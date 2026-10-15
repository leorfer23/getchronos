import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { db, workspaces, repos } from "./store.js";
import { scanDefaultDirs } from "./repo-scan.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "repo-scan-"));
const gitInit = (dir: string, remote?: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
};

beforeEach(() => {
  db.exec("DELETE FROM repos; DELETE FROM workspaces;");
});

test("registers git checkouts under default_dir; skips non-repos and dotfiles", async () => {
  const dir = tmp();
  gitInit(path.join(dir, "with-remote"), "https://example.com/with-remote.git");
  gitInit(path.join(dir, "no-remote"));
  fs.mkdirSync(path.join(dir, "just-a-folder"));
  gitInit(path.join(dir, ".hidden-checkout"));
  fs.writeFileSync(path.join(dir, "a-file.txt"), "x");
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme", default_dir: dir });

  assert.equal(await scanDefaultDirs(), 2);
  const rows = Object.fromEntries(repos.list(ws.id).map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(rows).sort(), ["no-remote", "with-remote"]);
  assert.equal(rows["with-remote"].git_remote, "https://example.com/with-remote.git");
  assert.equal(rows["with-remote"].delivery, "pr");
  assert.equal(rows["with-remote"].default_branch, "main");
  assert.equal(rows["no-remote"].git_remote, null);
  assert.equal(rows["no-remote"].delivery, "commit");
});

test("idempotent: a second sweep adds nothing", async () => {
  const dir = tmp();
  gitInit(path.join(dir, "repo"));
  workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme", default_dir: dir });
  assert.equal(await scanDefaultDirs(), 1);
  assert.equal(await scanDefaultDirs(), 0);
});

test("a symlink to an already-registered checkout is not a second repo", async () => {
  const outside = tmp();
  const real = path.join(outside, "shared");
  gitInit(real);
  const dir = tmp();
  fs.symlinkSync(real, path.join(dir, "shared"));
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme", default_dir: dir });
  repos.create({ workspace_id: ws.id, name: "shared", path: real });

  assert.equal(await scanDefaultDirs(), 0);
  assert.equal(repos.list(ws.id).length, 1);
});

test("a symlink to an UNregistered checkout registers under its real path", async () => {
  const outside = tmp();
  const real = path.join(outside, "linked");
  gitInit(real);
  const dir = tmp();
  fs.symlinkSync(real, path.join(dir, "linked"));
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme", default_dir: dir });

  assert.equal(await scanDefaultDirs(), 1);
  assert.equal(repos.list(ws.id)[0].path, fs.realpathSync(real));
});

test("workspaces without default_dir (or with a missing dir) are untouched", async () => {
  const ws1 = workspaces.create({ slug: "plain", name: "Plain", config_dir: "/tmp/plain" });
  const ws2 = workspaces.create({ slug: "gone", name: "Gone", config_dir: "/tmp/gone", default_dir: "/nonexistent/xyz" });
  assert.equal(await scanDefaultDirs(), 0);
  assert.equal(repos.list(ws1.id).length, 0);
  assert.equal(repos.list(ws2.id).length, 0);
});
