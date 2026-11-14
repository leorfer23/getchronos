/**
 * The red-team trial's bookkeeping (src/red-team.ts says what it means). Per workspace, off by default
 * (setting `trial.red_team`). It writes one row per analysis hand-off chain — on or off — so the operator
 * can compare the two arms of his own workspace with `mc trial report red-team`:
 *
 *   noteTrialHandoff  `mc outcome` from an investigation terminal (api.ts): the chain opens, or counts one more.
 *   noteTrialPass     every verifier pass over an investigation request: the round told and what for,
 *                     ready, the red team's run or the answers to it.
 *   noteOperatorTurn  a line the operator himself typed into the terminal (api.ts: his composer, his
 *                     pane) — never a line the daemon, Robert, a Lead or the verifier typed.
 *
 * The wall: every row carries the workspace of the terminal it counts, a request is only ever tied to a
 * terminal of its own workspace, and the report reads one workspace's rows per caller scope.
 */
import { sessions, workspaces } from "./store.js";
import { requests, type RequestRow } from "./store/requests.js";
import { trials, type TrialRow } from "./store/trials.js";
import { settingOn } from "./settings.js";
import { PROTOCOL_MARK, RED_TEAM, armStats, paneTurns, priorRedTeam, seedProtocol, type RedTeamStat } from "./red-team.js";
import type { CallerScope } from "./authz.js";
import type { GoalKind, Outcome, Session } from "./types.js";

/** Is the trial on for this workspace? Never on without one. */
export function redTeamOn(workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  try { return settingOn("trial.red_team", workspaceId); } catch { return false; }
}

/** The protocol a new terminal's first prompt carries, or null (terminal.ts deskSeed). */
export const trialProtocol = (kind: GoalKind | null | undefined, workspaceId: string | null | undefined): string | null =>
  seedProtocol(kind, kind === "investigation" && redTeamOn(workspaceId));

const hasProtocol = (firstPrompt: string | null | undefined) => String(firstPrompt ?? "").includes(PROTOCOL_MARK);

/** The request a terminal's hand-off at `at` belongs to — only ever one of its own workspace. */
function requestOf(s: Session, at?: string): RequestRow | undefined {
  const link = requests.primaryAt(s.id, at) ?? requests.primaryAt(s.id);
  const r = link ? requests.get(link.request_id) : undefined;
  return r && s.workspace_id && r.workspace_id === s.workspace_id ? r : undefined;
}

/**
 * The hand-off's answers to the red team, each with the finding it answers (from the request's red_team
 * check), so the hand-off carries the findings with their resolution — what Focus shows him.
 */
export function withFindingClaims(s: Session, o: Outcome): Outcome {
  if (!o.findings?.length) return o;
  try {
    const r = requestOf(s);
    const prior = r ? priorRedTeam(requests.checks(r.id)) : null;
    if (!prior?.findings.length) return o;
    const claim = new Map(prior.findings.map((f) => [f.id, f.claim]));
    return { ...o, findings: o.findings.map((f) => (claim.has(f.id) ? { ...f, claim: claim.get(f.id) } : f)) };
  } catch {
    return o;
  }
}

function openChain(s: Session, r: RequestRow | undefined, handoffAt: string): TrialRow {
  return trials.open({
    trial: RED_TEAM, workspace_id: s.workspace_id!, session_id: s.id, request_id: r?.id ?? null,
    arm: redTeamOn(s.workspace_id) ? "on" : "off", protocol: hasProtocol(s.first_prompt),
    started_at: r?.asked_at ?? s.created_at, handoff_at: handoffAt, hypotheses: s.outcome?.hypotheses?.length ?? 0,
  });
}

/** A hand-off was filed. Only an investigation terminal in a workspace is counted. Never throws. */
export function noteTrialHandoff(sessionId: string): TrialRow | null {
  try {
    const s = sessions.get(sessionId);
    const o = s?.outcome;
    if (!s?.workspace_id || s.goal_kind !== "investigation" || !o?.summary) return null;
    const r = requestOf(s, o.at);
    const row = trials.find(RED_TEAM, s.id, r?.id ?? null);
    if (!row) return openChain(s, r, o.at);
    if (r && !row.request_id) trials.setRequest(row.id, r.id);
    trials.handoff(row.id, o.at, o.hypotheses?.length ?? 0);
    return trials.get(row.id) ?? null;
  } catch (e: any) {
    console.warn("[trial] hand-off not counted:", e?.message ?? e);
    return null;
  }
}

/** One verifier pass over an investigation request (request-verifier.ts). Never throws. */
export function noteTrialPass(p: { request: RequestRow; session: Session | undefined; told: boolean; names: string[]; ready: boolean; redTeam: RedTeamStat | null; at?: string }): void {
  try {
    const { request: r, session: s } = p;
    if (r.kind !== "investigation" || !r.workspace_id || !s || s.workspace_id !== r.workspace_id) return;
    const at = p.at ?? new Date().toISOString();
    // A draft judged before any hand-off still opens the chain: it is what was delivered. The terminal's
    // newest hand-off dates it only when that hand-off was for this request.
    const own = s.outcome && requests.primaryAt(s.id, s.outcome.at)?.request_id === r.id ? s.outcome.at : null;
    const row = trials.find(RED_TEAM, s.id, r.id) ?? openChain(s, r, own ?? at);
    if (!row.request_id) trials.setRequest(row.id, r.id);
    trials.pass(row.id, { told: p.told, names: p.names, ready: p.ready, at });
    if (p.redTeam?.kind === "ran") trials.redTeam(row.id, "ran", p.redTeam.findings);
    else if (p.redTeam?.kind === "skipped") trials.redTeam(row.id, "skipped", 0);
    else if (p.redTeam?.kind === "answers") trials.answers(row.id, p.redTeam.answered, p.redTeam.changed);
  } catch (e: any) {
    console.warn("[trial] pass not counted:", e?.message ?? e);
  }
}

/**
 * A line the operator typed into a terminal — his composer, his own `mc session send`, his phone (POST
 * /sessions/:id/input with the admin token and no other `by`), or his pane (notePaneInput). Counted on
 * the terminal's newest chain that was already handed off. Never throws.
 */
export function noteOperatorTurn(sessionId: string, at = new Date().toISOString()): void {
  try {
    if (!trials.hasSession(sessionId)) return;
    trials.turn(sessionId, requests.primaryAt(sessionId)?.request_id ?? null, at);
  } catch (e: any) {
    console.warn("[trial] turn not counted:", e?.message ?? e);
  }
}

/** Per pane: a line typed and not yet sent. Small; dropped whole if it ever grows past a few hundred. */
const paneTyped = new Map<string, boolean>();
/** One frame of keystrokes from an attached Desk pane — only ever his (api.ts /term). */
export function notePaneInput(sessionId: string, data: unknown): void {
  if (typeof data !== "string" || !data) return;
  const r = paneTurns(paneTyped.get(sessionId) ?? false, data);
  if (paneTyped.size > 500) paneTyped.clear();
  if (r.typed) paneTyped.set(sessionId, true);
  else paneTyped.delete(sessionId);
  for (let i = 0; i < r.turns; i++) noteOperatorTurn(sessionId);
}

/**
 * GET /api/trials/:trial/report. On vs off, per workspace. Workspace scoping is the security boundary
 * (CLAUDE.md #4): a workspace token (or a project Robert) reads only its own workspace — naming another
 * is the same 404 an unknown one gets; the operator reads any, or every workspace with rows.
 */
export function trialReportView(scope: CallerScope, q: { trial?: unknown; workspace?: unknown; days?: unknown }, nowMs = Date.now()): { status: number; body: unknown } {
  if (scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  if (String(q.trial ?? "").replace(/-/g, "_") !== RED_TEAM) return { status: 404, body: { error: "no such trial — there is one: red-team" } };
  const raw = Number(q.days ?? 30);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(365, Math.round(raw)) : 30;
  const since = new Date(nowMs - days * 86_400_000).toISOString();
  const asked = typeof q.workspace === "string" && q.workspace && q.workspace !== "all" ? q.workspace : null;
  let ids: string[];
  if (asked) {
    const ws = workspaces.get(asked) ?? workspaces.getBySlug(asked);
    if (!ws || (scope.ws !== null && ws.id !== scope.ws)) return { status: 404, body: { error: "not found" } };
    ids = [ws.id];
  } else ids = scope.ws !== null ? [scope.ws] : trials.workspacesWith(RED_TEAM, since);
  const out = ids.flatMap((id) => {
    const ws = workspaces.get(id);
    if (!ws) return [];
    const rows = trials.list(RED_TEAM, id, since);
    return [{
      workspace: { id: ws.id, slug: ws.slug, name: ws.name },
      trial_on: redTeamOn(ws.id),
      verifier_on: (() => { try { return settingOn("verifier.enabled", ws.id); } catch { return true; } })(),
      arms: { on: armStats(rows.filter((r) => r.arm === "on")), off: armStats(rows.filter((r) => r.arm === "off")) },
    }];
  });
  return { status: 200, body: { trial: RED_TEAM, days, since, workspaces: out } };
}

/** Tests: forget the panes. */
export function resetTrialMemory(): void {
  paneTyped.clear();
}
