import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.CHRONOS_ACCEL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-status-root-"));

const { db, workspaces, repos, repoAccelerators } = await import("../store.js");
const { accelStatus } = await import("./status.js");
const { writeManifest, currentHead, configHashOf, manifestDir } = await import("./manifest.js");
const { versionOf } = await import("./detect.js");
const { parseToolVersion } = await import("./resolve-bin.js");

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-status-target-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  return dir;
}

let wsId = "";
let cfgDir = "";
beforeEach(() => {
  db.exec("DELETE FROM repo_accelerators; DELETE FROM repos; DELETE FROM workspaces;");
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-status-cfg-"));
  wsId = workspaces.create({ slug: "acme", name: "Acme", config_dir: cfgDir }).id;
});

test("a repo with nothing enabled reports every tool disabled, all freshness n/a except graphify=missing", () => {
  const repoPath = makeGitRepo();
  const repo = repos.create({ workspace_id: wsId, name: "r", path: repoPath });
  const ws = workspaces.get(wsId)!;
  const rows = accelStatus(repo, ws);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.enabled, false);
  assert.equal(rows.find((r) => r.tool === "graphify")!.freshness, "missing");
  assert.equal(rows.find((r) => r.tool === "ast-grep")!.freshness, "n/a");
  assert.equal(rows.find((r) => r.tool === "repomix")!.freshness, "n/a");
});

test("enabling a tool flips only that row's `enabled`, leaving detection/freshness independent", () => {
  const repoPath = makeGitRepo();
  const repo = repos.create({ workspace_id: wsId, name: "r", path: repoPath });
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "code-only");
  const rows = accelStatus(repo, workspaces.get(wsId)!);
  const graphify = rows.find((r) => r.tool === "graphify")!;
  assert.equal(graphify.enabled, true);
  assert.equal(graphify.mode, "code-only");
  assert.equal(rows.find((r) => r.tool === "ast-grep")!.enabled, false);
});

test("a manifest built at the current HEAD/version/mode is reflected as fresh; a mode change makes it stale", () => {
  const repoPath = makeGitRepo();
  const repo = repos.create({ workspace_id: wsId, name: "r", path: repoPath });
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "code-only");
  const graphifyVersion = parseToolVersion(versionOf("graphify").version);
  const dir = manifestDir(wsId, repo.id, "graphify");
  fs.mkdirSync(dir, { recursive: true });
  const body = "artifact";
  fs.writeFileSync(path.join(dir, "graph.json"), body);
  writeManifest({
    workspaceId: wsId, repoId: repo.id, tool: "graphify",
    head: currentHead(repoPath)!, toolVersion: graphifyVersion, configHash: configHashOf("code-only"),
    graphPath: "graph.json", bytes: Buffer.byteLength(body),
  });
  let graphify = accelStatus(repo, workspaces.get(wsId)!).find((r) => r.tool === "graphify")!;
  assert.equal(graphify.freshness, "fresh");

  // Flip the stored mode without touching HEAD — the manifest was built for "code-only".
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "full");
  graphify = accelStatus(repo, workspaces.get(wsId)!).find((r) => r.tool === "graphify")!;
  assert.equal(graphify.freshness, "stale");
});

test("graphify installed reflects the CLI probe, not the workspace's config_dir/skill file", () => {
  const repoPath = makeGitRepo();
  const repo = repos.create({ workspace_id: wsId, name: "r", path: repoPath });
  fs.mkdirSync(path.join(cfgDir, "skills", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "skills", "graphify", "SKILL.md"), "# graphify");
  const graphify = accelStatus(repo, workspaces.get(wsId)!).find((r) => r.tool === "graphify")!;
  // No real `graphify` binary in the test PATH — installed must stay false despite the skill file.
  assert.equal(graphify.installed, versionOf("graphify").installed);
  assert.match(graphify.detail!, /skill file present/);
});
