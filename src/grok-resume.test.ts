import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokSessionsDir, resolveGrokResumeId } from "./grok-resume.js";

function writeSummary(cwd: string, id: string, createdAt: string, kind?: string) {
  const dir = path.join(grokSessionsDir(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ created_at: createdAt, session_kind: kind ?? null, session_summary: "t" }),
  );
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), "");
}

test("resolveGrokResumeId: pinned Chronos id wins", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resume-pin-"));
  const chronosId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  writeSummary(cwd, chronosId, "2026-09-18T12:00:00.000Z");
  writeSummary(cwd, "01a0b60e-dde7-7382-9ad8-df1f44442f17", "2026-09-18T12:00:01.000Z");
  assert.equal(
    resolveGrokResumeId({ cwd, sessionId: chronosId, createdAt: "2026-09-18T12:00:00.000Z" }),
    chronosId,
  );
});

test("resolveGrokResumeId: legacy unpinned maps by created_at", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resume-legacy-"));
  const chronosId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const grokId = "01a0b60e-dde7-7382-9ad8-df1f44442f17";
  writeSummary(cwd, grokId, "2026-09-18T19:47:02.778Z");
  writeSummary(cwd, "01a0b605-73b0-78b2-9a7c-856bc63f6a18", "2026-09-18T18:00:00.000Z");
  assert.equal(
    resolveGrokResumeId({ cwd, sessionId: chronosId, createdAt: "2026-09-18T19:47:00.198Z" }),
    grokId,
  );
});

test("resolveGrokResumeId: simultaneous Desk rows pair 1:1 without colliding", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resume-cohort-"));
  const a = { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-09-18T18:54:22.476Z" };
  const b = { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-09-18T18:54:22.680Z" };
  const c = { id: "33333333-3333-4333-8333-333333333333", createdAt: "2026-09-18T18:54:22.804Z" };
  const g1 = "01a0b5de-a756-7701-af95-4e45ad7a3d6c";
  const g2 = "01a0b5de-a758-76c2-b329-69197dc9bf8c";
  const g3 = "01a0b5de-a792-7463-b78a-0a04380c1e70";
  writeSummary(cwd, g1, "2026-09-18T18:54:23.083Z");
  writeSummary(cwd, g2, "2026-09-18T18:54:23.087Z");
  writeSummary(cwd, g3, "2026-09-18T18:54:23.145Z");
  // subagent noise near the same second must not steal a seat
  writeSummary(cwd, "01a0b5df-a9a9-7e23-95bb-ed665d7e58ec", "2026-09-18T18:54:23.100Z", "subagent");

  const ra = resolveGrokResumeId({ cwd, sessionId: a.id, createdAt: a.createdAt, siblings: [b, c] });
  const rb = resolveGrokResumeId({ cwd, sessionId: b.id, createdAt: b.createdAt, siblings: [a, c] });
  const rc = resolveGrokResumeId({ cwd, sessionId: c.id, createdAt: c.createdAt, siblings: [a, b] });
  assert.deepEqual([ra, rb, rc].sort(), [g1, g2, g3].sort());
  assert.equal(new Set([ra, rb, rc]).size, 3, "each Desk row gets a distinct grok chat");
});

test("resolveGrokResumeId: no on-disk match returns the Chronos id", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "grok-resume-miss-"));
  const chronosId = "cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee";
  assert.equal(
    resolveGrokResumeId({ cwd, sessionId: chronosId, createdAt: "2026-09-18T12:00:00.000Z" }),
    chronosId,
  );
});
