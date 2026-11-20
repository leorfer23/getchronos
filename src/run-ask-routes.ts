/**
 * Run-asks over HTTP (src/run-asks.ts) — a command a terminal asked the operator to run.
 *
 *   POST /sessions/:id/run-asks   {command, why, cwd?}   the terminal itself asks (`mc ask-run`) → 201
 *   GET  /sessions/:id/run-asks                          that terminal's asks, newest first
 *   GET  /run-asks?state=open|running|done|all|<status,…>[&workspace=<id|slug>]   (default open)
 *   POST /run-asks/:id/run        {command?, surface?}   THE RUN — the operator's own hand only → 202
 *   POST /run-asks/:id/decline    {reason?, surface?}    the operator's own hand only
 *
 * Who:
 *  - ASKING is the terminal itself: its own `x-mc-session`, with its own workspace's token (a terminal
 *    with no workspace: the operator's token, which is what its `mc` sends). Another workspace's terminal
 *    is the 404 a missing id gets (CLAUDE.md gotcha #4). A Robert credential, a caller naming another
 *    terminal, or a Lead speaking for anyone but itself is refused.
 *  - READING is the operator (every workspace), a workspace token (its own workspace only) or that
 *    workspace's Robert — he may see that the operator owes a tap; he can do nothing about it.
 *  - RUNNING and DECLINING are ledger-routes.ts operatorHand, checked before anything else is read: his
 *    token itself from this Mac, no agent header, `x-mc-operator: 1`. No Robert grant, Lead, workspace
 *    token or agent credential gets through, and nothing delegates it.
 */
import type express from "express";
import { z } from "zod";
import { callerScope, checkScope, isOperator, leadScope, robertIdentity } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { operatorHand } from "./ledger-routes.js";
import { RUN_ASK_STATUSES, runAsks, sessions, workspaces, type RunAsk, type RunAskStatus } from "./store.js";
import { validate } from "./validation.js";
import { COMMAND_MAX, WHY_MAX, createRunAsk, declineRunAsk, reconcileRunAsks, runRunAsk } from "./run-asks.js";
import type { Session } from "./types.js";

const command = z.string().min(1).max(COMMAND_MAX).refine((s) => !s.includes("\0"), "no NUL bytes");
const CreateSchema = z.object({
  command,
  why: z.string().trim().min(1).max(WHY_MAX),
  cwd: z.string().max(1024).nullish(),
});
const RunSchema = z.object({
  /** The command as he means to run it — his edits and filled-in placeholders. Absent = as asked. */
  command: command.nullish(),
  surface: z.enum(["desk", "phone"]).nullish(),
});
const DeclineSchema = z.object({
  reason: z.string().max(300).nullish(),
  surface: z.enum(["desk", "phone"]).nullish(),
});

/** The operator's own hand, as middleware: nobody else learns even whether the body was valid. */
const hand: express.RequestHandler = (req, res, next) => {
  if (operatorHand(req, res)) next();
};

/** Why this caller is not that terminal asking for itself, or null. */
function askerRefusal(req: express.Request, s: Session, scope: NonNullable<ReturnType<typeof callerScope>>): string | null {
  if (forwardedHost(req) === null && robertIdentity(req.get("x-mc-admin")))
    return "a Robert credential never asks for a run — only the terminal itself does (`mc ask-run` from inside it)";
  if (req.get("x-mc-session") !== s.id)
    return "only the terminal itself asks the operator to run a command — `mc ask-run` from inside it (its own x-mc-session)";
  if (req.get("x-mc-lead")) {
    const lead = leadScope(req);
    if (!lead || lead.leadId !== s.id) return "a Lead asks only for itself";
  }
  if (s.workspace_id) {
    // Its own workspace's token: not the operator's token speaking for it, not a Robert scoped to it.
    if (!req.get("x-mc-workspace-token") || scope.ws !== s.workspace_id || scope.robert)
      return "a terminal asks with its own workspace's token (`mc ask-run` from inside it)";
  } else if (!isOperator(req)) {
    return "a terminal with no workspace asks with the operator's token, as its `mc` sends it";
  }
  return null;
}

const DONE: readonly RunAskStatus[] = ["ran", "failed", "declined", "superseded"];
/** `?state=` → statuses; undefined = all; null = a word that is not one. */
function parseState(v: unknown): readonly RunAskStatus[] | undefined | null {
  const raw = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!raw || raw === "open") return ["open"];
  if (raw === "all") return undefined;
  if (raw === "done") return DONE;
  if (raw === "live") return ["open", "running"];
  const out = raw.split(",").map((x) => x.trim()) as RunAskStatus[];
  return out.every((x) => RUN_ASK_STATUSES.includes(x)) ? out : null;
}

const findAsk = (ref: string): RunAsk | undefined => runAsks.get(ref) ?? runAsks.find(ref);

let reconciled = false;

export function mountRunAskRoutes(api: express.Router): void {
  // A run this daemon did not start cannot report back: settle it once, at boot.
  if (!reconciled) {
    reconciled = true;
    try {
      const n = reconcileRunAsks();
      if (n) console.log(`[run-ask] ${n} run(s) were still running when the daemon stopped — marked failed`);
    } catch (e: any) {
      console.warn("[run-ask] reconcile:", e?.message ?? e);
    }
  }

  api.post("/sessions/:id/run-asks", validate(CreateSchema), (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const why = askerRefusal(req, s, scope);
    if (why) return res.status(403).json({ error: why });
    const b = req.body as z.infer<typeof CreateSchema>;
    const out = createRunAsk(s, { command: b.command, why: b.why, cwd: b.cwd ?? null });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ ...out.ask, superseded: out.superseded.map((a) => a.id) });
  });

  api.get("/sessions/:id/run-asks", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 20, 100));
    res.json({ asks: runAsks.forSession(s.id, limit) });
  });

  api.get("/run-asks", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return res.status(401).json({ error: "invalid workspace token" });
    const statuses = parseState(req.query.state);
    if (statuses === null) return res.status(400).json({ error: `state: open, running, done, live, all, or a list of ${RUN_ASK_STATUSES.join(", ")}` });
    // A workspace token is its own workspace, whatever it names. Only the operator picks one.
    let ws: string | null | undefined = scope.ws === null ? undefined : scope.ws;
    if (scope.ws === null && typeof req.query.workspace === "string" && req.query.workspace) {
      const w = workspaces.get(req.query.workspace) ?? workspaces.getBySlug(req.query.workspace);
      if (!w) return res.status(404).json({ error: "workspace not found" });
      ws = w.id;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
    const rows = runAsks.list({ statuses, workspace_id: ws, limit });
    // Belt and braces: a scoped caller leaves with its own workspace's rows only.
    res.json({ asks: rows.filter((r) => scope.ws === null || r.workspace_id === scope.ws) });
  });

  api.post("/run-asks/:id/run", hand, validate(RunSchema), async (req, res) => {
    const a = findAsk(String(req.params.id));
    if (!a) return res.status(404).json({ error: "not found" });
    const b = req.body as z.infer<typeof RunSchema>;
    try {
      const out = await runRunAsk(a, { command: b.command ?? null, surface: b.surface ?? null });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      out.done.catch((e) => console.warn(`[run-ask] ${a.id.slice(0, 8)}:`, e?.message ?? e));
      res.status(202).json(out.ask);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  api.post("/run-asks/:id/decline", hand, validate(DeclineSchema), async (req, res) => {
    const a = findAsk(String(req.params.id));
    if (!a) return res.status(404).json({ error: "not found" });
    const b = req.body as z.infer<typeof DeclineSchema>;
    try {
      const out = await declineRunAsk(a, { reason: b.reason ?? null, surface: b.surface ?? null });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ ...out.ask, told: out.told });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
}
