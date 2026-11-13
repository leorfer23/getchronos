/**
 * The operator's own Claude home, walled off from every agent that is not his (sandbox.ts claudeHomeWall),
 * on real `sandbox-exec`, guard AND strict, against a fixture HOME laid out like a real one:
 *  - an agent on a client's profile writes nothing in ~/.claude — not settings.json (whose hooks run in
 *    every one of his sessions), not a hook script, not a skill, not through a link — and not the file
 *    behind a link in it either (a dotfiles settings file, a skill kept in ~/.agents/skills);
 *  - it reads only what a client profile takes from it: the skills, commands, CLAUDE.md its own links
 *    point at (two hops included), hook scripts its settings run, CHRONOS_CLAUDE_SHARED_EXTRA — never his
 *    settings, transcripts or prompt history, nor his ~/.codex or ~/.claude.json;
 *  - no re-grant reopens it (cwd = $HOME, ~/.claude as an add-dir, $HOME as a read-only tier); a
 *    workspace's sandbox_allow naming a path in it is the one way back in;
 *  - his own profile keeps all of it, and so does a workspace of his on a sibling login (a mirror that
 *    links his settings and transcripts) — the same login on behalf of a client does not;
 *  - the real `claude` starts and saves its config under the wall, when it is installed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Outside the temp dirs strict mode grants wholesale (/private/tmp, /private/var/folders): under them a
// strict profile's MISSING grant would go unnoticed. /Users/Shared is world-writable on every Mac.
function fixtureRoot(): string {
  for (const base of ["/Users/Shared", os.tmpdir()]) {
    try {
      return fs.realpathSync(fs.mkdtempSync(path.join(base, "chronos-home-wall-")));
    } catch { /* next */ }
  }
  throw new Error("nowhere to put a fixture home");
}
const root = fixtureRoot();
const home = path.join(root, "home");
// Before sandbox.ts / config.ts load: both read HOME and the extras once, at import.
process.env.HOME = home;
process.env.CHRONOS_CLAUDE_SHARED_EXTRA = "mcp-launch.sh";
after(() => fs.rmSync(root, { recursive: true, force: true }));

const C = path.join(home, ".claude");
const acme = path.join(home, ".claude-acme");
const alt = path.join(home, ".claude-alt");
const work = path.join(home, "work");
const put = (f: string, body = "x", mode?: number) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, mode ? { mode } : {});
};
const link = (target: string, at: string) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
};
// His home.
put(path.join(C, "settings.json"), '{"hooks":{}}');
put(path.join(C, "CLAUDE.md"), "his instructions");
put(path.join(C, "RULES.md"), "imported rules");
put(path.join(C, "skills", "direct", "SKILL.md"), "direct skill");
put(path.join(home, ".agents", "skills", "linked", "SKILL.md"), "skill kept in ~/.agents");
link(path.join(home, ".agents", "skills", "linked"), path.join(C, "skills", "linked"));
put(path.join(C, "commands", "c.md"), "a command");
put(path.join(C, "hooks", "h.sh"), "#!/bin/sh\necho hook-ran\n", 0o755);
put(path.join(C, "projects", "-Users-x-globex", "t.jsonl"), "globex transcript");
put(path.join(C, "history.jsonl"), "every prompt");
put(path.join(C, "mcp-launch.sh"), "#!/bin/sh\necho launcher\n", 0o755);
put(path.join(C, "private.sh"), "#!/bin/sh\necho private\n", 0o755);
put(path.join(home, "dotfiles", "settings.local.json"), '{"env":{"TOKEN":"dotfiles-secret"}}');
link(path.join(home, "dotfiles", "settings.local.json"), path.join(C, "settings.local.json"));
put(path.join(home, ".codex", "auth.json"), "chatgpt login");
put(path.join(home, ".claude.json"), '{"mcpServers":{}}');
// A client's profile, linked into his the way client profiles are.
link(path.join(C, "skills", "direct"), path.join(acme, "skills", "direct"));
link(path.join(C, "skills", "linked"), path.join(acme, "skills", "linked")); // two hops: → ~/.claude → ~/.agents
link(path.join(C, "commands"), path.join(acme, "commands"));
link(path.join(C, "CLAUDE.md"), path.join(acme, "CLAUDE.md"));
link(path.join(C, "projects"), path.join(acme, "sneaky"));
// His second login, kept in parity by linking his files (profile-route.ts siblings).
link(path.join(C, "settings.json"), path.join(alt, "settings.json"));
link(path.join(C, "projects"), path.join(alt, "projects"));
fs.mkdirSync(work, { recursive: true });

const { buildProfile, claudeHomeShared, sandboxAvailable, workspaceSandboxAllow, SANDBOX_EXEC } = await import("./sandbox.js");
const { workspaces } = await import("./store.js");
const { REPO_ROOT } = await import("./repo-root.js");

const nests = sandboxAvailable() && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const skip = nests ? false : "needs sandbox-exec, and a parent that lets it nest";

const t = Date.now();
const client = workspaces.create({ slug: `wall-client-${t}`, name: "Acme", config_dir: acme } as any);
const mine = workspaces.create({ slug: `wall-mine-${t}`, name: "Mine", config_dir: C } as any);
const clientDeny = () => workspaces.isolationDenyDirs(client.id);
const MODES = ["guard", "strict"] as const;

function sh(profile: string, script: string, cwd = work): { ok: boolean; out: string } {
  const r = spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", script], { cwd, encoding: "utf8", timeout: 15_000 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
const cat = (f: string) => `cat ${JSON.stringify(f)}`;
const write = (f: string) => `printf pwned >> ${JSON.stringify(f)}`;
const realpathJs = (p: string, native = false) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("fs").realpathSync${native ? ".native" : ""}(${JSON.stringify(p)})`)}`;

function assertDenied(profile: string, what: string, script: string) {
  const r = sh(profile, script);
  assert.equal(r.ok, false, `${what} must be refused:\n${r.out}`);
  assert.match(r.out, /not permitted/i, what);
}
function assertAllowed(profile: string, what: string, script: string): string {
  const r = sh(profile, script);
  assert.equal(r.ok, true, `${what} must work:\n${r.out}`);
  return r.out;
}

test("what may be read is the shared part: instructions and extensions, never his settings or history", () => {
  for (const rel of ["CLAUDE.md", "RULES.md", "skills/x/SKILL.md", "commands/c.md", "agents/a.md", "output-styles/s.md", "rules/r.md", "workflows/w.js", "hooks/h.sh", "mcp-launch.sh"])
    assert.equal(claudeHomeShared(rel), true, rel);
  for (const rel of ["settings.json", "settings.local.json", "projects/p/t.jsonl", "history.jsonl", "plugins/x", "agent-memory/a", "todos/x", "private.sh", "projects/notes.md", "../.ssh/id"])
    assert.equal(claudeHomeShared(rel), false, rel);
  // An extra outside ~/.claude is dropped, not honoured.
  assert.equal(claudeHomeShared("anything", ["../.ssh"]), false);
});

test("an agent on a client's profile writes nothing in ~/.claude, nor behind a link in it", { skip }, () => {
  const before = new Map([path.join(C, "settings.json"), path.join(C, "hooks", "h.sh"), path.join(home, ".agents", "skills", "linked", "SKILL.md"), path.join(home, "dotfiles", "settings.local.json")].map((f) => [f, fs.readFileSync(f, "utf8")]));
  for (const mode of MODES) {
    const p = buildProfile(mode, work, [], acme, clientDeny())!;
    assertDenied(p, `${mode}: settings.json (its hooks run in his sessions)`, write(path.join(C, "settings.json")));
    assertDenied(p, `${mode}: a transcript`, `mkdir -p ${JSON.stringify(path.join(C, "projects", "x"))} && ${write(path.join(C, "projects", "x", "t.jsonl"))}`);
    assertDenied(p, `${mode}: a new hook script`, write(path.join(C, "hooks", "new.sh")));
    assertDenied(p, `${mode}: an existing hook script`, write(path.join(C, "hooks", "h.sh")));
    assertDenied(p, `${mode}: a new skill`, `mkdir ${JSON.stringify(path.join(C, "skills", `new-${mode}`))}`);
    assertDenied(p, `${mode}: a command, through the client's own link to the dir`, write(path.join(acme, "commands", "new.md")));
    assertDenied(p, `${mode}: a skill, through the client's per-entry link`, write(path.join(acme, "skills", "direct", "SKILL.md")));
    assertDenied(p, `${mode}: the skill file behind his link (~/.agents/skills)`, write(path.join(home, ".agents", "skills", "linked", "SKILL.md")));
    assertDenied(p, `${mode}: the dotfiles file behind his settings.local.json link`, write(path.join(home, "dotfiles", "settings.local.json")));
    assertDenied(p, `${mode}: his ~/.claude.json`, write(path.join(home, ".claude.json")));
    assertDenied(p, `${mode}: his ~/.codex`, write(path.join(home, ".codex", "auth.json")));
    // Its own places still take writes.
    assertAllowed(p, `${mode}: its cwd and its own profile`, `printf ok > ok-${mode} && printf ok > ${JSON.stringify(path.join(acme, `ok-${mode}`))}`);
  }
  for (const [f, body] of before) assert.equal(fs.readFileSync(f, "utf8"), body, `${f} changed on disk`);
  assert.equal(fs.existsSync(path.join(C, "hooks", "new.sh")), false);
});

test("…and reads only what its own links and settings take from it", { skip }, () => {
  for (const mode of MODES) {
    const p = buildProfile(mode, work, [], acme, clientDeny())!;
    assert.match(assertAllowed(p, `${mode}: a skill through its link`, cat(path.join(acme, "skills", "direct", "SKILL.md"))), /direct skill/);
    assert.match(assertAllowed(p, `${mode}: a skill two links away (→ ~/.claude/skills → ~/.agents)`, cat(path.join(acme, "skills", "linked", "SKILL.md"))), /~\/\.agents/);
    assert.match(assertAllowed(p, `${mode}: CLAUDE.md through its link`, cat(path.join(acme, "CLAUDE.md"))), /his instructions/);
    assertAllowed(p, `${mode}: a file CLAUDE.md imports`, cat(path.join(C, "RULES.md")));
    assertAllowed(p, `${mode}: a command through its link to the dir`, cat(path.join(acme, "commands", "c.md")));
    assert.match(assertAllowed(p, `${mode}: a hook script its settings run`, JSON.stringify(path.join(C, "hooks", "h.sh"))), /hook-ran/);
    assert.match(assertAllowed(p, `${mode}: a script named in CHRONOS_CLAUDE_SHARED_EXTRA`, JSON.stringify(path.join(C, "mcp-launch.sh"))), /launcher/);
    assertAllowed(p, `${mode}: realpath through ~/.claude (JS)`, realpathJs(path.join(acme, "skills", "direct")));
    assertAllowed(p, `${mode}: realpath through ~/.claude (native)`, realpathJs(path.join(acme, "skills", "direct"), true));
    assertDenied(p, `${mode}: his settings.json`, cat(path.join(C, "settings.json")));
    assertDenied(p, `${mode}: another workspace's transcript`, cat(path.join(C, "projects", "-Users-x-globex", "t.jsonl")));
    assertDenied(p, `${mode}: the same transcript through a link it made`, cat(path.join(acme, "sneaky", "-Users-x-globex", "t.jsonl")));
    assertDenied(p, `${mode}: his prompt history`, cat(path.join(C, "history.jsonl")));
    assertDenied(p, `${mode}: a listing of ~/.claude`, `ls ${JSON.stringify(C)}`);
    assertDenied(p, `${mode}: a listing of his projects`, `ls ${JSON.stringify(path.join(C, "projects"))}`);
    assertDenied(p, `${mode}: a script of his not shared`, cat(path.join(C, "private.sh")));
    assertDenied(p, `${mode}: the dotfiles file behind his settings.local.json`, cat(path.join(home, "dotfiles", "settings.local.json")));
    assertDenied(p, `${mode}: his ~/.codex`, cat(path.join(home, ".codex", "auth.json")));
    assertDenied(p, `${mode}: his ~/.claude.json`, cat(path.join(home, ".claude.json")));
  }
});

test("no re-grant reopens it: cwd = $HOME, ~/.claude as an add-dir, $HOME as a read-only tier", { skip }, () => {
  for (const mode of MODES) {
    const p = buildProfile(mode, home, [C], acme, clientDeny(), false, [home])!;
    assertDenied(p, `${mode}: settings.json`, write(path.join(C, "settings.json")));
    assertDenied(p, `${mode}: the read-only tier's .claude/worktrees re-grant`, `mkdir -p ${JSON.stringify(path.join(C, "worktrees", "x"))}`);
    assertDenied(p, `${mode}: a transcript`, cat(path.join(C, "projects", "-Users-x-globex", "t.jsonl")));
    assertDenied(p, `${mode}: ~/.codex`, cat(path.join(home, ".codex", "auth.json")));
    assertAllowed(p, `${mode}: a skill`, cat(path.join(acme, "skills", "direct", "SKILL.md")));
  }
});

test("a workspace's sandbox_allow naming a path in it is the one way back in — that path, nothing else", { skip }, () => {
  const allow = workspaceSandboxAllow(JSON.stringify(["~/.claude/projects"]));
  assert.deepEqual(allow, [path.join(C, "projects")]);
  for (const mode of MODES) {
    const p = buildProfile(mode, work, [], acme, clientDeny(), false, [], allow)!;
    assertAllowed(p, `${mode}: the named path, read`, cat(path.join(C, "projects", "-Users-x-globex", "t.jsonl")));
    assertAllowed(p, `${mode}: the named path, write`, `printf x > ${JSON.stringify(path.join(C, "projects", `allowed-${mode}`))}`);
    assertDenied(p, `${mode}: the rest stays walled`, write(path.join(C, "settings.json")));
  }
});

test("his own profile keeps all of it; so does a workspace of his on a sibling login — not a client's", { skip }, () => {
  const settings = path.join(C, "settings.json");
  const before = fs.readFileSync(settings, "utf8");
  for (const mode of MODES) {
    const own = buildProfile(mode, work, [], C, workspaces.isolationDenyDirs(mine.id))!;
    assertAllowed(own, `${mode}: his settings, transcripts, history and ~/.codex`, [settings, path.join(C, "projects", "-Users-x-globex", "t.jsonl"), path.join(C, "history.jsonl"), path.join(home, ".codex", "auth.json")].map(cat).join(" && "));
    assertAllowed(own, `${mode}: writes in his ~/.claude`, `${write(settings)} && printf x > ${JSON.stringify(path.join(C, "projects", `own-${mode}`))}`);
    fs.writeFileSync(settings, before);
    // A walled client account routed onto his profile runs ON it (#103): same.
    assertAllowed(buildProfile(mode, work, [], C, clientDeny())!, `${mode}: a client account routed onto his profile`, cat(settings));
    // His workspace moved to his second login (a mirror that links his settings and transcripts).
    const sibling = buildProfile(mode, work, [], alt, workspaces.isolationDenyDirs(mine.id), false, [], [], { pinnedDir: C })!;
    assertAllowed(sibling, `${mode}: his workspace on his sibling login reads through the mirror`, cat(path.join(alt, "settings.json")));
    assertAllowed(sibling, `${mode}: …and writes its transcript through it`, `printf x > ${JSON.stringify(path.join(alt, "projects", `sibling-${mode}`))}`);
    // The same login on behalf of a client is walled like any other profile.
    const theirs = buildProfile(mode, work, [], alt, clientDeny(), false, [], [], { pinnedDir: acme })!;
    assertDenied(theirs, `${mode}: a client's workspace on that login`, cat(path.join(alt, "settings.json")));
    assertDenied(theirs, `${mode}: …nor writes through it`, `printf x > ${JSON.stringify(path.join(alt, "projects", `theirs-${mode}`))}`);
  }
  assert.equal(fs.readFileSync(settings, "utf8"), before);
});

// The real CLI, when this machine has one (never on CI: test-setup.mjs stubs it first on PATH). Each run
// gets CLAUDE_CONFIG_DIR, so its keychain item is named after a fixture dir (parity-env.ts) and the
// person's own login is never looked up.
function realClaude(): string | null {
  const stub = path.join(REPO_ROOT, "scripts", "test-bin");
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || path.resolve(dir) === stub) continue;
    const bin = path.join(dir, "claude");
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, env: { PATH: "/usr/bin:/bin", HOME: home } });
      if (/Claude Code/.test(v.stdout)) return fs.realpathSync(bin);
    } catch { /* next */ }
  }
  return null;
}
const claude = nests ? realClaude() : null;

test("the real claude starts on a client's profile under the wall, and saves its config in that profile", { skip: claude ? false : "no real claude CLI on this machine" }, () => {
  const env = {
    PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: acme,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const run = (profile: string, args: string[]) => spawnSync(SANDBOX_EXEC, ["-p", profile, claude!, ...args], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
  const ownConfig = fs.readFileSync(path.join(home, ".claude.json"), "utf8");
  for (const mode of MODES) {
    const p = buildProfile(mode, work, [], acme, clientDeny())!;
    const v = run(p, ["--version"]);
    assert.equal(v.status, 0, `${mode}: claude --version\n${v.stdout}${v.stderr}`);
    assert.match(v.stdout, /Claude Code/);
    const add = run(p, ["mcp", "add-json", "--scope", "user", `wall-${mode}`, '{"command":"true"}']);
    assert.equal(add.status, 0, `${mode}: claude mcp add-json\n${add.stdout}${add.stderr}`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(acme, ".claude.json"), "utf8")).mcpServers?.[`wall-${mode}`], `${mode}: saved in the client's profile`);
  }
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf8"), ownConfig, "his ~/.claude.json untouched");
  assert.equal(fs.readFileSync(path.join(C, "settings.json"), "utf8"), '{"hooks":{}}');
});

test("the real claude on his own profile still saves into his ~/.claude", { skip: claude ? false : "no real claude CLI on this machine" }, () => {
  // The default profile in its separate mode (CLAUDE_CONFIG_DIR=~/.claude → ~/.claude/.claude.json): what
  // the real binary writes in his own Claude home. Its own-home mode (~/.claude.json, with claude's lock
  // and temp file beside it) is covered with the same profile in sandbox-own-home.test.ts.
  const env = {
    PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: C,
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const mode of MODES) {
    const p = buildProfile(mode, work, [], C, workspaces.isolationDenyDirs(mine.id))!;
    const add = spawnSync(SANDBOX_EXEC, ["-p", p, claude!, "mcp", "add-json", "--scope", "user", `own-${mode}`, '{"command":"true"}'], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(add.status, 0, `${mode}: claude mcp add-json\n${add.stdout}${add.stderr}`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(C, ".claude.json"), "utf8")).mcpServers?.[`own-${mode}`], `${mode}: saved in his ~/.claude`);
  }
});
