import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { continuations, db, robertWakes, workspaces } from "./store.js";
import { deliver, sweep } from "./continuations.js";
import { createFollowUp, FOLLOWUP_LIMITS, pendingFollowUps } from "./robert-followups.js";
import { drainScope, resetWakeQueueState, setWakeAsker, setWakePoster, wakeSection } from "./wake-queue.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";

const MIN = 60_000;
const NOW = Date.now();

let asked: string[] = [];
let posted: string[] = [];
let reply = "QUIET";
setWakeAsker(async (prompt) => { asked.push(prompt); return reply; });
setWakePoster((p) => { posted.push(p.body); });

let ws: { id: string };
beforeEach(() => {
  db.exec("DELETE FROM continuations; DELETE FROM robert_wakes; DELETE FROM kv; DELETE FROM workspaces;");
  resetWakeQueueState();
  _resetSettingsCache();
  ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  asked = []; posted = []; reply = "QUIET";
});
after(() => { _resetSettingsCache(); });

async function followUp(when = "+10m", note = "asked the operator to merge PR 12 — no answer yet? ask again", extra: Record<string, unknown> = {}) {
  const r = await createFollowUp(ws.id, { when, note, ...extra }, "robert", NOW);
  assert.ok(r.ok, (r as any).error);
  return (r as any).followup;
}
// Every row, acked or not: an enqueue kicks the drain on the next tick, and that may ack it under us.
const wakesFor = (id: string) => db.prepare("SELECT * FROM robert_wakes WHERE key = ?").all(`followup:${id}`) as any[];
const followUpWakes = () => (db.prepare("SELECT COUNT(*) n FROM robert_wakes WHERE key LIKE 'followup:%'").get() as { n: number }).n;
/** Let the kicked drain run, then drain whatever is left. */
async function settle(nowMs: number) {
  await new Promise((r) => setTimeout(r, 30));
  await drainScope(ws.id, nowMs);
  await new Promise((r) => setTimeout(r, 30));
}

test("a due follow-up fires exactly once, into Robert's wake queue with his own note", async () => {
  const f = await followUp("+10m", "check CI on the export PR", { subject: "https://github.com/acme/app/pull/12" });
  assert.equal(f.status, "pending");

  await sweep(NOW + 5 * MIN);
  assert.equal(continuations.get(f.id)!.status, "armed", "not due yet");
  assert.equal(robertWakes.unacked().length, 0);

  await sweep(NOW + 11 * MIN);
  const row = continuations.get(f.id)!;
  assert.equal(row.status, "fired");
  assert.equal(row.fired_how, "woke");
  const [w] = wakesFor(f.id);
  assert.ok(w, "one wake queued");
  assert.equal(w.topic, "followup");
  assert.equal(w.workspace_id, ws.id);
  const say = JSON.parse(w.payload!).say as string;
  assert.match(say, /follow-up YOU set/);
  assert.match(say, /check CI on the export PR/);
  assert.match(say, /pull\/12/);
  assert.match(say, /current state first/);
  assert.match(say, /QUIET/);
  assert.doesNotMatch(say, /LATE/, "on time");

  // Another pass, a hand-made second delivery: still one wake.
  await sweep(NOW + 12 * MIN);
  assert.equal(await deliver(continuations.get(f.id)!, NOW + 12 * MIN), null);
  assert.equal(followUpWakes(), 1);
});

test("one that came due while the daemon was down fires once on boot, saying it is late", async () => {
  const f = await followUp("+10m");
  // "Restart": the in-process queue state is gone, the rows are not. The boot pass runs hours late.
  resetWakeQueueState();
  await sweep(NOW + 3 * 60 * MIN);
  const [w] = wakesFor(f.id);
  assert.match(JSON.parse(w.payload!).say, /LATE/);
  resetWakeQueueState();
  await sweep(NOW + 3 * 60 * MIN + 30_000);
  assert.equal(wakesFor(f.id).length, 1, "a second boot does not fire it again");
});

test("mark-then-enqueue is one transaction: a failed enqueue leaves it pending, and the retry fires once", async () => {
  const f = await followUp("+10m");
  const real = robertWakes.enqueue;
  robertWakes.enqueue = () => { throw new Error("disk full"); };
  try {
    await sweep(NOW + 11 * MIN);
  } finally {
    robertWakes.enqueue = real;
  }
  assert.equal(continuations.get(f.id)!.status, "met", "not marked fired without its wake");
  assert.equal(followUpWakes(), 0);
  await sweep(NOW + 20 * MIN);
  assert.equal(continuations.get(f.id)!.status, "fired");
  assert.equal(wakesFor(f.id).length, 1);
});

test("limits are the daemon's: 5 minutes to 7 days out, a short note, once only, 20 per workspace", async () => {
  const refused = async (r: Record<string, unknown>, re: RegExp, status = 400) => {
    const out = await createFollowUp(ws.id, { when: "+1h", note: "check it", ...r } as any, "robert", NOW);
    assert.equal(out.ok, false, JSON.stringify(r));
    assert.equal((out as any).status, status);
    assert.match((out as any).error, re);
  };
  await refused({ when: "+2m" }, /at least 5 minutes/);
  await refused({ when: "+8d" }, /at most 7 days/);
  await refused({ note: "x".repeat(FOLLOWUP_LIMITS.noteMax + 1) }, /under 400/);
  await refused({ note: "  " }, /what to check/);
  await refused({ every: "1h" }, /fires once/);
  await refused({ when: "someday" }, /can't read the time/);
  assert.ok((await createFollowUp(ws.id, { when: "+7d", note: "weekly-ish nudge" }, "robert", NOW - MIN)).ok, "7 days is allowed");

  for (let i = pendingFollowUps(ws.id).length; i < FOLLOWUP_LIMITS.perWorkspace; i++) await followUp("+1h", `check ${i}`);
  await refused({}, /already has 20 follow-ups pending/, 409);
  // The cap is per workspace: another one is untouched.
  const other = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/globex" });
  assert.ok((await createFollowUp(other.id, { when: "+1h", note: "check it" }, "robert", NOW)).ok);
});

test("a cancelled follow-up never fires", async () => {
  const f = await followUp("+10m");
  const { cancel } = await import("./continuations.js");
  assert.equal(cancel(continuations.get(f.id)!, "the operator answered"), true);
  await sweep(NOW + 11 * MIN);
  assert.equal(continuations.get(f.id)!.status, "cancelled");
  assert.equal(followUpWakes(), 0);
});

test("Robert switched off for the workspace when it comes due: no wake, the row says why", async () => {
  const f = await followUp("+10m");
  writeSetting("robert.enabled", false, ws.id);
  try {
    await sweep(NOW + 11 * MIN);
  } finally {
    writeSetting("robert.enabled", null, ws.id);
    _resetSettingsCache();
  }
  const row = continuations.get(f.id)!;
  assert.equal(row.status, "cancelled");
  assert.match(row.evidence ?? "", /switched off/);
  assert.equal(followUpWakes(), 0);
});

test("a follow-up that resolved itself ends QUIET and silent — any other wake in the batch still posts", async () => {
  const f = await followUp("+10m");
  await sweep(NOW + 11 * MIN);
  const [row] = wakesFor(f.id);
  assert.doesNotMatch(wakeSection(row), /Post ONE or TWO lines/, "its own rules, not the generic ones");
  await settle(NOW + 12 * MIN);
  assert.equal(asked.length, 1);
  assert.equal(posted.length, 0, "QUIET is acked, never posted");
  assert.equal(robertWakes.unacked().length, 0);

  // A follow-up batched with a stopped terminal: the terminal is news, so QUIET does not swallow it.
  robertWakes.enqueue({ topic: "session.idle", key: "term-drive:abc:idle", workspace_id: ws.id, payload: { say: "terminal abc stopped" } });
  await followUp("+15m");
  await sweep(NOW + 16 * MIN);
  await settle(NOW + 17 * MIN);
  assert.equal(asked.length, 2, "one turn for both");
  assert.deepEqual(posted, ["QUIET"]);
  assert.equal(robertWakes.unacked().length, 0);

  // And a follow-up that needed something posts what he did.
  posted = [];
  reply = "Re-asked the operator about PR 12.";
  await followUp("+20m");
  await sweep(NOW + 21 * MIN);
  await settle(NOW + 22 * MIN);
  assert.deepEqual(posted, ["Re-asked the operator about PR 12."]);
});
