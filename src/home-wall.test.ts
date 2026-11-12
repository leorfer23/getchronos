/**
 * The home wall: a client profile reads only what it is let read under $HOME (home-wall.ts).
 *
 * The deny lists before it covered what someone remembered to name. These tests pin the opposite
 * shape: an unnamed path under $HOME is unreadable, the named ones are readable, and the per-workspace
 * denies that follow still win inside an allowed dir.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildProfile, sandboxAvailable, SANDBOX_EXEC } from "./sandbox.js";
import { ancestorsUnder, homeWallFor, walled } from "./home-wall.js";

const noSandbox = sandboxAvailable() ? false : "sandbox-exec is macOS-only";

describe("walled", () => {
  const home = "/Users/operator";
  test("every profile but the default one", () => {
    assert.equal(walled("acme", "/Users/operator/.claude-acme", home), true);
    assert.equal(walled("mine", path.join(os.homedir(), ".claude"), os.homedir()), false);
    assert.equal(walled("acme", null, home), false);
  });

  test("CHRONOS_HOME_WALL=off and CHRONOS_HOME_WALL_SKIP leave it off", () => {
    const prev = { w: process.env.CHRONOS_HOME_WALL, s: process.env.CHRONOS_HOME_WALL_SKIP };
    try {
      process.env.CHRONOS_HOME_WALL = "off";
      assert.equal(walled("acme", "/Users/operator/.claude-acme", home), false);
      delete process.env.CHRONOS_HOME_WALL;
      process.env.CHRONOS_HOME_WALL_SKIP = "lab, acme";
      assert.equal(walled("acme", "/Users/operator/.claude-acme", home), false);
      assert.equal(walled("globex", "/Users/operator/.claude-globex", home), true);
    } finally {
      if (prev.w === undefined) delete process.env.CHRONOS_HOME_WALL; else process.env.CHRONOS_HOME_WALL = prev.w;
      if (prev.s === undefined) delete process.env.CHRONOS_HOME_WALL_SKIP; else process.env.CHRONOS_HOME_WALL_SKIP = prev.s;
    }
  });
});

describe("homeWallFor", () => {
  let home: string;
  before(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-wall-")));
    fs.mkdirSync(path.join(home, ".claude-acme"));
    fs.mkdirSync(path.join(home, "personal"));
    // A link in the client's own config dir: that dir is the agent's to write, so it must not widen the wall.
    fs.symlinkSync(path.join(home, "personal"), path.join(home, ".claude-acme", "planted"));
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  const cfg = () => path.join(home, ".claude-acme");
  const ws = { slug: "acme" };

  test("a workspace with its own GitHub token reads its own gh dir, never the operator's login", () => {
    const w = homeWallFor(ws, cfg(), { GH_TOKEN: "t", GH_CONFIG_DIR: path.join(home, ".mc", "gh", "acme") }, [], home)!;
    assert.ok(w.allow.includes(path.join(home, ".mc", "gh", "acme")));
    assert.ok(!w.allow.includes(path.join(home, ".config", "gh")));
  });

  test("a workspace without a GitHub credential of its own uses the operator's login", () => {
    const w = homeWallFor(ws, cfg(), {}, [], home)!;
    assert.ok(w.allow.includes(path.join(home, ".config", "gh")));
  });

  test("its places and the config dirs its env names are allowed; links in its own config dir are not", () => {
    const repo = path.join(home, "code", "acme-api");
    const w = homeWallFor(ws, cfg(), { CURSOR_CONFIG_DIR: "~/.cursor-acme" }, [repo], home)!;
    assert.ok(w.allow.includes(repo));
    assert.ok(w.allow.includes(path.join(home, ".cursor-acme")));
    assert.ok(!w.allow.includes(path.join(home, "personal")));
    assert.ok(!w.allow.includes(home), "never $HOME itself");
  });

  test("the default profile is never walled", () => {
    assert.equal(homeWallFor(ws, path.join(os.homedir(), ".claude"), {}, [], os.homedir()), null);
  });
});

describe("ancestorsUnder", () => {
  test("$HOME and every dir down to each path, nothing above $HOME", () => {
    assert.deepEqual(
      ancestorsUnder(["/h/a/b/c", "/elsewhere/x"], "/h").sort(),
      ["/h", "/h/a", "/h/a/b"],
    );
  });
});

describe("the kernel enforces the wall", { skip: noSandbox }, () => {
  let home: string;
  before(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "home-wall-k-")));
    const w = (rel: string, body = "x") => {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), body);
    };
    w("code/acme/app.sql", "acme");
    w("code/acme/vendor/globex/secret.sql", "globex");
    w("Documents/personal/plan.md", "mine");
    w(".config/gh/hosts.yml", "operator token");
    w(".mc/gh/acme/config.yml", "acme gh");
    w(".claude/skills/x/SKILL.md", "skill");
    w(".zsh_history", "history");
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  const profile = () => buildProfile(
    "guard",
    path.join(home, "code", "acme"),
    [],
    path.join(home, ".claude-acme"),
    [path.join(home, "code", "acme", "vendor", "globex")], // another workspace's repo, nested in ours
    false, [], [],
    {
      home,
      allow: [path.join(home, ".mc", "gh", "acme"), path.join(home, ".claude", "skills")],
      noWrite: [path.join(home, ".claude")],
    },
  )!;
  const run = (bin: string, ...args: string[]) =>
    spawnSync(SANDBOX_EXEC, ["-p", profile(), bin, ...args], { cwd: path.join(home, "code", "acme"), encoding: "utf8" });
  const nested = (r: ReturnType<typeof run>) => /sandbox_apply/.test(r.stderr); // inside a guard Desk terminal

  test("allowed paths read; everything else under $HOME does not", () => {
    const ok = run("/bin/cat", path.join(home, "code", "acme", "app.sql"));
    if (nested(ok)) return;
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(run("/bin/cat", path.join(home, ".mc", "gh", "acme", "config.yml")).status, 0);
    assert.equal(run("/bin/cat", path.join(home, ".claude", "skills", "x", "SKILL.md")).status, 0);
    for (const f of ["Documents/personal/plan.md", ".config/gh/hosts.yml", ".zsh_history"])
      assert.notEqual(run("/bin/cat", path.join(home, f)).status, 0, `${f} must be walled off`);
    assert.notEqual(run("/bin/ls", home).status, 0, "$HOME itself is not listable");
  });

  test("another workspace's repo inside an allowed dir stays denied", () => {
    const r = run("/bin/cat", path.join(home, "code", "acme", "vendor", "globex", "secret.sql"));
    if (nested(r)) return;
    assert.notEqual(r.status, 0);
  });

  test("realpath walks down to an allowed path; the dirs on the way stay closed", () => {
    const r = run("/bin/realpath", path.join(home, "code", "acme", "app.sql"));
    if (nested(r)) return;
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(run("/bin/ls", path.join(home, "code")).status, 0);
  });

  test("the dirs the wall trusts are not the agent's to write", () => {
    const r = run("/usr/bin/touch", path.join(home, ".claude", "skills", "planted"));
    if (nested(r)) return;
    assert.notEqual(r.status, 0);
    assert.equal(run("/usr/bin/touch", path.join(home, "code", "acme", "new.sql")).status, 0, "its own repo stays writable");
  });
});
