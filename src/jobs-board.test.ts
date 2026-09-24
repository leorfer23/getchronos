import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, jobs, runs } from "./store.js";
import { jobsBoard, runsFeed } from "./jobs-board.js";
import { isInternalJob } from "./job-name.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces;");
});

const NOW = new Date("2026-09-24T15:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ws = (name: string) =>
  workspaces.create({ slug: name.toLowerCase() + "-" + randomUUID().slice(0, 6), name, config_dir: "/tmp/jb-" + randomUUID().slice(0, 8) } as any);
const job = (name: string, workspace_id: string | null = null) => jobs.create({ name, goal: "g", cwd: "/tmp", workspace_id } as any);
function run(job_id: string, status: string, startedHoursAgo: number, secs = 60, cost = 0.5) {
  const r = runs.create(job_id, "cron");
  const started = ago(startedHoursAgo);
  const live = status === "running" || status === "queued";
  runs.patch(r.id, {
    status: status as any,
    started_at: status === "queued" ? null : started,
    ended_at: live ? null : new Date(Date.parse(started) + secs * 1000).toISOString(),
    cost_usd: cost,
  } as any);
  return r.id;
}

test("the board carries each job's strip newest first, its stats and its failure streak", () => {
  const w = ws("Acme");
  const j = job("nightly report", w.id);
  run(j.id, "success", 50, 120, 1);
  run(j.id, "success", 26, 60, 1);
  run(j.id, "failed", 3, 30, 0.25);
  run(j.id, "timeout", 2, 30, 0.25);
  run(j.id, "running", 0.1);
  const b = jobsBoard({ now: NOW, days: 14 });
  assert.equal(b.jobs.length, 1);
  const x = b.jobs[0];
  assert.deepEqual(x.recent.map((r) => r.status), ["running", "timeout", "failed", "success", "success"]);
  assert.equal(x.stats.runs, 5);
  assert.equal(x.stats.success, 2);
  assert.equal(x.stats.failed, 2);
  assert.equal(x.stats.live, 1);
  assert.equal(x.stats.streak_failed, 2, "a live run at the head does not break the streak");
  assert.equal(x.stats.avg_sec, 90);
  assert.equal(x.stats.cost, 3);
  assert.ok(x.stats.last_failure_at && x.stats.last_success_at);
  assert.equal(b.days.length, 14);
  assert.equal(b.days.reduce((n, d) => n + d.success + d.failed, 0), 4);
});

test("the window bounds the stats but not the strip", () => {
  const j = job("weekly");
  run(j.id, "success", 24 * 20);
  run(j.id, "failed", 24 * 2);
  const x = jobsBoard({ now: NOW, days: 7 }).jobs[0];
  assert.equal(x.recent.length, 2);
  assert.equal(x.stats.runs, 1);
  assert.equal(x.stats.failed, 1);
  assert.equal(x.stats.success, 0);
});

test("strip length is capped and machinery jobs stay off the operator board", () => {
  const j = job("hourly sync");
  for (let i = 0; i < 12; i++) run(j.id, "success", i + 1);
  job("ticket:ABC-1 build");
  job("prose:acme");
  const b = jobsBoard({ now: NOW, strip: 5 });
  assert.deepEqual(b.jobs.map((x) => x.name), ["hourly sync"]);
  assert.equal(b.jobs[0].recent.length, 5);
  assert.equal(jobsBoard({ now: NOW, kind: "internal" }).jobs.length, 2);
  assert.equal(jobsBoard({ now: NOW, kind: "all" }).jobs.length, 3);
});

test("a workspace scope shows only that workspace's jobs and runs", () => {
  const a = ws("A"), b = ws("B");
  const ja = job("a job", a.id), jb = job("b job", b.id);
  run(ja.id, "failed", 1);
  run(jb.id, "failed", 1);
  assert.deepEqual(jobsBoard({ now: NOW, ws: a.id }).jobs.map((x) => x.name), ["a job"]);
  assert.deepEqual(runsFeed({ now: NOW, ws: b.id }).map((r) => r.job_name), ["b job"]);
  const all = jobsBoard({ now: NOW, days: 2 });
  assert.equal(all.days.reduce((n, d) => n + d.failed, 0), 2);
  assert.equal(all.days_by_ws[a.id].reduce((n, d) => n + d.failed, 0), 1, "each client gets its own histogram");
});

test("day buckets follow the viewer's clock", () => {
  const j = job("late");
  // 01:30 UTC on the 24th is still the 23rd at UTC-3.
  const r = runs.create(j.id, "cron");
  runs.patch(r.id, { status: "success", started_at: "2026-09-24T01:30:00.000Z", ended_at: "2026-09-24T01:31:00.000Z" } as any);
  const utc = jobsBoard({ now: NOW, days: 3 }).days;
  const art = jobsBoard({ now: NOW, days: 3, tzOffsetMin: 180 }).days;
  assert.equal(utc.find((d) => d.day === "2026-09-24")?.success, 1);
  assert.equal(art.find((d) => d.day === "2026-09-23")?.success, 1);
});

test("the runs feed filters failures and live runs, newest first", () => {
  const j = job("etl");
  run(j.id, "success", 5);
  const f = run(j.id, "failed", 4);
  const t = run(j.id, "interrupted", 3);
  const q = run(j.id, "queued", 0);
  assert.deepEqual(runsFeed({ now: NOW, status: "failed" }).map((r) => r.id), [t, f]);
  assert.deepEqual(runsFeed({ now: NOW, status: "live" }).map((r) => r.id), [q]);
  assert.equal(runsFeed({ now: NOW }).length, 4);
  assert.equal(runsFeed({ now: NOW, limit: 2 }).length, 2);
  assert.equal(runsFeed({ now: NOW, status: "x'; DROP TABLE runs; --" }).length, 0, "a status is bound, never interpolated");
  assert.equal(runsFeed({ now: NOW }).length, 4);
  assert.deepEqual(runsFeed({ now: NOW, status: "success" }).map((r) => r.status), ["success"]);
});

test("prose and hygiene jobs are machinery", () => {
  assert.equal(isInternalJob("prose:acme"), true);
  assert.equal(isInternalJob("hygiene:weekly"), true);
  assert.equal(isInternalJob("prose review for Monday"), false);
});
