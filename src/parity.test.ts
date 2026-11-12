/**
 * "Same tools as your own Claude / ChatGPT" (parity.ts, parity-routes.ts) against fixture homes: the
 * report says names and never values, each fix does exactly what its label says (merge-only, a client
 * profile never handed one of the operator's credentials), the fix route takes the operator himself,
 * and Chronos's own writers (trust, fff, slack) follow the config the agents actually read.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { applyParityFix, codexServerNames, parityReport, type ParityDeps, type Runner } from "./parity.js";
import { parityStateFile, switchClaudeHome } from "./parity-env.js";

const homes: string[] = [];
after(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });

const SECRET = "tok-DO-NOT-LEAK-7f3a";
const EMAIL = "someone@example.com";
const FFF = { type: "stdio", command: "/home/op/.mc/bin/fff-mcp.sh", args: ["/opt/homebrew/bin/fff-mcp"] };
const SLACK = { type: "http", url: "https://mcp.slack.com/mcp", oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 } };
const X = { type: "stdio", command: "/usr/local/bin/x-mcp", args: [] };
const Y = { type: "http", url: "https://y.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } };

function put(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

/** A Mac like the live one: own servers x, y (+ a project server); the agents' separate config has fff + slack. */
function fixture(o: { ownAccount?: boolean; legacyCodexLogin?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  homes.push(home);
  const dir = path.join(home, ".claude");
  const account = { accountUuid: "acct-1", emailAddress: EMAIL };
  put(path.join(home, ".claude.json"), {
    ...(o.ownAccount === false ? {} : { oauthAccount: account }),
    mcpServers: { x: X, y: Y },
    projects: { "/work/app": { mcpServers: { db: { command: "db-mcp", env: { DB_PASSWORD: SECRET } } } } },
    claudeAiMcpEverConnected: ["claude.ai Gmail", "claude.ai Google Drive"],
  });
  put(path.join(dir, ".claude.json"), { oauthAccount: account, mcpServers: { fff: FFF, slack: SLACK } });
  put(path.join(dir, "settings.json"), { enabledPlugins: { "review@official": true, "off@official": false } });
  fs.mkdirSync(path.join(dir, "plugins", "synced", "notes"), { recursive: true });
  for (const s of ["a", "b", "synced/c"]) put(path.join(dir, "skills", s, "SKILL.md"), "---\nname: s\n---\n");
  put(path.join(dir, "CLAUDE.md"), "be brief");
  const desktopConfig = path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  put(desktopConfig, {
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"] },
      memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_KEY: SECRET } },
      "bad name": { command: "x" },
    },
  });
  put(path.join(home, ".codex", "config.toml"), `model = "gpt-5"\n[mcp_servers.docs]\ncommand = "docs-mcp"\n[mcp_servers."ci-bot"]\nurl = "https://ci"\n[mcp_servers."ci-bot".env]\nTOKEN = "${SECRET}"\n`);
  put(path.join(home, ".codex", "AGENTS.md"), "house rules");
  if (o.legacyCodexLogin) put(path.join(dir, "auth.json"), { tokens: SECRET });
  else put(path.join(home, ".codex", "auth.json"), { tokens: SECRET });
  const fake = fakeClaude();
  const deps: ParityDeps = { home, env: {}, stateFile: path.join(home, "state", "parity.json"), profiles: { claude: dir }, desktopConfig, platform: "darwin", run: fake.run, claudeBin: "claude" };
  return { home, dir, deps, calls: fake.calls, ownFile: path.join(home, ".claude.json"), legacyFile: path.join(dir, ".claude.json") };
}

/** `claude mcp add-json <name> <json> --scope user`, as claude does it: the env decides the file; refuses an existing name. */
function fakeClaude() {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: Runner = async (_cmd, args, opts) => {
    calls.push({ args, env: { ...opts.env } });
    const [mcp, sub, name, json, flag, scope] = args;
    if (mcp !== "mcp" || sub !== "add-json" || flag !== "--scope" || scope !== "user") return { code: 1, stdout: "", stderr: "unexpected call" };
    const file = opts.env?.CLAUDE_CONFIG_DIR ? path.join(opts.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(opts.env!.HOME!, ".claude.json");
    const cfg = fs.existsSync(file) ? readJson(file) : {};
    cfg.mcpServers ??= {};
    if (cfg.mcpServers[name]) return { code: 1, stdout: "", stderr: `MCP server ${name} already exists in user config` };
    const def = JSON.parse(json);
    cfg.mcpServers[name] = def.type === "stdio" && !def.args ? { ...def, args: [] } : def;
    put(file, cfg);
    return { code: 0, stdout: `Added MCP server ${name} to user config`, stderr: "" };
  };
  return { run, calls };
}

test("the report: what your own setup has next to what agents get — names only, never a value", () => {
  const f = fixture();
  const r = parityReport(f.deps);
  const claude = r.claude.profiles.find((p) => p.default)!;
  assert.equal(claude.mode, "separate");
  assert.deepEqual(claude.yours.mcp, ["x", "y"]);
  assert.deepEqual(claude.yours.projectMcp, ["db (app)"]);
  assert.deepEqual(claude.yours.plugins, ["notes@synced", "review@official"]);
  assert.equal(claude.yours.skills, 3);
  assert.equal(claude.yours.instructions, true);
  assert.deepEqual(claude.yours.connectors, ["Gmail", "Google Drive"]);
  assert.deepEqual(claude.agents.mcp, ["fff", "slack"]);
  assert.deepEqual(claude.missing, ["x", "y"]);
  assert.deepEqual(claude.extra, ["fff", "slack"]);
  assert.ok(claude.notes.some((n) => /slack/.test(n) && /claude mcp login/.test(n)), "the switch's one sign-in is named up front");
  assert.deepEqual(r.fixes.map((x) => x.id), ["claude-own-home", "claude-bring-over:claude", "claude-desktop-import"]);
  assert.match(r.fixes[0].label, /x, y/);
  assert.deepEqual(r.claude.desktop.importable, ["filesystem", "memory"]);
  assert.deepEqual(r.claude.desktop.invalid, ["bad name"], "claude mcp accepts only letters, digits, - and _");
  const codex = r.codex.profiles.find((p) => p.default)!;
  assert.equal(codex.mode, "own");
  assert.deepEqual(codex.agents.mcp, ["ci-bot", "docs"]);
  assert.equal(codex.agents.instructions, true);
  assert.equal(codex.agents.signedIn, true);
  assert.equal(r.ok, false);
  assert.equal(r.lines[0], "Same tools as your own Claude / ChatGPT");
  assert.ok(r.lines.some((l) => l.startsWith("  ! Claude Code: agents lack 2 of your MCP servers (x, y)")), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("  ✓ Codex (ChatGPT): agents use your own ~/.codex")));
  const raw = JSON.stringify(r);
  for (const leak of [SECRET, EMAIL, "acct-1", "Bearer", "DB_PASSWORD", "MEMORY_KEY"]) assert.ok(!raw.includes(leak), `report leaked ${leak}`);
});

test("fix claude-own-home: agents get your own setup; slack's one sign-in is spelled out; then the report is clean", async () => {
  const f = fixture();
  const res = await applyParityFix("claude-own-home", f.deps);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.done.sort(), ["fff", "slack"]);
  assert.deepEqual(res.signIn, ["slack"]);
  assert.match(res.message, /claude mcp login/);
  assert.equal(f.calls.length, 0, "the switch is a file merge, no CLI");
  const r = parityReport(f.deps);
  const claude = r.claude.profiles.find((p) => p.default)!;
  assert.equal(claude.mode, "own");
  assert.deepEqual(claude.missing, []);
  assert.equal(r.ok, true);
  assert.match(r.lines[1], /^ {2}✓ Claude Code: agents use your own setup — 4 MCP servers, 2 plugins, 3 skills, CLAUDE\.md, 2 claude\.ai connectors$/);
  assert.deepEqual(r.fixes.map((x) => x.id), ["claude-desktop-import"]);
});

test("fix claude-desktop-import: claude mcp add-json --scope user under the agents' env, merge-only", async () => {
  const f = fixture();
  // Separate setup: the import must land where the agents read, ~/.claude/.claude.json.
  let res = await applyParityFix("claude-desktop-import", f.deps);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.done, ["filesystem", "memory"]);
  assert.deepEqual(res.skipped, ["bad name"]);
  assert.equal(f.calls[0].env.CLAUDE_CONFIG_DIR, f.dir);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ["mcp", "add-json", "filesystem"]);
  assert.deepEqual(JSON.parse(f.calls[0].args[3]).type, "stdio", "Desktop's implicit stdio type is made explicit");
  assert.deepEqual(Object.keys(readJson(f.legacyFile).mcpServers).sort(), ["fff", "filesystem", "memory", "slack"]);
  // Own setup: no CLAUDE_CONFIG_DIR at all, so it lands in ~/.claude.json (their terminal sees it too).
  const g = fixture();
  assert.equal((await applyParityFix("claude-own-home", g.deps)).ok, true);
  res = await applyParityFix("claude-desktop-import", g.deps);
  assert.equal(res.ok, true);
  assert.equal("CLAUDE_CONFIG_DIR" in g.calls[0].env, false);
  assert.equal(g.calls[0].env.HOME, g.home);
  assert.deepEqual(Object.keys(readJson(g.ownFile).mcpServers).sort(), ["fff", "filesystem", "memory", "slack", "x", "y"]);
  const after = parityReport(g.deps).claude.desktop;
  assert.deepEqual(after.importable, []);
  assert.deepEqual(after.alreadyThere, ["filesystem", "memory"]);
  // Again: nothing to do, nothing run.
  const n = g.calls.length;
  assert.equal((await applyParityFix("claude-desktop-import", g.deps)).ok, true);
  assert.equal(g.calls.length, n);
});

test("fix claude-bring-over:<client>: explicit, into that profile only, never a server carrying your credential", async () => {
  const f = fixture();
  const acme = path.join(f.home, ".claude-acme");
  put(path.join(acme, ".claude.json"), { mcpServers: { fff: FFF } });
  const deps = { ...f.deps, profiles: { claude: f.dir, "claude-acme": acme } };
  const before = parityReport(deps);
  const p = before.claude.profiles.find((x) => x.profile === "claude-acme")!;
  assert.equal(p.mode, "separate");
  assert.deepEqual(p.missing, ["x", "y"]);
  assert.ok(before.fixes.some((x) => x.id === "claude-bring-over:claude-acme"));
  const res = await applyParityFix("claude-bring-over:claude-acme", deps);
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.done, ["x"]);
  assert.ok(res.skipped.some((s) => s.startsWith("y (carries a credential")), res.skipped.join("; "));
  assert.equal(f.calls.every((c) => c.env.CLAUDE_CONFIG_DIR === acme), true);
  assert.deepEqual(Object.keys(readJson(path.join(acme, ".claude.json")).mcpServers).sort(), ["fff", "x"]);
  assert.deepEqual(Object.keys(readJson(f.ownFile).mcpServers).sort(), ["x", "y"], "your own config is the source, never written");
  assert.equal((await applyParityFix("claude-bring-over:nope", deps)).ok, false);
});

test("no switch onto a signed-out terminal: the fix is not offered and refuses with the next step", async () => {
  const f = fixture({ ownAccount: false });
  const r = parityReport(f.deps);
  assert.ok(!r.fixes.some((x) => x.id === "claude-own-home"));
  assert.ok(r.claude.profiles[0].notes.some((n) => /claude auth login/.test(n)));
  const res = await applyParityFix("claude-own-home", f.deps);
  assert.equal(res.ok, false);
  assert.match(res.message, /claude auth login/);
  assert.equal(fs.existsSync(f.deps.stateFile!), false);
  assert.equal((await applyParityFix("rm -rf", f.deps)).message, "unknown fix");
});

test("codex: a login an older Chronos left under ~/.claude keeps agents there, and the report says how to move", () => {
  const f = fixture({ legacyCodexLogin: true });
  const codex = parityReport(f.deps).codex.profiles.find((p) => p.default)!;
  assert.equal(codex.mode, "separate");
  assert.equal(codex.agents.home, f.dir);
  assert.ok(codex.notes[0].includes("codex login"));
});

test("codex server names come from the TOML headers alone", () => {
  assert.deepEqual(codexServerNames(`[mcp_servers.a]\n[mcp_servers."b c"]\n[mcp_servers.'d'.env]\n[mcp_servers]\n[other.x]\n  [ mcp_servers.e ]\n`), ["a", "b c", "d", "e"]);
});

test("Chronos's writers follow the config the agents read: trust, fff and slack land in ~/.claude.json, merge-only", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "parity-writers-"));
  homes.push(home);
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir);
  const own = path.join(home, ".claude.json");
  put(own, { numStartups: 7, mcpServers: { fff: { command: "/their/fff" }, slack: { type: "http", url: "https://their-slack.example.com/mcp" } } });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(switchClaudeHome("fix", { home, env: {} }).ok, true);
    const { ensureTrustedCwd } = await import("./claude-trust.js");
    const { installFffMcp } = await import("./efficiency-tools.js");
    const { installSlackMcp } = await import("./slack.js");
    const { profileMcpTools } = await import("./telegram/agent.js");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "parity-cwd-"));
    homes.push(cwd);
    assert.equal(ensureTrustedCwd(dir, cwd), "added");
    assert.equal(readJson(own).projects[cwd].hasTrustDialogAccepted, true);
    assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false, "nothing goes to the old per-profile file");
    // fff: theirs is kept; once it is gone, ours goes in; removal takes only ours.
    assert.equal(installFffMcp(dir, "/opt/homebrew/bin/fff-mcp", "/home/op/.mc/bin/fff-mcp.sh"), "skipped");
    assert.deepEqual(readJson(own).mcpServers.fff, { command: "/their/fff" });
    const cfg = readJson(own);
    delete cfg.mcpServers.fff;
    put(own, cfg);
    assert.equal(installFffMcp(dir, "/opt/homebrew/bin/fff-mcp", "/home/op/.mc/bin/fff-mcp.sh"), "written");
    assert.equal(readJson(own).mcpServers.fff.command, "/home/op/.mc/bin/fff-mcp.sh");
    assert.equal(installFffMcp(dir, null, null), "removed");
    assert.equal(readJson(own).mcpServers.fff, undefined);
    // slack: theirs is kept on enable AND on disable; ours is added and removed.
    const ws = { id: "ws-slack", slug: "acme", config_dir: dir, slack_config: JSON.stringify({ enabled: true }) } as any;
    installSlackMcp(ws);
    assert.equal(readJson(own).mcpServers.slack.url, "https://their-slack.example.com/mcp");
    installSlackMcp({ ...ws, slack_config: JSON.stringify({ enabled: false }) });
    assert.equal(readJson(own).mcpServers.slack.url, "https://their-slack.example.com/mcp");
    const c2 = readJson(own);
    delete c2.mcpServers.slack;
    put(own, c2);
    installSlackMcp(ws);
    assert.equal(readJson(own).mcpServers.slack.url, "https://mcp.slack.com/mcp");
    assert.deepEqual(profileMcpTools(dir), ["mcp__slack"], "Robert's allow-list reads the same file");
    installSlackMcp({ ...ws, slack_config: JSON.stringify({ enabled: false }) });
    assert.equal(readJson(own).mcpServers.slack, undefined);
    assert.equal(readJson(own).numStartups, 7, "every other key of theirs survives every write");
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(parityStateFile(), { force: true });
  }
});

test("routes: GET is admin-gated; a fix takes the operator's own token — never a Robert credential", async () => {
  const { workspaces } = await import("./store.js");
  const { CONFIG } = await import("./config.js");
  const { requireAdmin, robertToken } = await import("./authz.js");
  const { parityRoutes, setParityDepsForTest } = await import("./parity-routes.js");
  const f = fixture();
  setParityDepsForTest(f.deps);
  const ws = workspaces.create({ slug: `parity-${Date.now()}`, name: "P", config_dir: "/tmp/parity-ws" } as any);
  const app = express();
  app.use(express.json());
  const api = express.Router();
  api.use(parityRoutes(requireAdmin));
  app.use("/api", api);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, p: string, token?: string) => {
    const r = await fetch(base + p, { method, headers: token ? { "x-mc-admin": token } : {} });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    assert.equal((await call("GET", "/setup/parity")).status, 403);
    const got = await call("GET", "/setup/parity", CONFIG.adminToken);
    assert.equal(got.status, 200);
    assert.equal(got.json.lines[0], "Same tools as your own Claude / ChatGPT");
    assert.equal((await call("POST", "/setup/parity/fix/claude-own-home")).status, 403);
    assert.equal((await call("POST", "/setup/parity/fix/claude-own-home", robertToken(ws.id, "rw"))).status, 403);
    assert.equal((await call("POST", "/setup/parity/fix/claude-own-home", robertToken(null, "rw"))).status, 403, "nor the fleet Robert");
    assert.equal(fs.existsSync(f.deps.stateFile!), false, "a refused call changed nothing");
    assert.equal((await call("POST", "/setup/parity/fix/drop-tables", CONFIG.adminToken)).status, 404);
    const ok = await call("POST", "/setup/parity/fix/claude-own-home", CONFIG.adminToken);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.ok, true);
    assert.equal(ok.json.report.claude.profiles[0].mode, "own");
  } finally {
    server.close();
    setParityDepsForTest(null);
  }
});
