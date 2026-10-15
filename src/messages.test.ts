import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jobs, messages, runs, tickets, workspaces } from "./store.js";
import { deliverPending, sendMessage } from "./messages.js";
import { messagesNote } from "./runner.js";

beforeEach(() => {
  db.exec("DELETE FROM run_messages; DELETE FROM run_steps; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

let n = 0;
function mkWs() {
  return workspaces.create({ slug: "msg-" + n++ + "-" + Math.random().toString(36).slice(2), name: "MsgWS", config_dir: "/tmp/msg-" + n });
}
function mkTicket(wsId: string) {
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key: "MSG-" + n++, slug: "msg-" + n, title: "t",
    status: "in_progress", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/msg.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
}
function mkRun(over: { workspace_id?: string; ticket_id?: string | null } = {}) {
  const job = jobs.create({ name: "ticket:MSG-" + n++, goal: "g", workspace_id: over.workspace_id, ticket_id: over.ticket_id ?? null });
  return runs.create(job.id, "manual");
}

// ── store ─────────────────────────────────────────────────────────────────

test("messages.create rejects a message with neither ticket_id nor run_id", () => {
  assert.throws(() => messages.create({ text: "hi", from_who: "human" }), /ticket_id or run_id/);
});

test("undeliveredFor matches run-scoped and ticket-scoped rows, oldest first", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  const run = mkRun({ workspace_id: ws.id, ticket_id: t.id });
  const a = messages.create({ run_id: run.id, text: "run-scoped", from_who: "human" });
  const b = messages.create({ ticket_id: t.id, text: "ticket-scoped", from_who: "robert" });
  const other = mkRun({ workspace_id: ws.id }); // unrelated run/ticket — must not show up
  messages.create({ run_id: other.id, text: "not for you", from_who: "human" });

  const pending = messages.undeliveredFor(run.id, t.id);
  assert.deepEqual(pending.map((m) => m.id), [a.id, b.id]);
});

test("markDelivered is idempotent — a second call doesn't clobber the first delivered_to_run", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  const m = messages.create({ ticket_id: t.id, text: "hi", from_who: "human" });
  messages.markDelivered([m.id], "run-a");
  messages.markDelivered([m.id], "run-b"); // must not overwrite
  const row = messages.get(m.id)!;
  assert.equal(row.delivered_to_run, "run-a");
  assert.ok(row.delivered_at);
});

// ── deliverPending ───────────────────────────────────────────────────────

test("deliverPending marks and returns oldest-first; a second call returns empty", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  const run = mkRun({ workspace_id: ws.id, ticket_id: t.id });
  messages.create({ ticket_id: t.id, text: "first", from_who: "human" });
  messages.create({ ticket_id: t.id, text: "second", from_who: "robert" });

  const first = deliverPending(run.id);
  assert.deepEqual(first.map((m) => m.text), ["first", "second"]);

  const second = deliverPending(run.id);
  assert.deepEqual(second, []);
});

// ── sendMessage ──────────────────────────────────────────────────────────

test("sendMessage resolves a ticket key (case-insensitive) and stores it ticket-scoped", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  const out = sendMessage(t.key.toLowerCase(), "prioritize the 500 fix", "leo");
  assert.ok(out.ok);
  assert.equal(out.resolved.kind, "ticket");
  assert.equal(out.message.ticket_id, t.id);
  assert.equal(out.message.run_id, null);
});

test("sendMessage resolves a run by id8 and stores both run_id and the run's ticket_id", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  const run = mkRun({ workspace_id: ws.id, ticket_id: t.id });
  const out = sendMessage(run.id.slice(0, 8), "switch branches", "leo");
  assert.ok(out.ok);
  assert.equal(out.resolved.kind, "run");
  assert.equal(out.message.run_id, run.id);
  assert.equal(out.message.ticket_id, t.id);
});

test("sendMessage rejects an unresolvable target", () => {
  const out = sendMessage("NOPE-999", "hi", "leo");
  assert.equal(out.ok, false);
});

// ── messagesNote (spawn-time injection formatter) ───────────────────────

test("messagesNote is empty for no rows, and formats one line per message otherwise", () => {
  assert.equal(messagesNote([]), "");
  const text = messagesNote([{ text: "prioritize the 500 fix", from_who: "leo", created_at: "2026-07-30T12:00:00Z" }]);
  assert.match(text, /^## Operator messages \(delivered at spawn\)/);
  assert.match(text, /- \[2026-07-30T12:00:00Z\] leo: prioritize the 500 fix/);
  assert.match(text, /directives from the operator/);
});

test("spawn-injection seam: ticket-scoped undelivered messages get marked delivered via deliverPending", () => {
  const ws = mkWs();
  const t = mkTicket(ws.id);
  messages.create({ ticket_id: t.id, text: "directive", from_who: "leo" });
  const freshRun = mkRun({ workspace_id: ws.id, ticket_id: t.id });
  // execute()'s real seam reads messages.undeliveredFor(null, ticket_id) directly (no run yet at
  // read time) — exercise that same store call + the delivery mark, same effect runner.ts produces.
  const pending = messages.undeliveredFor(null, t.id);
  assert.equal(pending.length, 1);
  messages.markDelivered(pending.map((m) => m.id), freshRun.id);
  assert.deepEqual(messages.undeliveredFor(null, t.id), []);
  assert.deepEqual(deliverPending(freshRun.id), []); // already delivered, nothing left to piggyback
});
