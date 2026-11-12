/**
 * A whole Robert turn under robert.hands = answers, through the real askManagerWeb and WarmManager,
 * with a stand-in `claude` that plays a scripted turn ([[plan:read,api,…]] in the message): a work
 * turn past its budget is cut and handed to a terminal, while a status brief, a wake, a turn where he
 * opened the terminal himself, and `anything` all run to their own answer. Then the routes: the knob
 * through GET/PUT /api/settings, and a fleet-wide Robert opening a terminal with no project.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rh-turn-home-")));
process.env.HOME = HOME;
process.env.CHRONOS_INBOX_CLEANUP = "0";
process.env.CHRONOS_JOB_CHECK = "0";
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);

// The stand-in CLI: one line in the log per spawn, per tool call it starts, and per finished turn.
const LOG = path.join(HOME, "fake-claude.log");
const BIN = path.join(HOME, "fake-claude");
fs.writeFileSync(BIN, `#!${process.execPath}
const fs = require("fs");
const LOG = ${JSON.stringify(LOG)};
fs.appendFileSync(LOG, "spawn\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const CALL = {
  read: (n) => ({ name: "Read", input: { file_path: "/tmp/fake-" + n + ".ts" } }),
  api: () => ({ name: "Bash", input: { command: 'curl -s -H "x-mc-admin: $CHRONOS_ADMIN" http://localhost:7777/api/fleet' } }),
  open: () => ({ name: "Bash", input: { command: 'curl -s -X POST -H "x-mc-admin: $CHRONOS_ADMIN" -H "content-type: application/json" http://localhost:7777/api/sessions -d \\'{"role":"worker","goal":"x"}\\'' } }),
};
let n = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const text = (m.message && m.message.content || []).map((b) => b.text || "").join("");
  const plan = ((/\\[\\[plan:([^\\]]*)\\]\\]/.exec(text) || [])[1] || "").split(",").filter(Boolean);
  const reply = (/\\[\\[reply:([^\\]]*)\\]\\]/.exec(text) || [])[1] || "done";
  out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Looking. " } } });
  let i = 0;
  const next = () => {
    if (i >= plan.length) {
      fs.appendFileSync(LOG, "result\\n");
      return out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: "fake-session" });
    }
    const kind = plan[i++]; const id = "t" + (++n);
    fs.appendFileSync(LOG, "tool " + kind + "\\n");
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, ...CALL[kind](n) }] } });
    setTimeout(() => { out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }); setTimeout(next, 20); }, 20);
  };
  next();
});
`, { mode: 0o755 });
process.env.CHRONOS_CLAUDE_BIN = BIN;

const { askManagerWeb, robertManagersForTest } = await import("./telegram/agent.js");
const { setHandOffOpener } = await import("./robert-hands.js");
const { writeSetting } = await import("./settings.js");
const { sessions, workspaces } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const { CONFIG } = await import("./config.js");
const { sandboxAvailable, SANDBOX_EXEC } = await import("./sandbox.js");
const { startServer } = await import("./api.js");

// His warm process runs under sandbox-exec (guard) like the real one; inside a sandbox that cannot
// nest another (a guard Desk terminal) the spawn itself fails, so the turn tests skip there.
const nests = sandboxAvailable() && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const skip = nests ? false : "needs sandbox-exec, and a parent that lets it nest";

type Opened = { workspace_id: string; goal: string; description: string };
const opened: Opened[] = [];
const turnLog = () => fs.readFileSync(LOG, "utf8");
const count = (re: RegExp) => (turnLog().match(re) ?? []).length;

function project(slug: string) {
  return workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 7)}`, name: slug, config_dir: fs.mkdtempSync(path.join(HOME, ".claude-")) } as any);
}
/** Each test starts with an empty log and a stub opener, and ends with no stand-in left running. */
async function turn(wsId: string, fn: () => Promise<void>) {
  fs.writeFileSync(LOG, "");
  opened.length = 0;
  setHandOffOpener(async (o) => { opened.push(o as Opened); return { id: "feedc0de-0000-4000-8000-000000000000" }; });
  try {
    await fn();
  } finally {
    setHandOffOpener(null);
    const m = robertManagersForTest(wsId);
    m.operator?.kill();
    m.wake?.kill();
  }
}
const reads = (n: number) => Array.from({ length: n }, () => "read").join(",");

test("a work turn past its budget is cut, a terminal opens with his request, and the reply is one line", { skip }, async () => {
  const w = project("turn-work");
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:${reads(7)}]] fix the typo in README`, undefined, w.id, { chat: { words: "fix the typo in README" } });
    assert.equal(out.reply, "That's more than a quick answer — I opened a terminal for it: fix the typo in README · feedc0de");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].workspace_id, w.id);
    assert.equal(opened[0].goal, "fix the typo in README");
    assert.match(opened[0].description, /- Read fake-1\.ts/);
    assert.ok(out.steps.some((s) => s.text === "Opened a terminal: “fix the typo in README”"), "the open is one of the turn's steps");
    assert.equal(count(/^spawn$/gm), 1, "one process: nothing respawned it, no fallback engine re-ran the turn");
    assert.equal(count(/^result$/gm), 0, "the turn never got to finish the work itself");
    assert.ok(count(/^tool /gm) < 7, `cut at the fifth outside look, not after all seven (${count(/^tool /gm)})`);
    assert.equal(robertManagersForTest(w.id).operator, undefined, "his process is gone; the next turn resumes the session");
  });
});

test("the same turn read aloud: one spoken sentence, no id", { skip }, async () => {
  const w = project("turn-voice");
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:${reads(7)}]] research the best sqlite backup approach and write it up`, undefined, w.id, {
      voice: true, chat: { words: "research the best sqlite backup approach and write it up", spoken: true },
    });
    assert.equal(out.reply, "That's more than a quick answer, so I opened a terminal for it: research the best sqlite backup approach and write it up.");
  });
});

test("a status brief takes its nine reads and answers inline", { skip }, async () => {
  const w = project("turn-status");
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:${Array(9).fill("api").join(",")}]][[reply:Quiet shop.]] status`, undefined, w.id, { chat: { words: "status" } });
    assert.equal(out.reply, "Quiet shop.");
    assert.equal(opened.length, 0);
    assert.equal(count(/^result$/gm), 1);
  });
});

test("a wake carries no budget, however much it reads", { skip }, async () => {
  const w = project("turn-wake");
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:${reads(7)}]][[reply:Looked.]] a terminal stopped`, undefined, w.id, { lane: "wake" });
    assert.equal(out.reply, "Looked.");
    assert.equal(opened.length, 0);
  });
});

test("when he opens the terminal himself, the rest of the turn is his", { skip }, async () => {
  const w = project("turn-routed");
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:read,open,${reads(6)}]][[reply:Opened it.]] fix the login bug`, undefined, w.id, { chat: { words: "fix the login bug" } });
    assert.equal(out.reply, "Opened it.");
    assert.equal(opened.length, 0, "no second terminal");
  });
});

test("anything: the old behaviour — no budget at all", { skip }, async () => {
  const w = project("turn-anything");
  writeSetting("robert.hands", "anything", w.id);
  await turn(w.id, async () => {
    const out = await askManagerWeb(`[[plan:${reads(7)}]][[reply:Fixed it.]] fix the typo in README`, undefined, w.id, { chat: { words: "fix the typo in README" } });
    assert.equal(out.reply, "Fixed it.");
    assert.equal(opened.length, 0);
  });
});

// ───────────────────────────── the routes ─────────────────────────────

let server: any;
before(() => { server = startServer(); });
after(() => server?.close?.());

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const operator = { "x-mc-admin": CONFIG.adminToken };
const fleet = { "x-mc-admin": robertToken(null, "rw", "operator") };

test("the knob through the Settings routes: shown, set by the operator, never loosened by Robert", async () => {
  const g = await call("GET", "/settings", operator);
  const v = g.json.settings.find((s: any) => s.key === "robert.hands");
  assert.equal(v.value, "answers");
  assert.equal(v.group, "Robert");
  assert.ok(v.help.length > 40);
  assert.equal((await call("PUT", "/settings", fleet, { key: "robert.hands", value: "anything" })).status, 403);
  assert.equal((await call("PUT", "/settings", fleet, { key: "robert.hands", value: "answers" })).status, 200, "tightening is his to do");
  const put = await call("PUT", "/settings", operator, { key: "robert.hands", value: "anything" });
  assert.equal(put.status, 200);
  assert.equal((await call("GET", "/settings", operator)).json.settings.find((s: any) => s.key === "robert.hands").value, "anything");
  assert.equal((await call("PUT", "/settings", operator, { key: "robert.hands", value: null })).status, 200);
});

test("the fleet-wide Robert opening a terminal with no project: it goes to the home project, created on first need", async () => {
  for (const w of workspaces.list(true)) workspaces.remove(w.id);
  // No project at all → POST /sessions creates Personal. A taken agent name stops it just before any
  // pty is spawned, so the test sees the decision without a terminal.
  sessions.create({ cwd: HOME, agent_name: "probe" } as any);
  const r = await call("POST", "/sessions", fleet, { role: "worker", goal: "research sqlite backups", agent_name: "probe" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /agent_name `probe` already in use/);
  const made = workspaces.list();
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, "personal");
  assert.equal(made[0].default_dir, path.join(HOME, ".chronos-landing", "personal"));
  // With it there, the open lands in it: its seat cap (1, already taken) is what refuses this one.
  writeSetting("limits.max_terminals", 1, made[0].id);
  sessions.create({ cwd: HOME, workspace_id: made[0].id } as any);
  const again = await call("POST", "/sessions", fleet, { role: "worker", goal: "write the release notes" });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /workspace session cap reached \(1\/1\)/);
  // The operator's own open is his to place: no project is put on it — the seat cap above never
  // applies, it is refused (before any spawn) only for the taken name.
  const mine = await call("POST", "/sessions", operator, { role: "human", goal: "poke around", agent_name: "probe" });
  assert.equal(mine.status, 400);
  assert.match(mine.json.error, /agent_name `probe` already in use/);
  assert.equal(workspaces.list().length, 1);
});
