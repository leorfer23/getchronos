import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, events, jobs, runs, workspaces } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { steerRun } from "./runner.js";
import { sendMessage } from "./messages.js";
import { claudeBackend } from "./backends/claude.js";
import { PatchWorkspaceSchema } from "./validation.js";
import type { Job, NewJob } from "./types.js";

// End-to-end steering through the REAL execute(): a live_steer workspace + the mock backend's
// stream-json child. Same hygiene rules as execute.test.ts — sandbox off, tmp cwd, retry_max 0,
// nothing that leaves a live timer.

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-steer-"));
let n = 0;
const mkWs = () =>
  workspaces.create({ slug: `steer-${n++}`, name: "SteerWS", config_dir: "/tmp/steer-cfg", live_steer: true });
const mkJob = (goal: string, over: Partial<NewJob> = {}): Job =>
  jobs.create({ name: `steer${n++}`, goal, cwd, sandbox: "off", backend: "mock", retry_max: 0, ...over });

async function finished(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runs.get(runId)!;
    if (r.status !== "queued" && r.status !== "running") return r;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${r.status} after ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM run_messages; DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces;");
});

test("claude steerArgs: streaming input flags, no goal in argv, same tail as buildArgs", () => {
  const job = { goal: "secret goal", model: "sonnet", allowed_tools: "Read,Bash", max_budget_usd: 2 } as any;
  const steer = claudeBackend.steerArgs!(job, "sess-1");
  assert.ok(steer.includes("--input-format") && steer[steer.indexOf("--input-format") + 1] === "stream-json");
  assert.ok(!steer.includes("secret goal"));
  assert.ok(steer.includes("--session-id") && steer[steer.indexOf("--session-id") + 1] === "sess-1");
  const resumed = claudeBackend.steerArgs!(job, "sess-1", "old-sess");
  assert.ok(resumed.includes("--resume") && !resumed.includes("--session-id"));
  const build = claudeBackend.buildArgs(job, "sess-1", null);
  for (const flag of ["--allowed-tools", "--model", "--max-budget-usd", "--dangerously-skip-permissions"])
    assert.ok(steer.includes(flag) === build.includes(flag), flag);
  const line = JSON.parse(claudeBackend.encodeSteer!("hello"));
  assert.equal(line.type, "user");
  assert.equal(line.message.content[0].text, "hello");
});

test("steer mode: goal over stdin, mid-run steer echoed by the child, per-turn results accumulate", async () => {
  const ws = mkWs();
  const job = mkJob("do the thing\n!sleep: 500", { workspace_id: ws.id });
  const r = dispatch(job.id, "test");
  assert.ok(!("error" in r));
  const runId = (r as any).run_id;
  assert.equal(runs.get(runId)!.status, "running");

  assert.equal(steerRun(runId, "also bump the version", "leo"), true);
  const done = await finished(runId);
  assert.equal(done.status, "success");
  assert.equal(done.cost_usd, 0.02); // claude reports cumulative usage per result; two turns ran

  const types = events.list(runId).map((e) => e.type);
  assert.ok(types.includes("steer"), "operator steer recorded in the event log");
  assert.ok(types.includes("steer_echo"), "child actually received the steer over stdin");
  assert.equal(types.filter((t) => t === "result").length, 2);
});

test("steerRun refuses runs that are not live-steerable", async () => {
  const job = mkJob("plain run"); // no workspace → no live_steer → classic buildArgs path
  const r = dispatch(job.id, "test");
  const runId = (r as any).run_id;
  assert.equal(steerRun(runId, "nope", "leo"), false);
  await finished(runId);
  assert.equal(steerRun("no-such-run", "nope", "leo"), false);
});

test("sendMessage delivers live to a steer-mode run and marks the mailbox row delivered", async () => {
  const ws = mkWs();
  const job = mkJob("work away\n!sleep: 500", { workspace_id: ws.id });
  const runId = (dispatch(job.id, "test") as any).run_id;

  const out = sendMessage(runId, "change of plan", "leo");
  assert.ok(out.ok);
  assert.equal(out.ok && out.steered, true);
  const row = db.prepare("SELECT delivered_to_run FROM run_messages WHERE id = ?").get(out.ok ? out.message.id : 0) as any;
  assert.equal(row.delivered_to_run, runId);
  await finished(runId);
});

test("sendMessage falls back to the mailbox when the run has ended", async () => {
  const ws = mkWs();
  const job = mkJob("quick", { workspace_id: ws.id });
  const runId = (dispatch(job.id, "test") as any).run_id;
  await finished(runId);

  const out = sendMessage(runId, "too late for live delivery", "leo");
  assert.ok(out.ok);
  assert.equal(out.ok && out.steered, false);
  const row = db.prepare("SELECT delivered_to_run FROM run_messages WHERE id = ?").get(out.ok ? out.message.id : 0) as any;
  assert.equal(row.delivered_to_run, null);
});

test("a steer the run never answered is returned to the mailbox, not silently lost", async () => {
  // The run is killed while the steer sits unprocessed in the CLI's input queue. Marking it
  // delivered optimistically must not strand the operator's directive.
  const ws = mkWs();
  const job = mkJob("long work\n!sleep: 3000", { workspace_id: ws.id, timeout_sec: 1 });
  const runId = (dispatch(job.id, "test") as any).run_id;

  const out = sendMessage(runId, "urgent change", "leo");
  assert.ok(out.ok && out.steered, "steer accepted while the run was live");
  const id = out.ok ? out.message.id : 0;
  assert.equal((db.prepare("SELECT delivered_to_run d FROM run_messages WHERE id = ?").get(id) as any).d, runId);

  const done = await finished(runId, 15_000); // watchdog kills it at timeout_sec
  assert.equal(done.status, "timeout");
  const row = db.prepare("SELECT delivered_to_run d, delivered_at a FROM run_messages WHERE id = ?").get(id) as any;
  assert.equal(row.d, null, "delivery reverted so the next dispatch re-injects it");
  assert.equal(row.a, null);
});

test("live_steer round-trips through store and API schema", () => {
  const ws = workspaces.create({ slug: "steer-schema", name: "s", config_dir: "/tmp/c", live_steer: true });
  assert.equal(ws.live_steer, 1);
  assert.equal(workspaces.update(ws.id, { live_steer: false })!.live_steer, 0);
  assert.equal(PatchWorkspaceSchema.parse({ live_steer: true }).live_steer, true);
});
