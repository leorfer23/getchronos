/**
 * `mc report` (LEADS.md) — the structured hand-back that replaces a worker stopping and being scraped.
 *
 * Three things are worth a test each and all three are behaviour, not shape: the refusal when there
 * is no Lead to read it (an agent told to report must be told plainly why it can't), the card the
 * Desk draws from it, and the stop that must NOT follow it into the same digest.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, leadEvents, leadSlices, sessions, workspaces } from "./store.js";
import { fileReport, leadEventLines } from "./lead-report.js";
import { reportSupersedes, REPORT_SUPPRESS_MS, digestText } from "./robert-drive.js";
import { ReportSchema } from "./validation.js";
import { signalsOf } from "./term-status.js";

beforeEach(() => db.exec("DELETE FROM lead_events; DELETE FROM lead_slices; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM session_status;"));

let n = 0;
const mkWs = () => workspaces.create({ slug: `rep${++n}`, name: "Acme", config_dir: "/tmp/rep" + n });
const mkLead = (wsId: string) => sessions.create({ workspace_id: wsId, role: "lead", goal: "ship the rollback", cwd: "/tmp" });
const mkWorker = (wsId: string, leadId: string | null, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, role: "worker", goal: "open the PR", cwd: "/tmp", lead_id: leadId, ...over } as any);

// ─────────────────────────────── the schema's caps ───────────────────────────────

test("ReportSchema: a summary is required and capped, every other field is optional and capped", () => {
  assert.equal(ReportSchema.safeParse({ state: "done" }).success, false, "no summary");
  assert.equal(ReportSchema.safeParse({ state: "shipped", summary: "x" }).success, false, "not a state");
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "x".repeat(2001) }).success, false);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "x", tests: "y".repeat(1001) }).success, false);
  const ok = ReportSchema.safeParse({ state: "partial", summary: "half of it" });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success && ok.data, { state: "partial", summary: "half of it" });
});

test("ReportSchema: at most five PR URLs, and only http(s) — a --pr is a link the Lead clicks", () => {
  const five = Array.from({ length: 5 }, (_, i) => `https://github.com/o/r/pull/${i}`);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "s", prs: five }).success, true);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "s", prs: [...five, five[0]] }).success, false);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "s", prs: ["file:///etc/passwd"] }).success, false);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "s", prs: ["javascript:alert(1)"] }).success, false);
  assert.equal(ReportSchema.safeParse({ state: "done", summary: "s", prs: ["not a url"] }).success, false);
});

// ─────────────────────────────── filing one ───────────────────────────────

test("a terminal with no live Lead is refused with the two things that DO work here", () => {
  const ws = mkWs();
  const alone = mkWorker(ws.id, null);
  const out = fileReport(alone.id, { state: "done", summary: "done" });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.status, 409);
  assert.match(!out.ok ? out.error : "", /no live Lead/);
  assert.match(!out.ok ? out.error : "", /mc state.*mc ask-robert/);

  // …and the same once its Lead has ended: `lead_id` outlives the Lead, the inbox does not.
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  sessions.end(lead.id);
  assert.equal(fileReport(worker.id, { state: "done", summary: "done" }).ok, false);
});

test("the event carries every field the Lead triages by, and the worker's id8/goal", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id, { goal: "open the rollback PR" });
  const out = fileReport(worker.id, {
    state: "done",
    summary: "PR is open and green",
    prs: ["https://github.com/o/r/pull/214"],
    tests: "npm test — 412 pass, 0 fail",
    verified: "ran the rollback against a scratch DB",
    next: "someone has to merge it",
  });
  assert.equal(out.ok, true);
  const [ev] = leadEvents.recent(lead.id);
  assert.equal(ev.kind, "report");
  assert.equal(ev.key, null, "a report has no stop behind it to dedupe against");
  assert.equal(ev.session_id, worker.id);
  const p = JSON.parse(ev.payload!);
  assert.equal(p.id8, worker.id.slice(0, 8));
  assert.equal(p.goal, "open the rollback PR");
  assert.equal(p.state, "done");
  assert.deepEqual(p.prs, ["https://github.com/o/r/pull/214"]);
  assert.equal(p.tests, "npm test — 412 pass, 0 fail");
  assert.equal(p.question, null, "an unpassed field is null, not missing");
});

test("a report lands in the Lead it belongs to, and nowhere else", () => {
  const ws = mkWs();
  const a = mkLead(ws.id), b = mkLead(ws.id);
  const mine = mkWorker(ws.id, a.id);
  fileReport(mine.id, { state: "partial", summary: "halfway" });
  assert.equal(leadEvents.recent(a.id).length, 1);
  assert.equal(leadEvents.recent(b.id).length, 0);
});

test("`done` declares the card for review and `blocked` declares it blocked; `partial` declares nothing", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const a = mkWorker(ws.id, lead.id), b = mkWorker(ws.id, lead.id), c = mkWorker(ws.id, lead.id);

  fileReport(a.id, { state: "done", summary: "shipped it" });
  assert.equal(signalsOf(a.id).declared?.state, "review");
  assert.equal(signalsOf(a.id).declared?.label, "shipped it");

  fileReport(b.id, { state: "blocked", summary: "stuck", question: "which migration number?" });
  assert.equal(signalsOf(b.id).declared?.state, "blocked");
  assert.equal(signalsOf(b.id).declared?.label, "which migration number?", "the question is the card line");

  // A worker that is carrying on is still working — declaring anything here would freeze its card.
  fileReport(c.id, { state: "partial", summary: "three of five files" });
  assert.equal(signalsOf(c.id).declared, undefined);
});

// ─────────────────────── the stop behind it must not double up ───────────────────────

test("a fresh unacked report supersedes that worker's stop; a stale or acked one does not", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  assert.equal(reportSupersedes(lead.id, worker.id), false, "nothing filed yet");

  fileReport(worker.id, { state: "done", summary: "shipped it" });
  assert.equal(reportSupersedes(lead.id, worker.id), true);
  // Another worker's stop is untouched by it.
  const sibling = mkWorker(ws.id, lead.id);
  assert.equal(reportSupersedes(lead.id, sibling.id), false);

  // Past the window it is history, not the stop that is happening now.
  assert.equal(reportSupersedes(lead.id, worker.id, Date.now() + REPORT_SUPPRESS_MS + 1), false);

  // And once the Lead has steered that worker, its next stop is news again.
  leadEvents.ackForWorker(lead.id, worker.id);
  assert.equal(reportSupersedes(lead.id, worker.id), false);
});

test("the digest names a report by what it SAYS, an ask by its question, a stop by its goal", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id, { goal: "open the rollback PR" });
  fileReport(worker.id, { state: "blocked", summary: "flyway refuses the checksum", question: "rebaseline?" });
  const text = digestText(leadEvents.recent(lead.id));
  assert.match(text, /REPORT blocked — flyway refuses the checksum/);
  // "stopped" would be a lie about a worker that is waiting on this Lead for an answer.
  assert.match(text, /^1 of your workers need you: /);
  assert.match(text, /mc lead inbox/);
});

// ─────────────────────────────── the board moves itself ───────────────────────────────

test("a `done` from a linked worker moves its slice to review and takes the first PR", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  leadSlices.add(lead.id, "the rollback");
  leadSlices.patch(lead.id, 1, { session_id: worker.id, status: "doing" });

  const out = fileReport(worker.id, {
    state: "done", summary: "open", prs: ["https://github.com/o/r/pull/9", "https://github.com/o/r/pull/10"],
  });
  assert.equal(out.ok && out.slice, 1);
  const slice = leadSlices.get(lead.id, 1)!;
  assert.equal(slice.status, "review", "never `done` — that is the Lead's call, after it checks");
  assert.equal(slice.pr_url, "https://github.com/o/r/pull/9");
});

test("an unlinked worker, a `partial`, and an already-done slice leave the board alone", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const linked = mkWorker(ws.id, lead.id), loose = mkWorker(ws.id, lead.id);
  leadSlices.add(lead.id, "the rollback");
  leadSlices.patch(lead.id, 1, { session_id: linked.id, status: "doing" });

  assert.equal((fileReport(loose.id, { state: "done", summary: "x" }) as any).slice, null);
  assert.equal(leadSlices.get(lead.id, 1)!.status, "doing");
  assert.equal((fileReport(linked.id, { state: "partial", summary: "x" }) as any).slice, null);
  assert.equal(leadSlices.get(lead.id, 1)!.status, "doing");

  leadSlices.patch(lead.id, 1, { status: "done", pr_url: "https://github.com/o/r/pull/1" });
  assert.equal((fileReport(linked.id, { state: "done", summary: "x", prs: ["https://e.com/2"] }) as any).slice, null);
  const after = leadSlices.get(lead.id, 1)!;
  assert.equal(after.status, "done", "a worker cannot reopen what the Lead already signed off");
  assert.equal(after.pr_url, "https://github.com/o/r/pull/1");
});

// ─────────────────────────────── rendering (pure) ───────────────────────────────

test("a report renders as one headline plus a labelled, indented line per field", () => {
  const lines = leadEventLines({
    kind: "report",
    session_id: "abcdef0123456789",
    payload: JSON.stringify({
      id8: "abcdef01", goal: "open the rollback PR", state: "done", summary: "PR #214 is open and green",
      prs: ["https://github.com/o/r/pull/214"], tests: "npm test — 412 pass", verified: "ran it against a scratch DB",
      question: null, next: "someone has to merge it",
    }),
  });
  assert.deepEqual(lines, [
    "● abcdef01 REPORT done — open the rollback PR",
    "  PR #214 is open and green",
    "  PR: https://github.com/o/r/pull/214",
    "  tests: npm test — 412 pass",
    "  verified: ran it against a scratch DB",
    "  next: someone has to merge it",
  ]);
});

test("an ask renders with the question, its options and how to answer it", () => {
  const lines = leadEventLines({
    kind: "ask",
    session_id: "abcdef0123456789",
    payload: JSON.stringify({ id8: "abcdef01", goal: "the migration", ask_id8: "11112222", question: "rebaseline?", options: ["yes", "no"] }),
  });
  assert.deepEqual(lines, [
    "● abcdef01 ASK — the migration",
    "  rebaseline?",
    "  options: yes / no",
    '  answer it: mc answer 11112222 "..."',
  ]);
});

test("a stop still renders exactly as #396 printed it — headline, card line, what it said, indented", () => {
  const lines = leadEventLines({
    kind: "turn",
    session_id: "abcdef0123456789",
    payload: JSON.stringify({ id8: "abcdef01", goal: "the migration", card_line: "finished its turn", last_result: "one\ntwo" }),
  });
  assert.deepEqual(lines, ["● abcdef01 FINISHED — the migration", "  finished its turn", "    one", "    two"]);
  // A payload that was never written (or is corrupt) degrades to the ids rather than throwing.
  assert.deepEqual(leadEventLines({ kind: "ended", session_id: "abcdef0123456789", payload: "{nope" }), [
    "● abcdef01 ENDED — (no goal)",
  ]);
});

test("`mc` prints the daemon's rendering rather than composing its own", () => {
  const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
  assert.match(mc, /for \(const e of events\) console\.log\(e\.lines\.join\("\\n"\)\);/);
});
