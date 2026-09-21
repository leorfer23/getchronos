import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lessons as store, repos, workspaces } from "./store.js";
import { decayLessons, lessonsBlock, recordLesson, relevantLessons, similarity, tokens } from "./lessons.js";
import { CONFIG } from "./config.js";

function ws(): string {
  const slug = `les-${randomUUID().slice(0, 6)}`;
  return workspaces.create({ slug, name: slug, config_dir: `/tmp/${slug}` }).id;
}

// ───────────────────────────── matching ─────────────────────────────

test("tokens drops filler so 'always' and 'the' don't make everything look alike", () => {
  const t = tokens("Always convert the timestamps to UTC");
  assert.ok(t.has("convert"));
  assert.ok(!t.has("always"));
  assert.ok(!t.has("the"));
  assert.ok(t.has("timestamp"), "plurals fold to singular so a rule and a ticket can agree");
  assert.deepEqual(tokens("migration"), tokens("migrations"));
});

test("similarity separates the same complaint from a different one", () => {
  const a = "Convert timestamps to UTC at the API edge";
  assert.ok(similarity(a, "Timestamps must be converted to UTC at the api edge") > 0.5);
  assert.ok(similarity(a, "Add an index to the orders table before querying it") < 0.2);
  assert.equal(similarity("", "anything"), 0);
});

// ───────────────────────────── capture ─────────────────────────────

test("recordLesson folds a restatement into the existing rule instead of piling up", () => {
  const w = ws();
  const first = recordLesson({ workspace_id: w, rule: "Convert timestamps to UTC at the API edge.", source: "review", state: "proposed" });
  const again = recordLesson({ workspace_id: w, rule: "Timestamps should be converted to UTC at the api edge.", source: "review", state: "proposed" });
  assert.equal(again.id, first.id, "the same complaint twice is one rule, not two");
  assert.equal(store.list({ workspace_id: w }).length, 1);
});

test("a reviewer's rule needs a recurrence to bind everyone; the operator's binds at once", () => {
  const w = ws();
  const proposed = recordLesson({ workspace_id: w, rule: "Never widen a public API type without a deprecation note.", source: "review", state: "proposed" });
  assert.equal(proposed.state, "proposed", "one reviewer complaint is a hypothesis");

  const repeated = recordLesson({ workspace_id: w, rule: "Do not widen a public API type without a deprecation note.", source: "review", state: "proposed" });
  assert.equal(repeated.id, proposed.id);
  assert.equal(repeated.state, "active", `promotes at seen=${CONFIG.lessonPromoteAfter}`);

  const fromLeo = recordLesson({ workspace_id: w, rule: "Put the cost number in the first line of any status report.", source: "operator" });
  assert.equal(fromLeo.state, "active", "he does not repeat himself");
});

test("the same rule scoped to a repo is separate from the workspace-wide one", () => {
  const w = ws();
  const repo = repos.create({ workspace_id: w, name: "api", path: `/tmp/${w}-api` });
  const wide = recordLesson({ workspace_id: w, repo_id: null, rule: "Run the linter before claiming done." });
  const scoped = recordLesson({ workspace_id: w, repo_id: repo.id, rule: "Run the linter before claiming done." });
  assert.notEqual(scoped.id, wide.id, "a repo-specific rule is not a restatement of the workspace-wide one");
});

// ───────────────────────────── injection ─────────────────────────────

test("relevantLessons ranks by what the work is actually about", () => {
  const w = ws();
  recordLesson({ workspace_id: w, rule: "Migrations must be reversible and land in their own PR.", topic: "build" });
  recordLesson({ workspace_id: w, rule: "Prefer the existing Button component over new markup.", topic: "build" });

  const picked = relevantLessons(w, { topic: "build", text: "Add a migration for the orders table" });
  assert.match(picked[0].rule, /Migrations/, "singular/plural must not decide whether a rule fires");
  assert.ok(
    similarity("Migrations must be reversible and land in their own PR.", "Add a migration for the orders table") > 0,
    "the match has to be real, not a tie broken by insertion order",
  );
});

test("relevantLessons keeps a topic's rules out of another topic's prompt", () => {
  const w = ws();
  recordLesson({ workspace_id: w, rule: "Lead every status report with the cost number.", topic: "comms" });
  recordLesson({ workspace_id: w, rule: "Never commit generated files by hand.", topic: "build" });

  // Topic-only standing injection (no text) — topic filter alone decides membership.
  const build = relevantLessons(w, { topic: "build" }).map((l) => l.rule);
  assert.ok(build.some((r) => r.includes("generated files")));
  assert.ok(!build.some((r) => r.includes("cost number")));
});

test("relevantLessons: a text query needs positive overlap — zero-overlap rules stay out", () => {
  const w = ws();
  recordLesson({ workspace_id: w, rule: "Never commit generated files by hand.", topic: "build" });
  recordLesson({ workspace_id: w, rule: "Migrations must be reversible and land in their own PR.", topic: "build" });

  assert.deepEqual(
    relevantLessons(w, { topic: "build", text: "unrelated redshift warehouse refresh" }),
    [],
    "unrelated query must not return every standing build rule",
  );
  const hit = relevantLessons(w, { topic: "build", text: "add a flyway migration" });
  assert.equal(hit.length, 1);
  assert.match(hit[0].rule, /Migrations/);
});

test("relevantLessons: topic-only injection still returns the topic's rules", () => {
  const w = ws();
  recordLesson({ workspace_id: w, rule: "Never commit generated files by hand.", topic: "build" });
  const build = relevantLessons(w, { topic: "build" });
  assert.equal(build.length, 1);
  assert.match(build[0].rule, /generated files/);
});

test("a path-scoped rule fires for its own files and steps aside for others", () => {
  const w = ws();
  recordLesson({ workspace_id: w, rule: "Every SQL migration needs a rollback section.", scope: "**/*.sql", topic: "review" });
  recordLesson({ workspace_id: w, rule: "Keep React components under 200 lines.", topic: "review" });

  const onSql = relevantLessons(w, { topic: "review", text: "orders", files: ["db/migrations/003.sql"] });
  assert.match(onSql[0].rule, /rollback/);

  const onTsx = relevantLessons(w, { topic: "review", text: "button", files: ["ui/Button.tsx"] }).map((l) => l.rule);
  assert.ok(!onTsx.some((r) => r.includes("rollback")), "an out-of-scope rule must not crowd the prompt");
});

test("archived rules are never injected", () => {
  const w = ws();
  const l = recordLesson({ workspace_id: w, rule: "This one was retired for a reason." });
  store.update(l.id, { state: "archived" });
  assert.equal(relevantLessons(w, {}).length, 0);
  assert.equal(lessonsBlock(w, {}), "");
});

test("lessonsBlock renders the rules and counts the injection", () => {
  const w = ws();
  const l = recordLesson({ workspace_id: w, rule: "Always append to the Work log, never rewrite it.", scope: "src/**" });
  const block = lessonsBlock(w, { topic: "build", text: "work log" });
  assert.match(block, /Always append to the Work log/);
  assert.match(block, /src\/\*\*/);
  assert.equal(store.get(l.id)!.hits, 1, "hits is what tells the operator which rules actually fire");
  assert.ok(store.get(l.id)!.last_fired);
});

test("lessonsBlock respects its prompt budget", () => {
  const w = ws();
  const rules = [
    "Every migration ships with a rollback section.",
    "Paginate any list endpoint that can exceed 200 rows.",
    "Log the request id, not the whole payload.",
    "Cache reads at the repository layer, never in a component.",
    "Retry idempotent calls only; a POST without a key must fail loud.",
    "Store timestamps naive UTC and convert at the edge.",
    "Uploads go through signed URLs; the API never proxies bytes.",
    "Verify webhook signatures before parsing the body.",
    "Add the index in the same change as the query that needs it.",
    "Read credentials from the workspace secrets file, never a literal.",
  ];
  for (const rule of rules) recordLesson({ workspace_id: w, rule });
  assert.equal(store.list({ workspace_id: w }).length, rules.length, "these are genuinely different rules");
  const block = lessonsBlock(w, { limit: 3 });
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 3);
});

// ───────────────────────────── decay ─────────────────────────────

test("decay retires a proposal nobody ever saw twice, but not before its time", () => {
  const w = ws();
  const l = recordLesson({ workspace_id: w, rule: "A proposal that never recurred anywhere else.", source: "review", state: "proposed" });
  const born = Date.parse(l.created_at);

  decayLessons(born + (CONFIG.lessonProposedTtlDays - 1) * 86_400_000);
  assert.equal(store.get(l.id)!.state, "proposed", "still inside its window");

  decayLessons(born + (CONFIG.lessonProposedTtlDays + 1) * 86_400_000);
  assert.equal(store.get(l.id)!.state, "archived");
});

test("decay never retires an active rule that is still firing", () => {
  const w = ws();
  const l = recordLesson({ workspace_id: w, rule: "A rule that keeps matching real work every week." });
  store.markFired([l.id]);
  const fired = Date.parse(store.get(l.id)!.last_fired!);
  // Old enough to be archived on age alone — but it fired recently, so it is doing its job.
  decayLessons(fired + (CONFIG.lessonIdleTtlDays - 1) * 86_400_000);
  assert.equal(store.get(l.id)!.state, "active");
});

test("decay retires an active rule whose code stopped existing", () => {
  const w = ws();
  const l = recordLesson({ workspace_id: w, rule: "A rule about a module that has since been deleted." });
  decayLessons(Date.parse(l.created_at) + (CONFIG.lessonIdleTtlDays + 1) * 86_400_000);
  assert.equal(store.get(l.id)!.state, "archived");
});
