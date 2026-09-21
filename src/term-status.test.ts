/**
 * The seven phases: what a card says for every combination of declaration, hooks and pty.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { applyHook, declare, resolve, signalsOf, HOOK_WORKING_SILENCE_MS, type ResolveInput, type Signals } from "./term-status.js";
import { claudeStyleHooks, grokHooksToml, installClaudeHooks, installCursorHooks, installGrokHooks, mergeHooks } from "./term-hooks.js";

const NOW = 1_800_000_000_000;
const base = (over: Partial<ResolveInput> = {}, signals: Signals = {}): ResolveInput => ({
  live: true, goalDone: false, goal: "fix the DAG", signals, quiet: false, lastOut: NOW - 1000, lastIn: null,
  prompt: null, ask: null, daemonBlock: null, demandInspection: false, narration: "Now checking the auth middleware.", result: null,
  now: NOW, ...over,
});

test("pty only (no hooks): bytes = working with its narration, silence = your turn", () => {
  const w = resolve(base());
  assert.equal(w.phase, "working");
  assert.equal(w.line, "Now checking the auth middleware.");
  assert.equal(w.needs_you, false);
  const t = resolve(base({ quiet: true, lastOut: NOW - 60_000 }));
  assert.equal(t.phase, "your_turn");
  assert.equal(t.word, "your turn");
});

test("a turn that ended with background subagents still running is waiting, not your turn", () => {
  const sig: Signals = {
    turn: { state: "stopped", at: NOW - 5000 },
    subagents: { a: { label: "parse invoices", at: NOW - 9000 }, b: { label: "map vendors", at: NOW - 9000 }, c: { label: "map vendors", at: NOW - 9000 } },
  };
  // The CLI's status line keeps printing while they run: pty bytes must not flip it to working.
  const r = resolve(base({ quiet: false }, sig));
  assert.equal(r.phase, "waiting");
  assert.equal(r.on, "subagents");
  assert.equal(r.subagents, 3);
  assert.equal(r.line, "3 subagents: parse invoices, map vendors ×2");
});

test("hooks own the turn: working until Stop, and a missed Stop does not stay green forever", () => {
  const sig: Signals = { turn: { state: "working", at: NOW - 60_000 } };
  assert.equal(resolve(base({ quiet: true, lastOut: NOW - 5000 }, sig)).phase, "working");
  assert.equal(resolve(base({ quiet: true, lastOut: NOW - HOOK_WORKING_SILENCE_MS - 1 }, sig)).phase, "your_turn");
});

test("precedence: blocked > decide > review > waiting > working", () => {
  const blocked: Signals = { declared: { state: "blocked", label: "need prod bucket write", reason: "auth", at: NOW - 1000 } };
  assert.equal(resolve(base({ goalDone: true, ask: { question: "drop it?", options: [], escalated: true } }, blocked)).phase, "blocked");
  const r = resolve(base({ goalDone: true, ask: { question: "drop the view?", options: ["drop", "keep"], escalated: true } }));
  assert.equal(r.phase, "decide");
  assert.equal(r.line, "drop the view? (drop / keep)");
  assert.equal(r.needs_you, true);
  assert.equal(resolve(base({ goalDone: true, result: "Result: PR #214 is open and CI is green. More text." })).line, "PR #214 is open and CI is green.");
  const waiting: Signals = { declared: { state: "waiting", label: "CI on PR #214", on: "ci", eta_at: NOW + 10 * 60000, at: NOW - 1000 } };
  const w = resolve(base({}, waiting));
  assert.equal(w.phase, "waiting");
  assert.equal(w.line, "CI on PR #214 · ~10m");
});

test("an ask still with Robert reads waiting on Robert; escalated it reads decide", () => {
  const q = { question: "mirror the cost column?", options: [], escalated: false };
  const r = resolve(base({ quiet: true, ask: q }));
  assert.equal(r.phase, "waiting");
  assert.equal(r.on, "robert");
  assert.equal(resolve(base({ quiet: true, ask: { ...q, escalated: true } })).phase, "decide");
});

test("a question read off the screen is decide; a finished turn's last line is not", () => {
  const sel = resolve(base({ quiet: true, prompt: { kind: "select", question: "Allow this command?", options: [] } as any }));
  assert.equal(sel.phase, "decide");
  assert.equal(resolve(base({ quiet: true, prompt: { kind: "turn", question: "? for shortcuts", options: [] } as any })).phase, "your_turn");
});

test("working line: progress, then the agent's label, then narration — never a tool call", () => {
  assert.equal(resolve(base({}, { progress: { n: 2, of: 5, label: "migrations", at: NOW } })).line, "2/5 · migrations");
  assert.equal(resolve(base({}, { work_label: { text: "bisecting", at: NOW } })).line, "bisecting");
});

test("the line comes from the closing **Summary:** paragraph", () => {
  assert.equal(resolve(base({ goalDone: true, result: "**Summary:** Rollback PR is open and green. Waiting on you." })).line, "Rollback PR is open and green.");
});

test("the line is plain text: no markdown, no Result:/Verdict: label", () => {
  const r = resolve(base({ narration: null, goalDone: true, result: "**Verdict:** Posted — [PR 3094](https://github.com/x/pull/3094). **Receipts:** more" }));
  assert.equal(r.line, "Posted — PR 3094.");
});

test("stalled: the liveness supervisor asked for a look", () => {
  const r = resolve(base({ quiet: true, lastOut: NOW - 20 * 60000, demandInspection: true }));
  assert.equal(r.phase, "stalled");
  assert.match(r.line, /silent 20m/);
});

test("a daemon block with reason question (ask-robert's own overlay) is not a wall", () => {
  assert.equal(resolve(base({ quiet: true, daemonBlock: { label: "q", reason: "question" } })).phase, "your_turn");
  assert.equal(resolve(base({ daemonBlock: { label: null, reason: "auth" } })).line, "needs a login");
});

// ── writers, against the store ─────────────────────────────────────────────────────────────────
beforeEach(() => {
  db.exec("DELETE FROM session_status; DELETE FROM sessions; DELETE FROM workspaces;");
});
let n = 0;
const mk = () => {
  const ws = workspaces.create({ slug: `ts${++n}`, name: "TS", config_dir: "/tmp/ts" });
  return sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "g" } as any);
};

test("declarations persist, and a submitted prompt clears everything but review", () => {
  const s = mk();
  declare(s.id, { state: "blocked", label: "need a login", reason: "auth" }, NOW);
  assert.equal(signalsOf(s.id).declared?.state, "blocked");
  const row = db.prepare("SELECT data FROM session_status WHERE session_id = ?").get(s.id) as { data: string };
  assert.equal(JSON.parse(row.data).declared.label, "need a login");
  applyHook(s.id, { event: "prompt" }, NOW + 5000);
  assert.equal(signalsOf(s.id).declared, null);
  declare(s.id, { state: "done", label: "PR open" }, NOW + 6000);
  assert.equal(signalsOf(s.id).declared?.state, "review");
  applyHook(s.id, { event: "prompt" }, NOW + 9000);
  assert.equal(signalsOf(s.id).declared?.state, "review");
  declare(s.id, { state: "waiting", label: "CI", on: "ci", eta_min: 10 }, NOW + 10_000);
  assert.equal(signalsOf(s.id).declared?.eta_at, NOW + 10_000 + 600_000);
  declare(s.id, { state: "idle" }, NOW + 11_000);
  assert.equal(signalsOf(s.id).declared, null);
});

test("hooks: subagents counted by key, a Stop's task list wins, the question tool opens and closes", () => {
  const s = mk();
  applyHook(s.id, { event: "prompt" }, NOW);
  applyHook(s.id, { event: "subagent_start", key: "a1", label: "parse invoices" }, NOW + 1);
  applyHook(s.id, { event: "subagent_start", key: "a2", label: "map vendors" }, NOW + 2);
  applyHook(s.id, { event: "stop" }, NOW + 3);
  assert.equal(Object.keys(signalsOf(s.id).subagents!).length, 2);
  assert.equal(signalsOf(s.id).turn?.state, "stopped");
  applyHook(s.id, { event: "subagent_stop", key: "a1" }, NOW + 4);
  assert.deepEqual(Object.keys(signalsOf(s.id).subagents!), ["a2"]);
  assert.equal(signalsOf(s.id).turn?.state, "working"); // the main agent wakes to read the result
  // No key (cursor's subagentStop): match by label, else the oldest.
  applyHook(s.id, { event: "subagent_stop", label: "map vendors" }, NOW + 5);
  assert.deepEqual(Object.keys(signalsOf(s.id).subagents!), []);
  applyHook(s.id, { event: "stop", tasks: [{ key: "bg1", label: "explore" }] }, NOW + 6);
  assert.deepEqual(Object.keys(signalsOf(s.id).subagents!), ["bg1"]);
  applyHook(s.id, { event: "ask", question: "Which schema?", options: ["staging", "prod"] }, NOW + 7);
  assert.equal(signalsOf(s.id).asking?.question, "Which schema?");
  applyHook(s.id, { event: "answered" }, NOW + 8);
  assert.equal(signalsOf(s.id).asking, null);
});

test("grok's PermissionRequest never becomes a stuck decide: it self-clears on the CLI's next hook, a real question does not", () => {
  const s = mk();
  // Auto-approved tool permission: fires "ask" with kind "permission", no answered/posttooluse behind it.
  applyHook(s.id, { event: "ask", question: "allow Bash?", options: ["yes", "no"], kind: "permission" }, NOW);
  assert.equal(signalsOf(s.id).asking?.question, "allow Bash?");
  // The agent keeps working — its very next hook call (another tool's permission gate here) proves
  // it was never parked, so the stale permission ask must not survive to sit the card on decide.
  applyHook(s.id, { event: "ask", question: "allow Read?", options: ["yes", "no"], kind: "permission" }, NOW + 1000);
  assert.equal(signalsOf(s.id).asking?.question, "allow Read?");
  applyHook(s.id, { event: "subagent_start", key: "a1", label: "explore" }, NOW + 2000);
  assert.equal(signalsOf(s.id).asking, null, "a stale permission-kind ask must clear on the next hook, not linger for minutes");
  // A real question tool (no kind) is the genuine block and must still park the card until answered.
  applyHook(s.id, { event: "ask", question: "Which schema?", options: ["staging", "prod"] }, NOW + 3000);
  applyHook(s.id, { event: "subagent_start", key: "a2", label: "still working" }, NOW + 4000);
  assert.equal(signalsOf(s.id).asking?.question, "Which schema?", "a real ask must not be cleared by an unrelated hook");
  applyHook(s.id, { event: "answered" }, NOW + 5000);
  assert.equal(signalsOf(s.id).asking, null);
});

// ── installers ─────────────────────────────────────────────────────────────────────────────────
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "term-hooks-"));

test("claude: merged beside the operator's own hooks, reinstall does not stack copies", () => {
  const dir = tmp();
  const theirs = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }] };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus", hooks: theirs }));
  assert.equal(installClaudeHooks(dir), "written");
  assert.equal(installClaudeHooks(dir), "noop");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(cfg.model, "opus");
  // Operator's Bash guard + our ask PreToolUse + our RTK Bash rewrite.
  assert.equal(cfg.hooks.PreToolUse.length, 3);
  assert.equal(cfg.hooks.PreToolUse[0].hooks[0].command, "guard.sh");
  assert.match(cfg.hooks.PreToolUse[1].hooks[0].command, /MC_SESSION.*mc" hook claude/);
  assert.match(cfg.hooks.PreToolUse[2].hooks[0].command, /rtk-rewrite\.sh/);
  assert.match(cfg.hooks.Stop[0].hooks[0].command, /MC_SESSION.*mc" hook claude/);
  // A settings file someone is halfway through editing is left alone.
  fs.writeFileSync(path.join(dir, "settings.json"), "{ nope");
  assert.equal(installClaudeHooks(dir), "skipped");
  assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "{ nope");
});

test("mergeHooks drops only our old entries", () => {
  const ours = claudeStyleHooks('"$HOME/.mc/bin/mc" hook claude', { notification: false });
  const once = mergeHooks({ Stop: [{ hooks: [{ command: "notify.sh" }] }] }, ours);
  const twice = mergeHooks(once, ours);
  assert.deepEqual(twice, once);
  assert.equal(twice.Stop.length, 2);
});

test("cursor: version 1 hooks.json, and a verdict echoed even outside a Chronos terminal", () => {
  const dir = tmp();
  installCursorHooks(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"));
  assert.equal(cfg.version, 1);
  assert.match(cfg.hooks.beforeSubmitPrompt[0].command, /else echo '\{"continue":true\}'/);
});

test("grok: one marked block appended to config.toml, replaced in place, skipped for inline hooks", () => {
  const home = tmp();
  const file = path.join(home, "config.toml");
  fs.writeFileSync(file, '[models]\ndefault = "grok-4.5"\n');
  assert.equal(installGrokHooks(home), "written");
  assert.equal(installGrokHooks(home), "noop");
  const toml = fs.readFileSync(file, "utf8");
  assert.ok(toml.startsWith('[models]\ndefault = "grok-4.5"\n\n# BEGIN chronos'));
  assert.equal(toml.split("# BEGIN chronos").length, 2);
  assert.match(grokHooksToml(), /\[\[hooks\.PreToolUse\]\]\nmatcher = "AskUserQuestion\|ExitPlanMode\|ask_user_question\|ask_user"/);
  fs.writeFileSync(file, 'hooks = { }\n');
  assert.equal(installGrokHooks(home), "skipped");
});
