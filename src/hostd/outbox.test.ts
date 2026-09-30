/**
 * The outbox (outbox.ts): which `mc` writes may wait for the brain, that they wait on disk in order
 * (across a host restart too), that the caps drop the oldest, and how a replay treats each answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Outbox, queueable } from "./outbox.js";
import type { ApiRequest, ApiResponse } from "./link.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-outbox-")), "outbox");
const quiet = { log: () => {} };
const req = (p: string, n = 0): ApiRequest => ({
  session_id: "s1", method: "POST", path: p,
  headers: { "x-mc-session": "s1", "x-mc-workspace-token": "wstok", "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ n })).toString("base64"),
});
const ok = (status = 200): ApiResponse => ({ status, headers: {}, body: null });

test("allowlist: status-type writes queue; asks, heavy slots, reads and everything else do not", () => {
  for (const p of [
    "/api/sessions/abc/hook", "/api/sessions/abc/status", "/api/sessions/abc/progress", "/api/agents/r1/report",
    "/api/runs/r1/steps/2", "/api/workspaces/w1/learn", "/api/workspaces/w1/remember", "/api/workspaces/w1/jots",
    "/api/jots/j1/append", "/api/sessions/abc/status?x=1",
  ]) assert.equal(queueable("POST", p), true, p);
  for (const [m, p] of [
    ["POST", "/api/asks"], ["GET", "/api/asks/a1/wait"], ["POST", "/api/machine/slots"], ["POST", "/api/usage/report"],
    ["GET", "/api/sessions/abc/status"], ["PATCH", "/api/sessions/abc"], ["POST", "/api/sessions"], ["POST", "/api/tickets"],
    ["DELETE", "/api/jots/j1"], ["POST", "/api/jots/j1/resolve"], ["POST", "/api/sessions/abc/hook/x"], ["POST", "/sessions/abc/status"],
  ]) assert.equal(queueable(m, p), false, `${m} ${p}`);
});

test("entries persist in FIFO order, 0600, and a new Outbox on the same dir picks them up", async () => {
  const dir = tmp();
  const a = new Outbox(dir, quiet);
  for (let i = 0; i < 3; i++) a.put(req("/api/sessions/s1/status", i));
  assert.equal(a.size, 3);
  for (const f of fs.readdirSync(dir)) assert.equal((fs.statSync(path.join(dir, f)).mode & 0o777).toString(8), "600");
  fs.writeFileSync(path.join(dir, "0000000000000009.json.tmp"), "{half");
  const b = new Outbox(dir, quiet); // a host restart
  assert.equal(b.size, 3);
  assert.equal(fs.existsSync(path.join(dir, "0000000000000009.json.tmp")), false, "a half-written entry is not owed");
  b.put(req("/api/sessions/s1/status", 3));
  const seen: ApiRequest[] = [];
  const r = await b.drain(async (q) => { seen.push(q); return ok(); });
  assert.deepEqual(r, { sent: 4, dropped: 0, left: 0 });
  assert.deepEqual(seen.map((q) => JSON.parse(Buffer.from(q.body!, "base64").toString()).n), [0, 1, 2, 3]);
  assert.equal(seen[0].headers["x-mc-workspace-token"], "wstok", "identity headers go back as they came");
  assert.equal(seen[0].session_id, "s1");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("over the count or byte cap, the oldest are dropped (and logged)", () => {
  const lines: string[] = [];
  const o = new Outbox(tmp(), { maxItems: 3, log: (s) => lines.push(s) });
  for (let i = 0; i < 5; i++) o.put(req("/api/sessions/s1/status", i));
  assert.equal(o.size, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /dropped the 1 oldest/);
  const small = new Outbox(tmp(), { maxBytes: 600, ...quiet });
  const one = Buffer.byteLength(JSON.stringify({ ...req("/api/sessions/s1/status"), at: Date.now() }));
  for (let i = 0; i < 5; i++) small.put(req("/api/sessions/s1/status", i));
  assert.equal(small.size, Math.floor(600 / one));
  assert.ok(small.bytes <= 600);
  assert.equal(new Outbox(tmp(), { maxBytes: 10, ...quiet }).put(req("/api/sessions/s1/status")), false, "one entry over the cap alone is refused");
});

test("replay: 4xx drops the entry, 503 stops and keeps it, a persistent 5xx is dropped after a few tries", async () => {
  const o = new Outbox(tmp(), { maxServerErrors: 2, ...quiet });
  for (let i = 0; i < 4; i++) o.put(req("/api/sessions/s1/status", i));
  const answers = [404, 503];
  const seen: number[] = [];
  const send = async (q: ApiRequest) => { seen.push(JSON.parse(Buffer.from(q.body!, "base64").toString()).n); return ok(answers.shift() ?? 200); };
  assert.deepEqual(await o.drain(send), { sent: 0, dropped: 1, left: 3 });
  assert.deepEqual(seen, [0, 1], "stopped at the 503 without skipping it");
  answers.push(500);
  assert.deepEqual(await o.drain(send), { sent: 0, dropped: 0, left: 3 }, "one 500: kept for next time");
  answers.push(500);
  assert.deepEqual(await o.drain(send), { sent: 2, dropped: 1, left: 0 }, "second 500: dropped, the rest go");
  assert.deepEqual(seen, [0, 1, 1, 1, 2, 3]);
});

test("a thrown send stops the replay; concurrent drains share one pass", async () => {
  const o = new Outbox(tmp(), quiet);
  o.put(req("/api/sessions/s1/progress"));
  assert.deepEqual(await o.drain(async () => { throw new Error("socket gone"); }), { sent: 0, dropped: 0, left: 1 });
  let calls = 0;
  const send = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return ok(); };
  const [a, b] = await Promise.all([o.drain(send), o.drain(send)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
