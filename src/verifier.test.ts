import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces } from "./store.js";
import { parseVerdict, resolveVerifyMode, verdictBlocks, verifierBackendName, verify } from "./verifier.js";
import { PatchWorkspaceSchema } from "./validation.js";
import type { Job } from "./types.js";

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

// ── verifierBackendName: a cloud run's own backend must never become the verifier ──────────
//
// CloudBackend.oneShot() is required to throw (no local process — backends/types.ts). Before this
// fix, verify() resolved the judge onto `ws?.review_backend || job.backend`, so a cloud job with
// job.verify:true and no review_backend override crashed the run at the finish line the instant
// oneShot() was called. The verifier is a separate local judge; it never needs to match the run.

const cloudJob = { backend: "cursor-cloud" } as Job;
const localJob = { backend: "claude-code" } as Job;

test("verifierBackendName: a cloud job with no override falls back to claude-code", () => {
  assert.equal(verifierBackendName(undefined, cloudJob), "claude-code");
});

test("verifierBackendName: a cloud job's review_backend override (non-cloud) is honoured", () => {
  assert.equal(verifierBackendName({ review_backend: "grok" } as any, cloudJob), "grok");
});

test("verifierBackendName: a misconfigured review_backend that is ITSELF cloud still resolves to a real local judge", () => {
  assert.equal(verifierBackendName({ review_backend: "cursor-cloud" } as any, cloudJob), "claude-code");
});

test("verifierBackendName: a local job's resolution is unchanged (legacy behavior)", () => {
  assert.equal(verifierBackendName(undefined, localJob), "claude-code");
  assert.equal(verifierBackendName({ review_backend: "grok" } as any, localJob), "grok");
});

// ── verify(): a cloud run with verify enabled finishes instead of throwing ─────────────────
//
// Not spawning the "no override" fallback (claude-code) here: whatever binary a real `claude`
// resolves to on the machine running this suite is exactly the kind of real-backend spawn CLAUDE.md
// #2 says never to do in a test (slow, environment-dependent, possibly network). The regression is
// already caught above at the layer that actually matters — verifierBackendName never returning
// "cursor-cloud" — and this test proves verify() genuinely completes end-to-end via a safe backend.

test("verify(): a cloud job with review_backend='mock' actually runs the judge and returns its verdict", async () => {
  const ws = workspaces.create({ slug: "verify-cloud-mock", name: "VerifyCloudMock", config_dir: "/tmp/verify-cloud-mock", review_backend: "mock" });
  const job = {
    backend: "cursor-cloud", workspace_id: ws.id, goal: "build the thing\n!verdict: {\"met\": true, \"reason\": \"looks done\"}",
    cwd: "/tmp", sandbox: "off", profile: "claude", add_dirs: null,
  } as unknown as Job;
  const verdict = await verify(job, "the agent's final result");
  assert.equal(verdict.met, true);
  assert.equal(verdict.reason, "looks done");
});
