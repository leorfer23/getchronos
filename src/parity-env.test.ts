/**
 * parity-env.ts against fixture homes: which config a profile resolves to, and the one-time, merge-only
 * switch of the default profile onto the person's own Claude Code setup. The first two tests are the
 * live install's exact shape — agents relying on `fff` and `slack` that only the Chronos-written
 * `~/.claude/.claude.json` has — and pin that boot never takes them away and the explicit switch carries
 * them over without touching anything of the person's.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMerge,
  claudeConfigLock,
  claudeGlobalConfig,
  claudeHomeEnv,
  claudeHomeVerdict,
  claudeOwnHome,
  codexHome,
  codexHomeEnv,
  dropInheritedClaudeHome,
  needsSignIn,
  parityStateFile,
  prepareClaudeHome,
  readParityState,
  sameDef,
  switchClaudeHome,
  updateClaudeConfig,
  withClaudeHome,
} from "./parity-env.js";

const homes: string[] = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const FFF = { type: "stdio", command: "/home/op/.mc/bin/fff-mcp.sh", args: ["/opt/homebrew/bin/fff-mcp"] };
const SLACK = { type: "http", url: "https://mcp.slack.com/mcp", oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 } };
const X = { type: "stdio", command: "/usr/local/bin/x-mcp", args: ["--stdio"] };
const Y = { type: "http", url: "https://y.example.com/mcp" };

type Json = Record<string, unknown> | string;
function fixture(o: { own?: Json; legacy?: Json; env?: NodeJS.ProcessEnv } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parity-env-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, ".claude"));
  const write = (f: string, v: Json) => fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 2));
  const ownFile = path.join(home, ".claude.json");
  const legacyFile = path.join(home, ".claude", ".claude.json");
  if (o.own !== undefined) write(ownFile, o.own);
  if (o.legacy !== undefined) write(legacyFile, o.legacy);
  const opts = { home, stateFile: path.join(home, "chronos-state", "parity.json"), env: o.env ?? {} };
  return { home, dir: path.join(home, ".claude"), ownFile, legacyFile, opts, read: (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) };
}

/** The live install: x, y in the person's own config; fff + slack only in the Chronos-written one. */
const liveInstall = () =>
  fixture({
    own: { numStartups: 41, oauthAccount: { accountUuid: "acct-1" }, mcpServers: { x: X, y: Y }, projects: { "/work/acme": { hasTrustDialogAccepted: true } } },
    legacy: { oauthAccount: { accountUuid: "acct-1" }, mcpServers: { fff: FFF, slack: SLACK }, projects: { "/work/acme": { hasTrustDialogAccepted: true } } },
  });

test("boot never takes fff or slack away from an install whose agents rely on them", () => {
  const f = liveInstall();
  const ownBefore = fs.readFileSync(f.ownFile, "utf8");
  const legacyBefore = fs.readFileSync(f.legacyFile, "utf8");
  const r = prepareClaudeHome(f.opts);
  assert.equal(r.action, "separate", "slack's sign-in lives in the Chronos-only keychain item: no automatic switch");
  assert.match(r.detail, /slack would need a new sign-in/);
  // Exactly what agents had before: the same env (so the same login + MCP tokens) and the same file.
  assert.deepEqual(claudeHomeEnv(f.dir, f.opts), { CLAUDE_CONFIG_DIR: f.dir });
  assert.equal(claudeGlobalConfig(f.dir, f.opts), f.legacyFile);
  assert.deepEqual(Object.keys(f.read(f.legacyFile).mcpServers).sort(), ["fff", "slack"]);
  assert.equal(fs.readFileSync(f.ownFile, "utf8"), ownBefore, "the person's own config is not touched");
  assert.equal(fs.readFileSync(f.legacyFile, "utf8"), legacyBefore);
  assert.equal(fs.existsSync(f.opts.stateFile), false, "nothing recorded");
});

test("the switch copies fff and slack into ~/.claude.json merge-only, keeps every other key, and names slack's one sign-in", () => {
  const f = liveInstall();
  const legacyBefore = fs.readFileSync(f.legacyFile, "utf8");
  const r = switchClaudeHome("fix", f.opts);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.copied.sort(), ["fff", "slack"]);
  assert.deepEqual(r.signIn, ["slack"], "OAuth tokens are not in .claude.json — slack needs `claude mcp login slack` once");
  assert.deepEqual(r.conflicts, []);
  const own = f.read(f.ownFile);
  assert.deepEqual(Object.keys(own.mcpServers).sort(), ["fff", "slack", "x", "y"]);
  assert.deepEqual(own.mcpServers.fff, FFF);
  assert.deepEqual(own.mcpServers.slack, SLACK);
  assert.deepEqual(own.mcpServers.x, X, "the person's own servers are untouched");
  assert.equal(own.numStartups, 41);
  assert.deepEqual(own.oauthAccount, { accountUuid: "acct-1" });
  assert.deepEqual(own.projects, { "/work/acme": { hasTrustDialogAccepted: true } });
  assert.equal(fs.readFileSync(f.legacyFile, "utf8"), legacyBefore, "the old config is never deleted from");
  // From now on agents start exactly like a plain terminal: no CLAUDE_CONFIG_DIR, ~/.claude.json.
  assert.equal(claudeOwnHome(f.dir, f.opts), true);
  assert.deepEqual(claudeHomeEnv(f.dir, f.opts), {});
  assert.equal(claudeGlobalConfig(f.dir, f.opts), f.ownFile);
  const env = withClaudeHome({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/somewhere/else" }, f.dir, f.opts);
  assert.equal("CLAUDE_CONFIG_DIR" in env, false, "an inherited CLAUDE_CONFIG_DIR is removed, not just not added");
  assert.equal(env.PATH, "/bin");
  assert.equal(readParityState(f.opts).claude?.via, "fix");
  // Recorded once, never flips back on its own; a second switch copies nothing.
  assert.equal(prepareClaudeHome(f.opts).action, "own");
  assert.deepEqual(switchClaudeHome("fix", f.opts).copied, []);
});

test("boot switches by itself when nothing would be lost: stdio servers copied, same account", () => {
  const f = fixture({
    own: { oauthAccount: { accountUuid: "acct-1" }, mcpServers: { x: X } },
    legacy: { oauthAccount: { accountUuid: "acct-1" }, mcpServers: { fff: FFF } },
  });
  const r = prepareClaudeHome(f.opts);
  assert.equal(r.action, "switched");
  assert.deepEqual(Object.keys(f.read(f.ownFile).mcpServers).sort(), ["fff", "x"]);
  assert.equal(readParityState(f.opts).claude?.via, "auto");
});

test("a fresh install (no Chronos-written config) starts on the person's own setup and writes nothing of theirs", () => {
  const f = fixture({ own: { mcpServers: { x: X } } });
  const before = fs.readFileSync(f.ownFile, "utf8");
  assert.equal(prepareClaudeHome(f.opts).action, "switched");
  assert.equal(fs.readFileSync(f.ownFile, "utf8"), before);
  assert.deepEqual(claudeHomeEnv(f.dir, f.opts), {});
});

test("a same-named server with another definition is a conflict: theirs is kept, never overwritten", () => {
  const theirs = { type: "http", url: "https://other-slack.example.com/mcp" };
  const f = fixture({ own: { mcpServers: { slack: theirs } }, legacy: { mcpServers: { fff: FFF, slack: SLACK } } });
  const r = switchClaudeHome("fix", f.opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.copied, ["fff"]);
  assert.deepEqual(r.conflicts, ["slack"]);
  assert.deepEqual(f.read(f.ownFile).mcpServers.slack, theirs);
});

test("no automatic switch onto a signed-out or different account", () => {
  const signedOut = fixture({ own: { mcpServers: {} }, legacy: { oauthAccount: { accountUuid: "acct-1" }, mcpServers: { fff: FFF } } });
  assert.equal(claudeHomeVerdict(signedOut.opts).account, "signed-out");
  assert.equal(prepareClaudeHome(signedOut.opts).action, "separate");
  const other = fixture({ own: { oauthAccount: { accountUuid: "acct-2" } }, legacy: { oauthAccount: { accountUuid: "acct-1" } } });
  assert.equal(claudeHomeVerdict(other.opts).account, "different");
  assert.equal(prepareClaudeHome(other.opts).action, "separate");
});

test("an unreadable ~/.claude.json is never rewritten from nothing, and nothing is recorded", () => {
  const f = fixture({ own: "{not json", legacy: { mcpServers: { fff: FFF } } });
  const r = switchClaudeHome("fix", f.opts);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(f.ownFile, "utf8"), "{not json");
  assert.equal(claudeOwnHome(f.dir, f.opts), false);
});

test("per-project servers move into the same project entry, next to what is already there", () => {
  const f = fixture({
    own: { projects: { "/work/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash(ls)"] } } },
    legacy: { projects: { "/work/app": { mcpServers: { db: X } }, "/work/other": { mcpServers: { y: Y } } } },
  });
  assert.equal(switchClaudeHome("fix", f.opts).ok, true);
  const p = f.read(f.ownFile).projects;
  assert.deepEqual(p["/work/app"].mcpServers, { db: X });
  assert.equal(p["/work/app"].hasTrustDialogAccepted, true);
  assert.deepEqual(p["/work/app"].allowedTools, ["Bash(ls)"]);
  assert.deepEqual(p["/work/other"].mcpServers, { y: Y });
});

test("named profiles stay separate whatever is recorded; CHRONOS_CLAUDE_OWN_HOME=0 is the way back", () => {
  const f = fixture({ own: {}, legacy: {} });
  assert.equal(switchClaudeHome("fix", f.opts).ok, true);
  const acme = path.join(f.home, ".claude-acme");
  fs.mkdirSync(acme);
  assert.equal(claudeOwnHome(acme, f.opts), false);
  assert.equal(claudeGlobalConfig(acme, f.opts), path.join(acme, ".claude.json"));
  assert.deepEqual(claudeHomeEnv(acme, f.opts), { CLAUDE_CONFIG_DIR: acme });
  const off = { ...f.opts, env: { CHRONOS_CLAUDE_OWN_HOME: "0" } };
  assert.equal(claudeOwnHome(f.dir, off), false);
  assert.deepEqual(claudeHomeEnv(f.dir, off), { CLAUDE_CONFIG_DIR: f.dir });
});

test("definitions compare the way claude stores them; remote servers without a credential need a sign-in", () => {
  assert.ok(sameDef({ command: "x" }, { type: "stdio", command: "x", args: [] }), "add-json fills in args and type");
  assert.ok(sameDef({ command: "x", env: {} }, { command: "x" }));
  assert.ok(!sameDef({ command: "x", args: ["a"] }, { command: "x", args: ["b"] }));
  assert.equal(needsSignIn(SLACK), true);
  assert.equal(needsSignIn(Y), true);
  assert.equal(needsSignIn({ type: "http", url: "https://z", headers: { Authorization: "Bearer t" } }), false);
  assert.equal(needsSignIn(FFF), false);
});

test("applyMerge re-checks the file as it is now: a server added meanwhile is not replaced", () => {
  const f = fixture({ own: { mcpServers: {} } });
  fs.writeFileSync(f.ownFile, JSON.stringify({ mcpServers: { fff: { command: "/their/fff" } } }));
  const r = applyMerge([{ name: "fff", def: FFF }], f.ownFile);
  assert.deepEqual(r.conflicts, ["fff"]);
  assert.deepEqual(f.read(f.ownFile).mcpServers.fff, { command: "/their/fff" });
});

test("codex: the default profile runs on the person's own ~/.codex unless an older Chronos login would be stranded", () => {
  const f = fixture();
  const codex = path.join(f.home, ".codex");
  assert.equal(codexHome(f.dir, f.opts), codex);
  assert.deepEqual(codexHomeEnv(f.dir, f.opts), {});
  fs.writeFileSync(path.join(f.dir, "auth.json"), "{}"); // a login an older Chronos made under CODEX_HOME=~/.claude
  assert.equal(codexHome(f.dir, f.opts), f.dir);
  assert.deepEqual(codexHomeEnv(f.dir, f.opts), { CODEX_HOME: f.dir });
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, "auth.json"), "{}");
  assert.equal(codexHome(f.dir, f.opts), codex, "signed in on their own: their home wins");
  assert.equal(codexHome(f.dir, { ...f.opts, env: { CHRONOS_CODEX_OWN_HOME: "0" } }), f.dir);
  const acme = path.join(f.home, ".claude-acme");
  assert.deepEqual(codexHomeEnv(acme, f.opts), { CODEX_HOME: acme }, "a client profile keeps its own Codex home");
});

test("the backends spawn with what parity-env decides (HOME pointed at a fixture)", async () => {
  const f = fixture({ own: {}, legacy: {} });
  const prevHome = process.env.HOME;
  process.env.HOME = f.home;
  const state = parityStateFile();
  try {
    const { claudeBackend } = await import("./backends/claude.js");
    const { codexBackend } = await import("./backends/codex.js");
    assert.deepEqual(claudeBackend.env({} as any, f.dir), { CLAUDE_CONFIG_DIR: f.dir, CLAUDE_CODE_ARTIFACT: "1" }, "not switched yet: as before");
    assert.equal(switchClaudeHome("fix", { home: f.home, env: {} }).ok, true); // records into the test state file
    assert.deepEqual(claudeBackend.env({} as any, f.dir), { CLAUDE_CODE_ARTIFACT: "1" });
    assert.deepEqual(claudeBackend.oneShot({ prompt: "p", configDir: f.dir } as any).env, {});
    const acme = path.join(f.home, ".claude-acme");
    assert.deepEqual(claudeBackend.env({} as any, acme), { CLAUDE_CONFIG_DIR: acme, CLAUDE_CODE_ARTIFACT: "1" });
    assert.deepEqual(codexBackend.env({} as any, f.dir), {}, "codex on ~/.codex, like the terminal");
    assert.deepEqual(codexBackend.env({} as any, acme), { CODEX_HOME: acme });
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(state, { force: true });
  }
});

test("writes go through claude's own lock: Chronos waits briefly, builds on what claude saved meanwhile, never steals the lock", async () => {
  const f = fixture({ own: { numStartups: 1 } });
  const lock = claudeConfigLock(f.ownFile);
  assert.equal(lock, `${f.ownFile}.lock`, "the directory claude's proper-lockfile takes");
  // claude holds the lock, saves its own change, lets go — while Chronos is waiting for it.
  const saved = path.join(f.home, "claude-save.json");
  fs.writeFileSync(saved, JSON.stringify({ numStartups: 2, mcpServers: { added: { command: "c" } } }));
  fs.mkdirSync(lock);
  const claude = spawn("/bin/sh", ["-c", `sleep 0.05; cp "${saved}" "${f.ownFile}"; rmdir "${lock}"`], { stdio: "ignore" });
  const r = updateClaudeConfig(f.ownFile, (cur) => ({ ...cur, chronos: true }), [50, 100, 200, 400, 800, 1600]);
  await new Promise((res) => claude.on("exit", res));
  assert.equal(r, "written");
  const got = f.read(f.ownFile);
  assert.equal(got.numStartups, 2, "built on claude's save, not on what was there before it");
  assert.deepEqual(got.mcpServers, { added: { command: "c" } });
  assert.equal(got.chronos, true);
  assert.equal(fs.existsSync(lock), false, "released");
  // Held past the short waits: nothing written, and the holder's lock is left where it is.
  fs.mkdirSync(lock);
  const before = fs.readFileSync(f.ownFile, "utf8");
  assert.equal(updateClaudeConfig(f.ownFile, (cur) => ({ ...cur, again: true }), [5, 5]), "busy");
  assert.equal(fs.readFileSync(f.ownFile, "utf8"), before);
  assert.equal(fs.existsSync(lock), true, "never removes a lock it did not make");
  // The switch says why it could not copy, and records nothing.
  fs.writeFileSync(f.legacyFile, JSON.stringify({ mcpServers: { fff: FFF } }));
  const s = switchClaudeHome("fix", f.opts);
  assert.equal(s.ok, false);
  assert.match(s.error ?? "", /claude is saving it right now/);
  assert.equal(claudeOwnHome(f.dir, f.opts), false);
  fs.rmdirSync(lock);
});

test("trust under a held lock is skipped with a warning, the file untouched; an already-trusted folder never takes the lock", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parity-trust-"));
  homes.push(home);
  const cfgDir = path.join(home, ".claude-acme");
  fs.mkdirSync(cfgDir);
  const file = path.join(cfgDir, ".claude.json");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parity-trust-cwd-"));
  homes.push(cwd);
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  const { ensureTrustedCwd, trustKeys } = await import("./claude-trust.js");
  fs.mkdirSync(claudeConfigLock(file));
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    assert.equal(ensureTrustedCwd(cfgDir, cwd), "skipped");
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((w) => /its lock is held/.test(w)), warned.join("\n"));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { projects: {} });
  fs.rmdirSync(claudeConfigLock(file));
  assert.equal(ensureTrustedCwd(cfgDir, cwd), "added");
  fs.mkdirSync(claudeConfigLock(file));
  try {
    assert.equal(ensureTrustedCwd(cfgDir, cwd), "already", "answered from a plain read while claude holds the lock");
  } finally {
    fs.rmdirSync(claudeConfigLock(file));
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects[trustKeys(cwd)[0]].hasTrustDialogAccepted, true);
});

test("an inherited CLAUDE_CONFIG_DIR is dropped from the daemon's env", () => {
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/x", PATH: "/bin" };
  assert.equal(dropInheritedClaudeHome(env), "/x");
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(dropInheritedClaudeHome(env), null);
});
