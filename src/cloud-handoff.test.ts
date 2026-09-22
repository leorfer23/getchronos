import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db, repos, sessions, workspaces } from "./store.js";
import { createTicket } from "./tickets.js";
import { prepareHandoff, executeHandoff, isOwnRepo } from "./cloud-handoff.js";
import type { AgentBackend } from "./backends/types.js";
import type { CloudBackend, CloudLaunch, CloudLaunchOpts } from "./backends/types.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM repos; DELETE FROM tickets; DELETE FROM workspaces;");
});

// ---------------------------------------------------------------------------------------------
// Fixtures: a bare repo standing in for GitHub (real git push, never the network), and a worktree
// whose `origin` points at it.

function g(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function tmpBareRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-handoff-remote-"));
  const bare = path.join(dir, "remote.git");
  fs.mkdirSync(bare);
  g(bare, ["init", "--bare", "-b", "main"]);
  return bare;
}

function tmpWorktree(remote: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-handoff-wt-"));
  const wt = path.join(dir, "wt");
  fs.mkdirSync(wt);
  g(wt, ["init", "-b", "main"]);
  g(wt, ["config", "user.email", "t@t.t"]);
  g(wt, ["config", "user.name", "t"]);
  g(wt, ["remote", "add", "origin", remote]);
  fs.writeFileSync(path.join(wt, "README.md"), "hi\n");
  g(wt, ["add", "-A"]);
  g(wt, ["commit", "-m", "init"]);
  g(wt, ["push", "origin", "main"]);
  return wt;
}

let n = 0;
function fixture(over: { gitRemote?: string; delivery?: "commit" | "pr"; noWorktree?: boolean } = {}) {
  n++;
  const remote = tmpBareRemote();
  const wt = over.noWorktree ? null : tmpWorktree(remote);
  const ws = workspaces.create({ slug: `handoff${n}`, name: "H", config_dir: fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-")) });
  const repo = repos.create({
    workspace_id: ws.id,
    name: `repo${n}`,
    path: wt ?? "/nonexistent",
    git_remote: over.gitRemote ?? "https://github.com/leorfer23/getchronos",
    default_branch: "main",
    delivery: over.delivery ?? "pr",
  } as any);
  const session = sessions.create({ workspace_id: ws.id, repo_id: repo.id, cwd: wt ?? "/tmp", backend: "claude-code", goal: "ship the thing" });
  if (wt) sessions.setWorktree(session.id, { path: wt, branch: "main" });
  return { ws, repo, session: sessions.get(session.id)!, wt, remote };
}

function fakeCloudBackend(over: Partial<CloudBackend> = {}): AgentBackend {
  const base: CloudBackend = {
    name: "cursor-cloud",
    kind: "cloud",
    supportsResume: true,
    bin: () => "cursor-cloud",
    buildArgs: () => { throw new Error("cloud backend has no local process"); },
    oneShot: () => { throw new Error("cloud backend has no local process"); },
    env: () => ({}),
    parseLine: (l: string) => ({ type: "raw", payload: l }),
    extractResult: () => null,
    detectRateLimit: () => null,
    async launch(_opts: CloudLaunchOpts): Promise<CloudLaunch> {
      return { agentId: "bc-" + randomUUID(), runId: "run-" + randomUUID(), url: "https://cursor.com/agents/bc-fake", status: "running" };
    },
    async *stream() {},
    async getRun() { return { status: "running", result: null, durationMs: null, branches: [], error: null }; },
    async usage() { return { tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_write: null, cost_usd: null }; },
    async followup() { throw new Error("not used in this test"); },
    async cancel() {},
    ...over,
  };
  return base;
}

// ---------------------------------------------------------------------------------------------

describe("isOwnRepo", () => {
  test("matches the two Chronos remotes in both ssh and https form", () => {
    assert.equal(isOwnRepo("https://github.com/leorfer23/getchronos"), true);
    assert.equal(isOwnRepo("https://github.com/leorfer23/getchronos.git"), true);
    assert.equal(isOwnRepo("git@github.com:leorfer23/chronos.git"), true);
    assert.equal(isOwnRepo("GIT@GITHUB.COM:leorfer23/Chronos.git"), true);
  });
  test("fails closed on anything else, including the operator's own client-hosted repos", () => {
    assert.equal(isOwnRepo("https://github.com/leorfer23/some-client-repo"), false);
    assert.equal(isOwnRepo("https://github.com/galley-eng/galley"), false);
    assert.equal(isOwnRepo(null), false);
    assert.equal(isOwnRepo(""), false);
    assert.equal(isOwnRepo("not a url at all"), false);
  });
});

describe("prepareHandoff", () => {
  test("zero side effects, lists exactly the right files, gitignored files excluded", async () => {
    const { session, wt } = fixture();
    fs.writeFileSync(path.join(wt!, ".gitignore"), "ignored.txt\n");
    g(wt!, ["add", ".gitignore"]);
    g(wt!, ["commit", "-m", "gitignore"]);
    fs.writeFileSync(path.join(wt!, "tracked-change.txt"), "wip\n");
    fs.writeFileSync(path.join(wt!, "new-file.txt"), "new\n");
    fs.writeFileSync(path.join(wt!, "ignored.txt"), "should never appear\n");
    const before = fs.readdirSync(wt!).sort();
    const beforeBranch = execFileSync("git", ["-C", wt!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

    const plan = await prepareHandoff(session.id);

    assert.equal(plan.refused, null);
    assert.equal(plan.branch, `chronos/handoff/${session.id.slice(0, 8)}`);
    assert.deepEqual(plan.files.sort(), ["new-file.txt", "tracked-change.txt"]);
    assert.ok(!plan.files.includes("ignored.txt"), "gitignored file never listed");
    assert.equal(plan.currentBranch, beforeBranch, "prepareHandoff never switches branches");
    assert.deepEqual(fs.readdirSync(wt!).sort(), before, "prepareHandoff creates no new files");
    assert.equal(execFileSync("git", ["-C", wt!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), beforeBranch, "no branch change");
  });

  test("own Chronos repo: no warning, auto-offer allowed", async () => {
    const { session } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    const plan = await prepareHandoff(session.id);
    assert.equal(plan.ownRepo, true);
    assert.equal(plan.requiresConfirm, false);
    assert.ok(!plan.warnings.some((w) => w.includes("not a Chronos-owned remote")));
  });

  test("non-Chronos remote: warning fires and blocks the auto-offer", async () => {
    const { session } = fixture({ gitRemote: "https://github.com/some-client/their-repo" });
    const plan = await prepareHandoff(session.id);
    assert.equal(plan.ownRepo, false);
    assert.equal(plan.requiresConfirm, true);
    assert.ok(plan.warnings.some((w) => w.includes("not a Chronos-owned remote")), "warning present");

    const result = await executeHandoff(session.id, { backend: fakeCloudBackend() });
    assert.equal(result.ok, false);
    assert.match(result.error!, /explicit confirm/);
  });

  test("refuses cleanly: no worktree", async () => {
    const { session } = fixture({ noWorktree: true });
    const plan = await prepareHandoff(session.id);
    assert.match(plan.refused!, /no claimed worktree/);
  });

  test("refuses cleanly: repo has no GitHub remote", async () => {
    const { session } = fixture({ gitRemote: "https://gitlab.com/leorfer23/getchronos" });
    const plan = await prepareHandoff(session.id);
    assert.match(plan.refused!, /not on GitHub/);
  });

  test("refuses cleanly: delivery is not pr", async () => {
    const { session } = fixture({ delivery: "commit" });
    const plan = await prepareHandoff(session.id);
    assert.match(plan.refused!, /delivery is "commit"/);
  });
});

describe("executeHandoff", () => {
  test("a failed push does NOT launch", async () => {
    const { session, wt, remote } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");
    // Make the remote unreachable so the push fails, without ever touching the network.
    g(wt!, ["remote", "set-url", "origin", path.join(remote, "does-not-exist")]);

    let launchCalled = false;
    const backend = fakeCloudBackend({ async launch() { launchCalled = true; return { agentId: "x", runId: "y", url: null, status: "running" }; } });

    const result = await executeHandoff(session.id, { backend });
    assert.equal(result.ok, false);
    assert.match(result.error!, /push failed/);
    assert.equal(launchCalled, false, "must never launch from a ref that was never actually pushed");
    assert.equal(sessions.get(session.id)!.status, "live", "local session must stay live on a failed push");
  });

  test("a successful handoff pushes, ends the local session, links the cloud run, and leaves the worktree in place", async () => {
    const { session, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");

    let launchedRepos: CloudLaunchOpts["repos"] | undefined;
    const backend = fakeCloudBackend({
      async launch(opts) {
        launchedRepos = opts.repos;
        return { agentId: "bc-123", runId: "run-456", url: "https://cursor.com/agents/bc-123", status: "running" };
      },
    });

    const result = await executeHandoff(session.id, { backend });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.cloudAgentId, "bc-123");
    assert.equal(result.cloudRunId, "run-456");
    assert.ok(result.newSessionId);
    assert.equal(launchedRepos?.[0]?.startingRef, `chronos/handoff/${session.id.slice(0, 8)}`);

    const old = sessions.get(session.id)!;
    assert.equal(old.status, "ended");
    assert.ok(old.end_reason?.includes(result.newSessionId!.slice(0, 8)), "old session's end reason links to the new cloud session");

    const fresh = sessions.get(result.newSessionId!)!;
    assert.equal(fresh.status, "live");
    assert.equal(fresh.backend, "cursor-cloud");
    assert.equal((fresh as any).cloud_agent_id, "bc-123");
    assert.equal((fresh as any).cloud_run_id, "run-456");
    assert.equal((fresh as any).cloud_url, "https://cursor.com/agents/bc-123");
    assert.equal(fresh.ticket_id, old.ticket_id, "carries the ticket forward — also what keeps the worktree from being swept");

    assert.ok(fs.existsSync(wt!), "worktree is kept, not removed");
    const branch = execFileSync("git", ["-C", wt!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(branch, `chronos/handoff/${session.id.slice(0, 8)}`);
    assert.equal(result.pushedSha, execFileSync("git", ["-C", wt!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  });

  test("when the cursor-cloud backend is unavailable, fails closed after the push (branch is not lost)", async () => {
    const { session, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");
    // A non-cloud backend stands in for "cursor-cloud isn't registered yet" (isCloudBackend → false).
    const notCloud: AgentBackend = {
      name: "claude-code",
      supportsResume: true,
      bin: () => "claude",
      buildArgs: () => [],
      oneShot: () => ({ cmd: "claude", args: [], env: {} }),
      env: () => ({}),
      parseLine: (l: string) => ({ type: "raw", payload: l }),
      extractResult: () => null,
      detectRateLimit: () => null,
    };

    const result = await executeHandoff(session.id, { backend: notCloud });
    assert.equal(result.ok, false);
    assert.match(result.error!, /cursor-cloud backend is not available/);
    assert.equal(result.branch, `chronos/handoff/${session.id.slice(0, 8)}`, "the pushed branch is still reported back");
    assert.equal(sessions.get(session.id)!.status, "live", "nothing launched → local session is not ended");
  });
});

describe("ticket body folded into the cloud prompt", () => {
  test("ticket key/title/body reach the launch via the job goal", async () => {
    const { session, ws, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    const ticket = createTicket({ workspace_id: ws.id, title: "Fix the thing", context: "Do the specific thing described here." });
    db.prepare("UPDATE sessions SET ticket_id=? WHERE id=?").run(ticket.id, session.id);
    fs.writeFileSync(path.join(wt!, "wip.txt"), "wip\n");

    let seenGoal = "";
    const backend = fakeCloudBackend({
      async launch(opts) { seenGoal = opts.job.goal; return { agentId: "a", runId: "r", url: null, status: "running" }; },
    });

    const result = await executeHandoff(session.id, { backend });
    assert.equal(result.ok, true, result.error);
    assert.ok(seenGoal.includes(ticket.key), "ticket key folded in");
    assert.ok(seenGoal.includes("Fix the thing"), "ticket title folded in");
    assert.ok(seenGoal.includes("Do the specific thing described here."), "ticket body folded in");
  });
});
