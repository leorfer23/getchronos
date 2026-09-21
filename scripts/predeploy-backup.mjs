#!/usr/bin/env node
// Pre-deploy snapshot of the live DB, kept machine-portable.
//
// The old inline `cp chronos.db backups/...` assumed the DB sat in the repo root — true only when
// the checkout IS ~/chronos. Resolve it the same way src/config.ts does instead, so a checkout
// anywhere (and a CHRONOS_DB override) still gets backed up rather than failing the deploy chain.
//
// A missing DB is not an error: a fresh machine has nothing to snapshot yet, and the deploy
// should proceed to build + restart, which is what creates it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEEP = Number(process.env.CHRONOS_BACKUP_KEEP ?? 5);
const dbPath = process.env.CHRONOS_DB ?? path.join(os.homedir(), "chronos", "chronos.db");

if (dbPath === ":memory:" || !fs.existsSync(dbPath)) {
  console.log(`[predeploy] no db at ${dbPath} — nothing to back up (fresh machine?)`);
  process.exit(0);
}

const backupDir = path.join(import.meta.dirname, "..", "backups");
fs.mkdirSync(backupDir, { recursive: true });

// Local time, filename-safe: 20260731-142600.
const now = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const stamp =
  `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-` +
  `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const dest = path.join(backupDir, `predeploy-${stamp}.db`);

// Copy through SQLite's backup API rather than cp(1): the daemon is live and mid-write, so a
// byte copy can land a torn page whose -wal/-shm siblings we did not copy. This produces a
// single self-consistent file. Falls back to cp semantics if better-sqlite3 is unavailable
// (e.g. deps not yet installed) — a possibly-torn backup beats no backup.
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  await db.backup(dest);
  db.close();
} catch (err) {
  console.warn(`[predeploy] sqlite backup unavailable (${err.message}); falling back to file copy`);
  fs.copyFileSync(dbPath, dest);
}

const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
console.log(`[predeploy] backed up ${dbPath} → ${path.relative(process.cwd(), dest)} (${mb} MB)`);

// Prune oldest, keeping the newest KEEP snapshots.
const stale = fs
  .readdirSync(backupDir)
  .filter((f) => f.startsWith("predeploy-") && f.endsWith(".db"))
  .sort()
  .reverse()
  .slice(KEEP);
for (const f of stale) fs.rmSync(path.join(backupDir, f), { force: true });
if (stale.length) console.log(`[predeploy] pruned ${stale.length} old backup(s), keeping ${KEEP}`);
