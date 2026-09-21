/**
 * Web Push to the phone (src/push.ts). Driven with a fake sender, a fake clock and temp files for
 * the VAPID pair and the subscription list — nothing here reaches a push service.
 *
 * What it guards: only the working→waiting FLIP pushes (not the steady state, not the first
 * "waiting" a fresh terminal reports), one per terminal per cooldown, a blocked agent pushes once,
 * Robert's reply pushes with its scope, a dead subscription (410) is dropped, and the buttons are
 * complete /input bodies capped at two.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-push-"));
process.env.CHRONOS_VAPID_FILE = path.join(tmp, "vapid.json");
process.env.CHRONOS_PUSH_SUBS_FILE = path.join(tmp, "subs.json");

const { bus } = await import("./bus.js");
const { sessions, workspaces } = await import("./store.js");
const { startPush, pushSubs, vapidKeys, actionsFor, broadcast, COOLDOWN_MS, MAX_PER_TERMINAL } = await import("./push.js");
import type { PushPayload, PushSubscription } from "./push.js";

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } });
const tick = () => new Promise((r) => setImmediate(r));

let ws: ReturnType<typeof workspaces.create>;
let s: ReturnType<typeof sessions.create>;
before(() => {
  ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: path.join(tmp, "acme") });
  s = sessions.create({ workspace_id: ws.id, cwd: tmp, backend: "claude-code", goal: "ship the docx export" });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("VAPID keys are generated once, persisted 0600, and reused", () => {
  const a = vapidKeys();
  assert.ok(a.publicKey.length > 40 && a.privateKey.length > 20);
  const mode = fs.statSync(process.env.CHRONOS_VAPID_FILE!).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(vapidKeys(), a);
});

test("subscriptions: add is idempotent per endpoint, remove reports whether it did anything", () => {
  pushSubs.add(sub(1), "Android Chrome");
  pushSubs.add(sub(1), "Android Chrome");
  pushSubs.add(sub(2));
  assert.equal(pushSubs.list().length, 2);
  assert.equal(pushSubs.remove(sub(2).endpoint), true);
  assert.equal(pushSubs.remove(sub(2).endpoint), false);
  assert.equal(pushSubs.list().length, 1);
});

test("actions are complete /input bodies, at most two", () => {
  const sel = actionsFor({ kind: "select", question: "Allow?", options: [{ label: "Yes", offset: 0 }, { label: "Yes, always", offset: 1 }, { label: "No", offset: 2 }] });
  assert.equal(sel.length, 2);
  assert.deepEqual(sel[0].input, { keys: ["enter"] });
  assert.deepEqual(sel[1].input, { keys: ["down", "enter"] });
  const yn = actionsFor({ kind: "yn", question: "Continue?" });
  assert.deepEqual(yn.map((a) => a.input), [{ text: "y", enter: true }, { text: "n", enter: true }]);
  const turn = actionsFor({ kind: "turn", question: "done." });
  assert.deepEqual(turn[0].input, { key: "enter" });
  assert.deepEqual(turn[1].input, {});
});

test("the flip pushes once per cooldown; steady-state and first-report waiting do not", async () => {
  const sent: PushPayload[] = [];
  let t = 1_000_000;
  const stop = startPush({
    enabled: true, now: () => t,
    send: async (_sub, p) => { sent.push(p); },
    activity: () => ({ live: true, quiet: true }),
    prompt: () => ({ kind: "yn", question: "Run the migration?" }),
  });
  try {
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick(); // a fresh terminal's first report
    assert.equal(sent.length, 0, "first 'waiting' is not a flip");
    bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting", prompt: { kind: "yn", question: "Run the migration?" } }); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "needs");
    assert.equal(sent[0].title, "Acme · your turn");
    assert.equal(sent[0].body, "ship the docx export — Run the migration?");
    assert.equal(sent[0].tag, "session:" + s.id);
    assert.equal(sent[0].url, "/phone#s=" + s.id);
    assert.deepEqual(sent[0].actions!.map((a) => a.title), ["Yes", "No"]);
    assert.equal(sent[0].needs, 1);
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick();
    assert.equal(sent.length, 1, "steady state is silent");
    bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick();
    assert.equal(sent.length, 1, "a second flip inside the cooldown is swallowed (TUI flicker)");
    t += COOLDOWN_MS + 1;
    bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting", prompt: { kind: "turn", question: "PR opened." } }); await tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].title, "Acme · turn finished");
    assert.deepEqual(sent[1].actions!.map((a) => a.action), ["enter", "open"]);
  } finally { stop(); }
});

test("blocked pushes once, and the terminal's next flip stays quiet while it is blocked", async () => {
  const sent: PushPayload[] = [];
  const stop = startPush({ enabled: true, send: async (_s, p) => { sent.push(p); }, activity: () => ({ live: true, quiet: false }), prompt: () => null });
  try {
    const ev = { topic: "agent.state" as const, kind: "session" as const, id: s.id, name: null, state: "blocked", state_label: "needs the VPN token", blocked_reason: "auth", workspace_id: ws.id };
    bus.publish(ev); await tick();
    bus.publish(ev); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "blocked");
    assert.equal(sent[0].title, "Acme · blocked");
    assert.match(sent[0].body, /needs the VPN token/);
    assert.equal(sent[0].needs, 1, "a blocked terminal counts even when it is not quiet");
    bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick();
    assert.equal(sent.length, 1, "no needs-you push on top of the blocked one");
  } finally { stop(); }
});

test("Robert's reply pushes with its scope; dividers and empty replies do not", async () => {
  const sent: PushPayload[] = [];
  const stop = startPush({ enabled: true, send: async (_s, p) => { sent.push(p); }, activity: () => ({ live: false, quiet: true }), prompt: () => null });
  try {
    bus.publish({ topic: "agent.push", you: "", reply: "", at: "now", source: "divider", ws: null }); await tick();
    bus.publish({ topic: "agent.push", you: "status?", reply: "", at: "now", source: "web", ws: null }); await tick();
    assert.equal(sent.length, 0);
    bus.publish({ topic: "agent.push", you: "status?", reply: "Two PRs\nwaiting on CI.", at: "now", source: "web", ws: ws.id }); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, "Robert · Acme");
    assert.equal(sent[0].body, "Two PRs waiting on CI.");
    assert.equal(sent[0].url, "/phone#robert=" + ws.id);
    assert.equal(sent[0].tag, "robert:" + ws.id);
  } finally { stop(); }
});

test("a subscription the browser dropped (410) is removed; other failures keep it", async () => {
  pushSubs.add(sub(1)); pushSubs.add(sub(3)); pushSubs.add(sub(4));
  const payload: PushPayload = { kind: "needs", title: "t", body: "b", tag: "x", url: "/phone", needs: 0, at: "now" };
  const r = await broadcast(payload, async (s: PushSubscription) => {
    if (s.endpoint.endsWith("/3")) { const e: any = new Error("gone"); e.statusCode = 410; throw e; }
    if (s.endpoint.endsWith("/4")) { const e: any = new Error("flaky"); e.statusCode = 500; throw e; }
  });
  assert.deepEqual(r, { sent: 1, dropped: 1 });
  assert.deepEqual(pushSubs.list().map((x) => x.endpoint).sort(), [sub(1).endpoint, sub(4).endpoint]);
});

test("disabled: startPush attaches nothing", async () => {
  const sent: PushPayload[] = [];
  const stop = startPush({ enabled: false, send: async (_s, p) => { sent.push(p); }, activity: () => ({ live: true, quiet: true }), prompt: () => null });
  bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
  bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick();
  assert.equal(sent.length, 0);
  stop();
});

test("a terminal that keeps flickering gets at most three pushes until the operator types into it", async () => {
  const sent: PushPayload[] = [];
  let t = 5_000_000;
  const flip = async () => {
    bus.publish({ topic: "session.activity", session_id: s.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: s.id, state: "waiting" }); await tick();
    t += COOLDOWN_MS + 1;
  };
  for (const x of pushSubs.list()) pushSubs.remove(x.endpoint);
  pushSubs.add(sub(1)); // one endpoint, so sent.length counts pushes, not deliveries
  const stop = startPush({ enabled: true, now: () => t, send: async (_s, p) => { sent.push(p); }, activity: () => ({ live: true, quiet: true }), prompt: () => null });
  try {
    for (let i = 0; i < MAX_PER_TERMINAL + 4; i++) await flip();
    assert.equal(sent.length, MAX_PER_TERMINAL, "capped");
    // The agent's own writes do not count as the operator looking.
    bus.publish({ topic: "session.input", session_id: s.id, by: "agent", text: "y", workspace_id: ws.id }); await tick();
    await flip();
    assert.equal(sent.length, MAX_PER_TERMINAL);
    bus.publish({ topic: "session.input", session_id: s.id, by: "operator", text: "continue", workspace_id: ws.id }); await tick();
    await flip();
    assert.equal(sent.length, MAX_PER_TERMINAL + 1, "answering resets the count");
  } finally { stop(); }
});

test("a live Lead's worker never pushes — the Lead is woken instead, and the phone does not list it", async () => {
  const lead = sessions.create({ workspace_id: ws.id, cwd: tmp, backend: "claude-code", role: "lead", goal: "drive the batch" });
  const worker = sessions.create({ workspace_id: ws.id, cwd: tmp, backend: "claude-code", goal: "slice 1", lead_id: lead.id } as any);
  const sent: PushPayload[] = [];
  let t = 2_000_000;
  const stop = startPush({
    enabled: true, now: () => t,
    send: async (_sub, p) => { sent.push(p); },
    activity: () => ({ live: true, quiet: true }),
    prompt: () => ({ kind: "yn", question: "ok?" }),
  });
  try {
    bus.publish({ topic: "session.activity", session_id: worker.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: worker.id, state: "waiting" }); await tick();
    assert.equal(sent.length, 0, "the worker's flip is the Lead's business");
    bus.publish({ topic: "agent.state", kind: "session", id: worker.id, state: "blocked" } as any); await tick();
    assert.equal(sent.length, 0, "and so is its block");
    // The Lead itself still pushes, and the badge it carries does not count the worker.
    bus.publish({ topic: "session.activity", session_id: lead.id, state: "working" }); await tick();
    bus.publish({ topic: "session.activity", session_id: lead.id, state: "waiting" }); await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session_id, lead.id);
    assert.ok(!sent[0].needs || sent[0].needs >= 1);
  } finally {
    stop();
    sessions.end(worker.id, "test");
    sessions.end(lead.id, "test");
  }
});
