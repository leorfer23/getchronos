import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, events, searchIndex, egressLog, jobs, runs } from "./store.js";

const runEventCount = () => (db.prepare("SELECT COUNT(*) c FROM run_events").get() as { c: number }).c;
const ftsEventRefs = () =>
  (db.prepare("SELECT ref_id FROM search_fts WHERE kind = 'event' ORDER BY ref_id").all() as Array<{ ref_id: string }>).map((r) => r.ref_id);
const egressCount = () => (db.prepare("SELECT COUNT(*) c FROM egress_log").get() as { c: number }).c;

// run_events.run_id is a real FK (ON DELETE CASCADE) — needs an actual runs row to insert against.
const mkRun = () => runs.create(jobs.create({ name: "test", goal: "g" }).id, "manual").id;

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM search_fts; DELETE FROM egress_log; DELETE FROM runs; DELETE FROM jobs;");
});

test("events.prune keeps only the last N rows by insertion order", () => {
  const runIds = Array.from({ length: 6 }, mkRun);
  for (const id of runIds) db.prepare("INSERT INTO run_events (run_id,ts,type,payload) VALUES (?,?,?,?)").run(id, "t", "assistant", "{}");
  events.prune(3);
  assert.equal(runEventCount(), 3);
  // survivors are the most recently inserted
  const remaining = (db.prepare("SELECT run_id FROM run_events ORDER BY id ASC").all() as Array<{ run_id: string }>).map((r) => r.run_id);
  assert.deepEqual(remaining, runIds.slice(3));
});

test("searchIndex.pruneOrphanEvents drops 'event' rows whose run_id has no run_events left, leaves other kinds alone", () => {
  const keptRun = mkRun();
  const orphanRun = mkRun();
  db.prepare("INSERT INTO run_events (run_id,ts,type,payload) VALUES (?,?,?,?)").run(keptRun, "t", "assistant", "{}");
  searchIndex.add({ kind: "event", ref_id: keptRun, workspace: "ws", title: "keep", body: "still has events" });
  searchIndex.add({ kind: "event", ref_id: orphanRun, workspace: "ws", title: "gone", body: "events already pruned" });
  searchIndex.add({ kind: "job", ref_id: orphanRun, workspace: "ws", title: "job row", body: "same ref_id, different kind" });

  searchIndex.pruneOrphanEvents();

  assert.deepEqual(ftsEventRefs(), [keptRun]);
  const kinds = (db.prepare("SELECT kind FROM search_fts WHERE ref_id = ?").all(orphanRun) as Array<{ kind: string }>).map((r) => r.kind);
  assert.deepEqual(kinds, ["job"]); // the 'event' row for orphanRun is gone; the 'job' row survives
});

test("egressLog.prune keeps only the last N rows", () => {
  for (let i = 0; i < 5; i++) egressLog.add({ host: `h${i}.example.com`, port: 443, action: "allow" });
  egressLog.prune(2);
  assert.equal(egressCount(), 2);
});
