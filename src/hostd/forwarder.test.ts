/**
 * The forwarder while the brain is away (HOSTS.md → Reconnect and restarts): status writes are
 * queued and answered 202, asks and everything else get a 503 the agent can read, `mc heavy` is
 * granted from this host's own pool, and a link that is up forwards exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startForwarder } from "./forwarder.js";
import { HostLink, unreachable, type ApiRequest, type ApiResponse, type LinkState } from "./link.js";
import { Outbox } from "./outbox.js";
import { HeavyPool } from "../machine.js";

type Fake = { state: LinkState; calls: ApiRequest[]; answer: (q: ApiRequest) => ApiResponse; api: (q: ApiRequest) => Promise<ApiResponse> };
const fakeLink = (state: LinkState): Fake => {
  const f: Fake = {
    state, calls: [],
    answer: () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"word":"working"}') }),
    // What HostLink.api does when down: answer `unreachable` without sending anything.
    api: async (q) => (f.state === "online" ? (f.calls.push(q), f.answer(q)) : unreachable(q.path)),
  };
  return f;
};

async function call(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(data ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { let json: any = s; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode ?? 0, json, headers: res.headers }); });
    });
    r.on("error", reject);
    r.end(data ?? undefined);
  });
}

async function withForwarder(link: Fake, fn: (port: number, o: { outbox: Outbox; heavy: HeavyPool }) => Promise<void>, slots = 1) {
  const outbox = new Outbox(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-fwd-")), "outbox"), { log: () => {} });
  const heavy = new HeavyPool("this-host", () => slots);
  const srv = await startForwarder(link, { port: 0, outbox, heavy, slotWaitMs: 0 });
  try {
    await fn((srv.address() as { port: number }).port, { outbox, heavy });
  } finally {
    srv.close();
  }
}

const H = { "x-mc-session": "s1", "x-mc-workspace-token": "wstok" };

test("offline: a status write is queued on disk and answered 202, then replayed with its identity on reconnect", async () => {
  const link = fakeLink("offline");
  await withForwarder(link, async (port, { outbox }) => {
    const r = await call(port, "POST", "/api/sessions/s1/status", { state: "working" }, H);
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { queued: true, note: "brain unreachable; will deliver on reconnect" });
    await call(port, "POST", "/api/sessions/s1/status", { state: "done" }, H);
    assert.equal(outbox.size, 2);
    assert.equal(link.calls.length, 0);
    // Online again, but the replay has not run yet: a fresh write queues BEHIND the old ones, or a
    // stale `working` would land after it.
    link.state = "online";
    const mid = await call(port, "POST", "/api/sessions/s1/progress", { n: 1, of: 2 }, H);
    assert.equal(mid.status, 202);
    assert.equal(mid.json.note, "delivering after earlier queued writes");
    await outbox.drain((q) => link.api(q));
    assert.deepEqual(link.calls.map((q) => [q.method, q.path, JSON.parse(Buffer.from(q.body!, "base64").toString()).state ?? "progress"]), [
      ["POST", "/api/sessions/s1/status", "working"], ["POST", "/api/sessions/s1/status", "done"], ["POST", "/api/sessions/s1/progress", "progress"],
    ]);
    assert.equal(link.calls[0].session_id, "s1");
    assert.equal(link.calls[0].headers["x-mc-workspace-token"], "wstok");
    // Drained: the next write goes straight through, answered by the brain.
    const now = await call(port, "POST", "/api/sessions/s1/status", { state: "idle" }, H);
    assert.equal(now.status, 200);
    assert.equal(now.json.word, "working");
  });
});

test("offline: an ask is not queued — 503 with words the agent can act on and a retry hint", async () => {
  await withForwarder(fakeLink("offline"), async (port, { outbox }) => {
    const r = await call(port, "POST", "/api/asks", { question: "ship it?" }, H);
    assert.equal(r.status, 503);
    assert.match(r.json.error, /operator can't see asks right now; continue if you can, or retry later/);
    assert.equal(r.json.retry_after_s, 60);
    assert.equal(r.headers["retry-after"], "60");
    const g = await call(port, "GET", "/api/tickets", undefined, H);
    assert.equal(g.status, 503);
    assert.match(g.json.error, /^brain unreachable from this host — continue if you can/);
    assert.equal(outbox.size, 0);
  });
});

test("HostLink.api answers `unreachable` when the link is not up", async () => {
  const link = new HostLink({ brains: [], hostId: "h", token: "t", fp: null, hello: async () => ({}) as any, vitals: async () => ({}) as any });
  const r = await link.api({ session_id: null, method: "POST", path: "/api/asks/a1/answer", headers: {}, body: null });
  assert.equal(r.status, 503);
  assert.match(JSON.parse(r.body!.toString()).error, /can't see asks/);
});

test("offline: mc heavy is granted from the host's own pool, heartbeats and releases locally", async () => {
  const link = fakeLink("offline");
  await withForwarder(link, async (port, { heavy }) => {
    const a = await call(port, "POST", "/api/machine/slots", { session_id: "s1", label: "npm test" }, H);
    assert.equal(a.status, 200);
    assert.equal(a.json.granted, true);
    assert.equal(a.json.local, true);
    assert.equal(a.json.slots, 1);
    const b = await call(port, "POST", "/api/machine/slots", { session_id: "s2", label: "tsc -b" }, H);
    assert.equal(b.json.granted, false, "the pool is full: the second waits its turn");
    assert.equal(typeof b.json.ticket, "string");
    // The brain comes back: the local slot stays local until it is given back.
    link.state = "online";
    assert.deepEqual((await call(port, "PUT", `/api/machine/slots/${a.json.slot_id}`)).json, { ok: true });
    assert.deepEqual((await call(port, "DELETE", `/api/machine/slots/${a.json.slot_id}`)).json, { released: true });
    assert.equal(heavy.holders().length, 0);
    assert.equal(link.calls.length, 0, "none of that reached the brain");
    // A new acquire, and a slot id this host does not hold, go to the brain as always.
    await call(port, "POST", "/api/machine/slots", { session_id: "s1", label: "npm test" }, H);
    await call(port, "PUT", "/api/machine/slots/brain-slot");
    assert.deepEqual(link.calls.map((q) => [q.method, q.path]), [["POST", "/api/machine/slots"], ["PUT", "/api/machine/slots/brain-slot"]]);
  });
});

test("a link that drops while mc heavy is parked on the brain falls back to the local pool", async () => {
  const link = fakeLink("online");
  link.answer = () => { link.state = "offline"; return unreachable("/api/machine/slots"); };
  await withForwarder(link, async (port) => {
    const r = await call(port, "POST", "/api/machine/slots", { label: "npm test" }, H);
    assert.equal(r.status, 200);
    assert.equal(r.json.granted, true);
    assert.equal(r.json.local, true);
  });
});

test("online with an empty outbox, the forwarder is a plain pipe", async () => {
  const link = fakeLink("online");
  await withForwarder(link, async (port, { outbox }) => {
    const r = await call(port, "POST", "/api/sessions/s1/hook", { event: "stop" }, H);
    assert.equal(r.status, 200);
    assert.equal(outbox.size, 0);
    assert.equal(link.calls.length, 1);
  });
});
