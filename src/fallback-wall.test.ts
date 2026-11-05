/**
 * An engine swap never widens what a turn can reach: a project's Robert on a fallback engine (grok,
 * cursor) keeps his walls and his workspace's env, and every agent CLI Chronos runs refuses to send —
 * cursor and opencode included. The live checks (cursor: `gh pr comment` blocked by the hook, a denied
 * MCP tool refused under --force; opencode: `gh pr comment` refused under --auto) were run by hand
 * when this landed; these pin the wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fallbackLaunch } from "./manager-fallback.js";
import { cursorNoSendRules, ensureCursorNoSend, opencodeNoSendConfig, SEND_BASH } from "./no-send.js";
import { cursorHooks } from "./term-hooks.js";
import { opencodeBackend } from "./backends/opencode.js";
import { workspaces } from "./store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-fbw-"));

test("a fallback turn keeps the primary's walls and env, not the daemon's", () => {
  process.env.CHRONOS_TG_TOKEN = "daemon-bot-token";
  const foreign = path.join(tmp, "initech");
  const l = fallbackLaunch(
    { sandbox: "guard", addDirs: [path.join(tmp, "home")], denyDirs: [foreign], baseEnv: { PATH: "/usr/bin", GH_TOKEN: "ws-token" }, extraEnv: { MC_WORKSPACE: "acme" } },
    "grok", { cmd: "grok", args: ["-p", "hi"] }, path.join(tmp, "acme"), path.join(tmp, "cfg"),
  );
  assert.equal(l.env.CHRONOS_TG_TOKEN, undefined, "the daemon's secrets stay in the daemon");
  assert.equal(l.env.GH_TOKEN, "ws-token");
  assert.equal(l.env.MC_WORKSPACE, "acme");
  if (l.cmd !== "grok") {
    const profile = l.cmdArgs[1];
    assert.ok(profile.includes(foreign), "the other workspace's places are denied on the fallback too");
  }
  // No walls given (the fleet-wide Robert, an executive): unchanged — the daemon's env.
  const plain = fallbackLaunch({ sandbox: "off" }, "grok", { cmd: "grok", args: [] }, tmp, tmp);
  assert.equal(plain.env.CHRONOS_TG_TOKEN, "daemon-bot-token");
});

test("Robert's fallback and one-shot paths pass his walls (source)", () => {
  const src = fs.readFileSync(new URL("./telegram/agent.ts", import.meta.url), "utf8");
  // Telegram warm turn, Telegram parallel one-shot, Desk turn: each carries robertSandbox into the fallback.
  assert.ok((src.match(/\.\.\.robertSandbox\((runWs|realWsId)\)/g) ?? []).length >= 3, "every Robert fallback carries his walls");
  assert.match(src, /const wall = robertSandbox\(opts\.wsId\)/, "a routed one-shot runs walled");
  assert.match(src, /wall\.baseEnv \?\? process\.env/);
});

test("cursor: MCP send tools denied in cli-config.json, others' settings kept, idempotent", () => {
  const home = path.join(tmp, "home-c");
  const dir = path.join(home, ".cursor");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cli-config.json"), JSON.stringify({ version: 1, model: "auto", permissions: { allow: ["Shell(gh)"], deny: ["Shell(rm)"] } }));
  const added = ensureCursorNoSend(null, home);
  assert.ok(added > 0);
  assert.equal(ensureCursorNoSend(null, home), 0, "second run adds nothing");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "cli-config.json"), "utf8"));
  assert.equal(cfg.model, "auto");
  assert.deepEqual(cfg.permissions.allow, ["Shell(gh)"]);
  assert.ok(cfg.permissions.deny.includes("Shell(rm)"));
  assert.ok(cfg.permissions.deny.includes("Mcp(*:add_issue_comment)"));
  assert.ok(cfg.permissions.deny.includes("Mcp(*:slack_send_message)"));
  // Writing a draft stays; sending one (Gmail send_draft) does not.
  for (const keep of ["Mcp(*:create_draft)", "Mcp(*:slack_send_message_draft)", "Mcp(*:update_draft)"])
    assert.ok(!cursorNoSendRules().includes(keep), keep);
  assert.ok(cursorNoSendRules().includes("Mcp(*:send_draft)"));
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8")).hooks;
  assert.match(hooks.beforeShellExecution[0].command, /hook no-send/);
});

test("cursor: the shell hook fails open and is not gated on a Chronos terminal", () => {
  const cmd = cursorHooks().beforeShellExecution[0].command;
  assert.doesNotMatch(cmd, /MC_SESSION/);
  // An mc that does not know the hook prints nothing: cursor would block every command on that.
  const out = execFileSync("sh", ["-c", cmd.replace(/"\$HOME\/\.mc\/bin\/mc"/, "true")], { input: '{"command":"ls"}', encoding: "utf8" });
  assert.equal(out, '{"permission":"allow"}');
});

test("mc hook no-send: the same shell list as no-send.ts; sends refused, the rest allowed", () => {
  const mc = fs.readFileSync(new URL("../scripts/mc", import.meta.url), "utf8");
  const m = mc.match(/const NO_SEND_BASH = \[([\s\S]*?)\];/);
  assert.ok(m, "NO_SEND_BASH in scripts/mc");
  assert.deepEqual(JSON.parse(`[${m![1].trim().replace(/,\s*$/, "")}]`), SEND_BASH);
  const run = (command: string) =>
    JSON.parse(execFileSync(process.execPath, [new URL("../scripts/mc", import.meta.url).pathname, "hook", "no-send"], { input: JSON.stringify({ command }), encoding: "utf8" })).permission;
  assert.equal(run("gh pr comment 12 --body hi"), "deny");
  assert.equal(run("rtk gh pr comment --help"), "deny");
  assert.equal(run("curl -X POST https://slack.com/api/chat.postMessage -d x"), "deny");
  assert.equal(run("gh pr create --fill"), "allow");
  assert.equal(run("gh pr list"), "allow");
});

test("opencode: every spawn carries the deny layer (send tools + shell spellings)", () => {
  const cfg = JSON.parse(opencodeNoSendConfig());
  assert.equal(cfg.permission["*_slack_send_message"], "deny");
  assert.equal(cfg.permission.bash["*gh pr comment*"], "deny");
  assert.equal(cfg.permission["*_slack_send_message_draft"], undefined, "drafts stay");
  assert.equal(opencodeBackend.env({} as any, tmp).OPENCODE_CONFIG_CONTENT, opencodeNoSendConfig());
  assert.equal(opencodeBackend.oneShot({ prompt: "hi" } as any).env.OPENCODE_CONFIG_CONTENT, opencodeNoSendConfig());
});

test("tests never rewrite the operator's own cursor config", () => {
  assert.equal(ensureCursorNoSend(null), 0);
  void workspaces;
});
