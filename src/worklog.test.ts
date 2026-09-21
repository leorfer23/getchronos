import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation as briefs.test.ts: the ledger and the brief are real notes on disk (notes resolve
// <repo>/notes/<ws>/<slug>.md at module load), so point CHRONOS_HOME at a temp dir before importing.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-worklog-"));

const { db, workspaces, notes: notesStore, sessions, jobs, runs } = await import("./store.js");
const { BRIEF_SEED, briefNote, briefsBlock, mergeNext, mergeRecently, briefPromptBody, rewriteBrief } = await import("./briefs.js");
const {
  WORKLOG_SLUG, entryBlock, parseEntry, parseWorklog, readWorklog, writeEntry,
  recordSession, recordRun, shouldLogRun, shouldLogSession, summarizeWork, worklogNote, logged,
  sinceIso, backfill,
} = await import("./worklog.js");

let acme = "";
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM kv; DELETE FROM sessions; DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces;");
  acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/mc-test/acme" }).id;
});

const ledger = () => notesStore.bySlug(acme, WORKLOG_SLUG)?.body ?? "";
const brief = () => briefNote(acme, false)?.body ?? "";
/** A finished terminal that did something: a goal, turns on the clock, and a frozen ledger. */
const endedSession = (goal: string) => {
  const s = sessions.create({ workspace_id: acme, cwd: "/tmp", goal, backend: "mock" });
  sessions.setLedger(s.id, { turns: 4, cost_usd: 0.12 });
  sessions.end(s.id);
  return sessions.get(s.id)!;
};
// Every test that reaches the summarizer hands it a stub — a real model call in the suite is a
// CLAUDE.md gotcha (#2), and the point here is the plumbing, not the prose.
const stub = (json: unknown) => async () => JSON.stringify(json);

// ───────────────────────────── entry shape ─────────────────────────────

test("an entry needs what + outcome; lists, PR and ticket are validated, junk is dropped", () => {
  assert.equal(parseEntry({ outcome: "shipped" }), null, "no what → no entry");
  assert.equal(parseEntry({ what: "the export" }), null, "no outcome → no entry");
  assert.equal(parseEntry("not json at all"), null);

  const e = parseEntry(`prose before {"what":"the tray export","outcome":"shipped it","pending":["docs",""],` +
    `"next":["add a test","x"],"pr":"https://github.com/a/b/pull/3","ticket":"acme-12"}`);
  assert.ok(e);
  assert.equal(e.what, "the tray export");
  assert.deepEqual(e.pending, ["docs"], "empty + too-short items are dropped");
  assert.deepEqual(e.next, ["add a test"]);
  assert.equal(e.pr, "https://github.com/a/b/pull/3");
  assert.equal(e.ticket, "ACME-12");

  const bad = parseEntry({ what: "a\nb", outcome: "c", pr: "not-a-url", ticket: "nope" });
  assert.equal(bad?.what, "a b", "newlines are folded — an entry is one line");
  assert.equal(bad?.pr, null);
  assert.equal(bad?.ticket, null);
});

test("the ledger block round-trips through the parser, newest first", () => {
  const e = { what: "the tray export", outcome: "shipped it", pending: ["docs"], next: ["add a test"], pr: "https://x/pull/1", ticket: "ACME-12" };
  const block = entryBlock(e, "2026-09-12 09:30");
  assert.match(block, /^### 2026-09-12 09:30 · the tray export · shipped it · PR https:\/\/x\/pull\/1 · ACME-12$/m);
  assert.match(block, /^- pending: docs$/m);
  assert.match(block, /^- next: add a test$/m);

  const rows = parseWorklog(`${block}\n${entryBlock({ ...e, what: "later work", pending: [], next: [] }, "2026-09-12 11:00")}`);
  assert.deepEqual(rows.map((r) => r.at), ["2026-09-12 11:00", "2026-09-12 09:30"], "newest first");
  assert.deepEqual(rows[1].pending, ["docs"]);
  assert.equal(rows[1].pr, "https://x/pull/1");
  assert.equal(rows[1].ticket, "ACME-12");
});

// ───────────────────────────── the two writes ─────────────────────────────

test("one entry writes the ledger block and one Recently line + the leftovers as Next items", () => {
  writeEntry(acme, { what: "the tray export", outcome: "shipped it", pending: ["docs are stale"], next: ["add a regression test"], ticket: "ACME-12" });
  assert.equal(worklogNote(acme, false)?.title, "Worklog");
  assert.match(ledger(), /### \d{4}-\d{2}-\d{2} \d{2}:\d{2} · the tray export · shipped it · ACME-12/);
  assert.match(ledger(), /- pending: docs are stale/);

  const b = brief();
  assert.match(b, /## Recently\n- \d{4}-\d{2}-\d{2} · the tray export · shipped it/);
  assert.match(b, /## Next\n(?:.*\n)*- \[ \] docs are stale \(from the tray export, \d{4}-\d{2}-\d{2}\)/);
  assert.match(b, /- \[ \] add a regression test \(from the tray export/);
  // The operator's own headings are untouched.
  assert.match(b, /## What the operator wants \(goals\)/);
});

test("Recently is capped — older lines roll off into the ledger", () => {
  let body = BRIEF_SEED;
  for (let i = 1; i <= 5; i++) body = mergeRecently(body, `2026-09-0${i} · work ${i} · done`, 3);
  const lines = body.split("\n").filter((l) => /^- 2026/.test(l));
  assert.deepEqual(lines.map((l) => l.match(/work \d/)![0]), ["work 3", "work 4", "work 5"]);
  assert.doesNotMatch(body, /work 1/, "the oldest line is gone from the brief");
});

test("Next dedupes near-identical follow-ups and ticks the item a later entry closed", () => {
  let body = mergeNext(BRIEF_SEED, ["add a regression test for the export"], { what: "the tray export", date: "2026-09-11" });
  body = mergeNext(body, ["add regression tests for the export"], { what: "something else entirely", date: "2026-09-12" });
  assert.equal(body.match(/- \[ \] add a regression test/g)?.length, 1, "the restatement is not a second item");

  // A later entry that IS that follow-up ticks it rather than leaving it open.
  const closedByText = mergeNext(body, [], { what: "add a regression test for the export", date: "2026-09-13" });
  assert.match(closedByText, /- \[x\] add a regression test for the export/);

  // Same ticket key closes it too, however differently the work was described.
  let keyed = mergeNext(BRIEF_SEED, ["finish the ACME-12 rollback path"], { what: "rollback", date: "2026-09-11" });
  keyed = mergeNext(keyed, [], { what: "totally different words", date: "2026-09-12", ticket: "ACME-12" });
  assert.match(keyed, /- \[x\] finish the ACME-12 rollback path/);
});

test("Recently and Next survive a brief too long for Robert's budget; other sections give way", () => {
  const prose = "x".repeat(400);
  const body =
    `# Robert — brief\n\n## What this is\n${prose}\n\n## How work is done here\n${prose}\n\n` +
    `## Recently\n- 2026-09-12 · the tray export · shipped it\n\n## Next\n- [ ] add a regression test\n`;
  const capped = briefPromptBody(body, 300);
  assert.match(capped, /## Recently\n- 2026-09-12 · the tray export/);
  assert.match(capped, /## Next\n- \[ \] add a regression test/);
  assert.ok(capped.length <= 300);
  assert.doesNotMatch(capped, /xxxx/, "the long operator prose is what gets dropped, not the live sections");

  // And end to end: a brief over PER_WS_CAP still reaches the prompt with both sections.
  rewriteBrief(acme, `# Robert — brief\n\n## What this is\n${"y".repeat(4000)}\n\n## Recently\n- 2026-09-12 · the tray export · shipped it\n\n## Next\n- [ ] add a regression test\n`);
  const block = briefsBlock(acme);
  assert.match(block, /the tray export/);
  assert.match(block, /add a regression test/);
});

// ───────────────────────────── what gets logged ─────────────────────────────

test("goal-less chat shells and two-minute nothings are skipped; a terminal with a goal is not", () => {
  const base = { workspace_id: acme, turns: 3, created_at: "2026-09-12T10:00:00Z", ended_at: "2026-09-12T10:30:00Z" };
  assert.equal(shouldLogSession({ ...base, goal: null, spawn_goal: null }), false, "no goal = a scratchpad");
  assert.equal(shouldLogSession({ ...base, goal: "fix the export", spawn_goal: null }), true);
  assert.equal(shouldLogSession({ ...base, goal: null, spawn_goal: "fix the export" }), true, "the typed goal counts");
  assert.equal(shouldLogSession({ ...base, workspace_id: null, goal: "fix it" }), false);
  // 20s and nothing to show for it.
  assert.equal(
    shouldLogSession({ workspace_id: acme, goal: "oops", spawn_goal: null, turns: 0, created_at: "2026-09-12T10:00:00Z", ended_at: "2026-09-12T10:00:20Z" }),
    false,
  );
  // 20s but it actually said something.
  assert.equal(
    shouldLogSession({ workspace_id: acme, goal: "quick fix", spawn_goal: null, turns: 2, created_at: "2026-09-12T10:00:00Z", ended_at: "2026-09-12T10:00:20Z" }),
    true,
  );
});

test("read-only runs, the worklog's own summarizers and unfinished runs are skipped", () => {
  for (const name of ["plan:ACME-1", "review:ACME-1", "grade:ACME-1", "distill:ACME-1", "ideas:acme", "intake:acme", "fallback:review:ACME-1"]) {
    assert.equal(shouldLogRun(name, "success"), false, `${name} must not reach the ledger`);
  }
  assert.equal(shouldLogRun("worklog:acme", "success"), false, "the summarizer does not summarize itself");
  assert.equal(shouldLogRun("ticket:ACME-1", "paused"), false, "parked on an ask is not finished");
  assert.equal(shouldLogRun("ticket:ACME-1", "rate_limited"), false, "it retries itself");
  assert.equal(shouldLogRun("ticket:ACME-1", "interrupted"), false, "the recovery card owns a restart-killed run");
  assert.equal(shouldLogRun("ticket:ACME-1", "queued"), false);
  assert.equal(shouldLogRun("ticket:ACME-1", "running"), false);
  assert.equal(shouldLogRun("ticket:ACME-1", "blocked"), true);
  assert.equal(shouldLogRun("ticket:ACME-1", "timeout"), true);
  assert.equal(shouldLogRun("ticket:ACME-1", "success"), true);
  assert.equal(shouldLogRun("ticket:ACME-1", "failed"), true);
  assert.equal(shouldLogRun("ticket:ACME-1", "killed"), true);
});

test("a read-only run publishes nothing into the ledger, a build run does", async () => {
  const mk = (name: string) => {
    const job = jobs.create({ name, goal: "g", workspace_id: acme, cwd: "/tmp" });
    const run = runs.create(job.id, "manual");
    runs.patch(run.id, {
      status: "success", ended_at: new Date().toISOString(),
      summary: "opened the PR with the tray export fix and the regression test it needed",
    });
    return run.id;
  };
  assert.equal(await recordRun(mk("review:ACME-1"), stub({ what: "x", outcome: "y" })), null);
  assert.equal(ledger(), "", "nothing was created for a read-only run");

  const row = await recordRun(mk("ticket:ACME-1"), stub({ what: "the tray export", outcome: "shipped it", pending: [], next: ["add a test"] }));
  assert.equal(row?.what, "the tray export");
  assert.match(ledger(), /the tray export · shipped it/);
});

test("a replayed event never double-appends — the source id is claimed before the summarizer runs", async () => {
  const s = endedSession("fix the export");
  const ask = stub({ what: "the export fix", outcome: "shipped it", pending: [], next: [] });

  const first = await recordSession(s.id, ask);
  const second = await recordSession(s.id, ask);
  assert.ok(first, "the first end writes an entry");
  assert.equal(second, null, "the replay writes nothing");
  assert.equal(ledger().match(/^### /gm)?.length, 1);
  assert.equal(brief().match(/^- \d{4}-\d{2}-\d{2} · /gm)?.length, 1);
  assert.equal(logged(`session:${s.id}`), true);
});

test("backfill is idempotent over work already in the ledger", async () => {
  endedSession("fix the export");
  const ask = stub({ what: "the export fix", outcome: "shipped it", pending: [], next: [] });

  const first = await backfill(acme, sinceIso("7d"), { ask });
  assert.equal(first.added, 1);
  const again = await backfill(acme, sinceIso("7d"), { ask });
  assert.equal(again.added, 0, "nothing is summarized twice");
  assert.equal(ledger().match(/^### /gm)?.length, 1);
});

test("the summarizer falls back to the facts we hold when the model is unreachable", async () => {
  const entry = await summarizeWork(
    { asked: "fix the tray export", status: "failed", transcript: "a".repeat(200), pr: null, ticket: "ACME-12" },
    async () => null,
  );
  assert.equal(entry.what, "fix the tray export");
  assert.equal(entry.outcome, "ended failed");
  assert.deepEqual(entry.pending, []);
  assert.equal(entry.ticket, "ACME-12", "a fact we hold is never replaced by a guess");
});

test("the API/CLI read shape is the parsed ledger, newest first", () => {
  writeEntry(acme, { what: "first piece", outcome: "shipped", pending: [], next: [] }, new Date("2026-09-11T09:00:00"));
  writeEntry(acme, { what: "second piece", outcome: "failed because CI", pending: ["rerun CI"], next: [] }, new Date("2026-09-12T09:00:00"));
  const rows = readWorklog(acme, 10);
  assert.deepEqual(rows.map((r) => r.what), ["second piece", "first piece"]);
  assert.deepEqual(rows[0].pending, ["rerun CI"]);
  assert.equal(rows[0].at, "2026-09-12 09:00");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["at", "next", "outcome", "pending", "pr", "ticket", "what"]);
  assert.deepEqual(readWorklog(acme, 1).map((r) => r.what), ["second piece"], "limit takes the newest");
});

test("since accepts 7d / 36h / an ISO date", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  assert.equal(sinceIso("7d", now), "2026-09-05T12:00:00.000Z");
  assert.equal(sinceIso("36h", now), "2026-09-11T00:00:00.000Z");
  assert.equal(sinceIso("2026-09-01", now), "2026-09-01T00:00:00.000Z");
  assert.equal(sinceIso("nonsense", now), "2026-09-05T12:00:00.000Z", "a bad spec falls back to a week");
});
