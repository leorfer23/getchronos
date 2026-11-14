/**
 * Work the daemon starts or watches on its own does not die with the network (src/net-up.ts):
 * continuations do not go `broken` on an outage, and scheduled terminals wait for the network.
 * The network look is swapped for a switch; nothing here opens a socket.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { continuations, db, inbox, jobs, jots, kv, runs, sessions, workspaces } from "./store.js";
import { setNetProbe } from "./net-up.js";
import { arm, deliver, evaluate, finishCheck, parseWhen, setRunScript, setViewPr, MAX_ERRORS, OFFLINE_RETRY_MS, RETRY_MS } from "./continuations.js";
import { openCheckTerminal, recordCheck } from "./job-check.js";
import { createAutoDispatcher } from "./inbox-autodispatch.js";
import { sweepFollowUps } from "./jot-followup.js";

const NOW = new Date(2026, 10, 12, 1, 1, 0, 0).getTime();
const PR = "https://github.com/acme/app/pull/7";
let up = true;
let ws: { id: string; slug: string };

beforeEach(() => {
  db.exec("DELETE FROM continuations; DELETE FROM sessions; DELETE FROM jots; DELETE FROM inbox_items; DELETE FROM kv WHERE key LIKE 'inbox.%';");
  ws = workspaces.create({ slug: "off-" + randomUUID().slice(0, 6), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);
  up = true;
  setNetProbe(async () => up);
  setViewPr(null);
  setRunScript(null);
});
after(() => { setNetProbe(null); setViewPr(null); setRunScript(null); });

/** Flip the network: the look is cached, so a flip also forgets the last answer. */
const network = (on: boolean) => { up = on; setNetProbe(async () => up); };
const spec = (r: any) => (parseWhen(r, NOW) as any).spec;
const term = () => sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship it" } as any);

// ── (a) continuations ──────────────────────────────────────────────────────────────────────────

test("a PR wait through a long outage never breaks: no error counted, no look spent, the next look a minute later", async () => {
  let calls = 0;
  setViewPr(async () => { calls++; throw Object.assign(new Error("gh failed"), { stderr: "error connecting to api.github.com" }); });
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "pr", target: PR, until: "checks" }), created_by: "x", round: 1 });
  network(false);
  for (let i = 0; i < MAX_ERRORS * 3; i++) await evaluate(continuations.get(c.id)!, NOW + i * 60_000);
  const row = continuations.get(c.id)!;
  assert.equal(row.status, "armed");
  assert.equal(row.errors, 0);
  assert.equal(row.checks, 0, "no look was spent");
  assert.equal(calls, 1, "gh is not even asked while the network is down (the one call is arm's baseline)");
  assert.equal(row.next_check_at, new Date(NOW + (MAX_ERRORS * 3 - 1) * 60_000 + OFFLINE_RETRY_MS).toISOString());

  // Back online: checking resumes, and a real failure still breaks as before.
  network(true);
  for (let i = 0; i < MAX_ERRORS; i++) await evaluate(continuations.get(c.id)!, NOW + 3_600_000 + i * 1000);
  const after = continuations.get(c.id)!;
  assert.equal(after.status, "met");
  assert.equal(after.outcome, "broken");
});

test("a gh call that fails because the network dropped mid-look is not counted; one that fails online is", async () => {
  setViewPr(async () => { network(false); throw new Error("dial tcp: lookup api.github.com: no such host"); });
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "pr", target: PR }), created_by: "x", round: 1 });
  network(true);
  await evaluate(continuations.get(c.id)!, NOW);
  assert.equal(continuations.get(c.id)!.errors, 0);

  network(true);
  setViewPr(async () => { throw new Error("gh: not authenticated"); });
  await evaluate(continuations.get(c.id)!, NOW + 300_000);
  assert.equal(continuations.get(c.id)!.errors, 1);
});

test("a script that timed out during an outage is not a failed look; a script exit 1 is still 'not yet'", async () => {
  let r = { met: false, error: true, out: "timed out after 60s" };
  setRunScript(async () => r);
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "script", target: "curl -sf https://api.example.com/x" }), created_by: "x", round: 1 });
  network(false);
  for (let i = 0; i < MAX_ERRORS + 2; i++) await evaluate(continuations.get(c.id)!, NOW + i * 60_000);
  assert.equal(continuations.get(c.id)!.status, "armed");
  assert.equal(continuations.get(c.id)!.errors, 0);

  // A local script keeps working offline: its answer counts.
  r = { met: false, error: false, out: "not yet" };
  await evaluate(continuations.get(c.id)!, NOW + 3_600_000);
  assert.equal(continuations.get(c.id)!.last_check, "not yet");
  r = { met: true, error: false, out: "the file is there" };
  await evaluate(continuations.get(c.id)!, NOW + 3_700_000);
  assert.equal(continuations.get(c.id)!.status, "met");
});

test("check: no probe starts while the network is down, and a probe that died on the network is neither counted nor spent", async () => {
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: spec({ kind: "check", target: "someone replied in the channel" }), created_by: "x", round: 1 });
  const started: string[] = [];
  const fake = ((jobId: string, name: string) => { started.push(name); return { error: "test: not started" }; }) as any;
  network(false);
  await evaluate(continuations.get(c.id)!, NOW, { dispatch: fake });
  assert.deepEqual(started, [], "no probe run offline");
  assert.equal(continuations.get(c.id)!.checks, 0);

  // A probe that started online and died when the network went.
  const job = jobs.create({ name: `when-check:${c.id.slice(0, 8)}`, goal: "g", cwd: "/tmp", workspace_id: ws.id, trigger_type: "manual" } as any);
  const run = runs.create(job.id, "when-check");
  runs.patch(run.id, { status: "failed", error: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" });
  await finishCheck(run.id, NOW + 60_000);
  let row = continuations.get(c.id)!;
  assert.equal(row.status, "armed");
  assert.deepEqual([row.checks, row.errors], [0, 0]);

  // The same failure with the network up is a failed look, as before.
  network(true);
  await finishCheck(run.id, NOW + 120_000);
  row = continuations.get(c.id)!;
  assert.deepEqual([row.checks, row.errors], [1, 1]);
});

test("the timeout still ends a wait that spent its whole life offline", async () => {
  setViewPr(async () => { throw new Error("unreachable"); });
  const c = await arm({ workspace_id: ws.id, session_id: term().id, spec: { ...spec({ kind: "pr", target: PR }), timeout_at: new Date(NOW + 30_000).toISOString() }, created_by: "x", round: 1 });
  network(false);
  await evaluate(continuations.get(c.id)!, NOW);
  assert.equal(continuations.get(c.id)!.next_check_at, new Date(NOW + 30_000).toISOString(), "the offline retry never jumps past the timeout");
  await evaluate(continuations.get(c.id)!, NOW + 30_000);
  assert.equal(continuations.get(c.id)!.outcome, "timeout");
});

test("a met continuation is not typed, resumed or opened into a dead network — it is retried", async () => {
  const s = term();
  const c = await arm({ workspace_id: ws.id, session_id: s.id, spec: spec({ kind: "manual" }), created_by: "x", round: 1 });
  continuations.markMet(c.id, { outcome: "manual", evidence: "done", at: new Date(NOW).toISOString() });
  const sent: string[] = [];
  const o = { alive: () => true, phase: () => "your_turn", send: ((id: string) => { sent.push(id); return null; }) as any };
  db.prepare("UPDATE sessions SET status = 'live' WHERE id = ?").run(s.id);
  assert.equal(await deliver(continuations.get(c.id)!, NOW, { ...o, netUp: async () => false }), null);
  assert.deepEqual(sent, []);
  assert.equal(continuations.get(c.id)!.next_check_at, new Date(NOW + RETRY_MS).toISOString());
  assert.equal(await deliver(continuations.get(c.id)!, NOW, { ...o, netUp: async () => true }), "typed");
  assert.deepEqual(sent, [s.id]);
});

// ── (b) scheduled terminals ────────────────────────────────────────────────────────────────────

const health = () => ({
  workspace_id: ws.id, since: new Date(NOW - 86_400_000).toISOString(), until: new Date(NOW).toISOString(), jobs: 1, runs: 1, recovered: 0,
  red: [{ job_id: "abcdef1234", job_name: "nightly-sync", kind: "failed" as const, detail: "failed at 01:00", runs: [] }],
});

test("the job check's terminal opens only once the network is up", async () => {
  const check = jobs.create({ name: "job-check:" + ws.slug, goal: "g", cwd: "/tmp", workspace_id: ws.id, trigger_type: "manual" } as any);
  const h = health();
  const rec = recordCheck(check.id, h);
  let release!: (v: boolean) => void;
  const back = new Promise<boolean>((r) => (release = r));
  const opened: string[] = [];
  const opener = (async (o: any) => { opened.push(o.goal); return { id: "sess-0a0b0c0d" }; }) as any;
  const p = openCheckTerminal(check.id, rec.id, h, { opener, network: () => back });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, [], "nothing opens while it waits");
  release(true);
  assert.deepEqual(await p, { session_id: "sess-0a0b0c0d" });
  assert.equal(opened.length, 1);
});

test("the job check gives up on a network that never came back: no terminal, no headless run, the row says why", async () => {
  const check = jobs.create({ name: "job-check:" + ws.slug, goal: "g", cwd: "/tmp", workspace_id: ws.id, trigger_type: "manual" } as any);
  const h = health();
  const rec = recordCheck(check.id, h);
  let opened = 0, ran = 0;
  const out = await openCheckTerminal(check.id, rec.id, h, {
    opener: (async () => { opened++; return { id: "x" }; }) as any,
    run: (() => { ran++; return { run_id: "r", status: "running" }; }) as any,
    network: async () => false,
  });
  assert.deepEqual(out, { error: "the network stayed down" });
  assert.deepEqual([opened, ran], [0, 0]);
  assert.match(runs.get(rec.id)!.summary!, /network stayed down/);
});

test("the operator's yes on a job check opens at once — it does not wait on the network look", async () => {
  const check = jobs.create({ name: "job-check:" + ws.slug, goal: "g", cwd: "/tmp", workspace_id: ws.id, trigger_type: "manual" } as any);
  const h = health();
  const rec = recordCheck(check.id, h);
  let looked = 0;
  const out = await openCheckTerminal(check.id, rec.id, h, {
    approved: true, opener: (async () => ({ id: "sess-yes00000" })) as any, network: async () => { looked++; return false; },
  });
  assert.deepEqual(out, { session_id: "sess-yes00000" });
  assert.equal(looked, 0);
});

test("inbox auto-dispatch neither judges nor opens while the network is down, and opens the row once it is back", async () => {
  kv.set("inbox.auto.after", "0");
  inbox.add({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: randomUUID(), title: "can you look at this" });
  let clock = 1_000_000, judged = 0;
  const opened: string[] = [];
  let online = false;
  const d = createAutoDispatcher({
    now: () => clock, enabled: () => true, triageOn: () => true, netUp: async () => online,
    triage: async () => { judged++; return { work: true, why: "asks", task: null }; },
    opener: (async (o: any) => {
      const id = "s-" + randomUUID().slice(0, 8);
      db.prepare("INSERT INTO sessions (id, workspace_id, cwd, status, created_at) VALUES (?,?,?, 'live', ?)").run(id, o.workspace_id, "/tmp", new Date().toISOString());
      opened.push(id);
      return { id };
    }) as any,
  });
  await d.pump();
  clock += 10 * 60_000;
  assert.deepEqual(await d.pump(), []);
  assert.deepEqual([judged, opened.length], [0, 0]);
  online = true;
  clock += 60_000;
  assert.equal((await d.pump()).length, 1);
  assert.deepEqual([judged, opened.length], [1, 1]);
});

test("a follow-up due while the network is down stays due and fires once it is back", async () => {
  const j = jots.create({ workspace_id: ws.id, title: "check the export" });
  const due = new Date(NOW - 60_000).toISOString();
  jots.setFollowUp(j.id, due);
  let n = 0;
  const opener = (async () => ({ id: "s" + ++n })) as any;
  assert.equal(await sweepFollowUps(NOW, opener, async () => false), 0);
  assert.equal(n, 0);
  assert.equal(jots.get(j.id)!.follow_up_at, due, "still due, not claimed");
  assert.equal(await sweepFollowUps(NOW, opener, async () => true), 1);
});
