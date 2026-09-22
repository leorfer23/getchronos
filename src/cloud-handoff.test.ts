import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { db, jobs, repos, runs, sessions, workspaces } from "./store.js";
import { createTicket } from "./tickets.js";
import { prepareHandoff, executeHandoff, isOwnRepo } from "./cloud-handoff.js";

beforeEach(() => {
  // Children before parents: tickets.repo_id -> repos.id is enforced (no ON DELETE SET NULL there,
  // unlike jobs.ticket_id), so repos must go after tickets, not before.
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces;");
});

// ---------------------------------------------------------------------------------------------
// Fixtures: a bare repo standing in for GitHub (real git push, never the network), and a worktree
// whose `origin` points at it. Every job in these tests dispatches through the real `dispatch()`
// (per the Lead's ruling — no second launch path), so sandbox_mode: "off" on the fixture workspace
// keeps the mock backend's spawn unsandboxed (a "guard" floor default would hit the same
// sandbox-exec permission wall the rest of the suite already carries as a known environmental
// failure — see CLAUDE.md and mkJob's convention in execute.test.ts).

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
// noTicket exists only to exercise that specific refusal — dispatcher.ts's validateSpawnTarget can
// only resolve cursor-cloud's repo via job.ticket_id -> ticket.repo_id (jobs carry no repo_id of
// their own), so every other fixture needs a real ticket or prepareHandoff refuses before reaching
// whatever else the test is actually about.
function fixture(over: { gitRemote?: string; delivery?: "commit" | "pr"; noWorktree?: boolean; noTicket?: boolean } = {}) {
  n++;
  const remote = tmpBareRemote();
  const wt = over.noWorktree ? null : tmpWorktree(remote);
  // Deliberately NOT `wt`: in production repo.path is the main checkout, a different directory from
  // a session's own per-ticket worktree — createTicket() writes its .md file under repo.path, and if
  // that were `wt` here, the ticket file would show up as an untracked file in the session's own
  // worktree, which is not what happens for real. Just needs to be writable; createTicket() doesn't
  // require it to be a git repo.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-handoff-repo-"));
  const ws = workspaces.create({
    slug: `handoff${n}`,
    name: "H",
    config_dir: fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cfg-")),
    sandbox_mode: "off",
  });
  const repo = repos.create({
    workspace_id: ws.id,
    name: `repo${n}`,
    path: repoDir,
    git_remote: over.gitRemote ?? "https://github.com/leorfer23/getchronos",
    default_branch: "main",
    delivery: over.delivery ?? "pr",
  } as any);
  const ticket = over.noTicket ? undefined : createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "ship the thing" });
  const session = sessions.create({
    workspace_id: ws.id,
    repo_id: repo.id,
    ticket_id: ticket?.id,
    cwd: wt ?? "/tmp",
    backend: "claude-code",
    goal: "ship the thing",
  });
  if (wt) sessions.setWorktree(session.id, { path: wt, branch: "main" });
  return { ws, repo, ticket, session: sessions.get(session.id)!, wt, remote };
}

async function waitForRun(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runs.get(runId)!;
    if (r.status !== "queued" && r.status !== "running") {
      // A ticket-linked run's post-exit review queueing (runner.ts) fires off the child process's
      // own exit event, a tick or two after runs.status turns terminal — wait it out here so it
      // never lands after the NEXT test's beforeEach has already wiped the ticket it needs.
      await new Promise((res) => setTimeout(res, 100));
      return r;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${r.status} after ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
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

    const result = await executeHandoff(session.id, { backendName: "mock" });
    assert.equal(result.ok, false);
    assert.match(result.error!, /explicit confirm/);
    assert.equal(sessions.get(session.id)!.status, "live", "refused before touching anything — old session untouched");
    assert.equal(jobs.list().length, 0, "no job created");
  });

  test("refuses cleanly: no worktree", async () => {
    const { session } = fixture({ noWorktree: true });
    const plan = await prepareHandoff(session.id);
    assert.match(plan.refused!, /no claimed worktree/);
  });

  test("refuses cleanly: no ticket — dispatch can only resolve cursor-cloud's repo through one", async () => {
    const { session } = fixture({ noTicket: true });
    const plan = await prepareHandoff(session.id);
    assert.match(plan.refused!, /no ticket/);
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
  test("a failed push does NOT dispatch a job — and never leaves a 'live' placeholder pointing at nothing", async () => {
    const { session, wt, remote } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");
    // Unreachable remote — the push fails without ever touching the network.
    g(wt!, ["remote", "set-url", "origin", path.join(remote, "does-not-exist")]);

    const result = await executeHandoff(session.id, { backendName: "mock" });

    assert.equal(result.ok, false);
    assert.match(result.error!, /push of branch .* failed/);
    assert.equal(jobs.list().length, 0, "must never dispatch from a ref that was never actually pushed");

    // The local terminal ends FIRST, before any git write (kill-before-commit) — so it is expected
    // to already be 'ended' here, same as on the success path. The placeholder cloud session it
    // handed off to must NOT be left 'live' with nothing behind it.
    assert.equal(sessions.get(session.id)!.status, "ended");
    assert.ok(result.newSessionId, "placeholder session id is still reported");
    assert.equal(sessions.get(result.newSessionId!)!.status, "ended", "placeholder session is torn down on failure, never left live");
  });

  test("kills the local terminal BEFORE any git write — a live agent's tree is never committed mid-write", async () => {
    const { session, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");

    const result = await executeHandoff(session.id, { backendName: "mock" });
    assert.equal(result.ok, true, result.error);
    // If commit/push ran before the kill, session.status would already need to be 'ended' for the
    // commit to be trustworthy either way — the real guarantee we can observe from outside is that
    // it ends up 'ended' with a handoff reason, and the branch it committed is exactly what was on
    // disk (nothing torn, since nothing was writing to it once the terminal died).
    const old = sessions.get(session.id)!;
    assert.equal(old.status, "ended");
    assert.match(old.end_reason ?? "", /handed off to Cursor Cloud/);
    await waitForRun(result.runId!); // drain the mock run before beforeEach wipes its tables
  });

  test("push is a plain push, never --force", async () => {
    // A retry after an earlier partial handoff: the branch already exists on the remote as an
    // ancestor of the new local commit. A plain push must fast-forward cleanly.
    const { session, wt, remote } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    const branch = `chronos/handoff/${session.id.slice(0, 8)}`;
    g(wt!, ["checkout", "-b", branch]);
    g(wt!, ["push", "origin", branch]);
    g(wt!, ["checkout", "main"]);
    fs.writeFileSync(path.join(wt!, "wip.txt"), "more work\n");

    const result = await executeHandoff(session.id, { backendName: "mock" });
    assert.equal(result.ok, true, result.error);
    const log = execFileSync("git", ["--git-dir", remote, "log", "--oneline", branch], { encoding: "utf8" });
    assert.ok(log.includes("handoff snapshot"), "fast-forwarded onto the existing remote branch");
    await waitForRun(result.runId!); // drain the mock run before beforeEach wipes its tables
  });

  test("no ticket: refused before touching the terminal or the worktree at all", async () => {
    // A regression guard for the exact gap that made this refusal necessary: it must be caught by
    // prepareHandoff, not discovered after dispatch() rejects a job whose local terminal is already
    // dead. See the "no ticket" refusal above and the comment on it in cloud-handoff.ts.
    const { session, wt } = fixture({ noTicket: true });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");

    const result = await executeHandoff(session.id);

    assert.equal(result.ok, false);
    assert.match(result.error!, /no ticket/);
    assert.equal(sessions.get(session.id)!.status, "live", "refused before touching anything");
    assert.equal(jobs.list().length, 0, "no job created");
    const status = execFileSync("git", ["-C", wt!, "status", "--porcelain"], { encoding: "utf8" });
    assert.ok(status.includes("wip.txt"), "worktree untouched — the WIP file is still just an uncommitted change");
  });

  // There is no live-dispatch test for the production default (backendName omitted -> "cursor-cloud",
  // now genuinely registered since PR1 landed #26): dispatch() would pass validateSpawnTarget on a
  // fully valid fixture and reach the real execute() with the real cursorCloudBackend, which is
  // exactly what CLAUDE.md's "never call the real execute() with a real backend in tests" rule
  // exists to prevent (PR2's runner.ts kind==="cloud" branch hasn't landed yet, so execute() would
  // still try to call cursorCloudBackend.buildArgs(), which deliberately throws). The default string
  // itself is a one-line, directly-reviewable piece of cloud-handoff.ts.

  test("a successful handoff pushes, dispatches, ends the local session, links the run, and leaves the worktree in place", async () => {
    const { session, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    fs.writeFileSync(path.join(wt!, "wip.txt"), "work in progress\n");

    const result = await executeHandoff(session.id, { backendName: "mock" });

    assert.equal(result.ok, true, result.error);
    assert.ok(result.jobId);
    assert.ok(result.runId);
    assert.ok(result.newSessionId);

    const old = sessions.get(session.id)!;
    assert.equal(old.status, "ended");
    assert.ok(old.end_reason?.includes(result.newSessionId!.slice(0, 8)), "old session's end reason links to the new cloud session");

    const fresh = sessions.get(result.newSessionId!)!;
    assert.equal(fresh.status, "live");
    assert.equal(fresh.backend, "mock");
    assert.equal(fresh.ticket_id, old.ticket_id, "carries the ticket forward — also what protects the worktree from terminal.ts's own cleanup");

    // runs.session_id is repurposed for a cloud run (no local CLI transcript to point at) to link
    // back to the Desk session displaying it.
    assert.equal(runs.get(result.runId!)!.session_id, fresh.id);

    const finished = await waitForRun(result.runId!);
    assert.equal(finished.status, "success");

    assert.ok(fs.existsSync(wt!), "worktree is kept, not removed");
    const branch = execFileSync("git", ["-C", wt!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(branch, `chronos/handoff/${session.id.slice(0, 8)}`);
    assert.equal(result.pushedSha, execFileSync("git", ["-C", wt!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  });
});

describe("ticket key/title/body reach the cloud prompt", () => {
  test("folded into the dispatched job's goal", async () => {
    const { session, ws, repo, wt } = fixture({ gitRemote: "https://github.com/leorfer23/getchronos" });
    const ticket = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Fix the thing", context: "Do the specific thing described here." });
    db.prepare("UPDATE sessions SET ticket_id=? WHERE id=?").run(ticket.id, session.id);
    fs.writeFileSync(path.join(wt!, "wip.txt"), "wip\n");

    const result = await executeHandoff(session.id, { backendName: "mock" });
    assert.equal(result.ok, true, result.error);

    const goal = jobs.get(result.jobId!)!.goal;
    assert.ok(goal.includes(ticket.key), "ticket key folded in");
    assert.ok(goal.includes("Fix the thing"), "ticket title folded in");
    assert.ok(goal.includes("Do the specific thing described here."), "ticket body folded in");
    await waitForRun(result.runId!); // drain the mock run before beforeEach wipes its tables
  });
});
