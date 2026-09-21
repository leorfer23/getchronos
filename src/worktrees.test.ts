import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureTicketWorktree, cleanupWorktree, reapDoneWorktrees, listAllWorktrees, worktreeState, removeWorktreeAs } from "./worktrees.js";
import { repos, sessions, tickets, workspaces } from "./store.js";
import { createTicket } from "./tickets.js";

function tmpRepo(): { path: string; default_branch: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-wt-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  g("add", "-A");
  g("commit", "-m", "init");
  return { path: repo, default_branch: "main" };
}

test("ensureTicketWorktree creates, reuses, and cleanup removes a clean worktree", async () => {
  const repo = tmpRepo() as any;

  const wt = await ensureTicketWorktree(repo, "PER-9");
  assert.ok(wt, "worktree path returned");
  assert.ok(fs.existsSync(path.join(wt!, "README.md")), "worktree checked out the base tree");
  // branch = mc/per-9
  const branch = execFileSync("git", ["-C", wt!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(branch, "mc/per-9");

  // idempotent: same branch → same path, no throw
  assert.equal(await ensureTicketWorktree(repo, "PER-9"), wt);

  // dirty worktree is NOT removed
  fs.writeFileSync(path.join(wt!, "scratch.txt"), "wip");
  await cleanupWorktree(repo.path, wt!);
  assert.ok(fs.existsSync(wt!), "dirty worktree preserved");

  // clean it → cleanup removes the checkout (branch survives in the repo)
  fs.rmSync(path.join(wt!, "scratch.txt"));
  await cleanupWorktree(repo.path, wt!);
  assert.ok(!fs.existsSync(wt!), "clean worktree removed");
  const branches = execFileSync("git", ["-C", repo.path, "branch", "--list", "mc/per-9"], { encoding: "utf8" });
  assert.ok(branches.includes("mc/per-9"), "branch preserved after worktree removal");
});

test("reapDoneWorktrees removes done tickets' clean worktrees and keeps everything else", async () => {
  const bare = tmpRepo();
  const ws = workspaces.create({
    slug: "wtreap-" + randomUUID().slice(0, 8),
    name: "WtReap",
    config_dir: "/tmp/wtreap",
  } as any);
  const repo = repos.create({ workspace_id: ws.id, name: "reap", path: bare.path, default_branch: "main" } as any);

  const doneT = createTicket({ workspace_id: ws.id, title: "finished" });
  const openT = createTicket({ workspace_id: ws.id, title: "still going" });
  const dirtyT = createTicket({ workspace_id: ws.id, title: "finished but dirty" });

  const doneWt = await ensureTicketWorktree(repo, doneT.key);
  const openWt = await ensureTicketWorktree(repo, openT.key);
  const dirtyWt = await ensureTicketWorktree(repo, dirtyT.key);
  assert.ok(doneWt && openWt && dirtyWt);
  fs.writeFileSync(path.join(dirtyWt!, "wip.txt"), "uncommitted work");

  tickets.update(doneT.id, { status: "done" });
  tickets.update(dirtyT.id, { status: "done" });
  tickets.update(openT.id, { status: "in_progress" });

  await reapDoneWorktrees();

  assert.ok(!fs.existsSync(doneWt!), "done ticket's clean worktree reaped");
  assert.ok(fs.existsSync(openWt!), "open ticket's worktree kept");
  assert.ok(fs.existsSync(dirtyWt!), "done ticket's DIRTY worktree kept — uncommitted work is never destroyed");
  const branches = execFileSync("git", ["-C", bare.path, "branch", "--list"], { encoding: "utf8" });
  assert.ok(branches.includes(`mc/${doneT.key.toLowerCase()}`), "reaped worktree's branch survives");
});

test("ensureTicketWorktree returns null for a non-git dir (caller falls back)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-nogit-"));
  assert.equal(await ensureTicketWorktree({ path: dir, default_branch: "main" } as any, "X-1"), null);
});

test("listAllWorktrees(workspaceId) never leaks another workspace's repo path — PER-92", async () => {
  const wsA = workspaces.create({
    slug: "wta-" + randomUUID().slice(0, 8),
    name: "WsA",
    config_dir: "/tmp/wta",
  } as any);
  const wsB = workspaces.create({
    slug: "wtb-" + randomUUID().slice(0, 8),
    name: "WsB",
    config_dir: "/tmp/wtb",
  } as any);

  const repoA = tmpRepo();
  const repoB = tmpRepo();
  repos.create({ workspace_id: wsA.id, name: "repo-a", path: repoA.path, default_branch: "main" } as any);
  repos.create({ workspace_id: wsB.id, name: "repo-b", path: repoB.path, default_branch: "main" } as any);

  const ticketA = createTicket({ workspace_id: wsA.id, title: "a work" });
  const ticketB = createTicket({ workspace_id: wsB.id, title: "b work" });
  const wtA = await ensureTicketWorktree(repoA as any, ticketA.key);
  const wtB = await ensureTicketWorktree(repoB as any, ticketB.key);
  assert.ok(wtA && wtB);

  // A workspace-A token calling GET /worktrees must never see workspace B's repo/path.
  const scopedToA = await listAllWorktrees(wsA.id);
  assert.ok(scopedToA.some((w) => w.repo_path === repoA.path), "A's own worktree is visible");
  assert.ok(!scopedToA.some((w) => w.repo_path === repoB.path), "B's repo path never leaks to A");
  assert.ok(!scopedToA.some((w) => w.repo === "repo-b"), "B's repo name never leaks to A");

  // Admin/unscoped (no argument) still sees everything — used by the admin-gated DELETE /worktrees.
  const unscoped = await listAllWorktrees();
  assert.ok(unscoped.some((w) => w.repo_path === repoA.path));
  assert.ok(unscoped.some((w) => w.repo_path === repoB.path));
});

// The normal end of a PR: squash-merged on the remote, branch deleted, `fetch --prune`. The terminal
// that did everything right must be able to remove its own tree without --force.
function squashMergedSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-wt-sq-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  run(repo, "add", "-A"); run(repo, "commit", "-qm", "init"); run(repo, "push", "-q", "origin", "HEAD:main");
  const wt = path.join(dir, ".chronos-worktrees", "repo", "lf-fix-thing");
  run(repo, "worktree", "add", "-q", "-b", "lf/fix/thing", wt, "origin/main");
  fs.writeFileSync(path.join(wt, "a.txt"), "a\n"); run(wt, "add", "-A"); run(wt, "commit", "-qm", "a");
  fs.writeFileSync(path.join(wt, "b.txt"), "b\n"); run(wt, "add", "-A"); run(wt, "commit", "-qm", "b");
  run(wt, "push", "-q", "-u", "origin", "lf/fix/thing");
  // GitHub's squash-merge, played by a second clone: one commit on main with the branch's whole diff.
  const gh = path.join(dir, "gh");
  execFileSync("git", ["clone", "-q", origin, gh], { stdio: "ignore" });
  fs.writeFileSync(path.join(gh, "a.txt"), "a\n"); fs.writeFileSync(path.join(gh, "b.txt"), "b\n");
  run(gh, "add", "-A"); run(gh, "commit", "-qm", "fix thing (#1)"); run(gh, "push", "-q", "origin", "main");
  run(gh, "push", "-q", "origin", "--delete", "lf/fix/thing");
  run(repo, "fetch", "-q", "--prune");
  return { repo, wt, run };
}

test("worktreeState: a squash-merged branch whose remote was deleted is not 'unpushed'", async () => {
  const { repo, wt } = squashMergedSetup();
  const st = await worktreeState(repo, wt);
  assert.equal(st.dirty, false);
  assert.equal(st.unpushed, 0);
});

test("worktreeState: a commit made after the squash-merge still counts as unpushed", async () => {
  const { repo, wt, run } = squashMergedSetup();
  fs.writeFileSync(path.join(wt, "c.txt"), "c\n"); run(wt, "add", "-A"); run(wt, "commit", "-qm", "c");
  const st = await worktreeState(repo, wt);
  assert.ok(st.unpushed > 0, "the new commit is only here");
});

test("removeWorktreeAs: a terminal naming its repo removes the tree it claimed there", async () => {
  const { repo, wt } = squashMergedSetup();
  const ws = workspaces.create({ slug: "wtrm-" + randomUUID().slice(0, 8), name: "WtRm", config_dir: "/tmp/wtrm" } as any);
  const r = repos.create({ workspace_id: ws.id, name: "squashy", path: repo, default_branch: "main" } as any);
  const s = sessions.create({ workspace_id: ws.id, cwd: repo, backend: "claude-code" } as any);
  sessions.setWorktree(s.id, { path: wt, branch: "lf/fix/thing", repo_id: r.id });
  const out = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: s.id }, "squashy");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(!fs.existsSync(wt));
});
