import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, robertWakes, tickets, workspaces } from "./store.js";
import {
  WAKE_ATTEMPT_CAP,
  batchPrompt,
  drainScope,
  dueRows,
  enqueueWake,
  resetWakeQueueState,
  setWakeAsker,
  setWakeNotifier,
  setWakePoster,
  touchWakeBeacon,
  wakeBeaconFresh,
  wakeDue,
  wakeKeyFor,
} from "./wake-queue.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

let asked: string[] = [];
let posted: Array<{ body: string; ticket_id: string | null; workspace_id: string | null }> = [];
let notified: string[] = [];
let reply = "ok, approve it";
let throwOnAsk = false;

setWakeAsker(async (prompt) => {
  asked.push(prompt);
  if (throwOnAsk) throw new Error("engine down");
  return reply;
});
setWakePoster((p) => { posted.push(p); });
setWakeNotifier(async (t) => { notified.push(t); });

function reset() {
  db.prepare("DELETE FROM robert_wakes").run();
  db.prepare("DELETE FROM kv").run();
  db.prepare("DELETE FROM tickets").run();
  db.prepare("DELETE FROM workspaces").run();
  resetWakeQueueState();
  asked = []; posted = []; notified = [];
  reply = "ok, approve it";
  throwOnAsk = false;
}

function ws(slug = "ws1"): string {
  return workspaces.create({ slug, name: slug, config_dir: "/tmp/" + slug }).id;
}

function ticket(wsId: string, key: string): string {
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(), title: `${key} title`,
    status: "blocked", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
  } as any).id;
}

const wake = (over: Record<string, unknown> = {}) => ({
  topic: "ticket.updated",
  key: "ticket-blocked:t1",
  subject: "t1",
  workspace_id: null,
  payload: { say: "TCK-1 went BLOCKED." },
  ...over,
});

test("a wake is a row before it is a turn, and a repeat is absorbed by the queued row", () => {
  reset();
  const id = enqueueWake(wake());
  const again = enqueueWake(wake({ payload: { say: "TCK-1 went BLOCKED (again)." } }));
  assert.equal(again, id, "same key while unacked = same row");
  const rows = robertWakes.unacked();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 2);
  // attempts is the delivery counter — absorbing repeats must never park a row.
  assert.equal(rows[0].attempts, 0);
  assert.match(rows[0].payload!, /again/);
});

test("an acked key does not absorb the next wake — it is new news", () => {
  reset();
  enqueueWake(wake());
  robertWakes.ack(robertWakes.unacked()[0].id);
  enqueueWake(wake());
  assert.equal(robertWakes.unacked().length, 1);
});

test("one turn drains every queued wake in generation order and acks through the highest", async () => {
  reset();
  enqueueWake(wake({ key: "review:r1", subject: "t1", payload: { say: "first" } }));
  enqueueWake(wake({ key: "ask:a1", subject: "t2", payload: { say: "second" } }));
  enqueueWake(wake({ key: "ticket-blocked:t3", subject: "t3", payload: { say: "third" } }));

  assert.equal(await drainScope("default", NOW), "drained");
  assert.equal(asked.length, 1, "three wakes, one turn");
  assert.ok(asked[0].indexOf("first") < asked[0].indexOf("second"));
  assert.ok(asked[0].indexOf("second") < asked[0].indexOf("third"));
  assert.equal(robertWakes.unacked().length, 0);
  assert.equal(posted.length, 1);
  // A batch is not about one ticket, so the post is not tagged with one.
  assert.equal(posted[0].ticket_id, null);
});

test("a single wake posts tagged with its ticket, and is presented verbatim (no batch framing)", async () => {
  reset();
  enqueueWake(wake({ subject: "t9", payload: { say: "TCK-9 went BLOCKED." } }));
  await drainScope("default", NOW);
  assert.equal(posted[0].ticket_id, "t9");
  assert.doesNotMatch(asked[0], /wake 1 of/);
});

test("a thrown turn leaves the rows queued, counts the attempt, and records why", async () => {
  reset();
  enqueueWake(wake());
  throwOnAsk = true;
  assert.equal(await drainScope("default", NOW), "failed");
  const [row] = robertWakes.unacked();
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, "engine down");
  assert.equal(row.claimed_at, null, "a failed claim is released so the next drain retries it");
  assert.equal(posted.length, 0);
});

test("unacked wakes survive a restart — the drain replays them against the same DB", async () => {
  reset();
  enqueueWake(wake());
  throwOnAsk = true;
  await drainScope("default", NOW);
  assert.equal(robertWakes.unacked().length, 1);

  resetWakeQueueState(); // the daemon comes back: in-process state is gone, the table is not
  throwOnAsk = false;
  assert.equal(await drainScope("default", NOW), "drained");
  assert.equal(robertWakes.unacked().length, 0);
  assert.equal(asked.length, 2);
});

test("past the attempt cap a wake is parked: out of the drain, onto the phone, never dropped", async () => {
  reset();
  enqueueWake(wake());
  throwOnAsk = true;
  for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) await drainScope("default", NOW);
  const [row] = robertWakes.unacked();
  assert.equal(row.attempts, WAKE_ATTEMPT_CAP);

  throwOnAsk = false;
  assert.equal(await drainScope("default", NOW), "idle", "a parked row no longer spends turns");
  assert.equal(robertWakes.unacked().length, 1, "and it is still there for a human");
  assert.equal(notified.length, 1, "one notice per parked wake, not one per sweep");
  assert.match(notified[0], /parked/i);
});

test("a successful turn never acks a parked row that was not in the prompt", async () => {
  reset();
  enqueueWake(wake({ key: "ticket-blocked:old", subject: "old" }));
  throwOnAsk = true;
  for (let i = 0; i < WAKE_ATTEMPT_CAP; i++) await drainScope("default", NOW);
  throwOnAsk = false;
  enqueueWake(wake({ key: "review:new", subject: "new" }));
  assert.equal(await drainScope("default", NOW), "drained");
  const left = robertWakes.unacked();
  assert.equal(left.length, 1);
  assert.equal(left[0].key, "ticket-blocked:old");
});

test("the 15-minute per-subject window is read from the table, not from memory", () => {
  reset();
  assert.equal(wakeDue(null, NOW), true);
  assert.equal(wakeDue(new Date(NOW - 60_000).toISOString(), NOW), false);
  assert.equal(wakeDue(new Date(NOW - 16 * 60_000).toISOString(), NOW), true);

  enqueueWake(wake({ key: "review:r1", subject: "t1" }));
  const rows = robertWakes.unacked();
  robertWakes.claim([rows[0].id]);
  robertWakes.ackIds([rows[0].id], WAKE_ATTEMPT_CAP);

  enqueueWake(wake({ key: "ask:a1", subject: "t1" }));
  const queued = robertWakes.unacked();
  assert.equal(dueRows(queued, Date.now()).length, 0, "same ticket inside the window: not a second turn");
  assert.equal(dueRows(queued, Date.now() + 16 * 60_000).length, 1, "past it: his own wake");
  // Suppressed, not dropped — the row is still queued for when the window closes.
  assert.equal(robertWakes.unacked().length, 1);
});

test("a terminal prompt is exempt from the per-subject window — a second question is new news", () => {
  reset();
  // Same subject as the row just handled, which for any other topic means "wait 15 minutes". A
  // terminal is BLOCKED on its question, so `terminal-prompt:` keys bypass the window (see
  // TERMINAL_PROMPT_KEY). The key carries the prompt hash, so the SAME question is still deduped.
  const subject = "session:abc";
  enqueueWake(wake({ key: "terminal-prompt:abc:h1", subject, payload: { say: "first question" } }));
  const [first] = robertWakes.unacked();
  robertWakes.claim([first.id]);
  robertWakes.ackIds([first.id], WAKE_ATTEMPT_CAP);
  enqueueWake(wake({ key: "terminal-prompt:abc:h2", subject, payload: { say: "second question" } }));
  assert.equal(dueRows(robertWakes.unacked(), Date.now()).length, 1);
  // The contrast: a non-prompt wake on that same subject is still held back.
  enqueueWake(wake({ key: "review:r9", subject, payload: { say: "a review landed" } }));
  assert.equal(dueRows(robertWakes.unacked(), Date.now()).length, 1);
});

test("workspaces drain separately — one turn per workspace batch", async () => {
  reset();
  const a = ws("acme");
  const b = ws("beta");
  enqueueWake(wake({ key: "review:a1", subject: "ta", workspace_id: a }));
  enqueueWake(wake({ key: "review:b1", subject: "tb", workspace_id: b }));
  assert.deepEqual(robertWakes.unackedScopes().sort(), [a, b].sort());
  await drainScope(a, NOW);
  assert.equal(robertWakes.unackedForScope(a).length, 0);
  assert.equal(robertWakes.unackedForScope(b).length, 1);
});

test("a drain already running for a scope is not entered twice", async () => {
  reset();
  enqueueWake(wake());
  let release = () => {};
  setWakeAsker(async () => {
    await new Promise<void>((r) => { release = r; });
    return "done";
  });
  const first = drainScope("default", NOW);
  assert.equal(await drainScope("default", NOW), "busy");
  release();
  assert.equal(await first, "drained");
  setWakeAsker(async (prompt) => { asked.push(prompt); if (throwOnAsk) throw new Error("engine down"); return reply; });
});

test("an empty reply still acks — a silent turn must not re-present the same wakes forever", async () => {
  reset();
  enqueueWake(wake());
  reply = "   ";
  assert.equal(await drainScope("default", NOW), "drained");
  assert.equal(posted.length, 0);
  assert.equal(robertWakes.unacked().length, 0);
});

test("the beacon is fresh only inside the grace the drain cadence sets", () => {
  reset();
  assert.equal(wakeBeaconFresh(NOW), false, "never beaten = stale");
  touchWakeBeacon(NOW);
  assert.equal(wakeBeaconFresh(NOW + 60_000), true);
  assert.equal(wakeBeaconFresh(NOW + 20 * 60_000), false);
});

test("the dedupe key names the thing that happened", () => {
  assert.equal(wakeKeyFor({ topic: "ask.created", ask_id: "a1", ticket_id: "t1" } as any), "ask:a1");
  assert.equal(wakeKeyFor({ topic: "review.created", review_id: "r1", ticket_id: "t1" } as any), "review:r1");
  assert.equal(wakeKeyFor({ topic: "ticket.updated", ticket_id: "t1", status: "blocked" } as any), "ticket-blocked:t1");
});

test("a batch prompt tells him to answer all of them in one reply", () => {
  reset();
  enqueueWake(wake({ key: "k1", subject: "t1", payload: { say: "one" } }));
  enqueueWake(wake({ key: "k2", subject: "t2", payload: { say: "two" } }));
  const p = batchPrompt(robertWakes.unacked());
  assert.match(p, /2 things queued up/);
  assert.match(p, /wake 1 of 2/);
  assert.match(p, /wake 2 of 2/);
});

test("a repeat absorbed while queued is named in the prompt", () => {
  reset();
  enqueueWake(wake());
  enqueueWake(wake());
  enqueueWake(wake());
  assert.match(batchPrompt(robertWakes.unacked()), /happened 3 times/);
});

test("tickets scope a bus wake to their workspace", async () => {
  reset();
  const id = ws("acme");
  const t = ticket(id, "ACM-1");
  const { enqueueBusWake } = await import("./wake-queue.js");
  enqueueBusWake({ topic: "ticket.updated", ticket_id: t, status: "blocked" } as any);
  assert.equal(robertWakes.unacked()[0].workspace_id, id);
});

test("a row claimed by a crashed drain but held back by its window is not acked by the next drain", async () => {
  reset();
  // t1 was handled a minute ago, so any further t1 row is inside its window.
  enqueueWake(wake({ key: "review:r1", subject: "t1" }));
  const first = robertWakes.unacked();
  robertWakes.claim([first[0].id]);
  robertWakes.ackIds([first[0].id], WAKE_ATTEMPT_CAP);
  // A second t1 wake was claimed by a drain that died before acking (claimed_at set, never failed).
  enqueueWake(wake({ key: "ask:a1", subject: "t1" }));
  const stuck = robertWakes.unacked()[0];
  robertWakes.claim([stuck.id]);
  // An unrelated wake drains now.
  enqueueWake(wake({ key: "ticket-blocked:t2", subject: "t2" }));
  setWakeAsker(async () => "handled t2");
  setWakePoster(() => {});
  assert.equal(await drainScope("default", Date.now()), "drained");
  const left = robertWakes.unacked();
  assert.equal(left.length, 1, "the held-back t1 row is still queued");
  assert.equal(left[0].id, stuck.id);
});
