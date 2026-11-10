import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, agentChat, chat } from "../store.js";

beforeEach(() => {
  db.exec("DELETE FROM agent_chat; DELETE FROM chat_messages;");
});

test("agentChat.add works with no workspaces row — the FK bug that hung 'thinking…'", () => {
  // chat.add("x","y","web","agent:ada") threw SQLITE_CONSTRAINT_FOREIGNKEY here; agent_chat must not.
  const row = agentChat.add("ada", "hola", "¡Hola the operator!");
  assert.ok(row.id > 0);
  const msgs = agentChat.recent("ada");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].you, "hola");
  assert.equal(msgs[0].reply, "¡Hola the operator!");
});

test("threads are per-agent and ordered oldest→newest", () => {
  agentChat.add("ada", "one", "r1");
  agentChat.add("iris", "other", "r");
  agentChat.add("ada", "two", "r2");
  const msgs = agentChat.recent("ada");
  assert.deepEqual(msgs.map((m: any) => m.you), ["one", "two"]);
});

test("exec threads never leak into the manager thread (and vice versa)", () => {
  agentChat.add("ada", "exec msg", "r");
  chat.add("mgr msg", "reply", "web", null);
  assert.deepEqual(chat.recent(10, null).map((m: any) => m.you), ["mgr msg"]);
  assert.deepEqual(agentChat.recent("ada").map((m: any) => m.you), ["exec msg"]);
});

test("chat.add stores a turn's voice flag and latency stamps; rows without them stay NULL", () => {
  const timed = chat.add("hola", "hola.", "web", null, null, null, null, "opus", {
    voice: true,
    asked_at: "2026-11-09T10:00:00.000Z",
    first_delta_at: "2026-11-09T10:00:01.200Z",
  });
  const plain = chat.add("typed", "ok", "web");
  const typed = chat.add("typed", "ok", "web", null, null, null, null, null, { voice: false, asked_at: "2026-11-09T10:01:00.000Z", first_delta_at: null });
  const get = (id: number) => db.prepare("SELECT voice, asked_at, first_delta_at FROM chat_messages WHERE id = ?").get(id) as any;
  assert.deepEqual({ ...get(timed.id) }, { voice: 1, asked_at: "2026-11-09T10:00:00.000Z", first_delta_at: "2026-11-09T10:00:01.200Z" });
  assert.deepEqual({ ...get(plain.id) }, { voice: null, asked_at: null, first_delta_at: null });
  assert.deepEqual({ ...get(typed.id) }, { voice: 0, asked_at: "2026-11-09T10:01:00.000Z", first_delta_at: null });
  // GET /agent/history reads these rows with SELECT *, so the stamps reach the client as-is.
  const row = chat.recent(10, null).find((r: any) => r.id === timed.id);
  assert.equal(row.voice, 1);
  assert.equal(row.asked_at, "2026-11-09T10:00:00.000Z");
});
