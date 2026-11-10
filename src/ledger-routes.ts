/**
 * `/api/ledger` — the request ledger over HTTP (src/ledger.ts, LEDGER.md).
 *
 *   GET  /ledger               rows, most urgent first. ?state=needs_operator,stuck… | open | active (default) | all
 *                              · ?needs=decision · ?workspace=<id|slug> (operator only) · ?since=ISO | 2h | 3d
 *                              · ?session=<id> · ?ambiguous=1 (a terminal's turn was a guess — the audit list)
 *                              · ?limit · ?format=text (the compact lines a coordinator reads)
 *   GET  /ledger/queue         the approval queue, in the order he should hear it, and what he deferred
 *   GET  /ledger/:id           one request in full: terminals, result, deliverables, decisions, checks
 *   POST /ledger/:id/decision  {item?, decision: yes|no|later|change, words?, target_hash?, until?, by?, audio_ref?,
 *                              surface?, how?, override?} records his answer. A yes on a merge or a send, with
 *                              the executor on (src/executor.ts), is then carried out — that exact version,
 *                              once — and the response says `executed: true|false` with what happened.
 *   POST /ledger/:id/close     {words?} — he closed it; whatever it still owed stops being a question
 *   POST /ledger/:id/verify    re-run the verifier on it now (src/request-verifier.ts) — the operator's token
 *                              only; answers 202 at once, the pass lands in GET /ledger/:id → verification.
 *                              Never merges, sends or posts: it only reads and writes checks.
 *
 * The wall (CLAUDE.md gotcha #4): the operator's token reads every workspace, and so does the fleet-wide
 * Robert's credential (he reads, the operator granted that; he never writes here). A project Robert's
 * token or a workspace token reads ONLY its own workspace's rows, and a foreign id is the same 404 as a
 * missing one. A fleet-wide row (no workspace) is the operator's and the fleet Robert's alone. No token,
 * no ledger: it holds what he said in every workspace, so the tokenless loopback pass older routes still
 * allow (authz.ts tokenlessMode) does not reach it.
 *
 * Writing is the operator's hand only: his token itself (authz.ts isOperator — no Robert holds it any
 * more: every Robert process carries a credential derived from it, which the server tells apart), no
 * agent header, and `x-mc-operator: 1`, which only his surfaces send. A yes recorded here is the only
 * way an approval comes to exist (src/executor.ts), so this check is what the executor stands on.
 */
import type express from "express";
import { z } from "zod";
import { callerScope, fleetScopeOf, isOperator, robertIdentity } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { validate } from "./validation.js";
import { workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { DECISIONS, OPEN_STATES, REQUEST_STATES, type RequestState } from "./ledger-model.js";
import { closeRequest, detailOf, ledgerText, queueView, recordDecision, summaryOf } from "./ledger.js";
import { verifyRequest } from "./request-verifier.js";
import { carryOutDecision, OVERRIDES } from "./executor.js";
import { APPROVAL_HOWS } from "./store/executor.js";

type Scope = { ws: string | null; operator: boolean };

/** Who is reading: the operator (every workspace) or one workspace. Null after answering the refusal. */
export function ledgerScope(req: express.Request, res: express.Response): Scope | null {
  if (isOperator(req)) return { ws: null, operator: true };
  // The fleet-wide Robert reads every workspace's rows, as the operator does — reads only: every write
  // here is operatorHand's, which his credential never passes.
  if (forwardedHost(req) === null && fleetScopeOf(req.get("x-mc-admin"))) return { ws: null, operator: true };
  const scope = callerScope(req);
  if (scope === null) {
    res.status(401).json({ error: "invalid token" });
    return null;
  }
  if (scope.ws === null) {
    res.status(401).json({ error: "the ledger needs a token: x-mc-admin (the operator) or x-mc-workspace-token" });
    return null;
  }
  return { ws: scope.ws, operator: false };
}

/**
 * The operator's own hand: his token itself, from this Mac (never a Robert's derived credential, a
 * workspace or Lead token, or a request a host replayed), no agent header, and `x-mc-operator: 1`.
 * False after answering the refusal. The only door to an approval (src/executor.ts).
 */
export function operatorHand(req: express.Request, res: express.Response): boolean {
  if (!isOperator(req)) {
    const robert = forwardedHost(req) === null && robertIdentity(req.get("x-mc-admin"));
    res.status(403).json({ error: robert ? "a Robert credential never records or carries out a decision — the operator's own device does" : "only the operator records a decision (x-mc-admin)" });
    return false;
  }
  if (req.get("x-mc-lead") || req.get("x-mc-session") || req.get("x-mc-agent") || req.get("x-mc-workspace-token")) {
    res.status(403).json({ error: "an agent may not answer for the operator" });
    return false;
  }
  if (req.get("x-mc-operator") !== "1") {
    res.status(403).json({ error: "a decision needs the operator's hand (x-mc-operator: 1 — the Desk, the phone, the voice layer)" });
    return false;
  }
  return true;
}

/** `?state=` → the states to show; null when it names one that does not exist. */
export function parseStates(v: unknown): RequestState[] | undefined | null {
  const raw = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!raw || raw === "active") return ["needs_operator", "stuck", "working", "done"];
  if (raw === "all") return undefined;
  if (raw === "open") return [...OPEN_STATES];
  const alias: Record<string, RequestState> = { needs: "needs_operator", "needs-operator": "needs_operator", needs_you: "needs_operator" };
  const out = raw.split(",").map((s) => alias[s.trim()] ?? (s.trim() as RequestState));
  return out.every((s) => (REQUEST_STATES as readonly string[]).includes(s)) ? out : null;
}

/** `?since=` → ISO: an ISO time, or 30m / 2h / 3d back from now. Null when it cannot be read. */
export function parseSince(v: unknown, nowMs = Date.now()): string | undefined | null {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const m = /^(\d+)\s*([mhd])$/i.exec(v.trim());
  if (m) return new Date(nowMs - Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2].toLowerCase() as "m" | "h" | "d"]).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const DecisionSchema = z.object({
  item: z.string().trim().min(4).max(64).nullish(),
  decision: z.enum(DECISIONS),
  words: z.string().max(4000).nullish(),
  target_hash: z.string().max(200).nullish(),
  until: z.string().max(40).nullish(),
  by: z.string().trim().max(40).nullish(),
  audio_ref: z.string().max(400).nullish(),
  /** Where he said it, when the surface says so (else read from `by`). */
  surface: z.enum(["desk", "phone", "bar", "voice", "web"]).nullish(),
  /** How the yes was given (else read from `by`): a tap, a strong spoken yes, or a weak one he confirmed. */
  how: z.enum(APPROVAL_HOWS).nullish(),
  /** An operator-only override carried with the yes, logged as given: merge although nothing verified it. */
  override: z.enum(OVERRIDES).nullish(),
});
const CloseSchema = z.object({ words: z.string().max(2000).nullish(), by: z.string().trim().max(40).nullish() });

export function mountLedgerRoutes(api: express.Router): void {
  api.get("/ledger", (req, res) => {
    const scope = ledgerScope(req, res);
    if (!scope) return;
    const states = parseStates(req.query.state);
    if (states === null) return res.status(400).json({ error: `state: ${REQUEST_STATES.join(", ")} (comma list), open, active or all` });
    const since = parseSince(req.query.since);
    if (since === null) return res.status(400).json({ error: "since: an ISO time, or 30m / 2h / 3d" });
    // A workspace's own token is its workspace — whatever it names. Only the operator picks one.
    let ws: string | undefined = scope.operator ? undefined : scope.ws!;
    if (scope.operator && typeof req.query.workspace === "string" && req.query.workspace) {
      const w = workspaces.get(req.query.workspace) ?? workspaces.getBySlug(req.query.workspace);
      if (!w) return res.status(404).json({ error: "workspace not found" });
      ws = w.id;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    if (req.query.format === "text") return res.json({ text: ledgerText(ws, { max: Math.min(limit, 40) }) });
    const rows = requests.list({
      workspace_id: ws, states, since, limit,
      needsDecision: req.query.needs === "decision" || req.query.needs === "1",
      ambiguous: req.query.ambiguous === "1" || req.query.ambiguous === "true",
      session_id: typeof req.query.session === "string" && req.query.session ? req.query.session : undefined,
    });
    // Belt and braces: whatever the query said, a scoped caller leaves with its own workspace's rows only.
    res.json(rows.filter((r) => scope.operator || r.workspace_id === scope.ws).map(summaryOf));
  });

  api.get("/ledger/queue", (req, res) => {
    const scope = ledgerScope(req, res);
    if (!scope) return;
    let ws: string | undefined = scope.operator ? undefined : scope.ws!;
    if (scope.operator && typeof req.query.workspace === "string" && req.query.workspace) {
      const w = workspaces.get(req.query.workspace) ?? workspaces.getBySlug(req.query.workspace);
      if (!w) return res.status(404).json({ error: "workspace not found" });
      ws = w.id;
    }
    const q = queueView(ws);
    if (!scope.operator) {
      q.items = q.items.filter((i) => i.workspace?.id === scope.ws);
      q.held = q.held.filter((i) => i.workspace?.id === scope.ws);
    }
    res.json(q);
  });

  api.get("/ledger/:id", (req, res) => {
    const scope = ledgerScope(req, res);
    if (!scope) return;
    const r = requests.resolve(String(req.params.id));
    if (!r || (!scope.operator && r.workspace_id !== scope.ws)) return res.status(404).json({ error: "not found" });
    res.json(detailOf(r, { operator: scope.operator }));
  });

  api.post("/ledger/:id/decision", validate(DecisionSchema), async (req, res) => {
    if (!operatorHand(req, res)) return;
    const b = req.body as z.infer<typeof DecisionSchema>;
    const out = recordDecision({
      request: String(req.params.id), item: b.item ?? null, decision: b.decision, words: b.words ?? null,
      target_hash: b.target_hash ?? null, until: b.until ?? null, by: b.by ?? "operator", audio_ref: b.audio_ref ?? null,
    });
    if (!out.ok) {
      const { ok: _ok, status, ...body } = out;
      return res.status(status).json(body);
    }
    // His answer is recorded either way. A yes the executor carries out runs now, and the response says
    // what happened: `executed` true only when the thing was done (merged, sent). The phone uses it to
    // know it must NOT also type an approval line into the terminal (LEDGER.md → Executing).
    let carried: Awaited<ReturnType<typeof carryOutDecision>> = { executed: false };
    try {
      carried = await carryOutDecision(out.item, out.request, {
        words: b.words ?? null, by: b.by ?? "operator", surface: b.surface ?? null, how: b.how ?? null, override: b.override ?? null, audio_ref: b.audio_ref ?? null,
      });
    } catch (e: any) {
      console.warn("[executor]", e?.message ?? e);
      // Not "nothing ran": the error may have come after GitHub merged. The log says what did happen.
      carried = { executed: false, executor: `the executor hit an error (${String(e?.message ?? e).slice(0, 200)}) — check \`mc executor log\` before saying yes again` };
    }
    const request = requests.get(out.request.id) ?? out.request;
    res.json({ ok: true, item: requests.item(out.item.id) ?? out.item, request: summaryOf(request), ...carried });
  });

  // The operator's re-run. A workspace token (or a project Robert's) may read its own checks, never
  // start a pass: a pass spends a heavy slot and a reviewer run, and its result is his evidence.
  api.post("/ledger/:id/verify", async (req, res) => {
    const scope = ledgerScope(req, res);
    if (!scope) return;
    if (!scope.operator) return res.status(403).json({ error: "only the operator re-runs the verifier (x-mc-admin)" });
    const r = requests.resolve(String(req.params.id));
    if (!r) return res.status(404).json({ error: "not found" });
    if (!r.workspace_id) return res.status(409).json({ error: "a request with no workspace is not verified — it has no sandbox or credentials to check it with" });
    const pass = verifyRequest(r.id, { trigger: "manual", by: "operator", force: true });
    // A pass that cannot start (nothing to check, one already running) says so at once; one that
    // starts is left to run — it can take as long as the repo's checks do.
    const early = await Promise.race([pass, new Promise<null>((ok) => setTimeout(() => ok(null), 50))]);
    if (early && early.status !== "done") return res.status(409).json({ error: early.reason, status: early.status });
    if (early) return res.json({ ok: true, request_id: r.id, ...early });
    res.status(202).json({ ok: true, request_id: r.id, started: true });
  });

  api.post("/ledger/:id/close", validate(CloseSchema), (req, res) => {
    if (!operatorHand(req, res)) return;
    const r = closeRequest(String(req.params.id), req.body?.words ?? null, req.body?.by ?? "operator");
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(summaryOf(r));
  });
}
