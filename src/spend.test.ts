import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, jobs, runs, sessions } from "./store.js";
import { combinedSpend, combinedByWorkspace, spendToday } from "./spend.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM workspaces;",
  );
});

function seedRun(wsId: string, cost: number | null, startedAt: string) {
  const job = jobs.create({
    name: "ticket:SP-" + randomUUID().slice(0, 4),
    goal: "g",
    workspace_id: wsId,
    cwd: "/tmp",
    backend: cost == null ? "grok" : "claude-code",
  } as any);
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    started_at: startedAt,
    status: "success",
    ended_at: startedAt,
    ...(cost === null ? {} : { cost_usd: cost, tokens_in: 100, tokens_out: 50 }),
  } as any);
  return run;
}

function seedSession(
  wsId: string,
  opts: { cost: number; estimated?: boolean; created_at: string; tokens_in?: number; tokens_out?: number },
) {
  const s = sessions.create({
    workspace_id: wsId,
    title: "desk-" + randomUUID().slice(0, 4),
    backend: "claude-code",
    cwd: "/tmp",
  });
  // created_at is set by create(); overwrite for window tests.
  db.prepare("UPDATE sessions SET created_at=?, ended_at=?, status='ended' WHERE id=?").run(
    opts.created_at,
    opts.created_at,
    s.id,
  );
  sessions.setLedger(s.id, {
    cost_usd: opts.cost,
    cost_estimated: opts.estimated ?? false,
    tokens_in: opts.tokens_in ?? 200,
    tokens_out: opts.tokens_out ?? 80,
    turns: 3,
  });
  return sessions.get(s.id)!;
}

test("combinedSpend sums runs + Desk without double counting", () => {
  const ws = workspaces.create({ slug: "sp-" + randomUUID().slice(0, 6), name: "Spend", config_dir: "/tmp/sp" } as any);
  const since = "2026-09-01T00:00:00.000Z";
  seedRun(ws.id, 2.0, "2026-09-02T10:00:00.000Z");
  seedRun(ws.id, 1.5, "2026-09-03T10:00:00.000Z");
  seedSession(ws.id, { cost: 10.0, created_at: "2026-09-02T12:00:00.000Z" });
  seedSession(ws.id, { cost: 4.0, estimated: true, created_at: "2026-09-03T12:00:00.000Z" });

  const c = combinedSpend(since, { workspace_id: ws.id });
  assert.equal(Number(c.runs.usd.toFixed(2)), 3.5);
  assert.equal(Number(c.sessions.usd.toFixed(2)), 14.0);
  assert.equal(Number(c.total_usd.toFixed(2)), 17.5);
  assert.equal(c.sessions.count, 2);
  assert.equal(c.coverage.estimated_usd, 4.0);
  assert.equal(c.coverage.priced_sessions, 1);
  assert.equal(c.coverage.estimated_sessions, 1);
});

test("combinedSpend is workspace-walled", () => {
  const a = workspaces.create({ slug: "spa-" + randomUUID().slice(0, 5), name: "A", config_dir: "/tmp/spa" } as any);
  const b = workspaces.create({ slug: "spb-" + randomUUID().slice(0, 5), name: "B", config_dir: "/tmp/spb" } as any);
  const since = "2026-09-01T00:00:00.000Z";
  seedRun(a.id, 5, "2026-09-02T10:00:00.000Z");
  seedSession(b.id, { cost: 9, created_at: "2026-09-02T10:00:00.000Z" });

  assert.equal(combinedSpend(since, { workspace_id: a.id }).total_usd, 5);
  assert.equal(combinedSpend(since, { workspace_id: b.id }).total_usd, 9);
  assert.equal(combinedSpend(since).total_usd, 14);
});

test("combinedByWorkspace keeps run/session breakdowns", () => {
  const ws = workspaces.create({ slug: "spw-" + randomUUID().slice(0, 5), name: "W", config_dir: "/tmp/spw" } as any);
  const since = "2026-09-01T00:00:00.000Z";
  seedRun(ws.id, 1.25, "2026-09-02T10:00:00.000Z");
  seedSession(ws.id, { cost: 3.75, estimated: true, created_at: "2026-09-02T11:00:00.000Z" });

  const row = combinedByWorkspace(since).find((r) => r.workspace_id === ws.id)!;
  assert.ok(row);
  assert.equal(row.runs_usd, 1.25);
  assert.equal(row.sessions_usd, 3.75);
  assert.equal(row.sessions_estimated_usd, 3.75);
  assert.equal(row.total_usd, 5);
});

test("sessions.spendSince honors the date window (created_at)", () => {
  const ws = workspaces.create({ slug: "spd-" + randomUUID().slice(0, 5), name: "D", config_dir: "/tmp/spd" } as any);
  seedSession(ws.id, { cost: 1, created_at: "2026-08-01T10:00:00.000Z" }); // out
  seedSession(ws.id, { cost: 2, created_at: "2026-09-02T10:00:00.000Z" }); // in
  seedSession(ws.id, { cost: 3, created_at: "2026-09-10T10:00:00.000Z" }); // after until

  const win = sessions.spendSince("2026-09-01T00:00:00.000Z", {
    workspace_id: ws.id,
    until: "2026-09-05T00:00:00.000Z",
  });
  assert.equal(win.usd, 2);
  assert.equal(win.sessions, 1);
});

test("spendToday coverage separates exact Desk from estimated", () => {
  const ws = workspaces.create({ slug: "spt-" + randomUUID().slice(0, 5), name: "T", config_dir: "/tmp/spt" } as any);
  const today = new Date().toISOString();
  seedSession(ws.id, { cost: 7, estimated: false, created_at: today });
  seedSession(ws.id, { cost: 3, estimated: true, created_at: today });
  const t = spendToday(ws.id);
  assert.equal(t.coverage.priced_usd, 7);
  assert.equal(t.coverage.estimated_usd, 3);
  assert.equal(t.total_usd, 10);
});

test("workspace-scoped runWindow reports real unpriced coverage (not silent zeros)", () => {
  const ws = workspaces.create({ slug: "spu-" + randomUUID().slice(0, 5), name: "U", config_dir: "/tmp/spu" } as any);
  const since = "2026-09-01T00:00:00.000Z";
  seedRun(ws.id, 2, "2026-09-02T10:00:00.000Z");
  seedRun(ws.id, null, "2026-09-02T11:00:00.000Z"); // unpriced grok
  const c = combinedSpend(since, { workspace_id: ws.id });
  assert.equal(c.runs.priced, 1);
  assert.equal(c.runs.unpriced, 1);
  assert.ok(c.coverage.unpriced_backends.includes("grok"));
  assert.equal(c.coverage.unpriced_runs, 1);
});

test("estimated headless runs stay labelled in coverage", () => {
  const ws = workspaces.create({ slug: "spe-" + randomUUID().slice(0, 5), name: "E", config_dir: "/tmp/spe" } as any);
  const since = "2026-09-01T00:00:00.000Z";
  const job = jobs.create({
    name: "ticket:EST",
    goal: "g",
    workspace_id: ws.id,
    cwd: "/tmp",
    backend: "grok",
  } as any);
  const run = runs.create(job.id, "manual");
  runs.patch(run.id, {
    started_at: "2026-09-02T10:00:00.000Z",
    ended_at: "2026-09-02T10:01:00.000Z",
    status: "success",
    cost_usd: 0.42,
    cost_estimated: 1,
    tokens_in: 1000,
    tokens_out: 100,
  } as any);
  const c = combinedSpend(since, { workspace_id: ws.id });
  assert.equal(c.runs.estimated, 1);
  assert.equal(c.runs.priced, 0);
  assert.equal(c.coverage.estimated_runs, 1);
  assert.equal(Number(c.coverage.estimated_usd.toFixed(2)), 0.42);
  assert.equal(c.coverage.priced_usd, 0);
});
