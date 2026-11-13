/**
 * The daily job check (src/job-check.ts): the daemon judges a client's last 24 hours of jobs, records
 * the check as a zero-cost run, and only red opens a terminal (or, refused, the job's headless run).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, jobs, kv, runs, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { cronSkipReason, reloadSchedules } from "./scheduler.js";
import {
  AUTO_RERUN, JOB_CHECK_PREFIX, checkBrief, checkGoal, cronFires, ensureCheckJob, healthLine, healthRequest,
  jobCheckDeps, jobHealth, openCheckTerminal, recordCheck, sayKeptDefaults,
} from "./job-check.js";
import { _resetSettingsCache, writeSetting } from "./settings.js";
import { decideStall, listStalls } from "./recovery.js";
import type { Job, RunStatus } from "./types.js";

const TZ = "America/Argentina/Buenos_Aires";
// jobHealth prints local times in CONFIG.slackTriageTz, which defaults to the machine's zone — pin it,
// or the suite only passes on a Mac set to Buenos Aires (CI runners are UTC).
(CONFIG as any).slackTriageTz = TZ;
// 17:00 in Buenos Aires (UTC-3).
const NOW = new Date("2026-11-02T20:00:00.000Z");
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

const mkWs = (over: Record<string, unknown> = {}) =>
  workspaces.create({ slug: "jc-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}`, ...over } as any);

function mkJob(wsId: string, over: Partial<Job> & { name?: string } = {}): Job {
  const j = jobs.create({
    name: over.name ?? "nightly-" + randomUUID().slice(0, 6), goal: "do it", cwd: "/tmp", workspace_id: wsId,
    trigger_type: (over.trigger_type ?? "cron") as any, cron_expr: over.cron_expr === undefined ? "0 9 * * *" : over.cron_expr,
    timezone: over.timezone ?? TZ, enabled: over.enabled === undefined ? true : !!over.enabled,
  } as any);
  // Born well before the window, so every fire in it is due.
  db.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(h(24 * 7), j.id);
  return jobs.get(j.id)!;
}
function mkRun(jobId: string, status: RunStatus, startedHoursAgo: number | null, over: Record<string, unknown> = {}): string {
  const r = runs.create(jobId, "cron");
  runs.patch(r.id, { status, started_at: startedHoursAgo === null ? null : h(startedHoursAgo), ...over } as any);
  return r.id;
}
// 09:00 Buenos Aires = 12:00Z = 8h before NOW.
const AT_FIRE = 8;

let ws: ReturnType<typeof mkWs>;
beforeEach(() => {
  db.exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'cron.skip.%' OR key LIKE 'jobcheck.%' OR key LIKE 'settings:%' OR key LIKE 'recover.%' OR key LIKE 'defaults.%';");
  _resetSettingsCache();
  ws = mkWs();
});
afterEach(() => { db.exec("DELETE FROM jobs"); reloadSchedules(); });

test("cronFires: the due fires in the window, in the job's own zone", () => {
  const f = cronFires("*/30 10-18 * * 1-5", TZ, new Date("2026-11-01T20:00:00Z"), NOW);
  assert.equal(f.length, 15, "Mon 10:00 → 17:00 every 30 min"); // Sunday has none
  assert.equal(f[0].toISOString(), "2026-11-02T13:00:00.000Z");
  assert.equal(f.at(-1)!.toISOString(), NOW.toISOString());
  assert.deepEqual(cronFires("not a cron", TZ, new Date(0), NOW), []);
});

test("green: the latest fire ran and succeeded", () => {
  const j = mkJob(ws.id);
  mkRun(j.id, "success", AT_FIRE);
  const r = jobHealth(ws.id, { now: NOW });
  assert.deepEqual([r.jobs, r.runs, r.red.length, r.recovered], [1, 1, 0, 0]);
  assert.match(healthLine(r), /^all green — 1 job, 1 run in 24h$/);
});

test("red: the latest run failed — status, local time and the error's first line", () => {
  const j = mkJob(ws.id, { name: "nightly-sync" });
  mkRun(j.id, "timeout", AT_FIRE, { error: "\n  watchdog: no output for 600s\nstack…" });
  const [red] = jobHealth(ws.id, { now: NOW }).red;
  assert.equal(red.kind, "failed");
  assert.equal(red.job_name, "nightly-sync");
  assert.match(red.detail, /^timeout at 02\/11 09:00: watchdog: no output for 600s$/);
  assert.equal(red.runs.length, 1);
});

test("a failure a later run fixed is recovered, not red", () => {
  const j = mkJob(ws.id, { cron_expr: "0 9,15 * * *" });
  mkRun(j.id, "failed", AT_FIRE, { error: "ENOTFOUND" });
  mkRun(j.id, "success", 2);
  const r = jobHealth(ws.id, { now: NOW });
  assert.equal(r.red.length, 0);
  assert.equal(r.recovered, 1);
  assert.match(healthLine(r), /1 recovered on their own/);
});

test("missed: a due fire with no run and no skip recorded", () => {
  mkJob(ws.id, { name: "morning-report" });
  const [red] = jobHealth(ws.id, { now: NOW }).red;
  assert.equal(red.kind, "missed");
  assert.match(red.detail, /^due 02\/11 09:00, no run and no skip recorded/);
});

test("a fire from before the check was armed is not judged missed — its skip could not be recorded", () => {
  mkJob(ws.id, { name: "morning-report" });
  kv.set("jobcheck.armed_at", h(2));
  try { assert.equal(jobHealth(ws.id, { now: NOW }).red.length, 0); }
  finally { kv.del("jobcheck.armed_at"); }
});

test("a fire skipped on purpose is not missed; a refused one is red", () => {
  const gated = mkJob(ws.id, { name: "gated" });
  const refused = mkJob(ws.id, { name: "refused" });
  kv.set("cron.skip." + gated.id, JSON.stringify({ at: h(AT_FIRE), kind: "gate", why: "nothing open" }));
  kv.set("cron.skip." + refused.id, JSON.stringify({ at: h(AT_FIRE), kind: "refused", why: "daily budget $5 reached" }));
  const r = jobHealth(ws.id, { now: NOW });
  assert.deepEqual(r.red.map((x) => [x.job_name, x.kind]), [["refused", "refused"]]);
  assert.match(r.red[0].detail, /Chronos refused to start it: daily budget \$5 reached/);
  // A skip recorded before the latest fire says nothing about it.
  kv.set("cron.skip." + gated.id, JSON.stringify({ at: h(30), kind: "gate", why: "nothing open" }));
  assert.ok(jobHealth(ws.id, { now: NOW }).red.some((x) => x.job_name === "gated" && x.kind === "missed"));
});

test("a fire due in the last minutes belongs to tomorrow's check", () => {
  mkJob(ws.id, { cron_expr: "57 16 * * *" }); // 3 minutes before the check
  mkJob(ws.id, { cron_expr: "0 17 * * *" });  // the same minute as the check
  // Each still has yesterday's fire in the window — give it its run.
  for (const j of jobs.list()) mkRun(j.id, "success", 23.9);
  assert.equal(jobHealth(ws.id, { now: NOW }).red.length, 0);
});

test("a rate-limit fallback clone's run counts for the job it stands in for", () => {
  const j = mkJob(ws.id, { name: "refresh-checkouts" });
  const fb = mkJob(ws.id, { name: "fallback:refresh-checkouts", trigger_type: "manual" as any, cron_expr: null });
  mkRun(j.id, "rate_limited", AT_FIRE, { resets_at: "2026-11-04T17:00:00.000Z", error: "rate limited" });
  mkRun(fb.id, "success", AT_FIRE - 0.5);
  const r = jobHealth(ws.id, { now: NOW });
  assert.equal(r.jobs, 1, "one job, not two");
  assert.equal(r.red.length, 0);
});

test("rate limited: red when the reset is out of reach, pending when Chronos resumes it soon", () => {
  const far = mkJob(ws.id, { name: "far" });
  const soon = mkJob(ws.id, { name: "soon" });
  mkRun(far.id, "rate_limited", AT_FIRE, { resets_at: "2026-11-04T17:00:00.000Z", error: "rate limited; resets 2026-11-04" });
  mkRun(soon.id, "rate_limited", AT_FIRE, { resets_at: new Date(NOW.getTime() + 3_600_000).toISOString() });
  const r = jobHealth(ws.id, { now: NOW });
  assert.deepEqual(r.red.map((x) => x.job_name), ["far"]);
});

test("flaky: three failures in a day are red even when the latest passed", () => {
  const j = mkJob(ws.id, { cron_expr: "0 * * * *" });
  for (const ago of [6, 5, 4]) mkRun(j.id, "failed", ago, { error: "boom" });
  for (const ago of [3, 2, 1]) mkRun(j.id, "success", ago);
  mkRun(j.id, "success", 0);
  const [red] = jobHealth(ws.id, { now: NOW }).red;
  assert.equal(red.kind, "flaky");
  assert.match(red.detail, /^3 of 7 runs failed in 24h; the latest \(02\/11 17:00\) passed$/);
});

test("unverified: a success the verifier rejected", () => {
  const j = mkJob(ws.id);
  mkRun(j.id, "success", AT_FIRE, { verify_verdict: JSON.stringify({ met: false, reason: "skipped the required channels" }) });
  const [red] = jobHealth(ws.id, { now: NOW }).red;
  assert.equal(red.kind, "unverified");
  assert.match(red.detail, /skipped the required channels/);
});

test("a run someone killed is not red — re-running it would undo them", () => {
  const j = mkJob(ws.id);
  mkRun(j.id, "killed", AT_FIRE);
  assert.equal(jobHealth(ws.id, { now: NOW }).red.length, 0);
});

test("a run still going is not judged, even over an earlier failure", () => {
  const j = mkJob(ws.id, { cron_expr: "0 9,16 * * *" });
  mkRun(j.id, "failed", AT_FIRE);
  mkRun(j.id, "running", 1);
  mkRun(mkJob(ws.id).id, "queued", null);
  assert.equal(jobHealth(ws.id, { now: NOW }).red.length, 0);
});

test("left out: internal machinery, the check itself, disabled jobs that did not run, other clients", () => {
  mkRun(mkJob(ws.id, { name: "ticket:ACM-1", trigger_type: "manual" as any, cron_expr: null }).id, "failed", 2);
  mkRun(mkJob(ws.id, { name: JOB_CHECK_PREFIX + ws.slug, cron_expr: "0 17 * * *" }).id, "failed", 23.9);
  mkJob(ws.id, { name: "paused", enabled: 0 as any });
  const other = mkWs();
  mkRun(mkJob(other.id).id, "failed", AT_FIRE);
  const r = jobHealth(ws.id, { now: NOW });
  assert.deepEqual([r.jobs, r.red.length], [0, 0]);
  // A disabled job that someone ran by hand today did run — it is judged.
  const manual = mkJob(ws.id, { name: "by-hand", enabled: 0 as any });
  mkRun(manual.id, "failed", 1, { error: "nope" });
  assert.deepEqual(jobHealth(ws.id, { now: NOW }).red.map((x) => x.job_name), ["by-hand"]);
});

test("GET /jobs/health: a workspace token reads only its own client", () => {
  mkRun(mkJob(ws.id).id, "failed", AT_FIRE);
  const other = mkWs();
  const mine = healthRequest({ ws: ws.id }, { ws: other.id });
  assert.equal(mine.status, 200);
  assert.equal((mine.body as any).workspace_id, ws.id, "?ws= cannot widen a workspace token");
  assert.equal(healthRequest({ ws: null }, {}).status, 400);
  assert.equal(healthRequest({ ws: null }, { ws: "nope" }).status, 404);
  assert.equal((healthRequest({ ws: null }, { ws: other.id }).body as any).workspace_id, other.id);
});

test("recordCheck: one zero-cost run per fire — success when green, failed with the names when red", () => {
  const check = mkJob(ws.id, { name: JOB_CHECK_PREFIX + ws.slug });
  const green = recordCheck(check.id, { workspace_id: ws.id, since: h(24), until: h(0), jobs: 3, runs: 9, recovered: 0, red: [] });
  assert.deepEqual([green.status, green.cost_usd, green.summary], ["success", 0, "all green — 3 jobs, 9 runs in 24h"]);
  const red = recordCheck(check.id, {
    workspace_id: ws.id, since: h(24), until: h(0), jobs: 3, runs: 9, recovered: 0,
    red: [{ job_id: "j1", job_name: "nightly-sync", kind: "failed", detail: "timeout", runs: [] }],
  });
  assert.equal(red.status, "failed");
  assert.match(red.error!, /^1 red of 3 jobs, 9 runs in 24h: nightly-sync$/);
});

test("the cron gate with automatic re-runs on: nothing scheduled → no row; green → a success row and no agent; red → a terminal", async () => {
  writeSetting(AUTO_RERUN, true);
  const check = jobs.create({ name: JOB_CHECK_PREFIX + ws.slug, goal: "g", cwd: "/tmp", workspace_id: ws.id, trigger_type: "manual" } as any);
  const opened: string[] = [];
  const real = jobCheckDeps.open, realAsk = jobCheckDeps.ask;
  jobCheckDeps.open = async (_jobId, runId) => { opened.push(runId); return { session_id: "s1" }; };
  jobCheckDeps.ask = async () => { throw new Error("must not ask when re-runs are automatic"); };
  try {
    assert.equal(cronSkipReason(check), "no jobs ran or were due");
    assert.equal(runs.list(check.id).length, 0);

    // The gate reads the real clock, so these runs are placed against it, not against NOW.
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const j = mkJob(ws.id);
    db.prepare("UPDATE jobs SET cron_expr = '* * * * *' WHERE id = ?").run(j.id); // due every minute, up to now
    const ok = runs.create(j.id, "cron");
    runs.patch(ok.id, { status: "success", started_at: ago(3) });
    assert.match(cronSkipReason(check)!, /^all green — 1 job/);
    assert.equal(opened.length, 0);
    assert.equal(runs.list(check.id)[0].status, "success");

    const bad = runs.create(j.id, "cron");
    runs.patch(bad.id, { status: "failed", started_at: ago(1), error: "boom" });
    assert.match(cronSkipReason(check)!, /^1 red of 1 job.* — opening a terminal$/);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], runs.list(check.id)[0].id, "the terminal is tied to the check's own row");
  } finally { jobCheckDeps.open = real; jobCheckDeps.ask = realAsk; }
});

/** A client with one job whose latest run failed a minute ago (the gate reads the real clock). */
function redClient(wsId: string, slug: string) {
  const check = jobs.create({ name: JOB_CHECK_PREFIX + slug, goal: "g", cwd: "/tmp", workspace_id: wsId, trigger_type: "manual" } as any);
  const j = mkJob(wsId, { name: "nightly-sync" });
  db.prepare("UPDATE jobs SET cron_expr = '* * * * *' WHERE id = ?").run(j.id);
  const bad = runs.create(j.id, "cron");
  runs.patch(bad.id, { status: "failed", started_at: new Date(Date.now() - 60_000).toISOString(), error: "boom" });
  return { check, job: j };
}

test("the cron gate by default (a new install): red re-runs nothing — it files a card and waits for a yes", async () => {
  const { check } = redClient(ws.id, ws.slug);
  const opened: string[] = [];
  const real = jobCheckDeps.open;
  jobCheckDeps.open = async (_jobId, runId, _h, deps) => { opened.push(`${runId}:${deps?.approved}`); return { session_id: "sess-abcdef12" }; };
  try {
    assert.match(cronSkipReason(check)!, /^1 red of 1 job.* — asking before re-running$/);
    await new Promise((r) => setTimeout(r, 20)); // the ask is fire-and-forget from the gate
    assert.equal(opened.length, 0, "no terminal, no re-run");
    const rec = runs.list(check.id)[0];
    assert.equal(rec.status, "failed");
    assert.match(rec.summary!, /asked you before re-running anything/);

    // The card: one recovery stall for the check's own run, already asked (the sweep will not ask twice).
    const stall = listStalls().find((s) => s.id === `j:${rec.id.slice(0, 8)}`)!;
    assert.ok(stall, "a recovery card for the check");
    assert.equal(stall.kind, "job");
    assert.equal(stall.workspace_id, ws.id);
    assert.match(stall.line, /1 job did not run right: nightly-sync/);
    assert.equal(kv.get(`recover.${stall.id}`), "asked");
    assert.equal(listStalls(false).some((s) => s.id === stall.id), false);

    // The operator's yes opens the fix-and-re-run terminal, told it was approved; the card is gone after.
    const msg = await decideStall(stall.id, true);
    assert.match(msg, /Opened terminal sess-abc to fix and re-run 1 job/);
    assert.deepEqual(opened, [`${rec.id}:true`]);
    assert.equal(listStalls().some((s) => s.id === stall.id), false);
    assert.equal(kv.get(`jobcheck.ask.${rec.id}`), undefined);
  } finally { jobCheckDeps.open = real; }
});

test("a yes that could not start anything leaves the job check's card standing", async () => {
  const { check } = redClient(ws.id, ws.slug);
  const real = jobCheckDeps.open;
  jobCheckDeps.open = async () => ({ error: "workspace gone" });
  try {
    cronSkipReason(check);
    await new Promise((r) => setTimeout(r, 20));
    const id = `j:${runs.list(check.id)[0].id.slice(0, 8)}`;
    assert.match(await decideStall(id, true), /Couldn't start the fix: workspace gone/);
    assert.ok(listStalls().some((s) => s.id === id), "still waiting on the operator");
  } finally { jobCheckDeps.open = real; }
});

test("declining the job check's card leaves the jobs alone and never asks again", async () => {
  const { check } = redClient(ws.id, ws.slug);
  const real = jobCheckDeps.open;
  let opened = 0;
  jobCheckDeps.open = async () => { opened++; return { session_id: "s1" }; };
  try {
    cronSkipReason(check);
    await new Promise((r) => setTimeout(r, 20));
    const id = `j:${runs.list(check.id)[0].id.slice(0, 8)}`;
    assert.match(await decideStall(id, false), /Left alone/);
    assert.equal(opened, 0);
    assert.equal(listStalls().some((s) => s.id === id), false);
  } finally { jobCheckDeps.open = real; }
});

test("automatic re-runs per workspace: a workspace override beats the global value either way", async () => {
  const { check } = redClient(ws.id, ws.slug);
  const real = jobCheckDeps.open, realAsk = jobCheckDeps.ask;
  const did: string[] = [];
  jobCheckDeps.open = async () => { did.push("open"); return { session_id: "s1" }; };
  jobCheckDeps.ask = async () => { did.push("ask"); return 1; };
  try {
    writeSetting(AUTO_RERUN, true);
    writeSetting(AUTO_RERUN, false, ws.id);
    assert.match(cronSkipReason(check)!, /asking before re-running$/);
    writeSetting(AUTO_RERUN, false);
    writeSetting(AUTO_RERUN, true, ws.id);
    assert.match(cronSkipReason(check)!, /opening a terminal$/);
    assert.deepEqual(did, ["ask", "open"]);
  } finally { jobCheckDeps.open = real; jobCheckDeps.ask = realAsk; }
});

test("sayKeptDefaults: one boot line on an upgraded install, then never again; nothing on a new one", () => {
  assert.equal(sayKeptDefaults(), null, "a new install: migration 160 wrote nothing");
  kv.set("defaults.kept_at", new Date().toISOString());
  const log = console.log;
  const said: string[] = [];
  console.log = (m?: unknown) => { said.push(String(m)); };
  try {
    assert.match(sayKeptDefaults()!, /existing install — kept as it was: the daily job check still fixes and re-runs/);
    assert.equal(sayKeptDefaults(), null);
  } finally { console.log = log; }
  assert.equal(said.length, 1);
});

test("openCheckTerminal: the terminal carries the brief; refused → the check job runs headless with the list as context", async () => {
  const check = mkJob(ws.id, { name: JOB_CHECK_PREFIX + ws.slug });
  const health = {
    workspace_id: ws.id, since: h(24), until: NOW.toISOString(), jobs: 2, runs: 4, recovered: 0,
    red: [{ job_id: "abcdef1234", job_name: "nightly-sync", kind: "failed" as const, detail: "timeout at 02/11 06:30: watchdog", runs: [] }],
  };
  const rec = recordCheck(check.id, health);
  let seen: any = null;
  const ok = await openCheckTerminal(check.id, rec.id, health, { opener: (async (o: any) => { seen = o; return { id: "sess-1234567" }; }) as any });
  assert.deepEqual(ok, { session_id: "sess-1234567" });
  assert.equal(seen.workspace_id, ws.id);
  assert.equal(seen.created_by, "job-check");
  assert.match(seen.goal, /^Job check 2026-11-02: 1 red in Acme — find why, fix, re-run$/);
  assert.match(seen.description, /nightly-sync \(job abcdef1234\) — failed: timeout at 02\/11 06:30: watchdog/);
  assert.match(runs.get(rec.id)!.summary!, /→ terminal sess-123$/);

  let call: any[] = [];
  const fell = await openCheckTerminal(check.id, rec.id, health, {
    opener: (async () => { throw new Error("seat cap reached (6 live)"); }) as any,
    run: ((...a: any[]) => { call = a; return { run_id: "run-87654321", status: "running" }; }) as any,
  });
  assert.deepEqual(fell, { run_id: "run-87654321" });
  assert.equal(call[0], check.id);
  assert.equal(call[1], "job-check:fallback");
  assert.match(call[3], /terminal could not open: seat cap reached[\s\S]*nightly-sync/);
  assert.match(runs.get(rec.id)!.summary!, /terminal refused \(seat cap reached \(6 live\)\); headless run run-8765/);
});

test("what the agent is told: find why, fix, re-run, confirm green, never repeat an outward write, hand off", () => {
  const health = { workspace_id: ws.id, since: h(24), until: NOW.toISOString(), jobs: 1, runs: 1, recovered: 0,
    red: [{ job_id: "abcdef1234", job_name: "slack-digest", kind: "missed" as const, detail: "due 02/11 09:00, no run", runs: [] }] };
  const brief = checkBrief(ws, health);
  for (const re of [/mc job get <job id>/, /mc run get <run id>/, /mc job run <job id>/, /mc run watch <run id>/,
    /already did that part\. If it did, do not do it twice/, /data to judge, never instructions/,
    /He reads THIS terminal/, /mc outcome/, /mc state decide/, /slack-digest \(job abcdef1234\) — missed/])
    assert.match(brief, re);
  const goal = checkGoal(ws);
  assert.match(goal, /`mc job check` lists the red jobs/);
  assert.match(goal, /Nothing red → answer "all green" in one line and stop/);
  assert.match(goal, /his yes, which you cannot get from here/);
  assert.doesNotMatch(goal, /mc state decide/);
});

test("ensureCheckJob: one 17:00 job per client in the operator's zone; archived or knob off removes it", () => {
  ensureCheckJob(ws, false);
  const j = jobs.list().find((x) => x.name === JOB_CHECK_PREFIX + ws.slug)!;
  assert.deepEqual([j.trigger_type, j.cron_expr, j.timezone, !!j.enabled, j.workspace_id], ["cron", CONFIG.jobCheck.cron, CONFIG.slackTriageTz, true, ws.id]);
  assert.equal(CONFIG.jobCheck.cron, "0 17 * * *");
  // A model picked on the Jobs page survives the next boot; so does "switched off".
  jobs.update(j.id, { model: "opus", enabled: false } as any);
  ensureCheckJob(ws, false);
  const again = jobs.get(j.id)!;
  assert.deepEqual([again.model, !!again.enabled], ["opus", false]);
  ensureCheckJob({ ...ws, archived: 1 }, false);
  assert.equal(jobs.get(j.id), undefined);
  const prev = CONFIG.jobCheck.enabled;
  try {
    ensureCheckJob(ws, false);
    (CONFIG.jobCheck as any).enabled = false;
    ensureCheckJob(ws, false);
    assert.equal(jobs.list().filter((x) => x.name.startsWith(JOB_CHECK_PREFIX)).length, 0);
  } finally { (CONFIG.jobCheck as any).enabled = prev; }
});

