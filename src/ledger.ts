/**
 * The request ledger — the writers and the read views (LEDGER.md). Code, not a model, records every
 * request where it enters and moves it from events the daemon already publishes:
 *
 *   entry                                      how it is seen
 *   the operator's words to Robert             agent.asked (turn id, words, surface, voice)
 *   Robert opens a terminal in that turn       session.started, created_by "robert", matched to the
 *                                              turn that announced that open (agent.step)
 *   Robert types his words into a terminal     session.input by "robert", same matching
 *   a terminal opened by hand, capture, inbox, session.started, by `sessions.created_by`
 *   job-check, proactive, follow-up
 *   a Lead's worker                            session.started with lead_id → the Lead's request
 *   failover / continuation stand-ins          session.failover · session.host_failover · continuation.fired
 *   anything else live and unknown             the sweep adopts it (and backfills at first start)
 *
 * The turn test needs nothing from the model. A workspace runs more than one Robert at once — his
 * conversation and the wake lane, on separate processes with the same credential — so the request a
 * terminal arrives with says nothing about which turn sent it. But every tool call a turn makes is
 * announced before it runs (agent.step: `mc session new --goal "…"` says its goal, `mc session send
 * <id>` names the terminal), so each open or keystroke is matched to the announcement that describes
 * it (ledger-model.ts pickTurn); only when no announcement tells the turns apart is it a guess, and
 * that guess is written on the link. A turn the operator started (agent.asked) carries his words; any
 * other turn is Robert's own.
 *
 * State follows session.status / session.updated / session.ended, asks and drafts — every write is
 * an idempotent upsert and every state is re-derived from rows, so a replayed, repeated or
 * out-of-order event changes nothing, and a restart loses only the in-flight turn map (whose turns
 * died with the process anyway).
 */
import { bus } from "./bus.js";
import { asks, continuations, kv, sessionPrs, sessions, workspaces } from "./store.js";
import { requests, type DecisionItem, type Deliverable, type RequestLink, type RequestRow } from "./store/requests.js";
import { heldBy, holderAsks, isOperatorsAsk } from "./robert-asks.js";
import { statusOf } from "./term-status.js";
import {
  DEFERRED_OPENERS, EXECUTABLE, FINAL_DELIVERABLE, OPEN_STATES, WORK, deliveredLinks, derivePrereqs, expectedChecks, ledgerLines, pickTurn, queueOrder,
  rollUp, viaOf, wordsOfSession,
  type Action, type AttributionHow, type DeliverableKind, type DeliverableState, type ItemView, type LineRow, type LinkRole, type LiveStepView,
  type LiveTurnView, type Prereq, type TerminalAct, type TerminalView, type TurnLane, type Via,
} from "./ledger-model.js";
import { terminalMove } from "./robert-steps.js";
import type { GoalKind, Outcome, Session } from "./types.js";

const iso = (ms: number) => new Date(ms).toISOString();
const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// ───────────────────────────── turns: which of Robert's turns made a move ─────────────────────────────

type Turn = { words: string; surface: string | null; voice: boolean; ws: string | null; at: string; seen: number };
/** Operator turns (POST /agent's agent.asked), by turn id. Short-lived: a turn lasts minutes. */
const turns = new Map<string, Turn>();
/** One turn at work: the label its steps carry, when it last moved, and every tool call it announced. */
type LiveTurn = { turn: string; label: string | null; lastAt: number; steps: LiveStepView[] };
/** Workspace (or "default" for the fleet-wide Robert) → every turn at work in it, whatever its lane. */
const live = new Map<string, Map<string, LiveTurn>>();
/** A turn keeps its last few announcements: enough to match the moves still in flight. */
const MAX_STEPS = 30;
/** A request opened before its turn (the voice front delegating with a request id): turn → request. */
const bound = new Map<string, string>();
/** Last resolved status per terminal, from session.status — saves re-resolving it on every roll-up. */
const lastStatus = new Map<string, { phase: string; line: string | null }>();

const TURN_KEEP_MS = 2 * 60 * 60_000;
/** Robert's turns are killed after 90s of silence (telegram/agent.ts WEB_TURN_TIMEOUT_MS): older is not "now". */
export const LIVE_TURN_MS = 3 * 60_000;
/** A deferred opener's own event (failover, continuation) gets this long to link it before the sweep adopts it. */
export const ORPHAN_GRACE_MS = 2 * 60_000;
export const SWEEP_MS = 60_000;
const BOOT_DELAY_MS = 30_000;
const SINCE_KEY = "ledger.since";

const procKey = (ws: string | null | undefined) => (ws && !String(ws).startsWith("agent:") ? String(ws) : "default");

function noteAsked(e: { turn?: string; you?: string; source?: string; ws?: string | null; at?: string; voice?: boolean }, nowMs: number): void {
  if (!e.turn) return;
  turns.set(e.turn, { words: String(e.you ?? ""), surface: e.source ?? null, voice: !!e.voice, ws: e.ws ?? null, at: e.at ?? iso(nowMs), seen: nowMs });
  if (turns.size > 200) for (const [k, t] of turns) if (nowMs - t.seen > TURN_KEEP_MS) turns.delete(k);
}
const isExecThread = (ws: unknown) => typeof ws === "string" && ws.startsWith("agent:");
function liveTurn(ws: string | null | undefined, turn: string, nowMs: number): LiveTurn {
  const key = procKey(ws);
  let m = live.get(key);
  if (!m) live.set(key, (m = new Map()));
  let t = m.get(turn);
  if (!t) m.set(turn, (t = { turn, label: null, lastAt: nowMs, steps: [] }));
  return t;
}
/** agent.step: one tool call announced, before it runs — read as a terminal move when it is one. */
function noteStep(e: { turn?: string; ws?: string | null; step?: unknown; label?: string | null }, nowMs: number): void {
  if (!e.turn || isExecThread(e.ws)) return;
  const t = liveTurn(e.ws, e.turn, nowMs);
  t.lastAt = nowMs;
  if (e.label) t.label = e.label;
  const mv = terminalMove(e.step as any);
  t.steps.push({
    at: nowMs, move: mv?.move ?? null, goal: mv?.move === "open" ? mv.goal : null,
    sid: mv?.move === "type" ? mv.sid : null, text: mv?.move === "type" ? mv.text : null, done: false, used: false,
  });
  if (t.steps.length > MAX_STEPS) t.steps.splice(0, t.steps.length - MAX_STEPS);
}
/**
 * agent.delta (the operator's own turns stream them): the turn is alive, and a `tool_done` says its
 * oldest call still in flight came back — that call can no longer be the one making a request.
 */
function noteDelta(e: { turn?: string; ws?: string | null; kind?: string }, nowMs: number): void {
  if (!e.turn || isExecThread(e.ws)) return;
  const t = liveTurn(e.ws, e.turn, nowMs);
  t.lastAt = nowMs;
  if (e.kind === "tool_done") {
    const s = t.steps.find((x) => !x.done);
    if (s) s.done = true;
  }
}
/** A turn ended (its agent.push names it): it can no longer have made anything. */
function endTurn(turn: string): void {
  for (const m of live.values()) m.delete(turn);
}
const laneOf = (turn: string): TurnLane => (turns.has(turn) || bound.has(turn) ? "operator" : "wake");

export type Attribution = { turn: string; lane: TurnLane; how: AttributionHow; ambiguous: boolean };
/** What the API can say about who made a request, when it knows (a lane-tagged credential — not yet). */
export type CallerHint = { turn?: string | null; lane?: TurnLane | null } | null | undefined;

/**
 * Which of Robert's turns in this workspace opened a terminal or typed into one (ledger-model.ts
 * pickTurn on every turn still at work). The seam: a caller that knows the turn — or the lane — says
 * so and that is the answer (or the only lane looked at); today no caller does. The announcement that
 * matched is spent: one announced call accounts for one terminal.
 */
export function attributeTurn(ws: string | null, act: TerminalAct, nowMs = Date.now(), caller?: CallerHint): Attribution | null {
  if (caller?.turn) return { turn: caller.turn, lane: caller.lane ?? laneOf(caller.turn), how: "caller", ambiguous: false };
  const m = live.get(procKey(ws));
  const cands: LiveTurnView[] = [];
  for (const t of m ? [...m.values()] : []) {
    if (nowMs - t.lastAt > LIVE_TURN_MS) { m!.delete(t.turn); continue; }
    const lane = laneOf(t.turn);
    if (caller?.lane && lane !== caller.lane) continue;
    cands.push({ turn: t.turn, lane, lastAt: t.lastAt, steps: t.steps });
  }
  const pick = pickTurn(cands, act, nowMs);
  if (!pick) return null;
  if (pick.step) pick.step.used = true;
  return { turn: pick.turn, lane: pick.lane, how: pick.how, ambiguous: pick.ambiguous };
}

/**
 * He spoke this turn (POST /agent's `voice`). Called right after agent.asked, before the turn runs, so
 * the request it may open is written as spoken; one already written is corrected.
 */
export function markVoiceTurn(turn: string): void {
  const t = turns.get(turn);
  if (t) t.voice = true;
  requests.markVoice(turn);
}

/**
 * The front (piece 4 of the plan) opens the request first and then hands a project's Robert the turn:
 * bind the turn so what that Robert opens or steers lands on this row instead of a new one.
 */
export function bindTurn(turn: string, requestId: string): void {
  bound.set(turn, requestId);
}

/** A request opened by code that is not a terminal (the voice front, a test). The caller links what serves it. */
export function openRequest(r: { workspace_id: string | null; words: string; via: Via; surface?: string | null; kind?: GoalKind | null; turn_id?: string | null }): RequestRow {
  const ws = r.workspace_id ? workspaces.get(r.workspace_id) : undefined;
  const row = requests.create({
    workspace_id: r.workspace_id, words: r.words, via: r.via, surface: r.surface ?? null, opened_by: "front", turn_id: r.turn_id ?? null,
    kind: r.kind ?? null, kind_source: r.kind ? "set" : null, prereqs: derivePrereqs(r.kind, ws as any),
  });
  if (r.turn_id) bindTurn(r.turn_id, row.id);
  return recompute(row.id) ?? row;
}

// ───────────────────────────── linking terminals ─────────────────────────────

/** A terminal that opens a request of its own: the request, and the link that makes it the owner. */
function openOwn(s: Session, via: Via, role: LinkRole, a?: Attribution | null): RequestRow {
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  const r = requests.create({
    workspace_id: s.workspace_id ?? null, words: wordsOfSession(s, via), via, opened_by: s.created_by ?? "operator",
    kind: s.goal_kind ?? null, kind_source: "terminal", prereqs: derivePrereqs(s.goal_kind, ws as any), asked_at: s.created_at,
  });
  requests.link({ request_id: r.id, session_id: s.id, role, primary: true, linked_at: s.created_at, linked_by: s.created_by, attribution: a?.how ?? null, ambiguous: !!a?.ambiguous });
  syncSession(s.id);
  return r;
}

/** The request one Robert turn carried into one workspace — created the first time the turn touches it. */
function requestForTurn(turn: string, ws: string | null): RequestRow | undefined {
  const b = bound.get(turn);
  if (b) {
    const r = requests.get(b);
    // The wall: a bound row from another workspace never takes this one's terminals.
    if (r && (r.workspace_id ?? null) === ws) return r;
    if (r) return undefined;
  }
  const hit = requests.byTurn(turn, ws);
  if (hit) return hit;
  const t = turns.get(turn);
  if (!t) return undefined;
  const base = { words: t.words, via: (t.voice ? "voice" : "typed") as Via, surface: t.surface, opened_by: "robert", turn_id: turn, asked_at: t.at };
  if ((t.ws ?? null) === ws) return requests.create({ ...base, workspace_id: ws });
  // A message to the whole shop (or to several projects): one row for what he said — the operator's
  // only — and one per project it reached, so each project's row stays inside that project.
  const parent = requests.byTurn(turn, null) ?? requests.create({ ...base, workspace_id: null });
  return requests.create({ ...base, workspace_id: ws, parent_id: parent.id });
}

/** Robert opened it on his own (a wake, a self-wake): one request per turn, in Robert's words. */
function requestForOwnTurn(turn: string, s: Session): RequestRow {
  const ws = s.workspace_id ?? null;
  const hit = requests.byTurn(turn, ws);
  if (hit) return hit;
  const w = ws ? workspaces.get(ws) : undefined;
  return requests.create({
    workspace_id: ws, words: wordsOfSession(s, "robert"), via: "robert", opened_by: s.created_by ?? "robert", turn_id: turn,
    kind: s.goal_kind ?? null, kind_source: "terminal", prereqs: derivePrereqs(s.goal_kind, w as any), asked_at: s.created_at,
  });
}

function onStarted(id: string, nowMs: number, caller?: CallerHint): void {
  const s = sessions.get(id);
  if (!s) return;
  // A reopen, a revive, a promote-to-Lead: the same terminal, already in the ledger.
  if (requests.linksOfSession(id).length) return syncSession(id);
  const by = (s.created_by ?? "operator").trim() || "operator";
  if (s.lead_id && inheritFromLead(s)) return;
  // A stand-in carries someone else's request; its own event links it (or the sweep adopts it).
  if (DEFERRED_OPENERS.has(by)) return;
  if (by === "robert") return attributeRobertOpen(s, nowMs, caller);
  openOwn(s, viaOf(by), "opened");
}

/**
 * Robert opened it: the operator's request if the turn that announced it was his, a request of
 * Robert's own if it was a wake's. Whatever decided it — and whether it was a guess — is on the link.
 */
function attributeRobertOpen(s: Session, nowMs: number, caller?: CallerHint): void {
  const ws = s.workspace_id ?? null;
  const a = attributeTurn(ws, { kind: "open", goal: s.spawn_goal ?? s.goal ?? null }, nowMs, caller);
  const r = a ? (a.lane === "operator" ? requestForTurn(a.turn, ws) : requestForOwnTurn(a.turn, s)) : undefined;
  if (!r) {
    openOwn(s, "robert", "opened", a);
    return;
  }
  requests.link({ request_id: r.id, session_id: s.id, role: "opened", primary: true, linked_at: s.created_at, linked_by: "robert", attribution: a!.how, ambiguous: a!.ambiguous });
  syncSession(s.id);
}

/** A Lead's worker serves its Lead's request(s). False when the Lead has none to give. */
function inheritFromLead(s: Session): boolean {
  if (!s.lead_id) return false;
  const lead = requests.linksOfSession(s.lead_id, { open: true }).filter((l) => l.primary);
  let linked = false;
  for (const l of lead) {
    const r = requests.get(l.request_id);
    if (!r || (r.workspace_id ?? null) !== (s.workspace_id ?? null)) continue;
    requests.link({ request_id: r.id, session_id: s.id, role: "worker", primary: true, linked_at: s.created_at, linked_by: s.created_by });
    linked = true;
  }
  if (linked) syncSession(s.id);
  return linked;
}

/** Did this link's request already get a hand-off (or a ticked goal) from its terminal? */
function finishedThrough(s: Session, l: RequestLink): boolean {
  if (outcomesIn(s, l).length) return true;
  return !!s.goal_done_at && s.goal_done_at >= l.linked_at && (!l.until || s.goal_done_at < l.until);
}

/**
 * Robert typed the operator's words into a terminal. Mid-work, it is an adjustment: the terminal's own
 * request keeps what it hands off, and this request follows it as a steer until it does. Once the
 * terminal had already handed its request off, the words are new work: this request takes it over.
 * A turn of Robert's own (a wake answering a prompt) is him driving existing work — no new request.
 * A guess never moves who owns a terminal's hand-offs: an ambiguous steer only rides along.
 */
function onRobertTyped(id: string, nowMs: number, text: string | null, caller?: CallerHint): void {
  const s = sessions.get(id);
  if (!s) return;
  const ws = s.workspace_id ?? null;
  const a = attributeTurn(ws, { kind: "type", sessionId: id, text }, nowMs, caller);
  if (!a || a.lane !== "operator") return;
  const r = requestForTurn(a.turn, ws);
  if (!r || (r.workspace_id ?? null) !== ws) return;
  if (requests.linksOfSession(id).some((l) => l.request_id === r.id)) return;
  const prim = requests.primaryAt(id);
  const at = iso(nowMs);
  const takeOver = !prim || (!a.ambiguous && finishedThrough(s, prim));
  if (prim && takeOver) requests.closeLink(prim.request_id, id, at);
  requests.link({ request_id: r.id, session_id: id, role: "steer", primary: takeOver, linked_at: at, linked_by: "robert", attribution: a.how, ambiguous: a.ambiguous });
  syncSession(id);
  if (prim) recompute(prim.request_id, nowMs);
}

/** A terminal took over another's work (failover, a continuation): its requests move with it. */
function handOver(fromId: string, toId: string, nowMs: number): void {
  const to = sessions.get(toId);
  if (!to) return;
  const open = requests.linksOfSession(fromId, { open: true });
  if (!open.length) {
    if (!requests.linksOfSession(toId).length) openOwn(to, viaOf(to.created_by), "adopted");
    return;
  }
  for (const l of open) {
    const r = requests.get(l.request_id);
    if (!r || (r.workspace_id ?? null) !== (to.workspace_id ?? null)) continue;
    requests.link({ request_id: r.id, session_id: toId, role: "standin", primary: l.primary, linked_at: to.created_at, linked_by: to.created_by });
    requests.closeLink(r.id, fromId, iso(nowMs));
  }
  syncSession(fromId);
  syncSession(toId);
}

// ───────────────────────────── what came back: outcomes, asks, drafts, pages ─────────────────────────────

function outcomesOf(s: Session): Outcome[] {
  return [...(s.outcome_prev ?? []), ...(s.outcome ? [s.outcome] : [])].filter((o) => o && o.at).sort((a, b) => a.at.localeCompare(b.at));
}
/** The hand-offs that count for one link: filed inside [linked_at, until). */
function outcomesIn(s: Session, l: RequestLink): Outcome[] {
  return outcomesOf(s).filter((o) => o.at >= l.linked_at && (!l.until || o.at < l.until));
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const prLabel = (url: string) => {
  const m = PR_URL.exec(url);
  return m ? `PR #${m[3]} (${m[1]}/${m[2]})` : url;
};
const ITEM_VERB: Record<Action, string> = { merge: "merge", deploy: "deploy", send: "send", review: "review", answer: "answer" };

/**
 * Put a question to him about one deliverable. Asked once per hand-off (the key carries the source),
 * and a newer asking of the same question on the same target — within this workspace — retires the
 * older open ones, so a corrected hand-off or a follow-up never leaves him two items for one PR.
 */
function raiseItem(r: RequestRow, action: Action, d: Deliverable, sourceAt: string, version: string = sourceAt): void {
  if (FINAL_DELIVERABLE.has(d.state)) return;
  const { item, created } = requests.upsertItem({
    request_id: r.id, action, label: d.label || d.ref, item_key: `${action}|${d.id}|${version}`, deliverable_id: d.id, target_hash: d.target_hash, source_at: sourceAt,
  });
  if (!created) return;
  for (const twin of twinsOf(d, r.workspace_id)) {
    for (const other of requests.itemsForDeliverable(twin.id)) {
      if (other.id === item.id || other.action !== action) continue;
      if ((other.source_at ?? "") > sourceAt) { requests.supersede(item.id, other.id); return; } // a newer asking exists: this one is history
      requests.supersede(other.id, item.id);
    }
  }
}
/** The same deliverable as other requests in this workspace know it (one PR, one recipient). */
function twinsOf(d: Deliverable, ws: string | null): Deliverable[] {
  return requests.deliverablesByRef(d.kind, d.ref, ws ?? null);
}
/** Carried out (or ended) another way: the item asking for it is no longer the question. */
function settle(d: Deliverable, state: DeliverableState, actions: Action[]): void {
  for (const twin of [d, ...twinsOf(d, requests.get(d.request_id)?.workspace_id ?? null).filter((x) => x.id !== d.id)]) {
    requests.setDeliverableState(twin.id, state);
    for (const it of requests.itemsForDeliverable(twin.id)) if (actions.includes(it.action)) requests.supersede(it.id, null);
  }
}

/**
 * One hand-off into the request: its deliverables always; its questions only when it is the newest one
 * in the window. Live, every hand-off is the newest when it lands, so this changes nothing there; on a
 * backfill or replay it keeps hand-offs he already dealt with from coming back as open questions.
 */
function recordOutcome(r: RequestRow, s: Session, o: Outcome, raise: boolean): void {
  const shippedMerge = o.shipped.some((x) => /\bmerg/i.test(x));
  const shippedDeploy = o.shipped.some((x) => /\bdeploy/i.test(x));
  const prs = o.prs.map((url) => requests.upsertDeliverable({ request_id: r.id, session_id: s.id, kind: "pr", ref: url, label: prLabel(url), source_at: o.at }));
  if (shippedMerge) for (const d of prs) settle(d, "merged", ["merge"]);
  const kind = (s.goal_kind ?? r.kind) as GoalKind | null;
  const answer = () =>
    requests.upsertDeliverable({ request_id: r.id, session_id: s.id, kind: "answer", ref: `outcome:${s.id}:${o.at}`, label: clip(o.summary, 200) || "the hand-off", source_at: o.at });
  // An analysis or a QA pass hands off an answer: the hand-off itself is what came back.
  const ans = kind === "investigation" || kind === "qa" ? answer() : null;
  // …and the document, dashboard or page it says it delivered, each by its link.
  for (const l of deliveredLinks(o)) requests.upsertDeliverable({ request_id: r.id, session_id: s.id, kind: l.kind, ref: l.url, label: clip(l.url.replace(/^https?:\/\//, ""), 120), source_at: o.at });
  const wantsMerge = (o.ask === "merge" || o.ask === "merge+deploy") && !shippedMerge;
  const wantsDeploy = (o.ask === "deploy" || o.ask === "merge+deploy") && !shippedDeploy;
  const ask = (action: Action, d: Deliverable) => { if (raise) raiseItem(r, action, d, o.at); };
  for (const d of prs) if (wantsMerge) ask("merge", requests.deliverable(d.id)!);
  // A merge asked for with no PR on the hand-off: nothing to bind a merge to. He reads it instead.
  if (wantsMerge && !prs.length) ask("review", ans ?? answer());
  if (wantsDeploy || shippedDeploy) {
    const d = requests.upsertDeliverable({ request_id: r.id, session_id: s.id, kind: "deploy", ref: `deploy:${o.prs[0] ?? s.id}`, label: `deploy ${o.prs[0] ? prLabel(o.prs[0]) : clip(s.goal, 80)}`, source_at: o.at });
    if (shippedDeploy) settle(d, "deployed", ["deploy"]);
    else ask("deploy", d);
  }
  if (o.ask === "review") ask("review", prs[0] ? requests.deliverable(prs[0].id)! : ans ?? answer());
}

/** A hand-off replaced by a correction is gone from the terminal: what it raised is no longer the question. */
function retireVanished(r: RequestRow, s: Session): void {
  const ats = new Set(outcomesOf(s).map((o) => o.at));
  for (const d of requests.deliverables(r.id)) {
    if (d.kind !== "answer" || d.session_id !== s.id || d.state !== "open") continue;
    const at = d.ref.slice(`outcome:${s.id}:`.length);
    if (d.ref.startsWith(`outcome:${s.id}:`) && !ats.has(at)) settle(d, "superseded", ["review"]);
  }
}

/** Open questions for the operator on this terminal become `answer` items on the request that owned it then. */
function syncAsks(s: Session, links: RequestLink[], nowMs: number): void {
  const seen = new Set<string>();
  for (const a of [...asks.openForSession(s.id), ...holderAsks(s.id)]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    // With Robert or a Lead still: not his yet.
    if (!isOperatorsAsk(a)) continue;
    const owner = requests.primaryAt(s.id, a.created_at) ?? requests.primaryAt(s.id);
    if (!owner) continue;
    const held = !!a.hold_until && Date.parse(a.hold_until) > nowMs;
    const { item, created } = requests.upsertItem({
      request_id: owner.request_id, action: "answer", label: a.question, item_key: `answer|${a.id}`, ask_id: a.id,
      status: held ? "held" : "open", hold_until: held ? a.hold_until : null,
    });
    // A hold lives on the ask (holds.ts): the item mirrors it both ways.
    if (!created && held && item.status === "open") requests.setHold(item.id, a.hold_until);
    else if (!created && !held && item.status === "held") requests.reopen(item.id);
  }
  // Items whose ask is no longer open: answered (his words), or gone without an answer.
  const rids = new Set(links.map((l) => l.request_id));
  for (const rid of rids) {
    for (const it of requests.items(rid)) {
      if (it.action !== "answer" || !it.ask_id || (it.status !== "open" && it.status !== "held")) continue;
      const a = asks.get(it.ask_id);
      if (!a || a.status === "cancelled") requests.supersede(it.id, null);
      else if (a.status === "answered") requests.decide(it.id, { decision: "answered", words: a.answer, by: a.answered_by, at: a.answered_at ?? undefined });
    }
  }
}

/**
 * Re-read one terminal into every request it serves: its hand-offs (deliverables + items), its open
 * questions, then each request's state. Reads rows only, so it is safe to call on any event, any
 * number of times, in any order.
 */
export function syncSession(id: string, nowMs = Date.now()): void {
  const s = sessions.get(id);
  if (!s) return;
  const links = requests.linksOfSession(id);
  if (!links.length) return;
  const touched = new Set<string>();
  for (const l of links) {
    touched.add(l.request_id);
    if (!l.primary) continue;
    const r = requests.get(l.request_id);
    if (!r) continue;
    const outs = outcomesIn(s, l);
    outs.forEach((o, i) => recordOutcome(r, s, o, i === outs.length - 1));
    retireVanished(r, s);
  }
  syncAsks(s, links, nowMs);
  for (const rid of touched) {
    refreshResultAt(rid);
    recompute(rid, nowMs);
  }
}

function refreshResultAt(rid: string): void {
  let newest: string | null = null;
  for (const l of requests.linksFor(rid)) {
    if (!l.primary) continue;
    const s = sessions.get(l.session_id);
    const outs = s ? outcomesIn(s, l) : [];
    const at = outs.length ? outs[outs.length - 1].at : null;
    if (at && (!newest || at > newest)) newest = at;
  }
  requests.setResultAt(rid, newest);
}

/**
 * A draft an agent left (it never sends — no-send.ts), announced by its terminal's hook. The draft's
 * identity is its channel and recipient; its target hash is what it says now (ledger-model.ts
 * draftHash, computed by `mc hook` where the text is). Rewriting it raises a new `send` item and
 * retires the old one, so a yes always names the words that would go out.
 */
export function noteDraft(sessionId: string, body: { label?: string | null; tool?: { name?: string } | null; target?: { channel?: string; to?: string; hash?: string } | null }, nowMs = Date.now()): void {
  const owner = requests.primaryAt(sessionId);
  if (!owner) return;
  const r = requests.get(owner.request_id);
  if (!r) return;
  const t = body.target?.channel && body.target?.to ? body.target : null;
  const kind: DeliverableKind = (t?.channel ?? "").toLowerCase() === "email" || /(?:^|__)(create|update)_draft$/.test(body.tool?.name ?? "") ? "email_draft" : "slack_draft";
  const label = clip(body.label, 200) || (kind === "email_draft" ? "email draft" : "Slack draft");
  const ref = t ? `${String(t.channel).toLowerCase()}:${String(t.to).trim().toLowerCase()}` : `draft:${label}`;
  const hash = t?.hash && /^sha256:[0-9a-f]{64}$/.test(t.hash) ? t.hash : null;
  const at = iso(nowMs);
  const d = requests.upsertDeliverable({ request_id: r.id, session_id: sessionId, kind, ref, label, target_hash: hash, source_at: at });
  // Asked once per version of the words: the same draft announced twice is one question.
  raiseItem(r, "send", d, at, hash ?? label);
  recompute(r.id, nowMs);
}

function onArtifact(e: { topic: string; artifact_id: string; session_id?: string | null; title?: string; version?: number }): void {
  if (!e.session_id) return;
  const owner = requests.primaryAt(e.session_id);
  if (!owner) return;
  if (e.topic === "artifact.created") {
    requests.upsertDeliverable({ request_id: owner.request_id, session_id: e.session_id, kind: "artifact", ref: e.artifact_id, label: e.title ?? "page", target_hash: "v1", source_at: new Date().toISOString() });
  } else {
    const d = requests.deliverables(owner.request_id).find((x) => x.kind === "artifact" && x.ref === e.artifact_id);
    if (d && e.version) requests.bindTarget(d.id, `v${e.version}`);
  }
  recompute(owner.request_id);
}

// ───────────────────────────── state ─────────────────────────────

type PhaseFn = (sessionId: string) => { phase: string; line: string | null } | null;
let phaseProvider: PhaseFn = (id) => {
  const st = statusOf(id);
  return st ? { phase: st.phase, line: st.line || null } : null;
};
/** Tests: a scripted terminal status instead of term-status's live resolver. null restores it. */
export function setLedgerPhaseProvider(fn: PhaseFn | null): void {
  phaseProvider = fn ?? ((id) => {
    const st = statusOf(id);
    return st ? { phase: st.phase, line: st.line || null } : null;
  });
}
function phaseOf(id: string): { phase: string; line: string | null } | null {
  const hit = lastStatus.get(id);
  if (hit) return hit;
  try { return phaseProvider(id); } catch { return null; }
}

function terminalView(l: RequestLink): TerminalView {
  const s = sessions.get(l.session_id);
  const base = { session_id: l.session_id, primary: l.primary, current: !l.until };
  if (!s) return { ...base, live: false, phase: "ended", line: null, kind: null, outcome_at: null, goal_reached: false };
  const st = s.status === "live" ? phaseOf(s.id) : null;
  const live = s.status === "live" && !!st && st.phase !== "ended";
  const outs = outcomesIn(s, l);
  return {
    ...base,
    live,
    phase: live ? st!.phase : "ended",
    line: st?.line ?? null,
    kind: s.goal_kind ?? null,
    outcome_at: outs.length ? outs[outs.length - 1].at : null,
    goal_reached: !!s.goal_done_at && s.goal_done_at >= l.linked_at && (!l.until || s.goal_done_at < l.until),
  };
}

function itemView(i: DecisionItem): ItemView {
  const d = i.deliverable_id ? requests.deliverable(i.deliverable_id) : undefined;
  return { action: i.action, status: i.status, label: i.label, decision: i.decision, hold_until: i.hold_until, deliverable_state: d?.state ?? null };
}

/** Re-derive one request's state from its rows (and its children's, for a fleet-wide one). Idempotent. */
export function recompute(id: string, nowMs = Date.now()): RequestRow | undefined {
  const r = requests.get(id);
  if (!r) return undefined;
  const links = requests.linksFor(id);
  const views = links.map(terminalView);
  // The work type follows the terminal doing the work — its agent sharpens it (`mc goal set --kind`) —
  // unless whoever opened the request said what it is.
  const prim = views.find((v) => v.primary && v.current && v.kind);
  if (prim?.kind && r.kind_source !== "set" && prim.kind !== r.kind) {
    const ws = r.workspace_id ? workspaces.get(r.workspace_id) : undefined;
    const kept = r.prereqs.filter((p) => p.source === "set");
    requests.setKind(id, prim.kind, "terminal", [...kept, ...derivePrereqs(prim.kind, ws as any)]);
  }
  const children = r.workspace_id === null ? requests.list({ parent_id: id, limit: 100 }).map((c) => ({ state: c.state, line: c.state_line })) : [];
  const out = rollUp({
    closed_at: r.closed_at, closed_reason: r.closed_reason, asked_at: r.asked_at,
    terminals: views, items: requests.items(id).map(itemView), children, now: nowMs,
  });
  if (requests.setState(id, out.state, out.line)) {
    bus.publish({ topic: "ledger.updated", request_id: id, workspace_id: r.workspace_id, state: out.state });
  }
  if (r.parent_id) recompute(r.parent_id, nowMs);
  return requests.get(id);
}

// ───────────────────────────── sweep, adoption, backfill ─────────────────────────────

/** When the ledger first ran on this database: live terminals older than this are backfilled. */
export function ledgerSince(): string {
  let v = kv.get(SINCE_KEY);
  if (!v) { v = new Date().toISOString(); kv.set(SINCE_KEY, v); }
  return v;
}

/**
 * Give every live terminal a request. One that predates the ledger is backfilled (what was said to
 * open it is not known; its goal stands in); one a deferred opener never linked is adopted under its
 * opener. Leads go first so their workers inherit. Idempotent: a linked terminal is skipped.
 */
export function adoptOrphans(nowMs = Date.now(), opts: { graceMs?: number } = {}): { backfilled: string[]; adopted: string[] } {
  const since = ledgerSince();
  const grace = opts.graceMs ?? ORPHAN_GRACE_MS;
  const out = { backfilled: [] as string[], adopted: [] as string[] };
  const rows = sessions.list({ status: "live", limit: 500 }).sort((a, b) => (a.role === "lead" ? 0 : 1) - (b.role === "lead" ? 0 : 1) || a.created_at.localeCompare(b.created_at));
  for (const s of rows) {
    if (requests.linksOfSession(s.id).length) continue;
    const predates = s.created_at < since;
    if (!predates && nowMs - Date.parse(s.created_at) < grace) continue;
    if (s.lead_id && inheritFromLead(s)) continue;
    const r = predates ? openOwn(s, "backfill", "backfill") : openOwn(s, viaOf(s.created_by), "adopted");
    (predates ? out.backfilled : out.adopted).push(r.id);
  }
  return out;
}

/** The one-off for day one: every live terminal gets its request now, no grace. */
export function backfillLive(nowMs = Date.now()) {
  return adoptOrphans(nowMs, { graceMs: 0 });
}

/**
 * What time alone moves: a dated "later" coming due, a PR GitHub settled (session_prs is polled by the
 * ship loop), a terminal nobody linked, a request whose pickup grace ran out. Then every open row is
 * re-derived, which also heals anything an event was missed for.
 */
export function sweepLedger(nowMs = Date.now()): void {
  for (const it of requests.holdsDue(iso(nowMs))) {
    // An answer item mirrors its ask's hold (holds.ts): back only while the ask is still open and not re-dated.
    if (it.action === "answer") {
      const a = it.ask_id ? asks.get(it.ask_id) : undefined;
      if (a?.status !== "open" || (a.hold_until && Date.parse(a.hold_until) > nowMs)) continue;
    }
    requests.reopen(it.id);
  }
  for (const d of requests.openOfKind("pr")) {
    const pr = sessionPrs.get(d.ref);
    if (pr?.state === "merged") settle(d, "merged", ["merge"]);
    else if (pr?.state === "closed") settle(d, "closed", ["merge", "deploy"]);
  }
  adoptOrphans(nowMs);
  for (const r of requests.open()) {
    try { recompute(r.id, nowMs); } catch (e: any) { console.warn("[ledger] recompute", r.id.slice(0, 8), e?.message ?? e); }
  }
}

// ───────────────────────────── the bus ─────────────────────────────

/** Every event the ledger listens to. Exported so tests drive it directly; the bus is just the wire. */
export function onLedgerEvent(e: any, nowMs = Date.now()): void {
  switch (e?.topic) {
    case "agent.asked": return noteAsked(e, nowMs);
    case "agent.step": return noteStep(e, nowMs);
    case "agent.delta": return noteDelta(e, nowMs);
    // Only a push that names its turn ends one: chat dividers, ask cards and Telegram replies name none
    // and must not cut short a turn still running on that thread. (agent.turn.done names only a thread,
    // which two lanes share — it ends nothing; POST /agent's own push names its turn.)
    case "agent.push":
      if (e.turn) endTurn(e.turn);
      return;
    // The seam (ledger.ts attributeTurn): when the API knows which turn or lane made a request — a
    // lane-tagged credential, planned — it puts `turn` / `lane` on these events and nothing is guessed.
    case "session.started": return onStarted(e.session_id, nowMs, { turn: e.turn ?? null, lane: e.lane ?? null });
    case "session.input":
      if (e.by === "robert") onRobertTyped(e.session_id, nowMs, typeof e.text === "string" ? e.text : null, { turn: e.turn ?? null, lane: e.lane ?? null });
      return;
    case "session.status":
      if (e.status && typeof e.status.phase === "string") lastStatus.set(e.session_id, { phase: e.status.phase, line: e.status.line ?? null });
      return syncSession(e.session_id, nowMs);
    case "session.updated":
      return syncSession(e.session_id, nowMs);
    case "session.ended":
      lastStatus.delete(e.session_id);
      return syncSession(e.session_id, nowMs);
    case "session.failover":
      if (e.step === "backend" && e.to_session_id) handOver(e.session_id, e.to_session_id, nowMs);
      return;
    case "session.host_failover":
      if (e.to_session_id && e.mode !== "stuck") handOver(e.session_id, e.to_session_id, nowMs);
      return;
    case "continuation.fired": {
      if (e.how !== "opened") return;
      const c = continuations.get(e.continuation_id);
      if (c?.session_id && c.session_id !== e.session_id) handOver(c.session_id, e.session_id, nowMs);
      else if (!requests.linksOfSession(e.session_id).length) {
        const s = sessions.get(e.session_id);
        if (s) openOwn(s, "continuation", "opened");
      }
      return;
    }
    case "ask.created":
    case "ask.answered": {
      const a = e.ask_id ? asks.get(e.ask_id) : undefined;
      const sid = e.session_id ?? a?.session_id ?? (e.ask_id ? heldBy(e.ask_id) : null);
      if (sid) syncSession(sid, nowMs);
      for (const it of e.ask_id ? requests.itemsForAsk(e.ask_id) : []) recompute(it.request_id, nowMs);
      return;
    }
    case "artifact.created":
    case "artifact.updated":
      return onArtifact(e);
  }
}

/** Forget what lives only in memory — the in-flight turns and cached statuses — as a restart does. Tests. */
export function resetLedgerMemory(): void {
  turns.clear();
  live.clear();
  bound.clear();
  lastStatus.clear();
}

let started = false;
export function startLedger(): void {
  if (started) return;
  started = true;
  ledgerSince();
  bus.on("event", (e: any) => {
    try { onLedgerEvent(e); } catch (err: any) { console.warn("[ledger]", e?.topic, err?.message ?? err); }
  });
  // After boot, once terminals are re-adopted (index.ts startTerminals): backfill and re-derive.
  const first = setTimeout(() => { try { sweepLedger(); } catch (err) { console.warn("[ledger] boot sweep", err); } }, BOOT_DELAY_MS);
  first.unref?.();
  const t = setInterval(() => { try { sweepLedger(); } catch (err) { console.warn("[ledger] sweep", err); } }, SWEEP_MS);
  t.unref?.();
}

// ───────────────────────────── decisions ─────────────────────────────

export type DecisionInput = {
  request: string;
  /** Which item (id or prefix). Optional when the request owes exactly one. */
  item?: string | null;
  decision: "yes" | "no" | "later" | "change";
  words?: string | null;
  target_hash?: string | null;
  /** For later: ISO, or +30m / +2h / +1d. Absent = undated. */
  until?: string | null;
  by?: string | null;
  audio_ref?: string | null;
};
export type DecisionResult =
  | { ok: true; item: DecisionItem; request: RequestRow }
  | { ok: false; status: number; error: string; items?: Array<{ id: string; action: Action; label: string; target_hash: string | null }>; ask_id?: string; target_hash?: string | null };

/** `+30m` / `+2h` / `+1d` / ISO → ISO, or null when it cannot be read. */
export function parseUntil(v: string, nowMs = Date.now()): string | null {
  const m = /^\+(\d+)\s*([mhd])$/i.exec(v.trim());
  if (m) return iso(nowMs + Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2].toLowerCase() as "m" | "h" | "d"]);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : iso(t);
}

/**
 * Record the operator's answer to one decision item — and nothing else: no merge, no send, no deploy.
 * The executor (a later piece) acts on a recorded yes. A yes on anything that changes the outside
 * world must name the target he was shown, and that target must still be what the item and its
 * deliverable say now; a decision that names a target always has to match.
 */
export function recordDecision(inp: DecisionInput, nowMs = Date.now()): DecisionResult {
  const r = requests.resolve(inp.request);
  if (!r) return { ok: false, status: 404, error: "no such request" };
  const pending = requests.items(r.id).filter((i) => i.status === "open" || i.status === "held");
  const brief = (xs: DecisionItem[]) => xs.map((i) => ({ id: i.id, action: i.action, label: i.label, target_hash: i.target_hash }));
  let item: DecisionItem | undefined;
  if (inp.item) {
    const hits = requests.items(r.id).filter((i) => i.id === inp.item || i.id.startsWith(String(inp.item)));
    if (hits.length !== 1) return { ok: false, status: 404, error: "no such item on this request" };
    item = hits[0];
    if (item.status !== "open" && item.status !== "held") return { ok: false, status: 409, error: `that item is already ${item.status}` };
  } else if (pending.length === 1) {
    item = pending[0];
  } else if (!pending.length) {
    return { ok: false, status: 409, error: "nothing on this request waits for a decision" };
  } else {
    return { ok: false, status: 409, error: "this request owes more than one decision — name the item", items: brief(pending) };
  }
  if (item.action === "answer") {
    return { ok: false, status: 409, error: "answer it on its ask (POST /api/asks/<id>/answer) — the ledger follows the ask", ask_id: item.ask_id ?? undefined };
  }
  const given = inp.target_hash ?? null;
  if (inp.decision === "yes" && EXECUTABLE.has(item.action)) {
    if (!item.target_hash) return { ok: false, status: 409, error: `not bound yet — there is no ${item.action === "send" ? "draft hash" : "PR head"} to approve against`, target_hash: null };
    const d = item.deliverable_id ? requests.deliverable(item.deliverable_id) : undefined;
    if (given !== item.target_hash || (d && d.target_hash !== item.target_hash)) {
      return { ok: false, status: 409, error: "target changed since it was put to you — hear it again", target_hash: d?.target_hash ?? item.target_hash };
    }
  } else if (given !== null && given !== item.target_hash) {
    return { ok: false, status: 409, error: "target changed since it was put to you — hear it again", target_hash: item.target_hash };
  }
  const words = (inp.words ?? "").trim();
  if (inp.decision === "change" && !words) return { ok: false, status: 400, error: "a change needs his words: what to change" };
  let hold: string | null = null;
  if (inp.decision === "later" && inp.until) {
    hold = parseUntil(inp.until, nowMs);
    if (!hold) return { ok: false, status: 400, error: "until: ISO time or +30m / +2h / +1d" };
    if (Date.parse(hold) <= nowMs) return { ok: false, status: 400, error: "until is in the past" };
  }
  const done = requests.decide(item.id, { decision: inp.decision, words: words || null, by: inp.by ?? "operator", hold_until: hold, audio_ref: inp.audio_ref ?? null, at: iso(nowMs) });
  if (!done) return { ok: false, status: 409, error: "that item was decided in the meantime" };
  bus.publish({
    topic: "ledger.decided", request_id: r.id, item_id: done.id, workspace_id: r.workspace_id, action: done.action, decision: inp.decision,
    by: done.decided_by, target_hash: done.target_hash, actor: done.decided_by ?? "operator",
  });
  return { ok: true, item: done, request: recompute(r.id, nowMs) ?? r };
}

/** He closed it ("drop it", "that's done"): whatever it still owed is no longer a question. */
export function closeRequest(id: string, words: string | null, by: string | null, nowMs = Date.now()): RequestRow | undefined {
  const r = requests.resolve(id);
  if (!r) return undefined;
  requests.close(r.id, words?.trim() ? `closed by ${by ?? "the operator"}: ${clip(words, 200)}` : `closed by ${by ?? "the operator"}`);
  for (const it of requests.items(r.id)) if (it.status === "open" || it.status === "held") requests.supersede(it.id, null);
  for (const c of requests.list({ parent_id: r.id, limit: 100 })) closeRequest(c.id, words, by, nowMs);
  return recompute(r.id, nowMs);
}

// ───────────────────────────── read views ─────────────────────────────

const wsInfo = (id: string | null) => {
  if (!id) return null;
  const w = workspaces.get(id);
  return w ? { id: w.id, slug: w.slug, name: w.name } : { id, slug: id, name: id };
};

function titleOf(r: RequestRow, links: RequestLink[]): string {
  const ordered = [...links.filter((l) => l.primary && !l.until), ...links];
  for (const l of ordered) {
    const g = sessions.get(l.session_id)?.goal;
    if (g?.trim()) return clip(g, 120);
  }
  return clip(r.words.split("\n")[0], 120) || "(no words)";
}

export type RequestSummary = ReturnType<typeof summaryOf>;
export function summaryOf(r: RequestRow) {
  const links = requests.linksFor(r.id);
  const open = requests.items(r.id).filter((i) => i.status === "open");
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    workspace: wsInfo(r.workspace_id),
    parent_id: r.parent_id,
    words: r.words,
    via: r.via,
    surface: r.surface,
    kind: r.kind,
    title: titleOf(r, links),
    state: r.state,
    state_line: r.state_line,
    state_at: r.state_at,
    asked_at: r.asked_at,
    result_at: r.result_at,
    closed_at: r.closed_at,
    terminals: links.map((l) => {
      const s = sessions.get(l.session_id);
      const st = s?.status === "live" ? phaseOf(l.session_id) : null;
      return { session_id: l.session_id, role: l.role, primary: l.primary, current: !l.until, goal: s?.goal ?? null, phase: s?.status === "live" ? st?.phase ?? null : "ended", ambiguous: l.ambiguous };
    }),
    open_decisions: open.length,
    next: open[0] ? `${ITEM_VERB[open[0].action]}: ${open[0].label}` : null,
  };
}

/** One request in full: what serves it, what came back, what it owes, the verifier's slots. */
export function detailOf(r: RequestRow, opts: { operator: boolean }) {
  const links = requests.linksFor(r.id);
  const checks = requests.checks(r.id);
  const result: Array<{ session_id: string; outcome: Outcome }> = [];
  for (const l of links) {
    if (!l.primary) continue;
    const s = sessions.get(l.session_id);
    if (s) for (const o of outcomesIn(s, l)) result.push({ session_id: s.id, outcome: o });
  }
  result.sort((a, b) => a.outcome.at.localeCompare(b.outcome.at));
  return {
    ...summaryOf(r),
    opened_by: r.opened_by,
    turn_id: r.turn_id,
    prereqs: r.prereqs as Prereq[],
    work: r.kind ? { kind: r.kind, label: WORK[r.kind].label, done: WORK[r.kind].done, deliverables: WORK[r.kind].deliverables, actions: WORK[r.kind].actions } : null,
    terminals: links.map((l) => {
      const s = sessions.get(l.session_id);
      const v = terminalView(l);
      return {
        session_id: l.session_id, role: l.role, primary: l.primary, linked_at: l.linked_at, until: l.until,
        attribution: l.attribution, ambiguous: l.ambiguous,
        goal: s?.goal ?? null, goal_kind: s?.goal_kind ?? null, done_when: s?.done_when ?? [], done_checked: s?.done_checked ?? [],
        live: v.live, phase: v.phase, line: v.line, created_by: s?.created_by ?? null,
      };
    }),
    result,
    deliverables: requests.deliverables(r.id),
    decisions: requests.items(r.id),
    checks,
    expected_checks: expectedChecks(r.kind, checks),
    // A fleet-wide row's per-project children are the operator's view only.
    children: opts.operator && r.workspace_id === null ? requests.list({ parent_id: r.id, limit: 100 }).map(summaryOf) : [],
  };
}

export type QueueItem = ReturnType<typeof queueView>["items"][number];
/**
 * The approval queue: every item whose result is in and which waits for his word, in the order he
 * should hear them (ledger-model.ts queueRank), plus what he deferred. `ws` undefined = every
 * workspace (the operator); a workspace id = that workspace only.
 */
export function queueView(ws: string | undefined) {
  const pending = requests.pendingItems(ws);
  const shape = (i: DecisionItem & { workspace_id: string | null }) => {
    const r = requests.get(i.request_id)!;
    const d = i.deliverable_id ? requests.deliverable(i.deliverable_id) : undefined;
    // Only checks on this target count: a pass for an older PR head is not a pass for this one.
    const mine = requests.checks(r.id).filter((c) => (!c.deliverable_id || c.deliverable_id === i.deliverable_id) && (!c.target_hash || c.target_hash === i.target_hash));
    const exp = expectedChecks(r.kind, mine);
    const checks = {
      pass: exp.filter((c) => c.status === "pass").length,
      fail: exp.filter((c) => c.status === "fail").length,
      missing_required: exp.filter((c) => c.required && c.status === "missing").length,
    };
    const title = titleOf(r, requests.linksFor(r.id));
    const where = ws === undefined && r.workspace_id ? ` in ${wsInfo(r.workspace_id)?.name}` : "";
    const verified = checks.fail ? `${checks.fail} check${checks.fail > 1 ? "s" : ""} failed` : checks.pass && !checks.missing_required ? "checks pass" : "not verified yet";
    const line = i.action === "answer"
      ? `Answer: ${clip(i.label, 160)}${where}`
      : `${ITEM_VERB[i.action][0].toUpperCase()}${ITEM_VERB[i.action].slice(1)} ${clip(i.label, 100)} for “${clip(title, 80)}”${where} — ${EXECUTABLE.has(i.action) && !i.target_hash ? "not bound yet" : verified}`;
    return {
      item_id: i.id, request_id: r.id, workspace: wsInfo(r.workspace_id), words: clip(r.words, 300), title, kind: r.kind,
      action: i.action, label: i.label, status: i.status, hold_until: i.hold_until,
      deliverable: d ? { id: d.id, kind: d.kind, ref: d.ref, label: d.label, state: d.state } : null,
      ask_id: i.ask_id, target_hash: i.target_hash, bound: !!i.target_hash, checks, created_at: i.created_at, line,
    };
  };
  const shaped = pending.map(shape);
  const items = queueOrder(shaped.filter((x) => x.status === "open"));
  const held = shaped.filter((x) => x.status === "held").sort((a, b) => (a.hold_until ?? "~").localeCompare(b.hold_until ?? "~"));
  return { items, held };
}

/**
 * The compact text for a coordinator's prompt (ledger-model.ts ledgerLines): one line per open
 * request. `ws` undefined = the fleet (with workspace names), else that workspace only. Not wired into
 * any prompt yet — the coordinator's prompt is assembled in telegram/agent.ts.
 */
export function ledgerText(ws: string | undefined, opts: { max?: number; width?: number } = {}): string {
  const rows = requests.list({ workspace_id: ws, states: [...OPEN_STATES], limit: 200 });
  const lines: LineRow[] = rows
    // The fleet view reads the per-project rows; a fleet-wide parent would say the same thing twice.
    .filter((r) => !(ws === undefined && r.workspace_id === null && requests.list({ parent_id: r.id, limit: 1 }).length))
    .map((r) => {
      const links = requests.linksFor(r.id);
      const prim = links.find((l) => l.primary && !l.until);
      let progress: string | null = null;
      if (prim) {
        try {
          const st = statusOfSafe(prim.session_id);
          if (st?.progress) progress = `${st.progress.n}/${st.progress.of}`;
        } catch { /* a status that cannot be read just has no progress */ }
      }
      return { id: r.id, state: r.state, title: titleOf(r, links), state_line: r.state_line, via: r.via, workspace: wsInfo(r.workspace_id)?.name ?? null, progress };
    });
  return ledgerLines(lines, { ...opts, withWorkspace: ws === undefined });
}
/**
 * The block put above the operator's words when the unscoped Robert takes a turn: what is open across
 * every project, from the ledger. "" when nothing is open or the ledger cannot be read — the turn
 * never fails on it.
 */
export function openWorkBlock(): string {
  try {
    const t = ledgerText(undefined, { max: 25 }).trim();
    if (!t) return "";
    return `[Open work right now, from the request ledger. Answer from this when he asks how things are or what waits for him: one voice, a few short sentences, the things that need him first. Do not re-scan the Desk for it, and do not answer project by project.]\n${t}\n\n`;
  } catch { return ""; }
}
let statusOfSafe: (id: string) => { progress?: { n: number; of: number } | null } | null = (id) => statusOf(id);
/** Tests: no live resolver for the progress fraction. */
export function setLedgerProgressProvider(fn: ((id: string) => { progress?: { n: number; of: number } | null } | null) | null): void {
  statusOfSafe = fn ?? ((id) => statusOf(id));
}
