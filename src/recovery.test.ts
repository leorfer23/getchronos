import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jobs, kv, runs, sessions, tickets, workspaces } from "./store.js";
import { listStalls, decideStall, awaitingRecovery } from "./recovery.js";
import { setExecutor } from "./dispatcher.js";

// The supervisor must never spawn a real agent: every dispatch it can reach is scripted here, and the
// count is the assertion — "no automatic retries" is a claim about this number staying at 0.
let dispatched = 0;
setExecutor(async (_job, runId) => {
  dispatched++;
  runs.patch(runId, { status: "success", ended_at: new Date().toISOString() });
  return "success";
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// One interrupted run, exactly as db.ts's startup reconciliation leaves it after a daemon restart.
function seedInterruptedRun(endedAt = hoursAgo(1)) {
  const ws = workspaces.create({
    slug: "rec-" + randomUUID().slice(0, 8),
    name: "Rec",
    config_dir: "/tmp/rec",
  } as any);
  const job = jobs.create({ name: `ideas:followups:${randomUUID().slice(0, 4)}`, goal: "g", workspace_id: ws.id } as any);
  const run = runs.create(job.id, "cron");
  runs.patch(run.id, { status: "interrupted", started_at: endedAt, ended_at: endedAt, error: "daemon restarted while run was active" });
  return { ws, job, run, id: `r:${run.id.slice(0, 8)}` };
}

test("an interrupted run becomes a pending decision, and nothing is dispatched for it", () => {
  const before = dispatched;
  const { id } = seedInterruptedRun();
  const stall = listStalls().find((s) => s.id === id);
  assert.ok(stall, "interrupted run surfaced as a stall");
  assert.equal(stall!.kind, "run");
  assert.equal(dispatched, before, "listing stalls must never dispatch");
});

test("declining is remembered — the same stall is never raised again", async () => {
  const before = dispatched;
  const { id } = seedInterruptedRun();
  const out = await decideStall(id, false);
  assert.match(out, /Left alone/);
  assert.equal(listStalls().find((s) => s.id === id), undefined, "declined stall disappears");
  assert.equal(dispatched, before, "declining dispatches nothing");
});

test("approving is the only path that re-dispatches", async () => {
  const before = dispatched;
  const { id } = seedInterruptedRun();
  const out = await decideStall(id, true);
  assert.match(out, /Resumed/);
  assert.equal(dispatched, before + 1, "approve dispatched exactly one run");
  assert.equal(listStalls().find((s) => s.id === id), undefined, "approved stall disappears");
});

test("interruptions older than the window are history, not a decision", () => {
  const { id } = seedInterruptedRun(hoursAgo(72));
  assert.equal(listStalls().find((s) => s.id === id), undefined, "stale interruption is not raised");
});

test("hygiene may not reap a job whose stall is still awaiting an answer", async () => {
  const { job, id } = seedInterruptedRun();
  assert.equal(awaitingRecovery(job.id), true, "job is protected while undecided");
  await decideStall(id, false);
  assert.equal(awaitingRecovery(job.id), false, "protection lifts once decided");
});

test("a ticket parked in_progress with no agent is a stall; a fresh one is not", () => {
  const ws = workspaces.create({
    slug: "recT-" + randomUUID().slice(0, 8),
    name: "RecT",
    config_dir: "/tmp/recT",
  } as any);
  const mk = (key: string, updatedAt: string) => {
    const t = tickets.create({
      id: randomUUID(), workspace_id: ws.id, repo_id: null, key, slug: key.toLowerCase(), title: `t ${key}`,
      status: "in_progress", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
      file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
    } as any);
    // tickets.update() always stamps updated_at=now(), so age the row directly — this is what a
    // 10-day-old Jira-imported in_progress ticket actually looks like in the table.
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(updatedAt, t.id);
    return t;
  };
  const stale = mk("REC-1", hoursAgo(48));
  const fresh = mk("REC-2", hoursAgo(1));

  const ids = listStalls().map((s) => s.id);
  assert.ok(ids.includes(`t:${stale.key}`), "long-parked ticket is a stall");
  assert.ok(!ids.includes(`t:${fresh.key}`), "recently-touched ticket is left alone");

  // A live run on it means an agent IS working — not stalled, whatever the clock says.
  const job = jobs.create({ name: `ticket:${stale.key}`, goal: "g", workspace_id: ws.id, ticket_id: stale.id } as any);
  const r = runs.create(job.id, "manual");
  runs.patch(r.id, { status: "running" });
  assert.ok(!listStalls().some((s) => s.id === `t:${stale.key}`), "ticket with a live run is not a stall");
});

test("a ticket being worked in a live Desk terminal is not a stall, even with no run row; an ended terminal doesn't protect it", () => {
  const ws = workspaces.create({
    slug: "recS-" + randomUUID().slice(0, 8),
    name: "RecSess",
    config_dir: "/tmp/recS",
  } as any);
  const mk = (key: string) => {
    const t = tickets.create({
      id: randomUUID(), workspace_id: ws.id, repo_id: null, key, slug: key.toLowerCase(), title: `t ${key}`,
      status: "in_progress", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
      file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
    } as any);
    db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(hoursAgo(48), t.id);
    return t;
  };

  // Live session, no run at all — a terminal claimed to this ticket all day.
  const withLive = mk("RECS-1");
  const live = sessions.create({ workspace_id: ws.id, ticket_id: withLive.id, role: "human", cwd: "/tmp" });
  assert.ok(!listStalls().some((s) => s.id === `t:${withLive.key}`), "ticket with a live session is not a stall");

  // Ending the terminal removes that protection — same false alarm as before, once nothing is live.
  sessions.end(live.id);
  assert.ok(listStalls().some((s) => s.id === `t:${withLive.key}`), "ticket becomes a stall again once its session ends and no run covers it");

  // No session at all, still stale and unrun: stalls exactly as before this fix.
  const bare = mk("RECS-2");
  assert.ok(listStalls().some((s) => s.id === `t:${bare.key}`), "ticket with no session and no run is a stall, as before");
});

test("a tracker-mirrored in_progress ticket (status_source 'external') is never a stall — it's expected tracker state, not a died agent", () => {
  const ws = workspaces.create({
    slug: "recM-" + randomUUID().slice(0, 8),
    name: "RecMirror",
    config_dir: "/tmp/recM",
  } as any);
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: null, key: "MIR-1", slug: "mir-1", title: "mirrored ticket",
    status: "in_progress", status_source: "external", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: "/tmp/MIR-1.md", external_system: "clickup", external_id: "ext-1", external_url: null, tags: null,
  } as any);
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(hoursAgo(48), t.id); // long stale, would otherwise trip the sweep

  assert.ok(!listStalls().some((s) => s.id === `t:${t.key}`), "mirror ticket is excluded from the stall sweep");
});

test("kv holds the decision, so a restart cannot re-ask", async () => {
  const { id } = seedInterruptedRun();
  await decideStall(id, false);
  assert.equal(kv.get(`recover.${id}`), "declined");
});
