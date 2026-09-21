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
