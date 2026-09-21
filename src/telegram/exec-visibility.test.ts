import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BusEvent } from "../bus.js";

// CONFIG snapshots env at import, so point it at the fake CLI before pulling agent.ts in.
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.CHRONOS_CLAUDE_BIN = path.join(HERE, "fake-claude.mjs");

const { WarmManager, execDeltas, queuedNotice } = await import("./agent.js");
const { bus } = await import("../bus.js");

const collect = (fn: () => void): Extract<BusEvent, { topic: "agent.delta" }>[] => {
  const out: any[] = [];
  const on = (e: BusEvent) => { if (e.topic === "agent.delta") out.push(e); };
  bus.on("event", on);
  try { fn(); } finally { bus.off("event", on); }
  return out;
};

// The bug this covers: one warm process per executive serves chat, board wakes, heartbeats and the
// mail sweep, but ONLY the chat route published deltas. A board wake could hold Ada for 15 minutes
// of browser work while the operator's chat showed a bare "Ada is thinking…" and the bus stayed silent.
test("a background turn publishes its activity on the executive's chat thread", () => {
  const emit = execDeltas("ada");
  const events = collect(() => {
    emit("browse pickitfood.com", "tool");
    emit("", "tool_done");
  });
  assert.deepEqual(events.map((e) => [e.ws, e.kind, e.text]), [
    ["agent:ada", "tool", "browse pickitfood.com"],
    ["agent:ada", "tool_done", ""],
  ]);
});

// A board reply belongs to the board. Streaming its prose into the operator's pending chat bubble would put
// an answer he never asked for above the reply he is waiting for.
test("only the chat surface streams reply text; background turns keep their prose", () => {
  const background = collect(() => execDeltas("ada")("hola amor", "text"));
  assert.deepEqual(background, [], "a background turn must not stream text");

  const chat = collect(() => execDeltas("ada", { stream: true })("hola amor", "text"));
  assert.deepEqual(chat.map((e) => [e.ws, e.kind, e.text]), [["agent:ada", "text", "hola amor"]]);
});

test("the queued notice names the turn in the way and how long it has run", () => {
  const line = queuedNotice({ label: "a board thread", at: Date.now() - 15 * 60_000 });
  assert.equal(line, "queued behind a board thread (running 15m)");
});

// busyWith is what makes that notice possible: turns are serialized through one process, so a caller
// has to be able to see what is ahead of it without reaching into the manager's internals.
test("an in-flight turn is visible to whoever queues behind it, and clears when it settles", async () => {
  const m = new WarmManager({ system: "test", model: "sonnet", turnTimeoutMs: 5_000, maxTurns: 30 });
  assert.equal(m.busyWith(), null, "an idle manager is not busy");

  const first = m.turn("hello", undefined, "a board thread");
  await new Promise((r) => setTimeout(r, 40)); // spawned and written, fake CLI answers at 120ms
  const busy = m.busyWith();
  assert.equal(busy?.label, "a board thread");
  assert.ok(busy!.at <= Date.now() && Date.now() - busy!.at < 5_000, "started just now");

  await first;
  assert.equal(m.busyWith(), null, "a settled turn leaves the manager free");
  m.kill();
});

// A turn that dies must not leave the manager looking permanently occupied — the next caller would
// be told it is "queued behind" a turn that no longer exists.
test("an aborted turn does not leave the manager looking busy forever", async () => {
  const m = new WarmManager({ system: "test", model: "sonnet", turnTimeoutMs: 5_000, maxTurns: 30 });
  const aborted = m.turn("first", undefined, "the operator's chat").catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 30));
  m.kill();
  assert.ok((await aborted) instanceof Error);
  assert.equal(m.busyWith(), null);
});
