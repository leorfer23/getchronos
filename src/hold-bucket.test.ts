import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { filterByBucket, holdBucket, holdDivergence, parseBucketFilter, tomorrowAt } from "./hold-bucket.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const AGED = 72 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── bucket truth table, at the boundaries ────────────────────────────────────

test("holdBucket: a hold in the future is dated, and the instant it expires it is live again", () => {
  const created = iso(NOW - 1000);
  assert.equal(holdBucket({ created_at: created, hold_until: iso(NOW + 1) }, NOW, AGED), "dated");
  // Exactly now is NOT the future: its moment has come, so it belongs back on the list.
  assert.equal(holdBucket({ created_at: created, hold_until: iso(NOW) }, NOW, AGED), "live");
  assert.equal(holdBucket({ created_at: created, hold_until: iso(NOW - 1) }, NOW, AGED), "live");
});

test("holdBucket: a PAST hold on an ancient row is live, not aged — a date beats the age heuristic", () => {
  const ancient = iso(NOW - AGED * 5);
  assert.equal(holdBucket({ created_at: ancient, hold_until: iso(NOW - 1) }, NOW, AGED), "live");
  assert.equal(holdBucket({ created_at: ancient, hold_until: null }, NOW, AGED), "aged");
});

test("holdBucket: aged needs an UNDATED row at or past the threshold", () => {
  assert.equal(holdBucket({ created_at: iso(NOW - AGED + 1) }, NOW, AGED), "live");
  assert.equal(holdBucket({ created_at: iso(NOW - AGED) }, NOW, AGED), "aged");
  assert.equal(holdBucket({ created_at: iso(NOW - AGED - 1) }, NOW, AGED), "aged");
});

test("holdBucket: agedAfterMs 0 turns aging off entirely — only dates hold anything back", () => {
  assert.equal(holdBucket({ created_at: iso(NOW - AGED * 10) }, NOW, 0), "live");
  assert.equal(holdBucket({ created_at: iso(NOW - AGED * 10), hold_until: iso(NOW + 1000) }, NOW, 0), "dated");
});

test("holdBucket: an unparseable date is not a hold (never silently 'dated')", () => {
  assert.equal(holdBucket({ created_at: iso(NOW), hold_until: "later maybe" }, NOW, AGED), "live");
  // Never classified from prose: the same row with a reason-shaped value still buckets on fields only.
  assert.equal(holdBucket({ created_at: "not a date" }, NOW, AGED), "live");
});

test("holdBucket defaults agedAfterMs from CONFIG.holdAgedHours", () => {
  const justOver = iso(Date.now() - CONFIG.holdAgedHours * 3_600_000 - 1000);
  assert.equal(holdBucket({ created_at: justOver }), "aged");
});

test("parseBucketFilter: anything unrecognised means the live 'needs you' list", () => {
  assert.equal(parseBucketFilter(undefined), "live");
  assert.equal(parseBucketFilter(""), "live");
  assert.equal(parseBucketFilter("nonsense"), "live");
  assert.equal(parseBucketFilter("DATED"), "dated");
  assert.equal(parseBucketFilter("aged"), "aged");
  assert.equal(parseBucketFilter("all"), "all");
});

test("filterByBucket tags every row and keeps only the asked-for bucket; 'all' keeps everything", () => {
  const rows = [
    { id: "live", created_at: iso(NOW - 1000), hold_until: null },
    { id: "dated", created_at: iso(NOW - 1000), hold_until: iso(NOW + AGED) },
    { id: "aged", created_at: iso(NOW - AGED * 2), hold_until: null },
  ];
  assert.deepEqual(filterByBucket(rows, "live", NOW, AGED).map((r) => r.id), ["live"]);
  assert.deepEqual(filterByBucket(rows, "dated", NOW, AGED).map((r) => r.id), ["dated"]);
  assert.deepEqual(filterByBucket(rows, "aged", NOW, AGED).map((r) => r.id), ["aged"]);
  assert.deepEqual(
    filterByBucket(rows, "all", NOW, AGED).map((r) => [r.id, r.bucket]),
    [["live", "live"], ["dated", "dated"], ["aged", "aged"]],
  );
});

test("tomorrowAt is always strictly tomorrow, at the given local hour", () => {
  const at = new Date(tomorrowAt(Date.parse("2026-09-12T07:30:00"), 9));
  assert.equal(at.getHours(), 9);
  assert.equal(at.getMinutes(), 0);
  assert.equal(at.getDate(), new Date(Date.parse("2026-09-13T07:30:00")).getDate());
  assert.ok(at.getTime() > Date.parse("2026-09-12T07:30:00"));
});

// ── divergence ───────────────────────────────────────────────────────────────

const ask = (over: Partial<Parameters<typeof holdDivergence>[0]["asks"][0]> = {}) => ({
  id: "aaaaaaaa-1111-2222-3333-444444444444",
  question: "main or release?",
  workspace_id: "ws1",
  ticket_key: "PER-9",
  ticket_closed: false,
  run_done_status: null,
  run_read_only: false,
  ...over,
});

test("holdDivergence: a closed ticket with its ask still open is reported", () => {
  const out = holdDivergence({ asks: [ask({ ticket_closed: true })], reviews: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "ask");
  assert.equal(out[0].id8, "aaaaaaaa");
  assert.match(out[0].line, /still open but PER-9 is closed/);
});

test("holdDivergence: a build run that finished successfully with its question open is reported", () => {
  const out = holdDivergence({ asks: [ask({ run_done_status: "success" })], reviews: [] });
  assert.equal(out.length, 1);
  assert.match(out[0].line, /build run finished success/);
});

test("holdDivergence: a read-only run's advisory ask is never a divergence", () => {
  const out = holdDivergence({ asks: [ask({ run_done_status: "success", run_read_only: true })], reviews: [] });
  assert.deepEqual(out, []);
});

test("holdDivergence: a still-running or failed run with an open ask is the normal shape", () => {
  assert.deepEqual(holdDivergence({ asks: [ask()], reviews: [] }), []);
  assert.deepEqual(holdDivergence({ asks: [ask({ run_done_status: "interrupted" })], reviews: [] }), []);
});

test("holdDivergence: a pending review whose PR is merged or closed is reported; open/null is not", () => {
  const base = { id: "bbbbbbbb-1111", workspace_id: "ws1", ticket_key: "PER-3" };
  assert.equal(holdDivergence({ asks: [], reviews: [{ ...base, pr_state: "merged" }] }).length, 1);
  assert.equal(holdDivergence({ asks: [], reviews: [{ ...base, pr_state: "closed" }] }).length, 1);
  assert.equal(holdDivergence({ asks: [], reviews: [{ ...base, pr_state: "open" }] }).length, 0);
  assert.equal(holdDivergence({ asks: [], reviews: [{ ...base, pr_state: null }] }).length, 0);
  assert.match(
    holdDivergence({ asks: [], reviews: [{ ...base, pr_state: "merged" }] })[0].line,
    /still pending but PER-3 PR is merged/,
  );
});
