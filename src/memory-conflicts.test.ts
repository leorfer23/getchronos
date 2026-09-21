import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, memoryRelations, workspaces } from "./store.js";
import { MIN_REF_PREFIX } from "./store/memory-relations.js";
import {
  ACTIONABLE,
  buildJudgePrompt,
  candidatesFor,
  conflictBlock,
  idfOver,
  openConflicts,
  parseVerdicts,
  subjectOverlap,
  type MemoryFact,
} from "./memory-conflicts.js";
import { tokens } from "./text-similarity.js";

const mkWs = (slug: string) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}-${randomUUID()}` });

const fact = (ref: string, text: string): MemoryFact => ({ kind: "memory-line", ref, text });

const MANDATORY = "Every agent claims its own git worktree before editing any file";
const OPTIONAL = "For a one-line change an agent may edit the main worktree directly";

// ───────────────────────────── candidate generation ─────────────────────────────

test("a contradiction is found even though its token overlap is tiny", () => {
  // The two rules disagree about worktrees but share almost no vocabulary — which is exactly why
  // the Jaccard dedupe that guards capture cannot see them, and why this stage does not use it.
  const a = tokens(MANDATORY);
  const b = tokens(OPTIONAL);
  const shared = [...a].filter((t) => b.has(t));
  const jaccard = shared.length / (a.size + b.size - shared.length);
  assert.ok(jaccard < 0.3, `overlap is low by design: ${jaccard.toFixed(2)}`);

  const pool = [
    fact("b", OPTIONAL),
    fact("c", "Telegram is the escalation channel when an agent is blocked"),
    fact("d", "The chief-of-staff poll interval is ninety seconds"),
  ];
  const picked = candidatesFor(fact("a", MANDATORY), pool);
  assert.equal(picked[0]?.ref, "b", `the contradicting rule ranks first, got ${picked.map((p) => p.ref)}`);
});

test("a shared rare word outranks a shared common one", () => {
  const pool = [
    fact("rare", "flyway checksums are repaired with the repair command"),
    fact("common", "the deploy command is run after the review command"),
    fact("n1", "the command runs nightly"),
    fact("n2", "the command runs on request"),
    fact("n3", "the command runs after a merge"),
  ];
  // "flyway" appears in 1 of 5 pool texts, "command" in all 5 — the rare one must weigh more.
  const idf = idfOver(pool.map((p) => p.text));
  assert.ok((idf.get("flyway") ?? 0) > (idf.get("command") ?? 0), "idf ranks the rare token higher");

  // Both candidates share exactly one token with the query; only the rarity differs.
  const picked = candidatesFor(fact("q", "flyway command"), pool);
  assert.equal(picked[0].ref, "rare", `rare-token match leads, got ${picked.map((p) => p.ref)}`);

  const s = (a: string, b: string) => subjectOverlap(tokens(a), tokens(b), idf);
  assert.ok(s("flyway", pool[0].text) > s("command", pool[1].text), "per-token weight, not count");
});

test("candidates are capped and floored — an unrelated pool costs nothing", () => {
  const pool = Array.from({ length: 30 }, (_, i) =>
    fact(`p${i}`, `An unrelated note about ${["invoices", "calendars", "fonts", "printers"][i % 4]} number ${i}`),
  );
  const picked = candidatesFor(fact("new", MANDATORY), pool);
  assert.equal(picked.length, 0, "nothing shares a subject, so no model call is ever made");

  const crowded = Array.from({ length: 30 }, (_, i) => fact(`w${i}`, `${MANDATORY} variant ${i}`));
  assert.ok(candidatesFor(fact("new", MANDATORY), crowded).length <= 6, "batch is capped");
});

test("a fact is never a candidate against itself", () => {
  const picked = candidatesFor(fact("a", MANDATORY), [fact("a", MANDATORY), fact("b", OPTIONAL)]);
  assert.deepEqual(picked.map((p) => p.ref), ["b"]);
});

// ───────────────────────────── the prompt and its reply ─────────────────────────────

test("the judge prompt numbers candidates and locks the vocabulary", () => {
  const p = buildJudgePrompt(fact("a", MANDATORY), [fact("b", OPTIONAL), fact("c", "Something else")]);
  assert.match(p, /1\. For a one-line change/);
  assert.match(p, /2\. Something else/);
  for (const verb of ["conflicts_with", "supersedes", "scoped", "related", "compatible", "not_conflict"])
    assert.ok(p.includes(verb), `${verb} is offered`);
  assert.match(p, /narrower exception to a general rule is "scoped"/, "guards the common false positive");
});

test("parseVerdicts keeps the valid rows and drops the rest", () => {
  const out = `noise before
  [{"n":1,"relation":"conflicts_with","confidence":0.8,"reason":"required vs optional"},
   {"n":2,"relation":"not_a_verb","confidence":0.9,"reason":"x"},
   {"n":9,"relation":"related","confidence":0.5,"reason":"out of range"},
   {"n":1,"relation":"related","confidence":0.4,"reason":"duplicate n"},
   {"n":2,"relation":"related","confidence":5,"reason":"clamped"}]
  trailing noise`;
  const v = parseVerdicts(out, 2);
  assert.deepEqual(v.map((x) => x.n), [1, 2], "invalid verb, out-of-range n and duplicate n are dropped");
  assert.equal(v[0].relation, "conflicts_with");
  assert.equal(v[1].confidence, 1, "confidence is clamped into [0,1]");
});

test("parseVerdicts never throws on junk", () => {
  for (const junk of [null, "", "not json", "[", "{}", "[1,2,3]", '[{"n":"x"}]'])
    assert.deepEqual(parseVerdicts(junk, 3), [], `handled: ${JSON.stringify(junk)}`);
});

// ───────────────────────────── storage and surfacing ─────────────────────────────

function seedRelation(ws: string, relation: string, source = MANDATORY, target = OPTIONAL) {
  return memoryRelations.record({
    workspace_id: ws,
    source_kind: "memory-line",
    source_ref: `s-${randomUUID().slice(0, 8)}`,
    source_text: source,
    target_kind: "memory-line",
    target_ref: `t-${randomUUID().slice(0, 8)}`,
    target_text: target,
    relation: relation as any,
    confidence: 0.8,
    reason: "required vs optional",
    judged_by: "haiku",
  });
}

test("a pair is recorded once, and `judged` sees it from either direction", () => {
  const w = mkWs("mc-once");
  const first = memoryRelations.record({
    workspace_id: w.id,
    source_kind: "lesson", source_ref: "L1", source_text: MANDATORY,
    target_kind: "lesson", target_ref: "L2", target_text: OPTIONAL,
    relation: "conflicts_with", confidence: 0.8, reason: "r", judged_by: "haiku",
  });
  assert.ok(first);
  const again = memoryRelations.record({
    workspace_id: w.id,
    source_kind: "lesson", source_ref: "L1", source_text: MANDATORY,
    target_kind: "lesson", target_ref: "L2", target_text: OPTIONAL,
    relation: "related", confidence: 0.2, reason: "r2", judged_by: "haiku",
  });
  assert.equal(again, undefined, "the second write is ignored, not a duplicate row");
  assert.equal(memoryRelations.get(first!.id)!.relation, "conflicts_with", "the first verdict stands");
  assert.ok(memoryRelations.judged(w.id, "L2", "L1"), "reversed pair counts as judged");
  assert.ok(!memoryRelations.judged(w.id, "L1", "L3"));
});

test("only contradictions surface; the bookkeeping verdicts stay quiet", () => {
  const w = mkWs("mc-surface");
  seedRelation(w.id, "conflicts_with");
  seedRelation(w.id, "supersedes");
  seedRelation(w.id, "related");
  seedRelation(w.id, "compatible");
  seedRelation(w.id, "not_conflict");

  const open = openConflicts(w.id, 10);
  assert.equal(open.length, 2, `only the actionable verdicts, got ${open.map((r) => r.relation)}`);
  assert.ok(open.every((r) => ACTIONABLE.has(r.relation)));
});

test("a resolved conflict stops being surfaced", () => {
  const w = mkWs("mc-resolve");
  const r = seedRelation(w.id, "conflicts_with")!;
  assert.equal(openConflicts(w.id).length, 1);
  memoryRelations.resolve(r.id, "resolved");
  assert.equal(openConflicts(w.id).length, 0);
  assert.equal(memoryRelations.countOpen(w.id), 0);
});

test("conflictBlock shows both sides and is empty when there is nothing to settle", () => {
  const w = mkWs("mc-block");
  assert.equal(conflictBlock(w.id), "");
  seedRelation(w.id, "conflicts_with");
  const block = conflictBlock(w.id);
  assert.match(block, /Memory conflicts/);
  assert.ok(block.includes("claims its own git worktree"), "the new side is shown");
  assert.ok(block.includes("edit the main worktree directly"), "the old side is shown");
  assert.match(block, /mc memory conflicts/, "tells the reader how to settle it");
});

test("relations are workspace-walled", () => {
  const a = mkWs("mc-wall-a");
  const b = mkWs("mc-wall-b");
  seedRelation(a.id, "conflicts_with");
  assert.equal(openConflicts(a.id).length, 1);
  assert.equal(openConflicts(b.id).length, 0, "another workspace never sees it");
  assert.equal(conflictBlock(b.id), "");
});

// ───────────────────────────── capture hooks ─────────────────────────────

test("a lesson's conflict pool is limited to rules that could apply to the same work", async () => {
  // CHRONOS_TEST disables the auditor, so recordLesson must still behave exactly as before:
  // the hook is fire-and-forget and may never change what capture returns.
  const { recordLesson } = await import("./lessons.js");
  const w = mkWs("mc-hook");
  const a = recordLesson({
    workspace_id: w.id, repo_id: null, scope: null, topic: "build",
    rule: "Claim a worktree before editing any file.", source: "operator", source_ref: null, state: "active",
  });
  assert.equal(a.state, "active");
  const b = recordLesson({
    workspace_id: w.id, repo_id: null, scope: null, topic: "build",
    rule: "For one-line changes edit the main checkout in place.", source: "operator", source_ref: null, state: "active",
  });
  assert.notEqual(b.id, a.id, "a contradicting rule is a NEW lesson, not a fold into the old one");
  assert.equal(memoryRelations.list({ workspace_id: w.id }).length, 0, "no model call under CHRONOS_TEST");
});

test("remembering a fact still works with the auditor wired in", async () => {
  const { rememberFact } = await import("./memory-tree.js");
  const w = mkWs("mc-remember");
  const r1 = rememberFact(w.id, { fact: "Claim a worktree before editing any file", topic: "Git" });
  assert.equal(r1.ok, true);
  const r2 = rememberFact(w.id, { fact: "For one-line changes edit the main checkout in place", topic: "Git" });
  assert.equal(r2.ok, true);
  assert.equal(r2.ok && r2.added, true, "the second line lands — it is new, not a duplicate");
});

test("a new index line is never judged against itself", async () => {
  const { rememberFact } = await import("./memory-tree.js");
  const { candidatesFor: cf } = await import("./memory-conflicts.js");
  const w = mkWs("mc-self");
  rememberFact(w.id, { fact: "Claim a worktree before editing any file", topic: "Git" });
  // Same subject, different claim — the pool it is judged against must exclude the line itself.
  const pool = [{ kind: "memory-line" as const, ref: "other", text: "Claim a worktree before editing any file" }];
  const me = { kind: "memory-line" as const, ref: "other", text: "Claim a worktree before editing any file" };
  assert.deepEqual(cf(me, pool), [], "identical ref is filtered out");
});

// ───────────────────────────── settling by the id people actually see ─────────────────────────────

test("a conflict resolves by the short id the CLI prints, not just the full uuid", () => {
  const w = mkWs("mc-prefix");
  const r = seedRelation(w.id, "conflicts_with")!;
  const shown = r.id.slice(0, 8); // exactly what `mc memory conflicts` puts on screen

  const byPrefix = memoryRelations.resolveRef(w.id, shown);
  assert.equal(byPrefix.row?.id, r.id, "the printed id is enough to settle it");
  assert.equal(byPrefix.ambiguous, undefined);

  const byFull = memoryRelations.resolveRef(w.id, r.id);
  assert.equal(byFull.row?.id, r.id, "the full uuid still works");

  assert.equal(memoryRelations.resolveRef(w.id, r.id.toUpperCase()).row?.id, r.id, "case-insensitive");
});

test("an ambiguous prefix refuses to guess, and reports how many it matched", () => {
  const w = mkWs("mc-ambig");
  // Craft the collision rather than hope for one: two ids sharing the first eight characters is
  // exactly the case the CLI's short form can produce, and it must never settle the wrong one.
  const ids = ["dead1234-0000-4000-8000-000000000001", "dead1234-0000-4000-8000-000000000002"];
  for (const id of ids)
    db.prepare(
      `INSERT INTO memory_relations
         (id,workspace_id,source_kind,source_ref,source_text,target_kind,target_ref,target_text,
          relation,confidence,reason,judged_by,status,created_at)
       VALUES (?,?,'memory-line',?,?,'memory-line',?,?,'conflicts_with',0.8,'r','haiku','open',?)`,
    ).run(id, w.id, `s-${id}`, MANDATORY, `t-${id}`, OPTIONAL, new Date().toISOString());

  const res = memoryRelations.resolveRef(w.id, "dead1234");
  assert.equal(res.row, undefined, "refuses to settle either one");
  assert.equal(res.ambiguous, 2, "says how many it matched so the caller can add characters");

  // One more character disambiguates.
  assert.equal(memoryRelations.resolveRef(w.id, "dead1234-0000-4000-8000-000000000002").row?.id, ids[1]);
});

test("a prefix never reaches another workspace's conflicts", () => {
  const a = mkWs("mc-pfx-a");
  const b = mkWs("mc-pfx-b");
  const r = seedRelation(a.id, "conflicts_with")!;
  assert.equal(memoryRelations.resolveRef(b.id, r.id).row, undefined, "walled even with the full id");
  assert.equal(memoryRelations.resolveRef(b.id, r.id.slice(0, 8)).row, undefined);
});

test("a prefix shorter than the floor is refused rather than guessed at", () => {
  const w = mkWs("mc-floor");
  const r = seedRelation(w.id, "conflicts_with")!;
  assert.equal(memoryRelations.resolveRef(w.id, r.id.slice(0, 3)).row, undefined, "3 chars is below the floor");
  assert.equal(memoryRelations.resolveRef(w.id, "").row, undefined);
  assert.equal(memoryRelations.resolveRef(w.id, r.id.slice(0, MIN_REF_PREFIX)).row?.id, r.id, "the floor itself works");
});

test("an unknown id is not found rather than matching something else", () => {
  const w = mkWs("mc-unknown");
  seedRelation(w.id, "conflicts_with");
  const res = memoryRelations.resolveRef(w.id, "zzzzzzzz");
  assert.equal(res.row, undefined);
  assert.equal(res.ambiguous, undefined);
});

// ───────────────────────────── who actually judged ─────────────────────────────

test("judged_by records the model that runs, not the workspace's unset preference", async () => {
  const { helperModel } = await import("./summarize.js");
  // A workspace with no review_model is the common case — the backend supplies the default, and
  // recording `ws.review_model` there would file the verdict under nothing.
  const bare = mkWs("mc-model");
  assert.equal(bare.review_model ?? null, null, "review_model is unset by default");
  assert.equal(helperModel(bare), "haiku", "claude-code backend supplies its own default");
  assert.notEqual(helperModel(bare), bare.review_model ?? null, "the two genuinely differ");

  // An explicit preference still wins.
  const picked = { ...bare, review_model: "opus" } as typeof bare;
  assert.equal(helperModel(picked), "opus");
  assert.equal(helperModel(picked, "sonnet"), "sonnet", "an explicit override beats both");
});
