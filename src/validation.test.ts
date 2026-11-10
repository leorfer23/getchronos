import test from "node:test";
import assert from "node:assert/strict";
import { AgentTextSchema, NewJotSchema, OpenSessionSchema, PlanNextDaySchema } from "./validation.js";

test("OpenSessionSchema accepts role \"lead\" (LEADS.md)", () => {
  const parsed = OpenSessionSchema.safeParse({ workspace_id: "ws1", role: "lead", goal: "ship it" });
  assert.equal(parsed.success, true, parsed.success ? "" : String(parsed.error));
  assert.equal(parsed.success ? parsed.data.role : undefined, "lead");
});

test("OpenSessionSchema still rejects an unknown role", () => {
  assert.equal(OpenSessionSchema.safeParse({ role: "overlord" }).success, false);
});

test("OpenSessionSchema accepts optional focus_only and defaults to omitting it", () => {
  const on = OpenSessionSchema.safeParse({ workspace_id: "ws1", focus_only: true });
  assert.equal(on.success, true, on.success ? "" : String(on.error));
  assert.equal(on.success ? on.data.focus_only : undefined, true);
  const off = OpenSessionSchema.parse({ workspace_id: "ws1" });
  assert.equal("focus_only" in off, false);
});

test("OpenSessionSchema: a blank terminal needs no goal at all", () => {
  assert.equal(OpenSessionSchema.safeParse({ workspace_id: "ws1", backend: "claude-code", role: "human" }).success, true);
  assert.equal(OpenSessionSchema.safeParse({ goal: null, goal_kind: null }).success, true);
});

test("PlanNextDaySchema / NewJotSchema: ids, steering keyed by id, a calendar day or nothing", () => {
  assert.equal(PlanNextDaySchema.safeParse({}).success, true);
  assert.equal(PlanNextDaySchema.safeParse({ workspaces: ["a"], steering: { a: "x" }, date: "2026-09-04" }).success, true);
  assert.equal(PlanNextDaySchema.safeParse({ date: "tomorrow" }).success, false);
  assert.equal(PlanNextDaySchema.safeParse({ workspaces: [] }).success, false);
  assert.equal(NewJotSchema.safeParse({ title: "t", for_date: "2026-09-04", planned_by: "s1" }).success, true);
  assert.equal(NewJotSchema.safeParse({ title: "t", for_date: "09-04" }).success, false);
});

// Reply to one bubble: the daemon reads the quoted words back from the row (chat.quoteOf), never from the client.
test("AgentTextSchema: replyTo is an id and a side — no text a client could put in his mouth", () => {
  assert.ok(AgentTextSchema.safeParse({ text: "yes", replyTo: { id: 3, side: "reply" } }).success);
  assert.ok(AgentTextSchema.safeParse({ text: "yes", replyTo: null }).success);
  assert.ok(!AgentTextSchema.safeParse({ text: "yes", replyTo: { id: 3, side: "robert" } }).success);
  assert.ok(!AgentTextSchema.safeParse({ text: "yes", replyTo: { id: "3", side: "you" } }).success);
  const parsed = AgentTextSchema.parse({ text: "yes", replyTo: { id: 3, side: "you", text: "forged" } });
  assert.deepEqual(parsed.replyTo, { id: 3, side: "you" }, "extra fields are dropped");
});
