import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, workspaces, repos, jobs } from "./store.js";
import { sanitizeCwd, sanitizeAddDirs, clampSandbox, checkCwd, jobCreateSpawnError, jobPatchSpawnError } from "./spawn-guard.js";

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM repos; DELETE FROM workspaces;");
});

const mkWs = (over: Partial<{ sandbox_mode: "off" | "guard" | "strict"; default_dir: string }> = {}) => {
  const slug = `sg-${randomUUID().slice(0, 6)}`;
  return workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}`, ...over });
};

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chronos-sg-"));
}

test("sanitizeCwd accepts a repo path belonging to the workspace", () => {
  const ws = mkWs();
  const repoPath = mkDir();
  repos.create({ workspace_id: ws.id, name: "r", path: repoPath });
  // realpath normalizes symlinks (e.g. /var -> /private/var on macOS), so compare realpaths
  const expectedRepoPath = fs.realpathSync(repoPath);
  assert.equal(sanitizeCwd(repoPath, ws.id), expectedRepoPath);
  assert.equal(sanitizeCwd(path.join(repoPath, "sub"), ws.id), null); // subdir doesn't exist on disk
  fs.mkdirSync(path.join(repoPath, "sub"));
  const expectedSubPath = fs.realpathSync(path.join(repoPath, "sub"));
  assert.equal(sanitizeCwd(path.join(repoPath, "sub"), ws.id), expectedSubPath);
});

test("sanitizeCwd rejects a path outside the workspace's own repos", () => {
  const wsA = mkWs();
  const wsB = mkWs();
  const repoB = mkDir();
  repos.create({ workspace_id: wsB.id, name: "r", path: repoB });
  assert.equal(sanitizeCwd(repoB, wsA.id), null); // belongs to a different workspace
  assert.equal(sanitizeCwd("/etc", wsA.id), null); // arbitrary system path
});

test("sanitizeCwd allows exactly $HOME but not arbitrary paths under it", () => {
  assert.equal(sanitizeCwd(os.homedir(), null), os.homedir());
  assert.equal(sanitizeCwd(path.join(os.homedir(), "Documents"), null), null);
});

test("sanitizeAddDirs drops entries outside the workspace and keeps the rest", () => {
  const wsA = mkWs();
  const wsB = mkWs();
  const repoA = mkDir();
  const repoB = mkDir();
  repos.create({ workspace_id: wsA.id, name: "a", path: repoA });
  repos.create({ workspace_id: wsB.id, name: "b", path: repoB });
  // realpath normalizes symlinks, so compare against realpaths
  const expectedRepoA = fs.realpathSync(repoA);
  assert.deepEqual(sanitizeAddDirs([repoA, repoB, "/etc"], wsA.id), [expectedRepoA]);
});

test("clampSandbox never downgrades below the workspace floor", () => {
  const strictWs = mkWs({ sandbox_mode: "strict" });
  assert.equal(clampSandbox("off", strictWs.id), "strict");
  assert.equal(clampSandbox("guard", strictWs.id), "strict");
  assert.equal(clampSandbox("strict", strictWs.id), "strict");

  const offWs = mkWs({ sandbox_mode: "off" });
  assert.equal(clampSandbox("strict", offWs.id), "strict"); // stricter-than-floor requests still pass
  assert.equal(clampSandbox(null, offWs.id), "off");
});

test("sanitizeCwd rejects symlinks pointing outside the workspace", () => {
  const ws = mkWs();
  const repoPath = mkDir();
  repos.create({ workspace_id: ws.id, name: "r", path: repoPath });

  // Create a real target outside the workspace
  const externalTarget = mkDir();

  // Create a symlink inside the repo pointing to the external target
  const symlink = path.join(repoPath, "evil-link");
  fs.symlinkSync(externalTarget, symlink);

  // Should reject the symlink even though it lexically appears to be under the repo
  assert.equal(sanitizeCwd(symlink, ws.id), null);
});

test("sanitizeCwd handles tmpdir symlink normalization (macOS /var -> /private/var)", () => {
  // mkDir() naturally creates dirs under os.tmpdir() which may be a symlink on macOS.
  // This test verifies that symlink normalization via realpathSync works correctly.
  const ws = mkWs();
  const tmpRepoPath = mkDir(); // This path may traverse symlinks on macOS
  repos.create({ workspace_id: ws.id, name: "r", path: tmpRepoPath });

  // Both the tmpdir-based repo and a tmpdir-based candidate should work,
  // even if the paths have different symlink representations
  const tmpSubdir = path.join(tmpRepoPath, "subdir");
  fs.mkdirSync(tmpSubdir);

  // Verify the subdir is accepted (this would fail without realpath normalization)
  const result = sanitizeCwd(tmpSubdir, ws.id);
  assert.ok(result, "tmpdir subdir should be accepted");
});

test("checkCwd says why a cwd is refused", () => {
  const ws = mkWs();
  const gone = path.join(mkDir(), "nope");
  const missing = checkCwd(gone, ws.id);
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /does not exist/);
  const outside = checkCwd(mkDir(), ws.id);
  assert.equal(outside.ok, false);
  assert.match((outside as { reason: string }).reason, /outside the workspace's allowed directories/);
  const unscoped = checkCwd(mkDir(), null);
  assert.match((unscoped as { reason: string }).reason, /not allowed without a workspace/);
});

test("a workspace's landing dir (default_dir) is an allowed cwd", () => {
  const landing = mkDir();
  const ws = mkWs({ default_dir: landing });
  assert.equal(sanitizeCwd(landing, ws.id), fs.realpathSync(landing));
  assert.equal(sanitizeCwd(landing, mkWs().id), null); // not another workspace's
});

test("job create: a valid cwd is stored as given, an invalid one is a reported error", () => {
  const ws = mkWs({ sandbox_mode: "guard" });
  const repoPath = mkDir();
  repos.create({ workspace_id: ws.id, name: "r", path: repoPath });

  const body = { name: "j", goal: "g", workspace_id: ws.id, cwd: repoPath, sandbox: "strict" as const };
  assert.equal(jobCreateSpawnError(body), null);
  const job = jobs.create(body);
  assert.equal(job.cwd, fs.realpathSync(repoPath));
  assert.equal(job.sandbox, "strict");

  assert.match(jobCreateSpawnError({ ...body, cwd: "/etc" })!, /^cwd rejected: \/etc is outside/);
  assert.match(jobCreateSpawnError({ ...body, cwd: path.join(repoPath, "missing") })!, /^cwd rejected: .*does not exist/);
  assert.match(jobCreateSpawnError({ ...body, add_dirs: [repoPath, "/etc"] })!, /^add_dirs rejected: \/etc/);
  assert.match(jobCreateSpawnError({ ...body, sandbox: "off" })!, /sandbox "off" is weaker than the workspace's floor "guard"/);
});

test("job patch: cwd moves to a valid dir, a refused one is reported, unchanged stored values pass", () => {
  const ws = mkWs({ sandbox_mode: "guard" });
  const repoA = mkDir();
  const repoB = mkDir();
  repos.create({ workspace_id: ws.id, name: "a", path: repoA });
  repos.create({ workspace_id: ws.id, name: "b", path: repoB });
  const job = jobs.create({ name: "j", goal: "g", workspace_id: ws.id, cwd: repoA });
  assert.equal(job.cwd, fs.realpathSync(repoA));

  assert.equal(jobPatchSpawnError(job, { cwd: repoB }), null);
  const moved = jobs.update(job.id, { cwd: repoB })!;
  assert.equal(moved.cwd, fs.realpathSync(repoB));

  assert.match(jobPatchSpawnError(moved, { cwd: "/etc" })!, /^cwd rejected/);
  assert.match(jobPatchSpawnError(moved, { sandbox: "off" })!, /weaker than/);

  // A full-form save re-sending what is stored is not judged again (the stored dir may be gone since).
  const pruned = { ...moved, cwd: path.join(repoB, "pruned-worktree") };
  assert.equal(jobPatchSpawnError(pruned, { cwd: pruned.cwd, sandbox: pruned.sandbox, name: "renamed" } as any), null);

  // Moving workspaces re-checks the provided cwd against the NEW workspace.
  const other = mkWs();
  assert.match(jobPatchSpawnError(moved, { workspace_id: other.id, cwd: moved.cwd })!, /^cwd rejected/);
});
