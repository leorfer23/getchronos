/**
 * Where a repo-less terminal lands on a host (landing.ts) and what the host says when a CLI's
 * transcript never shows up (terminals.ts TranscriptTail).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureLandingDir } from "./landing.js";
import { HostTerminals, TranscriptTail, type HostBackend } from "./terminals.js";
import type { SpawnSpec } from "../hosts/spawn-spec.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hostd-landing-")));

function gitRepo(dir: string, remote: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return fs.realpathSync(dir);
}

test("ensureLandingDir: one symlink per checkout, kept in step, nothing else touched", () => {
  const root = tmp();
  const a = gitRepo(path.join(root, "src", "web"), "git@github.com:acme/web.git");
  const b = gitRepo(path.join(root, "src", "api"), "git@github.com:acme/api.git");
  const c = gitRepo(path.join(root, "other", "api"), "git@github.com:acme/api-2.git");
  const land = path.join(root, "landing");

  const dir = ensureLandingDir(land, "acme", [a, b, c])!;
  assert.equal(dir, fs.realpathSync(path.join(land, "acme")));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["api", "api-2", "web"], "a clashing folder name is suffixed");
  assert.equal(fs.realpathSync(path.join(dir, "web")), a);

  // The operator's own file in there is never touched; a repo no longer here loses its link.
  fs.writeFileSync(path.join(dir, "notes.md"), "mine");
  ensureLandingDir(land, "acme", [a, b]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["api", "notes.md", "web"]);

  assert.equal(ensureLandingDir(land, "acme", [a]), null, "one checkout: land in it, no farm");
  assert.equal(ensureLandingDir(land, "../escape", [a, b]), null, "a slug is a folder name, never a path");
  assert.equal(ensureLandingDir(land, "", [a, b]), null);
});

test("a repo-less terminal lands in its workspace's landing dir on this host", async () => {
  const home = tmp();
  const web = gitRepo(path.join(home, "code", "web"), "git@github.com:acme/web.git");
  const api = gitRepo(path.join(home, "code", "api"), "git@github.com:acme/api.git");
  const sh: HostBackend = { name: "sh", bin: () => "/bin/sh", interactiveArgs: () => ["-c", "sleep 5"], env: () => ({}) };
  const t = new HostTerminals({
    home, root: process.cwd(), prepare: false, mcPort: 7777,
    profiles: () => ({ claude: home }),
    checkouts: async () => [{ path: web, remote_url: "git@github.com:acme/web.git" }, { path: api, remote_url: "git@github.com:acme/api.git" }] as any,
    deny: () => [],
    backends: { sh },
  });
  const spec = (over: Partial<SpawnSpec>): SpawnSpec => ({
    kind: "intent", session_id: "s-land", workspace: { id: "ws-a", slug: "acme" }, backend: "sh", model: null, role: "human",
    cli_session: null, resume: false, repo: null, repos: [{ id: "r1", git_remote: "https://github.com/acme/web" }, { id: "r2", git_remote: "https://github.com/acme/api" }],
    worktree: null, resume_cwd: null, cwd_hint: "landing", profile: "claude", sandbox: { mode: "off", allow: [], egress_locked: false },
    system: null, env: {}, env_home_relative: [], nice: 0, cols: 80, rows: 24, seed: null, ...over,
  } as SpawnSpec);
  const r = await t.spawn(spec({}));
  assert.equal(r.cwd, path.join(home, ".chronos-landing", "acme"));
  assert.deepEqual(fs.readdirSync(r.cwd).sort(), ["api", "web"]);
  t.killAll();
  // With a repo the hint is not landing: the checkout itself, as before.
  const r2 = await t.spawn(spec({ session_id: "s-repo", repo: { id: "r1", git_remote: "https://github.com/acme/web" }, cwd_hint: "repo" }));
  assert.equal(r2.cwd, web);
  t.killAll();
});

test("TranscriptTail: a transcript that never appears is logged once, not polled silently forever", () => {
  const lines: string[] = [];
  const tail = new TranscriptTail(
    { sessionId: "abcdef123456", backend: "claude-code", cwd: "/x", configDir: "/nope", sinceMs: Date.now(), transcriptFile: path.join(tmp(), "never.jsonl") },
    () => true,
    (l) => lines.push(l),
    0,
  );
  tail.poll();
  tail.poll();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /abcdef12 .*none found.*brief instead of resuming/);
});
