import test from "node:test";
import assert from "node:assert/strict";
import { OpenSessionSchema } from "./validation.js";

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
