/**
 * The setup checks (src/setup-check.ts) and the backends' auth checks, against fake CLIs.
 *
 * One fake script stands in for all five (claude, codex, cursor-agent, grok, opencode). It logs in by
 * leaving a marker in the account dir it was given (CLAUDE_CONFIG_DIR / CODEX_HOME), so a check that
 * forgot to pass the dir a spawn uses reads "not signed in" — the bug this whole module exists to avoid.
 * It also prints an email and an org id wherever the real CLIs do; none may come back out.
 * Every account dir is a temp dir: CONFIG.profiles is pointed away from the real ~/.claude.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { workspaces } from "./store.js";
import { installCli, loginCli, resolveBin, scrub, setupStatus, smokeCli, versionFrom, type CliStatus } from "./setup-check.js";
import { claudeAuthFrom, claudeBackend } from "./backends/claude.js";
import { codexBackend } from "./backends/codex.js";
import { backendReady } from "./backends/index.js";
import { grokEntries, grokSignedIn, signedInFrom } from "./backends/grok-auth.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-check-")));
const bin = path.join(tmp, "bin");
const profile = path.join(tmp, "profile-default");
const other = path.join(tmp, "profile-acme");
const log = path.join(tmp, "calls.log");
// Behaviour switches are files, not env vars: the checks run with the agent allowlist env (childEnv), as they must.
const flags = path.join(tmp, "flags");
const flag = (name: string, on: boolean) => { fs.mkdirSync(flags, { recursive: true }); if (on) fs.writeFileSync(path.join(flags, name), "1"); else fs.rmSync(path.join(flags, name), { force: true }); };
const EMAIL = "ops@acme.test";
// grok's home is a temp dir too (GROK_HOME): its sign-in is read from auth.json there, never this machine's.
const grokDir = path.join(tmp, "grok-home");
const savedGrokHome = process.env.GROK_HOME;
/** auth.json the way `grok login` leaves it — one entry per sign-in (values here are dummies). */
const grokAuth = (e: Record<string, unknown> | null) => {
  fs.mkdirSync(grokDir, { recursive: true });
  if (e) fs.writeFileSync(path.join(grokDir, "auth.json"), JSON.stringify({ "https://auth.x.ai::client": { key: "dummy-access", user_id: "u1", email: EMAIL, ...e } }));
  else fs.rmSync(path.join(grokDir, "auth.json"), { force: true });
};

const FAKE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, args, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: env.CODEX_HOME ?? null, OPENAI_API_KEY: env.OPENAI_API_KEY ?? null }) + "\\n");
const marker = (dir) => dir && fs.existsSync(path.join(dir, ".fake-login"));
const login = (dir) => setTimeout(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, ".fake-login"), "1"); process.exit(0); }, 300);
const out = (s, code = 0) => { process.stdout.write(s); process.exit(code); };
const flag = (f) => fs.existsSync(path.join(${JSON.stringify(flags)}, f));
if (args[0] === "--version") out({ claude: "9.1.2 (Claude Code)\\n", codex: "codex-cli 0.9.9\\n", "cursor-agent": "2026.11.05-86047df\\n", grok: "grok 1.0.70 (f50904eaee6c) [stable]\\n", opencode: "1.2.3\\n" }[name]);
if (name === "claude") {
  if (args[0] === "auth" && args[1] === "status") {
    if (flag("garbled")) out("Welcome to the new auth flow!\\n", 0);
    const on = marker(env.CLAUDE_CONFIG_DIR);
    out(JSON.stringify(on ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: ${JSON.stringify(EMAIL)}, orgId: "org-1234", orgName: "Acme", subscriptionType: "max" } : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2), on ? 0 : 1);
  }
  if (args[0] === "auth" && args[1] === "login") login(env.CLAUDE_CONFIG_DIR);
  else if (args[0] === "-p") {
    if (flag("smoke-fail")) out(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Fix it at console for ${EMAIL}" }) + "\\n", 1);
    out(JSON.stringify({ type: "system", subtype: "init" }) + "\\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) + "\\n");
  }
}
if (name === "codex") {
  if (args[0] === "login" && args[1] === "status") out(marker(env.CODEX_HOME) ? "Logged in using ChatGPT\\n" : "Not logged in\\n", marker(env.CODEX_HOME) ? 0 : 1);
  if (args[0] === "login") login(env.CODEX_HOME);
  else if (args[0] === "exec") out([{ type: "thread.started", thread_id: "t1" }, { type: "item.completed", item: { type: "agent_message", text: "OK" } }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } }].map((e) => JSON.stringify(e)).join("\\n") + "\\n");
}
if (name === "cursor-agent" && args[0] === "status") out(JSON.stringify({ status: "authenticated", isAuthenticated: true, userInfo: { email: ${JSON.stringify(EMAIL)}, userId: 42 } }) + "\\n");
if (name === "grok" && args[0] === "models") out("You are not authenticated.\\n\\nDefault model: grok-4.5\\n");
if (name === "opencode" && args[0] === "auth") out("┌  Credentials ~/.local/share/opencode/auth.json\\n│\\n└  2 credentials\\n");
if (name === "opencode" && args[0] === "run") out(JSON.stringify({ type: "text", part: { type: "text", text: "OK" } }) + "\\n" + JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 5, output: 1 }, cost: 0 } }) + "\\n");
setTimeout(() => {}, 60000);
`;

const saved = { claude: CONFIG.claudeBin, codex: CONFIG.codexBin, cursor: CONFIG.cursorBin, grok: CONFIG.grokBin, opencode: CONFIG.opencodeBin, profiles: { ...CONFIG.profiles }, defaultProfile: CONFIG.defaultProfile };
before(() => {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "fake-cli"), FAKE, { mode: 0o755 });
  for (const n of ["claude", "codex", "cursor-agent", "grok", "opencode"]) fs.symlinkSync(path.join(bin, "fake-cli"), path.join(bin, n));
  CONFIG.claudeBin = path.join(bin, "claude");
  CONFIG.codexBin = path.join(bin, "codex");
  CONFIG.cursorBin = path.join(bin, "cursor-agent");
  CONFIG.grokBin = path.join(bin, "grok");
  CONFIG.opencodeBin = path.join(bin, "opencode");
  for (const k of Object.keys(CONFIG.profiles)) delete CONFIG.profiles[k];
  Object.assign(CONFIG.profiles, { claude: profile, "claude-acme": other });
  (CONFIG as any).defaultProfile = "claude";
  process.env.GROK_HOME = grokDir;
  grokAuth(null);
});
after(() => {
  Object.assign(CONFIG, { claudeBin: saved.claude, codexBin: saved.codex, cursorBin: saved.cursor, grokBin: saved.grok, opencodeBin: saved.opencode });
  for (const k of Object.keys(CONFIG.profiles)) delete CONFIG.profiles[k];
  Object.assign(CONFIG.profiles, saved.profiles);
  (CONFIG as any).defaultProfile = saved.defaultProfile;
  if (savedGrokHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = savedGrokHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const signIn = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, ".fake-login"), "1"); };
const signOut = (dir: string) => fs.rmSync(path.join(dir, ".fake-login"), { force: true });
const row = (s: { clis: CliStatus[] }, id: string) => s.clis.find((c) => c.id === id)!;

test("status asks each CLI the way an agent runs it: the profile dir as CLAUDE_CONFIG_DIR and as CODEX_HOME", async () => {
  signIn(profile);
  signOut(other);
  fs.rmSync(log, { force: true });
  const s = await setupStatus({ fresh: true, appDirs: [tmp], platform: "darwin" });
  assert.deepEqual(s.daemon, { ok: true, version: s.daemon.version, port: CONFIG.port });
  assert.equal(typeof s.projects, "number");
  assert.deepEqual(s.clis.map((c) => c.id), ["claude", "codex", "cursor-agent", "grok", "opencode"]);

  const claude = row(s, "claude");
  assert.equal(claude.installed, true);
  assert.equal(claude.version, "9.1.2");
  assert.equal(claude.loggedIn, true);
  assert.equal(claude.authDetail, "Claude Max subscription");
  assert.deepEqual(claude.profiles, [{ name: "claude-acme", loggedIn: false }], "the other profile, checked in its own dir");
  assert.equal(claude.login, `CLAUDE_CONFIG_DIR="${profile}" "${path.join(bin, "claude")}" auth login`, "the account dir agents read, and the binary a spawn runs");
  assert.equal(claude.install, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.equal(claude.can_install, false, "already installed");

  // codex reads CODEX_HOME = the profile dir — a ChatGPT login in ~/.codex is not one an agent sees.
  const codex = row(s, "codex");
  assert.equal(codex.loggedIn, true, "signed in through the same profile dir");
  assert.equal(codex.authDetail, "ChatGPT account");
  assert.match(codex.login, /^CODEX_HOME=".*profile-default" ".*\/codex" login$/);
  const codexCalls = calls().filter((c) => c.name === "codex" && c.args[0] === "login");
  assert.ok(codexCalls.length && codexCalls.every((c) => c.CODEX_HOME === profile), "every codex check ran with CODEX_HOME=<profile>");
  assert.ok(calls().filter((c) => c.name === "claude" && c.args[0] === "auth").every((c) => c.CLAUDE_CONFIG_DIR === profile || c.CLAUDE_CONFIG_DIR === other));

  assert.equal(row(s, "cursor-agent").loggedIn, true);
  assert.equal(row(s, "grok").loggedIn, false, "no auth.json: signed out");
  assert.equal(row(s, "opencode").loggedIn, true);
  assert.equal(row(s, "opencode").authDetail, "2 providers signed in");
  assert.ok(!JSON.stringify(s).includes(EMAIL) && !JSON.stringify(s).includes("org-1234"), "no email, no org id");
});

test("signed out of the profile dir = not signed in, whatever the CLI's own default says", async () => {
  signOut(profile);
  const s = await setupStatus({ fresh: true, appDirs: [tmp], platform: "darwin" });
  assert.equal(row(s, "claude").loggedIn, false);
  assert.equal(row(s, "codex").loggedIn, false);
  signIn(profile);
});

test("a CLI that isn't there: not installed, installable on a Mac, and its desktop app noticed", async () => {
  const apps = path.join(tmp, "Applications");
  fs.mkdirSync(path.join(apps, "ChatGPT.app"), { recursive: true });
  CONFIG.codexBin = path.join(tmp, "nowhere", "codex");
  try {
    const s = await setupStatus({ fresh: true, appDirs: [apps], platform: "darwin" });
    const codex = row(s, "codex");
    assert.deepEqual([codex.installed, codex.version, codex.loggedIn, codex.app, codex.can_install], [false, null, null, true, true]);
    assert.equal(codex.install, "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    assert.equal(row(s, "claude").app, false);
    assert.equal(row(await setupStatus({ fresh: true, appDirs: [apps], platform: "win32" }), "codex").can_install, false, "no installer we can run there");
  } finally {
    CONFIG.codexBin = path.join(bin, "codex");
  }
});

test("a bare name resolves like a spawn does: ~/.mc/bin first, then PATH — nowhere else", () => {
  const home = path.join(tmp, "home-resolve");
  fs.mkdirSync(path.join(home, ".mc", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".mc", "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveBin("codex", { pathVar: bin, home }), path.join(home, ".mc", "bin", "codex"));
  assert.equal(resolveBin("claude", { pathVar: bin, home }), path.join(bin, "claude"));
  assert.equal(resolveBin("claude", { pathVar: "/nonexistent", home }), null);
  assert.equal(resolveBin(path.join(bin, "nope"), { home }), null);
});

test("the test prompt runs through the backend's own one-shot argv, in the profile env, and reads each answer shape", async () => {
  signIn(profile);
  fs.rmSync(log, { force: true });
  const claude = await smokeCli("claude");
  assert.equal(claude.ok, true);
  assert.equal(claude.reply, "OK");
  assert.ok(claude.ms >= 0);
  const c = calls().find((x) => x.name === "claude" && x.args[0] === "-p")!;
  assert.equal(c.args[1], "Reply with exactly: OK");
  assert.ok(c.args.includes("--model") && c.args[c.args.indexOf("--model") + 1] === "haiku", "the cheapest model");
  assert.ok(c.args.includes("--strict-mcp-config") && c.args.includes("--dangerously-skip-permissions"), "the same argv a helper run uses");
  assert.equal(c.CLAUDE_CONFIG_DIR, profile);
  assert.deepEqual(await smokeCli("codex").then((r) => [r.ok, r.reply]), [true, "OK"], "codex: item.completed");
  assert.deepEqual(await smokeCli("opencode").then((r) => [r.ok, r.reply]), [true, "OK"], "opencode: text parts");
  const cx = calls().find((x) => x.name === "codex" && x.args[0] === "exec")!;
  assert.equal(cx.CODEX_HOME, profile);
});

test("a failed test prompt says why — with the email scrubbed — and a CLI that isn't there is not tried", async () => {
  flag("smoke-fail", true);
  try {
    const r = await smokeCli("claude");
    assert.equal(r.ok, false);
    assert.match(r.error!, /^Invalid API key/);
    assert.ok(!r.error!.includes(EMAIL), r.error);
  } finally {
    flag("smoke-fail", false);
  }
  CONFIG.grokBin = path.join(tmp, "nowhere", "grok");
  try {
    assert.deepEqual(await smokeCli("grok"), { ok: false, ms: 0, error: "Grok isn't installed" });
  } finally {
    CONFIG.grokBin = path.join(bin, "grok");
  }
});

test("install runs the vendor's installer without the account-dir variables, and reports what it printed", async () => {
  const pathDir = path.join(tmp, "install-path");
  const tmpHome = path.join(tmp, "home-install");
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(pathDir, { recursive: true });
  CONFIG.codexBin = "codex-installed-by-test";
  const envOut = path.join(tmp, "installer-env.txt");
  process.env.CODEX_HOME = "/should/not/leak";
  try {
    const cmd = `env > ${JSON.stringify(envOut)}; echo "downloading… done for ${EMAIL}"; printf '#!/bin/sh\\n' > ${JSON.stringify(path.join(pathDir, "codex-installed-by-test"))}; chmod +x ${JSON.stringify(path.join(pathDir, "codex-installed-by-test"))}`;
    const r = await installCli("codex", { command: cmd, pathVar: pathDir, home: tmpHome });
    assert.equal(r.ok, true, r.log_tail);
    assert.match(r.log_tail, /downloading… done for <email>/);
    const env = fs.readFileSync(envOut, "utf8");
    assert.ok(!/^CODEX_HOME=/m.test(env), "codex's installer would put its packages under $CODEX_HOME — a claude profile dir in Chronos");
    assert.match(env, /^CODEX_NON_INTERACTIVE=1$/m, "the script's own never-prompt switch");
    assert.deepEqual(await installCli("codex", { command: "exit 99", pathVar: pathDir, home: tmpHome }), { ok: true, log_tail: "Codex (ChatGPT) is already installed." });
    CONFIG.grokBin = path.join(tmp, "nowhere", "grok");
    const failed = await installCli("grok", { command: "echo 'curl: (6) Could not resolve host' >&2; exit 6", pathVar: "/nonexistent", home: tmpHome });
    assert.equal(failed.ok, false);
    assert.match(failed.log_tail, /Could not resolve host/);
  } finally {
    delete process.env.CODEX_HOME;
    CONFIG.codexBin = path.join(bin, "codex");
    CONFIG.grokBin = path.join(bin, "grok");
  }
});

test("sign-in from the Desk runs the CLI's login with the profile dir and returns once the check flips", async () => {
  signOut(profile);
  fs.rmSync(log, { force: true });
  const r = await loginCli("claude", { pollMs: 100, timeoutMs: 10_000 });
  assert.deepEqual(r, { ok: true });
  assert.ok(fs.existsSync(path.join(profile, ".fake-login")), "the login landed in the dir agents read");
  const loginCall = calls().find((c) => c.name === "claude" && c.args.join(" ") === "auth login")!;
  assert.equal(loginCall.CLAUDE_CONFIG_DIR, profile);
  assert.deepEqual(await loginCli("claude", { pollMs: 100 }), { ok: true, message: "already signed in" });

  signOut(profile);
  const r2 = await loginCli("codex", { pollMs: 100, timeoutMs: 10_000 });
  assert.equal(r2.ok, true);
  assert.equal(calls().find((c) => c.name === "codex" && c.args.join(" ") === "login")!.CODEX_HOME, profile);
  signIn(profile);
});

test("claude checkAuth: the workspace's own config dir; unknown is not logged out", async () => {
  const wsDir = path.join(tmp, "cfg-ws");
  const ws = workspaces.create({ slug: `setup-ck-${Date.now()}`, name: "Globex", config_dir: wsDir } as any);
  signIn(wsDir);
  assert.equal(await claudeBackend.checkAuth!(ws.id), true);
  const outDir = path.join(tmp, "cfg-ws-out");
  const ws2 = workspaces.create({ slug: `setup-ck2-${Date.now()}`, name: "Initech", config_dir: outDir } as any);
  assert.equal(await claudeBackend.checkAuth!(ws2.id), false, "its own dir has no login");
  // A claude that prints something we don't understand, or won't start: true — never block on a guess.
  const garbled = path.join(tmp, "cfg-garbled");
  const ws3 = workspaces.create({ slug: `setup-ck3-${Date.now()}`, name: "Umbrella", config_dir: garbled } as any);
  flag("garbled", true);
  try { assert.equal(await claudeBackend.checkAuth!(ws3.id), true); } finally { flag("garbled", false); }
  const missing = path.join(tmp, "cfg-missing-bin");
  const ws4 = workspaces.create({ slug: `setup-ck4-${Date.now()}`, name: "Hooli", config_dir: missing } as any);
  CONFIG.claudeBin = path.join(tmp, "nowhere", "claude");
  try { assert.equal(await claudeBackend.checkAuth!(ws4.id), true); } finally { CONFIG.claudeBin = path.join(bin, "claude"); }
});

test("codex checkAuth asks with CODEX_HOME = the workspace's config dir, and an API key counts only if agents get it", async () => {
  const wsDir = path.join(tmp, "cfg-codex");
  const ws = workspaces.create({ slug: `setup-cx-${Date.now()}`, name: "Acme", config_dir: wsDir } as any);
  assert.equal(await codexBackend.checkAuth!(ws.id), false);
  signIn(wsDir);
  assert.equal(await codexBackend.checkAuth!(ws.id), true);
  signOut(wsDir);
  process.env.OPENAI_API_KEY = "sk-daemon-only";
  try {
    assert.equal(await codexBackend.checkAuth!(ws.id), false, "the daemon's own key never reaches an agent (child-env.ts)");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("parsers keep the answer and drop the account", () => {
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: EMAIL, orgId: "o" })), { loggedIn: true, detail: "Claude Pro subscription" });
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })), { loggedIn: true, detail: "claude.ai subscription" });
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })), { loggedIn: true, detail: "Anthropic API key" });
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: true, authMethod: "x", apiProvider: "bedrock" })), { loggedIn: true, detail: "bedrock account" });
  assert.deepEqual(claudeAuthFrom(`{"loggedIn": false, "authMethod": "none"}`), { loggedIn: false, detail: null });
  assert.deepEqual(claudeAuthFrom("Not logged in. Run claude auth login to authenticate."), { loggedIn: null, detail: null });
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: "yes" })), { loggedIn: null, detail: null });
  assert.deepEqual(claudeAuthFrom(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "<script>" })), { loggedIn: true, detail: "claude.ai subscription" });
  assert.equal(versionFrom("2.1.322 (Claude Code)"), "2.1.322");
  assert.equal(versionFrom("codex-cli 0.144.1"), "0.144.1");
  assert.equal(versionFrom("2026.11.05-86047df"), "2026.11.05-86047df");
  assert.equal(versionFrom("grok 1.0.70 (f50904eaee6c) [stable]"), "1.0.70");
  assert.equal(scrub(`\x1b[31mfailed for ${EMAIL}\x1b[0m\n  please retry`), "failed for <email> please retry");
});

test("grok: the setup check and the failover chain give ONE answer, from grok's credentials file — not from `grok models`", async () => {
  const hour = 3600_000;
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const both = async () => {
    const s = await setupStatus({ fresh: true, appDirs: [tmp], platform: "darwin" });
    return [row(s, "grok").loggedIn, backendReady("grok")];
  };
  try {
    // The fake `grok models` always says "You are not authenticated." — what grok 1.0.70 prints for a
    // session whose 6-hour access token ran out, while the same run refreshes it. Its words decide nothing.
    grokAuth({ expires_at: iso(-hour), refresh_token: "dummy-refresh" });
    assert.deepEqual(await both(), [true, true], "access token expired, refresh token there: grok refreshes on the next call");
    assert.equal(row(await setupStatus({ fresh: true, appDirs: [tmp], platform: "darwin" }), "grok").authDetail, "grok.com account");
    grokAuth({ expires_at: iso(hour) });
    assert.deepEqual(await both(), [true, true], "unexpired access token");
    grokAuth({ expires_at: iso(-hour) });
    assert.deepEqual(await both(), [false, false], "expired and nothing to refresh it with: grok asks for a new sign-in");
    fs.writeFileSync(path.join(grokDir, "auth.json"), "{}");
    assert.deepEqual(await both(), [false, false], "an empty file (what an older check counted as signed in)");
    grokAuth(null);
    assert.deepEqual(await both(), [false, false], "no file");
    assert.ok(!calls().some((c) => c.name === "grok" && c.args[0] === "models"), "never spawned to decide");
  } finally {
    grokAuth(null);
  }
});

test("grok sign-in rule: presence and expiry only — nothing secret kept", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const e = grokEntries(JSON.stringify({ a: { key: "tok", refresh_token: "r", expires_at: "2026-11-13T06:00:00Z" }, b: { nokey: true }, c: "x" }));
  assert.deepEqual(e, [{ refresh: true, expiresAt: Date.parse("2026-11-13T06:00:00Z") }]);
  assert.equal(signedInFrom(e, now), true);
  assert.equal(signedInFrom(grokEntries(JSON.stringify({ a: { key: "tok", expires_at: "2026-11-13T13:00:00Z" } })), now), true);
  assert.equal(signedInFrom(grokEntries(JSON.stringify({ a: { key: "tok", expires_at: "2026-11-13T11:00:00Z", refresh_token: "" } })), now), false);
  assert.equal(signedInFrom(grokEntries(JSON.stringify({ a: { key: "", refresh_token: "r" } })), now), false);
  assert.deepEqual(grokEntries("not json"), []);
  assert.deepEqual(grokEntries("[]"), []);
  const home = fs.mkdtempSync(path.join(tmp, "grok-rule-"));
  assert.equal(grokSignedIn({ GROK_HOME: path.join(home, "none") }, home), false);
  fs.mkdirSync(path.join(home, ".grok"));
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), JSON.stringify({ a: { key: "tok", refresh_token: "r" } }));
  assert.equal(grokSignedIn({}, home), true, "~/.grok when GROK_HOME is unset");
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), JSON.stringify({}));
  assert.equal(grokSignedIn({}, home), false, "a rewrite (grok logout) is seen, not cached");
});
