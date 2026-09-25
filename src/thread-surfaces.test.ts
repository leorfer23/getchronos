/**
 * The router's two integration points: POST /agent and Telegram's runAgent.
 *
 * The decision itself is `resolveTurn` (tested here for real), and both surfaces call it — a turn
 * never runs a manager in a test (CLAUDE.md gotcha 2), so what a route does to a live process is
 * asserted against the wiring in the sources instead.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, chat, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { commitTurn, getSticky, resolveTurn } from "./thread-router.js";

const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
const tg = fs.readFileSync(path.join(process.cwd(), "src/telegram/agent.ts"), "utf8");
const tgRouter = fs.readFileSync(path.join(process.cwd(), "src/telegram.ts"), "utf8");
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

let atlas: any, cedar: any;

beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM workspaces; DELETE FROM kv;");
  CONFIG.thread.aliases = {};
  CONFIG.thread.stickyMinutes = 90;
  atlas = workspaces.create({ slug: "atlas", name: "Atlas", config_dir: "/tmp/atlas" });
  cedar = workspaces.create({ slug: "cedar", name: "Cedar", config_dir: "/tmp/ml" });
});

// ── resolveTurn: the one seam both surfaces use ──────────────────────────────────────────────────

test("an explicit workspace selector overrides the router entirely", () => {
  // The text says atlas; the client says cedar. The client wins, and the tag is NOT stripped
  // (nothing routed) — it is just text the operator typed.
  const t = resolveTurn("#atlas ship it", { selected: cedar.id, surface: "test" });
  assert.equal(t.ws, cedar.id);
  assert.equal(t.how, "selected");
  assert.equal(t.routed, null);
  assert.equal(t.text, "#atlas ship it");
});

test("no selector routes; route:false means the fleet manager literally", () => {
  assert.equal(resolveTurn("#atlas ship it", { surface: "test" }).ws, atlas.id);
  const off = resolveTurn("#atlas ship it", { route: false, surface: "test" });
  assert.equal(off.ws, null);
  assert.equal(off.how, "fleet");
  assert.equal(off.text, "#atlas ship it");
});

test("an ambiguous turn resolves to an ask and runs nothing", () => {
  const t = resolveTurn("open the PR", { surface: "test" });
  assert.equal(t.ask?.how, "ask");
  assert.equal(t.ws, null);
  assert.deepEqual(t.ask?.candidates.map((c) => c.slug), ["atlas", "cedar", "all"]);
});

test("commitTurn pins after a routed turn, releases on a fleet one, and ignores an ask", () => {
  commitTurn("test", resolveTurn("#atlas ship it", { surface: "test" }));
  assert.equal(getSticky("test")?.ws, atlas.id);
  commitTurn("test", resolveTurn("open the PR", { surface: "test" })); // ask
  assert.equal(getSticky("test")?.ws, atlas.id);
  commitTurn("test", resolveTurn("what's running?", { surface: "test" }));
  assert.equal(getSticky("test"), null);
});

test("an explicit pick pins the thread; picking the whole shop releases it", () => {
  commitTurn("test", resolveTurn("hi", { selected: cedar.id, surface: "test" }));
  assert.equal(getSticky("test")?.ws, cedar.id);
  commitTurn("test", resolveTurn("hi", { selected: null, route: false, surface: "test" }));
  assert.equal(getSticky("test"), null);
});

// ── what the surfaces do with it ─────────────────────────────────────────────────────────────────

test("the stored row carries the ROUTED workspace, so each recap stays that project's own", () => {
  // Exactly what POST /agent and runAgent do: resolve → run → store under turn.ws with turn.text.
  for (const text of ["#atlas the warehouse is slow", "#cedar the dag is red", "status"]) {
    const t = resolveTurn(text, { surface: "test" });
    commitTurn("test", t);
    chat.add(t.text, "ok", "web", t.ws);
  }
  assert.deepEqual(chat.recent(99, atlas.id).map((r) => r.you), ["the warehouse is slow"]);
  assert.deepEqual(chat.recent(99, cedar.id).map((r) => r.you), ["the dag is red"]);
  assert.deepEqual(chat.recent(99, null).map((r) => r.you), ["status"]);
  // The isolation the whole feature exists for, through the router path.
  assert.doesNotMatch(chat.contextBlock({ workspaceId: atlas.id }), /dag is red|status/);
  assert.doesNotMatch(chat.contextBlock({ workspaceId: cedar.id }), /warehouse is slow/);
});

test("POST /agent routes, refuses to guess, and answers with where it landed", () => {
  assert.match(api, /const turn = await resolveTurnSmart\(req\.body\.text, \{/);
  assert.match(api, /selected: req\.body\.ws \?\? null/);
  assert.match(api, /stagedSessionId: req\.body\.session \?\? null/);
  // An ask returns candidates instead of running a manager.
  assert.match(api, /if \(turn\.ask\) \{[\s\S]*?ask: \{ why: turn\.ask\.why, candidates: turn\.ask\.candidates \}/);
  // The turn runs on the routed workspace's own manager, and the row is stored under it. `prompt` is
  // `text` plus any attachment paths (chatAttachmentsBlock); the stored `you` stays the clean text.
  assert.match(api, /askManagerWeb\(prompt, \(t, kind\) => bus\.publish\(\{ topic: "agent\.delta", text: t, kind, ws, client, turn: turnId \}\), ws, \{ voice: !!req\.body\.voice, turn: turnId \}\)/);
  assert.match(api, /const row = chat\.add\(text, reply \|\| "", "web", ws, steps, shown\)/);
  assert.match(api, /res\.json\(\{ reply, actions, ws, how: turn\.how, turn: turnId \}\)/);
  assert.match(api, /commitTurn\(surface, turn\)/);
});

test("the debug and control routes exist and are admin-gated", () => {
  assert.match(api, /api\.get\("\/thread\/route", requireAdmin/);
  assert.match(api, /api\.post\("\/thread\/sticky", requireAdmin, validate\(ThreadStickySchema\)/);
  // ws=all is the one visible thread.
  assert.match(api, /if \(ws === "all"\) return res\.json\(\{ messages: chat\.recentAll\(/);
});

test("Telegram runs the turn on the routed workspace's manager and says where it landed", () => {
  assert.match(tg, /const turn = await resolveTurnSmart\(text, \{/);
  assert.match(tg, /selected: pick \? pick\.ws : activeWsForChat\(chat\)/);
  assert.match(tg, /if \(turn\.ask\) \{\s*await offerRoute\(chat, text, msgId, turn\.ask\);/);
  // The prefix appears only when he did NOT say where himself.
  assert.match(tg, /turn\.ws && turn\.how !== "tag" && turn\.how !== "selected" \? `#\$\{workspaces\.get\(turn\.ws\)\?\.slug \?\? "\?"\} · `/);
  // The routed workspace picks the warm manager, and the row is stored under it.
  assert.match(tg, /const m = threadWs \? warmForChatWs\(chat, threadWs\) : warmForChat\(chat\)/);
  assert.match(tg, /chatLog\.add\(body, storedReply, "telegram", threadWs\)/);
  assert.match(tg, /ws: threadWs,/);
});

test("a tap on Telegram's routing question re-runs the same message on that project", () => {
  assert.match(tg, /export async function answerRouteAsk\(key: string, pick: string\)/);
  assert.match(tg, /void runAgent\(pending\.chat, pending\.text, pending\.msgId, \{ ws: ws\.id \}\)/);
  assert.match(tg, /if \(!ws\) return false; \/\/ archived or deleted between the question and the tap/);
  assert.match(tgRouter, /if \(ns === "tr"\) \{\s*const ok = await answerRouteAsk\(op, id\);/);
});

test("the Desk renders one thread with a chip per row, routed by the daemon, never by the filter", () => {
  // No filter → ws=all; a filtered project → that thread's own history (see desk-chat-scope.test.ts).
  assert.match(html, /: "\/agent\/history\?ws=all&limit=16"\)/);
  assert.match(html, /function setChip\(el, ws, chip = true\)/);
  // Both bubbles of a row carry the project even though only one shows the chip, or filtering to a
  // project would hide half of every exchange.
  assert.match(html, /el\.dataset\.ws = ws === undefined \? "\?" : ws \|\| "";/);
  // A tapped candidate is explicit — including #all, which must not route again and ask forever.
  assert.match(html, /if \(item\.picked\) \{ body\.ws = item\.ws; body\.route = false; \}/);
  // Every Robert row belongs here now — only an executive's own pane is a different thread.
  assert.match(html, /String\(e\.ws \|\| ""\)\.startsWith\("agent:"\)\) return;/);
  assert.doesNotMatch(html, /api\("\/thread\/sticky"/);
  assert.match(html, /session: S\.active \|\| null/);
  assert.match(html, /if \(r\?\.how === "ask"\)/);
});

test("Robert is told he only ever sees this project — and that a handoff is fleet-level", () => {
  const threads = fs.readFileSync(path.join(process.cwd(), "agents/_blocks/threads.md"), "utf8");
  const coord = fs.readFileSync(path.join(process.cwd(), "agents/_blocks/coordinator.md"), "utf8");
  assert.equal(threads.trim().split("\n").length, 6);
  assert.match(threads, /never claim knowledge of another project's work/);
  assert.match(threads, /`#all`/);
  assert.match(coord, /CROSS-PROJECT WORK IS FLEET-LEVEL/);
  for (const surface of ["agents/robert/web.md", "agents/robert/telegram.md"])
    assert.match(fs.readFileSync(path.join(process.cwd(), surface), "utf8"), /\{\{> threads\}\}/, surface);
});

test("a line said on the phone shows on the Desk: turns carry the sending page, the Desk skips only its own", () => {
  // Phone and Desk share the "web" surface, so source cannot tell them apart — the page id can.
  assert.match(api, /bus\.publish\(\{ topic: "agent\.asked", you: text, at: new Date\(\)\.toISOString\(\), source: surface, ws, client, turn: turnId,/);
  assert.match(api, /client,\n\s*turn: turnId,/);
  assert.match(html, /const body = \{ text: item\.text, session: S\.active \|\| null, client: CLIENT \};/);
  assert.match(html, /"agent\.asked"/);
  assert.match(html, /if \(e\.client === CLIENT \|\| !e\.you\) return;/);
  assert.match(html, /const fromHere = e\.client === CLIENT;/);
  assert.doesNotMatch(html, /const fromHere = e\.source === "web";/);
});
