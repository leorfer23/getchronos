/**
 * Host failover (src/host-failover.ts): a computer that stays offline past the grace hands its live
 * terminals to one that is here. No sockets, no CLIs: the host is a RemoteHost on a stub link whose
 * `isOnline` the test flips, and the terminal opener is a fake that only writes the row (CLAUDE.md
 * gotcha 2 — nothing here may boot a real agent). Ending the old row goes through the real path.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const { sessions, workspaces, repos, hosts } = await import("./store.js");
const { registerHost } = await import("./hosts/index.js");
const { RemoteHost } = await import("./hosts/remote.js");
const { writeTranscript } = await import("./hosts/transcript-mirror.js");
const { reconcileHost } = await import("./remote-terminals.js");
const { PROTOCOL_VERSION } = await import("./hostlink/wire.js");
const { ensureOriginBranchWorktree } = await import("./worktree-core.js");
const hf = await import("./host-failover.js");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-hf-")));
const profile = path.join(tmp, "profile");
const checkout = path.join(tmp, "repo");
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(checkout, { recursive: true });

let online = false;
const sent: any[] = [];
const port = {
  isOnline: () => online,
  sendControl: (_h: string, f: any) => { sent.push(f); return online; },
  request: async () => { throw new Error("no requests in this test"); },
};
const HOST = "h_failover";
const host = new RemoteHost(HOST, port);
registerHost(host);
hosts.create({ id: HOST, name: "m2", status: "offline", token_hash: "x".repeat(64) });

const ws = workspaces.create({ slug: "hf", name: "HF", config_dir: profile });
const repo = repos.create({ workspace_id: ws.id, name: "app", path: checkout, git_remote: "git@github.com:acme/app.git" });
const gone = repos.create({ workspace_id: ws.id, name: "ghost", path: path.join(tmp, "not-here"), git_remote: "git@github.com:acme/ghost.git" });

const opened: any[] = [];
const posts: string[] = [];
const MIN = 60_000;

beforeEach(() => {
  opened.length = 0;
  posts.length = 0;
  sent.length = 0;
  online = false;
  hf.resetHostFailover({ bootAt: Date.now() - 60 * MIN });
  hf.setHostFailoverOps({
    open: async (o: any) => {
      opened.push(o);
      return sessions.create({ ...o, id: o.agentSessionId ?? undefined, cwd: o.cwd || "", host_id: o.host_id });
    },
    post: (b: string) => { posts.push(b); },
    feed: () => ["understanding: fix the importer", "act: edited importer.ts"],
    originWorktree: async () => null,
    freshWorktree: async () => null,
  });
  // Nothing from an earlier test is still live on the host.
  for (const s of sessions.list({ status: "live" })) if (s.host_id === HOST) sessions.end(s.id);
});

/** The host dropped `ago` ms before `now`. */
function wentOffline(ago: number): number {
  const now = Date.now();
  hosts.update(HOST, { last_seen_at: new Date(now - ago).toISOString() });
  host.setOffline();
  (host as any).offlineSince = now - ago;
  return now;
}

function remoteRow(o: Partial<Parameters<typeof sessions.create>[0]> & { worktree_branch?: string; worktree_path?: string } = {}) {
  const { worktree_branch, worktree_path, ...rest } = o;
  const s = sessions.create({ backend: "claude-code", workspace_id: ws.id, repo_id: repo.id, goal: "fix the importer", title: "Importer fix", cwd: "/Users/a.smith/GitHub/app", host_id: HOST, ...rest });
  if (worktree_branch) sessions.setWorktree(s.id, { path: worktree_path ?? `/Users/a.smith/GitHub/.chronos-worktrees/app/${worktree_branch.replace(/\//g, "-")}`, branch: worktree_branch });
  return sessions.get(s.id)!;
}

test("grace not reached → nothing moves", async () => {
  const s = remoteRow();
  const now = wentOffline(2 * MIN);
  assert.deepEqual(hf.dueHosts(now, 5), []);
  const r = await hf.sweepHostFailover(now);
  assert.equal(r.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(sessions.get(s.id)!.status, "live");
  assert.equal(posts.length, 0);
});

test("a brain that just booted waits the grace too, whatever last_seen_at says", async () => {
  remoteRow();
  const now = wentOffline(60 * MIN);
  hf.resetHostFailover({ bootAt: now - MIN });
  assert.deepEqual(hf.dueHosts(now, 5), []);
});

test("offline ≥ grace → moved once to the brain with its conversation; a second sweep is a no-op", async () => {
  const s = remoteRow({ agent_name: "importer" });
  const lines = [
    { type: "user", sessionId: s.id, cwd: "/Users/a.smith/GitHub/app", message: { role: "user", content: "fix the importer" } },
    { type: "assistant", sessionId: s.id, cwd: "/Users/a.smith/GitHub/app", message: { content: [{ type: "text", text: "on it" }] } },
  ].map((l) => JSON.stringify(l) + "\n").join("");
  writeTranscript(s.id, 0, lines + '{"type":"assist'); // a half-streamed last line is dropped
  const now = wentOffline(6 * MIN);

  const r = await hf.sweepHostFailover(now);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, "moved");
  assert.equal(opened.length, 1);
  const o = opened[0];
  assert.equal(o.host_id, "local");
  assert.equal(o.movedFrom, s.id);
  assert.equal(o.resumeAgent, true);
  assert.equal(o.cwd, checkout, "the brain's own checkout of the repo, not the host's path");
  assert.equal(o.workspace_id, ws.id);
  assert.equal(o.backend, "claude-code");
  assert.equal(o.goal, "fix the importer");
  assert.match(o.seed, /offline for 6 min/);
  assert.match(o.seed, /NOT here/);
  assert.match(o.seed, /push early/);

  // The transcript is where `claude --resume <new id>` started in that cwd looks for it.
  const newId = o.agentSessionId as string;
  const dest = path.join(profile, "projects", checkout.replace(/[^a-zA-Z0-9]/g, "-"), `${newId}.jsonl`);
  assert.ok(fs.existsSync(dest), dest);
  const copied = fs.readFileSync(dest, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(copied.length, 2);
  assert.ok(copied.every((l) => l.sessionId === newId && l.cwd === checkout));

  const old = sessions.get(s.id)!;
  assert.equal(old.status, "ended");
  assert.equal(old.end_reason, "host_failover");
  const next = sessions.get(newId)!;
  assert.equal(next.status, "live");
  assert.equal(next.agent_name, "importer", "the handle moves once the old row frees it");
  assert.match(next.placement ?? "", /continues .* from m2/);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^m2 offline 6m → moved 1 terminal here: HF: "fix the importer"/);

  const again = await hf.sweepHostFailover(now + MIN);
  assert.equal(again.length, 0);
  assert.equal(opened.length, 1, "never twice");
  assert.equal(posts.length, 1);
});

test("the host comes back → the old process is killed there, never resumed", async () => {
  const s = remoteRow();
  const now = wentOffline(10 * MIN);
  await hf.sweepHostFailover(now);
  assert.equal(sessions.get(s.id)!.end_reason, "host_failover");

  online = true;
  sent.length = 0;
  host.setOnline({
    proto: PROTOCOL_VERSION, version: "0.1.0", host_id: HOST, name: "m2", platform: "darwin", arch: "arm64",
    capabilities: { clis: [], node: process.version, sandbox: true }, profiles: [], checkouts: [], deny: [],
    live: [{ ch: 21, session_id: s.id, kind: "pty", pid: 777, last_seq: 4 }],
  } as any);
  const revived: string[] = [];
  const r = await reconcileHost(host, { revive: async (x) => { revived.push(x.id); } });
  assert.deepEqual(r.orphans, [21]);
  assert.deepEqual(sent.filter((f) => f.ch === 21).map((f) => f.t), ["kill", "release"]);
  assert.deepEqual(revived, [], "a failed-over terminal is not revived on its old host");
  assert.equal(sessions.get(s.id)!.status, "ended");
  assert.equal(hf.hostOfflineSince(HOST), null, "online again: nothing is due");
});

test("repo on no online computer → stays live, one Desk line saying why, once", async () => {
  const s = remoteRow({ repo_id: gone.id, title: "Ghost work" });
  const now = wentOffline(7 * MIN);
  const r = await hf.sweepHostFailover(now);
  assert.equal(r[0].kind, "stuck");
  assert.equal(opened.length, 0);
  assert.equal(sessions.get(s.id)!.status, "live");
  assert.equal(posts.length, 1);
  assert.match(posts[0], /could not move HF: "fix the importer" — ghost is not checked out on this Mac or on any online computer; it stays on m2/);
  await hf.sweepHostFailover(now + 5 * MIN);
  assert.equal(posts.length, 1, "said once");
});

test("a backend that cannot resume gets a brief: goal, what it did, and the branch situation", async () => {
  const s = remoteRow({ backend: "grok", worktree_branch: "feat/importer", worktree_path: "/Users/a.smith/GitHub/.chronos-worktrees/app/feat-importer", title: "Grok importer" });
  sessions.setMeta(s.id, { summary: "parsing works, tests failing" });
  const now = wentOffline(8 * MIN);
  await hf.sweepHostFailover(now);
  assert.equal(opened.length, 1);
  const o = opened[0];
  assert.equal(o.resumeAgent, undefined);
  assert.equal(o.backend, "grok");
  assert.match(o.seed, /taking over a Desk terminal that was running on m2/);
  assert.match(o.seed, /Goal: fix the importer/);
  assert.match(o.seed, /parsing works, tests failing/);
  assert.match(o.seed, /edited importer\.ts/);
  assert.match(o.seed, /`feat\/importer` could not be checked out here/);
  assert.equal(sessions.get(s.id)!.end_reason, "host_failover");
});

test("a pushed branch is checked out fresh from origin on the brain", async () => {
  const wt = path.join(tmp, ".chronos-worktrees", "repo", "feat-importer"); // worktreeRootFor(checkout)
  fs.mkdirSync(wt, { recursive: true });
  hf.setHostFailoverOps({
    open: async (o: any) => { opened.push(o); return sessions.create({ ...o, id: o.agentSessionId ?? undefined, cwd: o.cwd || "", host_id: o.host_id }); },
    post: (b: string) => { posts.push(b); },
    feed: () => [],
    originWorktree: async (_p: string, b: string) => (b === "feat/importer" ? wt : null),
    freshWorktree: async () => null,
  });
  const s = remoteRow({ worktree_branch: "feat/importer" });
  writeTranscript(s.id, 0, JSON.stringify({ type: "user", sessionId: s.id, message: { role: "user", content: "x" } }) + "\n");
  const now = wentOffline(9 * MIN);
  await hf.sweepHostFailover(now);
  assert.equal(opened.length, 1);
  assert.match(opened[0].seed, /checked out fresh from origin/);
  assert.equal(opened[0].cwd, wt);
  assert.equal(opened[0].resumeAgent, true);
  const next = sessions.get(opened[0].agentSessionId)!;
  assert.equal(next.worktree_branch, "feat/importer", "the new card owns the branch it continues");
  assert.equal(next.worktree_path, wt);
  assert.ok(fs.existsSync(path.join(profile, "projects", wt.replace(/[^a-zA-Z0-9]/g, "-"), `${next.id}.jsonl`)));
});

test("ensureOriginBranchWorktree: a pushed branch → a worktree tracking origin; an unpushed one → null", async () => {
  const origin = path.join(tmp, "origin.git");
  const clone = path.join(tmp, "clone");
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, clone], { stdio: "pipe" });
  g(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  g(clone, "push", "origin", "HEAD:main");
  g(clone, "checkout", "-b", "feat/pushed");
  fs.writeFileSync(path.join(clone, "work.txt"), "pushed work\n");
  g(clone, "add", "work.txt");
  g(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "work");
  g(clone, "push", "origin", "feat/pushed");
  g(clone, "checkout", "main");
  g(clone, "branch", "-D", "feat/pushed"); // the brain never had it locally

  const p = await ensureOriginBranchWorktree(clone, "feat/pushed");
  assert.ok(p && fs.existsSync(path.join(p, "work.txt")), "the pushed commit is in the new worktree");
  assert.equal(g(p!, "rev-parse", "--abbrev-ref", "HEAD"), "feat/pushed");
  assert.equal(g(p!, "rev-parse", "--abbrev-ref", "@{u}"), "origin/feat/pushed");
  assert.equal(await ensureOriginBranchWorktree(clone, "feat/pushed"), p, "idempotent");
  assert.equal(await ensureOriginBranchWorktree(clone, "feat/never-pushed"), null);
});

test("copyClaudeTranscript: nothing for a path claude would hash, nothing for an empty mirror", () => {
  const src = path.join(tmp, "empty.jsonl");
  fs.writeFileSync(src, "");
  assert.equal(hf.copyClaudeTranscript(src, profile, checkout, "id-1"), null);
  assert.equal(hf.claudeProjectDir(profile, "/" + "a".repeat(220)), null);
  assert.equal(hf.claudeProjectDir(profile, "/Users/x/my_repo.v2"), path.join(profile, "projects", "-Users-x-my-repo-v2"));
});

test("placement: a move is admission-exempt and never sticky to the dead host", async () => {
  const { placeRequest } = await import("./hosts/candidates.js");
  const s = remoteRow();
  const req = placeRequest({ workspace_id: ws.id, backend: "claude-code", host_id: "local", movedFrom: s.id }, "failover");
  assert.equal(req.exempt_admission, true);
  assert.equal(req.sticky, null, "unlike `replaces`, which would pin it back onto m2");
  assert.equal(req.pinned, "local");
});

test("the Desk line names each terminal by its project and goal, not a pasted-prompt title", () => {
  const ws = workspaces.create({ slug: `tt-${Date.now()}`, name: "Medialab", config_dir: "/tmp/tt" } as any);
  const s = { id: "abcdef12-0000", workspace_id: ws.id, title: "ng por DM , después este job:", goal: "ShareOut ask to Robert, 30-day flag backfill", spawn_goal: null } as any;
  assert.equal(hf.titleOf(s), 'Medialab: "ShareOut ask to Robert, 30-day flag backfill"');
  const long = hf.titleOf({ ...s, workspace_id: null, goal: "x".repeat(100) });
  assert.equal(long, `"${"x".repeat(69)}…"`);
});
