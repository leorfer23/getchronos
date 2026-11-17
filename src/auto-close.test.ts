/**
 * Auto-close (src/auto-close.ts): the operator lets Robert close a terminal once its goal is met — from
 * the Focus toggle or the word `auto-close`. The keyword, the guard, the close, Robert's wake, and the
 * routes, asked of the running API.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertToken } = await import("./authz.js");
const { sessions, workspaces } = await import("./store.js");
const { autoCloseWord, closeRefusal, closeWhenDone, handoffWants, spawnAutoClose } = await import("./auto-close.js");
const { driveSay, reaches } = await import("./robert-drive.js");
import type { Outcome } from "./types.js";

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-autoclose-"));
const A = workspaces.create({ slug: `ac-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `ac-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asRobertA = { ...json, "x-mc-admin": robertToken(A.id, "rw") };
const asRobertB = { ...json, "x-mc-admin": robertToken(B.id, "rw") };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token! };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}
const terminal = (extra: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: A.id, cwd: tmp, backend: "claude-code", goal: "fix the flaky checkout test", ...extra } as any);
const outcome = (o: Partial<Outcome>): Outcome =>
  ({ summary: "Fixed and green.", changes: [], proof: [], prs: [], shots: [], ask: "none", shipped: [], at: new Date().toISOString(), ...o }) as Outcome;

// ── the keyword ──────────────────────────────────────────────────────────────────────────────

test("autoCloseWord: the keyword on its own, as a tag, or set off at the start or end of the line", () => {
  const on = (t: string, rest: string) => assert.deepEqual(autoCloseWord(t), { on: true, text: rest }, t);
  const off = (t: string, rest: string) => assert.deepEqual(autoCloseWord(t), { on: false, text: rest }, t);
  on("auto-close", "");
  on("  AutoClose. ", "");
  on("auto close", "");
  off("no auto-close", "");
  off("sin auto-close", "");
  on("fix the flaky test, auto-close", "fix the flaky test");
  on("arreglá el test · auto-close", "arreglá el test");
  on("arreglá el test. auto-close", "arreglá el test");
  on("fix the flaky test — auto-close", "fix the flaky test");
  on("auto-close: fix the flaky test", "fix the flaky test");
  on("fix the flaky test #auto-close", "fix the flaky test");
  on("#autoclose fix the flaky test", "fix the flaky test");
  on("fix the flaky test --auto-close", "fix the flaky test");
  off("fix it, don't auto-close", "fix it");
  off("fix it #no-auto-close", "fix it");
});

test("autoCloseWord: a feature being described is not a wish about the terminal", () => {
  for (const t of [
    "the modal should auto-close on save",
    "add an auto-close toggle to the Desk",
    "the modal should auto-close",
    "make toasts autoclose after 3s",
    "",
    "   ",
  ]) assert.equal(autoCloseWord(t), null, t);
});

test("spawnAutoClose: the operator's keyword turns it on and leaves the goal clean; anyone else's grants nothing", () => {
  const op: any = { goal: "fix the flaky test, auto-close" };
  spawnAutoClose(op, true);
  assert.deepEqual(op, { goal: "fix the flaky test", auto_close: true });
  const brief: any = { goal: "fix the flaky test", description: "auto-close" };
  spawnAutoClose(brief, true);
  assert.deepEqual(brief, { goal: "fix the flaky test", auto_close: true });
  const bare: any = { goal: "auto-close" };
  spawnAutoClose(bare, true);
  assert.deepEqual(bare, { goal: null, auto_close: true });
  const robert: any = { goal: "fix the flaky test, auto-close", auto_close: true };
  spawnAutoClose(robert, false);
  assert.deepEqual(robert, { goal: "fix the flaky test, auto-close" }, "not the operator: field dropped, words untouched");
});

// ── the guard ────────────────────────────────────────────────────────────────────────────────

test("handoffWants: a hand-off still asking him for a merge, deploy or review, or saying it waits on him", () => {
  assert.equal(handoffWants(null), null);
  assert.equal(handoffWants(outcome({})), null);
  assert.match(handoffWants(outcome({ ask: "merge" }))!, /merge/);
  assert.equal(handoffWants(outcome({ ask: "merge", shipped: ["merged #12"] })), null, "it merged under its ship permission");
  assert.match(handoffWants(outcome({ ask: "merge+deploy", shipped: ["merged #12"] }))!, /merge\+deploy/, "merged, not deployed");
  assert.match(handoffWants(outcome({ ask: "review" }))!, /review/);
  assert.match(handoffWants(outcome({ summary: "Done, but it needs you to re-auth Okta." }))!, /waits on the operator/);
});

test("closeRefusal: only an auto-close terminal, finished, quiet, asking nothing, on this computer", () => {
  const row = { auto_close: true, status: "live", host_id: "local", cloud_agent_id: null, outcome: null, role: "human" } as any;
  const facts = { live: true, quiet: true, phase: "review" as const, openAsks: 0, liveWorkers: 0 };
  assert.equal(closeRefusal(row, facts), null);
  assert.equal(closeRefusal(row, { ...facts, phase: "your_turn" }), null);
  assert.match(closeRefusal({ ...row, auto_close: false }, facts)!, /auto-close is off/);
  assert.match(closeRefusal(row, { ...facts, live: false })!, /not running/);
  assert.match(closeRefusal({ ...row, status: "ended" }, facts)!, /not running/);
  assert.match(closeRefusal({ ...row, cloud_agent_id: "c1" }, facts)!, /cloud/);
  assert.match(closeRefusal({ ...row, host_id: "m2" }, facts)!, /another computer/);
  assert.match(closeRefusal({ ...row, role: "lead" }, { ...facts, liveWorkers: 2 })!, /Lead with 2/);
  assert.match(closeRefusal(row, { ...facts, quiet: false })!, /still working/);
  assert.match(closeRefusal(row, { ...facts, openAsks: 1 })!, /open question/);
  for (const phase of ["working", "waiting", "blocked", "decide", "stalled"] as const)
    assert.match(closeRefusal(row, { ...facts, phase })!, /not finished/, phase);
  assert.match(closeRefusal({ ...row, outcome: outcome({ ask: "deploy" }) }, facts)!, /deploy/);
});

// ── the close ────────────────────────────────────────────────────────────────────────────────

test("closeWhenDone: past every guard it ticks the goal and ends the terminal with the reason", async () => {
  const s = terminal({ auto_close: true });
  const killed: [string, string | null | undefined][] = [];
  const deps = {
    activity: () => ({ live: true, quiet: true, last_out: null, last_in: null, started_at: null }),
    status: () => ({ phase: "review" as const }),
    strands: async () => null,
    kill: (id: string, why?: string | null) => { killed.push([id, why]); },
  };
  assert.deepEqual(await closeWhenDone(s.id, "PR #12 merged, suite green", "robert", deps), { closed: true });
  assert.equal(killed.length, 1);
  assert.equal(killed[0][0], s.id);
  assert.match(String(killed[0][1]), /^closed by Robert — goal met: PR #12 merged/);
  assert.ok(sessions.get(s.id)!.goal_done_at, "done is done: the goal is ticked");

  const dirty = terminal({ auto_close: true });
  const r = await closeWhenDone(dirty.id, "done", "robert", { ...deps, strands: async () => "2 uncommitted file(s) in its worktree" });
  assert.deepEqual(r, { refused: "2 uncommitted file(s) in its worktree" });
  assert.equal(killed.length, 1, "a tree that would strand work is never closed");
  assert.equal(sessions.get(dirty.id)!.goal_done_at, null);
});

// ── Robert's wake ────────────────────────────────────────────────────────────────────────────

test("reaches: an auto-close terminal's 'goal done' reaches Robert even when it was never handed to him", () => {
  const prev = process.env.CHRONOS_ROBERT_WATCH_ALL;
  process.env.CHRONOS_ROBERT_WATCH_ALL = "0";
  try {
    const plain = { robert: false, lead_id: null, workspace_id: A.id };
    assert.equal(reaches(plain, "review"), false);
    assert.equal(reaches({ ...plain, auto_close: true }, "review"), true);
    assert.equal(reaches({ ...plain, auto_close: true }, "turn"), false, "a finished turn is not a claim it is done");
    assert.equal(reaches(plain, "robert"), true, "waiting --on robert always reaches him");
    assert.equal(reaches({ ...plain, robert: true }, "turn"), true);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_ROBERT_WATCH_ALL;
    else process.env.CHRONOS_ROBERT_WATCH_ALL = prev;
  }
});

test("driveSay: an auto-close wake names the close command; a check-only one tells him not to type into it", () => {
  const prev = process.env.CHRONOS_ROBERT_WATCH_ALL;
  process.env.CHRONOS_ROBERT_WATCH_ALL = "0";
  try {
    const s = { id: "abcdef12-0000", goal: "fix the test", spawn_goal: null, workspace_id: A.id, lead_id: null };
    const words = { result: "Fixed.", said: null };
    const plain = driveSay(s, "review", { line: "done" }, words, "Acme");
    assert.doesNotMatch(plain, /AUTO-CLOSE/);
    const check = driveSay({ ...s, auto_close: true }, "review", { line: "done" }, words, "Acme");
    assert.match(check, /AUTO-CLOSE IS ON/);
    assert.match(check, /mc session close abcdef12/);
    assert.match(check, /do NOT type into it/);
    assert.doesNotMatch(check, /DRIVING THE WALL/, "a check, not a hand-over");
    const driven = driveSay({ ...s, auto_close: true, robert: true }, "review", { line: "done" }, words, "Acme");
    assert.match(driven, /mc session close abcdef12/);
    assert.match(driven, /DRIVING THE WALL/);
    assert.doesNotMatch(driven, /do NOT type into it/);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_ROBERT_WATCH_ALL;
    else process.env.CHRONOS_ROBERT_WATCH_ALL = prev;
  }
});

// ── the routes ───────────────────────────────────────────────────────────────────────────────

test("PATCH auto_close: the operator's toggle; never a workspace token's", async () => {
  const s = terminal();
  assert.equal(s.auto_close, false);
  const no = await call("PATCH", `/sessions/${s.id}`, asA, { auto_close: true });
  assert.equal(no.status, 403);
  assert.equal(sessions.get(s.id)!.auto_close, false);
  const yes = await call("PATCH", `/sessions/${s.id}`, admin, { auto_close: true });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.auto_close, true);
  const off = await call("PATCH", `/sessions/${s.id}`, admin, { auto_close: false });
  assert.equal(off.json.auto_close, false);
});

test("input: the operator saying `auto-close` flips it and types nothing; Robert saying it grants nothing", async () => {
  const s = terminal();
  const on = await call("POST", `/sessions/${s.id}/input`, admin, { text: "auto-close", enter: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { ok: true, auto_close: true, typed: false });
  assert.equal(sessions.get(s.id)!.auto_close, true);
  const off = await call("POST", `/sessions/${s.id}/input`, admin, { text: "no auto-close", enter: true });
  assert.equal(off.json.auto_close, false);
  assert.equal(sessions.get(s.id)!.auto_close, false);
  // Robert's line is typed as words (here: refused, the terminal has no pty) — the flag never moves.
  const rb = await call("POST", `/sessions/${s.id}/input`, asRobertA, { text: "auto-close", enter: true });
  assert.notEqual(rb.json?.auto_close, true);
  assert.equal(sessions.get(s.id)!.auto_close, false);
});

test("close-when-done: only Robert of its workspace or the operator, only on auto-close, refusals say why", async () => {
  const s = terminal();
  const ws = await call("POST", `/sessions/${s.id}/close-when-done`, asA, { why: "done" });
  assert.equal(ws.status, 403, "a terminal's own token never closes anything");
  const other = await call("POST", `/sessions/${s.id}/close-when-done`, asRobertB, { why: "done" });
  assert.equal(other.status, 404, "another project's Robert cannot even see it");
  const offRefused = await call("POST", `/sessions/${s.id}/close-when-done`, asRobertA, { why: "done" });
  assert.equal(offRefused.status, 409);
  assert.match(offRefused.json.error, /auto-close is off/);
  sessions.setAutoClose(s.id, true);
  const notLive = await call("POST", `/sessions/${s.id}/close-when-done`, asRobertA, { why: "done" });
  assert.equal(notLive.status, 409);
  assert.match(notLive.json.error, /not running/);
  const noWhy = await call("POST", `/sessions/${s.id}/close-when-done`, asRobertA, {});
  assert.equal(noWhy.status, 400, "a close says what landed");
});
