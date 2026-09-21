import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces } from "./store.js";
import { parseVerdict, resolveVerifyMode, verdictBlocks } from "./verifier.js";
import { PatchWorkspaceSchema } from "./validation.js";

beforeEach(() => {
  db.exec("DELETE FROM workspaces;");
});

test("parseVerdict: parseable verdicts pass through, junk around the JSON is fine", () => {
  assert.deepEqual(parseVerdict('thinking...\n{"met": true, "reason": "all good"}'), { met: true, reason: "all good" });
  assert.deepEqual(parseVerdict('{"met": false, "reason": "no tests ran"}'), { met: false, reason: "no tests ran" });
});

test("parseVerdict: takes the LAST parseable candidate — an echoed prompt template earlier in the output doesn't shadow the real verdict", () => {
  const echoed =
    'I will reply with {"met": true|false, "reason": "<short>"} as instructed.\n' +
    'Checked the files.\n{"met": true, "reason": "output present"}';
  assert.deepEqual(parseVerdict(echoed), { met: true, reason: "output present" });
});

test("parseVerdict: unparseable output is an inconclusive met:false, not a silent pass", () => {
  for (const text of ["", "I could not tell.", '{"met": oops}']) {
    const v = parseVerdict(text);
    assert.equal(v.met, false, JSON.stringify(text));
    assert.equal(v.inconclusive, true, JSON.stringify(text));
  }
});

test("verdictBlocks: shadow never blocks, enforce fails open, strict fails closed", () => {
  const failed = { met: false, reason: "goal not met" };
  const inconclusive = { met: false, reason: "verifier unavailable", inconclusive: true };
  const passed = { met: true, reason: "ok" };

  assert.equal(verdictBlocks("shadow", failed), false);
  assert.equal(verdictBlocks("shadow", inconclusive), false);
  assert.equal(verdictBlocks("shadow", passed), false);

  assert.equal(verdictBlocks("enforce", failed), true);
  assert.equal(verdictBlocks("enforce", inconclusive), false);
  assert.equal(verdictBlocks("enforce", passed), false);

  assert.equal(verdictBlocks("strict", failed), true);
  assert.equal(verdictBlocks("strict", inconclusive), true);
  assert.equal(verdictBlocks("strict", passed), false);
});

test("resolveVerifyMode: workspace column overrides the daemon default, junk falls back to enforce", () => {
  assert.equal(resolveVerifyMode(undefined), "enforce");

  const ws = workspaces.create({ slug: "vm-test", name: "vm", config_dir: "/tmp/cfg", verify_mode: "shadow" });
  assert.equal(ws.verify_mode, "shadow");
  assert.equal(resolveVerifyMode(ws), "shadow");

  const strict = workspaces.update(ws.id, { verify_mode: "strict" })!;
  assert.equal(resolveVerifyMode(strict), "strict");

  const cleared = workspaces.update(ws.id, { verify_mode: null })!;
  assert.equal(resolveVerifyMode(cleared), "enforce");

  assert.equal(resolveVerifyMode({ verify_mode: "bogus" } as any), "enforce");
});

test("API schema passes verify_mode through (zod strips unknown keys — a missing field here is a silent no-op PATCH)", () => {
  assert.equal(PatchWorkspaceSchema.parse({ verify_mode: "shadow" }).verify_mode, "shadow");
  assert.equal(PatchWorkspaceSchema.parse({ verify_mode: null }).verify_mode, null);
  assert.equal(PatchWorkspaceSchema.safeParse({ verify_mode: "bogus" }).success, false);
});
