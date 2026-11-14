/**
 * The Downloads wall, with real sandbox-exec (src/downloads.ts). The operator's ~/Downloads is shared by
 * every workspace, so each workspace's agents get their own folder there and nothing of anyone else's:
 * not a file, not a listing, not a folder before it exists, not a spelling in another case, and not the
 * folder a workspace had before it was renamed. Profiles are built the way a Desk terminal builds its
 * own (terminal.ts): its folder among the add-dirs, every other workspace's places in denyDirs.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before the store loads. The fixture sits under the temp dir, which strict grants wholesale: only the
// explicit denies can be what refuses these — the same denies that hold for a real ~/Downloads.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dl-sbx-")));
process.env.CHRONOS_DOWNLOADS_DIR = path.join(home, "Downloads");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { buildProfile, sandboxAvailable } = await import("./sandbox.js");
const { workspaces } = await import("./store.js");
const canSandbox = sandboxAvailable();

/** True when the profile lets `script` run to the end — every read and write in it allowed. */
function canRun(profile: string, script: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const t = Date.now();
const mkWs = (name: string, slug: string) =>
  workspaces.create({ slug: `${slug}-${t}`, name, config_dir: path.join(home, `.claude-${slug}`) } as any);
/** A Desk terminal of `ws` in `cwd`: its own folder granted, everyone else's places denied. */
const terminalProfile = (mode: "guard" | "strict", ws: { id: string }, cwd: string, cfg: string) =>
  buildProfile(mode, cwd, [workspaces.ensureDownloadsDir(ws.id)!], cfg, workspaces.isolationDenyDirs(ws.id))!;

test("each workspace writes and reads its own Downloads folder, and never touches another's", { skip: !canSandbox }, () => {
  const acme = mkWs("Acme", "acme");
  const globex = mkWs("Globex", "globex");
  const initech = mkWs("Initech", "initech"); // never spawned: its folder does not exist yet
  const theirs = workspaces.ensureDownloadsDir(globex.id)!;
  fs.writeFileSync(path.join(theirs, "q3-numbers.csv"), "client data");
  const notYet = workspaces.downloadsDirs().get(initech.id)!;
  assert.equal(fs.existsSync(notYet), false);
  const shouted = path.join(path.dirname(theirs), path.basename(theirs).toUpperCase());

  const work = path.join(home, "work");
  fs.mkdirSync(work, { recursive: true });
  for (const mode of ["guard", "strict"] as const) {
    // A terminal in a repo, and one that landed in $HOME (other places nested in its cwd are re-denied).
    for (const cwd of [work, home]) {
      const p = terminalProfile(mode, acme, cwd, path.join(home, ".claude-acme"));
      const mine = workspaces.downloadsDirs().get(acme.id)!;
      const tag = `${mode}, cwd ${cwd === home ? "$HOME" : "a repo"}`;
      assert.equal(canRun(p, `printf x > "${mine}/report.xlsx" && cat "${mine}/report.xlsx" && ls "${mine}"`), true, `${tag}: its own folder`);
      assert.equal(canRun(p, `cat "${theirs}/q3-numbers.csv"`), false, `${tag}: read another workspace's file`);
      assert.equal(canRun(p, `cat "${shouted}/q3-numbers.csv"`), false, `${tag}: read it through another case`);
      assert.equal(canRun(p, `ls "${theirs}"`), false, `${tag}: listed another workspace's folder`);
      assert.equal(canRun(p, `printf x > "${theirs}/planted.txt"`), false, `${tag}: wrote into another workspace's folder`);
      assert.equal(canRun(p, `mkdir -p "${notYet}"`), false, `${tag}: made the folder another workspace will get`);
    }
  }
  assert.equal(fs.existsSync(path.join(theirs, "planted.txt")), false);
  assert.equal(fs.existsSync(notYet), false);
  // The owner itself is not walled out of it.
  const own = terminalProfile("strict", globex, work, path.join(home, ".claude-globex"));
  assert.equal(canRun(own, `cat "${theirs}/q3-numbers.csv"`), true);
});

test("a renamed workspace's old folder stays walled from everyone else", { skip: !canSandbox }, () => {
  const acme = mkWs("Acme Two", "acme2");
  const hooli = mkWs("Hooli", "hooli");
  const old = workspaces.ensureDownloadsDir(hooli.id)!;
  fs.writeFileSync(path.join(old, "contract.pdf"), "client data");
  workspaces.update(hooli.id, { name: "Hooli Labs" } as any);
  const renamed = workspaces.ensureDownloadsDir(hooli.id)!;
  assert.notEqual(renamed, old);

  const work = path.join(home, "work2");
  fs.mkdirSync(work, { recursive: true });
  for (const mode of ["guard", "strict"] as const) {
    const p = terminalProfile(mode, acme, work, path.join(home, ".claude-acme2"));
    assert.equal(canRun(p, `cat "${old}/contract.pdf"`), false, `${mode}: read the folder it had before the rename`);
    assert.equal(canRun(p, `ls "${renamed}"`), false, `${mode}: listed its new folder`);
  }
});
