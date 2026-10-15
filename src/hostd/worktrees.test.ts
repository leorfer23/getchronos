/**
 * A host's own worktrees (hostd/worktrees.ts): what `worktree_list` reports and what `worktree_remove`
 * refuses — on real temp git repos standing in for this host's checkouts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureBranchWorktree } from "../worktree-core.js";
import { listHostWorktrees, removeHostWorktree, type HostWorktreeDeps } from "./worktrees.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function checkout(name: string, remote: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hostd-wt-"));
  const p = path.join(root, name);
  fs.mkdirSync(p);
  g(p, "init", "-q", "-b", "main");
  g(p, "config", "user.email", "t@t.t");
  g(p, "config", "user.name", "t");
  g(p, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(p, "README.md"), "hi\n");
  g(p, "add", "-A");
  g(p, "commit", "-qm", "init");
  // The remote is a GitHub-shaped name (what the brain matches by), served from a local bare repo so
  // the base fetch never leaves this machine.
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["clone", "-q", "--bare", p, bare]);
  g(p, "config", `url.${bare}.insteadOf`, remote);
  g(p, "fetch", "-q", "origin");
  return fs.realpathSync(p);
}

const APP = "git@github.com:acme/app.git";
const OTHER = "git@github.com:acme/other.git";

function deps(paths: Array<{ path: string; remote_url: string }>, busy: string[] = []): HostWorktreeDeps {
  return {
    checkouts: async () => paths.map((p) => ({ ...p, head: null }) as any),
    busy: (dir) => busy.includes(dir),
  };
}

test("worktree_list: only the Chronos trees of the repos the brain asked about", async () => {
  const app = checkout("app", APP);
  const other = checkout("other", OTHER);
  const wt = (await ensureBranchWorktree(app, "main", "op/fix/thing"))!;
  await ensureBranchWorktree(other, "main", "op/feat/elsewhere");
  const d = deps([{ path: app, remote_url: APP }, { path: other, remote_url: OTHER }], [wt]);
  const got = await listHostWorktrees(d, { repos: [{ git_remote: "https://github.com/acme/app", default_branch: "main" }] });
  assert.equal(got.length, 1);
  assert.equal(got[0].path, wt);
  assert.equal(got[0].branch, "op/fix/thing");
  assert.equal(got[0].repo_path, app);
  assert.equal(got[0].busy, true, "a process here is in it");
  assert.equal(got[0].dirty, false);
  assert.deepEqual(await listHostWorktrees(d, { repos: [] }), [], "nothing asked, nothing told");
  assert.deepEqual(await listHostWorktrees(d, null), []);
});

test("worktree_remove: refuses what the brain's rules refuse, removes a clean one", async () => {
  const app = checkout("app", APP);
  const other = checkout("other", OTHER);
  const wt = (await ensureBranchWorktree(app, "main", "op/fix/rm"))!;
  const otherWt = (await ensureBranchWorktree(other, "main", "op/fix/rm"))!;
  const d = deps([{ path: app, remote_url: APP }, { path: other, remote_url: OTHER }]);
  const rm = (over: Record<string, unknown>) => removeHostWorktree(d, { git_remote: APP, default_branch: "main", path: wt, ...over });

  assert.match(((await rm({ path: app })) as any).error, /main checkout/);
  assert.match(((await rm({ path: otherWt })) as any).error, /no Chronos worktree/, "another repo's tree is not this repo's");
  assert.match(((await rm({ path: "relative/path" })) as any).error, /absolute/);
  const stray = path.join(path.dirname(wt), "not-a-worktree");
  fs.mkdirSync(stray);
  assert.match(((await rm({ path: stray })) as any).error, /no Chronos worktree/, "a folder that only looks like one");

  fs.writeFileSync(path.join(wt, "wip.txt"), "wip");
  const dirty = await rm({});
  assert.equal(dirty.ok, false);
  assert.match((dirty as any).error, /1 uncommitted file\(s\)/);
  fs.rmSync(path.join(wt, "wip.txt"));

  // A commit no remote has: refused unless forced.
  fs.writeFileSync(path.join(wt, "x.txt"), "x");
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "x");
  assert.match(((await rm({})) as any).error, /not on any remote/);

  const busy = await removeHostWorktree(deps([{ path: app, remote_url: APP }], [wt]), { git_remote: APP, path: wt, force: true });
  assert.match((busy as any).error, /terminal is working in there/, "--force never overrides busy");

  const forced = await rm({ force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.ok(!fs.existsSync(wt));
  assert.ok(g(app, "branch", "--list", "op/fix/rm").includes("op/fix/rm"), "the branch survives");
});

test("worktree_remove mode=cleanup: a clean tree goes, unpushed commits and all; a dirty one stays", async () => {
  const app = checkout("app", APP);
  const wt = (await ensureBranchWorktree(app, "main", "mc/acm-1"))!;
  const d = deps([{ path: app, remote_url: APP }]);
  fs.writeFileSync(path.join(wt, "wip.txt"), "wip");
  const kept = await removeHostWorktree(d, { git_remote: APP, path: wt, mode: "cleanup" });
  assert.equal(kept.ok, false);
  assert.ok(fs.existsSync(wt));
  g(wt, "add", "-A");
  g(wt, "commit", "-qm", "done");
  const gone = await removeHostWorktree(d, { git_remote: APP, path: wt, mode: "cleanup" });
  assert.equal(gone.ok, true);
  assert.ok(!fs.existsSync(wt));
});
