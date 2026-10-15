/**
 * `launcherProfile`: the wall a hand-started `claude-<client>` runs behind. One rule — outside
 * Chronos a client's CLI sees no more of the Mac than its Desk terminal does, plus none of the
 * other profiles' transcripts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { repos, workspaces } from "./store.js";
import { sandboxAvailable, SANDBOX_EXEC } from "./sandbox.js";
import { launcherProfile } from "./launcher-sandbox.js";

const noSandbox = sandboxAvailable() ? false : "sandbox-exec is macOS-only";

let tmp: string;
let mine: any;
let otherRepo: string;
let otherCfg: string;
let ownCfg: string;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-sb-")));
  const mk = (slug: string, sandbox_mode: string) =>
    workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: path.join(tmp, `cfg-${slug}`), sandbox_mode } as any);
  mine = mk("acme", "guard");
  const other = mk("globex", "guard");
  otherRepo = path.join(tmp, "globex-repo");
  fs.mkdirSync(otherRepo);
  fs.writeFileSync(path.join(otherRepo, "secret.sql"), "client data");
  repos.create({ workspace_id: other.id, name: "ml", path: otherRepo } as any);
  ownCfg = path.join(tmp, ".claude-acme");
  otherCfg = path.join(tmp, ".claude-globex");
  for (const d of [ownCfg, otherCfg]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(otherCfg, "history.jsonl"), "globex prompts");
  fs.writeFileSync(path.join(ownCfg, "settings.json"), "{}");
  CONFIG.profiles["claude-<client>-t"] = ownCfg;
  CONFIG.profiles["claude-globex-t"] = otherCfg;
});

after(() => {
  delete CONFIG.profiles["claude-<client>-t"];
  delete CONFIG.profiles["claude-globex-t"];
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("launcherProfile", () => {
  test("refuses a config dir that is not a known profile", () => {
    assert.throws(() => launcherProfile(mine.id, tmp), /not a known profile dir/);
  });

  test("names the other workspace's repo and the other profile dir as denied", { skip: noSandbox }, () => {
    const p = launcherProfile(mine.id, ownCfg)!;
    assert.match(p, /\(deny file-read\*[^)]*globex-repo/);
    assert.ok(p.includes(`(subpath "${otherCfg}")`));
  });

  test("the kernel enforces it: other client's repo and profile unreadable, own profile readable", { skip: noSandbox }, () => {
    const p = launcherProfile(mine.id, ownCfg)!;
    const cat = (f: string) => spawnSync(SANDBOX_EXEC, ["-p", p, "/bin/cat", f], { cwd: otherRepo, encoding: "utf8" });
    const r = cat(path.join(otherRepo, "secret.sql"));
    if (/sandbox_apply/.test(r.stderr)) return; // already inside a sandbox (guard Desk terminal) — cannot nest
    assert.notEqual(r.status, 0, "cwd inside another client's repo must not grant it");
    assert.notEqual(cat(path.join(otherCfg, "history.jsonl")).status, 0);
    assert.equal(cat(path.join(ownCfg, "settings.json")).status, 0);
  });

  test("a workspace whose floor is off gets no profile", () => {
    const off = workspaces.create({ slug: `off-${randomUUID().slice(0, 6)}`, name: "off", config_dir: path.join(tmp, "cfg-off"), sandbox_mode: "off" } as any);
    assert.equal(launcherProfile(off.id, ownCfg), null);
  });
});
