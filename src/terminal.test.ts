import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { excludeChronosArtifacts, ensureWorktreeRoot, gitExcludePath, insideGitRepo, syncAgentsMd } from "./terminal.js";

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-term-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  g("add", "-A");
  g("commit", "-m", "init");
  return repo;
}

test("gitExcludePath resolves inside .git for a plain checkout", async () => {
  const repo = tmpRepo();
  const ex = await gitExcludePath(repo);
  assert.equal(ex, path.join(repo, ".git", "info", "exclude"));
});

// The bug this fixes: .git is a FILE in a worktree, not a directory, so a path-based check
// ("is repoPath/.git a directory?") used to skip the exclude step there entirely. info/exclude is
// shared repo-wide (not per-worktree, unlike HEAD/index) — `git rev-parse --git-path` correctly
// resolves it to the MAIN repo's .git/info/exclude (an absolute path, since it's outside `wtPath`)
// whether it's asked from a plain checkout or a worktree, so old code's skip was pure data loss.
test("gitExcludePath resolves the real (main-repo, shared) exclude file for a worktree", async () => {
  const repo = tmpRepo();
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-term-wt-"));
  const wtPath = fs.realpathSync(wtDir) + "/wt";
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wtPath, "-b", "feat"], { stdio: "ignore" });
  assert.ok(fs.statSync(path.join(wtPath, ".git")).isFile(), "sanity: .git is a file in a worktree");

  const ex = await gitExcludePath(wtPath);
  assert.equal(ex, path.join(fs.realpathSync(repo), ".git", "info", "exclude"));
  assert.ok(fs.existsSync(ex), "the resolved exclude file actually exists on disk");
});

test("syncAgentsMd writes AGENTS.md and excludes it locally even inside a worktree", async () => {
  const repo = tmpRepo();
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-term-wt2-"));
  const wtPath = path.join(wtDir, "wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wtPath, "-b", "feat2"], { stdio: "ignore" });

  await syncAgentsMd(wtPath);

  assert.ok(fs.existsSync(path.join(wtPath, "AGENTS.md")), "AGENTS.md written into the worktree");
  const ex = await gitExcludePath(wtPath);
  const excludeBody = fs.readFileSync(ex, "utf8");
  assert.ok(excludeBody.includes("AGENTS.md"), "AGENTS.md git-excluded locally, not just gitignored globally");
});

test("syncAgentsMd never throws for a missing/bogus path", async () => {
  await assert.doesNotReject(syncAgentsMd("/no/such/path/at/all"));
  await assert.doesNotReject(syncAgentsMd(""));
});

const porcelain = (repo: string) => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });

// The bug this pins: the auto-exclude only fired when Chronos CREATED AGENTS.md, and
// `info/exclude` does nothing for a path already in the index. So a repo that tracks its own
// AGENTS.md got the 346-line managed block as a REAL modification — swept into every `git add -A`
// Chronos runs on the way to a PR (captureDiff/createForRun/shipPR) and left the shared checkout
// permanently dirty. It reached the presence repo's history that way. Chronos is purely local:
// nothing of it may ever appear in a repo, so the only correct move is to not write the file.
test("syncAgentsMd leaves a repo-TRACKED AGENTS.md completely untouched", async () => {
  const repo = tmpRepo();
  const file = path.join(repo, "AGENTS.md");
  const own = "# AGENTS.md\n\nthe repo's own instructions\n";
  fs.writeFileSync(file, own);
  execFileSync("git", ["-C", repo, "add", "AGENTS.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "own agents"], { stdio: "ignore" });

  const mode = await syncAgentsMd(repo);

  assert.equal(mode, "skipped-tracked");
  assert.equal(fs.readFileSync(file, "utf8"), own, "byte-identical: not even a trailing newline added");
  assert.ok(!porcelain(repo).includes("AGENTS.md"), "git sees no modification — nothing to sweep into a commit");
});

// Second hole in the same guard: `if (!existed)` also skipped the exclude for an AGENTS.md that
// already existed but was UNTRACKED (a human's scratch copy, or one written before the exclude
// step existed). `git add -A` stages untracked files too, so that still leaked.
test("syncAgentsMd excludes a pre-existing UNTRACKED AGENTS.md it did not create", async () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# scratch notes\n");

  const mode = await syncAgentsMd(repo);

  assert.equal(mode, "written");
  assert.ok(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8").includes("# scratch notes"), "own content kept");
  assert.ok(!porcelain(repo).includes("AGENTS.md"), "excluded, so git does not see it at all");
});

// Ticket markdown lives under repo.path (resolveFilePath), had no ignore of any kind, and six of
// them were committed into the presence repo before this existed.
test("excludeChronosArtifacts hides .mc/ ticket files from git", async () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, ".mc", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".mc", "tickets", "PER-1.md"), "---\nid: PER-1\n---\n");
  assert.ok(porcelain(repo).includes(".mc/"), "sanity: git sees it before we exclude it");

  await excludeChronosArtifacts(repo);

  assert.equal(porcelain(repo).trim(), "", "no Chronos artifact is visible to git");
  assert.ok(fs.existsSync(path.join(repo, ".mc", "tickets", "PER-1.md")), "file kept on disk — Chronos still reads it");
});

// The sync is the shared chokepoint for all three call sites, so the artifact ignores must be
// applied even on the path that bails out early without writing anything.
test("syncAgentsMd still excludes .mc/ when it skips a tracked AGENTS.md", async () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# own\n");
  execFileSync("git", ["-C", repo, "add", "AGENTS.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "commit", "-m", "own"], { stdio: "ignore" });
  fs.mkdirSync(path.join(repo, ".mc", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".mc", "tickets", "PER-2.md"), "x\n");

  assert.equal(await syncAgentsMd(repo), "skipped-tracked");
  assert.equal(porcelain(repo).trim(), "", "early return still shielded the repo");
});

// A terminal opened in a plain directory is ordinary — the umbrella folder that HOLDS several repos
// (~/Documents/GitHub/acme) is where a "which repo?" session starts. It used to emit a two-line
// `fatal: not a git repository` per Chronos artifact, per session open, into chronos.err.log.
test("a directory that is not a checkout syncs silently — no git noise in the log", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-plain-"));
  fs.writeFileSync(path.join(plain, "note.txt"), "not a repo\n");

  const said: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => { said.push(a.map(String).join(" ")); };
  try {
    assert.equal(await insideGitRepo(plain), false);
    await excludeChronosArtifacts(plain);
    await syncAgentsMd(plain);
  } finally {
    console.warn = realWarn;
  }

  assert.deepEqual(said, [], "nothing should be logged for a plain directory: " + said.join(" | "));
  // Still does its real job there: the CLIs that read AGENTS.md work in non-git dirs too.
  assert.ok(fs.existsSync(path.join(plain, "AGENTS.md")), "AGENTS.md still written");
});

test("insideGitRepo says true for a checkout", async () => {
  assert.equal(await insideGitRepo(tmpRepo()), true);
});

// The bug this fixes: a workspace repo whose worktree root (`.chronos-worktrees/<repo>`) had never
// been created yet — because no terminal had claimed a worktree there — was still handed to backends
// unconditionally via --add-dir. cursor-agent exits at spawn on a nonexistent --add-dir path (claude
// tolerates it), which killed a Personal terminal 1s after spawn (chronos.err.log:239982, 2026-09-19).
test("ensureWorktreeRoot creates a repo's missing worktree root and returns it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-wtroot-"));
  const repoPath = path.join(dir, "myrepo");
  fs.mkdirSync(repoPath);
  const expected = path.join(dir, ".chronos-worktrees", "myrepo");
  assert.equal(fs.existsSync(expected), false, "sanity: root doesn't exist yet");
  assert.equal(ensureWorktreeRoot(repoPath), expected);
  assert.ok(fs.statSync(expected).isDirectory());
});

test("ensureWorktreeRoot returns null instead of a nonexistent path when it can't create the root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-wtroot-fail-"));
  const repoPath = path.join(dir, "myrepo");
  fs.mkdirSync(repoPath);
  // A file sits where the worktree root directory needs to go, so mkdirSync throws.
  fs.writeFileSync(path.join(dir, ".chronos-worktrees"), "not a dir");
  assert.equal(ensureWorktreeRoot(repoPath), null);
});
