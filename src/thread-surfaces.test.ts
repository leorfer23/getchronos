/**
 * The router's decision (`resolveTurn`, run for real) that POST /agent and Telegram's runAgent both
 * call, the sticky thread it pins, and what every Robert is told about workspaces never mixing.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, chat, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { commitTurn, getSticky, resolveTurn } from "./thread-router.js";

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

// Prompt text is the contract here: what every Robert is told about workspace isolation.
test("workspaces never mix: every Robert surface is told so, and the coordinator no longer owns cross-project work", () => {
  const threads = fs.readFileSync(path.join(process.cwd(), "agents/_blocks/threads.md"), "utf8");
  const coord = fs.readFileSync(path.join(process.cwd(), "agents/_blocks/coordinator.md"), "utf8");
  assert.match(threads, /ONE ROBERT PER PROJECT/);
  assert.match(threads, /Workspaces never mix/);
  assert.match(threads, /reply exactly QUIET/);
  assert.match(threads, /Never tell him to re-send with tags/);
  assert.match(coord, /CROSS-PROJECT WORK — workspaces never mix/);
  assert.doesNotMatch(coord, /CROSS-PROJECT WORK IS YOURS/);
  for (const surface of ["agents/robert/web.md", "agents/robert/telegram.md"])
    assert.match(fs.readFileSync(path.join(process.cwd(), surface), "utf8"), /\{\{> threads\}\}/, surface);
});

