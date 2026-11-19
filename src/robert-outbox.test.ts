/**
 * Robert's outbox (src/robert-outbox.ts): every unprompted line is written down, delivered exactly as
 * before, never repeated word for word about the same thing inside the window, and read back — in its own
 * workspace only — at the start of the next wake turn. Wakes run through the real queue and the DEFAULT
 * poster; only the model is stubbed (setWakeAsker), so no manager ever runs (CLAUDE.md gotcha 2).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { db, artifacts, asks, robertOutbox, robertWakes, sessions, workspaces } from "./store.js";
import { bus, type BusEvent } from "./bus.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { postRobertToDesk } from "./robert-desk.js";
import { notifyAskCreated } from "./asks.js";
import { escalateAsk } from "./ask-robert.js";
import { askMarker } from "./robert-asks.js";
import { postToBoard, setBoardAsker, setBoardWakeMirror, startBoardWatcher } from "./board.js";
import { artifactMarker, publishArtifact, updateArtifact } from "./artifacts.js";
import { REPORTED_MAX_CHARS, episodeOf, reportedBlock, sayUnprompted, withReported, withoutReported } from "./robert-outbox.js";
import { batchPrompt, drainScope, enqueueWake, resetWakeQueueState, scopeOf, setWakeAsker } from "./wake-queue.js";

const H = 3_600_000;
const T = Date.parse("2026-11-18T12:00:00.000Z");
const STEP = { at: "2026-11-18T11:59:00.000Z", icon: "🔎", text: "read terminal abc12345", sid: "abc12345", kind: "read" } as any;

let asked: Array<{ prompt: string; model: string }> = [];
let reply: string | { reply: string; steps?: any[]; turn?: string; engine?: string } = "ok";
setWakeAsker(async (prompt, _ws, model) => {
  asked.push({ prompt, model });
  return reply;
});
const pushes: any[] = [];
bus.on("event", (e: BusEvent) => { if (e.topic === "agent.push") pushes.push(e); });
// A page's versions are files: never in the repo's own artifacts/ from a test.
const PAGES = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-outbox-pages-"));
process.env.CHRONOS_ARTIFACTS = PAGES;
after(() => fs.rmSync(PAGES, { recursive: true, force: true }));

function reset() {
  db.exec(
    "DELETE FROM robert_outbox; DELETE FROM robert_wakes; DELETE FROM chat_messages; DELETE FROM board_posts; DELETE FROM asks; " +
      "DELETE FROM artifact_events; DELETE FROM artifacts; DELETE FROM sessions; DELETE FROM kv; DELETE FROM workspaces;",
  );
  _resetSettingsCache();
  resetWakeQueueState();
  asked = [];
  pushes.length = 0;
  reply = "ok";
}
const ws = (slug: string) => workspaces.create({ slug, name: slug, config_dir: "/tmp/" + slug }).id;
const deskPosts = (wsId: string | null, on: boolean) => writeSetting("robert.desk_posts", on, wsId);
// Every column of a chat row but its id and timestamp; every field of a push but its id and timestamp.
const chatRows = () =>
  db.prepare("SELECT you, reply, source, workspace_id, steps, attachments, reply_to, reply_quote, engine, voice, asked_at, first_delta_at FROM chat_messages ORDER BY id").all();
const strip = ({ id: _id, at: _at, ...rest }: any) => rest;
const robertBoard = () => db.prepare("SELECT body, ticket_id, workspace_id FROM board_posts WHERE author = 'robert' ORDER BY created_at").all();
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

/** One wake about terminal abc, drained now through the real queue and the default poster. */
async function wakeTurn(wsId: string | null, say = "terminal abc stopped", subject = "session:abc") {
  enqueueWake({ topic: "session.stopped", key: `term-drive:${randomUUID()}`, subject, workspace_id: wsId, payload: { say } });
  return drainScope(scopeOf(wsId), Date.now());
}

async function captureLogs<T>(fn: () => T | Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { out: await fn(), lines };
  } finally {
    console.log = log;
  }
}

// ── delivery is what it was ───────────────────────────────────────────────────────────────────────────

test("desk posts off (the default): a wake's reply is recorded held — no chat row, no push — and the board still gets it", async () => {
  reset();
  const a = ws("acme");
  const said = "Terminal abc stopped on a failing test; told it to rerun.";
  // Before: the poster handed the words to postRobertToDesk, which logged them and stopped.
  const before = await captureLogs(() => postRobertToDesk({ body: said, ws: a, steps: [STEP], turn: "t-1", engine: "sonnet" }));
  assert.equal(before.out, "held");
  reply = { reply: said, steps: [STEP], turn: "t-1", engine: "sonnet" };
  const now = await captureLogs(() => wakeTurn(a));
  assert.equal(now.out, "drained");
  assert.deepEqual(chatRows(), []);
  assert.equal(pushes.length, 0);
  assert.deepEqual(now.lines.filter((l) => l.startsWith("[robert-desk]")), before.lines, "the same quiet line, byte for byte");
  assert.deepEqual(robertBoard(), [{ body: said, ticket_id: "session:abc", workspace_id: a }], "the board post a wake always made");
  const [row] = robertOutbox.list();
  assert.equal(row.status, "held");
  assert.equal(row.reason, "desk posts off");
  assert.equal(row.workspace_id, a);
  assert.equal(row.source, "wake");
  assert.equal(row.body, said);
  assert.equal(row.steps, 1);
  assert.equal(row.turn, "t-1");
  assert.equal(row.episode, "session:abc");
  assert.deepEqual(row.wakes.map((w) => [w.topic, w.subject]), [["session.stopped", "session:abc"]]);
  assert.match(row.wakes[0].key, /^term-drive:/);
  assert.equal(robertWakes.unacked().length, 0, "the turn acked as before");
});

test("desk posts on: the chat row and the push a wake makes are exactly what postRobertToDesk made before", async () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  const out = { reply: "Merged PR #12 for terminal abc — its checks were green.", steps: [STEP], turn: "turn-1", engine: "sonnet" };
  postRobertToDesk({ body: out.reply, ws: a, steps: out.steps, turn: out.turn, engine: out.engine });
  const before = { rows: chatRows(), pushes: pushes.splice(0).map(strip) };
  assert.equal(before.rows.length, 1);
  db.exec("DELETE FROM chat_messages");

  reply = out;
  await wakeTurn(a);
  assert.deepEqual({ rows: chatRows(), pushes: pushes.map(strip) }, before);
  const [row] = robertOutbox.list();
  assert.equal(row.status, "delivered");
  assert.equal(row.channel, "desk");
  assert.ok(row.delivered_at);
});

test("an ask card, an escalation and a watch's answer each write their line down — and post as before", async () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  const card = asks.create({ asked_by: "acme terminal", route: "operator", workspace_id: a, question: "staging or prod?" });
  await notifyAskCreated(card, undefined);
  const up = asks.create({ asked_by: "acme terminal", route: "robert", workspace_id: a, question: "drop the table?" });
  await escalateAsk(up, "destructive — yours", { line: "**Passed a question to you** — destructive" });
  setBoardWakeMirror(null);
  setBoardAsker(async () => "The PR merged at 11:40; nothing needs you.");
  startBoardWatcher();
  postToBoard({ author: "chronos", kind: "watch", workspace_id: a, body: "⏱ watch fired — PR #12 merged\n@robert you asked to be woken for this." });
  await settle();
  setBoardAsker(null);

  assert.deepEqual(
    (chatRows() as Array<{ reply: string }>).map((r) => r.reply),
    [askMarker(card.id), `**Passed a question to you** — destructive\n\n${askMarker(up.id)}`, "The PR merged at 11:40; nothing needs you."],
  );
  const rows = robertOutbox.list({ workspace: a }).reverse();
  assert.deepEqual(rows.map((r) => [r.source, r.episode, r.status]), [
    ["ask", `ask:${card.id}`, "delivered"],
    ["triage", `ask:${up.id}`, "delivered"],
    ["board", "watch:⏱ watch fired — PR #12 merged", "delivered"],
  ]);
});

// The record is only complete while nothing goes round it. The text is the rule here: an allow-list.
test("nothing posts to the Desk in Robert's name except through the outbox", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const callers = fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => f.endsWith(".ts") && !/\.(test|eval)\.ts$/.test(f))
    .filter((f) => /\bpostRobertToDesk\s*\(/.test(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort();
  assert.deepEqual(callers, ["robert-desk.ts", "robert-outbox.ts"]);
});

// ── the one new rule: no word-for-word repeat about the same thing inside 6 hours ──────────────────────

test("the same words about the same thing inside 6h are recorded suppressed, not posted; the window runs from the last one told", () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  const say = (body: string, at: number) => sayUnprompted({ source: "wake", body, ws: a, episode: "session:abc" }, at);
  assert.equal(say("Terminal abc is waiting on your merge OK.", T), "delivered");
  assert.equal(say("terminal abc is  waiting on your\nmerge ok. ", T + 5 * H), "suppressed", "case and spacing aside, the same words");
  assert.equal(chatRows().length, 1);
  assert.deepEqual(robertOutbox.list({ workspace: a }).map((r) => [r.status, r.reason]), [["suppressed", "repeat"], ["delivered", null]]);
  // A suppressed row was never told, so it does not stretch the window.
  assert.equal(say("Terminal abc is waiting on your merge OK.", T + 6 * H + 60_000), "delivered");
  assert.equal(chatRows().length, 2);
  assert.equal(say("Terminal abc is still waiting on your merge OK — 6h now.", T + 6 * H + 120_000), "delivered", "new words are new news");
});

test("another thing, another workspace or the default thread is never a repeat", () => {
  reset();
  const a = ws("acme");
  const g = ws("globex");
  for (const w of [a, g, null]) deskPosts(w, true);
  const body = "The nightly import is red again.";
  assert.equal(sayUnprompted({ source: "wake", body, ws: a, episode: "session:abc" }, T), "delivered");
  assert.equal(sayUnprompted({ source: "wake", body, ws: a, episode: "session:def" }, T + H), "delivered");
  assert.equal(sayUnprompted({ source: "wake", body, ws: g, episode: "session:abc" }, T + H), "delivered");
  assert.equal(sayUnprompted({ source: "wake", body, ws: null, episode: "session:abc" }, T + H), "delivered");
  assert.equal(chatRows().length, 4);
});

test("a page's card is the same marker every time: a new version is new news, the same version twice is not", async () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  const term = sessions.create({ workspace_id: a, cwd: "/tmp", backend: "claude-code" });
  const { artifact } = await publishArtifact({ title: "Report", html: "<p>x</p>", workspace_id: a, session_id: term.id, notify: true });
  updateArtifact(artifacts.get(artifact.id)!, "<p>y</p>", null, true);
  const cards = () => (chatRows() as Array<{ reply: string }>).filter((r) => r.reply === artifactMarker(artifact.id)).length;
  assert.equal(cards(), 2);
  assert.equal(sayUnprompted({ source: "artifact", body: artifactMarker(artifact.id), ws: a, episode: `artifact:${artifact.id}:v2` }), "suppressed");
  assert.equal(cards(), 2);
  assert.deepEqual(robertOutbox.list({ workspace: a }).map((r) => [r.source, r.episode, r.status]).reverse(), [
    ["artifact", `artifact:${artifact.id}:v1`, "delivered"],
    ["artifact", `artifact:${artifact.id}:v2`, "delivered"],
    ["artifact", `artifact:${artifact.id}:v2`, "suppressed"],
  ]);
});

test("held counts as told; a steps-only post has no words to repeat; desk posts off records the repeat too", () => {
  reset();
  const a = ws("acme");
  const say = (at: number, over: object = {}) => sayUnprompted({ source: "wake", body: "PR #12 needs your OK.", ws: a, episode: "pr:12", ...over }, at);
  assert.equal(say(T), "held");
  assert.equal(say(T + H), "suppressed");
  deskPosts(a, true);
  assert.equal(say(T + 2 * H), "suppressed", "it was already said, if not shown");
  assert.equal(chatRows().length, 0);
  const stepsOnly = { body: "", steps: [STEP] };
  assert.equal(say(T + 3 * H, stepsOnly), "delivered");
  assert.equal(say(T + 3 * H + 1, stepsOnly), "delivered");
  assert.equal(chatRows().length, 2);
});

test("two wake turns about the same terminal that say the same thing post once", async () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  reply = "Terminal abc is blocked on a missing env var; asked it to read the README.";
  await wakeTurn(a, "terminal abc stopped");
  await wakeTurn(a, "terminal abc stopped again");
  assert.equal(chatRows().length, 1);
  assert.deepEqual(robertOutbox.list({ workspace: a }).map((r) => r.status), ["suppressed", "delivered"]);
  assert.equal(robertBoard().length, 2, "the board keeps every wake reply, as before");
});

// ── failure never costs the post ──────────────────────────────────────────────────────────────────────

test("an outbox that cannot be written never costs the post: the wake still posts the old direct way", async () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  reply = "Opened a terminal to fix the flaky login test.";
  db.exec("ALTER TABLE robert_outbox RENAME TO robert_outbox_away");
  try {
    assert.equal(await wakeTurn(a), "drained");
    assert.equal(sayUnprompted({ source: "ask", body: "a card", ws: a, episode: "ask:1" }), "unrecorded");
  } finally {
    db.exec("ALTER TABLE robert_outbox_away RENAME TO robert_outbox");
  }
  assert.deepEqual((chatRows() as Array<{ reply: string }>).map((r) => r.reply), ["Opened a terminal to fix the flaky login test.", "a card"]);
  assert.equal(robertBoard().length, 1);
  assert.equal(asked.length, 1, "the turn ran without the block it could not read");
  assert.equal(robertWakes.unacked().length, 0);
});

test("a board post that throws fails the turn as it always did, and the record says so", () => {
  reset();
  const a = ws("acme");
  deskPosts(a, true);
  assert.throws(() => sayUnprompted({ source: "wake", body: "x", ws: a, episode: "e", board: () => { throw new Error("board down"); } }), /board down/);
  assert.equal(chatRows().length, 0);
  const [row] = robertOutbox.list();
  assert.deepEqual([row.status, row.reason], ["failed", "board post failed"]);
});

// ── what the next wake reads back ─────────────────────────────────────────────────────────────────────

test("the episode is what the wakes were about: the subject, the key when there is none, a sorted set for a batch", () => {
  assert.equal(episodeOf([{ key: "term-drive:1", subject: "session:abc" }]), "session:abc");
  assert.equal(episodeOf([{ key: "robert-sweep:ws1", subject: null }]), "robert-sweep:ws1");
  assert.equal(
    episodeOf([{ key: "b", subject: "session:b" }, { key: "a", subject: "session:a" }, { key: "c", subject: "session:a" }]),
    "session:a + session:b",
  );
  assert.equal(episodeOf([]), null);
});

test("the block: newest first, one line each — when, shown or not, the first words — and nothing when there is nothing", () => {
  reset();
  const a = ws("acme");
  assert.equal(reportedBlock(a, T), "");
  const say = (body: string, at: number, episode = randomUUID()) => sayUnprompted({ source: "wake", body, ws: a, episode }, at);
  say("Stale: said yesterday.", T - 25 * H);
  deskPosts(a, true);
  say("Merged PR #12 for terminal abc.", T - 3 * H, "pr:12");
  deskPosts(a, false);
  say("Nudged terminal def to rerun the failing test.", T - 40 * 60_000, "session:def");
  say("Nudged terminal def to rerun the failing test.", T - 10 * 60_000, "session:def"); // suppressed: not listed twice
  say(`**A question for you**\n\n${askMarker("1a2b3c4d-0000-4000-8000-000000000000")}`, T - 5 * 60_000);
  say("x".repeat(300), T - 30_000);
  const lines = reportedBlock(a, T).split("\n");
  assert.equal(lines[0], "What you already told the operator here in the last 24h, newest first (your outbox):");
  assert.equal(lines[1], `- just now · not shown, desk posts off · ${"x".repeat(139)}…`);
  assert.equal(lines[2], "- 5m ago · not shown, desk posts off · **A question for you** [question card 1a2b3c4d]");
  assert.equal(lines[3], "- 40m ago · not shown, desk posts off · Nudged terminal def to rerun the failing test.");
  assert.equal(lines[4], "- 3h ago · shown · Merged PR #12 for terminal abc.");
  assert.match(lines[5], /^Do not repeat these: if one is still unresolved and matters, say what changed or how long it has waited/);
  assert.equal(lines.length, 6, "nothing older than 24h, no repeat listed twice");
});

test("the block never passes its cap, and what it drops is the oldest", async () => {
  reset();
  const a = ws("acme");
  await captureLogs(() => {
    for (let i = 0; i < 30; i++) sayUnprompted({ source: "wake", body: `line ${String(i).padStart(2, "0")} ` + "y".repeat(180), ws: a, episode: `e${i}` }, T - (30 - i) * 60_000);
  });
  const block = reportedBlock(a, T);
  assert.ok(block.length <= REPORTED_MAX_CHARS, `${block.length} chars`);
  assert.match(block, /line 29 /);
  assert.doesNotMatch(block, /line 00 /);
  assert.match(block, /^Do not repeat these/m, "the rule always survives the cut");
});

test("the wall: a workspace reads back its own lines only, and the default thread only its own", () => {
  reset();
  const a = ws("acme");
  const g = ws("globex");
  sayUnprompted({ source: "wake", body: "ACME-ONLY: PR #12 is ready.", ws: a, episode: "pr:12" }, T - H);
  sayUnprompted({ source: "watch", body: "GLOBEX-ONLY: the import job is red.", ws: g, episode: "session:g" }, T - H);
  sayUnprompted({ source: "failover", body: "FLEET-ONLY: m2 offline 6m.", ws: null, episode: "host:m2" }, T - H);
  const of = (w: string | null) => reportedBlock(w, T);
  assert.match(of(a), /ACME-ONLY/);
  assert.doesNotMatch(of(a), /GLOBEX-ONLY|FLEET-ONLY/);
  assert.match(of(g), /GLOBEX-ONLY/);
  assert.doesNotMatch(of(g), /ACME-ONLY|FLEET-ONLY/);
  assert.match(of(null), /FLEET-ONLY/);
  assert.doesNotMatch(of(null), /ACME-ONLY|GLOBEX-ONLY/);
});

test("a wake turn reads the block first, in its own text, with the wake after it untouched; no block, no change", async () => {
  reset();
  const a = ws("acme");
  const g = ws("globex");
  sayUnprompted({ source: "wake", body: "Told acme: PR #12 is ready for your OK.", ws: a, episode: "pr:12" });

  enqueueWake({ topic: "session.stopped", key: "term-drive:a1", subject: "session:abc", workspace_id: a, payload: { say: "terminal abc stopped" } });
  const wakeA = batchPrompt(robertWakes.unackedForScope(a));
  await drainScope(a, Date.now());
  const p = asked[0].prompt;
  assert.ok(p.startsWith(OP_PREFIX + "What you already told the operator here"), "the daemon's mark still opens the turn");
  assert.match(p, /- just now · not shown, desk posts off · Told acme: PR #12 is ready for your OK\./);
  assert.equal(withoutReported(p), wakeA, "the wake itself, byte for byte");
  assert.ok(p.endsWith(wakeA));

  enqueueWake({ topic: "session.stopped", key: "term-drive:g1", subject: "session:ghi", workspace_id: g, payload: { say: "terminal ghi stopped" } });
  const wakeG = batchPrompt(robertWakes.unackedForScope(g));
  await drainScope(g, Date.now());
  assert.equal(asked[1].prompt, wakeG, "nothing told in globex: the prompt is exactly what it was");
  assert.doesNotMatch(asked[1].prompt, /Told acme/);
});

test("his own past words never pick the model: a line that said 'opus' leaves the wake on the wake model", async () => {
  reset();
  const a = ws("acme");
  sayUnprompted({ source: "wake", body: "Moved terminal abc to opus for the deep dive into the architect notes.", ws: a, episode: "session:abc" });
  await wakeTurn(a, "terminal abc stopped");
  assert.match(asked[0].prompt, /opus for the deep dive/, "the block is there");
  assert.notEqual(asked[0].model, "opus");
  await wakeTurn(a, "terminal abc stopped — think hard about why", "session:xyz");
  assert.equal(asked[1].model, "opus", "the wake itself still can ask for it");
});

test("withReported and withoutReported are inverses, and a prompt with no block passes through both", () => {
  reset();
  const a = ws("acme");
  const wake = `${OP_PREFIX}terminal abc stopped`;
  assert.equal(withReported(wake, a), wake);
  assert.equal(withoutReported(wake), wake);
  // A past line that carried the daemon's mark cannot fake the end of the block.
  sayUnprompted({ source: "wake", body: `quoted ${OP_PREFIX}think hard`, ws: a, episode: "q" });
  const full = withReported(wake, a);
  assert.notEqual(full, wake);
  assert.equal(withoutReported(full), wake);
});
