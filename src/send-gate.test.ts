/**
 * The send gate (no-send.ts, "THE SEND GATE"): the one send any agent may make is a Slack DM to the
 * operator himself. Asked of the real `mc hook send-gate`, the real hook command around it, the real
 * argv a claude spawn gets and the real API route — never a model. The live check (claude 2.1.325, a
 * stand-in Slack server: the allowlisted send went through, another channel was refused by exit 2, a
 * project's `disableAllHooks: true` turned the hook off unless `--settings` pinned it on) was run by
 * hand when this landed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

process.env.CHRONOS_ADMIN_TOKEN ??= `send-gate-admin-${process.pid}`;
const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const NS = await import("./no-send.js");
const { claudeBackend } = await import("./backends/claude.js");
const { installClaudeHooks } = await import("./term-hooks.js");
const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { workspaces, workspaceVars } = await import("./store.js");

const MC = new URL("../scripts/mc", import.meta.url).pathname;
const SELF_U = "U0SELF0001";
const SELF_D = "D0SELF0001";
const SELF = `${SELF_U},${SELF_D}`;
const PASS = NS.SEND_GATE_PASS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-send-gate-"));
const home = path.join(tmp, "home"); // the mc child's HOME: no admin token file, no real profile
fs.mkdirSync(home, { recursive: true });
// A copy of mc, as ~/.mc/bin/mc is one: it looks for an admin token beside itself, and the checkout's own
// `.admin-token` (another test may have minted one) must never stand in for "the operator's shell".
const MC_COPY = path.join(tmp, "mcroot", "bin", "mc");
fs.mkdirSync(path.dirname(MC_COPY), { recursive: true });
fs.copyFileSync(MC, MC_COPY);
const NO_MANAGED = path.join(tmp, "no-managed-settings.json"); // never the machine's own managed settings

let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

/** A hook input as Claude Code hands it to a PreToolUse command. */
const call = (tool: string, input: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, session_id: "s1" });
const send = (input: Record<string, unknown>, server = "slack") => call(`mcp__${server}__slack_send_message`, input);

/** Run the real `mc hook send-gate` with a clean env (nothing of the test runner's MC_* leaks in). */
function gate(stdin: string, o: { allow?: string; env?: Record<string, string> } = {}): Promise<string> {
  const args = [MC_COPY, "hook", "send-gate", ...(o.allow !== undefined ? ["--allow", o.allow] : [])];
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, { env: { PATH: process.env.PATH ?? "", HOME: home, ...(o.env ?? {}) }, encoding: "utf8", timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(stdin);
  });
}
const passes = async (stdin: string, o?: Parameters<typeof gate>[1]) => assert.equal(await gate(stdin, o), PASS, stdin);
async function refuses(stdin: string, o?: Parameters<typeof gate>[1], why?: RegExp) {
  const out = await gate(stdin, o);
  assert.notEqual(out, PASS, stdin);
  assert.match(out, /draft/i, "a refusal tells the agent to leave a draft");
  if (why) assert.match(out, why);
}

test("allowlisted: his self-DM, his user id, a reply in his DM, a reminder scheduled there — on every server name", async () => {
  await passes(send({ channel_id: SELF_D, message: "done: PR merged" }), { allow: SELF });
  await passes(send({ channel_id: SELF_U, message: "done" }), { allow: SELF });
  await passes(send({ channel_id: SELF_D, message: "update", thread_ts: "1731500000.000100" }), { allow: SELF });
  await passes(call("mcp__slack__slack_schedule_message", { channel_id: SELF_D, message: "check CI", post_at: 1893456000 }), { allow: SELF });
  for (const s of ["plugin_slack_slack", "claude_ai_Slack"]) await passes(send({ channel_id: SELF_D, message: "hi" }, s), { allow: SELF });
});

test("refused: another DM, another person, a channel, a thread elsewhere, a scheduled message to others", async () => {
  await refuses(send({ channel_id: "D0OTHER001", message: "hi" }), { allow: SELF }, /not the operator's own DM/);
  await refuses(send({ channel_id: "U0OTHER001", message: "hi" }), { allow: SELF });
  await refuses(send({ channel_id: "C0CHAN0001", message: "deploy done" }), { allow: SELF });
  await refuses(send({ channel_id: "C0CHAN0001", message: "+1", thread_ts: "1731500000.000100" }), { allow: SELF });
  await refuses(call("mcp__claude_ai_Slack__slack_schedule_message", { channel_id: "C0CHAN0001", message: "reminder", post_at: 1893456000 }), { allow: SELF });
  await refuses(send({ channel_id: ` ${SELF_D}x`, message: "hi" }), { allow: SELF });
});

test("refused: a field that hides where it goes, no destination, a post_at on a plain send", async () => {
  await refuses(send({ channel_id: SELF_U, message: "hi", draft_id: "Dr0123" }), { allow: SELF }, /draft_id/);
  await refuses(send({ message: "hi" }), { allow: SELF });
  await refuses(send({ channel_id: SELF_D, message: "hi", post_at: 1893456000 }), { allow: SELF });
  await refuses(send({ channel_id: SELF_D, message: "hi", channel: "C0CHAN0001" }), { allow: SELF });
});

test("refused outright: email, comments and every other send tool, allowlist or not", async () => {
  for (const tool of ["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward",
    "mcp__claude_ai_Atlassian__addCommentToJiraIssue", "mcp__github__add_issue_comment", "mcp__slack__slack_add_reaction",
    "mcp__clickup__clickup_create_task_comment"]) {
    await refuses(call(tool, { to: SELF_U, channel_id: SELF_D, body: "x" }), { allow: SELF }, /agents do not send/);
  }
});

test("fails closed: malformed or empty input, a missing or malformed allowlist", async () => {
  await refuses("not json", { allow: SELF });
  await refuses("", { allow: SELF });
  await refuses(JSON.stringify({ tool_name: "mcp__slack__slack_send_message", tool_input: "a string" }), { allow: SELF });
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { allow: "" }, /OPERATOR_SLACK_SELF_IDS/);
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { allow: `${SELF_D},C0CHAN0001` }, /OPERATOR_SLACK_SELF_IDS/);
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { MC_SESSION: "t1" } }, /OPERATOR_SLACK_SELF_IDS/);
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { OPERATOR_SLACK_SELF_IDS: "my own dm" } });
});

test("whose list: the spawn's --allow wins over the env, and the env is the session's own workspace", async () => {
  // A Chronos session: its env names its workspace's ids.
  await passes(send({ channel_id: SELF_D, message: "hi" }), { env: { MC_SESSION: "t1", OPERATOR_SLACK_SELF_IDS: SELF } });
  // Workspace A's ids never open a send in workspace B: B's session carries B's list (or none).
  const B = "U0BBBB0001,D0BBBB0001";
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { MC_SESSION: "t2", OPERATOR_SLACK_SELF_IDS: B } });
  // The flag-level list is the session's: an env widened from inside it changes nothing.
  await refuses(send({ channel_id: "D0BBBB0001", message: "hi" }), { allow: SELF, env: { OPERATOR_SLACK_SELF_IDS: B } });
});

/** A stand-in daemon for a session started by hand: answers /api/no-send/self for one profile. */
async function fakeDaemon(byProfile: Record<string, string[]>) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    seen.push(`${req.headers["x-mc-admin"]}|${u.searchParams.get("profile")}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ids: byProfile[u.searchParams.get("profile") ?? ""] ?? [] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { api: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/api`, seen, close: () => srv.close() };
}

test("a session started by hand asks the daemon for its profile's ids; no daemon or no token: nothing", async () => {
  const profile = path.join(tmp, "profile-hand");
  const d = await fakeDaemon({ [profile]: [SELF_U, SELF_D] });
  try {
    const env = { MC_API: d.api, CHRONOS_ADMIN_TOKEN: "hand-token", CLAUDE_CONFIG_DIR: profile };
    await passes(send({ channel_id: SELF_D, message: "hi" }), { env });
    await refuses(send({ channel_id: "C0CHAN0001", message: "hi" }), { env });
    assert.deepEqual(d.seen, [`hand-token|${profile}`, `hand-token|${profile}`], "asked with his token, for this profile");
    await refuses(call("mcp__claude_ai_Gmail__send_message", { to: "x" }), { env });
    assert.equal(d.seen.length, 2, "an email is refused without asking anyone");
    await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { ...env, CLAUDE_CONFIG_DIR: path.join(tmp, "profile-other") } });
    // A Chronos process never falls back to a profile's ids, even with a daemon that would answer.
    await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { ...env, MC_RUN: "r1" } });
    const { CHRONOS_ADMIN_TOKEN: _t, ...noToken } = env;
    await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: noToken });
  } finally {
    d.close();
  }
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { MC_API: `http://127.0.0.1:1/api`, CHRONOS_ADMIN_TOKEN: "t", CLAUDE_CONFIG_DIR: profile } });
});

/** Run the hook command exactly as Claude Code would: `sh -c`, the call on stdin, our HOME. */
function hookRun(command: string, stdin: string, mcBody?: string) {
  const h = fs.mkdtempSync(path.join(tmp, "hook-home-"));
  if (mcBody !== undefined) {
    fs.mkdirSync(path.join(h, ".mc", "bin"), { recursive: true });
    fs.writeFileSync(path.join(h, ".mc", "bin", "mc"), mcBody, { mode: 0o755 });
  }
  return spawnSync("sh", ["-c", command], { input: stdin, env: { PATH: process.env.PATH ?? "", HOME: h }, encoding: "utf8" });
}

test("the hook command fails closed: only mc's pass line lets a call through (exit 0); everything else is exit 2", () => {
  const cmd = NS.sendGateCommand([SELF_U, SELF_D]);
  assert.match(cmd, /hook send-gate --allow U0SELF0001,D0SELF0001/);
  const ok = hookRun(cmd, "{}", `#!/bin/sh\necho "${PASS}"\n`);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout + ok.stderr, "", "a pass says nothing: the session's own permission rules still decide");
  const no = hookRun(cmd, "{}", `#!/bin/sh\necho "Chronos blocked mcp__slack__slack_send_message: not his DM"\n`);
  assert.equal(no.status, 2);
  assert.match(no.stderr, /not his DM/, "the reason reaches the agent");
  for (const [what, body] of [["crashed after printing the pass line", `#!/bin/sh\necho "${PASS}"\nexit 1\n`], ["an older mc that prints nothing", "#!/bin/sh\nexit 0\n"], ["garbage", "#!/bin/sh\necho allow\n"]] as const) {
    const r = hookRun(cmd, "{}", body);
    assert.equal(r.status, 2, what);
    assert.match(r.stderr, /draft/i, what);
  }
  const missing = hookRun(cmd, "{}");
  assert.equal(missing.status, 2, "no mc at all");
  // End to end with the real mc behind it.
  const real = fs.readFileSync(MC, "utf8");
  assert.equal(hookRun(cmd, send({ channel_id: SELF_D, message: "hi" }), real).status, 0);
  assert.equal(hookRun(cmd, send({ channel_id: "C0CHAN0001", message: "hi" }), real).status, 2);
  assert.equal(hookRun(NS.sendGateCommand(), send({ channel_id: SELF_D, message: "hi" }), real).status, 2, "a profile's hook with no list and no daemon: refused");
});

test("scripts/mc gates the same posting tools and prints the same pass line as no-send.ts", () => {
  const src = fs.readFileSync(MC, "utf8");
  const m = src.match(/const SLACK_SELF_SEND = (\[[^\]]*\]);/);
  assert.ok(m, "SLACK_SELF_SEND in scripts/mc");
  assert.deepEqual(JSON.parse(m![1]), NS.SLACK_SELF_SEND_TOOLS);
  assert.ok(src.includes(`const GATE_PASS = ${JSON.stringify(PASS)};`));
});

// ── the spawn's argv ──────────────────────────────────────────────────────────────────────────────

const denyOf = (args: string[]) => args[args.indexOf("--disallowed-tools") + 1].split(",");
const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]);

test("openSlackSelfSend: the posting tools leave the deny flag, the gate joins one --settings, the rest stays denied", () => {
  const args = claudeBackend.interactiveArgs!(null, null, [], "s1", false);
  args.push("--settings", JSON.stringify({ skillOverrides: { foo: "name-only" } }));
  const dm = NS.openSlackSelfSend(args, [SELF_U, SELF_D], { managedFile: NO_MANAGED });
  assert.equal(dm, SELF_D, "MC_OPERATOR_SLACK_DM is his self-DM channel");
  const deny = denyOf(args);
  for (const r of NS.slackSelfSendRules()) assert.ok(!deny.includes(r), r);
  for (const r of ["mcp__*__send_message", "mcp__*__reply", "mcp__*__slack_add_reaction", "mcp__claude_ai_Gmail__forward", "Bash(*chat.postMessage*)"])
    assert.ok(deny.includes(r), `${r} stays denied`);
  assert.equal(args.filter((a) => a === "--settings").length, 1, "merged, never a second --settings that would shadow the first");
  assert.equal(args.filter((a) => a === "--disallowed-tools").length, 1);
  const s = settingsOf(args);
  assert.deepEqual(s.skillOverrides, { foo: "name-only" }, "what was there is kept");
  assert.equal(s.disableAllHooks, false, "a project settings file cannot switch the gate off");
  const [entry] = s.hooks.PreToolUse;
  assert.equal(entry.matcher, NS.SEND_GATE_FLAG_MATCHER);
  assert.equal(entry.hooks[0].onFailure, "block");
  assert.match(entry.hooks[0].command, /hook send-gate --allow U0SELF0001,D0SELF0001/);
  const re = new RegExp(entry.matcher);
  for (const t of ["mcp__slack__slack_send_message", "mcp__plugin_slack_slack__slack_send_message", "mcp__claude_ai_Slack__slack_schedule_message"]) assert.ok(re.test(t), t);
  for (const t of ["mcp__slack__slack_send_message_draft", "mcp__slack__slack_read_channel", "Bash"]) assert.ok(!re.test(t), t);
});

test("openSlackSelfSend keeps the gate shut — args untouched — whenever it cannot be sure the hook runs", () => {
  const fresh = () => claudeBackend.interactiveArgs!(null, null, [], "s1", false);
  const shut = (args: string[], ids: string[], o: Parameters<typeof NS.openSlackSelfSend>[2] = {}) => {
    const before = [...args];
    assert.equal(NS.openSlackSelfSend(args, ids, { managedFile: NO_MANAGED, ...o }), null);
    assert.deepEqual(args, before);
  };
  shut(fresh(), []);
  shut(fresh(), [SELF_D, "C0CHAN0001"]);
  shut([...fresh(), "--settings", "/path/to/settings.json"], [SELF_D]);
  shut([...fresh(), "--settings", "{}", "--settings", "{}"], [SELF_D]);
  shut(["-p", "x"], [SELF_D]); // no deny flag at all: nothing to open
  const managed = path.join(tmp, "managed.json");
  fs.writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }));
  shut(fresh(), [SELF_D], { managedFile: managed });
  fs.writeFileSync(managed, "{ half an edit");
  shut(fresh(), [SELF_D], { managedFile: managed });
  const profile = fs.mkdtempSync(path.join(tmp, "profile-remote-"));
  fs.writeFileSync(path.join(profile, "remote-settings.json"), JSON.stringify({ settings: { disableAllHooks: true } }));
  shut(fresh(), [SELF_D], { profileDir: profile });
});

test("a job's own deny of a posting tool survives the gate", () => {
  const job = { goal: "g", model: "sonnet", disallowed_tools: "mcp__slack__slack_send_message,Edit" } as any;
  const args = claudeBackend.buildArgs(job, "s1", null);
  assert.equal(NS.openSlackSelfSend(args, [SELF_D], { managedFile: NO_MANAGED, keep: job.disallowed_tools }), SELF_D);
  const deny = denyOf(args);
  assert.ok(deny.includes("mcp__slack__slack_send_message") && deny.includes("Edit"));
  assert.ok(!deny.includes("mcp__claude_ai_Slack__slack_send_message"));
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /DRAFT EVERYWHERE/);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /\$MC_OPERATOR_SLACK_DM/);
});

test("ids: only U/W/D ids, one bad entry voids the list; the DM channel is preferred for MC_OPERATOR_SLACK_DM", () => {
  assert.deepEqual(NS.parseSlackSelfIds(` ${SELF_U} , ${SELF_D} `), [SELF_U, SELF_D]);
  assert.deepEqual(NS.parseSlackSelfIds("W0GRID0001"), ["W0GRID0001"]);
  for (const bad of ["", "C0CHAN0001", `${SELF_U},#general`, "u0lower001", `${SELF_D};rm -rf`]) assert.deepEqual(NS.parseSlackSelfIds(bad), [], bad);
  assert.equal(NS.operatorSlackDm([SELF_U, SELF_D]), SELF_D);
  assert.equal(NS.operatorSlackDm([SELF_U]), SELF_U);
  assert.equal(NS.operatorSlackDm([]), null);
  assert.deepEqual(NS.operatorSlackIds({ OPERATOR_SLACK_SELF_IDS: SELF }), [SELF_U, SELF_D]);
  assert.deepEqual(NS.operatorSlackIds({}), []);
});

// ── a session started by hand: which workspace's ids ──────────────────────────────────────────────

test("profileSelfSend: the one workspace on that profile; another profile's never; a shared profile only when all agree", () => {
  const p1 = fs.mkdtempSync(path.join(tmp, "p1-"));
  const p2 = fs.mkdtempSync(path.join(tmp, "p2-"));
  const A = { config_dir: p1, ids: [SELF_U, SELF_D] };
  const B = { config_dir: p2, ids: ["U0BBBB0001"] };
  assert.deepEqual(NS.profileSelfSend(p1, [A, B]).ids, [SELF_U, SELF_D]);
  assert.deepEqual(NS.profileSelfSend(p2, [A, B]).ids, ["U0BBBB0001"]);
  assert.deepEqual(NS.profileSelfSend(path.join(tmp, "nobody"), [A, B]).ids, []);
  assert.deepEqual(NS.profileSelfSend("", [A, B]).ids, []);
  assert.deepEqual(NS.profileSelfSend(p1, [A, { config_dir: p1, ids: [SELF_D, SELF_U] }]).ids, [SELF_U, SELF_D], "same ids, any order");
  assert.deepEqual(NS.profileSelfSend(p1, [A, { config_dir: p1, ids: [] }]).ids, [], "one workspace on it has none");
  assert.deepEqual(NS.profileSelfSend(p1, [A, { config_dir: p1, ids: ["U0BBBB0001"] }]).ids, [], "they disagree");
  const link = path.join(tmp, "p1-link");
  fs.symlinkSync(p1, link);
  assert.deepEqual(NS.profileSelfSend(link, [A]).ids, [SELF_U, SELF_D], "a linked path is the same profile");
});

test("GET /api/no-send/self: the operator's token only; answers from the workspace vars of that profile alone", async () => {
  const pa = fs.mkdtempSync(path.join(tmp, "route-a-"));
  const pb = fs.mkdtempSync(path.join(tmp, "route-b-"));
  const A = workspaces.create({ slug: `sg-a-${Date.now()}`, name: "Acme", config_dir: pa, default_dir: path.join(tmp, "a") } as any);
  const B = workspaces.create({ slug: `sg-b-${Date.now()}`, name: "Initech", config_dir: pb, default_dir: path.join(tmp, "b") } as any);
  workspaceVars.set(A.id, "OPERATOR_SLACK_SELF_IDS", SELF, null);
  const base = `http://127.0.0.1:${PORT}/api/no-send/self?profile=`;
  const get = (p: string, headers: Record<string, string>) => fetch(base + encodeURIComponent(p), { headers }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const admin = { "x-mc-admin": CONFIG.adminToken };
  assert.deepEqual((await get(pa, admin)).json.ids, [SELF_U, SELF_D]);
  assert.deepEqual((await get(pb, admin)).json.ids, [], "B named no ids: A's never stand in for them");
  for (const h of [{ "x-mc-workspace-token": workspaces.get(A.id)!.token! }, {}]) assert.equal((await get(pa, h)).status >= 400, true);
  // The whole chain for a hand-started session on A's profile: mc → this daemon → A's ids.
  const env = { MC_API: `http://127.0.0.1:${PORT}/api`, CHRONOS_ADMIN_TOKEN: CONFIG.adminToken, CLAUDE_CONFIG_DIR: pa };
  await passes(send({ channel_id: SELF_D, message: "hi" }), { env });
  await refuses(send({ channel_id: SELF_D, message: "hi" }), { env: { ...env, CLAUDE_CONFIG_DIR: pb } });
});

// ── every profile's settings.json, for the sessions he starts himself ─────────────────────────────

test("installClaudeSendGate merges into a profile's settings, backs up once, is idempotent and leaves the card hooks alone", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "profile-"));
  const file = path.join(dir, "settings.json");
  const theirs = {
    env: { FOO: "1" },
    permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm -rf:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/guard.sh" }] }],
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
    statusLine: { type: "command", command: "~/status.sh" },
    theme: "dark",
  };
  const original = JSON.stringify(theirs, null, 4);
  fs.writeFileSync(file, original);
  assert.equal(NS.installClaudeSendGate(dir), "written");
  const got = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(got), Object.keys(theirs), "every key kept, in its place");
  assert.deepEqual(got.env, theirs.env);
  assert.deepEqual(got.permissions, theirs.permissions);
  assert.deepEqual(got.hooks.Stop, theirs.hooks.Stop);
  assert.deepEqual(got.hooks.PreToolUse[0], theirs.hooks.PreToolUse[0], "his own PreToolUse hook stays first");
  assert.deepEqual(got.hooks.PreToolUse[1], NS.profileSendGateEntry());
  assert.equal(fs.readFileSync(file + NS.SEND_GATE_BACKUP, "utf8"), original, "the original, beside it");
  const re = new RegExp(got.hooks.PreToolUse[1].matcher);
  for (const t of ["mcp__slack__slack_send_message", "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Atlassian__addCommentToJiraIssue"]) assert.ok(re.test(t), t);
  for (const t of ["mcp__slack__slack_send_message_draft", "mcp__claude_ai_Gmail__create_draft", "Bash", "mcp__slack__slack_read_thread"]) assert.ok(!re.test(t), t);

  const once = fs.readFileSync(file, "utf8");
  assert.equal(NS.installClaudeSendGate(dir), "noop");
  assert.equal(fs.readFileSync(file, "utf8"), once, "byte-identical on the second run");
  // Card hooks and the gate keep each other: neither installer drops or reorders the other's entry.
  installClaudeHooks(dir);
  const withCards = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(withCards.hooks.PreToolUse.some((e: any) => JSON.stringify(e) === JSON.stringify(NS.profileSendGateEntry())), "the card installer keeps the gate");
  assert.equal(NS.installClaudeSendGate(dir), "noop", "and the gate installer keeps the cards");
  // An older gate entry is replaced where it stands, never doubled; the backup is never overwritten.
  const stale = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = stale.hooks.PreToolUse.findIndex((e: any) => /hook send-gate/.test(e.hooks[0].command));
  stale.hooks.PreToolUse[at] = { matcher: "old", hooks: [{ type: "command", command: `"$HOME/.mc/bin/mc" hook send-gate` }] };
  fs.writeFileSync(file, JSON.stringify(stale, null, 2));
  assert.equal(NS.installClaudeSendGate(dir), "written");
  const fixed = JSON.parse(fs.readFileSync(file, "utf8")).hooks.PreToolUse;
  assert.deepEqual(fixed[at], NS.profileSendGateEntry());
  assert.equal(fixed.filter((e: any) => /hook send-gate/.test(e.hooks[0].command)).length, 1);
  assert.equal(fs.readFileSync(file + NS.SEND_GATE_BACKUP, "utf8"), original);
});

test("installClaudeSendGate: through a linked settings.json, a new profile, a half-edited file, never a real profile in tests", () => {
  // Linked (two profiles sharing one settings.json): the target changes, the link stays a link.
  const shared = fs.mkdtempSync(path.join(tmp, "shared-"));
  fs.writeFileSync(path.join(shared, "settings.json"), JSON.stringify({ theme: "light" }));
  const linked = fs.mkdtempSync(path.join(tmp, "linked-"));
  fs.symlinkSync(path.join(shared, "settings.json"), path.join(linked, "settings.json"));
  assert.equal(NS.installClaudeSendGate(linked), "written");
  assert.ok(fs.lstatSync(path.join(linked, "settings.json")).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared, "settings.json"), "utf8")).hooks.PreToolUse.length, 1);
  assert.equal(NS.installClaudeSendGate(shared), "noop", "the other profile on the same file: already there");
  // No settings.json yet: created with the gate alone, nothing to back up.
  const fresh = fs.mkdtempSync(path.join(tmp, "fresh-"));
  assert.equal(NS.installClaudeSendGate(fresh), "written");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, "settings.json"), "utf8")), { hooks: { PreToolUse: [NS.profileSendGateEntry()] } });
  assert.ok(!fs.existsSync(path.join(fresh, "settings.json" + NS.SEND_GATE_BACKUP)));
  // Half an edit: left exactly as it is.
  const broken = fs.mkdtempSync(path.join(tmp, "broken-"));
  fs.writeFileSync(path.join(broken, "settings.json"), '{ "theme": ');
  assert.equal(NS.installClaudeSendGate(broken), "skipped");
  assert.equal(fs.readFileSync(path.join(broken, "settings.json"), "utf8"), '{ "theme": ');
  fs.writeFileSync(path.join(broken, "settings.json"), JSON.stringify({ hooks: { PreToolUse: "nope" } }));
  assert.equal(NS.installClaudeSendGate(broken), "skipped");
  assert.equal(NS.installClaudeSendGate(path.join(tmp, "missing-dir")), "skipped");
  // Under test, a profile in the (here: stand-in) home is never touched.
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(path.join(tmp, "fake-home-"));
  fs.mkdirSync(path.join(fakeHome, ".claude-acme"));
  process.env.HOME = fakeHome;
  try {
    assert.equal(NS.installClaudeSendGate(path.join(fakeHome, ".claude-acme")), "skipped");
    assert.ok(!fs.existsSync(path.join(fakeHome, ".claude-acme", "settings.json")));
  } finally {
    process.env.HOME = realHome;
  }
});
