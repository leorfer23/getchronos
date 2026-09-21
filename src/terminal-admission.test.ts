/**
 * The spawn-admission half of the machine governor (src/machine.ts): an AGENT may not open a Desk
 * terminal onto a saturated Mac; the operator always may.
 *
 * Nothing here spawns: the refusal is thrown in openSession's prologue, before the row, the profile
 * or the pty. The operator's path is proved by the error it gets INSTEAD — the workspace seat cap,
 * the very next guard — so this asserts that admission was skipped without letting a CLI start.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { setLoadProbe, type MachineLoad } from "./machine.js";
import { workspaces } from "./store.js";
import { openSession } from "./terminal.js";

const SATURATED: MachineLoad = { load1: 34.1, ncpu: 12, loadPerCore: 34.1 / 12, swapUsedMb: 12902, swapTotalMb: 13312, pressureLevel: 4 };
// Calm, but with the swapfile mostly full — the resting state of a healthy Mac, which must admit.
const QUIET: MachineLoad = { load1: 1.2, ncpu: 12, loadPerCore: 0.1, swapUsedMb: 12902, swapTotalMb: 13312, pressureLevel: 1 };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-admission-"));
let wsId: string;
const capWas = CONFIG.maxSessionsPerWorkspace;

beforeEach(() => {
  const ws = workspaces.create({ slug: `adm-${Math.random().toString(36).slice(2, 8)}`, name: "Admission", config_dir: tmp, sandbox_mode: "off" } as any);
  wsId = ws.id;
  CONFIG.maxSessionsPerWorkspace = capWas;
});
after(() => {
  setLoadProbe(null);
  CONFIG.maxSessionsPerWorkspace = capWas;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("an agent-opened terminal is refused on a saturated machine, with the numbers in the message", async () => {
  setLoadProbe(() => SATURATED);
  await assert.rejects(
    () => openSession({ workspace_id: wsId, backend: "claude-code", created_by: "robert", goal: "fix the flaky test" } as any),
    (e: Error) => {
      assert.match(e.message, /^machine saturated — /);
      assert.match(e.message, /load 34\.1 on 12 cores/);
      assert.match(e.message, /memory pressure critical \(swap 97% used\)/);
      return true;
    },
  );
});

test("a Lead's worker is an agent too", async () => {
  setLoadProbe(() => SATURATED);
  await assert.rejects(
    () => openSession({ workspace_id: wsId, backend: "claude-code", created_by: "lead:1a2b3c4d" } as any),
    /^Error: machine saturated — /,
  );
});

test("the operator is never refused — he reaches the next guard instead", async () => {
  setLoadProbe(() => SATURATED);
  // Zero seats: the workspace cap throws for anyone who gets past admission. That it is THIS error,
  // and not "machine saturated", is the proof the operator was let through.
  CONFIG.maxSessionsPerWorkspace = 0;
  for (const created_by of ["operator", undefined]) {
    await assert.rejects(
      () => openSession({ workspace_id: wsId, backend: "claude-code", created_by } as any),
      /workspace session cap reached/,
    );
  }
});

// Regression: the first cut of this gate refused the failover stand-in, and a walled terminal on a
// busy Mac had nowhere to hand its work to (src/terminal-failover.ts opens with created_by
// "failover"). A `replaces` open is a swap, not an extra process.
test("a failover stand-in is never refused — it replaces a terminal, it does not add one", async () => {
  setLoadProbe(() => SATURATED);
  CONFIG.maxSessionsPerWorkspace = 0;
  await assert.rejects(
    () => openSession({ workspace_id: wsId, backend: "claude-code", created_by: "failover", replaces: "some-live-id" } as any),
    /workspace session cap reached/,
  );
});

test("on a quiet machine the agent gets past admission too", async () => {
  setLoadProbe(() => QUIET);
  CONFIG.maxSessionsPerWorkspace = 0;
  await assert.rejects(
    () => openSession({ workspace_id: wsId, backend: "claude-code", created_by: "robert" } as any),
    /workspace session cap reached/,
  );
});
