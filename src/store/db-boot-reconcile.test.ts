/**
 * db.ts's startup reconciliation (module-level, runs once per process on `import "./db.js"`) marks
 * every run still 'running'/'queued' `interrupted` — EXCEPT a cloud run, whose process lives on the
 * provider's VM and did not die with the daemon (see the comment next to that query). That exclusion
 * is the one line standing between this rollout and "a cloud run survives a restart" being false, so
 * it gets its own guard: spawn two fresh processes against the same on-disk DB (the reconciliation
 * only fires at import time, so it can't be re-triggered inside one process) — the first seeds a
 * local run and a cloud run both 'running', the second imports the store fresh (the boot sweep) and
 * reports back what each run's status became.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-boot-reconcile-"));
const dbPath = path.join(dir, "test.db");

const SEED = `
import { jobs, runs } from "${path.join(process.cwd(), "src/store.js")}";
const job = jobs.create({ name: "seed", goal: "g", cwd: "${dir}", sandbox: "off", backend: "mock", retry_max: 0 });
const local = runs.create(job.id, "test");
runs.patch(local.id, { status: "running", started_at: new Date().toISOString() });
const cloud = runs.create(job.id, "test");
runs.patch(cloud.id, { status: "running", started_at: new Date().toISOString(), cloud_agent_id: "bc-1", cloud_run_id: "run-1" });
console.log(JSON.stringify({ localId: local.id, cloudId: cloud.id }));
`;

const READBACK = `
import { runs } from "${path.join(process.cwd(), "src/store.js")}";
const ids = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  local: runs.get(ids.localId)?.status,
  cloud: runs.get(ids.cloudId)?.status,
}));
`;

function run(script: string, args: string[] = []): string {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, script);
  return execFileSync("node", ["--import", "tsx", file, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CHRONOS_DB: dbPath, CHRONOS_TEST: "1" },
    encoding: "utf8",
  });
}

test("boot reconciliation: a local run is marked interrupted, a cloud run is left running", () => {
  const seedOut = run(SEED);
  const ids = JSON.parse(seedOut.trim().split("\n").pop()!);

  // A fresh process importing the store is exactly what a daemon restart does — db.ts's
  // reconciliation runs once, at import time, in this new process.
  const readOut = run(READBACK, [JSON.stringify(ids)]);
  const statuses = JSON.parse(readOut.trim().split("\n").pop()!);

  assert.equal(statuses.local, "interrupted", "a local run's process died with the daemon — reconciled");
  assert.equal(statuses.cloud, "running", "a cloud run's process lives on the provider's VM — untouched");
});
