/**
 * `/api/playbooks` and `/api/playbook-runs` — the HTTP side of playbooks (src/playbooks.ts).
 *
 *   GET    /playbooks[?workspace=]            list, each with its last run
 *   GET    /playbooks/:id                     one, with its recent runs
 *   POST   /playbooks                         save one: {name, text | steps | from_session, …}
 *   PATCH  /playbooks/:id                     change it (a run in flight keeps the steps it had)
 *   DELETE /playbooks/:id
 *   POST   /playbooks/:id/runs                {pr?, from?, here?} → a run waiting for the operator's OK
 *   GET    /playbook-runs[?workspace=&playbook=&session=&state=live]
 *   GET    /playbook-runs/:id                 (and /brief: the steps + protocol its terminal follows)
 *   POST   /playbook-runs/:id/ok              THE OK — the operator's own hand only
 *   POST   /playbook-runs/:id/stop            anyone in its workspace: stopping only ever halts
 *   POST   /playbook-runs/:id/steps/:n/start|done|fail    its own terminal (or the operator)
 *
 * `:id` is an id, or a playbook's name when it is unique among what the caller sees (a run: an id8).
 *
 * The workspace wall (CLAUDE.md gotcha #4): a workspace token reads and writes its own workspace's
 * playbooks and runs only — another's are the 404 a missing id gets. Saving, editing and asking for a
 * run are open to the workspace's agents, Robert and the operator: nothing runs before the OK, a run
 * runs in that workspace's sandbox, and the OK itself (ledger-routes.ts operatorHand) is his alone.
 */
import fs from "node:fs";
import type express from "express";
import { z } from "zod";
import { callerScope, isOperator } from "./authz.js";
import { operatorHand } from "./ledger-routes.js";
import {
  createRun, draftSteps, finishStep, formatSteps, MAX_STEPS, normalizeSteps, okRun, parseSteps, playbookView, readCalls, runBrief, runView,
  startStep, stopRun, transcriptOf, validateSteps, freshen, type Fail,
} from "./playbooks.js";
import { GATE_KINDS, LIVE_RUN_STATES, PLAYBOOK_NAME_RE, STEP_KINDS, playbookRuns, playbooks, repos, sessions, workspaces, type Playbook, type PlaybookRun, type PlaybookStep } from "./store.js";
import type { Workspace } from "./types.js";

type Req = express.Request;
type Res = express.Response;

const StepSchema = z.object({
  kind: z.enum(STEP_KINDS as [string, ...string[]]),
  run: z.string().max(4000),
  gate: z.enum(GATE_KINDS as [string, ...string[]]).nullable().optional(),
  to: z.string().max(200).nullable().optional(),
  channel: z.enum(["slack", "email"]).nullable().optional(),
}).strict();

const Fields = {
  name: z.string().trim().regex(PLAYBOOK_NAME_RE, "lowercase letters, digits, - and _ (max 48)"),
  description: z.string().trim().max(500).nullable(),
  repo: z.string().trim().max(200).nullable(),
  text: z.string().max(60_000),
  steps: z.array(StepSchema).max(MAX_STEPS),
};

const CreateSchema = z.object({
  workspace: z.string().trim().min(1).max(64).optional(),
  name: Fields.name,
  description: Fields.description.optional(),
  repo: Fields.repo.optional(),
  text: Fields.text.optional(),
  steps: Fields.steps.optional(),
  /** Draft the steps from what this terminal ran (its CLI transcript). */
  from_session: z.string().trim().min(6).max(64).optional(),
  /** Only what it ran since: an ISO time, or 30m / 2h / 3d back. */
  since: z.string().trim().max(40).optional(),
  /** Overwrite a playbook of that name (its runs stay). */
  replace: z.boolean().optional(),
  /** Answer with the steps it would save, and save nothing. */
  dry_run: z.boolean().optional(),
}).strict();

const PatchSchema = z.object({
  name: Fields.name.optional(),
  description: Fields.description.optional(),
  repo: Fields.repo.optional(),
  text: Fields.text.optional(),
  steps: Fields.steps.optional(),
}).strict();

const RunSchema = z.object({
  pr: z.string().trim().max(300).nullable().optional(),
  from: z.number().int().min(1).max(MAX_STEPS).nullable().optional(),
  here: z.boolean().optional(),
}).strict();

const OkSchema = z.object({
  sha: z.string().trim().max(64).nullable().optional(),
  gates: z.array(z.number().int().min(1).max(MAX_STEPS)).max(MAX_STEPS),
  surface: z.string().trim().max(24).optional(),
}).strict();

const StopSchema = z.object({ reason: z.string().trim().max(300).optional() }).strict();
const NoteSchema = z.object({ note: z.string().max(2000).optional(), error: z.string().max(2000).optional() }).strict();

const bad = (res: Res, e: z.ZodError) =>
  res.status(400).json({ error: `invalid request — ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });
const send = (res: Res, f: Fail) => {
  const { ok: _ok, status, ...rest } = f;
  res.status(status).json(rest);
};

function wsFrom(raw: unknown): Workspace | undefined {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? workspaces.get(v) ?? workspaces.getBySlug(v) : undefined;
}

/** Who is asking, in the words a run's log and its terminal use. */
function who(req: Req): string {
  if (isOperator(req)) return "operator";
  const scope = callerScope(req);
  if (scope?.robert) return "robert";
  const sid = req.get("x-mc-session");
  return sid ? `terminal ${sid.slice(0, 8)}` : "an agent";
}

/** The workspace a write lands in: the caller's own, or (operator / fleet Robert) the one it names. Null after answering. */
function writeWs(req: Req, res: Res, named: unknown, fallback?: string | null): Workspace | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const asked = named != null && named !== "" ? wsFrom(named) : undefined;
  if (named != null && named !== "" && !asked) { res.status(404).json({ error: "workspace not found" }); return null; }
  if (scope.ws !== null) {
    if (asked && asked.id !== scope.ws) { res.status(404).json({ error: "workspace not found" }); return null; }
    const w = workspaces.get(scope.ws);
    if (!w) { res.status(404).json({ error: "workspace not found" }); return null; }
    return w;
  }
  const w = asked ?? (fallback ? workspaces.get(fallback) : undefined);
  if (!w) { res.status(400).json({ error: "which workspace? pass workspace (slug or id)" }); return null; }
  return w;
}

/** The playbooks this caller may see. Null after answering the refusal. */
function visible(req: Req, res: Res): Playbook[] | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const named = req.query.workspace != null ? wsFrom(req.query.workspace) : undefined;
  if (req.query.workspace != null && (!named || (scope.ws !== null && named.id !== scope.ws))) {
    res.status(404).json({ error: "workspace not found" });
    return null;
  }
  return playbooks.list(scope.ws ?? named?.id ?? null);
}

/** `:id` → the playbook, by id or by a name unique among what the caller sees. Null after answering. */
function find(req: Req, res: Res): Playbook | null {
  const all = visible(req, res);
  if (!all) return null;
  const key = String(req.params.id ?? "");
  const byId = all.find((p) => p.id === key);
  if (byId) return byId;
  const named = all.filter((p) => p.name === key);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    res.status(409).json({ error: `${named.length} playbooks are named '${key}' — pass ?workspace=<slug> or the id` });
    return null;
  }
  res.status(404).json({ error: "playbook not found" });
  return null;
}

/** `:id` → a run of the caller's workspace (full id or id8). Null after answering. */
function findRun(req: Req, res: Res): PlaybookRun | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const r = playbookRuns.find(String(req.params.id ?? ""));
  if (!r || (scope.ws !== null && r.workspace_id !== scope.ws)) { res.status(404).json({ error: "run not found" }); return null; }
  return freshen(r);
}

/** A run's steps are driven by its own terminal — or by the operator — never by Robert or another terminal. */
function stepCaller(req: Req, res: Res, r: PlaybookRun): boolean {
  if (isOperator(req)) return true;
  const scope = callerScope(req);
  if (scope?.robert) { res.status(403).json({ error: "the run's own terminal works its steps — not Robert" }); return false; }
  const sid = req.get("x-mc-session");
  if (!sid || !r.session_id || sid !== r.session_id) {
    res.status(403).json({ error: r.session_id ? `only the run's own terminal (${r.session_id.slice(0, 8)}) works its steps` : "the run has no terminal yet — it waits for the operator's OK" });
    return false;
  }
  return true;
}

/** `?since=` → ms: an ISO time, or 30m / 2h / 3d back from now. Undefined = none; null = unreadable. */
function sinceMs(v: string | undefined, nowMs = Date.now()): number | undefined | null {
  if (!v) return undefined;
  const m = /^(\d+)\s*([mhd])$/i.exec(v);
  if (m) return nowMs - Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2].toLowerCase() as "m" | "h" | "d"];
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** The repo a playbook's terminal opens in: an id or name among the workspace's (owned or shared in). */
function repoOf(ws: Workspace, ref: string | null | undefined): { id: string | null } | { error: string } {
  if (ref == null || ref === "") return { id: null };
  const all = repos.accessible(ws.id);
  const hit = all.find((r) => r.id === ref) ?? all.filter((r) => r.name === ref).at(0);
  return hit ? { id: hit.id } : { error: `${ws.slug} has no repo '${ref}'` };
}

type Steps = { steps: PlaybookStep[]; notes: string[]; drafted_from: string | null };

/** The steps a write carries — typed, in the line format, or drafted from a terminal. Null after answering. */
async function stepsFrom(req: Req, res: Res, ws: Workspace, b: { text?: string; steps?: PlaybookStep[]; from_session?: string; since?: string }): Promise<Steps | null | undefined> {
  const given = [b.text != null, b.steps != null, b.from_session != null].filter(Boolean).length;
  if (given > 1) { res.status(400).json({ error: "pass one of text, steps or from_session" }); return null; }
  if (b.text != null) {
    const p = parseSteps(b.text);
    if (p.errors.length) { res.status(400).json({ error: p.errors.join("; "), errors: p.errors }); return null; }
    return { steps: normalizeSteps(p.steps), notes: [], drafted_from: null };
  }
  if (b.steps != null) return { steps: normalizeSteps(b.steps as PlaybookStep[]), notes: [], drafted_from: null };
  if (b.from_session != null) {
    const key = b.from_session.toLowerCase();
    const s = sessions.get(key) ?? (key.length >= 6 ? sessions.list({ workspace_id: ws.id, limit: 500 }).filter((x) => x.id.startsWith(key)).at(0) : undefined);
    // Another workspace's terminal is the same 404 as one that does not exist: a draft never crosses.
    if (!s || s.workspace_id !== ws.id) { res.status(404).json({ error: "terminal not found in this workspace" }); return null; }
    const since = sinceMs(b.since);
    if (since === null) { res.status(400).json({ error: "since is an ISO time or 30m / 2h / 3d" }); return null; }
    const t = await transcriptOf(s.id);
    if (t.error) { res.status(400).json({ error: t.error }); return null; }
    if (!t.file) { res.status(404).json({ error: `no transcript found for terminal ${s.id.slice(0, 8)} yet` }); return null; }
    let text = "";
    try { text = fs.readFileSync(t.file, "utf8"); } catch (e) { res.status(500).json({ error: `could not read its transcript: ${(e as Error).message}` }); return null; }
    const d = draftSteps(readCalls(text, t.backend), { since });
    if (!d.steps.length) { res.status(422).json({ error: `terminal ${s.id.slice(0, 8)} ran nothing that changes anything — write the steps by hand`, notes: d.notes }); return null; }
    return { steps: d.steps, notes: d.notes, drafted_from: s.id };
  }
  return undefined;
}

function lastRun(pbId: string): PlaybookRun | null {
  const r = playbookRuns.list({ playbook_id: pbId, limit: 1 })[0];
  return r ? freshen(r) : null;
}

export function mountPlaybookRoutes(api: express.Router): void {
  api.get("/playbooks", (req, res) => {
    const all = visible(req, res);
    if (all) res.json(all.map((p) => playbookView(p, lastRun(p.id))));
  });

  api.get("/playbooks/:id", (req, res) => {
    const p = find(req, res);
    if (!p) return;
    const runs = playbookRuns.list({ playbook_id: p.id, limit: 10 }).map((r) => runView(freshen(r)));
    res.json({ ...playbookView(p, null), runs });
  });

  api.post("/playbooks", async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error);
    const b = parsed.data;
    // A draft from a terminal lands in that terminal's workspace when the operator names none.
    const fromWs = b.from_session ? sessions.get(b.from_session)?.workspace_id ?? null : null;
    const ws = writeWs(req, res, b.workspace, fromWs);
    if (!ws) return;
    const st = await stepsFrom(req, res, ws, b as any);
    if (st === null) return;
    if (!st) return void res.status(400).json({ error: "no steps — pass text (one step a line), steps, or from_session" });
    const errors = validateSteps(ws, st.steps);
    if (b.dry_run) return void res.json({ workspace_id: ws.id, steps: st.steps, notes: st.notes, errors, text: formatSteps(st.steps) });
    if (errors.length) return void res.status(400).json({ error: errors.join("; "), errors, notes: st.notes });
    const repo = repoOf(ws, b.repo);
    if ("error" in repo) return void res.status(400).json({ error: repo.error });
    const existing = playbooks.byName(ws.id, b.name);
    const operator = isOperator(req);
    if (existing) {
      if (!b.replace) return void res.status(409).json({ error: `${ws.slug} already has a playbook named '${b.name}' — pass replace to overwrite it`, id: existing.id });
      const out = playbooks.update(existing.id, { steps: st.steps, ...(b.description !== undefined ? { description: b.description } : {}), ...(b.repo !== undefined ? { repo_id: repo.id } : {}) }, operator);
      return void res.json({ ...playbookView(out!, lastRun(out!.id)), notes: st.notes });
    }
    const p = playbooks.create({
      workspace_id: ws.id, name: b.name, steps: st.steps, description: b.description ?? null, repo_id: repo.id,
      source: st.drafted_from ? "session" : "hand", drafted_from: st.drafted_from, reviewed: operator && !st.drafted_from, created_by: who(req),
    });
    res.status(201).json({ ...playbookView(p, null), notes: st.notes });
  });

  api.patch("/playbooks/:id", async (req, res) => {
    const p = find(req, res);
    if (!p) return;
    const parsed = PatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error);
    const b = parsed.data;
    const ws = workspaces.get(p.workspace_id);
    if (!ws) return void res.status(404).json({ error: "workspace not found" });
    const st = await stepsFrom(req, res, ws, b as any);
    if (st === null) return;
    if (st) {
      const errors = validateSteps(ws, st.steps);
      if (errors.length) return void res.status(400).json({ error: errors.join("; "), errors });
    }
    if (b.name && b.name !== p.name && playbooks.byName(p.workspace_id, b.name)) return void res.status(409).json({ error: `this workspace already has a playbook named '${b.name}'` });
    const repo = b.repo !== undefined ? repoOf(ws, b.repo) : null;
    if (repo && "error" in repo) return void res.status(400).json({ error: repo.error });
    const out = playbooks.update(p.id, {
      ...(b.name ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}),
      ...(repo ? { repo_id: repo.id } : {}), ...(st ? { steps: st.steps } : {}),
    }, isOperator(req));
    res.json(playbookView(out!, lastRun(p.id)));
  });

  api.delete("/playbooks/:id", (req, res) => {
    const p = find(req, res);
    if (!p) return;
    const live = playbookRuns.list({ playbook_id: p.id, states: LIVE_RUN_STATES }).map((r) => freshen(r)).find((r) => LIVE_RUN_STATES.includes(r.state));
    if (live) return void res.status(409).json({ error: `run ${live.id.slice(0, 8)} is still ${live.state.replace("_", " ")} — stop it first` });
    playbooks.delete(p.id);
    res.json({ deleted: p.id });
  });

  api.post("/playbooks/:id/runs", async (req, res) => {
    const p = find(req, res);
    if (!p) return;
    const parsed = RunSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error);
    const out = await createRun(p, { pr: parsed.data.pr ?? null, from: parsed.data.from ?? null, here: !!parsed.data.here, by: who(req), session: req.get("x-mc-session") ?? null });
    if (!out.ok) return send(res, out);
    res.status(201).json(runView(out.run));
  });

  api.get("/playbook-runs", (req, res) => {
    const scope = callerScope(req);
    if (scope === null) return void res.status(401).json({ error: "invalid workspace token" });
    const named = req.query.workspace != null ? wsFrom(req.query.workspace) : undefined;
    if (req.query.workspace != null && (!named || (scope.ws !== null && named.id !== scope.ws))) return void res.status(404).json({ error: "workspace not found" });
    let pbId: string | undefined;
    if (req.query.playbook != null) {
      const key = String(req.query.playbook);
      const pool = playbooks.list(scope.ws ?? named?.id ?? null);
      const hit = pool.find((x) => x.id === key) ?? pool.filter((x) => x.name === key).at(0);
      if (!hit) return void res.status(404).json({ error: "playbook not found" });
      pbId = hit.id;
    }
    const live = String(req.query.state ?? "") === "live";
    const rows = playbookRuns.list({
      workspace_id: scope.ws ?? named?.id ?? null, playbook_id: pbId, session_id: req.query.session ? String(req.query.session) : undefined,
      states: live ? LIVE_RUN_STATES : undefined, limit: Number(req.query.limit) || 50,
    }).map((r) => freshen(r)).filter((r) => !live || LIVE_RUN_STATES.includes(r.state));
    res.json(rows.map(runView));
  });

  api.get("/playbook-runs/:id", (req, res) => {
    const r = findRun(req, res);
    if (r) res.json(runView(r));
  });

  api.get("/playbook-runs/:id/brief", (req, res) => {
    const r = findRun(req, res);
    if (!r) return;
    res.json({ run_id: r.id, state: r.state, text: runBrief(r, workspaces.get(r.workspace_id)?.name ?? "this workspace") });
  });

  // THE OK. His hand only: the admin token itself, from this Mac, no agent header, x-mc-operator: 1 —
  // never a Robert, workspace or Lead credential (ledger-routes.ts operatorHand, the executor's gate).
  api.post("/playbook-runs/:id/ok", async (req, res) => {
    if (!operatorHand(req, res)) return;
    const r = findRun(req, res);
    if (!r) return;
    const parsed = OkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error);
    const out = await okRun(r, parsed.data);
    if (!out.ok) return send(res, out);
    res.json(runView(out.run));
  });

  api.post("/playbook-runs/:id/stop", (req, res) => {
    const r = findRun(req, res);
    if (!r) return;
    const parsed = StopSchema.safeParse(req.body ?? {});
    if (!parsed.success) return bad(res, parsed.error);
    const sid = req.get("x-mc-session");
    const by = !isOperator(req) && sid && sid === r.session_id ? "its terminal" : who(req);
    const out = stopRun(r, by, parsed.data.reason ?? null);
    if (!out.ok) return send(res, out);
    res.json(runView(out.run));
  });

  for (const action of ["start", "done", "fail"] as const) {
    api.post(`/playbook-runs/:id/steps/:n/${action}`, async (req, res) => {
      const r = findRun(req, res);
      if (!r) return;
      if (!stepCaller(req, res, r)) return;
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1) return void res.status(400).json({ error: "a step number" });
      const parsed = NoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) return bad(res, parsed.error);
      if (action === "start") {
        const out = await startStep(r, n);
        if (!out.ok) return send(res, out);
        return void res.json({ run: runView(out.run), step: n, command: out.command, carried: out.carried, instruction: out.step.kind === "agent" || out.step.kind === "message" ? out.step.run : null, kind: out.step.kind });
      }
      const out = finishStep(r, n, action === "done" ? "done" : "failed", (action === "done" ? parsed.data.note : parsed.data.error ?? parsed.data.note) ?? null);
      if (!out.ok) return send(res, out);
      res.json({ run: runView(out.run), step: n });
    });
  }
}
