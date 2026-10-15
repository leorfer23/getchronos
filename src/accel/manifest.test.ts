import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// manifest.ts resolves ACCEL_ROOT from CHRONOS_ACCEL_ROOT at module load — point it at a throwaway
// dir BEFORE the first import so these tests never touch the operator's real ~/.chronos.
const accelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-root-"));
process.env.CHRONOS_ACCEL_ROOT = accelRoot;

const { manifestDir, readManifest, writeManifest, currentHead, freshness, configHashOf, ACCEL_ROOT, safeRelativeGraphPath } = await import("./manifest.js");

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  return dir;
}

const base = {
  workspaceId: "ws-1", repoId: "repo-1", tool: "graphify" as const,
  toolVersion: "1.0.0", configHash: configHashOf(null),
  graphPath: "graph.json", bytes: 12,
};

function plantArtifact(workspaceId: string, repoId: string, tool: "graphify" | "ast-grep" | "repomix", bytes = 12) {
  const dir = manifestDir(workspaceId, repoId, tool);
  fs.mkdirSync(dir, { recursive: true });
  const body = "x".repeat(bytes);
  fs.writeFileSync(path.join(dir, "graph.json"), body, { mode: 0o600 });
  return body.length;
}

test("ACCEL_ROOT resolves outside any checkout (env-overridable, defaults under the home dir)", () => {
  assert.equal(ACCEL_ROOT, accelRoot);
  assert.ok(!ACCEL_ROOT.includes("chronos-worktrees"), "must never resolve inside a repo checkout");
});

test("no manifest yet → missing, and currentHead still reads the target repo's real HEAD", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath);
  assert.ok(head && /^[0-9a-f]{40}$/.test(head));
  const f = freshness({ ...base, repoId: "repo-x", repoPath });
  assert.equal(f.state, "missing");
  assert.equal(f.manifestHead, null);
  assert.equal(f.currentHead, head);
});

test("a manifest written at the current HEAD/version/config reports fresh", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  const bytes = plantArtifact("ws-1", "repo-y", "graphify");
  writeManifest({ ...base, repoId: "repo-y", head, bytes });
  const f = freshness({ ...base, repoId: "repo-y", repoPath });
  assert.equal(f.state, "fresh");
  assert.equal(f.manifestHead, head);
});

test("a new commit after the manifest was written flips it to stale", () => {
  const repoPath = makeGitRepo();
  const oldHead = currentHead(repoPath)!;
  writeManifest({ ...base, repoId: "repo-z", head: oldHead });
  fs.writeFileSync(path.join(repoPath, "b.txt"), "two");
  execFileSync("git", ["add", "b.txt"], { cwd: repoPath });
  execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repoPath });
  const newHead = currentHead(repoPath)!;
  assert.notEqual(oldHead, newHead);
  const f = freshness({ ...base, repoId: "repo-z", repoPath });
  assert.equal(f.state, "stale");
  assert.equal(f.manifestHead, oldHead);
  assert.equal(f.currentHead, newHead);
});

test("a tool version bump after the manifest was written flips it to stale even with HEAD unchanged", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  writeManifest({ ...base, repoId: "repo-tv", head, toolVersion: "1.0.0" });
  const f = freshness({ ...base, repoId: "repo-tv", repoPath, toolVersion: "1.1.0" });
  assert.equal(f.state, "stale");
});

test("a config/mode change after the manifest was written flips it to stale even with HEAD+version unchanged", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  writeManifest({ ...base, repoId: "repo-cfg", head, configHash: configHashOf("code-only") });
  const f = freshness({ ...base, repoId: "repo-cfg", repoPath, configHash: configHashOf("full") });
  assert.equal(f.state, "stale");
});

test("an unreadable HEAD (not a git repo) is treated as stale, never as fresh, and prints no git stderr", () => {
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-notgit-"));
  writeManifest({ ...base, repoId: "repo-w", head: "deadbeef" });
  const f = freshness({ ...base, repoId: "repo-w", repoPath: notGit });
  assert.equal(f.state, "stale");
  assert.equal(f.currentHead, null);
});

test("a manifest copied from another workspace's directory is rejected — identity must match exactly, not just the path", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  // Simulate a manifest physically copied from ws-real's directory into ws-target's: the file lives
  // at ws-target's path, but its own contents still claim ws-real. Bypasses writeManifest on purpose
  // — writeManifest always stamps the identity it was called with, so this has to be hand-written to
  // reproduce a copy/corruption.
  const dir = manifestDir("ws-target", "repo-copied", "graphify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph.json"), "x".repeat(12));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: "ws-real", repoId: "repo-copied", tool: "graphify",
    head, builtAt: new Date().toISOString(), toolVersion: base.toolVersion, configHash: base.configHash,
    graphPath: "graph.json", bytes: 12,
  }));
  const f = freshness({ ...base, workspaceId: "ws-target", repoId: "repo-copied", repoPath });
  assert.equal(f.state, "stale");
  assert.equal(f.manifestHead, null, "an untrusted manifest's HEAD must not be surfaced as if it were authoritative");
});

test("a manifest written by an unknown schema version is rejected, never treated as fresh", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  const dir = manifestDir("ws-1", "repo-futureschema", "graphify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph.json"), "x".repeat(12));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 999, workspaceId: "ws-1", repoId: "repo-futureschema", tool: "graphify",
    head, builtAt: new Date().toISOString(), toolVersion: base.toolVersion, configHash: base.configHash,
    graphPath: "graph.json", bytes: 12,
  }));
  const f = freshness({ ...base, repoId: "repo-futureschema", repoPath });
  assert.equal(f.state, "stale");
});

test("schema v1 manifests are stale under schema v2 — force a rebuild, never treat as fresh", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  const dir = manifestDir("ws-1", "repo-v1", "graphify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "graph.json"), "x".repeat(12));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, workspaceId: "ws-1", repoId: "repo-v1", tool: "graphify",
    head, builtAt: new Date().toISOString(), toolVersion: base.toolVersion, configHash: base.configHash,
  }));
  assert.equal(freshness({ ...base, repoId: "repo-v1", repoPath }).state, "stale");
});

test("traversal-unsafe graphPath values are rejected by writeManifest and freshness", () => {
  assert.throws(() => writeManifest({ ...base, repoId: "bad-path", head: "abc", graphPath: "../etc/passwd", bytes: 1 }));
  assert.throws(() => writeManifest({ ...base, repoId: "bad-abs", head: "abc", graphPath: "/tmp/graph.json", bytes: 1 }));
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  const dir = manifestDir("ws-1", "repo-trav", "graphify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: "ws-1", repoId: "repo-trav", tool: "graphify",
    head, builtAt: new Date().toISOString(), toolVersion: base.toolVersion, configHash: base.configHash,
    graphPath: "../escape.json", bytes: 1,
  }));
  assert.equal(freshness({ ...base, repoId: "repo-trav", repoPath }).state, "stale");
});

test("currentHead's own source pipes/ignores git's stderr rather than inheriting the daemon's console", () => {
  const src = fs.readFileSync(new URL("./manifest.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function currentHead"));
  assert.match(fn, /stdio:\s*\[.*"ignore".*\]/s, "currentHead must not inherit stderr for a git call that is expected to fail on non-repos");
});

test("readManifest round-trips exactly what writeManifest wrote, including the expanded schema fields", () => {
  const bytes = plantArtifact("ws-2", "repo-v", "ast-grep", 9);
  const m = writeManifest({
    workspaceId: "ws-2", repoId: "repo-v", tool: "ast-grep", head: "abc123",
    toolVersion: "0.9", configHash: configHashOf(null), graphPath: "graph.json", bytes,
  });
  const back = readManifest("ws-2", "repo-v", "ast-grep");
  assert.deepEqual(back, m);
  assert.equal(m.schemaVersion, 2);
  assert.equal(m.workspaceId, "ws-2");
  assert.equal(m.repoId, "repo-v");
  assert.equal(m.graphPath, "graph.json");
  assert.equal(m.bytes, bytes);
});

test("no repo pollution — the manifest never lands inside the target repo's own tree, or inside any checkout", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  writeManifest({ ...base, repoId: "repo-u", tool: "repomix", head });
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" }).trim(), "");
  assert.deepEqual(fs.readdirSync(repoPath).sort(), [".git", "a.txt"]);
  const dir = manifestDir("ws-1", "repo-u", "repomix");
  assert.ok(dir.startsWith(accelRoot), `expected ${dir} to live under ${accelRoot}`);
  assert.ok(fs.existsSync(path.join(dir, "manifest.json")));
});

test("directories are created 0700 and the manifest file 0600 (private, not shared/world-readable)", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  writeManifest({ ...base, repoId: "repo-perm", head });
  const dir = manifestDir("ws-1", "repo-perm", "graphify");
  const dirMode = fs.statSync(dir).mode & 0o777;
  const fileMode = fs.statSync(path.join(dir, "manifest.json")).mode & 0o777;
  assert.equal(dirMode, 0o700, `dir mode was ${dirMode.toString(8)}`);
  assert.equal(fileMode, 0o600, `file mode was ${fileMode.toString(8)}`);
});

test("keys by workspaceId/repoId/tool — two workspaces never collide on the same repoId", () => {
  const repoPath = makeGitRepo();
  const head = currentHead(repoPath)!;
  writeManifest({ ...base, workspaceId: "ws-a", repoId: "shared-repo-id", head, toolVersion: "1" });
  writeManifest({ ...base, workspaceId: "ws-b", repoId: "shared-repo-id", head, toolVersion: "2" });
  assert.equal(readManifest("ws-a", "shared-repo-id", "graphify")!.toolVersion, "1");
  assert.equal(readManifest("ws-b", "shared-repo-id", "graphify")!.toolVersion, "2");
});
