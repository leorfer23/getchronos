/**
 * Robert's process hygiene, through the real WarmManager against the fake CLI (never a real model —
 * CLAUDE.md gotcha 2):
 *  - every persona spawn drops the profile's output style, user CLAUDE.md and auto memory, keeps the
 *    profile dir (login + MCP) and the never-send deny list;
 *  - an idle hour frees the operator's process but keeps his conversation, and a stale resume id still
 *    recovers on its own;
 *  - wakes run on their own manager and their own --resume session, so his turn never waits behind one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CONFIG snapshots env at import, so point it at the fake CLI before pulling agent.ts in.
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.CHRONOS_CLAUDE_BIN = path.join(HERE, "fake-claude.mjs");

const agent = await import("./agent.js");
const { kv } = await import("../store.js");
const { claudeDenyArgs } = await import("../no-send.js");
const {
  WarmManager,
  personaIsolationArgs,
  PERSONA_ENV,
  laneKeys,
  rotateWebIfIdle,
  robertManagerForTest,
  robertManagersForTest,
  WAKE_SESSION_MAX_TURNS,
} = agent;

const tmp = (name: string) => path.join(os.tmpdir(), `chronos-lanes-${name}-${process.pid}`);
const HOUR = 60 * 60 * 1000;

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return fn().finally(() => { for (const k of Object.keys(vars)) delete process.env[k]; });
}

// ── A. the profile is his login and MCP, not the operator's style or CLAUDE.md ─────────────────────

test("a persona spawn overrides the output style, excludes the profile's CLAUDE.md and rules, and keeps the deny list", async () => {
  const argvFile = tmp("argv-a");
  const envFile = tmp("env-a");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-profile-"));
  await withEnv({ CHRONOS_FAKE_ARGV: argvFile, CHRONOS_FAKE_ENV: envFile }, async () => {
    const m = new WarmManager({ system: "persona", model: "sonnet", profileDir: profile, inheritProfileMcp: true, turnTimeoutMs: 5_000, maxTurns: 30 });
    try { assert.equal(await m.turn("hi"), "ok:1"); } finally { m.kill(); }
  });
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  assert.equal(settings.outputStyle, "default", "the profile's outputStyle must not reach Robert");
  assert.deepEqual(settings.claudeMdExcludes, [path.join(profile, "CLAUDE.md"), path.join(profile, "rules", "**")]);
  assert.equal(argv[argv.indexOf("--system-prompt-snapshot") + 1], "off", "a resumed manager must see its current persona");
  // Still his: the persona, the profile's MCP (no strict), and the never-send deny list untouched.
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "persona");
  assert.ok(!argv.includes("--strict-mcp-config"));
  const deny = claudeDenyArgs();
  assert.equal(argv[argv.indexOf("--disallowed-tools") + 1], deny[1]);
  const env = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal(env.CLAUDE_CONFIG_DIR, profile, "the profile dir stays: it holds the login and the MCP tokens");
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  for (const f of [argvFile, envFile]) fs.rmSync(f, { force: true });
  fs.rmSync(profile, { recursive: true, force: true });
});

test("personaIsolationArgs is valid JSON for a profile path with spaces and quotes", () => {
  const args = personaIsolationArgs(`/tmp/odd "profile" dir`);
  const s = JSON.parse(args[1]);
  assert.equal(s.claudeMdExcludes[0], `/tmp/odd "profile" dir/CLAUDE.md`);
  assert.deepEqual(PERSONA_ENV, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
});

test("the one-shot manager spawn (Telegram parallel asks) gets the same isolation", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/telegram/agent.ts"), "utf8");
  const body = src.slice(src.indexOf("export function spawnManager("), src.indexOf("function spawnAgent("));
  assert.match(body, /\[\.\.\.spec\.args, \.\.\.personaIsolationArgs\(profileDir\)\]/);
  assert.match(body, /\.\.\.\(claude \? PERSONA_ENV : \{\}\)/);
});

// ── D. an idle hour frees the process, not the conversation ────────────────────────────────────────

test("idle rotation drops the operator's process but keeps his resume id", () => {
  const key = "lanes-d";
  const k = laneKeys("operator", key);
  kv.set(k.session, "sess-op");
  kv.set(k.lastTurnAt, String(Date.now() - 2 * HOUR));
  const m = robertManagerForTest("operator", key, null);
  assert.equal(robertManagersForTest(key).operator, m);
  rotateWebIfIdle(key, "operator");
  assert.equal(robertManagersForTest(key).operator, undefined, "the idle process is freed");
  assert.equal(kv.get(k.session), "sess-op", "the conversation survives the idle gap");
  kv.del(k.session); kv.del(k.lastTurnAt);
});

test("a stale resume id still recovers: the turn answers on a fresh session and the stored id is dropped", async () => {
  let dropped = 0;
  const ids: string[] = [];
  await withEnv({ CHRONOS_FAKE_STALE_RESUME: "1" }, async () => {
    const m = new WarmManager({
      system: "t", model: "sonnet", turnTimeoutMs: 5_000, maxTurns: 30,
      resumeSessionId: "gone-session",
      onStaleResume: () => { dropped++; },
      onSessionId: (id) => ids.push(id),
    });
    try { assert.equal(await m.turn("hello again"), "ok:1"); } finally { m.kill(); }
  });
  assert.equal(dropped, 1, "the caller is told to forget the dead id");
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], "gone-session", "the new session id is persisted, not the dead one");
});

// ── E. wakes have their own manager and session ─────────────────────────────────────────────────────

test("lanes never share a kv row", () => {
  const op = laneKeys("operator", "w1");
  const wk = laneKeys("wake", "w1");
  assert.equal(op.session, "web.session:w1", "the operator's key is the one Telegram and the Desk already resume");
  for (const f of ["session", "lastTurnAt"] as const) assert.notEqual(op[f], wk[f]);
});

test("a wake runs on its own manager and resumes its own session; the operator's id is never touched", async () => {
  const key = "lanes-e";
  const op = laneKeys("operator", key);
  const wk = laneKeys("wake", key);
  kv.set(op.session, "sess-op");
  kv.set(wk.session, "sess-wake");
  const argvFile = tmp("argv-e");
  const opM = robertManagerForTest("operator", key, null);
  const wakeM = robertManagerForTest("wake", key, null);
  assert.notEqual(opM, wakeM, "two processes, not one shared queue");
  await withEnv({ CHRONOS_FAKE_ARGV: argvFile }, async () => {
    await wakeM.turn("a wake");
    let argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--resume") + 1], "sess-wake");
    await opM.turn("the operator");
    argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--resume") + 1], "sess-op");
  });
  assert.equal(kv.get(op.session), "sess-op");
  assert.equal(kv.get(wk.session), "sess-wake");
  opM.kill(); wakeM.kill();
  fs.rmSync(argvFile, { force: true });
  for (const k of [op.session, wk.session]) kv.del(k);
});

test("the operator's turn never waits behind a running wake", async () => {
  const key = "lanes-race";
  const opM = robertManagerForTest("operator", key, null);
  const wakeM = robertManagerForTest("wake", key, null);
  const done: string[] = [];
  const wake = wakeM.turn("a long wake !slow").then(() => done.push("wake"));
  await new Promise((r) => setTimeout(r, 50)); // the wake is in flight first
  const mine = opM.turn("hola").then(() => done.push("operator"));
  await Promise.all([wake, mine]);
  assert.deepEqual(done, ["operator", "wake"]);
  opM.kill(); wakeM.kill();
});

test("the wake session starts over after an idle hour or a full transcript; the operator's never does", () => {
  const key = "lanes-rot";
  const wk = laneKeys("wake", key);
  kv.set(wk.session, "sess-wake");
  kv.set(wk.turns!, String(WAKE_SESSION_MAX_TURNS));
  kv.set(wk.lastTurnAt, String(Date.now()));
  rotateWebIfIdle(key, "wake");
  assert.equal(kv.get(wk.session), undefined, "full → a fresh wake session");
  assert.equal(kv.get(wk.turns!), undefined);

  kv.set(wk.session, "sess-wake-2");
  kv.set(wk.lastTurnAt, String(Date.now() - 2 * HOUR));
  rotateWebIfIdle(key, "wake");
  assert.equal(kv.get(wk.session), undefined, "idle hour → a fresh wake session");

  kv.set(wk.session, "sess-wake-3");
  kv.set(wk.lastTurnAt, String(Date.now() - 60_000));
  rotateWebIfIdle(key, "wake");
  assert.equal(kv.get(wk.session), "sess-wake-3", "a busy wake lane keeps its session");
  kv.del(wk.session); kv.del(wk.lastTurnAt);
});

