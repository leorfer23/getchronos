import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, repos, repoAccelerators, isAcceleratorTool } from "../store.js";

let wsA = "", wsB = "";
let repoA = "", repoB = "";
beforeEach(() => {
  db.exec("DELETE FROM repo_accelerators; DELETE FROM repos; DELETE FROM workspaces;");
  wsA = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" }).id;
  wsB = workspaces.create({ slug: "other", name: "Other", config_dir: "/tmp/other" }).id;
  repoA = repos.create({ workspace_id: wsA, name: "repo-a", path: "/tmp/repo-a" }).id;
  repoB = repos.create({ workspace_id: wsB, name: "repo-b", path: "/tmp/repo-b" }).id;
});

test("a fresh repo has no accelerator rows until one is flipped", () => {
  assert.deepEqual(repoAccelerators.listByRepo(repoA), []);
  assert.equal(repoAccelerators.get(repoA, "graphify"), undefined);
});

test("setEnabled upserts by (repo, tool) — flipping twice never duplicates the row", () => {
  const first = repoAccelerators.setEnabled(wsA, repoA, "ast-grep", true);
  const second = repoAccelerators.setEnabled(wsA, repoA, "ast-grep", false);
  assert.equal(first.id, second.id);
  assert.equal(second.enabled, 0);
  assert.equal(repoAccelerators.listByRepo(repoA).length, 1);
});

test("mode is preserved across an enable/disable that omits it, and cleared only when passed null", () => {
  repoAccelerators.setEnabled(wsA, repoA, "graphify", true, "code-only");
  const off = repoAccelerators.setEnabled(wsA, repoA, "graphify", false);
  assert.equal(off.mode, "code-only", "omitting mode must not clear it");
  const cleared = repoAccelerators.setEnabled(wsA, repoA, "graphify", true, null);
  assert.equal(cleared.mode, null);
});

test("workspace isolation — one workspace's rows are invisible to another's listing", () => {
  repoAccelerators.setEnabled(wsA, repoA, "graphify", true);
  repoAccelerators.setEnabled(wsB, repoB, "graphify", true);
  const aRows = repoAccelerators.listByWorkspace(wsA);
  assert.equal(aRows.length, 1);
  assert.equal(aRows[0].repo_id, repoA);
  const bRows = repoAccelerators.listByWorkspace(wsB);
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].repo_id, repoB);
});

test("deleting a repo takes its accelerator rows with it (no orphaned repo pollution in the DB)", () => {
  repoAccelerators.setEnabled(wsA, repoA, "repomix", true);
  repos.remove(repoA);
  assert.equal((db.prepare("SELECT count(*) c FROM repo_accelerators WHERE repo_id=?").get(repoA) as { c: number }).c, 0);
});

test("isAcceleratorTool rejects anything not in the known set", () => {
  assert.ok(isAcceleratorTool("graphify"));
  assert.ok(isAcceleratorTool("ast-grep"));
  assert.ok(isAcceleratorTool("repomix"));
  assert.ok(!isAcceleratorTool("rm -rf"));
  assert.ok(!isAcceleratorTool(""));
});

test("remove() deletes only the named (repo, tool) row, leaving siblings alone", () => {
  repoAccelerators.setEnabled(wsA, repoA, "graphify", true);
  repoAccelerators.setEnabled(wsA, repoA, "ast-grep", true);
  repoAccelerators.remove(repoA, "graphify");
  const left = repoAccelerators.listByRepo(repoA);
  assert.equal(left.length, 1);
  assert.equal(left[0].tool, "ast-grep");
});

test("setEnabled rejects a workspaceId/repoId ownership mismatch — repoB does not belong to wsA", () => {
  assert.throws(() => repoAccelerators.setEnabled(wsA, repoB, "graphify", true), /does not belong to workspace/);
  assert.deepEqual(repoAccelerators.listByRepo(repoB), [], "the rejected call must not have written a row");
});

test("setEnabled rejects a repoId that does not exist at all", () => {
  assert.throws(() => repoAccelerators.setEnabled(wsA, "no-such-repo", "graphify", true), /does not belong to workspace/);
});

test("schema CHECK rejects an unknown tool name at the SQL layer, not just in application code", () => {
  assert.throws(() => {
    db.prepare(
      `INSERT INTO repo_accelerators (id,workspace_id,repo_id,tool,enabled,mode,created_at,updated_at)
       VALUES ('x',?,?,?,0,NULL,'now','now')`,
    ).run(wsA, repoA, "not-a-real-tool");
  }, /CHECK constraint failed/);
});

test("schema CHECK rejects an enabled value outside 0/1 at the SQL layer", () => {
  assert.throws(() => {
    db.prepare(
      `INSERT INTO repo_accelerators (id,workspace_id,repo_id,tool,enabled,mode,created_at,updated_at)
       VALUES ('x',?,?,'graphify',2,NULL,'now','now')`,
    ).run(wsA, repoA);
  }, /CHECK constraint failed/);
});
