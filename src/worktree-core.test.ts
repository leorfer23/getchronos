/**
 * worktree-core.ts on real git: a ticket branch that was worked on — and pushed — from another
 * computer (a terminal moved by host failover, a build on a host) is picked up from ORIGIN, never
 * re-invented off the default branch; and when git refuses, its reason comes back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureBranchWorktree, tryBranchWorktree } from "./worktree-core.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe" }).toString().trim();

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-core-")));
  const origin = path.join(base, "origin.git");
  const other = path.join(base, "other"); // the other computer
  const here = path.join(base, "here");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, other], { stdio: "pipe" });
  g(other, "commit", "--allow-empty", "-m", "base");
  g(other, "push", "origin", "HEAD:main");
  execFileSync("git", ["clone", origin, here], { stdio: "pipe" });
  return { base, origin, other, here };
}

test("a branch only origin has: the worktree TRACKS origin/<branch> with its commits, not a fresh one off main", async () => {
  const { other, here } = setup();
  g(other, "checkout", "-b", "acme/APP-1");
  fs.writeFileSync(path.join(other, "work.txt"), "from the other computer\n");
  g(other, "add", "work.txt");
  g(other, "commit", "-m", "work");
  g(other, "push", "origin", "acme/APP-1");

  const p = await ensureBranchWorktree(here, "main", "acme/APP-1");
  assert.ok(p && fs.existsSync(path.join(p, "work.txt")), "the pushed commit is there");
  assert.equal(g(p!, "rev-parse", "--abbrev-ref", "@{u}"), "origin/acme/APP-1");

  // The other computer pushes more; reusing the worktree fetches and fast-forwards it.
  fs.writeFileSync(path.join(other, "more.txt"), "more\n");
  g(other, "add", "more.txt");
  g(other, "commit", "-m", "more");
  g(other, "push", "origin", "acme/APP-1");
  assert.equal(await ensureBranchWorktree(here, "main", "acme/APP-1"), p, "reused");
  assert.ok(fs.existsSync(path.join(p!, "more.txt")), "fetched and fast-forwarded on reuse");
});

test("a branch nobody pushed: created off the default branch, as before", async () => {
  const { here } = setup();
  const p = await ensureBranchWorktree(here, "main", "acme/APP-2");
  assert.ok(p);
  assert.equal(g(p!, "rev-parse", "--abbrev-ref", "HEAD"), "acme/APP-2");
  assert.equal(g(p!, "rev-parse", "HEAD"), g(here, "rev-parse", "origin/main"));
});

test("git's own reason comes back instead of a bare null", async () => {
  const { here } = setup();
  const r = await tryBranchWorktree(here, "main", "bad..name");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /not a valid branch name/);
  assert.ok("error" in (await tryBranchWorktree(path.join(here, "nope"), "main", "x")));
});
