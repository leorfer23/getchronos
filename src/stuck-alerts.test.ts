/**
 * Stuck-work alerts: what counts as stuck, when the operator is told, on which channel, that he is
 * told once (across a restart too), that a storm becomes one summary, and that the self-check catches
 * what the event path missed. Every clock here is injected — nothing waits on the wall clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { bus } from "./bus.js";
import { asks, db, jobs, kv, runs, sessions, workspaces } from "./store.js";
import { alerts } from "./store/alerts.js";
import { _resetSettingsCache, writeSetting } from "./settings.js";
import { declare, type TermStatus } from "./term-status.js";
import { noteDriveInput, resetRobertDriveState } from "./robert-drive.js";
import { setFailoverOps } from "./terminal-failover.js";
import { reportAgentState } from "./agent-lifecycle.js";
import { notePresence, resetVoicePresence, voiceFor } from "./voice-presence.js";
import type { PushPayload } from "./push.js";
import { alertText, alertTitle, type TextInput } from "./alert-text.js";
import {
  _test, ackAlert, alertWindow, alertsOwnPush, alertsReadiness, alertsReport, checkAlertCoverage, classifyTerminal, closeHost,
  confirmSpoken, flushHostBatch, onTermStatus, raise, resetStuckAlerts, setAlertProbes, setAlertSenders,
  tickAlerts, willRetry, COVERAGE_SLACK_MS, FAILOVER_SAFETY_MS, HANDOFF_SETTLE_MS, OPERATOR_GRACE_MS, REOPEN_MS,
  SUMMARY_DEBOUNCE_MS, UNREACHABLE_AFTER_MS, VOICE_PLAY_MAX_MS, WAKE_SETTLE_MS, type TermFacts,
} from "./stuck-alerts.js";

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = Date.parse("2026-09-15T12:00:00.000Z");
/** robert-drive graceMs("decide"/"blocked") with the default 90s: min(90, 45). */
const ROBERT_GRACE = 45 * SEC;
const CHANCE = 120 * SEC;

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
const status = new Map<string, TermStatus>();
const walls = new Map<string, { kind: "credit" | "limit" | "login"; line: string }>();
const typed = new Map<string, number>();
const offline = new Map<string, number>();
const outs = new Map<string, number>();
setAlertProbes({
  status: (id) => status.get(id) ?? null,
  wall: (id) => walls.get(id) ?? null,
  lastOut: (id) => outs.get(id) ?? null,
  prompt: () => null,
  operatorLastIn: (id) => typed.get(id) ?? null,
  hostOfflineSince: (h) => offline.get(h) ?? null,
});
let pushes: PushPayload[] = [];
let telegrams: { html: string; markup: any }[] = [];
let subs = 1;
let pushOk = true;
let tgReady = true;
let tgOk = true;
let tgHealth = { configured: true, lastOkAt: NOW - 60_000 as number | null, lastErrorAt: null as number | null, lastError: null as string | null, failStreak: 0 };
let macs: { title: string; text: string }[] = [];
setAlertSenders({
  pushEnabled: () => true,
  subscriptions: () => subs,
  push: async (p) => { pushes.push(p); return { sent: pushOk ? 1 : 0, dropped: 0 }; },
  telegramReady: () => tgReady,
  telegram: async (html, markup) => { telegrams.push({ html, markup }); return tgOk ? { ok: true, detail: "message 1" } : { ok: false, detail: "no answer from Telegram" }; },
  telegramHealth: () => tgHealth,
  macReady: () => true,
  mac: async (title, text) => { macs.push({ title, text }); return { ok: true, detail: "said on this Mac's speakers (say) + a notification — not confirmed he heard it" }; },
});
let spoken: any[] = [];
bus.on("event", (e: any) => { if (e.topic === "alert.raised") spoken.push(e); });

function reset() {
  for (const t of ["alerts", "robert_wakes", "runs", "jobs", "sessions", "workspaces"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM kv WHERE key LIKE 'settings:%' OR key LIKE 'alerts.%'").run();
  _resetSettingsCache();
  resetStuckAlerts();
  resetVoicePresence();
  resetRobertDriveState();
  setFailoverOps({});
  status.clear(); walls.clear(); typed.clear(); offline.clear(); outs.clear();
  pushes = []; telegrams = []; spoken = []; macs = []; subs = 1; pushOk = true; tgReady = true; tgOk = true;
  tgHealth = { configured: true, lastOkAt: NOW - 60_000, lastErrorAt: null, lastError: null, failStreak: 0 };
}

let n = 0;
function term(over: Record<string, unknown> = {}) {
  const w = workspaces.create({ slug: "acme" + ++n, name: "Acme", config_dir: "/tmp/acme" + n }).id;
  return sessions.create({ workspace_id: w, goal: "fix the login redirect", cwd: "/tmp", ...over } as any);
}
const st = (phase: TermStatus["phase"], over: Partial<TermStatus> = {}): TermStatus => ({
  phase, line: "should it run the migration on staging? (yes / no)", word: phase, needs_you: phase === "decide" || phase === "blocked",
  since: NOW, on: null, eta_at: null, subagents: 0, progress: null, hooked: true, ...over,
});
/** Put a status on the terminal and let the alert layer see it, as the bus would. */
function show(id: string, s: TermStatus, at = s.since) {
  status.set(id, s);
  onTermStatus(id, s, at);
}
const rows = () => db.prepare("SELECT * FROM alerts ORDER BY created_at").all() as any[];
const open = (id: string) => alerts.openForSubject(`session:${id}`);
function wake(sessionId: string, createdAt: number, ackedAt: number | null = null) {
  db.prepare(
    "INSERT INTO robert_wakes (id,generation,topic,key,subject,payload,workspace_id,created_at,acked_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(`w${Math.random()}`, Date.now(), "session.decide", `term-drive:${sessionId}:decide:${createdAt}`, `session:${sessionId}`, "{}", null,
    new Date(createdAt).toISOString(), ackedAt ? new Date(ackedAt).toISOString() : null);
}
const facts = (over: Partial<TermFacts> = {}): TermFacts => ({
  phase: "decide", hasWorkspace: true, hasGoal: true, operatorAsk: false, declaredBlocked: false, ship: false,
  leadOwned: false, robertMayAct: true, wall: false, failoverActing: false, movedOn: false, ...over,
});

// ── what counts as stuck ──────────────────────────────────────────────────────────────────────
test("classifyTerminal: questions, blocks, stalls and walls are stuck; finished turns and waits are Robert's, not alerts", () => {
  assert.deepEqual(classifyTerminal(facts()), { kind: "decide", owner: "robert" });
  assert.deepEqual(classifyTerminal(facts({ operatorAsk: true })), { kind: "decide", owner: "operator" }, "an escalated question is already his");
  assert.deepEqual(classifyTerminal(facts({ ship: true })), { kind: "decide", owner: "operator" }, "a Ship terminal's question is his merge call");
  assert.deepEqual(classifyTerminal(facts({ robertMayAct: false })), { kind: "decide", owner: "operator" }, "Robert off / not watching");
  assert.deepEqual(classifyTerminal(facts({ leadOwned: true })), { kind: "decide", owner: "lead" });
  assert.deepEqual(classifyTerminal(facts({ phase: "blocked", declaredBlocked: true })), { kind: "blocked", owner: "robert" });
  assert.deepEqual(classifyTerminal(facts({ phase: "blocked" })), { kind: "blocked", owner: "operator" }, "a daemon block (auth, budget) is his");
  assert.deepEqual(classifyTerminal(facts({ phase: "stalled" })), { kind: "stalled", owner: "operator" });
  assert.deepEqual(classifyTerminal(facts({ phase: "your_turn", wall: true })), { kind: "wall", owner: "operator" });
  assert.deepEqual(classifyTerminal(facts({ phase: "your_turn", wall: true, failoverActing: true })), { kind: "wall", owner: "failover" });
  assert.equal(classifyTerminal(facts({ phase: "your_turn", wall: true, movedOn: true })), null, "failover already moved the work");
  for (const phase of ["your_turn", "review", "waiting", "working", "ended"] as const)
    assert.equal(classifyTerminal(facts({ phase })), null, phase);
  assert.equal(classifyTerminal(facts({ hasGoal: false })), null, "no goal = his own scratch window");
  assert.equal(classifyTerminal(facts({ hasWorkspace: false })), null);
});

test("alertWindow: his own at 10s; Robert's between his wake+15s and his grace+chance; a Lead after its grace+chance", () => {
  const w = { robertGraceMs: ROBERT_GRACE, leadGraceMs: 15 * SEC, chanceMs: CHANCE };
  assert.deepEqual(alertWindow({ kind: "decide", owner: "operator" }, w), { first: OPERATOR_GRACE_MS, last: OPERATOR_GRACE_MS });
  assert.deepEqual(alertWindow({ kind: "decide", owner: "robert" }, w), { first: ROBERT_GRACE + WAKE_SETTLE_MS, last: ROBERT_GRACE + CHANCE });
  assert.deepEqual(alertWindow({ kind: "decide", owner: "lead" }, w), { first: 15 * SEC + CHANCE, last: 15 * SEC + CHANCE });
  assert.deepEqual(alertWindow({ kind: "wall", owner: "failover" }, w), { first: FAILOVER_SAFETY_MS, last: FAILOVER_SAFETY_MS });
});

// ── episodes from status sequences ────────────────────────────────────────────────────────────
test("an escalated question is told 10s after it appears — once, with the terminal as the tap target", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS - 1);
  assert.equal(rows().length, 0, "not inside the grace");
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.equal(pushes.length, 1, "no voice call → straight to the phone");
  const p = pushes[0];
  assert.equal(p.kind, "alert");
  assert.equal(p.url, `/phone#s=${s.id}`);
  assert.equal(p.alert_id, rows()[0].id);
  assert.match(p.body, /^In Acme, the task “fix the login redirect” stopped with a question for you: should it run the migration on staging/);
  assert.equal(rows()[0].reason, "his_from_the_start");
  // The same episode keeps arriving on the bus: nothing new.
  show(s.id, st("decide", { asks: 1 }), NOW + 20 * SEC);
  await tickAlerts(NOW + 30 * SEC);
  assert.equal(rows().length, 1);
  assert.equal(pushes.length, 1);
});

test("Robert first: not woken → told at his grace + 15s; woken and still on it → told at grace + chance", async () => {
  reset();
  const a = term();
  show(a.id, st("decide"));
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS - 1);
  assert.equal(rows().length, 0);
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS);
  assert.equal(rows().length, 1, "no wake row for this stop: Robert is not coming");
  assert.equal(rows()[0].reason, "robert_not_woken");

  reset();
  const b = term();
  show(b.id, st("decide"));
  wake(b.id, NOW + ROBERT_GRACE); // robert-drive's timer fired: his turn is queued, not done
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS);
  await tickAlerts(NOW + ROBERT_GRACE + CHANCE - 1);
  assert.equal(rows().length, 0, "inside his chance");
  await tickAlerts(NOW + ROBERT_GRACE + CHANCE);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "robert_chance_over");
});

test("Robert looked and it is still stuck: told 15s after his turn ended, not at the end of his chance", async () => {
  reset();
  const s = term();
  show(s.id, st("decide"));
  const acked = NOW + ROBERT_GRACE + 30 * SEC;
  wake(s.id, NOW + ROBERT_GRACE, acked);
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS);
  await tickAlerts(acked + HANDOFF_SETTLE_MS - 1);
  assert.equal(rows().length, 0, "his answer may still be landing");
  await tickAlerts(acked + HANDOFF_SETTLE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "robert_looked_still_stuck");
});

test("a Lead's worker: the Lead gets its grace + the chance first, and the tap lands on the Lead (the phone does not list workers)", async () => {
  reset();
  const lead = term({ role: "lead", goal: "ship the billing rework" });
  const worker = sessions.create({ workspace_id: lead.workspace_id, goal: "migrate the invoices table", cwd: "/tmp", lead_id: lead.id } as any);
  show(worker.id, st("decide"));
  await tickAlerts(NOW + 15 * SEC + CHANCE - 1);
  assert.equal(rows().length, 0);
  await tickAlerts(NOW + 15 * SEC + CHANCE);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "lead_chance_over");
  assert.equal(pushes[0].url, `/phone#s=${lead.id}`);
});

test("Robert resolved it inside his chance: nothing is ever sent", async () => {
  reset();
  const s = term();
  show(s.id, st("decide"));
  wake(s.id, NOW + ROBERT_GRACE);
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS);
  show(s.id, st("working", { since: NOW + 80 * SEC }));
  await tickAlerts(NOW + 10 * MIN);
  assert.equal(rows().length, 0);
  assert.equal(pushes.length + telegrams.length + spoken.length, 0);
});

test("a flicker of the same question is the same episode: one alert, not two", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(pushes.length, 1);
  // A repaint: working for a second, then the very same question again.
  show(s.id, st("working", { since: NOW + 20 * SEC }));
  assert.ok(rows()[0].resolved_at, "the episode closed with it");
  show(s.id, st("decide", { asks: 1, since: NOW + 21 * SEC }));
  await tickAlerts(NOW + 21 * SEC + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1, "reopened, not a second row");
  assert.equal(rows()[0].resolved_at, null);
  assert.equal(pushes.length, 1, "and not a second buzz");
  // A DIFFERENT question later is new news.
  show(s.id, st("working", { since: NOW + 40 * SEC }));
  show(s.id, st("decide", { asks: 1, since: NOW + REOPEN_MS + 50 * SEC, line: "which branch should it push to?" }));
  await tickAlerts(NOW + REOPEN_MS + 50 * SEC + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 2);
});

test("a terminal he is typing into is his: no alert while he owns it, told once he walks away", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  noteDriveInput(s.id, "operator", NOW + 5 * SEC);
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 0);
  await tickAlerts(NOW + 3 * MIN);
  assert.equal(rows().length, 0, "still inside robert-drive's three minutes");
  await tickAlerts(NOW + 5 * SEC + 3 * MIN + 15 * SEC);
  assert.equal(rows().length, 1);
});

test("a declared block gives Robert his chance; a daemon block (logged out) is told at once, in plain words", async () => {
  reset();
  const a = term();
  declare(a.id, { state: "blocked", label: "the staging database refuses connections" }, NOW);
  show(a.id, st("blocked", { line: "the staging database refuses connections" }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 0, "declared: Robert's first");
  await tickAlerts(NOW + ROBERT_GRACE + WAKE_SETTLE_MS);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /is stuck: the staging database refuses connections\. It needs you to get it moving again\.$/);

  reset();
  const b = term();
  reportAgentState(b.id, { state: "blocked", blocked_reason: "auth", state_label: "needs a login" });
  show(b.id, st("blocked", { line: "needs a login" }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /needs a login before it can go on/);
});

// ── durable dedup ─────────────────────────────────────────────────────────────────────────────
test("a restart neither repeats an alert nor forgets one half-way up the ladder", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(pushes.length, 1);
  const id = rows()[0].id;
  resetStuckAlerts(); // the daemon restarts: every timer and candidate is gone, the row is not
  // After a restart term-status re-derives `since` to boot time and publishes every terminal again.
  const boot = NOW + 40 * SEC;
  show(s.id, st("decide", { asks: 1, since: boot }), boot);
  await tickAlerts(boot + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1, "same open episode: no second row");
  assert.equal(pushes.length, 1, "and no second push");
  // The ladder resumes from the row's own clock: no ack inside the window → Telegram.
  await tickAlerts(NOW + OPERATOR_GRACE_MS + 90 * SEC);
  assert.equal(telegrams.length, 1);
  assert.equal(alerts.get(id)!.state, "done");
});

// ── the ladder ────────────────────────────────────────────────────────────────────────────────
test("ladder: a live call speaks it in its language; no confirmation → phone; no ack → Telegram", async () => {
  reset();
  const s = term();
  notePresence({ client: "desk-1", surface: "desk", live: true, lang: "es" }, NOW);
  show(s.id, st("decide", { asks: 1 }));
  const t0 = NOW + OPERATOR_GRACE_MS;
  await tickAlerts(t0);
  assert.equal(spoken.length, 1, "spoken first");
  assert.equal(spoken[0].client, "desk-1", "to ONE call");
  assert.match(spoken[0].say, /^En Acme, la tarea “fix the login redirect” se frenó con una pregunta para vos/);
  assert.equal(pushes.length, 0, "the phone waits for the call");
  await tickAlerts(t0 + 15 * SEC - 1);
  assert.equal(pushes.length, 0);
  await tickAlerts(t0 + 15 * SEC);
  assert.equal(pushes.length, 1, "the call never confirmed → phone");
  const row = alerts.get(rows()[0].id)!;
  assert.equal(row.channels[0].ok, false);
  assert.match(String(row.channels[0].detail), /never confirmed/);
  assert.equal(row.delivered_via, "push");
  await tickAlerts(t0 + 15 * SEC + 90 * SEC);
  assert.equal(telegrams.length, 1, "not acknowledged in the window → Telegram");
  assert.match(telegrams[0].html, /^🔔 <b>Acme · espera tu respuesta<\/b>/, "alerts.lang auto follows the language of his last call");
  const kbRows = telegrams[0].markup.inline_keyboard;
  assert.equal(kbRows[kbRows.length - 1][0].callback_data, `al.ack.${row.id.slice(0, 8)}`);
  assert.equal(alerts.get(row.id)!.state, "done");
});

test("ladder: a call that confirms is the delivery; he replies on that call → acknowledged, nothing else is sent", async () => {
  reset();
  const s = term();
  notePresence({ client: "desk-1", live: true, lang: "en" }, NOW);
  show(s.id, st("decide", { asks: 1 }));
  const t0 = NOW + OPERATOR_GRACE_MS;
  await tickAlerts(t0);
  const id = rows()[0].id;
  confirmSpoken(id, "desk-1", t0 + 2 * SEC);
  let row = alerts.get(id)!;
  assert.equal(row.delivered_via, "voice");
  assert.equal(row.delivered_at, new Date(t0 + 2 * SEC).toISOString());
  _test.ackVoiceReply("desk-1", t0 + 20 * SEC);
  row = alerts.get(id)!;
  assert.equal(row.acked_via, "voice_reply");
  await tickAlerts(t0 + 10 * MIN);
  assert.equal(pushes.length + telegrams.length, 0);
});

test("ladder: no phone subscribed → Telegram right away; he answers the terminal → acknowledged", async () => {
  reset();
  subs = 0;
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(pushes.length, 0);
  assert.equal(telegrams.length, 1);
  const row = alerts.get(rows()[0].id)!;
  assert.deepEqual(row.channels.map((c) => [c.rung, c.ok]), [["voice", false], ["push", false], ["telegram", true]]);
  assert.match(String(row.channels[1].detail), /no phone subscribed/);
  typed.set(s.id, NOW + 30 * SEC); // his answer, as proactive-score.ts records it
  await tickAlerts(NOW + 31 * SEC);
  assert.equal(alerts.get(row.id)!.acked_via, "answered");
});

test("ladder: acknowledged on the phone, or the terminal moved on → it stops climbing", async () => {
  reset();
  const a = term();
  show(a.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  ackAlert(rows()[0].id, "push_open", NOW + 20 * SEC);
  await tickAlerts(NOW + 10 * MIN);
  assert.equal(telegrams.length, 0);

  reset();
  const b = term();
  show(b.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  show(b.id, st("working", { since: NOW + 30 * SEC }));
  await tickAlerts(NOW + 10 * MIN);
  assert.equal(telegrams.length, 0, "nothing left to tell him");
  assert.equal(alerts.get(rows()[0].id)!.state, "resolved");
});

test("keystrokes in his Desk pane (no bus event) acknowledge it too", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  typed.set(s.id, NOW + 40 * SEC);
  await tickAlerts(NOW + 45 * SEC);
  assert.equal(alerts.get(rows()[0].id)!.acked_via, "answered");
});

// ── the cap ───────────────────────────────────────────────────────────────────────────────────
test("over the hourly cap: everything else that hour is ONE summary, never dropped", async () => {
  reset();
  writeSetting("alerts.per_hour", 2);
  const ts = [term(), term(), term(), term()];
  for (const s of ts) show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(pushes.length, 2, "two told one by one");
  const capped = rows().filter((r) => r.state === "capped");
  assert.equal(capped.length, 2, "two written, folded");
  const sum = rows().find((r) => r.kind === "summary")!;
  assert.ok(sum);
  assert.ok(capped.every((r) => r.summary_id === sum.id));
  await tickAlerts(NOW + OPERATOR_GRACE_MS + SUMMARY_DEBOUNCE_MS - 1);
  assert.equal(pushes.length, 2, "the summary waits a minute for the rest of the burst");
  await tickAlerts(NOW + OPERATOR_GRACE_MS + SUMMARY_DEBOUNCE_MS);
  assert.equal(pushes.length, 3);
  assert.match(pushes[2].body, /^2 more things are stuck and waiting on you: Acme: fix the login redirect; Acme: fix the login redirect\./);
  // One more inside the same hour: a new summary, deferred to an hour after the first.
  const late = term();
  show(late.id, st("decide", { asks: 1, since: NOW + 5 * MIN }));
  await tickAlerts(NOW + 5 * MIN + OPERATOR_GRACE_MS);
  const second = rows().filter((r) => r.kind === "summary").find((r) => r.id !== sum.id)!;
  assert.equal(second.next_at, Date.parse(sum.created_at) + 60 * MIN);
  assert.equal(pushes.length, 3);
  // Acknowledging a summary covers everything it carried.
  ackAlert(sum.id, "push_open", NOW + 6 * MIN);
  assert.ok(capped.every((r) => alerts.get(r.id)!.acked_at));
});

test("a summary whose items all moved on before it went out says nothing", async () => {
  reset();
  writeSetting("alerts.per_hour", 1);
  const [a, b] = [term(), term()];
  show(a.id, st("decide", { asks: 1 }));
  show(b.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  show(b.id, st("working", { since: NOW + 20 * SEC }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS + SUMMARY_DEBOUNCE_MS);
  assert.equal(pushes.length, 1);
  assert.equal(rows().find((r) => r.kind === "summary")!.reason, "nothing_left_stuck");
});

// ── the self-check ────────────────────────────────────────────────────────────────────────────
test("self-check: a terminal stuck past its window with no row is raised (marked) and counted as a miss", async () => {
  reset();
  const s = term();
  status.set(s.id, st("decide", { asks: 1 })); // the status event never reached the alert layer
  const at = NOW + OPERATOR_GRACE_MS + COVERAGE_SLACK_MS + 1;
  const quiet = await checkAlertCoverage(NOW + OPERATOR_GRACE_MS + COVERAGE_SLACK_MS, { force: true });
  assert.equal(quiet.misses.length, 0, "not late yet");
  const cov = await checkAlertCoverage(at, { force: true });
  assert.equal(cov.ok, false);
  assert.deepEqual(cov.misses.map((m) => [m.subject, m.kind]), [[`session:${s.id}`, "decide"]]);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].selfcheck, 1);
  assert.equal(rows()[0].reason, "selfcheck:missed");
  assert.equal(pushes.length, 1, "and he is told");
  const again = await checkAlertCoverage(at + MIN, { force: true });
  assert.equal(again.misses.length, 0, "covered now");
  assert.equal(again.misses_total, 1, "the miss stays counted");
  assert.equal(JSON.parse(kv.get("alerts.coverage")!).misses_total, 1);
});

test("self-check: a ladder step overdue by minutes means the tick died — stepped, and counted", async () => {
  reset();
  const s = term();
  const row = alerts.insert({ subject: `session:${s.id}`, kind: "decide", title: "t", text: "x", lang: "en", state: "active", stuck_since: NOW, next_at: NOW, workspace_id: s.workspace_id, session_id: s.id, meta: {} }, NOW)!;
  status.set(s.id, st("decide", { asks: 1 }));
  const cov = await checkAlertCoverage(NOW + 3 * MIN, { force: true });
  assert.ok(cov.misses.some((m) => m.what === "ladder step overdue"));
  assert.equal(pushes.length, 1);
  assert.equal(alerts.get(row.id)!.delivered_via, "push");
});

test("self-check: a job's last attempt failing with no alert is a miss", async () => {
  reset();
  const ws = workspaces.create({ slug: "acme-jobs", name: "Acme", config_dir: "/tmp/acme-jobs" }).id;
  const job = jobs.create({ name: "nightly report", goal: "x", workspace_id: ws } as any);
  const run = runs.create(job.id, "cron");
  runs.patch(run.id, { status: "failed", ended_at: new Date(NOW - 10 * MIN).toISOString(), error: "exit 1: the export API answered 500" });
  const cov = await checkAlertCoverage(NOW, { force: true });
  assert.ok(cov.misses.some((m) => m.subject === `job:${job.id}`));
  assert.equal(rows()[0].kind, "job_failed");
});

// ── walls, computers, jobs, headless runs ─────────────────────────────────────────────────────
test("wall: failover giving up is told at once (its own Telegram notice counts); a move to a stand-in is not stuck", async () => {
  reset();
  const s = term();
  await _test.onFailover({ topic: "session.failover", session_id: s.id, workspace_id: s.workspace_id, step: "give_up", wall: "limit", detail: "You've hit your session limit · resets 3pm", from_backend: "claude-code", from_model: null, reason: "x" }, NOW);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /hit its usage limit and could not move to another account \(it resets 3pm\)\./);
  await tickAlerts(NOW + 2 * 90 * SEC);
  const row = alerts.get(rows()[0].id)!;
  assert.deepEqual(row.channels.map((c) => c.rung), ["voice", "push", "telegram"]);
  assert.match(String(row.channels[2].detail), /covered/);
  assert.equal(telegrams.length, 0, "failover's own Telegram notice already said it");

  reset();
  const m = term();
  walls.set(m.id, { kind: "credit", line: "You're out of usage credits" });
  await _test.onFailover({ topic: "session.failover", session_id: m.id, workspace_id: m.workspace_id, step: "backend", wall: "credit", detail: "x", from_backend: "claude-code", from_model: null, to_backend: "grok", to_session_id: "standin", reason: "x" }, NOW);
  show(m.id, st("your_turn"));
  await tickAlerts(NOW + 10 * MIN);
  assert.equal(rows().length, 0, "the walled terminal is left for him to close; the work moved on");
});

test("wall: with failover off for the workspace, a wall on screen is his at once; while failover still acts, it gets five minutes", async () => {
  reset();
  const a = term();
  writeSetting("failover.enabled", false, a.workspace_id);
  walls.set(a.id, { kind: "limit", line: "You've hit your limit · resets 7pm" });
  show(a.id, st("your_turn"));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].kind, "wall");

  reset();
  const b = term();
  walls.set(b.id, { kind: "limit", line: "You've hit your limit · resets 7pm" });
  setFailoverOps({ frame: () => ["⎿  You've hit your limit · resets 7pm", ">"] }); // failoverOwns() sees the same wall
  show(b.id, st("your_turn"));
  await tickAlerts(NOW + FAILOVER_SAFETY_MS - 1);
  assert.equal(rows().length, 0);
  await tickAlerts(NOW + FAILOVER_SAFETY_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "failover_not_acting");
});

test("host: one alert for every terminal one failover pass could not move; the host coming back ends it", async () => {
  reset();
  const a = term({ host_id: "m2" });
  const b = term({ host_id: "m2", goal: "rebuild the search index" });
  _test.onHostStuck("m2", a.id, NOW);
  _test.onHostStuck("m2", b.id, NOW);
  await flushHostBatch("m2", NOW + 5 * SEC);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].kind, "host");
  assert.match(rows()[0].text, /went offline and 2 pieces of work could not move to another computer: Acme: fix the login redirect; Acme: rebuild the search index\./);
  assert.equal(rows()[0].workspace_id, null, "two clients' work: no single workspace, so a locked Desk never gets it");
  closeHost("m2", NOW + MIN);
  assert.ok(rows()[0].resolved_at);
});

test("host: failover that neither moved nor failed — offline past grace + 5 min with live work is caught by the sweep", async () => {
  reset();
  const s = term({ host_id: "m5" });
  offline.set("m5", NOW - 40 * MIN);
  await _test.sweepHosts(NOW);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /has been offline for 40 minutes with work on it/);
  assert.equal(rows()[0].session_id, s.id);
  offline.delete("m5");
  await _test.sweepHosts(NOW + MIN);
  assert.ok(rows()[0].resolved_at, "back online → over");
});

test("jobs: only a final failure of a job he set up alerts; a retry still coming, a muted job or machinery do not; a success ends it", async () => {
  reset();
  const ws = workspaces.create({ slug: "acme-j", name: "Acme", config_dir: "/tmp/acme-j" }).id;
  const mk = (over: Record<string, unknown>, runOver: Record<string, unknown> = {}) => {
    const job = jobs.create({ name: "nightly report", goal: "x", workspace_id: ws, ...over } as any);
    const run = runs.create(job.id, "cron", (runOver.attempt as number) ?? 1);
    runs.patch(run.id, { status: "failed", ended_at: new Date(NOW).toISOString(), error: "exit 1: the export API answered 500", ...runOver } as any);
    return { job, run };
  };
  assert.equal(willRetry({ status: "failed", attempt: 1, error: "boom" }, { retry_max: 1 }), true);
  assert.equal(willRetry({ status: "failed", attempt: 2, error: "boom" }, { retry_max: 1 }), false);
  assert.equal(willRetry({ status: "failed", attempt: 1, error: "Not logged in · Please run /login" }, { retry_max: 3 }), false, "a logged-out profile is never retried");

  const retrying = mk({ retry_max: 2 });
  await _test.onRunEnded(retrying.run.id, NOW);
  const muted = mk({ notify: "off" });
  await _test.onRunEnded(muted.run.id, NOW);
  const machinery = mk({ name: "review:ACM-12" });
  await _test.onRunEnded(machinery.run.id, NOW);
  assert.equal(rows().length, 0);

  const final = mk({});
  await _test.onRunEnded(final.run.id, NOW);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /^In Acme, the scheduled job “nightly report” failed: exit 1: the export API answered 500\. Decide whether to run it again\.$/);
  const again = runs.create(final.job.id, "cron");
  runs.patch(again.id, { status: "failed", ended_at: new Date(NOW + HOUR_MS()).toISOString(), error: "same" });
  await _test.onRunEnded(again.id, NOW + HOUR_MS());
  assert.equal(rows().length, 1, "still the same failing episode");
  const ok = runs.create(final.job.id, "cron");
  runs.patch(ok.id, { status: "success" });
  await _test.onRunEnded(ok.id, NOW + 2 * HOUR_MS());
  assert.ok(rows()[0].resolved_at, "a success ends it");
});
function HOUR_MS() { return 60 * MIN; }

test("headless run with no sign of life: told on the stall verdict, over when it ends", async () => {
  reset();
  const ws = workspaces.create({ slug: "acme-r", name: "Acme", config_dir: "/tmp/acme-r" }).id;
  const job = jobs.create({ name: "weekly export", goal: "x", workspace_id: ws } as any);
  const run = runs.create(job.id, "cron");
  runs.patch(run.id, { status: "running", started_at: new Date(NOW - 30 * MIN).toISOString() });
  await _test.onRunState({ topic: "agent.state", kind: "run", id: run.id, name: null, state: "blocked", state_label: "quiet 16m, no liveness evidence", blocked_reason: "stall", workspace_id: ws }, NOW);
  assert.equal(rows().length, 1);
  assert.match(rows()[0].text, /the scheduled job “weekly export” has shown no sign of life for 16 minutes/);
  await _test.onRunState({ topic: "agent.state", kind: "run", id: run.id, name: null, state: "blocked", state_label: "quiet 21m", blocked_reason: "stall", workspace_id: ws }, NOW + 5 * MIN);
  assert.equal(rows().length, 1, "the sweep repeats the verdict: same episode");
  runs.patch(run.id, { status: "killed" });
  await _test.onRunEnded(run.id, NOW + 10 * MIN);
  assert.ok(rows()[0].resolved_at);
});

// ── switches ──────────────────────────────────────────────────────────────────────────────────
test("alerts off for a workspace: nothing is raised there, and the self-check does not call it a miss", async () => {
  reset();
  const s = term();
  writeSetting("alerts.enabled", false, s.workspace_id);
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + 10 * MIN);
  const cov = await checkAlertCoverage(NOW + 10 * MIN, { force: true });
  assert.equal(rows().length, 0);
  assert.equal(cov.misses.length, 0);
});

test("the alerts own the phone push for a question or block on fleet work (push.ts asks); finished turns stay push.ts's", () => {
  reset();
  const s = term();
  assert.equal(alertsOwnPush(s.id, "decide"), false, "not running → push.ts keeps everything");
  _test.setStarted(true);
  try {
    assert.equal(alertsOwnPush(s.id, "decide"), true);
    assert.equal(alertsOwnPush(s.id, "blocked"), true);
    assert.equal(alertsOwnPush(s.id, "your_turn"), false);
    const scratch = sessions.create({ workspace_id: s.workspace_id, cwd: "/tmp" } as any);
    assert.equal(alertsOwnPush(scratch.id, "decide"), false, "his own scratch window: push.ts as before");
    writeSetting("alerts.push", false);
    assert.equal(alertsOwnPush(s.id, "decide"), false, "the phone rung off → push.ts as before");
  } finally {
    _test.setStarted(false);
  }
});

// ── what he hears ─────────────────────────────────────────────────────────────────────────────
test("every alert: at most two sentences, no ids or links, none of the internal words — in both languages", () => {
  const inputs: TextInput[] = [
    { kind: "decide", ws: "Acme", work: "fix the login redirect (session 3f2a9c1e)", question: "Run the migration on staging? Or skip it. See https://example.com/x", options: ["yes", "no"] },
    { kind: "decide", ws: "Acme", work: "ship the export", question: "", options: [], permission: { tool: "Bash", input: "npm run deploy. then tag" } },
    { kind: "blocked", ws: "Acme", work: "rebuild the index", why: "waiting on credentials. The vault is locked!", reason: null },
    { kind: "blocked", ws: "Acme", work: "rebuild the index", why: null, reason: "auth" },
    { kind: "blocked", ws: "Acme", work: "rebuild the index", why: null, reason: "budget" },
    { kind: "stalled", ws: "Acme", work: "rebuild the index", minutes: 25 },
    { kind: "stalled", ws: "Acme", work: "weekly export", minutes: 16, job: true },
    { kind: "wall", ws: "Acme", work: "rebuild the index", wall: "credit", resets: "3pm" },
    { kind: "wall", ws: "Acme", work: "rebuild the index", wall: "limit", resets: null },
    { kind: "host", host: "m2", works: ["Acme: a", "Globex: b"], minutes: null, moved: true },
    { kind: "host", host: "m2", works: ["Acme: a"], minutes: 40, moved: false },
    { kind: "job_failed", ws: "Acme", job: "nightly report", why: "exit 1. stack trace follows", auth: false, backend: "claude-code" },
    { kind: "job_failed", ws: "Acme", job: "nightly report", why: null, auth: true, backend: "claude-code" },
    { kind: "job_failed", ws: "Acme", job: "nightly report", why: null, auth: false, timeout: true, backend: null },
    { kind: "summary", items: ["Acme: a", "Globex: b", "Acme: c", "Acme: d", "Acme: e"] },
  ];
  for (const lang of ["en", "es"] as const) {
    for (const inp of inputs) {
      const t = alertText(inp, lang);
      const sentences = t.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡0-9])/).filter(Boolean);
      assert.ok(sentences.length <= 2, `${lang} ${inp.kind}: ${sentences.length} sentences — ${t}`);
      assert.doesNotMatch(t, /https?:|\b[0-9a-f]{8}\b/i, `${lang} ${inp.kind}: id or link — ${t}`);
      assert.doesNotMatch(t, /\b(stall(ed)?|wake|woken|blocked|ask(s|ed)?)\b/i, `${lang} ${inp.kind}: internal word — ${t}`);
      assert.ok(alertTitle(inp, lang).length <= 60);
    }
  }
});

// ── workspaces never mix ──────────────────────────────────────────────────────────────────────
test("a Desk locked to one client is never handed another client's alert — not to speak, not on the bus", async () => {
  reset();
  const a = term();
  const b = term();
  notePresence({ client: "desk-locked", live: true, lang: "en", lock: a.workspace_id }, NOW);
  assert.equal(voiceFor(b.workspace_id, NOW), null, "locked to A: never picked for B");
  assert.equal(voiceFor(null, NOW), null, "nor for an alert that belongs to no single client");
  assert.equal(voiceFor(a.workspace_id, NOW)?.client, "desk-locked");

  show(b.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(spoken.length, 0, "B's alert skipped the call locked to A");
  assert.equal(pushes.length, 1, "and went to his phone instead");
  assert.match(String(alerts.get(rows()[0].id)!.channels[0].detail), /no live voice call/);

  // The bus lens a locked Desk runs every event through (static/desk-scope.js), on the real event shape.
  const store = new Map<string, string>([["desk-lock", JSON.stringify({ id: a.workspace_id, name: "Acme" })]]);
  const ctx: any = { window: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem() {}, removeItem() {} } } };
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-scope.js"), "utf8"), ctx);
  const lock = ctx.window.DeskScope.get();
  const ev = (ws: string | null) => ({ topic: "alert.raised", alert_id: "x", workspace_id: ws, session_id: null, kind: "decide", say: "…", lang: "en", client: null });
  assert.equal(ctx.window.DeskScope.passes(ev(a.workspace_id), lock), true);
  assert.equal(ctx.window.DeskScope.passes(ev(b.workspace_id), lock), false);
  assert.equal(ctx.window.DeskScope.passes(ev(null), lock), false, "fails closed on an alert with no single client");
});

test("GET /api/alerts report: what was said, how long until he was told, and the numbers", async () => {
  reset();
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  const r = alertsReport({ sinceMs: NOW - MIN }, NOW + MIN);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].told_ms, OPERATOR_GRACE_MS, "stuck → told");
  assert.equal(r.alerts[0].raise_ms, OPERATOR_GRACE_MS);
  assert.equal(r.stats.delivered, 1);
  assert.equal(r.stats.told_ms_p50, OPERATOR_GRACE_MS);
});

test("raise() is idempotent per open episode even when two paths race for it", async () => {
  reset();
  const s = term();
  const ep = {
    subject: `session:${s.id}`, kind: "decide" as const, workspace_id: s.workspace_id, session_id: s.id, since: NOW, reason: "x",
    input: { kind: "decide", ws: "Acme", work: "w", question: "q?", options: [] } as TextInput,
  };
  const [x, y] = await Promise.all([raise(ep, NOW), raise(ep, NOW)]);
  assert.ok(!!x !== !!y, "exactly one of them raised it");
  assert.equal(rows().length, 1);
  assert.equal(pushes.length, 1);
});

// ── review round: spoken means heard, frozen terminals, logins, waits on Robert, no silent dead end ──
test("voice: 'started' buys the call time to finish; only 'done' is a delivery; started but never finished → phone", async () => {
  reset();
  const s = term();
  notePresence({ client: "desk-1", live: true, lang: "en" }, NOW);
  show(s.id, st("decide", { asks: 1 }));
  const t0 = NOW + OPERATOR_GRACE_MS;
  await tickAlerts(t0);
  const id = rows()[0].id;
  confirmSpoken(id, "desk-1", t0 + 3 * SEC, "started");
  let row = alerts.get(id)!;
  assert.equal(row.delivered_at, null, "started is not heard");
  assert.equal(row.next_at, t0 + 3 * SEC + VOICE_PLAY_MAX_MS);
  await tickAlerts(t0 + 15 * SEC);
  assert.equal(pushes.length, 0, "the 15s window no longer applies once it is playing");
  await tickAlerts(t0 + 3 * SEC + VOICE_PLAY_MAX_MS);
  assert.equal(pushes.length, 1, "it never finished → the phone");
  row = alerts.get(id)!;
  assert.match(String(row.channels[0].detail), /started playing but never finished/);
  assert.equal(row.delivered_via, "push");

  reset();
  const b = term();
  notePresence({ client: "desk-1", live: true, lang: "en" }, NOW);
  show(b.id, st("decide", { asks: 1 }));
  await tickAlerts(t0);
  const id2 = rows()[0].id;
  confirmSpoken(id2, "desk-1", t0 + 3 * SEC, "started");
  confirmSpoken(id2, "desk-1", t0 + 14 * SEC, "done");
  assert.equal(alerts.get(id2)!.delivered_via, "voice");
  assert.equal(alerts.get(id2)!.delivered_at, new Date(t0 + 14 * SEC).toISOString(), "delivered when it finished playing");
});

test("a frozen terminal (term-status stalled) is told at once, with how long it has printed nothing", async () => {
  reset();
  const s = term();
  outs.set(s.id, NOW - 4 * MIN);
  show(s.id, st("stalled", { line: "no output for 4m in the middle of its turn" }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].kind, "stalled");
  assert.match(rows()[0].text, /stopped responding in the middle of its work 4 minutes ago\. Decide whether to restart it or leave it\.$/);
});

test("a login wall is his at once — failover never moves it — in plain words with the tool's name", async () => {
  reset();
  const s = term();
  walls.set(s.id, { kind: "login", line: "Invalid API key · Please run /login" });
  show(s.id, st("your_turn"));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].kind, "wall");
  assert.equal(rows()[0].reason, "his_from_the_start");
  assert.match(rows()[0].text, /^In Acme, the task “fix the login redirect” is logged out of Claude and cannot go on\. Log in to Claude again, or tell me which account to use\.$/);
  assert.equal(rows()[0].title, "Acme · logged out");
});

test("waiting on Robert: off → his at 10s; on but never woken → his at grace + 15s; an open question → net under ask-robert's deadline", async () => {
  reset();
  const off = term();
  writeSetting("robert.enabled", false, off.workspace_id);
  declare(off.id, { state: "waiting", on: "robert", label: "the staging password" }, NOW);
  show(off.id, st("waiting", { on: "robert", line: "the staging password" }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].kind, "waiting");
  assert.match(rows()[0].text, /is waiting for an answer nobody has given: the staging password\. Tell me what it should do\.$/);

  reset();
  const on = term();
  declare(on.id, { state: "waiting", on: "robert", label: "which region to deploy" }, NOW);
  show(on.id, st("waiting", { on: "robert", line: "which region to deploy" }));
  await tickAlerts(NOW + 20 * SEC + WAKE_SETTLE_MS - 1);
  assert.equal(rows().length, 0, "robert-drive's own 20s grace for a wait on him, then 15s for the wake row");
  await tickAlerts(NOW + 20 * SEC + WAKE_SETTLE_MS);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "robert_not_woken");

  reset();
  const q = term();
  asks.create({ session_id: q.id, workspace_id: q.workspace_id, question: "Use the EU or US bucket?", route: "robert" });
  show(q.id, st("waiting", { on: "robert", line: "Robert is deciding: Use the EU or US bucket?" }));
  await tickAlerts(NOW + 4 * MIN - 1);
  assert.equal(rows().length, 0, "ask-robert escalates it itself at its 3-minute deadline");
  await tickAlerts(NOW + 4 * MIN);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].reason, "robert_triage_overdue");
  assert.match(rows()[0].text, /waiting for an answer nobody has given: Use the EU or US bucket/);
});

test("no rung that reaches him → said on the Mac (last resort), shown as NOT reached, and retried when a phone subscribes", async () => {
  reset();
  subs = 0; tgReady = false;
  tgHealth = { configured: false, lastOkAt: null, lastErrorAt: null, lastError: null, failStreak: 0 };
  const s = term();
  show(s.id, st("decide", { asks: 1 }));
  await tickAlerts(NOW + OPERATOR_GRACE_MS);
  assert.equal(macs.length, 1, "the Mac said it");
  let row = alerts.get(rows()[0].id)!;
  assert.deepEqual(row.channels.map((c) => [c.rung, c.ok]), [["voice", false], ["push", false], ["telegram", false], ["mac", true]]);
  assert.equal(row.delivered_at, null, "the Mac's speakers do not count as reaching him");
  const view = alertsReport({ sinceMs: NOW - MIN }, NOW + MIN).alerts[0];
  assert.equal(view.not_reached, true);
  assert.equal(view.said_on_mac, true);
  // A phone subscribes: the reach check retries it, without saying it on the Mac a second time.
  subs = 1;
  await _test.checkReach(NOW + 2 * MIN);
  row = alerts.get(row.id)!;
  assert.equal(pushes.length, 1);
  assert.equal(row.delivered_via, "push");
  assert.equal(macs.length, 1);
  assert.equal(row.meta.retried, 1);
});

test("no phone and no Telegram for 5 minutes → ONE alert that says so; a phone subscribing ends it", async () => {
  reset();
  subs = 0;
  tgOk = false; // what a send does while DNS for the Bot API fails
  tgHealth = { configured: true, lastOkAt: NOW - 3 * 3_600_000, lastErrorAt: NOW - 10_000, lastError: "TypeError: fetch failed (ENOTFOUND)", failStreak: 12 };
  const r = alertsReadiness(NOW);
  assert.equal(r.remote_usable, false);
  assert.match(r.rungs.find((x) => x.rung === "telegram")!.line, /set up but unreachable: the last 12 calls failed \(TypeError: fetch failed \(ENOTFOUND\)\); last success 3h ago/);
  assert.match(r.rungs.find((x) => x.rung === "push")!.line, /No phone has notifications on/);
  assert.match(r.rungs.find((x) => x.rung === "voice")!.line, /No voice call is live/);
  await _test.checkReach(NOW);
  await _test.checkReach(NOW + UNREACHABLE_AFTER_MS - 1);
  assert.equal(rows().length, 0, "a blip is not an episode");
  await _test.checkReach(NOW + UNREACHABLE_AFTER_MS);
  await _test.checkReach(NOW + UNREACHABLE_AFTER_MS + MIN);
  const reach = rows().filter((x) => x.kind === "unreachable");
  assert.equal(reach.length, 1, "one episode, not one per check");
  assert.equal(reach[0].text, "I have no way to reach you away from the Mac: no phone has notifications on and Telegram cannot be reached from this Mac. Turn on notifications in the phone app, or get Telegram working, so I can.");
  assert.equal(macs.length, 1, "said on the Mac, since nothing remote can take it");
  subs = 1;
  await _test.checkReach(NOW + UNREACHABLE_AFTER_MS + 2 * MIN);
  assert.ok(alerts.get(reach[0].id)!.resolved_at, "a phone can reach him again: over");
  assert.equal(pushes.filter((p) => p.alert_id === reach[0].id).length, 0, "the phone that just subscribed is never told it cannot be reached");
});

test("minutes read like a person says them: 1 minute, 3 minutes — 1 minuto, 3 minutos", () => {
  const one = { kind: "stalled", ws: "Acme", work: "w", minutes: 1 } as TextInput;
  assert.match(alertText(one, "en"), /1 minute ago\./);
  assert.match(alertText(one, "es"), /hace 1 minuto\./);
  assert.match(alertText({ ...one, minutes: 3 } as TextInput, "en"), /3 minutes ago\./);
  assert.match(alertText({ kind: "stalled", ws: "Acme", work: "export", minutes: 1, job: true }, "en"), /for 1 minute\./);
});
