import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, hosts, repoCheckouts, repos, workspaces, sessions, jobs, runs, LOCAL_HOST_ID } from "../store.js";

beforeEach(() => {
  db.exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM repos; DELETE FROM workspaces;");
  db.exec("DELETE FROM hosts WHERE id != 'local';");
});

const ws = () => workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });

test("the local host exists on a fresh store and leads the list", () => {
  const local = hosts.get(LOCAL_HOST_ID);
  assert.ok(local);
  assert.equal(local.status, "online");
  db.prepare("INSERT INTO hosts (id,name,platform,created_at) VALUES ('m2','aaa-first-by-name','darwin','2026-09-24T00:00:00Z')").run();
  assert.deepEqual(hosts.list().map((h) => h.id), ["local", "m2"]);
});

test("repos.create writes the local checkout beside repos.path", () => {
  const r = repos.create({ workspace_id: ws().id, name: "one", path: "/src/one" });
  assert.equal(r.path, "/src/one", "repos.path is still what every caller reads");
  const c = repoCheckouts.get(r.id, LOCAL_HOST_ID);
  assert.deepEqual(c, { repo_id: r.id, host_id: "local", path: "/src/one", head: null, scanned_at: null });
});

test("repos.update keeps the local checkout in sync with a moved path, and leaves it alone otherwise", () => {
  const r = repos.create({ workspace_id: ws().id, name: "one", path: "/src/one" });
  db.prepare("UPDATE repo_checkouts SET head = 'abc', scanned_at = 'then' WHERE repo_id = ?").run(r.id);

  repos.update(r.id, { name: "renamed" });
  assert.equal(repoCheckouts.get(r.id, LOCAL_HOST_ID)!.head, "abc", "a patch without a path does not touch the checkout");

  repos.update(r.id, { path: "/src/one" });
  assert.equal(repoCheckouts.get(r.id, LOCAL_HOST_ID)!.head, "abc", "the same path is the same checkout");

  repos.update(r.id, { path: "/elsewhere/one" });
  const moved = repoCheckouts.get(r.id, LOCAL_HOST_ID)!;
  assert.equal(moved.path, "/elsewhere/one");
  assert.equal(moved.head, null, "a checkout that moved has not been scanned yet");
  assert.equal(moved.scanned_at, null);
});

test("an update of an unknown repo writes no checkout", () => {
  assert.equal(repos.update("nope", { path: "/x" }), undefined);
  assert.equal(repoCheckouts.forRepo("nope").length, 0);
});

test("a remote host's checkout is its own row; removing the repo removes both", () => {
  db.prepare("INSERT INTO hosts (id,name,platform,created_at) VALUES ('m2','m2','darwin','2026-09-24T00:00:00Z')").run();
  const r = repos.create({ workspace_id: ws().id, name: "one", path: "/Users/alice/src/one" });
  repoCheckouts.upsert({ repo_id: r.id, host_id: "m2", path: "/Users/a.smith/src/one", head: "deadbeef", scanned_at: "now" });
  repos.update(r.id, { path: "/Users/alice/code/one" });
  assert.deepEqual(repoCheckouts.forRepo(r.id).map((c) => [c.host_id, c.path]), [
    ["local", "/Users/alice/code/one"],
    ["m2", "/Users/a.smith/src/one"],
  ]);
  assert.equal(repoCheckouts.forHost("m2").length, 1);
  repos.remove(r.id);
  assert.equal(repoCheckouts.forRepo(r.id).length, 0);
});

test("sessions and runs carry host_id 'local' without anyone setting it", () => {
  const w = ws();
  const s = sessions.create({ workspace_id: w.id, cwd: "/tmp" } as any);
  assert.equal(s.host_id, "local");
  const j = jobs.create({ name: "j", goal: "g", cwd: "/tmp", workspace_id: w.id } as any);
  assert.equal(runs.create(j.id, "test").host_id, "local");
});

test("reapAll ends only this machine's live terminals", () => {
  const w = ws();
  const here = sessions.create({ workspace_id: w.id, cwd: "/tmp" } as any);
  const there = sessions.create({ workspace_id: w.id, cwd: "/tmp" } as any);
  db.prepare("UPDATE sessions SET host_id = 'm2' WHERE id = ?").run(there.id);
  sessions.reapAll();
  assert.equal(sessions.get(here.id)!.status, "ended");
  assert.equal(sessions.get(there.id)!.status, "live", "a terminal on another host outlives a brain restart");
});
