import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, sandboxAvailable, SANDBOX_EXEC } from "./sandbox.js";
import { mainCheckouts } from "./terminal.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

test("a read-only dir wins over the agent's own grants, keeps worktree paths writable, seals its git state", () => {
  const p = buildProfile("guard", "/r/repo", ["/r/repo", "/r/.chronos-worktrees/repo", "/r/repo/tickets/ws"], "/cfg", [], false, ["/r/repo"])!;
  const at = (s: string) => p.indexOf(s);
  const allowOwn = at('(allow file-write* (subpath "/r/repo")');
  const deny = at('(deny file-write* (subpath "/r/repo")');
  assert.ok(allowOwn >= 0 && deny > allowOwn, "deny comes after the cwd grant, so it wins");
  const regrant = p.slice(deny).split("\n")[1];
  for (const g of ["/r/repo/.git", "/r/repo/.mc", "/r/repo/.claude/worktrees", "/r/repo/tickets/ws"]) assert.ok(regrant.includes(`"${g}"`), g);
  assert.ok(!regrant.includes('"/r/.chronos-worktrees/repo"'), "a sibling grant was never denied, so it needs no re-grant");
  const sealed = p.slice(deny).split("\n")[2];
  for (const f of ["index.lock", "HEAD.lock", "HEAD", "rebase-merge"]) assert.ok(sealed.includes(`"/r/repo/.git/${f}"`), f);
  assert.ok(buildProfile("strict", "/r/repo", [], "/cfg", [], false, ["/r/repo"])!.includes('(deny file-write* (subpath "/r/repo")'));
});

test("mainCheckouts keeps real main checkouts only", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-main-")));
  fs.mkdirSync(path.join(root, "main"));
  git(path.join(root, "main"), "init", "-q");
  fs.mkdirSync(path.join(root, "plain"));
  assert.deepEqual(mainCheckouts([path.join(root, "main"), path.join(root, "plain"), null, path.join(root, "missing")]), [path.join(root, "main")]);
});

test("under the Desk sandbox, git in the shared checkout fails without touching it; a worktree works", { skip: !sandboxAvailable() }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-wall-")));
  const repo = path.join(root, "repo"), wtRoot = path.join(root, ".chronos-worktrees", "repo"), wt = path.join(wtRoot, "desk-1");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f.txt"), "v1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "other");
  fs.mkdirSync(wtRoot, { recursive: true });
  const profile = buildProfile("guard", repo, [repo, wtRoot], path.join(root, "cfg"), [], false, [repo])!;
  const sh = (cwd: string, cmd: string) =>
    spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", cmd], {
      cwd, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });

  for (const cmd of ["git checkout -q other", "git checkout -q -b sneaky", "echo x >> f.txt", "git reset -q --hard", "git commit -q --allow-empty -m x", "git stash -q"]) {
    const r = sh(repo, cmd);
    assert.notEqual(r.status, 0, `${cmd} must fail in the shared checkout`);
    assert.match(r.stderr, /not permitted|could not write index/i, cmd);
  }
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "v1\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "index.lock")), "no stale lock left for the operator");

  const add = sh(repo, `git worktree add -q -b desk/1 ${JSON.stringify(wt)}`);
  assert.equal(add.status, 0, add.stderr);
  const work = sh(wt, "echo v2 > f.txt && git add f.txt && git commit -qm v2 && git checkout -q -b desk/1b && git log --format=%s -1");
  assert.equal(work.status, 0, work.stderr);
  assert.equal(work.stdout.trim(), "v2");
  assert.equal(git(repo, "log", "--format=%s", "-1", "desk/1b"), "v2", "the commit landed in the shared object store");
});
