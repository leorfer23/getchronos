/**
 * Slack wall: a workspace reaches a Slack only when it is its own. The live check (a real claude on the
 * operator's profile: with `mcp__slack` or `mcp__*__slack_*` denied, no Slack tool is left) was run by hand
 * when this landed; these pin who is walled and that every spawn path carries it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSlackServer, ownsSlack, slackWallRules, slackWalled, wallForeignSlack } from "./slack-wall.js";
import { claudeDenyArgs, openSlackSelfSend } from "./no-send.js";
import { buildRemoteSpawnSpec } from "./hosts/spawn-spec.js";
import { workspaces } from "./store.js";

const ON = JSON.stringify({ enabled: true, triage: false });
const ws = (id: string, config_dir: string | null, slack: string | null = null, archived = 0) =>
  ({ id, config_dir, slack_config: slack, archived }) as any;

/** Claude Code's full-name glob match for a bare deny rule (no-send.test.ts); a bare server name covers its tools. */
const matches = (rule: string, tool: string) =>
  rule.split("__").length === 2
    ? tool.startsWith(`${rule}__`)
    : new RegExp("^" + rule.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(tool);
const walls = (tool: string) => slackWallRules().some((r) => matches(r, tool));

test("a Slack is a workspace's own only when it turned Slack on and no other live workspace shares its profile", () => {
  const acme = ws("g", "/p/.claude-acme", ON);
  const globex = ws("s", "/p/.claude");
  const personal = ws("p", "/p/.claude", ON);
  const all = [acme, globex, personal];
  assert.equal(ownsSlack(acme, all), true, "its own profile, Slack on");
  assert.equal(ownsSlack(globex, all), false, "Slack off");
  assert.equal(ownsSlack(personal, all), false, "Slack on, but the profile is shared — its login is no one's");
  assert.equal(ownsSlack(ws("x", "/p/.claude-x"), [ws("x", "/p/.claude-x")]), false, "own profile, Slack off");
  assert.equal(ownsSlack(ws("x", null, ON), []), false, "no profile of its own");
  assert.equal(ownsSlack(ws("x", "/p/.claude-x", "{broken"), []), false, "unreadable config: off");
  // An archived sharer does not count; a sharer on the default profile does.
  assert.equal(ownsSlack(acme, [acme, ws("old", "/p/.claude-acme", null, 1)]), true);
  assert.equal(ownsSlack(acme, [acme, ws("d", null)], "/p/.claude-acme"), false);
});

test("the same profile reached through a symlink still counts as shared", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-slackwall-"));
  try {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    const a = ws("a", real, ON);
    assert.equal(ownsSlack(a, [a, ws("b", link)]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the rules take every Slack tool under every name, and nothing else", () => {
  for (const t of [
    "mcp__slack__slack_read_channel", "mcp__slack__slack_send_message_draft", "mcp__slack__slack_search_public",
    "mcp__plugin_slack_slack__slack_read_thread", "mcp__claude_ai_Slack__slack_search_users",
    "mcp__slack_acme__slack_read_channel", "mcp__acme__slack_send_message_draft",
  ]) assert.ok(walls(t), t);
  for (const t of ["mcp__claude_ai_Gmail__create_draft", "mcp__fff__grep", "Bash", "mcp__atlassian__getJiraIssue"]) assert.ok(!walls(t), t);
});

test("wallForeignSlack merges into the one deny flag, and a send gate opened after it cannot undo it", () => {
  const all = [ws("g", "/p/.claude-acme", ON), ws("s", "/p/.claude"), ws("p", "/p/.claude")];
  const args = ["--model", "opus", ...claudeDenyArgs()];
  assert.equal(wallForeignSlack(args, "s", all), true);
  assert.equal(args.filter((a) => a === "--disallowed-tools").length, 1, "still one flag");
  const deny = args[args.indexOf("--disallowed-tools") + 1].split(",");
  for (const r of slackWallRules()) assert.ok(deny.includes(r), r);
  // The gate takes only its exact send rules out; the server-wide ones stay, and a deny beats an allow.
  openSlackSelfSend(args, ["U0123ABCD"], { managedFile: "/nonexistent" });
  const after = args[args.indexOf("--disallowed-tools") + 1].split(",");
  assert.ok(after.includes("mcp__slack") && after.includes("mcp__*__slack_*"));

  const own = ["--model", "opus", ...claudeDenyArgs()];
  const before = own.join(" ");
  assert.equal(wallForeignSlack(own, "g", all), false, "its own Slack: untouched");
  assert.equal(own.join(" "), before);
  assert.equal(wallForeignSlack(own, null, all), false, "no workspace: the operator's own spawn");
  assert.equal(wallForeignSlack(own, "gone", all), true, "a workspace we cannot find: walled");
});

test("a remote terminal carries the wall in its spec", () => {
  const base = {
    sessionId: "s1", workspace: { id: "s", slug: "globex" }, backend: "claude-code", model: null, role: "human",
    cliSession: null, resume: false, repo: null, wsRepos: [], worktree: null, resumeCwd: null, profile: "claude",
    sandbox: { mode: "guard" as const, allowRaw: [], egressLocked: false }, system: null, env: {}, nice: 10,
    cols: 100, rows: 30, seed: null, seedEnterMs: 0, brainHome: os.homedir(),
  };
  assert.deepEqual(buildRemoteSpawnSpec({ ...base, deny: slackWallRules() }).spec.deny, slackWallRules());
  assert.equal("deny" in buildRemoteSpawnSpec(base).spec, false, "nothing to deny: the field is left out");
});

test("isSlackServer knows a Slack by its name or where it points", () => {
  assert.ok(isSlackServer("slack", { type: "http", url: "https://mcp.slack.com/mcp" }));
  assert.ok(isSlackServer("team-chat", { type: "http", url: "https://mcp.slack.com/mcp" }));
  assert.ok(isSlackServer("chat", { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] }));
  assert.ok(!isSlackServer("metrics", { command: "g" }));
});

test("a project's Robert on a shared profile loads no Slack; on his project's own profile he does", async () => {
  const agent = await import("./telegram/agent.js");
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-slackwall-shared-"));
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-slackwall-own-"));
  const slack = { type: "http", url: "https://mcp.slack.com/mcp" };
  for (const d of [shared, own]) fs.writeFileSync(path.join(d, ".claude.json"), JSON.stringify({ mcpServers: { slack } }));
  const a = workspaces.create({ slug: "sw-a", name: "A", config_dir: shared, slack_config: { enabled: true } } as any);
  const b = workspaces.create({ slug: "sw-b", name: "B", config_dir: shared } as any);
  const c = workspaces.create({ slug: "sw-c", name: "C", config_dir: own, slack_config: { enabled: true } } as any);
  try {
    assert.equal(slackWalled(a.id), true);
    assert.equal(slackWalled(b.id), true);
    assert.equal(slackWalled(c.id), false);
    for (const w of [a, b]) {
      const m = agent.robertMcp(shared, w.id);
      assert.equal(m.mcpConfig, undefined, "no Slack in his bundle");
      assert.deepEqual(m.allowedTools, []);
    }
    assert.deepEqual(JSON.parse(agent.robertMcp(own, c.id).mcpConfig!), { mcpServers: { slack } });
    assert.deepEqual(JSON.parse(agent.robertMcp(shared, null).mcpConfig!), { mcpServers: { slack } }, "fleet-wide Robert: unchanged");
  } finally {
    for (const w of [a, b, c]) workspaces.update(w.id, { archived: true } as any);
    fs.rmSync(shared, { recursive: true, force: true });
    fs.rmSync(own, { recursive: true, force: true });
  }
});
