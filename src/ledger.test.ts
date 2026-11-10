/**
 * The request ledger's writers (src/ledger.ts), driven the way the daemon drives them: by the events
 * it already publishes. Every entry point opens or links a request; state follows the terminals;
 * replayed, repeated and out-of-order events change nothing; a restart re-derives the same rows; the
 * backfill gives every live terminal a request on day one. Terminal status is scripted (no ptys).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { asks, continuations, db, kv, sessionPrs, sessions, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import * as L from "./ledger.js";
import { draftHash } from "./ledger-model.js";
import type { Outcome, Session } from "./types.js";

const phases = new Map<string, { phase: string; line: string | null }>();
L.setLedgerPhaseProvider((id) => phases.get(id) ?? { phase: "working", line: null });
L.setLedgerProgressProvider(() => null);

const mkWs = (slug: string, extra: Record<string, unknown> = {}) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/lg-${slug}-${Math.random()}`, ...extra } as any);

beforeEach(() => {
  db.exec("DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM asks; DELETE FROM session_prs; DELETE FROM sessions;");
  L.resetLedgerMemory();
  phases.clear();
  // Everything in these tests is opened after the ledger started, unless a test says otherwise.
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
});

const ev = (e: Record<string, unknown>, nowMs?: number) => L.onLedgerEvent(e, nowMs);
function open(ws: { id: string } | null, over: Partial<Session> & { first_prompt?: string } = {}): Session {
  const { first_prompt, ...rest } = over as any;
  const s = sessions.create({ workspace_id: ws?.id ?? null, cwd: "/tmp", goal: "fix the login redirect", goal_kind: "pr", ...rest } as any);
  if (first_prompt) sessions.setMeta(s.id, { first_prompt });
  ev({ topic: "session.started", session_id: s.id });
  return sessions.get(s.id)!;
}
const asked = (turn: string, words: string, ws: { id: string } | null, extra: Record<string, unknown> = {}) =>
  ev({ topic: "agent.asked", turn, you: words, ws: ws?.id ?? null, source: "desk", at: "2026-11-09T10:00:00.000Z", ...extra });
const step = (turn: string, ws: { id: string } | null, nowMs?: number) => ev({ topic: "agent.step", turn, ws: ws?.id ?? null, step: {} }, nowMs);
const status = (sid: string, phase: string, line: string | null = null) => {
  phases.set(sid, { phase, line });
  ev({ topic: "session.status", session_id: sid, status: { phase, line } });
};
let tick = 0;
const out = (over: Partial<Outcome> = {}): Outcome => ({
  summary: "fixed it", changes: [], proof: [], prs: [], shots: [], ask: "review", shipped: [],
  at: new Date(Date.now() + 1000 + tick++).toISOString(), ...over,
});
/** File a hand-off the way POST /sessions/:id/outcome stores it: a new one on top, the old one kept under it. */
function handOff(sid: string, o: Outcome, mode: "new" | "replace" = "new") {
  const s = sessions.get(sid)!;
  const earlier = mode === "new" && s.outcome ? [...s.outcome_prev, s.outcome] : s.outcome_prev;
  sessions.setOutcome(sid, o, earlier);
  ev({ topic: "session.updated", session_id: sid });
}
const only = <T>(xs: T[]): T => {
  assert.equal(xs.length, 1, `expected exactly one, got ${xs.length}`);
  return xs[0];
};
const reqOf = (sid: string) => requests.get(requests.primaryAt(sid)!.request_id)!;
const PR = "https://github.com/atlas/api/pull/12";

// ── entry points ────────────────────────────────────────────────────────────────────────────────

test("an operator turn that opens terminals: one request in his words, how he said it, fanned to each terminal", () => {
  const atlas = mkWs("atlas");
  asked("t1", "arreglá el login de atlas y actualizá el runbook", atlas, { voice: true });
  step("t1", atlas);
  const a = open(atlas, { created_by: "robert", goal: "fix the login redirect" });
  const b = open(atlas, { created_by: "robert", goal: "update the runbook", goal_kind: "investigation" });
  const r = only(requests.list({ states: undefined }));
  assert.equal(r.words, "arreglá el login de atlas y actualizá el runbook");
  assert.equal(r.via, "voice");
  assert.equal(r.surface, "desk");
  assert.equal(r.turn_id, "t1");
  assert.equal(r.workspace_id, atlas.id);
  assert.deepEqual(requests.linksFor(r.id).map((l) => [l.session_id, l.role, l.primary]), [[a.id, "opened", true], [b.id, "opened", true]]);
  assert.equal(r.kind, "pr", "the work type follows the first terminal doing the work");
  assert.equal(r.state, "working");
  // Typed, not spoken:
  asked("t2", "abrí otra para los docs", atlas);
  step("t2", atlas);
  open(atlas, { created_by: "robert", goal: "docs" });
  assert.equal(requests.byTurn("t2", atlas.id)?.via, "typed");
});

test("a turn of Robert's own (a wake) that opens terminals: one robert-initiated request per turn, in his words", () => {
  const atlas = mkWs("atlas");
  step("wake-1", atlas);
  const a = open(atlas, { created_by: "robert", goal: "check the nightly export" });
  open(atlas, { created_by: "robert", goal: "check the morning export" });
  const r = reqOf(a.id);
  assert.equal(r.via, "robert");
  assert.equal(r.words, "check the nightly export");
  assert.equal(requests.linksFor(r.id).length, 2, "the same wake turn = the same request");
  // No turn running at all: still a request, still Robert's.
  L.resetLedgerMemory();
  const c = open(atlas, { created_by: "robert", goal: "look at the queue" });
  assert.equal(reqOf(c.id).via, "robert");
  assert.notEqual(reqOf(c.id).id, r.id);
});

test("a chat card or divider posted mid-turn (no turn id) does not end the turn", () => {
  const atlas = mkWs("atlas");
  asked("t1", "abrí una terminal para el login", atlas);
  step("t1", atlas);
  ev({ topic: "agent.push", ws: atlas.id, you: "", reply: "::ask 1234abcd::", at: "x", source: "robert" });
  ev({ topic: "agent.push", ws: atlas.id, you: "", reply: "", at: "x", source: "divider" });
  const s = open(atlas, { created_by: "robert", goal: "the login" });
  assert.equal(reqOf(s.id).turn_id, "t1");
  assert.equal(reqOf(s.id).via, "typed");
  // POST /agent's own end of turn does end it.
  ev({ topic: "agent.turn.done", ws: atlas.id });
  const later = open(atlas, { created_by: "robert", goal: "something else" });
  assert.equal(reqOf(later.id).via, "robert");
});

test("a turn that ended or went quiet is not the one a later open belongs to", () => {
  const atlas = mkWs("atlas");
  asked("t1", "abrí una terminal para el login", atlas);
  step("t1", atlas);
  ev({ topic: "agent.push", turn: "t1", ws: atlas.id, you: "", reply: "", at: "x" });
  const a = open(atlas, { created_by: "robert", goal: "something Robert started later" });
  assert.equal(reqOf(a.id).via, "robert", "the operator's turn was over");
  asked("t2", "otra", atlas);
  const t0 = Date.now();
  step("t2", atlas, t0);
  // An open more than LIVE_TURN_MS after the turn's last move is not that turn's.
  const s = sessions.create({ workspace_id: atlas.id, cwd: "/tmp", goal: "late", created_by: "robert" } as any);
  ev({ topic: "session.started", session_id: s.id }, t0 + L.LIVE_TURN_MS + 1);
  assert.equal(reqOf(s.id).via, "robert");
});

test("every other opener: a request of its own, how it arrived taken from who opened it", () => {
  const atlas = mkWs("atlas");
  const seed = "Goal: fix the export\n\nBrief from your operator:\nit is empty since monday\n\nWhen the work is green: open the PR.\n\nStart now.";
  const hand = open(atlas, { created_by: "operator", goal: "fix the export", first_prompt: seed });
  assert.equal(reqOf(hand.id).via, "hand");
  assert.equal(reqOf(hand.id).words, "fix the export\n\nit is empty since monday", "his goal and his dialog brief");
  const vias: Record<string, string> = { capture: "capture", inbox: "inbox", "job-check": "job-check", proactive: "robert", "follow-up": "follow-up" };
  for (const [by, via] of Object.entries(vias)) {
    const s = open(atlas, { created_by: by, goal: `from ${by}` });
    assert.equal(reqOf(s.id).via, via, by);
    assert.equal(reqOf(s.id).opened_by, by);
    assert.equal(only(requests.linksFor(reqOf(s.id).id)).role, "opened");
  }
});

test("a Lead's workers serve their Lead's request", () => {
  const atlas = mkWs("atlas");
  asked("t1", "migrá el esquema con un lead", atlas);
  step("t1", atlas);
  const lead = open(atlas, { created_by: "robert", role: "lead", goal: "Lead · migrate the schema" } as any);
  const w1 = open(atlas, { created_by: `lead:${lead.id.slice(0, 8)}`, lead_id: lead.id, goal: "slice 1" } as any);
  const w2 = open(atlas, { created_by: `lead:${lead.id.slice(0, 8)}`, lead_id: lead.id, goal: "slice 2" } as any);
  const r = reqOf(lead.id);
  assert.equal(reqOf(w1.id).id, r.id);
  assert.deepEqual(requests.linksFor(r.id).map((l) => l.role), ["opened", "worker", "worker"]);
  // One worker asks him something: the whole request needs him.
  status(w2.id, "decide", "which column type?");
  assert.equal(requests.get(r.id)!.state, "needs_operator");
});

test("a failover stand-in or a continuation takes the request over; the walled terminal stops counting", () => {
  const atlas = mkWs("atlas");
  const walled = open(atlas, { created_by: "operator", goal: "fix the export" });
  const r = reqOf(walled.id);
  const stand = open(atlas, { created_by: "failover", goal: "fix the export" });
  assert.equal(requests.linksOfSession(stand.id).length, 0, "a stand-in waits for its own event");
  ev({ topic: "session.failover", session_id: walled.id, step: "backend", to_session_id: stand.id, workspace_id: atlas.id });
  assert.equal(reqOf(stand.id).id, r.id);
  assert.equal(requests.linksFor(r.id).find((l) => l.session_id === walled.id)?.until !== null, true, "the walled one's window closed");
  status(walled.id, "blocked", "hit its usage limit");
  status(stand.id, "working", "1/3");
  assert.equal(requests.get(r.id)!.state, "working", "the walled terminal no longer speaks for the request");
  // A continuation that opened a fresh terminal for a parked one.
  const parked = open(atlas, { created_by: "operator", goal: "wait for the review" });
  const parkedReq = reqOf(parked.id);
  const c = continuations.create({ workspace_id: atlas.id, session_id: parked.id, kind: "pr", label: "PR approved" } as any);
  const fresh = open(atlas, { created_by: "continuation", goal: "Continue: wait for the review" });
  ev({ topic: "continuation.fired", continuation_id: c.id, workspace_id: atlas.id, session_id: fresh.id, how: "opened" });
  assert.equal(reqOf(fresh.id).id, parkedReq.id);
  assert.equal(only(requests.linksOfSession(fresh.id)).role, "standin");
  assert.equal(requests.primaryAt(parked.id), undefined, "the parked terminal no longer serves it");
});

test("Robert typing his words: mid-work it rides along as a steer; after a hand-off it takes the terminal over", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "operator", goal: "fix the login redirect" });
  const r1 = reqOf(s.id);
  // Mid-work: an adjustment. R1 keeps the terminal and its hand-offs.
  asked("t2", "decile que use la librería nueva", atlas);
  step("t2", atlas);
  ev({ topic: "session.input", session_id: s.id, by: "robert", text: "use the new library", workspace_id: atlas.id });
  const r2 = requests.byTurn("t2", atlas.id)!;
  assert.deepEqual(requests.linksFor(r2.id).map((l) => [l.role, l.primary]), [["steer", false]]);
  assert.equal(reqOf(s.id).id, r1.id);
  // The same line typed twice in the turn is one link.
  ev({ topic: "session.input", session_id: s.id, by: "robert", text: "again", workspace_id: atlas.id });
  assert.equal(requests.linksFor(r2.id).length, 1);
  handOff(s.id, out({ prs: [PR], ask: "merge" }));
  status(s.id, "your_turn", "finished its turn");
  assert.equal(requests.get(r1.id)!.state, "needs_operator", "R1 owns the hand-off and its merge");
  assert.equal(requests.get(r2.id)!.state, "closed", "the steer is carried into R1");
  // After that hand-off: new work. R3 takes the terminal; R1 keeps what it got.
  asked("t3", "ahora escribí los docs del cambio", atlas);
  step("t3", atlas);
  ev({ topic: "session.input", session_id: s.id, by: "robert", text: "now write the docs", workspace_id: atlas.id });
  const r3 = requests.byTurn("t3", atlas.id)!;
  assert.equal(reqOf(s.id).id, r3.id);
  handOff(s.id, out({ prs: ["https://github.com/atlas/api/pull/13"], ask: "merge" }));
  assert.ok(requests.deliverables(r3.id).some((d) => d.ref.endsWith("/13")), "the docs PR is R3's");
  assert.ok(!requests.deliverables(r1.id).some((d) => d.ref.endsWith("/13")), "…not R1's");
  // A wake turn typing (Robert answering a prompt) is not the operator's request.
  step("wake-9", atlas);
  ev({ topic: "session.input", session_id: s.id, by: "robert", text: "y", workspace_id: atlas.id });
  assert.equal(requests.byTurn("wake-9", atlas.id), undefined);
});

test("a message to the whole shop: one row for what he said, one per project it reached", () => {
  const atlas = mkWs("atlas");
  const cedar = mkWs("cedar");
  asked("t1", "en cada proyecto, abrí una terminal para revisar los PRs abiertos", null);
  step("t1", atlas);
  const a = open(atlas, { created_by: "robert", goal: "review open PRs" });
  step("t1", cedar);
  const c = open(cedar, { created_by: "robert", goal: "review open PRs" });
  const parent = requests.byTurn("t1", null)!;
  assert.equal(parent.workspace_id, null);
  assert.equal(reqOf(a.id).parent_id, parent.id);
  assert.equal(reqOf(c.id).parent_id, parent.id);
  assert.equal(reqOf(a.id).workspace_id, atlas.id);
  assert.equal(requests.linksFor(parent.id).length, 0, "the parent links no terminal of any workspace");
  status(c.id, "decide", "merge both?");
  assert.equal(requests.get(parent.id)!.state, "needs_operator", "as urgent as its most urgent project");
});

// ── state follows events ────────────────────────────────────────────────────────────────────────

test("a request's life: working → asks → working → hands off a merge → he says yes → carried out → closed", () => {
  const atlas = mkWs("atlas");
  asked("t1", "arreglá el login", atlas);
  step("t1", atlas);
  const s = open(atlas, { created_by: "robert" });
  const r = reqOf(s.id);
  status(s.id, "working", "2/5 · reproducing");
  assert.equal(requests.get(r.id)!.state, "working");
  status(s.id, "decide", "which branch? (main / release)");
  assert.deepEqual([requests.get(r.id)!.state, requests.get(r.id)!.state_line], ["needs_operator", "which branch? (main / release)"]);
  status(s.id, "working", "4/5 · tests");
  assert.equal(requests.get(r.id)!.state, "working");
  handOff(s.id, out({ prs: [PR], ask: "merge", summary: "the redirect loop is gone" }));
  status(s.id, "your_turn", "finished its turn");
  const row = requests.get(r.id)!;
  assert.equal(row.state, "needs_operator");
  assert.match(row.state_line!, /^merge: PR #12 \(atlas\/api\)/);
  assert.ok(row.result_at, "the result is in");
  const item = only(requests.items(r.id));
  assert.equal(item.action, "merge");
  assert.equal(item.target_hash, null, "not bound until the verifier stamps the PR head");
  // The verifier (a later piece) binds the head it verified.
  const d = only(requests.deliverables(r.id).filter((x) => x.kind === "pr"));
  requests.bindTarget(d.id, "f".repeat(40));
  const yes = L.recordDecision({ request: r.id, decision: "yes", words: "dale, mergealo", target_hash: "f".repeat(40), by: "voice" });
  assert.equal(yes.ok, true);
  assert.equal(requests.get(r.id)!.state, "done", "nothing owed; the merge waits for the executor");
  assert.equal(requests.deliverable(d.id)!.state, "open", "recording a yes merged nothing");
  // The executor merged it (here: GitHub says so through session_prs) and the terminal is closed.
  sessionPrs.record({ url: PR, session_id: s.id, workspace_id: atlas.id, cwd: "/tmp" });
  sessionPrs.update(PR, { state: "merged" });
  L.sweepLedger();
  assert.equal(requests.deliverable(d.id)!.state, "merged");
  assert.equal(requests.get(r.id)!.state, "done", "its terminal is still open");
  sessions.end(s.id);
  ev({ topic: "session.ended", session_id: s.id });
  assert.equal(requests.get(r.id)!.state, "closed");
});

test("out of order: a hand-off filed before the open is processed still lands; a status before the open is harmless", () => {
  const atlas = mkWs("atlas");
  const s = sessions.create({ workspace_id: atlas.id, cwd: "/tmp", goal: "fix it", goal_kind: "pr", created_by: "operator" } as any);
  ev({ topic: "session.status", session_id: s.id, status: { phase: "working", line: null } });
  ev({ topic: "session.updated", session_id: s.id });
  assert.equal(requests.list({ states: undefined }).length, 0, "nothing knows it yet: no row invented");
  sessions.setOutcome(s.id, out({ prs: [PR], ask: "merge" }));
  ev({ topic: "session.started", session_id: s.id });
  const r = reqOf(s.id);
  assert.equal(only(requests.items(r.id)).action, "merge");
  assert.equal(requests.get(r.id)!.state, "needs_operator");
});

test("repeated events write nothing new and land on the same state", () => {
  const atlas = mkWs("atlas");
  asked("t1", "arreglá el login", atlas);
  step("t1", atlas);
  const s = open(atlas, { created_by: "robert" });
  const o = out({ prs: [PR], ask: "merge+deploy" });
  handOff(s.id, o);
  const q = asks.create({ session_id: s.id, workspace_id: atlas.id, route: "operator", question: "deploy tonight or tomorrow?" });
  const count = () => ["requests", "request_terminals", "request_deliverables", "request_decisions"].map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  const replay = () => {
    ev({ topic: "session.started", session_id: s.id });
    ev({ topic: "session.updated", session_id: s.id });
    ev({ topic: "ask.created", ask_id: q.id, session_id: s.id, run_id: null, question: q.question });
    status(s.id, "your_turn");
    ev({ topic: "session.updated", session_id: s.id });
  };
  replay();
  const before = count();
  const state = requests.get(reqOf(s.id).id)!.state;
  for (let i = 0; i < 3; i++) replay();
  assert.deepEqual(count(), before);
  assert.equal(requests.get(reqOf(s.id).id)!.state, state);
  assert.deepEqual(requests.items(reqOf(s.id).id).map((i) => i.action).sort(), ["answer", "deploy", "merge"]);
});

test("a daemon restart: memory is gone, rows are not — the same state is re-derived", () => {
  const atlas = mkWs("atlas");
  const a = open(atlas, { created_by: "operator", goal: "one" });
  const b = open(atlas, { created_by: "operator", goal: "two" });
  status(a.id, "stalled", "silent 30m");
  handOff(b.id, out({ ask: "review", summary: "here is the answer" }));
  status(b.id, "your_turn");
  const before = requests.list({ states: undefined }).map((r) => [r.id, r.state, r.state_line]);
  L.resetLedgerMemory(); // the process died: no turns, no cached statuses
  L.sweepLedger();
  assert.deepEqual(requests.list({ states: undefined }).map((r) => [r.id, r.state, r.state_line]), before);
});

test("a corrected hand-off retires what the replaced one asked; a shipped one asks nothing", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "operator" });
  const r = reqOf(s.id);
  handOff(s.id, out({ prs: [PR], ask: "merge", summary: "first try" }));
  const first = only(requests.items(r.id));
  handOff(s.id, out({ prs: [PR], ask: "merge", summary: "corrected" }), "replace");
  const items = requests.items(r.id);
  assert.equal(items.length, 2);
  assert.equal(requests.item(first.id)!.status, "superseded", "the corrected hand-off is the question now");
  assert.equal(items.filter((i) => i.status === "open").length, 1, "one PR, one open merge");
  // It merged on its own (ship = merge) and said so: nothing left to ask.
  handOff(s.id, out({ prs: [PR], ask: "merge", shipped: ["merged #12"] }));
  assert.equal(requests.items(r.id).filter((i) => i.status === "open").length, 0);
  assert.equal(only(requests.deliverables(r.id).filter((d) => d.kind === "pr")).state, "merged");
});

test("his questions: an open ask is an answer item; answered, it carries his words; one Robert still triages is not his yet", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "operator" });
  const r = reqOf(s.id);
  const triaged = asks.create({ session_id: s.id, workspace_id: atlas.id, route: "robert", question: "rebase or merge main in?" });
  ev({ topic: "ask.created", ask_id: triaged.id, session_id: s.id, run_id: null, question: triaged.question, route: "robert" });
  assert.equal(requests.items(r.id).length, 0, "with Robert first: not the operator's yet");
  asks.escalate(triaged.id, "needs the operator: touches release");
  status(s.id, "decide", "rebase or merge main in?");
  const it = only(requests.items(r.id));
  assert.deepEqual([it.action, it.status, it.label], ["answer", "open", "rebase or merge main in?"]);
  assert.equal(requests.get(r.id)!.state, "needs_operator");
  // The ledger never answers it — the ask path does, and the ledger follows.
  const refused = L.recordDecision({ request: r.id, decision: "yes" });
  assert.equal(refused.ok, false);
  assert.match((refused as any).error, /answer it on its ask/);
  asks.answer(triaged.id, "rebase", "operator");
  ev({ topic: "ask.answered", ask_id: triaged.id, run_id: null, answer: "rebase", answered_by: "operator" });
  const done = requests.item(it.id)!;
  assert.deepEqual([done.status, done.decision, done.words, done.decided_by], ["decided", "answered", "rebase", "operator"]);
});

test("a question he put off (a held ask) is held in the ledger too, and comes back with it", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "operator" });
  const r = reqOf(s.id);
  const q = asks.create({ session_id: s.id, workspace_id: atlas.id, route: "operator", question: "ship it friday?" });
  const now = Date.now();
  asks.hold(q.id, new Date(now + 3_600_000).toISOString(), "after the standup");
  ev({ topic: "ask.created", ask_id: q.id, session_id: s.id, run_id: null, question: q.question }, now);
  const it = only(requests.items(r.id));
  assert.equal(it.status, "held");
  status(s.id, "your_turn");
  assert.equal(requests.get(r.id)!.state, "done", "nothing owed while it is held");
  L.sweepLedger(now + 30 * 60_000);
  assert.equal(requests.item(it.id)!.status, "held", "not before its time");
  L.sweepLedger(now + 61 * 60_000);
  assert.equal(requests.item(it.id)!.status, "open");
  assert.equal(requests.get(r.id)!.state, "needs_operator");
});

test("drafts: a send item bound to the words; the same draft again is one question, a rewrite re-asks", () => {
  const cedar = mkWs("cedar");
  const s = open(cedar, { created_by: "operator", goal: "answer the weekly numbers question", goal_kind: "investigation" });
  const r = reqOf(s.id);
  const h1 = draftHash({ channel: "slack", to: "#ops", text: "numbers are up 4%" });
  const label = "Slack draft → #ops: numbers are up 4%";
  L.noteDraft(s.id, { label, tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash: h1 } });
  L.noteDraft(s.id, { label, tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash: h1 } });
  const first = only(requests.items(r.id));
  assert.deepEqual([first.action, first.target_hash], ["send", h1]);
  const d = only(requests.deliverables(r.id).filter((x) => x.kind === "slack_draft"));
  assert.equal(d.ref, "slack:#ops");
  const h2 = draftHash({ channel: "slack", to: "#ops", text: "numbers are up 4.2%" });
  L.noteDraft(s.id, { label: "Slack draft → #ops: numbers are up 4.2%", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash: h2 } });
  assert.equal(requests.item(first.id)!.status, "superseded");
  assert.equal(only(requests.items(r.id).filter((i) => i.status === "open")).target_hash, h2);
  assert.equal(requests.deliverable(d.id)!.target_hash, h2);
  // A yes for the words he heard first no longer matches anything.
  const stale = L.recordDecision({ request: r.id, decision: "yes", target_hash: h1 });
  assert.equal(stale.ok, false);
  assert.equal((stale as any).status, 409);
  assert.equal(L.recordDecision({ request: r.id, decision: "yes", target_hash: h2, words: "mandalo" }).ok, true);
  // An email draft announced without a hash (an older `mc`): unbound — a yes is refused, later is fine.
  L.noteDraft(s.id, { label: "Email draft → someone@example.com · Weekly", tool: { name: "mcp__y__create_draft" } });
  const email = only(requests.items(r.id).filter((i) => i.status === "open"));
  assert.equal(email.target_hash, null);
  const unbound = L.recordDecision({ request: r.id, item: email.id, decision: "yes" });
  assert.equal(unbound.ok, false);
  assert.match((unbound as any).error, /not bound yet/);
  assert.equal(L.recordDecision({ request: r.id, item: email.id, decision: "later", until: "+2h" }).ok, true);
  assert.equal(requests.item(email.id)!.status, "held");
});

test("an analysis hands off an answer, and the dashboard and document it names, each by its link", () => {
  const cedar = mkWs("cedar");
  const s = open(cedar, { created_by: "operator", goal: "weekly signups", goal_kind: "investigation" });
  handOff(s.id, out({ ask: "review", summary: "Signups up 4% — https://bi.example.com/dashboard/7", changes: ["notes: https://docs.example.com/d/9"], proof: ["query: https://ci.example.com/run/1"] }));
  const kinds = requests.deliverables(reqOf(s.id).id).map((d) => [d.kind, d.ref]);
  assert.deepEqual(kinds.map((k) => k[0]).sort(), ["answer", "dashboard", "doc"]);
  assert.ok(!kinds.some((k) => String(k[1]).includes("ci.example.com")), "proof is evidence, not a deliverable");
  assert.equal(only(requests.items(reqOf(s.id).id)).action, "review", "he reads the answer");
});

test("decisions: a request owing two must be told which; change needs words; a dated later comes back", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "operator", goal_kind: "product" });
  const r = reqOf(s.id);
  handOff(s.id, out({ prs: [PR], ask: "merge+deploy" }));
  const pending = requests.items(r.id);
  assert.deepEqual(pending.map((i) => i.action).sort(), ["deploy", "merge"]);
  const which = L.recordDecision({ request: r.id, decision: "no" });
  assert.equal((which as any).status, 409);
  assert.equal((which as any).items.length, 2);
  const merge = pending.find((i) => i.action === "merge")!;
  assert.equal((L.recordDecision({ request: r.id, item: merge.id, decision: "change" }) as any).status, 400);
  assert.equal(L.recordDecision({ request: r.id, item: merge.id.slice(0, 8), decision: "change", words: "add a test for the callback" }).ok, true);
  const deploy = pending.find((i) => i.action === "deploy")!;
  const now = Date.now();
  assert.equal((L.recordDecision({ request: r.id, item: deploy.id, decision: "later", until: "2000-01-01T00:00:00Z" }, now) as any).status, 400);
  assert.equal(L.recordDecision({ request: r.id, item: deploy.id, decision: "later", until: "+1h" }, now).ok, true);
  // Nothing is owed now: the change went back to its terminal, which is working on it.
  assert.equal(requests.get(r.id)!.state, "working");
  status(s.id, "your_turn", "finished its turn");
  assert.match(requests.get(r.id)!.state_line!, /held for later/);
  // An hour later the sweep puts it back in front of him.
  L.sweepLedger(now + 61 * 60_000);
  assert.equal(requests.item(deploy.id)!.status, "open");
  assert.equal(requests.get(r.id)!.state, "needs_operator");
  // A target he names must match even on a decision that executes nothing.
  assert.equal((L.recordDecision({ request: r.id, item: deploy.id, decision: "no", target_hash: "deadbeef" }) as any).status, 409);
});

test("work type: follows the terminal unless the opener set it; an analysis in a VPN workspace needs the VPN first", () => {
  const cedar = mkWs("cedar", { vpn_config: { kind: "example" } });
  const s = open(cedar, { created_by: "operator", goal: "how many signups last week", goal_kind: "investigation" });
  const r = reqOf(s.id);
  assert.deepEqual(r.prereqs.map((p) => p.kind), ["vpn"]);
  sessions.setGoal(s.id, { goal_kind: "pr" });
  ev({ topic: "session.updated", session_id: s.id });
  assert.equal(requests.get(r.id)!.kind, "pr");
  assert.deepEqual(requests.get(r.id)!.prereqs, [], "a code change does not need the data network");
  const set = L.openRequest({ workspace_id: cedar.id, words: "send the numbers to the team", via: "voice", kind: "investigation", turn_id: "front-1" });
  assert.equal(set.kind_source, "set");
  step("front-1", cedar);
  const t = open(cedar, { created_by: "robert", goal: "draft the numbers message", goal_kind: "qa" });
  assert.equal(reqOf(t.id).id, set.id, "the front's request takes the terminal its turn opened");
  assert.equal(requests.get(set.id)!.kind, "investigation", "what the opener said wins");
});

// ── adoption and backfill ───────────────────────────────────────────────────────────────────────

test("backfill: every live terminal from before the ledger gets a request on day one; Leads first; a second run adds nothing", () => {
  const atlas = mkWs("atlas");
  const mk = (over: Record<string, unknown>) => sessions.create({ workspace_id: atlas.id, cwd: "/tmp", goal: "g", ...over } as any);
  // Created before the ledger existed and never seen by it (no session.started event).
  const worker = mk({ goal: "slice 1", created_by: "lead:x" });
  const lead = mk({ goal: "Lead · migrate", role: "lead", created_by: "robert" });
  db.prepare("UPDATE sessions SET lead_id = ? WHERE id = ?").run(lead.id, worker.id);
  const plain = mk({ goal: "fix the export", created_by: "operator" });
  const gone = mk({ goal: "old", created_by: "operator" });
  sessions.end(gone.id);
  handOff(plain.id, out({ ask: "review", summary: "found it" }));
  db.prepare("UPDATE sessions SET created_at = '2026-11-01T00:00:00.000Z'").run();
  kv.set("ledger.since", "2026-11-05T00:00:00.000Z");
  const first = L.backfillLive();
  assert.equal(first.backfilled.length, 2, "the Lead and the plain terminal; the worker inherits; the ended one is history");
  assert.equal(reqOf(worker.id).id, reqOf(lead.id).id);
  assert.equal(reqOf(plain.id).via, "backfill");
  assert.equal(only(requests.linksFor(reqOf(plain.id).id)).role, "backfill");
  assert.equal(requests.linksOfSession(gone.id).length, 0);
  assert.equal(reqOf(plain.id).state, "needs_operator", "its earlier hand-off is already in front of him");
  const again = L.backfillLive();
  assert.deepEqual([again.backfilled.length, again.adopted.length], [0, 0]);
});

test("backfill of a long-lived terminal: every hand-off is a result, only the newest is a question", () => {
  const atlas = mkWs("atlas");
  const s = sessions.create({ workspace_id: atlas.id, cwd: "/tmp", goal: "keep the API healthy", goal_kind: "pr", created_by: "operator" } as any);
  sessions.setOutcome(s.id, out({ ask: "merge", prs: ["https://github.com/atlas/api/pull/20"] }));
  handOff(s.id, out({ ask: "review", summary: "second" }));
  handOff(s.id, out({ ask: "merge", prs: ["https://github.com/atlas/api/pull/22"] }));
  db.prepare("UPDATE sessions SET created_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(s.id);
  kv.set("ledger.since", "2026-11-05T00:00:00.000Z");
  L.backfillLive();
  const r = reqOf(s.id);
  assert.equal(L.detailOf(r, { operator: true }).result.length, 3, "all three hand-offs are its result");
  assert.deepEqual(requests.deliverables(r.id).filter((d) => d.kind === "pr").map((d) => d.ref.split("/").pop()).sort(), ["20", "22"]);
  const open = requests.items(r.id).filter((i) => i.status === "open");
  assert.deepEqual(open.map((i) => i.label), ["PR #22 (atlas/api)"], "he is asked about the newest hand-off only");
});

test("adoption: a deferred opener's terminal gets its grace, then a request of its own", () => {
  const atlas = mkWs("atlas");
  const s = open(atlas, { created_by: "ship", goal: "merge the ready PRs" });
  assert.equal(requests.linksOfSession(s.id).length, 0);
  const t0 = Date.parse(s.created_at);
  L.adoptOrphans(t0 + 1_000);
  assert.equal(requests.linksOfSession(s.id).length, 0, "still inside the grace");
  L.adoptOrphans(t0 + L.ORPHAN_GRACE_MS + 1_000);
  assert.equal(reqOf(s.id).via, "ship");
  assert.equal(only(requests.linksOfSession(s.id)).role, "adopted");
});

// ── read views ──────────────────────────────────────────────────────────────────────────────────

test("queue view and compact text: what he owes, in order; one line per open request", () => {
  const atlas = mkWs("atlas");
  const a = open(atlas, { created_by: "operator", goal: "fix the login redirect" });
  handOff(a.id, out({ prs: [PR], ask: "merge" }));
  const b = open(atlas, { created_by: "operator", goal: "decide the column type" });
  const q = asks.create({ session_id: b.id, workspace_id: atlas.id, route: "operator", question: "int or bigint?" });
  ev({ topic: "ask.created", ask_id: q.id, session_id: b.id, run_id: null, question: q.question });
  const c = open(atlas, { created_by: "operator", goal: "update the runbook" });
  status(c.id, "working", "1/3 · reading");
  const view = L.queueView(undefined);
  assert.deepEqual(view.items.map((i) => i.action), ["answer", "merge"], "a blocked question first");
  assert.match(view.items[1].line, /^Merge PR #12 \(atlas\/api\) for “fix the login redirect” in atlas — not bound yet$/);
  assert.equal(L.queueView(mkWs("cedar").id).items.length, 0, "another workspace's queue is empty");
  const text = L.ledgerText(atlas.id);
  assert.match(text, /^LEDGER \(3 open · 2 need you\):/);
  assert.match(text, /- needs you · fix the login redirect — merge: PR #12/);
  assert.match(text, /- working · update the runbook — 1\/3 · reading/);
  assert.ok(!text.includes("atlas ·"), "a project's own view names no workspace");
  assert.match(L.ledgerText(undefined), /needs you · atlas · /, "the fleet view does");
});

// Last: once started, the ledger listens on the real bus for the rest of this process.
test("wired to the bus: startLedger follows what the daemon publishes", async () => {
  const { bus } = await import("./bus.js");
  L.startLedger();
  L.startLedger(); // twice is once
  const atlas = mkWs("atlas");
  bus.publish({ topic: "agent.asked", turn: "bus-1", you: "abrí una terminal para el export", ws: atlas.id, source: "phone", at: "2026-11-09T10:00:00.000Z", voice: true });
  bus.publish({ topic: "agent.step", turn: "bus-1", ws: atlas.id, step: {} });
  const s = sessions.create({ workspace_id: atlas.id, cwd: "/tmp", goal: "fix the export", goal_kind: "pr", created_by: "robert" } as any);
  bus.publish({ topic: "session.started", session_id: s.id });
  const r = reqOf(s.id);
  assert.deepEqual([r.via, r.surface, r.turn_id], ["voice", "phone", "bus-1"]);
  bus.publish({ topic: "session.status", session_id: s.id, status: { phase: "decide", line: "which table?" } });
  assert.equal(requests.get(r.id)!.state, "needs_operator");
});
