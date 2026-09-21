import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asks, db, ideas, workspaces } from "./store.js";
import { createTicket } from "./tickets.js";
import { briefBuckets, agentDigest, type BriefBuckets } from "./heartbeat.js";

const BUCKETS: (keyof BriefBuckets)[] = ["needs_you", "landed", "underway", "next"];

beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM asks; " +
      "DELETE FROM reviews; DELETE FROM ideas; DELETE FROM tickets; DELETE FROM workspaces;"
  );
});

const ws = () =>
  workspaces.create({
    slug: "brief-" + randomUUID().slice(0, 8),
    name: "Brief",
    config_dir: "/tmp/brief-" + randomUUID().slice(0, 8),
  } as any);

/** The rule the whole contract rests on: no id appears under two headings. */
function assertExclusive(b: BriefBuckets) {
  const seen = new Map<string, string>();
  for (const k of BUCKETS)
    for (const item of b[k]) {
      const prior = seen.get(item.id);
      assert.equal(prior, undefined, `${item.id} is in both ${prior} and ${k}`);
      seen.set(item.id, k);
    }
}

test("a quiet shop is four empty buckets and one stable fingerprint", () => {
  const b = briefBuckets();
  for (const k of BUCKETS) assert.deepEqual(b[k], [], `${k} should be empty`);
  // "Quiet shop." collapses in the prose; here it has to collapse to ONE string, or two identical
  // quiet ticks compare unequal and the digest-skip wakes him to report nothing.
  assert.equal(agentDigest("robert"), "quiet");
});

test("every kind of work lands in exactly one bucket, from state and not from prose", () => {
  const w = ws();
  // A body that screams urgency must not move a ticket: the status column decides, not the words.
  createTicket({
    workspace_id: w.id,
    title: "Working",
    status: "in_progress",
    context: "URGENT — needs the operator to decide right now, blocked, waiting on approval",
  } as any);
  createTicket({ workspace_id: w.id, title: "Queued", status: "ready" } as any);
  createTicket({ workspace_id: w.id, title: "Stuck", status: "blocked" } as any);
  const review = createTicket({ workspace_id: w.id, title: "Built", status: "review" } as any);
  const done = createTicket({ workspace_id: w.id, title: "Shipped", status: "done" } as any);
  asks.create({ workspace_id: w.id, question: "which branch?", asked_by: "codex" } as any);
  ideas.insert({
    id: randomUUID(),
    workspace_id: w.id,
    repo_id: null,
    title: "Rewrite the importer",
    pitch: "",
    kind: "feature",
    source: "robert",
    source_ref: null,
    acceptance: null,
    status: "proposed",
    model: null,
    promoted_ticket_id: null,
    created_at: new Date().toISOString(),
    decided_at: null,
  } as any);

  const b = briefBuckets();
  assertExclusive(b);

  const labels = (k: keyof BriefBuckets) => b[k].map((i) => i.label).join(" ");
  assert.match(labels("needs_you"), /ask codex/);
  assert.match(labels("needs_you"), /:review/, "a build waiting on his yes needs him");
  assert.match(labels("needs_you"), /:blocked/);
  assert.match(labels("landed"), new RegExp(`${done.key}:done`));
  assert.match(labels("underway"), /:in_progress/);
  assert.match(labels("next"), /:ready/);
  assert.match(labels("next"), /idea Rewrite the importer/);

  // Action-free work stays out of Needs you, however loud its body is.
  assert.doesNotMatch(labels("needs_you"), /:in_progress/);
  assert.doesNotMatch(labels("needs_you"), /:ready/);
  assert.doesNotMatch(labels("needs_you"), /idea /);
  // And a ticket waiting on a yes is not ALSO reported as landed.
  assert.doesNotMatch(labels("landed"), new RegExp(`${review.key}:`));
});

test("the digest is the four buckets in order, and does not turn over with the clock", () => {
  const w = ws();
  createTicket({ workspace_id: w.id, title: "Working", status: "in_progress" } as any);
  asks.create({ workspace_id: w.id, question: "q?", asked_by: "codex" } as any);

  const d = agentDigest("robert", new Date(2026, 6, 27, 14, 10));
  assert.equal(d, agentDigest("robert", new Date(2026, 6, 27, 14, 50)));
  assert.match(d, /^need=.*\|land=.*\|under=.*\|next=/);
});
