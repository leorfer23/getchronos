import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, launches, workspaces } from "./store.js";
import { NewLaunchSchema, LaunchPatchSchema, SessionInputSchema } from "./validation.js";

beforeEach(() => {
  db.exec("DELETE FROM launches; DELETE FROM workspaces;");
});

const mkWs = (slug = `l-${randomUUID().slice(0, 6)}`) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });

test("a launch keeps the whole New-terminal dialog under a name, appended to its client's row", () => {
  const ws = mkWs();
  const a = launches.create({ workspace_id: ws.id, name: "Airflow morning", goal: "triage failed DAGs", goal_kind: "investigation", description: "yesterday 00:00 UTC → now", cwd: "/tmp/airflow" });
  const b = launches.create({ workspace_id: ws.id, name: "blank in repo" });
  assert.equal(a.pos, 0); assert.equal(b.pos, 1);
  assert.equal(a.goal_kind, "investigation");
  assert.equal(b.goal, null); assert.equal(b.backend, null);
  assert.equal(a.run_count, 0); assert.equal(a.last_run_at, null);
});

test("running a launch counts it and remembers the terminal; the row itself never closes", () => {
  const ws = mkWs();
  const l = launches.create({ workspace_id: ws.id, name: "dbt run" });
  launches.ran(l.id, "sess-1");
  const r = launches.ran(l.id, "sess-2")!;
  assert.equal(r.run_count, 2);
  assert.equal(r.last_session_id, "sess-2");
  assert.ok(r.last_run_at);
  assert.equal(launches.list({ workspace_id: ws.id }).length, 1);
});

test("patch touches only the named fields, and reorder is per client", () => {
  const ws = mkWs(), other = mkWs();
  const a = launches.create({ workspace_id: ws.id, name: "a", goal: "g" });
  const b = launches.create({ workspace_id: ws.id, name: "b" });
  const x = launches.create({ workspace_id: other.id, name: "x" });
  assert.equal(launches.update(a.id, { name: "A" })!.goal, "g");
  launches.reorder(ws.id, [b.id, a.id]);
  assert.deepEqual(launches.list({ workspace_id: ws.id }).map((l) => l.name), ["b", "A"]);
  assert.equal(launches.list({ workspace_id: other.id })[0].id, x.id);
  assert.equal(launches.remove(a.id), true);
  assert.equal(launches.remove(a.id), false);
});

test("deleting a client takes its launches with it", () => {
  const ws = mkWs();
  launches.create({ workspace_id: ws.id, name: "gone with the client" });
  workspaces.remove(ws.id);
  assert.equal(launches.list().length, 0);
});

test("schemas: a launch needs only a name; a patch needs something; input takes a key sequence", () => {
  assert.equal(NewLaunchSchema.safeParse({ name: "x" }).success, true);
  assert.equal(NewLaunchSchema.safeParse({ goal: "no name" }).success, false);
  assert.equal(LaunchPatchSchema.safeParse({}).success, false);
  assert.equal(SessionInputSchema.safeParse({ keys: ["down", "down", "enter"] }).success, true);
  assert.equal(SessionInputSchema.safeParse({ keys: [] }).success, false);
  assert.equal(SessionInputSchema.safeParse({}).success, false);
});
