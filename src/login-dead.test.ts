/**
 * A Claude login known to be dead (login-dead.ts) at spawn: an agent's new terminal for that workspace
 * goes to the failover chain or is refused, never onto the dead profile; the operator's own open is
 * left alone; another workspace is untouched.
 *
 * Nothing here spawns. Every open is stopped before the pty by a guard that runs AFTER the reroute —
 * a taken agent_name — and the reroute is read off the log line it writes, so no CLI ever starts.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { setLoadProbe } from "./machine.js";
import { sessions, workspaces } from "./store.js";
import { openSession } from "./terminal.js";
import { setFailoverOps } from "./terminal-failover.js";
import { claudeDirFor, LOGIN_DEAD_TTL_MS, loginDeadFor, loginWorks, markLoginDead, resetLoginDead } from "./login-dead.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-login-dead-"));
const fallbacksWas = CONFIG.terminalFallbackBackends;
const failoverWas = CONFIG.terminalFailover;
let wsId: string;
let logs: string[];
const log = console.log;

beforeEach(() => {
  resetLoginDead();
  const ws = workspaces.create({ slug: `ld-${Math.random().toString(36).slice(2, 8)}`, name: "Initech", config_dir: tmp, sandbox_mode: "off" } as any);
  wsId = ws.id;
  // A taken name: the guard right after the reroute, so the open always stops before any spawn.
  if (!sessions.findByAgentName("taken")) {
    const other = workspaces.create({ slug: `ld-x-${Math.random().toString(36).slice(2, 8)}`, name: "Elsewhere", config_dir: tmp } as any);
    sessions.create({ workspace_id: other.id, backend: "grok", cwd: tmp, agent_name: "taken" } as any);
  }
  setLoadProbe(() => ({ load1: 1, ncpu: 12, loadPerCore: 0.1, swapUsedMb: 0, swapTotalMb: 1, pressureLevel: 1 }));
  CONFIG.terminalFailover = true;
  CONFIG.terminalFallbackBackends = ["grok"];
  setFailoverOps({ installed: (b) => b === "grok", hostCanRun: () => true });
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
after(() => {
  console.log = log;
  setLoadProbe(null);
  setFailoverOps({});
  CONFIG.terminalFallbackBackends = fallbacksWas;
  CONFIG.terminalFailover = failoverWas;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const open = (o: Record<string, unknown>) => openSession({ workspace_id: wsId, backend: "claude-code", goal: "reply in the thread", agent_name: "taken", ...o } as any);
const rerouted = () => logs.filter((l) => l.startsWith("[login-dead] new terminal"));

test("an agent's claude terminal for a workspace whose login is dead goes to the fallback instead", async () => {
  markLoginDead(wsId, claudeDirFor(wsId), { line: "Login reached its time limit · Please run /login", session_id: "dead0001" });
  await assert.rejects(() => open({ created_by: "robert" }), /agent_name `taken` already in use/);
  console.log = log;
  assert.equal(rerouted().length, 1);
  assert.match(rerouted()[0], /\(robert\) → grok(\/[^:]+)?: this workspace's Claude login is dead/);
});

test("with nowhere to go it is refused before anything spawns, saying why", async () => {
  markLoginDead(wsId, claudeDirFor(wsId), { line: "Not logged in · Please run /login", session_id: "dead0001" });
  setFailoverOps({ installed: () => false, hostCanRun: () => false });
  await assert.rejects(() => open({ created_by: "inbox" }), /^Error: refused: this workspace's Claude login is dead \("Not logged in · Please run \/login"\) and no fallback can take the terminal/);
  CONFIG.terminalFailover = false;
  await assert.rejects(() => open({ created_by: "inbox" }), /failover is off for this workspace/);
});

test("the operator's own open, a stand-in and another workspace are never rerouted", async () => {
  markLoginDead(wsId, claudeDirFor(wsId), { line: "Not logged in · Please run /login", session_id: "dead0001" });
  for (const o of [{ created_by: "operator" }, { created_by: undefined }, { created_by: "failover", replaces: "some-live-id" }]) {
    await assert.rejects(() => open(o), /agent_name `taken` already in use/);
  }
  const other = workspaces.create({ slug: `ld-o-${Math.random().toString(36).slice(2, 8)}`, name: "Hooli", config_dir: tmp, sandbox_mode: "off" } as any);
  await assert.rejects(() => open({ workspace_id: other.id, created_by: "robert" }), /agent_name `taken` already in use/);
  console.log = log;
  assert.deepEqual(rerouted(), []);
});

test("no mark, a lapsed mark, or a proven-fixed login: claude as asked", async () => {
  await assert.rejects(() => open({ created_by: "robert" }), /agent_name `taken` already in use/);
  const dir = claudeDirFor(wsId);
  markLoginDead(wsId, dir, { line: "Not logged in · Please run /login", session_id: "dead0001" }, Date.now() - LOGIN_DEAD_TTL_MS - 1);
  await assert.rejects(() => open({ created_by: "robert" }), /agent_name `taken` already in use/);
  markLoginDead(wsId, dir, { line: "Not logged in · Please run /login", session_id: "dead0001" });
  assert.ok(loginWorks(wsId, dir, Date.now() + 1));
  await assert.rejects(() => open({ created_by: "robert" }), /agent_name `taken` already in use/);
  console.log = log;
  assert.deepEqual(rerouted(), []);
});

test("markLoginDead answers true once per profile until the login is proven to work", () => {
  const dir = claudeDirFor(wsId);
  assert.equal(markLoginDead(wsId, dir, { line: "a", session_id: "s1" }, 1000), true);
  assert.equal(markLoginDead(wsId, dir, { line: "a", session_id: "s2" }, 2000), false);
  // Lapsed by the TTL and seen again: still the same unfixed login — no second alert.
  assert.equal(loginDeadFor(wsId, dir, 2000 + LOGIN_DEAD_TTL_MS), null);
  assert.equal(markLoginDead(wsId, dir, { line: "a", session_id: "s3" }, 3000 + LOGIN_DEAD_TTL_MS), false);
  assert.equal(loginWorks(wsId, dir, 500), false, "a terminal older than the first wall proves nothing");
  assert.equal(loginWorks(wsId, dir, 1500), true);
  assert.equal(markLoginDead(wsId, dir, { line: "a", session_id: "s4" }, 5000 + LOGIN_DEAD_TTL_MS), true);
});
