/**
 * Reconcile after a host says hello (HOSTS.md → Reconnect and restarts), with a stub link: no socket,
 * no host process. What is asserted is the brain's decision per row and per reported channel.
 *
 * Every module is imported dynamically after CHRONOS_CLAUDE_BIN points at `true`, so the exit digest
 * a closing terminal fires never boots a real CLI (CLAUDE.md gotcha 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const { sessions } = await import("./store.js");
const { registerHost } = await import("./hosts/index.js");
const { RemoteHost } = await import("./hosts/remote.js");
const { mirrorFile } = await import("./hosts/transcript-mirror.js");
const { reconcileHost, resolveHostRef, sessionHostOffline } = await import("./remote-terminals.js");
const { isLive, focusEvents, sessionActivity } = await import("./terminal.js");
const { PROTOCOL_VERSION } = await import("./hostlink/wire.js");

const sent: any[] = [];
let online = true;
const port = {
  isOnline: () => online,
  sendControl: (_h: string, f: any) => { sent.push(f); return true; },
  request: async () => { throw new Error("no requests in this test"); },
};
const HOST = "h_reconcile";
const host = new RemoteHost(HOST, port);
registerHost(host);
const hello = (live: any[]) => ({
  proto: PROTOCOL_VERSION, version: "0.1.0", host_id: HOST, name: "m2", platform: "darwin", arch: "arm64",
  capabilities: { clis: [], node: process.version, sandbox: true }, profiles: [], checkouts: [], deny: [], live,
});
const row = (cwd: string) => sessions.create({ backend: "mock", cwd, host_id: HOST });

test("reconcile: adopt after a brain restart, re-attach after a blip, end + sticky revive when lost, stop orphans", async () => {
  const kept = row("/Users/a.smith/work");      // still running on the host, unknown to this brain's memory
  const lost = row("/Users/a.smith/gone");       // the host no longer has it (host restarted)
  const closed = row("/Users/a.smith/closed");   // closed from the Desk while the host was away
  sessions.end(closed.id);
  const local = sessions.create({ backend: "mock", cwd: "/tmp" }); // a local row is none of this's business

  host.setOnline(hello([
    { ch: 7, session_id: kept.id, kind: "pty", pid: 4242, last_seq: 3 },
    { ch: 9, session_id: closed.id, kind: "pty", pid: 4243, last_seq: 1 },
    { ch: 11, session_id: "not-a-session-here", kind: "pty", pid: 1, last_seq: 0 },
  ]));
  sent.length = 0;
  const revived: string[] = [];
  const r = await reconcileHost(host, { revive: async (s) => { revived.push(s.id); } });

  assert.deepEqual(r.adopted, [kept.id]);
  assert.ok(isLive(kept.id), "the surviving terminal is back on the wall");
  assert.equal(sessionActivity(kept.id).live, true);
  assert.deepEqual(sent.filter((f) => f.t === "attach"), [{ t: "attach", ch: 7, session_id: kept.id, seq: 0, transcript_offset: 0 }], "…and the host is asked to resend everything it holds");

  assert.deepEqual(r.lost, [lost.id]);
  assert.equal(sessions.get(lost.id)!.status, "ended");
  assert.deepEqual(revived, [lost.id], "resumable → reopened (openSession reads the host from the row: sticky)");

  assert.deepEqual(r.orphans, [9]);
  assert.deepEqual(sent.filter((f) => f.ch === 9).map((f) => f.t), ["kill", "release"], "ended here → stopped there");
  assert.equal(sent.some((f) => f.ch === 11), false, "a session this brain never had is left alone");
  assert.equal(sessions.get(local.id)!.status, "live", "local rows untouched");

  // A link blip: the same channel reported again while the brain still holds it → re-attach from our seq.
  host.data({ ch: 7, seq: 1, bytes: Buffer.from("one ") });
  host.data({ ch: 7, seq: 2, bytes: Buffer.from("two ") });
  sent.length = 0;
  const again = await reconcileHost(host);
  assert.deepEqual(again.reattached, [kept.id]);
  assert.deepEqual(sent.find((f) => f.t === "attach"), { t: "attach", ch: 7, session_id: kept.id, seq: 2, transcript_offset: 0 });

  // Transcript deltas land in the mirror by offset: an overlapping resend is trimmed, not doubled.
  const rec = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
  host.control({ t: "transcript", ch: 7, delta: rec("Understanding: fix it"), offset: 0 });
  const first = fs.readFileSync(mirrorFile(kept.id), "utf8");
  host.control({ t: "transcript", ch: 7, delta: first + rec("Result: done"), offset: 0 });
  assert.equal(fs.readFileSync(mirrorFile(kept.id), "utf8"), first + rec("Result: done"));

  // Offline is a flag, not an ending.
  online = false;
  host.setOffline();
  assert.equal(sessionHostOffline(sessions.get(kept.id)!), true);
  assert.equal(sessions.get(kept.id)!.status, "live");
  online = true;
  host.setOnline(hello([{ ch: 7, session_id: kept.id, kind: "pty", pid: 4242, last_seq: 2 }]));
  assert.equal(sessionHostOffline(sessions.get(kept.id)!), false);
  assert.equal(resolveHostRef("m2"), HOST);
  assert.equal(resolveHostRef(HOST), HOST);
  assert.equal(resolveHostRef("m9"), null);

  // The exit frame runs the ordinary close-out, and only then is the host told to forget the channel.
  sent.length = 0;
  host.control({ t: "exit", ch: 7, code: 0, signal: null });
  assert.equal(isLive(kept.id), false);
  assert.equal(sessions.get(kept.id)!.status, "ended");
  assert.deepEqual(sent, [{ t: "ack", ch: 7, seq: 2 }, { t: "release", ch: 7 }], "last ack, then release");
  // The story of a remote terminal survives it: read back from the mirror.
  assert.deepEqual(focusEvents(kept.id).map((e) => e.kind), ["understanding", "result"]);
});

test("RemoteHost: a frame that beats its spawn reply is held for the channel, and a resend is dropped once", async () => {
  const h2 = new RemoteHost("h_early", { ...port, request: async () => ({ ch: 3, pid: 99, cols: 80, rows: 24, cwd: "/Users/x" }) });
  h2.setOnline({ ...hello([]), host_id: "h_early" });
  h2.data({ ch: 3, seq: 1, bytes: Buffer.from("early ") });
  const spec = { kind: "intent", session_id: "s-early", cols: 80, rows: 24 } as any;
  const t = await h2.spawnPty(spec);
  assert.equal(t.cwd, "/Users/x");
  let got = "";
  t.onData((d) => { got += d; });
  h2.data({ ch: 3, seq: 2, bytes: Buffer.from("late") });
  h2.data({ ch: 3, seq: 2, bytes: Buffer.from("late") }); // resend overlap after a reconnect
  h2.data({ ch: 3, seq: 1, bytes: Buffer.from("early ") });
  assert.equal(got, "early late");
  await assert.rejects(h2.spawnPty({ id: "x", cmd: "sh", args: [], cwd: "/", env: {}, cols: 1, rows: 1 }), /takes a SpawnSpec/);
  assert.throws(() => h2.signal(), /through its channel/);
});
