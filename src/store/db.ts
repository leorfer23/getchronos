import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CONFIG } from "../config.js";
import { migrate } from "./migrate.js";
import { now } from "./util.js";

// GUARDRAIL — never let the test suite touch a real database.
// Test files mass-DELETE tables (workspaces/tickets/...) in beforeEach and rely SOLELY on
// CHRONOS_DB=:memory:. If that env fails to propagate (e.g. a nested `npm run` in the deploy chain),
// the suite runs against the prod DB and wipes it. Detect the node test runner and refuse to open
// any DB that isn't in-memory or a throwaway /tmp path — fail loud instead of destroying data.
// Detects `node --test` (the suite), CHRONOS_TEST=1, AND any other runner someone reaches for.
// That last clause is not hypothetical: an agent ran `npx vitest` in a worktree, every check above
// was false, CHRONOS_DB was unset — so it opened the PRODUCTION database and applied two unreleased
// migrations to it while three of the operator's terminals were live. Any file named *.test.* on
// the command line means a test run, whatever binary is executing it.
const underTest =
  process.env.NODE_TEST_CONTEXT != null ||
  process.env.CHRONOS_TEST === "1" ||
  process.env.VITEST != null ||
  process.env.JEST_WORKER_ID != null ||
  process.execArgv.some((a) => a === "--test" || a.startsWith("--test=")) ||
  process.argv.some((a) => a === "--test") ||
  process.argv.some((a) => /(^|[/\\])vitest([/\\]|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(a));
const dbIsThrowaway =
  CONFIG.dbPath === ":memory:" ||
  CONFIG.dbPath.startsWith("/tmp/") ||
  CONFIG.dbPath.startsWith(path.join(os.tmpdir(), ""));
if (underTest && !dbIsThrowaway) {
  throw new Error(
    `[store] REFUSING to open a real database under the test runner: ${CONFIG.dbPath}\n` +
      `Tests mass-delete tables — set CHRONOS_DB=:memory:. This guard exists because a deploy once ` +
      `ran the suite against production and wiped it.`,
  );
}

fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true, mode: 0o700 });

export const db = new Database(CONFIG.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// NORMAL is safe (not just fast) under WAL: a crash can lose the last commit but never corrupts the
// db, and WAL already fsyncs on checkpoint. Many processes (daemon + dispatched agents + terminals)
// hit this file concurrently — busy_timeout makes a writer retry instead of throwing SQLITE_BUSY.
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
// Owner-only perms on the live DB (and WAL/SHM sidecars) — holds tickets, secrets paths, notes.
if (CONFIG.dbPath !== ":memory:") {
  for (const p of [CONFIG.dbPath, CONFIG.dbPath + "-wal", CONFIG.dbPath + "-shm"]) {
    try { fs.chmodSync(p, 0o600); } catch {}
  }
}

migrate(db);

// Startup reconciliation: any run still 'running'/'queued' was orphaned by a daemon stop/crash
// (its child process is gone and the in-memory queue is empty). Mark them so they don't hang forever.
//
// Cloud runs (cloud_agent_id set) are excluded on purpose: this reconciliation exists because a
// LOCAL run's child process dies with the daemon. A cloud run's process did NOT die — it is still
// working on the provider's VM — so marking it interrupted here would be factually wrong, not just
// inconvenient, and would undo the whole point of the cloud backend (survive the Mac sleeping or the
// daemon being off). cloud-reconcile.ts (started later, in index.ts) picks those back up instead.
{
  const orphans = db
    .prepare("SELECT id FROM runs WHERE status IN ('running','queued') AND cloud_agent_id IS NULL")
    .all() as Array<{ id: string }>;
  if (orphans.length) {
    db.prepare(
      "UPDATE runs SET status='interrupted', ended_at=?, error=COALESCE(error,'daemon restarted while run was active') WHERE status IN ('running','queued') AND cloud_agent_id IS NULL"
    ).run(now());
    console.log(`[chronos] reconciled ${orphans.length} orphaned run(s) → interrupted`);
  }
}
