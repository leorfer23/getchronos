import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { pruneBackups, rotateLogIfNeeded, composeBrief, isStalled, maybeStallSweep, shouldRemind, maybeAskReminders, effectiveStallMinutes, effectiveAskRemindHours, type BriefWs } from "./monitor.js";
import { db, workspaces, tickets, jobs, runs, events, kv, asks, repos, steps } from "./store.js";
import { getAgent } from "./agent-lifecycle.js";

const mkWs = (o: Partial<BriefWs> = {}): BriefWs => ({
  name: "Acme", autoPlan: false, spend: 0, open: 0, mirrored: 0, review: 0, live: 0,
  arrived: [], builtOk: 0, builtFail: 0, reviewsAwaiting: 0,
  ideasProposed: 0, ideasExpiringSoon: 0, ...o,
});
const arr = (key: string, createdAt: string, o: Partial<BriefWs["arrived"][0]> = {}) =>
  ({ key, title: `${key} title`, status: "backlog", ticketId: key.toLowerCase().padEnd(8, "0"), createdAt, ...o });

const totals = { spent: 1, budget: 5, awaitingReview: 0 };

function tmpDirWithFiles(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-backup-"));
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  return dir;
}

test("pruneBackups keeps the N most recent by name and deletes the rest", () => {
  const dir = tmpDirWithFiles([
    "chronos-2024-01-01.db",
    "chronos-2024-01-02.db",
    "chronos-2024-01-03.db",
    "chronos-2024-01-04.db",
  ]);
  pruneBackups(dir, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["chronos-2024-01-03.db", "chronos-2024-01-04.db"]);
});

test("pruneBackups ignores non-matching files", () => {
  const dir = tmpDirWithFiles(["chronos-2024-01-01.db", "chronos.db-shm", "notes.txt"]);
  pruneBackups(dir, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["chronos.db-shm", "notes.txt"]);
});

test("pruneBackups is a no-op when under the retain limit", () => {
  const dir = tmpDirWithFiles(["chronos-2024-01-01.db"]);
  pruneBackups(dir, 7);
  assert.deepEqual(fs.readdirSync(dir), ["chronos-2024-01-01.db"]);
});

test("rotateLogIfNeeded is a no-op under maxBytes", () => {
  const dir = tmpDirWithFiles([]);
  const file = path.join(dir, "chronos.err.log");
  fs.writeFileSync(file, "small");
  assert.equal(rotateLogIfNeeded(file, 1024, 3), false);
  assert.equal(fs.readFileSync(file, "utf8"), "small");
  assert.deepEqual(fs.readdirSync(dir), ["chronos.err.log"]);
});

test("rotateLogIfNeeded is a no-op when the file doesn't exist", () => {
  const dir = tmpDirWithFiles([]);
  assert.equal(rotateLogIfNeeded(path.join(dir, "missing.log"), 10, 3), false);
});

test("rotateLogIfNeeded gzips + truncates over maxBytes, preserving content", () => {
  const dir = tmpDirWithFiles([]);
  const file = path.join(dir, "chronos.err.log");
  const body = "boom\n".repeat(1000);
  fs.writeFileSync(file, body);
  assert.equal(rotateLogIfNeeded(file, 100, 3), true);
  assert.equal(fs.readFileSync(file, "utf8"), "");
  const gz = zlib.gunzipSync(fs.readFileSync(`${file}.1.gz`)).toString("utf8");
  assert.equal(gz, body);
});

test("rotateLogIfNeeded shifts older rotations and drops the oldest beyond retain", () => {
  const dir = tmpDirWithFiles([]);
  const file = path.join(dir, "chronos.err.log");
  fs.writeFileSync(`${file}.1.gz`, "gen1");
  fs.writeFileSync(`${file}.2.gz`, "gen2");
  fs.writeFileSync(file, "x".repeat(200));
  assert.equal(rotateLogIfNeeded(file, 100, 2), true);
  assert.equal(fs.readFileSync(`${file}.2.gz`, "utf8"), "gen1");
  assert.equal(fs.existsSync(`${file}.3.gz`), false);
  const gz = zlib.gunzipSync(fs.readFileSync(`${file}.1.gz`)).toString("utf8");
  assert.equal(gz, "x".repeat(200));
});

test("composeBrief: skips empty workspaces, renders arrived + overnight", () => {
  const wsList: BriefWs[] = [
    mkWs({ name: "Empty" }),
    mkWs({ name: "Acme", open: 2, spend: 1.5, arrived: [arr("ACM-14", "2026-07-12T01:00")], builtOk: 3, builtFail: 1, reviewsAwaiting: 2 }),
  ];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.doesNotMatch(text, /Empty/);
  assert.match(text, /<b>Acme<\/b> — \$1\.50 · 2 open/);
  assert.match(text, /🆕 Arrived\nACM-14 ACM-14 title/);
  assert.match(text, /🌙 3 built · 1 failed · 2 awaiting review/);
});

test("composeBrief: truncates long titles and overflows past 5 arrived", () => {
  const arrived = ["A", "B", "C", "D", "E", "F", "G"].map((k, i) => arr(`ACM-${i}`, `2026-07-12T0${i}:00`, { title: `${k} `.repeat(40) }));
  const { text } = composeBrief("2026-07-12", [mkWs({ open: 7, arrived })], totals);
  assert.match(text, /…/);            // long title truncated
  assert.match(text, /\+2 more/);     // 7 arrived, 5 shown
});

test("composeBrief: buttons only for backlog tickets in auto_plan-off ws, oldest first, cap 6", () => {
  const off = mkWs({
    name: "Off", open: 9,
    arrived: [
      arr("ACM-1", "2026-07-12T03:00"),
      arr("ACM-2", "2026-07-12T01:00"),                         // oldest
      arr("ACM-3", "2026-07-12T02:00", { status: "planned" }), // not backlog → no button
    ],
  });
  const on = mkWs({ name: "On", autoPlan: true, open: 1, arrived: [arr("CED-1", "2026-07-12T00:00")] });
  const { text, buttons } = composeBrief("2026-07-12", [off, on], totals);
  assert.deepEqual(buttons.map((b) => b.text), ["▶ ACM-2", "▶ ACM-1"]);
  assert.equal(buttons[0].data, "br.p.acm-2000");
  assert.ok(buttons.every((b) => b.data.length <= 64));
  assert.doesNotMatch(text, /CED-1.*▶/);       // auto_plan ws gets no button
  assert.match(text, /CED-1 CED-1 title ⚙ auto/); // ...just the inline marker
});

test("composeBrief: shows '+N mirrored' next to 'open' when a workspace has tracker-mirrored tickets", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Acme", open: 5, mirrored: 3 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.match(text, /<b>Acme<\/b> — \$0\.00 · 5 open \(\+3 mirrored\)/);
});

test("composeBrief: no mirrored suffix when there are none", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Acme", open: 5, mirrored: 0 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.doesNotMatch(text, /mirrored/);
});

test("composeBrief: shows the idea pool line when a workspace has proposed ideas", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Acme", open: 5, ideasProposed: 4, ideasExpiringSoon: 2 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.match(text, /💡 ideas: 4 proposed · 2 expiran esta semana/);
});

test("composeBrief: idea pool line omits the expiring clause when nothing is close", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Acme", open: 5, ideasProposed: 4, ideasExpiringSoon: 0 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.match(text, /💡 ideas: 4 proposed(?!.*expiran)/);
});

test("composeBrief: no idea line and no crash when the pool is empty", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Acme", open: 5 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.doesNotMatch(text, /💡/);
});

test("composeBrief: a workspace with only a pending idea pool (nothing else) still gets a line", () => {
  const wsList: BriefWs[] = [mkWs({ name: "Empty", ideasProposed: 1 })];
  const { text } = composeBrief("2026-07-12", wsList, totals);
  assert.match(text, /<b>Empty<\/b>/);
  assert.match(text, /💡 ideas: 1 proposed/);
});

test("composeBrief: caps buttons at 6", () => {
  const arrived = Array.from({ length: 9 }, (_, i) => arr(`ACM-${i}`, `2026-07-12T0${i}:00`));
  const { buttons } = composeBrief("2026-07-12", [mkWs({ open: 9, arrived })], totals);
  assert.equal(buttons.length, 6);
});

test("effectiveStallMinutes: null falls back to global CONFIG, a number wins, 0 means off", () => {
  assert.equal(effectiveStallMinutes(undefined), 15); // test env default (no CHRONOS_STALL_MINUTES)
  assert.equal(effectiveStallMinutes({ stall_minutes: null }), 15);
  assert.equal(effectiveStallMinutes({ stall_minutes: 30 }), 30);
  assert.equal(effectiveStallMinutes({ stall_minutes: 0 }), 0);
});

test("effectiveAskRemindHours: null falls back to global CONFIG, a number wins, 0 means off", () => {
  assert.equal(effectiveAskRemindHours(undefined), 2); // test env default (no CHRONOS_ASK_REMIND_HOURS)
  assert.equal(effectiveAskRemindHours({ ask_remind_hours: null }), 2);
  assert.equal(effectiveAskRemindHours({ ask_remind_hours: 6 }), 6);
  assert.equal(effectiveAskRemindHours({ ask_remind_hours: 0 }), 0);
});

test("isStalled: threshold edges + detector-off", () => {
  const now = Date.now();
  const exactly10 = new Date(now - 10 * 60_000).toISOString();
  const over10 = new Date(now - 10 * 60_000 - 1000).toISOString();
  assert.equal(isStalled(exactly10, null, now, 10), false); // right at the threshold, not over it
  assert.equal(isStalled(over10, null, now, 10), true); // past it
  assert.equal(isStalled(null, null, now, 10), false); // no event ts, no started_at → nothing to judge
  assert.equal(isStalled(over10, null, now, 0), false); // 0 = detector off
  assert.equal(isStalled(null, over10, now, 10), true); // no events yet → falls back to started_at
});

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM run_steps; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces; DELETE FROM kv; DELETE FROM asks;");
});

let stallN = 0;
type StallSeed = {
  /** Registered as a repo of the workspace so the job may legitimately point its cwd at it. */
  checkout?: string;
  ticketStatus?: string;
  ask?: string;
};
function seedRunningTicketRun(
  startedMinutesAgo: number,
  wsOverrides: Record<string, unknown> = {},
  seed: StallSeed = {}
): string {
  const ws = workspaces.create({ slug: "stall-" + Math.random().toString(36).slice(2), name: "Stall", config_dir: "/tmp/stall", ...wsOverrides } as any);
  const key = `ST-${++stallN}`;
  const repo = seed.checkout ? repos.create({ workspace_id: ws.id, name: key, path: seed.checkout } as any) : undefined;
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: repo?.id ?? null, key, slug: key.toLowerCase(),
    title: key, status: seed.ticketStatus ?? "in_progress", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  const job = jobs.create({ name: `ticket:${key}`, goal: "g", workspace_id: ws.id, ticket_id: t.id, cwd: seed.checkout } as any);
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, { status: "running", started_at: new Date(Date.now() - startedMinutesAgo * 60_000).toISOString() });
  if (seed.ask) asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: ws.id, question: seed.ask });
  return run.id;
}

// A checkout the write probe will accept (walkableCheckout wants a .git), aged out of the quiet window.
function seedCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-stall-wt-"));
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "old.ts"), "x");
  const old = new Date(Date.now() - 6 * 3600_000);
  for (const p of [path.join(root, "src", "old.ts"), path.join(root, "src"), path.join(root, ".git")])
    fs.utimesSync(p, old, old);
  return root;
}

test("maybeStallSweep: notifies once, sets a blocked overlay, then clears both once events resume", async () => {
  // Default CONFIG.stallMinutes is 15 in the test env (no CHRONOS_STALL_MINUTES override).
  const runId = seedRunningTicketRun(20); // started 20m ago, no run_events since → stalled

  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), "1");
  assert.equal(getAgent(runId)?.state, "blocked");
  assert.equal(getAgent(runId)?.blocked_reason, "stall");

  // Still stalled on the next sweep — overlay refreshes, but the marker (and thus the notify) doesn't repeat.
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), "1");

  // Fresh activity → next sweep clears the marker and the overlay so a later stall could re-notify.
  events.add(runId, "assistant", { type: "assistant" });
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), undefined);
  assert.equal(getAgent(runId)?.blocked_reason, null);
});

test("maybeStallSweep: a run well under the threshold is left alone", async () => {
  const runId = seedRunningTicketRun(1);
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), undefined);
  assert.equal(getAgent(runId)?.blocked_reason, null);
});

test("maybeStallSweep: workspace stall_minutes=0 turns the detector off even though it's stalled by the global default", async () => {
  const runId = seedRunningTicketRun(20, { stall_minutes: 0 }); // 20m quiet, global default is 15m
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), undefined);
  assert.equal(getAgent(runId)?.blocked_reason, null);
});

test("maybeStallSweep: workspace stall_minutes overrides the global default down (fires sooner)", async () => {
  const runId = seedRunningTicketRun(6, { stall_minutes: 5 }); // 6m quiet, under the 15m global default
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), "1");
  assert.equal(getAgent(runId)?.blocked_reason, "stall");
});

test("maybeStallSweep: step activity counts as liveness even with no run events", async () => {
  const runId = seedRunningTicketRun(20);
  steps.declare(runId, ["read the code", "write the fix"]);
  await maybeStallSweep();
  assert.equal(kv.get(`stall.notified.${runId}`), undefined);
  assert.equal(kv.get(`stall.escalations.${runId}`), undefined);
  assert.equal(getAgent(runId)?.blocked_reason, null);
});

test("maybeStallSweep: a quiet run still writing its checkout is deferred, not alarmed", async () => {
  const wt = seedCheckout();
  const runId = seedRunningTicketRun(20, {}, { checkout: wt });
  fs.writeFileSync(path.join(wt, "src", "fresh.ts"), "x"); // written inside the quiet window

  await maybeStallSweep();
  const a = getAgent(runId);
  assert.equal(a?.state, "working"); // writing files is working — never the Desk's needs-you column
  assert.equal(a?.state_label, "quiet 20m, still writing files");
  assert.equal(a?.demand_inspection, false);
  assert.equal(kv.get(`stall.notified.${runId}`), undefined); // no Telegram
  assert.equal(kv.get(`stall.escalations.${runId}`), undefined);
});

test("maybeStallSweep: no evidence escalates with a count, and asks for a look at stallInspectCount", async () => {
  const wt = seedCheckout(); // nothing written since it was seeded
  const runId = seedRunningTicketRun(20, {}, { checkout: wt });

  await maybeStallSweep();
  assert.equal(kv.get(`stall.escalations.${runId}`), "1");
  assert.equal(kv.get(`stall.notified.${runId}`), "1");
  assert.equal(getAgent(runId)?.blocked_reason, "stall");
  assert.equal(getAgent(runId)?.state_label, "quiet 20m, no liveness evidence");
  assert.equal(getAgent(runId)?.demand_inspection, false);

  await maybeStallSweep();
  assert.equal(kv.get(`stall.escalations.${runId}`), "2");
  assert.equal(getAgent(runId)?.demand_inspection, false);

  await maybeStallSweep(); // CONFIG.stallInspectCount is 3 in the test env
  assert.equal(kv.get(`stall.escalations.${runId}`), "3");
  assert.equal(getAgent(runId)?.demand_inspection, true);
  assert.match(getAgent(runId)?.state_label ?? "", /no files written, no terminal output for 3 checks — needs a look/);
});

test("maybeStallSweep: write evidence clears an escalation count the earlier sweeps built up", async () => {
  const wt = seedCheckout();
  const runId = seedRunningTicketRun(20, {}, { checkout: wt });
  await maybeStallSweep();
  await maybeStallSweep();
  assert.equal(kv.get(`stall.escalations.${runId}`), "2");

  fs.writeFileSync(path.join(wt, "src", "fresh.ts"), "x");
  await maybeStallSweep();
  assert.equal(kv.get(`stall.escalations.${runId}`), undefined);
  assert.equal(getAgent(runId)?.state, "working");
  assert.equal(getAgent(runId)?.demand_inspection, false);
});

test("maybeStallSweep: a run parked on an open ask is a declared wait, resurfaced on the long cadence", async () => {
  const runId = seedRunningTicketRun(20, {}, { ask: "which env?" });

  await maybeStallSweep();
  const a = getAgent(runId);
  assert.equal(a?.blocked_reason, "question");
  assert.match(a?.state_label ?? "", /waiting on an answer: “which env\?”/);
  assert.equal(a?.demand_inspection, false);
  assert.equal(kv.get(`stall.escalations.${runId}`), undefined); // a declared wait never escalates
  const surfaced = kv.get(`stall.surfaced.${runId}`);
  assert.ok(surfaced);

  // Well inside CONFIG.pauseResurfaceMinutes (240) — the overlay stays, the operator is not told again.
  await maybeStallSweep();
  assert.equal(kv.get(`stall.surfaced.${runId}`), surfaced);

  // Past the cadence → one more line.
  kv.set(`stall.surfaced.${runId}`, new Date(Date.now() - 241 * 60_000).toISOString());
  await maybeStallSweep();
  assert.notEqual(kv.get(`stall.surfaced.${runId}`), surfaced);
});

test("maybeStallSweep: a ticket the operator is holding for review is a declared wait, not a wedge", async () => {
  const runId = seedRunningTicketRun(20, {}, { ticketStatus: "review" });
  await maybeStallSweep();
  assert.equal(getAgent(runId)?.blocked_reason, "review");
  assert.equal(getAgent(runId)?.state_label, "quiet 20m, waiting on your review");
  assert.equal(kv.get(`stall.escalations.${runId}`), undefined);
});

test("shouldRemind: threshold edges, repeat-reminder resets the clock, off", () => {
  const now = Date.now();
  const exactly2h = new Date(now - 2 * 3600_000).toISOString();
  const over2h = new Date(now - 2 * 3600_000 - 1000).toISOString();
  assert.equal(shouldRemind(exactly2h, null, now, 2), false); // right at the threshold, not over it
  assert.equal(shouldRemind(over2h, null, now, 2), true); // past it, never reminded
  assert.equal(shouldRemind(over2h, null, now, 0), false); // 0 = off
  assert.equal(shouldRemind(over2h, over2h, now, 2), true); // last reminder also past threshold
  const justReminded = new Date(now - 1000).toISOString();
  assert.equal(shouldRemind(over2h, justReminded, now, 2), false); // reminded recently — clock resets off lastRemindedAt
});

let askN = 0;
function seedOpenAsk(createdMinutesAgo: number, question = "which env?", wsOverrides: Record<string, unknown> = {}): string {
  const ws = workspaces.create({ slug: "ask-" + Math.random().toString(36).slice(2), name: "Ask", config_dir: "/tmp/ask", ...wsOverrides } as any);
  const key = `AK-${++askN}`;
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key, slug: key.toLowerCase(),
    title: key, status: "in_progress", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  const job = jobs.create({ name: `ticket:${key}`, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const ask = asks.create({ run_id: run.id, job_id: job.id, ticket_id: t.id, workspace_id: ws.id, question });
  db.prepare("UPDATE asks SET created_at = ? WHERE id = ?").run(
    new Date(Date.now() - createdMinutesAgo * 60_000).toISOString(),
    ask.id
  );
  return ask.id;
}

test("maybeAskReminders: reminds once past the threshold, doesn't repeat immediately, ignores answered asks", async () => {
  // Default CONFIG.askRemindHours is 2 in the test env (no CHRONOS_ASK_REMIND_HOURS override).
  const askId = seedOpenAsk(180); // 3h old → past the 2h threshold

  await maybeAskReminders();
  const firstMark = kv.get(`ask.reminded.${askId}`);
  assert.ok(firstMark);

  // Immediately again — just reminded, nowhere near another 2h — marker unchanged.
  await maybeAskReminders();
  assert.equal(kv.get(`ask.reminded.${askId}`), firstMark);

  asks.answer(askId, "yes", "leo");
  await maybeAskReminders(); // answered → asks.list({status:"open"}) no longer returns it; no-op, no throw
});

test("maybeAskReminders: a fresh ask under the threshold is left alone", async () => {
  const askId = seedOpenAsk(5);
  await maybeAskReminders();
  assert.equal(kv.get(`ask.reminded.${askId}`), undefined);
});

test("maybeAskReminders: workspace ask_remind_hours=0 turns reminders off even past the global default", async () => {
  const askId = seedOpenAsk(180, "which env?", { ask_remind_hours: 0 }); // 3h old, global default is 2h
  await maybeAskReminders();
  assert.equal(kv.get(`ask.reminded.${askId}`), undefined);
});

test("maybeAskReminders: workspace ask_remind_hours overrides the global default down (fires sooner)", async () => {
  const askId = seedOpenAsk(90, "which env?", { ask_remind_hours: 1 }); // 1.5h old, under the 2h global default
  await maybeAskReminders();
  assert.ok(kv.get(`ask.reminded.${askId}`));
});
