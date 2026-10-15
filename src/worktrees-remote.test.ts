/**
 * `mc worktree list|rm`, the end-of-terminal cleanup and the reaper for a tree on ANOTHER computer
 * (worktrees.ts → RemoteHost → hostd/worktrees.ts): the brain routes by the session's host, and the
 * host applies the rules on its own disk. A RemoteHost on a stub link answers the rpc ops with the
 * host's real handlers over temp git repos standing in for that computer's checkout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hosts, repos, sessions, tickets, workspaces } from "./store.js";
import { registerHost } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { PROTOCOL_VERSION } from "./hostlink/wire.js";
import { ensureBranchWorktree } from "./worktree-core.js";
import { listHostWorktrees, removeHostWorktree, sameDir, type HostWorktreeDeps } from "./hostd/worktrees.js";
import { cleanupRemoteWorktree, listAllWorktrees, reapRemoteWorktrees, removeWorktreeAs } from "./worktrees.js";
import { createTicket } from "./tickets.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const REMOTE = "git@github.com:acme/app.git";

// "m2"'s checkout of acme/app, with origin served from a local bare repo.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-remote-"));
const hostRepo = path.join(root, "app");
fs.mkdirSync(hostRepo);
g(hostRepo, "init", "-q", "-b", "main");
g(hostRepo, "config", "user.email", "t@t.t");
g(hostRepo, "config", "user.name", "t");
fs.writeFileSync(path.join(hostRepo, "README.md"), "hi\n");
g(hostRepo, "add", "-A");
g(hostRepo, "commit", "-qm", "init");
g(hostRepo, "remote", "add", "origin", REMOTE);
execFileSync("git", ["clone", "-q", "--bare", hostRepo, path.join(root, "app.git")]);
g(hostRepo, "config", `url.${path.join(root, "app.git")}.insteadOf`, REMOTE);
g(hostRepo, "fetch", "-q", "origin");
const hostCheckout = fs.realpathSync(hostRepo);

// What the host process would answer: its own terminals' cwds make a tree busy.
const hostBusy: string[] = [];
const deps: HostWorktreeDeps = {
  checkouts: async () => [{ path: hostCheckout, remote_url: REMOTE, head: null } as any],
  busy: (dir) => hostBusy.some((b) => sameDir(b, dir)),
};
let online = true;
let legacy = false;
const calls: string[] = [];
const port = {
  isOnline: () => online,
  sendControl: () => true,
  request: async (_h: string, op: string, args?: unknown) => {
    calls.push(op);
    if (legacy) throw new Error(`unknown op ${op}`);
    if (op === "worktree_list") return listHostWorktrees(deps, args);
    if (op === "worktree_remove") return removeHostWorktree(deps, args);
    throw new Error(`unknown op ${op}`);
  },
};
hosts.create({ id: "h_m2", name: "m2", token_hash: "x".repeat(64), status: "online" });
const m2 = new RemoteHost("h_m2", port);
registerHost(m2);
m2.setOnline({
  proto: PROTOCOL_VERSION, version: "0.1.0", host_id: "h_m2", name: "m2", platform: "darwin", arch: "arm64",
  capabilities: { clis: [], node: process.version, sandbox: true, procs: true }, profiles: [], checkouts: [], deny: [], live: [],
} as any);

const ws = workspaces.create({ slug: "wtr-" + randomUUID().slice(0, 6), name: "WtR", config_dir: "/tmp/wtr" } as any);
// The brain's own checkout of the repo is not on this disk: only the host has one.
const repo = repos.create({ workspace_id: ws.id, name: "app", path: path.join(root, "brain-has-none"), git_remote: "https://github.com/acme/app", default_branch: "main" } as any);

async function claimed(branch: string) {
  const wt = (await ensureBranchWorktree(hostCheckout, "main", branch))!;
  const s = sessions.create({ workspace_id: ws.id, repo_id: repo.id, cwd: hostCheckout, backend: "claude-code", host_id: "h_m2" } as any);
  sessions.setWorktree(s.id, { path: wt, branch, repo_id: repo.id });
  return { wt, s };
}

test("list: a remote terminal's tree shows up, on its computer, held by its session", async () => {
  const { wt, s } = await claimed("op/fix/list-me");
  const all = await listAllWorktrees(ws.id);
  const row = all.find((w) => w.path === wt);
  assert.ok(row, JSON.stringify(all));
  assert.equal(row!.host_id, "h_m2");
  assert.equal(row!.repo, "app");
  assert.equal(row!.repo_id, repo.id);
  assert.equal(row!.session_id, s.id);
  assert.equal(row!.busy, true, "a live terminal of this brain claimed it");
  sessions.end(s.id);
});

test("rm @mine from the remote terminal: refused while dirty, removed when clean, claim cleared", async () => {
  const { wt, s } = await claimed("op/fix/rm-me");
  fs.writeFileSync(path.join(wt, "wip.txt"), "wip");
  const refused = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: s.id }, "@mine");
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 uncommitted file\(s\)/);
  fs.rmSync(path.join(wt, "wip.txt"));

  const other = sessions.create({ workspace_id: ws.id, repo_id: repo.id, cwd: hostCheckout, backend: "claude-code", host_id: "h_m2" } as any);
  const notYours = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: other.id }, wt);
  assert.equal(notYours.status, 403, "another terminal's tree on the same computer");
  sessions.end(other.id);

  const ok = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: s.id }, "@mine");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(!fs.existsSync(wt));
  assert.equal(ok.removed?.session_id, s.id);
  assert.equal(sessions.get(s.id)!.worktree_path, null);
  sessions.end(s.id);
});

test("rm: a process on the host in the tree is busy, even for its owner's --force", async () => {
  const { wt, s } = await claimed("op/fix/busy");
  hostBusy.push(wt);
  const r = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: s.id }, "@mine", { force: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /terminal is working in there/);
  hostBusy.length = 0;
  sessions.end(s.id);
});

test("rm with the host offline says so instead of 'no such worktree'; an old host lists nothing", async () => {
  const { s } = await claimed("op/fix/offline");
  online = false;
  const r = await removeWorktreeAs({ admin: false, scope: { ws: ws.id }, session: s.id }, "@mine");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /computer \(m2\) is offline/);
  online = true;
  legacy = true;
  assert.deepEqual((await listAllWorktrees(ws.id)).filter((w) => w.host_id === "h_m2"), []);
  legacy = false;
  sessions.end(s.id);
});

test("exit cleanup runs on the host (clean only); the reaper takes finished tickets' trees there", async () => {
  const clean = (await ensureBranchWorktree(hostCheckout, "main", "op/feat/ended"))!;
  const dirty = (await ensureBranchWorktree(hostCheckout, "main", "op/feat/ended-dirty"))!;
  fs.writeFileSync(path.join(dirty, "wip.txt"), "wip");
  await cleanupRemoteWorktree("h_m2", repo, clean);
  await cleanupRemoteWorktree("h_m2", repo, dirty);
  assert.ok(!fs.existsSync(clean), "a clean tree goes when its terminal ends");
  assert.ok(fs.existsSync(dirty), "uncommitted work is never destroyed");

  const done = createTicket({ workspace_id: ws.id, title: "finished" });
  const open = createTicket({ workspace_id: ws.id, title: "still going" });
  const doneWt = (await ensureBranchWorktree(hostCheckout, "main", `mc/${done.key.toLowerCase()}`))!;
  const openWt = (await ensureBranchWorktree(hostCheckout, "main", `mc/${open.key.toLowerCase()}`))!;
  tickets.update(done.id, { status: "done" });
  tickets.update(open.id, { status: "in_progress" });
  online = false;
  assert.equal(await reapRemoteWorktrees(m2), 0, "an offline host is left for its next hello");
  online = true;
  assert.equal(await reapRemoteWorktrees(m2), 1);
  assert.ok(!fs.existsSync(doneWt));
  assert.ok(fs.existsSync(openWt));
  assert.ok(fs.existsSync(dirty), "not an mc/ branch: never the reaper's");
});
