import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { jobs, runs, workspaces } from "./store.js";
import { resetBrainAwake } from "./brain-awake.js";
import { setExecutor } from "./dispatcher.js";
import { fireCronWhenAwake, lastCronSkip } from "./scheduler.js";
import { _resetUsage, noteClaudeStatusline } from "./usage-meter.js";
import type { RunStatus } from "./types.js";

// A daily cron job on an account whose 5-hour window is 90% spent: the fire is a deliberate skip, no
// run starts, and the job runs once just after the reset — not tomorrow.
const T0 = Date.parse("2026-11-17T15:05:00.000Z");
const RESET = T0 + 3_600_000;

afterEach(() => {
  mock.timers.reset();
  resetBrainAwake();
  setExecutor(null);
  _resetUsage();
});

test("a cron fire past the reserve line is held, recorded as a gate skip, and runs once after the reset", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ bootAt: T0 - 86_400_000, lastWake: () => T0 - 3_600_000 });
  const started: string[] = [];
  setExecutor(async (job): Promise<RunStatus> => { started.push(job.name); return "success"; });
  const dir = `/tmp/.claude-hold-${randomUUID().slice(0, 6)}`;
  const ws = workspaces.create({ slug: "hold-" + randomUUID().slice(0, 6), name: "Hold", config_dir: dir, default_backend: "claude-code" } as any);
  noteClaudeStatusline(dir, { five_hour: { used_percentage: 90, resets_at: RESET / 1000 } });
  const job = jobs.create({
    name: "monitor:hold-test", goal: "check", cwd: "/tmp", trigger_type: "cron", timezone: "UTC", enabled: true,
    cron_expr: "3 15 * * *", workspace_id: ws.id, backend: "claude-code",
  } as any);

  fireCronWhenAwake(job);
  assert.equal(runs.list(job.id, 5).length, 0, "no run while held");
  const skip = lastCronSkip(job.id);
  assert.equal(skip?.kind, "gate", "a deliberate skip — the job check must not open a terminal over it");
  assert.match(skip!.why, /90% of its 5-hour window/);

  mock.timers.tick(RESET - T0 + 89_000);
  assert.equal(runs.list(job.id, 5).length, 0, "not before the reset has rolled over");
  mock.timers.tick(2_000);
  assert.equal(runs.list(job.id, 5).length, 1, "one run, right after the reset");
  assert.deepEqual(started, ["monitor:hold-test"]);
});

test("a cron fire under the reserve line runs as before", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  resetBrainAwake({ bootAt: T0 - 86_400_000, lastWake: () => T0 - 3_600_000 });
  setExecutor(async (): Promise<RunStatus> => "success");
  const dir = `/tmp/.claude-hold-${randomUUID().slice(0, 6)}`;
  const ws = workspaces.create({ slug: "hold-" + randomUUID().slice(0, 6), name: "Hold", config_dir: dir, default_backend: "claude-code" } as any);
  noteClaudeStatusline(dir, { five_hour: { used_percentage: 40, resets_at: RESET / 1000 } });
  const job = jobs.create({
    name: "monitor:open-test", goal: "check", cwd: "/tmp", trigger_type: "cron", timezone: "UTC", enabled: true,
    cron_expr: "3 15 * * *", workspace_id: ws.id, backend: "claude-code",
  } as any);
  fireCronWhenAwake(job);
  assert.equal(runs.list(job.id, 5).length, 1);
});
