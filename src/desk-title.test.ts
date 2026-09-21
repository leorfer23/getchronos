/**
 * Desk cards: the seed a terminal starts working from, and who is allowed to rename its card.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import {
  applyDerivedSummary,
  applyDerivedTitle,
  isDerivable,
  summaryFromResult,
  titleFromUnderstanding,
} from "./desk-title.js";
import { deskSeed } from "./terminal.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

let n = 0;
const mkSession = (goal: string | null, extra: Record<string, unknown> = {}) => {
  const slug = `desk${++n}`; // workspace slugs are unique — one per terminal in these tests
  const ws = workspaces.create({ slug, name: "Desk", config_dir: "/tmp/desk" });
  return sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal, ...extra } as any);
};

test("deskSeed carries the goal, the finish line for its kind, and the brief", () => {
  const seed = deskSeed("open the flyway rollback PR", "pr", "master already has V4.55 — renumber first");
  assert.match(seed, /^Goal: open the flyway rollback PR/);
  assert.match(seed, /pull request is open/i);
  assert.match(seed, /master already has V4\.55/);
  assert.match(seed, /mc goal set/); // the retitle contract rides along with the task
  assert.match(seed, /Start now\.$/);
  // Each kind states a different done.
  assert.match(deskSeed("why the DAG fails", "investigation"), /answer with the evidence/i);
  assert.match(deskSeed("check the export", "qa"), /verdict/i);
  // No kind, no brief → still a runnable prompt.
  const bare = deskSeed("write the memo", null);
  assert.match(bare, /^Goal: write the memo/);
  assert.doesNotMatch(bare, /Brief from your operator/);
});

test("deskSeed with no goal: the brief is the task, and the card asks to be named", () => {
  // The Desk's goal field is optional (Blank terminal). A brief typed without one must still become
  // the first prompt rather than being dropped, and the contract asks for a name instead of a fix.
  const seed = deskSeed("", null, "look at why the nightly export is empty");
  assert.doesNotMatch(seed, /^Goal:/m);
  assert.match(seed, /^look at why the nightly export is empty/);
  assert.match(seed, /no title yet/i);
  assert.match(seed, /mc goal set/);
  assert.match(seed, /Start now\.$/);
  // Nothing typed at all is not this function's job — openSession types no seed in that case.
});

test("titleFromUnderstanding keeps the first sentence and drops the throat-clearing", () => {
  assert.equal(
    titleFromUnderstanding("Understanding: I need to open the flyway rollback PR. Then I'll renumber."),
    "open the flyway rollback PR",
  );
  assert.equal(
    titleFromUnderstanding("**Understanding:** The task is to find why the 3am DAG fails"),
    "find why the 3am DAG fails",
  );
  // A dash starts the speculation — the label stops there.
  assert.equal(
    titleFromUnderstanding("Understanding: I need to audit Flyway migration numbering in wh-core — likely a gap in V4.5x"),
    "audit Flyway migration numbering in wh-core",
  );
  // Too short to be a label, and nothing at all.
  assert.equal(titleFromUnderstanding("Understanding: ok"), null);
  assert.equal(titleFromUnderstanding("   "), null);
  // Long ones are cut on a word boundary, not mid-word.
  const long = titleFromUnderstanding("Understanding: " + "rebuild the redshift refresh pipeline ".repeat(5))!;
  assert.ok(long.length <= 72);
  assert.match(long, /…$/);
});

test("structured Focus closeouts become session summaries without another model call", () => {
  assert.equal(
    summaryFromResult("**Summary:** Flyway rollback PR is open and green; waiting on approval."),
    "Flyway rollback PR is open and green; waiting on approval.",
  );
  assert.equal(summaryFromResult("Result: tests pass"), "tests pass");
  assert.equal(summaryFromResult("  "), null);

  const s = mkSession("open the rollback PR");
  assert.equal(
    applyDerivedSummary(s.id, "**Summary:** PR opened; unit tests and typecheck pass."),
    "PR opened; unit tests and typecheck pass.",
  );
  assert.equal(sessions.get(s.id)!.summary, "PR opened; unit tests and typecheck pass.");
  assert.equal(applyDerivedSummary(s.id, "**Summary:** PR opened; unit tests and typecheck pass."), null);
});

test("the deriver renames a spawn-typed card and stops once a human or the agent claims it", () => {
  const s = mkSession("fix the dbt thing");
  assert.equal(sessions.get(s.id)!.goal_source, "seed"); // typed in the dialog = still a guess

  assert.equal(applyDerivedTitle(s.id, "Understanding: I need to fix the incremental merge in fct_orders."), "fix the incremental merge in fct_orders");
  assert.equal(sessions.get(s.id)!.goal_source, "auto");
  assert.equal(sessions.get(s.id)!.title, "fix the incremental merge in fct_orders");

  // A second turn refines it again — the card follows the work.
  applyDerivedTitle(s.id, "Understanding: it's actually the late-arriving dedupe in stg_orders.");
  assert.equal(sessions.get(s.id)!.goal, "it's actually the late-arriving dedupe in stg_orders");
  assert.equal(sessions.get(s.id)!.title, "fix the incremental merge in fct_orders", "historical opening title stays stable");

  // The operator edits the card → his words are pinned, and the next Understanding is ignored.
  sessions.setGoal(s.id, { goal: "unblock the nightly build" });
  assert.equal(sessions.get(s.id)!.goal_source, "human");
  assert.equal(applyDerivedTitle(s.id, "Understanding: I need to rewrite the whole model."), null);
  assert.equal(sessions.get(s.id)!.goal, "unblock the nightly build");

  // Same for a goal the agent set itself with `mc goal set`.
  const s2 = mkSession("look at it");
  sessions.setGoal(s2.id, { goal: "open the rollback PR", goal_source: "agent" });
  assert.equal(applyDerivedTitle(s2.id, "Understanding: I need to do something else entirely."), null);

  const s3 = mkSession("look at it", { title: "operator's terminal label" });
  applyDerivedTitle(s3.id, "Understanding: I need to inspect the export.");
  assert.equal(sessions.get(s3.id)!.title, "operator's terminal label");
});

test("a ticked or ended terminal is never renamed", () => {
  const s = mkSession("ship the migration");
  sessions.setGoal(s.id, { goal_done: true });
  assert.equal(isDerivable(sessions.get(s.id)!), false);
  assert.equal(applyDerivedTitle(s.id, "Understanding: I need to start over."), null);

  const s2 = mkSession("write the memo");
  sessions.end(s2.id);
  assert.equal(isDerivable(sessions.get(s2.id)!), false);
});

test("sessions.setGoal round-trips the kind, and a plain goal write is the operator's", () => {
  const s = mkSession(null);
  assert.equal(sessions.get(s.id)!.goal_source, null); // no goal, no owner
  sessions.setGoal(s.id, { goal: "verify the invoice export", goal_kind: "qa" });
  const row = sessions.get(s.id)!;
  assert.equal(row.goal_kind, "qa");
  assert.equal(row.goal_source, "human");
});
