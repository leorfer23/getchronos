/**
 * Robert drives: which stopped terminals wake him, which never should, and the guards that keep a
 * woken Robert from answering over the operator's shoulder or looping on one terminal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, leadEvents, sessions, workspaces } from "./store.js";
import { setWakeAsker, setWakeNotifier, setWakePoster, dueRows, TERMINAL_DRIVE_KEY } from "./wake-queue.js";
import type { TermStatus } from "./term-status.js";
import {
  armedWakes,
  driveKey,
  driveKind,
  driveSay,
  fireIfStill,
  graceMs,
  isStopped,
  LEAD_GAP_MS,
  leadGraceMs,
  LEAD_RETRY_MAX,
  noteDriveInput,
  noteLeadTyped,
  noteWorkerEnded,
  onStatus,
  OPERATOR_OWNS_MS,
  resetRobertDriveState,
  setDriveInputProbe,
  setDriveProbe,
  setDriveSendProbe,
  setLeadDigestMs,
  setLeadGapMs,
  REPORT_SUPPRESS_MS,
  underCaps,
  waitForLeadEvents,
} from "./robert-drive.js";
import { fileReport } from "./lead-report.js";
import { CONFIG } from "./config.js";

setWakeAsker(async () => "noted");
setWakePoster(() => {});
setWakeNotifier(async () => {});

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const ctx = (over: Partial<Parameters<typeof driveKind>[1]> = {}) => ({
  hasWorkspace: true, hasGoal: true, openAsk: false, declared: null, promptTracked: false, ...over,
});
const st = (phase: TermStatus["phase"], over: Partial<TermStatus> = {}): TermStatus => ({
  phase, line: "tests green, PR #214 open", word: phase, needs_you: false, since: NOW - 5 * 60_000,
  on: null, eta_at: null, subagents: 0, progress: null, hooked: true, ...over,
});

let screens = new Map<string, TermStatus>();
setDriveProbe((id) => screens.get(id) ?? null);
let typedAt = new Map<string, number>();
let printedAt = new Map<string, number>();
setDriveInputProbe((id) => ({ lastIn: typedAt.get(id) ?? null, lastOut: printedAt.get(id) ?? null }));

function reset() {
  db.prepare("DELETE FROM robert_wakes").run();
  db.prepare("DELETE FROM lead_wakes").run();
  db.prepare("DELETE FROM lead_events").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM workspaces").run();
  resetRobertDriveState();
  setDriveSendProbe(() => null);
  // Every test but the pacing one drives many wakes at one Lead and asserts synchronously; the real
  // 600ms gap between keystrokes would make each of them a wall-clock wait.
  setLeadGapMs(0);
  // …and the digest's 5s/20s windows would make every one of them a five-second wait. 0/0 still goes
  // through the event loop, so a test that expects a digest awaits `settle()` rather than nothing.
  setLeadDigestMs(0, 0);
  screens = new Map();
  typedAt = new Map();
  printedAt = new Map();
}
/** Let the debounce timer (and the pacing FIFO behind it) run. */
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** `mc report` stamps the real clock; every fireIfStill here is given the fixture's NOW instead. */
const stampReport = (at: number) =>
  db.prepare("UPDATE lead_events SET created_at = ? WHERE kind = 'report'").run(new Date(at).toISOString());
let n = 0;
const term = (over: Record<string, unknown> = {}) => {
  const w = workspaces.create({ slug: "acme" + ++n, name: "Acme", config_dir: "/tmp/acme" + n }).id;
  return sessions.create({ workspace_id: w, goal: "open the rollback PR", cwd: "/tmp", ...over } as any);
};
const rows = () => db.prepare("SELECT * FROM robert_wakes ORDER BY generation").all() as any[];

test("driveKind: finished, review, decide, declared blocked and waiting-on-robert wake him", () => {
  assert.equal(driveKind(st("your_turn"), ctx()), "turn");
  assert.equal(driveKind(st("review"), ctx()), "review");
  assert.equal(driveKind(st("decide"), ctx()), "decide");
  assert.equal(driveKind(st("blocked"), ctx({ declared: "blocked" })), "blocked");
  assert.equal(driveKind(st("waiting", { on: "robert" }), ctx()), "robert");
});

test("driveKind: work in flight, scratch windows and things with another owner never do", () => {
  assert.equal(driveKind(st("working"), ctx()), null);
  assert.equal(driveKind(st("waiting", { on: "ci" }), ctx()), null);
  assert.equal(driveKind(st("waiting", { on: "subagents" }), ctx()), null);
  assert.equal(driveKind(st("stalled"), ctx()), null, "stalls belong to the recovery supervisor");
  assert.equal(driveKind(st("ended"), ctx()), null);
  assert.equal(driveKind(st("your_turn"), ctx({ hasGoal: false })), null, "no goal = operator's scratch terminal");
  assert.equal(driveKind(st("your_turn"), ctx({ hasWorkspace: false })), null);
  assert.equal(driveKind(st("waiting", { on: "robert" }), ctx({ openAsk: true })), null, "ask-robert already has it");
  assert.equal(driveKind(st("decide"), ctx({ openAsk: true })), null, "an escalated ask is the operator's card");
  assert.equal(driveKind(st("decide"), ctx({ promptTracked: true })), null, "terminal-prompts is on that menu");
  assert.equal(driveKind(st("blocked"), ctx({ declared: null })), null, "a daemon block has its own owner");
});

test("graceMs: a finished turn waits the full grace, declared stops less", () => {
  assert.equal(graceMs("turn"), CONFIG.robertDrive.graceSec * 1000);
  assert.ok(graceMs("robert") <= 20_000);
  assert.ok(graceMs("review") <= 45_000);
});

test("underCaps: rolling hour per terminal and daemon-wide", () => {
  const caps = { perSession: 2, global: 3 };
  assert.equal(underCaps([], [], NOW, caps), true);
  assert.equal(underCaps([NOW - 1000, NOW - 2000], [], NOW, caps), false);
  assert.equal(underCaps([NOW - 61 * 60_000, NOW - 62 * 60_000], [], NOW, caps), true, "older than an hour stops counting");
  assert.equal(underCaps([], [NOW, NOW, NOW], NOW, caps), false);
});

test("fireIfStill: a terminal still stopped after its grace queues ONE wake with the context Robert needs", () => {
  reset();
  const s = term();
  const status = st("your_turn");
  screens.set(s.id, status);
  const key = driveKey(s.id, "your_turn", status.since);
  const id = fireIfStill(s.id, key, NOW);
  assert.ok(id);
  const [row] = rows();
  assert.ok(row.key.startsWith(TERMINAL_DRIVE_KEY));
  assert.equal(row.subject, `session:${s.id}`);
  assert.equal(row.workspace_id, s.workspace_id);
  const payload = JSON.parse(row.payload);
  assert.equal(payload.kind, "turn");
  assert.match(payload.say, /FINISHED ITS TURN/);
  assert.match(payload.say, /open the rollback PR/);
  assert.match(payload.say, new RegExp(s.id));
  assert.match(payload.say, /DRIVING THE WALL/);
  // The same stop again (a second status event, a re-armed timer) is absorbed, not a second turn.
  fireIfStill(s.id, key, NOW + 1000);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].hits, 2);
  // A drive wake is not held behind the 15-minute per-subject debounce: one wake per stop is in the key.
  assert.equal(dueRows(rows(), NOW).length, 1);
});

test("fireIfStill: moved on during the grace, operator at the keyboard, or ended → nothing", () => {
  reset();
  const s = term();
  const status = st("your_turn");
  const key = driveKey(s.id, "your_turn", status.since);
  screens.set(s.id, st("working"));
  assert.equal(fireIfStill(s.id, key, NOW), null, "it picked up again");
  screens.set(s.id, st("your_turn", { since: NOW }));
  assert.equal(fireIfStill(s.id, key, NOW), null, "a different stop than the one armed");
  screens.set(s.id, status);
  noteDriveInput(s.id, "operator", NOW - 30_000);
  assert.equal(fireIfStill(s.id, key, NOW), null, "the operator is typing into it");
  assert.ok(fireIfStill(s.id, key, NOW + OPERATOR_OWNS_MS), "his window closed");
  reset();
  const gone = term();
  db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(gone.id);
  screens.set(gone.id, st("your_turn"));
  assert.equal(fireIfStill(gone.id, driveKey(gone.id, "your_turn", st("your_turn").since), NOW), null);
  assert.equal(rows().length, 0);
});

test("fireIfStill: Robert's own keystrokes don't count as the operator, and the per-terminal cap stops a loop", () => {
  reset();
  const s = term();
  noteDriveInput(s.id, "robert", NOW);
  const cap = CONFIG.robertDrive.perSessionHour;
  let sent = 0;
  for (let i = 0; i < cap + 3; i++) {
    const status = st("your_turn", { since: NOW - 10 * 60_000 + i * 60_000 });
    screens.set(s.id, status);
    typedAt.set(s.id, Date.now() + 1000); // Robert answered the previous stop
    if (fireIfStill(s.id, driveKey(s.id, "your_turn", status.since), NOW + i * 1000)) sent++;
  }
  assert.equal(sent, cap);
});

test("driveSay: every kind names the terminal, the goal and the move", () => {
  const s = { id: "abcdef12-0000-0000-0000-000000000000", goal: "open the rollback PR", spawn_goal: null, workspace_id: "w" };
  for (const k of ["review", "turn", "decide", "blocked", "robert"] as const) {
    const say = driveSay(s, k, { line: "tests green" }, { result: "PR #214 open", said: null }, "Acme");
    assert.match(say, /`abcdef12` · Acme · open the rollback PR/);
    assert.match(say, /ITS LAST RESULT: PR #214 open/);
    assert.match(say, /mc session send abcdef12/);
  }
});

test("a restart re-deriving since does not re-wake him about the same untouched stop; a parked terminal is not news", () => {
  reset();
  const s = term();
  const first = st("your_turn");
  screens.set(s.id, first);
  assert.ok(fireIfStill(s.id, driveKey(s.id, "your_turn", first.since), NOW));
  // Daemon restarted: same idle terminal, new `since`, nobody typed.
  const again = st("your_turn", { since: NOW + 60_000 });
  screens.set(s.id, again);
  assert.equal(fireIfStill(s.id, driveKey(s.id, "your_turn", again.since), NOW + 120_000), null);
  // Somebody answered it and it stopped again → that IS a new stop.
  typedAt.set(s.id, Date.now() + 5_000);
  const next = st("your_turn", { since: NOW + 180_000 });
  screens.set(s.id, next);
  assert.ok(fireIfStill(s.id, driveKey(s.id, "your_turn", next.since), NOW + 200_000));

  reset();
  const old = term();
  const parked = st("your_turn", { since: NOW - 13 * 60 * 60_000 });
  screens.set(old.id, parked);
  assert.equal(fireIfStill(old.id, driveKey(old.id, "your_turn", parked.since), NOW), null);
});

test("Robert ticking a terminal done himself does not wake him about his own tick", () => {
  reset();
  const s = term();
  const turn = st("your_turn");
  screens.set(s.id, turn);
  assert.ok(fireIfStill(s.id, driveKey(s.id, "your_turn", turn.since), NOW));
  // He ran `mc session done` — no keystroke, no output from the terminal — and the card went ✅.
  const review = st("review", { since: NOW + 60_000 });
  screens.set(s.id, review);
  assert.equal(fireIfStill(s.id, driveKey(s.id, "review", review.since), NOW + 120_000), null);
  // The agent itself finishing after working (it printed) is real news.
  printedAt.set(s.id, Date.now() + 5_000);
  const real = st("review", { since: NOW + 180_000 });
  screens.set(s.id, real);
  assert.ok(fireIfStill(s.id, driveKey(s.id, "review", real.since), NOW + 200_000));
});

// ─────────────────────────────── leads (LEADS.md) ───────────────────────────────

test("isStopped: a `waiting` worker only counts as stopped when it is waiting on a PERSON", () => {
  // The whole WAIT_ON table (term-status.ts / `mc state --on`). These four come back by themselves,
  // so a Lead idle while one of them runs is waiting on real work, not stuck.
  for (const on of ["subagents", "ci", "command", "deploy"] as const)
    assert.equal(isStopped(st("waiting", { on })), false, `waiting on ${on} is work in flight`);
  // These need a hand, so the Lead idling behind them IS the thing that has to move.
  for (const on of ["robert", "person", "terminal", "other"] as const)
    assert.equal(isStopped(st("waiting", { on })), true, `waiting on ${on} needs somebody`);
  assert.equal(isStopped(st("waiting", { on: null })), true, "waiting on nothing in particular is a stop");
  // …and the rest of the phases.
  for (const p of ["your_turn", "review", "decide", "blocked", "ended"] as const)
    assert.equal(isStopped(st(p)), true, p);
  assert.equal(isStopped(st("working")), false);
  assert.equal(isStopped(st("stalled")), false, "a stall has its own owner (the recovery supervisor)");
  assert.equal(isStopped(null), false, "no status at all is not evidence that anything has frozen");
});

test("a Lead whose only worker is waiting on CI is not woken; the same worker waiting on a person wakes it", () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const idle = st("your_turn");
  screens.set(lead.id, idle);
  const key = driveKey(lead.id, "your_turn", idle.since);

  screens.set(worker.id, st("waiting", { on: "ci" }));
  assert.equal(fireIfStill(lead.id, key, NOW), null, "CI comes back by itself — nothing for Robert to do");
  screens.set(worker.id, st("waiting", { on: "subagents" }));
  assert.equal(fireIfStill(lead.id, key, NOW), null, "nor do its own subagents need anybody");

  screens.set(worker.id, st("waiting", { on: "person" }));
  assert.ok(fireIfStill(lead.id, key, NOW), "waiting on a person is a stop, and the group is frozen");
  assert.match(JSON.parse(rows()[0].payload).say, /THIS IS A LEAD; its 1 workers are all stopped/);
});

test("driveKind: a Lead idle while its workers work is not news; idle with all of them stopped is a turn stop", () => {
  assert.equal(driveKind(st("your_turn"), ctx({ isLead: true, leadHasWorkingWorkers: true })), null);
  assert.equal(driveKind(st("your_turn"), ctx({ isLead: true, leadHasWorkingWorkers: false })), "turn");
  // A Lead's decide/blocked/review/robert stops are never suppressed this way — only your_turn is.
  assert.equal(driveKind(st("review"), ctx({ isLead: true, leadHasWorkingWorkers: true })), "review");
});

/** A Lead + one worker it owns, in one workspace. Returns both rows and the keystroke log. */
function leadAndWorker(over: Record<string, unknown> = {}) {
  const ws = workspaces.create({ slug: "lead-ws" + ++n, name: "Acme", config_dir: "/tmp/lead-ws" + n }).id;
  const lead = sessions.create({ workspace_id: ws, role: "lead", goal: "ship the thing", cwd: "/tmp" });
  const worker = sessions.create({
    workspace_id: ws, role: "worker", goal: "open the rollback PR", cwd: "/tmp",
    created_by: `lead:${lead.id.slice(0, 8)}`, lead_id: lead.id, ...over,
  });
  const sent: Array<{ id: string; text: string; by: string }> = [];
  setDriveSendProbe((id, text, opts) => { sent.push({ id, text, by: opts.by }); return null; });
  return { ws, lead, worker, sent };
}

test("fireIfStill: a worker owned by a live Lead files into the Lead's inbox, not Robert's queue", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();

  const status = st("your_turn");
  screens.set(worker.id, status);
  const key = driveKey(worker.id, "your_turn", status.since);
  const wakeId = fireIfStill(worker.id, key, NOW);
  assert.ok(wakeId?.startsWith("lead:"), "synthetic id, not a robert_wakes row id");
  assert.equal(sent.length, 0, "nothing is TYPED at the moment of the stop — it is a row first");
  const [ev] = leadEvents.unseen(lead.id);
  assert.equal(ev.session_id, worker.id);
  assert.equal(ev.kind, "turn");
  assert.equal(ev.key, key);
  assert.equal(JSON.parse(ev.payload!).goal, "open the rollback PR");
  assert.equal(rows().length, 0, "never reached robert_wakes — this was never Robert's to answer");

  // Nobody is pulling, so it becomes one typed digest once the debounce is up.
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, lead.id, "typed into the LEAD's pty, not the worker's or Robert's queue");
  assert.equal(sent[0].by, "daemon");
  assert.match(sent[0].text, /^1 of your workers stopped: /);
  assert.match(sent[0].text, new RegExp(`${worker.id.slice(0, 8)} FINISHED — open the rollback PR`));
  assert.match(sent[0].text, /mc lead inbox/);
  assert.match(sent[0].text, /mc lead wait/);

  // The same stop firing again (a re-armed timer) is absorbed, not a second event or a second digest.
  fireIfStill(worker.id, key, NOW + 1000);
  await settle();
  assert.equal(sent.length, 1, "the same key twice sends once");
});

test("a Lead blocked in `mc lead wait` is handed the stop and nothing is typed at it at all", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const waiter = waitForLeadEvents(lead.id, 5_000);

  const status = st("your_turn");
  screens.set(worker.id, status);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW);

  const events = await waiter.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].session_id, worker.id);
  assert.ok(events[0].seen_at, "what the waiter took is seen");
  await settle();
  assert.equal(sent.length, 0, "a Lead that is PULLING is never also typed at");
  assert.equal(rows().length, 0);
  // …and `lead_wakes` still remembers it, so a restart does not hand it over a second time.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM lead_wakes").get().c, 1);
});

test("an already-unseen event resolves `wait` immediately, and a second waiter replaces the first", async () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const status = st("your_turn");
  screens.set(worker.id, status);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW);

  assert.equal((await waitForLeadEvents(lead.id, 5_000).events).length, 1, "already waiting for it");
  const first = waitForLeadEvents(lead.id, 5_000);
  const second = waitForLeadEvents(lead.id, 5_000);
  assert.deepEqual(await first.events, [], "the replaced waiter resolves empty, it does not hang");
  second.cancel();
  assert.deepEqual(await second.events, []);
});

test("five workers stopping together are ONE typed digest naming all five", async () => {
  reset();
  const { lead, sent } = leadAndWorker();
  const workers = Array.from({ length: 5 }, (_, i) =>
    sessions.create({
      workspace_id: lead.workspace_id!, role: "worker", goal: `task ${i}`, cwd: "/tmp", lead_id: lead.id,
    }),
  );
  for (const w of workers) {
    const status = st("your_turn");
    screens.set(w.id, status);
    fireIfStill(w.id, driveKey(w.id, "your_turn", status.since), NOW);
  }
  await settle();
  assert.equal(sent.length, 1, "one keystroke burst, not five prompts and five Lead turns");
  assert.match(sent[0].text, /^5 of your workers stopped: /);
  for (const w of workers) assert.match(sent[0].text, new RegExp(w.id.slice(0, 8)));
  assert.equal(leadEvents.unseen(lead.id).length, 0, "all five delivered");
  assert.equal(rows().length, 0);
});

test("a digest costs the Lead ONE against its hour and each worker one against its own", async () => {
  reset();
  const perLead = CONFIG.leadDrive.perLeadHour;
  const perWorker = CONFIG.leadDrive.perWorkerHour;
  CONFIG.leadDrive.perLeadHour = 1;
  CONFIG.leadDrive.perWorkerHour = 1;
  try {
    const { lead, sent } = leadAndWorker();
    const [a, b] = [0, 1].map((i) =>
      sessions.create({
        workspace_id: lead.workspace_id!, role: "worker", goal: `task ${i}`, cwd: "/tmp", lead_id: lead.id,
      }),
    );
    for (const w of [a, b]) {
      const status = st("your_turn");
      screens.set(w.id, status);
      fireIfStill(w.id, driveKey(w.id, "your_turn", status.since), NOW);
    }
    await settle();
    assert.equal(sent.length, 1, "two stops, one digest — so the Lead's hour of 1 covers both");
    assert.equal(rows().length, 0);

    // The Lead's hour is now spent, so the next stop of a THIRD worker is Robert's.
    const c = sessions.create({
      workspace_id: lead.workspace_id!, role: "worker", goal: "task 2", cwd: "/tmp", lead_id: lead.id,
    });
    const third = st("your_turn");
    screens.set(c.id, third);
    const id = fireIfStill(c.id, driveKey(c.id, "your_turn", third.since), NOW);
    assert.ok(id && !id.startsWith("lead:"), "escalated, not queued for a Lead over its hour");
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(rows().length, 1);
  } finally {
    CONFIG.leadDrive.perLeadHour = perLead;
    CONFIG.leadDrive.perWorkerHour = perWorker;
  }
});

test("`ended` wakes a waiter, but never types a digest and never reaches Robert", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const waiter = waitForLeadEvents(lead.id, 5_000);
  sessions.end(worker.id);
  noteWorkerEnded(worker.id);
  const events = await waiter.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "ended");
  assert.equal(events[0].key, null);

  // With nobody pulling, a closed terminal is nobody's turn: no keystroke, no wake.
  reset();
  const solo = leadAndWorker();
  sessions.end(solo.worker.id);
  noteWorkerEnded(solo.worker.id);
  await settle();
  assert.equal(solo.sent.length, 0, "an `ended` on its own never interrupts a working Lead");
  assert.equal(rows().length, 0);
  assert.equal(leadEvents.unseen(solo.lead.id).length, 1, "…it waits for a digest that is sent anyway");
  void sent;
});

test("an `ended` rides along in a digest a real stop causes, and is never escalated", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const other = sessions.create({
    workspace_id: lead.workspace_id!, role: "worker", goal: "rerun the suite", cwd: "/tmp", lead_id: lead.id,
  });
  sessions.end(other.id);
  noteWorkerEnded(other.id);
  const status = st("review");
  screens.set(worker.id, status);
  fireIfStill(worker.id, driveKey(worker.id, "review", status.since), NOW);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^2 of your workers stopped: /);
  assert.match(sent[0].text, new RegExp(`${other.id.slice(0, 8)} ENDED`));
  assert.match(sent[0].text, new RegExp(`${worker.id.slice(0, 8)} REVIEW`));
});

test("the Lead typing into a worker acks that worker's events, so the digest never mentions it", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const status = st("your_turn");
  screens.set(worker.id, status);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW);

  // It looked at the wall itself and steered that worker before the debounce was up.
  noteLeadTyped(worker.id, `lead:${lead.id.slice(0, 8)}`);
  await settle();
  assert.equal(sent.length, 0, "nothing left to tell it about — it just did it");
  assert.equal(leadEvents.recent(lead.id).length, 0, "and nothing outstanding in the inbox");
  assert.equal(leadEvents.recent(lead.id, { all: true }).length, 1, "the history keeps it");

  // The operator's own hand at the Desk is not the Lead acting, and neither is the daemon's digest.
  reset();
  const again = leadAndWorker();
  const st2 = st("your_turn");
  screens.set(again.worker.id, st2);
  fireIfStill(again.worker.id, driveKey(again.worker.id, "your_turn", st2.since), NOW);
  noteLeadTyped(again.worker.id, "operator");
  noteLeadTyped(again.worker.id, "daemon");
  assert.equal(leadEvents.unseen(again.lead.id).length, 1);
});

test("fireIfStill: a worker with no lead_id — including one that SAYS it has a Lead — wakes Robert", () => {
  reset();
  // The old linkage, self-asserted: `mc` signs created_by from MC_AGENT_NAME, so anything able to open
  // a terminal could claim a Lead's workers. Without the x-mc-lead header there is no lead_id, and the
  // string buys nothing: this stop is Robert's like any other.
  const ws = workspaces.create({ slug: "spoof-ws" + ++n, name: "Acme", config_dir: "/tmp/spoof-ws" + n }).id;
  const lead = sessions.create({ workspace_id: ws, role: "lead", goal: "ship the thing", cwd: "/tmp" });
  const impostor = sessions.create({
    workspace_id: ws, role: "worker", goal: "open the rollback PR", cwd: "/tmp",
    created_by: `lead:${lead.id.slice(0, 8)}`,
  });
  const sent: string[] = [];
  setDriveSendProbe((id) => { sent.push(id); return null; });
  assert.equal(impostor.lead_id, null);

  const status = st("your_turn");
  screens.set(impostor.id, status);
  assert.ok(fireIfStill(impostor.id, driveKey(impostor.id, "your_turn", status.since), NOW));
  assert.equal(sent.length, 0, "nothing typed into the Lead it named");
  assert.equal(rows().length, 1, "fell back to Robert's queue");

  // …and so does a real worker whose Lead has since ended.
  reset();
  const orphan = leadAndWorker();
  sessions.end(orphan.lead.id);
  const st2 = st("your_turn");
  screens.set(orphan.worker.id, st2);
  assert.ok(fireIfStill(orphan.worker.id, driveKey(orphan.worker.id, "your_turn", st2.since), NOW));
  assert.equal(orphan.sent.length, 0);
  assert.equal(rows().length, 1);
});

test("an undeliverable digest retries, then EVERY pending stop reaches Robert exactly once", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const second = sessions.create({
    workspace_id: lead.workspace_id!, role: "worker", goal: "rerun the suite", cwd: "/tmp", lead_id: lead.id,
  });
  const ended = sessions.create({
    workspace_id: lead.workspace_id!, role: "worker", goal: "already closed", cwd: "/tmp", lead_id: lead.id,
  });
  let fail: string | null = "terminal is not live";
  setDriveSendProbe((id, text, opts) => { sent.push({ id, text, by: opts.by }); return fail; });

  const a = st("your_turn");
  const b = st("review", { since: NOW - 4 * 60_000 });
  screens.set(worker.id, a);
  screens.set(second.id, b);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", a.since), NOW);
  fireIfStill(second.id, driveKey(second.id, "review", b.since), NOW);
  sessions.end(ended.id);
  noteWorkerEnded(ended.id);
  await settle();
  assert.equal(sent.length, 1, "one digest attempted");
  assert.equal(rows().length, 0, "a failure is a retry, not an escalation");

  // The retry is armed 30s out; drive it by hand the way the timer would, up to one short of the cap.
  for (let i = 1; i < LEAD_RETRY_MAX - 1; i++) {
    fireIfStill(worker.id, driveKey(worker.id, "your_turn", a.since), NOW + i * 1000);
    await settle();
    assert.equal(sent.length, i + 1, `attempt ${i + 1} is still the Lead's`);
    assert.equal(rows().length, 0);
  }
  // Out of retries: the stops are not lost, they become Robert's with HIS wording, one row each.
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", a.since), NOW + 10_000);
  await settle();
  assert.equal(sent.length, LEAD_RETRY_MAX, "no sixth keystroke at a Lead that cannot be typed into");
  assert.equal(rows().length, 2, "both stops escalated — and the `ended` did not");
  assert.deepEqual(
    rows().map((r) => JSON.parse(r.payload).session_id).sort(),
    [worker.id, second.id].sort(),
  );
  assert.match(JSON.parse(rows()[0].payload).say, /DRIVING THE WALL/, "Robert's wording, not the Lead's");
  assert.equal(leadEvents.unseen(lead.id).length, 0, "all three marked delivered — nothing escalates twice");

  // Firing the same stop again after the escalation adds no second wake for it.
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", a.since), NOW + 11_000);
  await settle();
  assert.equal(rows().length, 2);
  fail = null;
});

test("fireIfStill: a Lead sitting on a question of its own is not typed into — same retry path", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  // The Lead is itself deciding: a digest typed now would answer ITS question with a list of workers.
  screens.set(lead.id, st("decide"));
  const status = st("your_turn");
  screens.set(worker.id, status);
  const key = driveKey(worker.id, "your_turn", status.since);
  fireIfStill(worker.id, key, NOW);
  await settle();
  assert.equal(sent.length, 0, "nothing typed at a deciding Lead");
  assert.equal(rows().length, 0, "not Robert's yet either — it is a retry, not an escalation");

  // Working and your_turn are both fine: Claude Code queues input mid-turn.
  screens.set(lead.id, st("working"));
  fireIfStill(worker.id, key, NOW + 1000);
  await settle();
  assert.equal(sent.length, 1);
});

test("fireIfStill: a worker over ITS own hour escalates to Robert, without touching Robert's budget", async () => {
  reset();
  const { worker, sent } = leadAndWorker();
  const cap = CONFIG.leadDrive.perWorkerHour;
  for (let i = 0; i < cap + 2; i++) {
    const status = st("your_turn", { since: NOW - 60 * 60_000 + i * 60_000 });
    screens.set(worker.id, status);
    typedAt.set(worker.id, Date.now() + 1000); // the Lead answered the previous stop
    fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW + i * 1000);
    await settle(); // each stop is its own digest — the Lead answered the one before it
  }
  assert.equal(sent.length, cap, "one bouncing worker takes exactly its own cap of the Lead's attention");
  assert.equal(rows().length, 2, "the two over the cap are escalated to Robert, not dropped");
  // Robert's own per-terminal budget is 4/h and was never spent by the cap-and-under stops: had the
  // Lead path been consuming it, these two could not have gone through.
  assert.ok(CONFIG.leadDrive.perWorkerHour > CONFIG.robertDrive.perSessionHour);
});

test("a restart does not re-tell a Lead about a stop it was already handed", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const first = st("your_turn");
  screens.set(worker.id, first);
  assert.ok(fireIfStill(worker.id, driveKey(worker.id, "your_turn", first.since), NOW));
  await settle();
  assert.equal(sent.length, 1);

  // Daemon restarted: the in-memory state is gone, `since` is re-derived, nobody typed into the worker.
  resetRobertDriveState();
  setLeadGapMs(0);
  setLeadDigestMs(0, 0);
  const again = st("your_turn", { since: NOW + 60_000 });
  screens.set(worker.id, again);
  assert.equal(fireIfStill(worker.id, driveKey(worker.id, "your_turn", again.since), NOW + 120_000), null);
  await settle();
  assert.equal(sent.length, 1, "lead_wakes remembered it across the restart");
  assert.equal(leadEvents.unseen(lead.id).length, 0, "and no second inbox row for the same stop");

  // Somebody answered it and it stopped again → a new stop, worth telling it about.
  typedAt.set(worker.id, Date.now() + 5_000);
  const next = st("your_turn", { since: NOW + 180_000 });
  screens.set(worker.id, next);
  assert.ok(fireIfStill(worker.id, driveKey(worker.id, "your_turn", next.since), NOW + 200_000));
  await settle();
  assert.equal(sent.length, 2);
});

test("a stop re-derived under a NEW key while still unseen is the same stop, named once in the digest", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const first = st("your_turn");
  screens.set(worker.id, first);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", first.since), NOW);
  // Restart before the debounce elapsed: same stop, new `since`, nothing typed into the worker.
  const again = st("your_turn", { since: NOW + 60_000 });
  screens.set(worker.id, again);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", again.since), NOW + 61_000);
  assert.equal(leadEvents.unseen(lead.id).length, 1, "one row, not two");
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^1 of your workers stopped: /);
});

test("two digests to one Lead are spaced, so the second is not swallowed by the first one's Enter", async () => {
  reset();
  setLeadGapMs(LEAD_GAP_MS); // the real thing, not the 0 the other tests run with
  const { lead, worker, sent } = leadAndWorker();
  const second = sessions.create({
    workspace_id: lead.workspace_id!, role: "worker", goal: "rerun the suite", cwd: "/tmp", lead_id: lead.id,
  });
  const a = st("your_turn");
  screens.set(worker.id, a);
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", a.since), NOW);
  await settle();
  assert.equal(sent.length, 1);

  // A second burst, right behind the first: sendInput writes Enter 200ms after the text, so this one
  // has to wait or its words land inside the previous line.
  const b = st("review", { since: NOW - 4 * 60_000 });
  screens.set(second.id, b);
  fireIfStill(second.id, driveKey(second.id, "review", b.since), NOW);
  await settle();
  assert.equal(sent.length, 1, "the second keystroke waits out the per-Lead gap");
  await new Promise((r) => setTimeout(r, LEAD_GAP_MS + 200));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, lead.id);
  assert.match(sent[1].text, new RegExp(second.id.slice(0, 8)));
});

test("a burst of digests each count against the Lead's hour, not just the last one", async () => {
  reset();
  setLeadGapMs(5); // every digest after the first is delivered from a queued callback
  const perLead = CONFIG.leadDrive.perLeadHour;
  CONFIG.leadDrive.perLeadHour = 2;
  try {
    const { lead, sent } = leadAndWorker();
    const workers = Array.from({ length: 3 }, (_, i) =>
      sessions.create({
        workspace_id: lead.workspace_id!, role: "worker", goal: `task ${i}`, cwd: "/tmp", lead_id: lead.id,
      }),
    );
    // One digest each, queued behind the same pacing gap — the callbacks used to hold one snapshot of
    // the Lead's window, so the last write won and N keystrokes counted as 1 (#394). Both windows are
    // re-read at write time now.
    for (const w of workers.slice(0, 2)) {
      const status = st("your_turn");
      screens.set(w.id, status);
      fireIfStill(w.id, driveKey(w.id, "your_turn", status.since), NOW);
      await settle();
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 2, "both landed in the Lead's pty");
    assert.equal(rows().length, 0, "and neither was Robert's");

    // The window now holds two, so the third worker's stop is over the Lead's hour and goes to Robert.
    const third = workers[2];
    const status = st("your_turn");
    screens.set(third.id, status);
    const id = fireIfStill(third.id, driveKey(third.id, "your_turn", status.since), NOW);
    assert.ok(id && !id.startsWith("lead:"), "escalated, not queued");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 2);
    assert.equal(rows().length, 1);
  } finally {
    CONFIG.leadDrive.perLeadHour = perLead;
  }
});

test("an idle Lead whose workers have ALL stopped is a turn stop; one still working keeps it quiet", () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const busy = sessions.create({
    workspace_id: lead.workspace_id!, role: "worker", goal: "run the migration", cwd: "/tmp", lead_id: lead.id,
  });
  const idle = st("your_turn");
  screens.set(lead.id, idle);
  screens.set(worker.id, st("your_turn"));
  screens.set(busy.id, st("working"));
  const key = driveKey(lead.id, "your_turn", idle.since);
  assert.equal(fireIfStill(lead.id, key, NOW), null, "one worker still working — the Lead is waiting on it");

  // That last worker finishes: now everything is waiting on the Lead and the Lead on nobody.
  screens.set(busy.id, st("review"));
  assert.ok(fireIfStill(lead.id, key, NOW));
  const say = JSON.parse(rows()[0].payload).say;
  assert.match(say, /THIS IS A LEAD; its 2 workers are all stopped and waiting on it/);

  // An ENDED worker is not a live one: a Lead whose workers are all closed is an ordinary idle terminal.
  reset();
  const solo = leadAndWorker();
  sessions.end(solo.worker.id);
  const st2 = st("your_turn");
  screens.set(solo.lead.id, st2);
  assert.ok(fireIfStill(solo.lead.id, driveKey(solo.lead.id, "your_turn", st2.since), NOW));
  assert.doesNotMatch(JSON.parse(rows()[0].payload).say, /THIS IS A LEAD/, "no live workers, nothing frozen behind it");
});

test("an idle Lead with unseen events is digested first; staying idle still reaches Robert", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  const idle = st("your_turn");
  screens.set(lead.id, idle);
  const status = st("your_turn");
  screens.set(worker.id, status);
  // A Lead sitting on a finished turn is not "busy" (leadBusy only refuses decide/blocked/prompts —
  // Claude Code queues input mid-turn), so the digest reaches IT before anything reaches Robert.
  fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW);
  await settle();
  assert.equal(sent.length, 1, "the Lead is told about its own worker first");
  assert.equal(rows().length, 0);

  // It stays idle anyway, with every live worker stopped: #394's rule is untouched — the whole group
  // is waiting on the Lead and the Lead on nobody, and that IS Robert's news after the usual grace.
  assert.ok(fireIfStill(lead.id, driveKey(lead.id, "your_turn", idle.since), NOW));
  assert.match(JSON.parse(rows()[0].payload).say, /THIS IS A LEAD; its 1 workers are all stopped/);
});

test("onStatus: a worker's status re-arms its Lead's own timer, so an all-stopped group is not silent", () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const idle = st("your_turn", { since: Date.now() - 60_000 });
  screens.set(lead.id, idle);
  screens.set(worker.id, st("working"));
  onStatus(worker.id, screens.get(worker.id)!);
  assert.equal(armedWakes().find((w) => w.session_id === lead.id), undefined, "the Lead is waiting on live work");

  // The worker stops. The LEAD emits no status of its own — nothing else would ever look at it again.
  screens.set(worker.id, st("your_turn"));
  onStatus(worker.id, screens.get(worker.id)!);
  const armed = armedWakes();
  assert.ok(armed.find((w) => w.session_id === worker.id), "the worker's own stop is armed");
  assert.ok(armed.find((w) => w.session_id === lead.id), "and so is its Lead's");
});

// ──────────── a Lead's worker reaches it sooner than Robert's 90s (CONFIG.leadDrive.graceSec) ────────────

test("leadGraceMs: a Lead's worker waits the Lead's grace; every other terminal waits Robert's", () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const leadGrace = CONFIG.leadDrive.graceSec * 1000;
  const plain = term();

  // Only ever LOWERS it — a kind Robert already hears about quickly keeps its own, shorter number.
  assert.equal(leadGraceMs("turn", worker), Math.min(graceMs("turn"), leadGrace));
  assert.ok(leadGraceMs("turn", worker) < graceMs("turn"), "90s of dead air per worker turn is the bug");
  assert.equal(leadGraceMs("robert", worker), Math.min(graceMs("robert"), leadGrace));

  assert.equal(leadGraceMs("turn", plain), graceMs("turn"), "a terminal with no Lead is Robert's, at Robert's pace");
  assert.equal(leadGraceMs("turn", undefined), graceMs("turn"));
  // The LEAD itself is not its own worker: its `lead_id` is null, so its stops keep Robert's grace.
  assert.equal(leadGraceMs("turn", lead), graceMs("turn"));
  // An orphan — its Lead has ended — goes back to Robert's pace too, because Robert is who gets it.
  sessions.end(lead.id);
  assert.equal(leadGraceMs("turn", sessions.get(worker.id)!), graceMs("turn"));
});

test("armTimer arms a Lead's worker at the Lead's grace, and a plain terminal at Robert's", () => {
  reset();
  const { lead, worker } = leadAndWorker();
  const since = Date.now();
  screens.set(worker.id, st("your_turn", { since }));
  onStatus(worker.id, screens.get(worker.id)!);
  const mine = armedWakes().find((w) => w.session_id === worker.id)!;
  assert.ok(mine, "armed");
  // fire_at is `since + grace`, give or take the milliseconds this test spends.
  assert.ok(Math.abs(mine.fire_at - (since + CONFIG.leadDrive.graceSec * 1000)) < 1500, `fired at ${mine.fire_at - since}ms`);

  const plain = term();
  screens.set(plain.id, st("your_turn", { since }));
  onStatus(plain.id, screens.get(plain.id)!);
  const theirs = armedWakes().find((w) => w.session_id === plain.id)!;
  assert.ok(Math.abs(theirs.fire_at - (since + graceMs("turn"))) < 1500, `fired at ${theirs.fire_at - since}ms`);
  assert.ok(mine.fire_at < theirs.fire_at);
});

// ──────────── a report and the stop behind it are ONE moment ────────────

test("fireIfStill: a worker's stop is dropped while its fresh report is still outstanding", async () => {
  reset();
  const { lead, worker, sent } = leadAndWorker();
  fileReport(worker.id, { state: "done", summary: "PR #214 is open and green" });
  stampReport(NOW - 1000); // filed a second ago, on the clock fireIfStill is given below
  await settle();
  assert.equal(leadEvents.recent(lead.id).length, 1, "the report");

  // The turn ends seconds later, as it always does after `mc report`.
  const status = st("your_turn");
  screens.set(worker.id, status);
  assert.equal(fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW), null);
  await settle();
  const evs = leadEvents.recent(lead.id);
  assert.equal(evs.length, 1, "still just the report — not the report AND a scraped stop");
  assert.equal(evs[0].kind, "report");
  assert.equal(rows().length, 0, "and it did not fall through to Robert either");

  // The Lead steers that worker: its report is answered, so the NEXT stop is news again.
  noteLeadTyped(worker.id, `lead:${lead.id.slice(0, 8)}`);
  const next = st("review", { since: NOW - 60_000 });
  screens.set(worker.id, next);
  assert.ok(fireIfStill(worker.id, driveKey(worker.id, "review", next.since), NOW));
  await settle();
  assert.deepEqual(leadEvents.recent(lead.id).map((e) => e.kind), ["review"]);
  assert.ok(sent.length >= 1, "and the Lead heard about it");
});

test("a report older than the suppression window no longer stands in for a stop", async () => {
  reset();
  const { lead, worker } = leadAndWorker();
  fileReport(worker.id, { state: "partial", summary: "three of five files" });
  stampReport(NOW - REPORT_SUPPRESS_MS - 60_000);

  const status = st("your_turn");
  screens.set(worker.id, status);
  assert.ok(fireIfStill(worker.id, driveKey(worker.id, "your_turn", status.since), NOW));
  await settle();
  assert.deepEqual(leadEvents.recent(lead.id).map((e) => e.kind).sort(), ["report", "turn"]);
});
