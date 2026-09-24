/**
 * The dream pass (src/dream-pass.ts, src/dream.ts, src/dream-routes.ts): gather → plan → apply → undo,
 * the caps, the clocks, the archive, and the workspace wall on every door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { activity, db, dreamRuns, jobs, memoryClocks, memoryRelations, memoryUsage, notes, workspaces } from "./store.js";
import { captureLearnings, contextBlock, createNote, updateNote } from "./notes.js";
import {
  applyPlan, BRANCH_STALE_DAYS, CHUNK_LINES, dreamBranch, dreamContext, DreamError, dropEmptySections, inboxChunk,
  inboxLines, INDEX_STALE_DAYS, isBranch, memLines, queryNames, receiptLine, undoRun, type DreamPlan,
} from "./dream-pass.js";
import { activitySignals, isActive, pickActive, startDream } from "./dream.js";
import * as routes from "./dream-routes.js";
import { ARCHIVE_SLUG, HOT_SLUG, INBOX_SLUG, INDEX_SLUG } from "./memory-tree.js";
import { entryHash } from "./memory-tiers.js";
import { isReadOnlyRun } from "./runner.js";
import { isInternalJob } from "./job-name.js";
import { EPHEMERAL_JOB_PREFIXES, reapEphemeralJobs } from "./hygiene.js";
import type { Workspace } from "./types.js";

const mkWs = (slug: string): Workspace =>
  workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: `/tmp/dream-test/${slug}-${randomUUID()}` });
const body = (ws: Workspace, slug: string) => notes.bySlug(ws.id, slug)?.body ?? null;
const daysAgo = (n: number, now = new Date()) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const HEAD = "# Memory index\n\nOne line per rule, grouped by topic. `→ memory-x` = details in that memo (`mc memo get memory-x`).\n";
const id = (ws: Workspace, text: string) => inboxLines(body(ws, INBOX_SLUG) ?? "").find((l) => l.text === text)!.id;

function errOf(fn: () => unknown): DreamError {
  try { fn(); } catch (e) { if (e instanceof DreamError) return e; throw e; }
  assert.fail("expected a DreamError");
}

const fakeReq = (params: Record<string, string>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.type = () => r;
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}

// ───────────────────────────── reading memos ─────────────────────────────

test("memLines: prose without bullet, pointer or marker; pinned by section or marker; paragraphs count", () => {
  const lines = memLines(`${HEAD}\n## Git\n- Squash-merge only → memory-git\n\n## Pinned\n- Never force-push main\n\n## Db\n- Flyway only <!--P-->\n`);
  assert.deepEqual(lines.map((l) => [l.text, l.pointer, l.pinned, l.bullet]), [
    ["One line per rule, grouped by topic. `→ memory-x` = details in that memo (`mc memo get memory-x`).", null, false, false],
    ["Squash-merge only", "memory-git", false, true],
    ["Never force-push main", null, true, true],
    ["Flyway only", null, true, true],
  ]);
  assert.equal(lines[1].hash, entryHash("Squash-merge only"), "the pointer is not part of a rule's identity");
});

test("dropEmptySections removes a topic whose last line left, keeps the title and full topics", () => {
  assert.equal(dropEmptySections("# T\n\nintro\n\n## A\n\n## B\n- b\n"), "# T\n\nintro\n\n## B\n- b\n");
});

test("inboxChunk: oldest first, bounded by chars and lines, never empty when there is a line", () => {
  const lines = Array.from({ length: 300 }, (_, i) => ({ id: String(i), text: "x".repeat(100), from: null }));
  const c = inboxChunk(lines);
  assert.equal(c.length, CHUNK_LINES);
  assert.equal(c[0].id, "0");
  assert.equal(inboxChunk([{ id: "big", text: "y".repeat(50_000), from: null }]).length, 1, "one oversized line still moves the queue");
  assert.equal(inboxChunk(lines, 1000).length, 10);
});

test("isBranch: tree branches only — never index/hot/archive, persona memory or a stow archive", () => {
  const n = (slug: string, title = `Memory: ${slug}`, scope = "workspace") => ({ slug, title, scope } as any);
  assert.equal(isBranch(n("memory-git")), true);
  assert.equal(isBranch(n("memory-repo-shop-api")), true);
  for (const s of ["memory-index", "memory-hot", "memory-archive", "memory-archive-robert", "worklog"]) assert.equal(isBranch(n(s)), false, s);
  assert.equal(isBranch(n("memory-robert", "Memory — robert")), false, "persona memory is not the dream pass's");
  assert.equal(isBranch(n("memory-x", "Memory: x", "global")), false);
});

test("queryNames: two shared tokens, or the whole of a one-word query", () => {
  assert.equal(queryNames("flyway repair prod", "Never run flyway repair on prod"), true);
  assert.equal(queryNames("flyway", "Never run flyway repair on prod"), true);
  assert.equal(queryNames("deploy daemon", "Never run flyway repair on prod"), false);
});

// ───────────────────────────── gather → apply → undo ─────────────────────────────

function seedHappy() {
  const w = mkWs("dream-happy");
  captureLearnings(w.id, [
    "Deploy the daemon only with npm run deploy, which builds dist and restarts launchd",
    "PR 12 merged this afternoon",
    "Flyway migrations live in db/migrations and CI applies them on merge",
  ], "s1");
  return w;
}

function happyPlan(w: Workspace, run: string): DreamPlan {
  return {
    run,
    index: `${HEAD}\n## Deploy\n- Deploy only with \`npm run deploy\` → memory-deploy\n`,
    hot: "# Memory hot\n\n- Flyway rollout · migrations land via CI · next: first prod run\n",
    branches: { "memory-deploy": "# Memory: deploy\n\n- `npm run deploy` builds dist/ and restarts launchd\n- Flyway migrations live in db/migrations; CI applies them on merge\n" },
    inbox: [
      { id: id(w, "Deploy the daemon only with npm run deploy, which builds dist and restarts launchd"), to: "index" },
      { id: id(w, "PR 12 merged this afternoon"), to: "drop", why: "task status" },
      { id: id(w, "Flyway migrations live in db/migrations and CI applies them on merge"), to: "memory-deploy" },
    ],
    note: "first pass",
  };
}

test("gather: one bundle with the inbox chunk; the run is marked gathered with that chunk", () => {
  const w = seedHappy();
  const b = dreamContext(w);
  assert.equal(b.workspace.slug, w.slug);
  assert.equal(b.inbox.shown, 3);
  assert.equal(b.inbox.left_after_this_pass, 0);
  assert.equal(b.caps.index, 3000);
  const run = dreamRuns.get(b.run)!;
  assert.equal(run.status, "gathered");
  assert.deepEqual(JSON.parse(run.chunk!), b.inbox.lines.map((l) => l.id));
  assert.equal(dreamContext(w).run, b.run, "a second gather continues the open pass");
});

test("apply: writes index, hot and branch; empties the consumed inbox into the archive with provenance; receipt + activity", () => {
  const w = seedHappy();
  const b = dreamContext(w);
  const r = applyPlan(w, happyPlan(w, b.run));
  assert.equal(r.dry, false);
  assert.match(body(w, INDEX_SLUG)!, /## Deploy\n- Deploy only with `npm run deploy` → memory-deploy/);
  assert.equal(notes.bySlug(w.id, INDEX_SLUG)!.context, 1);
  assert.equal(notes.bySlug(w.id, HOT_SLUG)!.context, 1, "hot is always loaded");
  assert.equal(notes.bySlug(w.id, "memory-deploy")!.context, 0, "branches are on demand");
  assert.equal(inboxLines(body(w, INBOX_SLUG)!).length, 0, "consumed lines leave the inbox");
  const arc = body(w, ARCHIVE_SLUG)!;
  assert.match(arc, /PR 12 merged this afternoon — from session-learnings · [^\n]*s1 · triaged→drop \(task status\)/);
  assert.match(arc, /triaged→memory-deploy/);
  assert.match(arc, /triaged→index/);
  assert.equal(notes.bySlug(w.id, ARCHIVE_SLUG)!.context, 0, "the archive is never injected");
  assert.equal(r.stats.rules_added, 1);
  assert.equal(r.stats.inbox_triaged, 3);
  assert.equal(r.stats.hot_items, 1);
  assert.match(r.receipt, new RegExp(`^${w.slug}: \\+1 rule, 1 branch written, 3 inbox triaged, hot rebuilt \\(1 thread\\) — first pass$`));
  const run = dreamRuns.get(b.run)!;
  assert.equal(run.status, "applied");
  assert.equal(run.receipt, r.receipt);
  const ev = activity.list({ workspace_id: w.id, topic: "memory.dream" });
  assert.equal(ev[0].detail, r.receipt);
});

test("dry run validates and reports, writes nothing, leaves the pass open", () => {
  const w = seedHappy();
  const b = dreamContext(w);
  const before = body(w, INBOX_SLUG);
  const r = applyPlan(w, happyPlan(w, b.run), { dry: true });
  assert.equal(r.dry, true);
  assert.equal(r.stats.inbox_triaged, 3);
  assert.equal(body(w, INBOX_SLUG), before);
  assert.equal(body(w, INDEX_SLUG), null);
  assert.equal(dreamRuns.get(b.run)!.status, "gathered");
});

test("undo: memos, inbox, archive and status come back; a second undo is refused", () => {
  const w = seedHappy();
  const inboxBefore = inboxLines(body(w, INBOX_SLUG)!).map((l) => l.text).sort();
  const b = dreamContext(w);
  applyPlan(w, happyPlan(w, b.run));
  const undone = undoRun(w, b.run.slice(0, 8));
  assert.equal(undone.status, "undone");
  assert.equal(notes.bySlug(w.id, INDEX_SLUG), undefined, "created by the pass → removed");
  assert.equal(notes.bySlug(w.id, "memory-deploy"), undefined);
  assert.deepEqual(inboxLines(body(w, INBOX_SLUG)!).map((l) => l.text).sort(), inboxBefore);
  assert.doesNotMatch(body(w, ARCHIVE_SLUG) ?? "", /triaged→/, "the pass's archive block leaves with it");
  assert.equal(errOf(() => undoRun(w, b.run)).status, 409);
  assert.equal(activity.list({ workspace_id: w.id, topic: "memory.dream.undo" }).length, 1);
});

test("undo refuses to overwrite a memo edited after the pass, and goes newest first", () => {
  const w = seedHappy();
  const b1 = dreamContext(w);
  applyPlan(w, happyPlan(w, b1.run));
  captureLearnings(w.id, ["Staging lives at staging.example.test behind the VPN"], "s2");
  const b2 = dreamContext(w);
  assert.notEqual(b2.run, b1.run);
  applyPlan(w, { run: b2.run, hot: "- staging access · VPN\n", inbox: [{ id: b2.inbox.lines[0].id, to: "hot" }] });
  const e = errOf(() => undoRun(w, b1.run));
  assert.equal(e.status, 409);
  assert.match(e.message, /newer pass first/);
  updateNote(notes.bySlug(w.id, HOT_SLUG)!.id, { body: "- operator's own hot edit\n" });
  const e2 = errOf(() => undoRun(w, b2.run));
  assert.equal(e2.status, 409);
  assert.match(e2.message, /memory-hot/);
  assert.equal(body(w, HOT_SLUG), "- operator's own hot edit\n", "nothing was overwritten");
});

// ───────────────────────────── validation ─────────────────────────────

test("every line of the chunk must be decided; unknown ids and destinations are refused (400)", () => {
  const w = seedHappy();
  const b = dreamContext(w);
  const p = happyPlan(w, b.run);
  const e = errOf(() => applyPlan(w, { ...p, inbox: p.inbox!.slice(1) }));
  assert.equal(e.status, 400);
  assert.match(e.message, /1 line\(s\) of this pass's chunk are undecided/);
  const e2 = errOf(() => applyPlan(w, { ...p, inbox: [...p.inbox!.slice(1), { id: p.inbox![0].id, to: "memory-nowhere" }] }));
  assert.match(e2.message, /not drop\|drop-secret\|index\|hot\|conflict or a branch/);
  const e3 = errOf(() => applyPlan(w, { ...p, inbox: [...p.inbox!, { id: "deadbeef0000", to: "drop" }] }));
  assert.match(e3.message, /deadbeef0000 is not a line of the inbox/);
  assert.equal(inboxLines(body(w, INBOX_SLUG)!).length, 3, "a refused plan changes nothing");
});

test("caps are 409s that say what to condense — index, index line, hot, branch", () => {
  const w = seedHappy();
  const b = dreamContext(w);
  const p = happyPlan(w, b.run);
  const long = "x".repeat(201);
  const e = errOf(() => applyPlan(w, {
    ...p,
    index: `${HEAD}\n## Deploy\n- ${long}\n` + Array.from({ length: 40 }, (_, i) => `- rule number ${i} ${"y".repeat(60)}`).join("\n"),
    hot: "- " + "h".repeat(1600),
    branches: { "memory-deploy": "z".repeat(6001) },
  }));
  assert.equal(e.status, 409);
  assert.ok(e.problems.some((m) => /memory-index is \d+\/3000 chars/.test(m)));
  assert.ok(e.problems.some((m) => /memory-index line is 201\/200/.test(m)));
  assert.ok(e.problems.some((m) => /memory-hot is \d+\/1500/.test(m)));
  assert.ok(e.problems.some((m) => /memory-deploy is 600\d\/6000/.test(m)));
});

test("shape: rules need a topic, pointers must resolve, slugs must be tree slugs, repo branches need a repo", () => {
  const w = seedHappy();
  createNote({ workspace_id: w.id, title: "Runbook", body: "# Runbook\n" });
  const b = dreamContext(w);
  const p = happyPlan(w, b.run);
  const e = errOf(() => applyPlan(w, {
    ...p,
    index: `${HEAD}\n- orphan rule\n\n## Deploy\n- deploy rule → memory-ghost\n`,
    branches: { ...p.branches, "memory-index": "x", "Memory-Bad": "x", "memory-repo-nope": "x", runbook: "x" },
  }));
  assert.equal(e.status, 400);
  const all = e.problems.join("\n");
  assert.match(all, /every rule goes under a "## Topic" heading/);
  assert.match(all, /points at memory-ghost, which does not exist/);
  assert.match(all, /"memory-index" is not a branch slug/);
  assert.match(all, /"Memory-Bad" is not a branch slug/);
  assert.match(all, /memory-repo-nope names no repo of this workspace/);
  assert.match(all, /"runbook" is not a branch slug/);
});

test("pinned lines are the operator's: kept verbatim, and the dreamer cannot add one", () => {
  const w = seedHappy();
  createNote({ workspace_id: w.id, slug: INDEX_SLUG, title: "Memory index", context: true, body: `${HEAD}\n## Pinned\n- Never touch prod on Fridays\n` });
  const b = dreamContext(w);
  const p = happyPlan(w, b.run);
  const e = errOf(() => applyPlan(w, { ...p, index: `${HEAD}\n## Pinned\n- Ship whenever\n` }));
  assert.match(e.problems.join("\n"), /pinned line "Never touch prod on Fridays" must stay/);
  assert.match(e.problems.join("\n"), /"Ship whenever" is new under Pinned/);
});

// ───────────────────────────── nothing lost ─────────────────────────────

test("a line the plan rewrites away is archived with the plan's reason, or 'rewritten away'", () => {
  const w = mkWs("dream-lost");
  createNote({ workspace_id: w.id, slug: INDEX_SLUG, title: "Memory index", context: true, body: `${HEAD}\n## Git\n- Old rule A\n- Old rule B\n- Keeps its place\n` });
  const b = dreamContext(w);
  const r = applyPlan(w, {
    run: b.run, hot: "",
    index: `${HEAD}\n## Git\n- Keeps its place\n`,
    archive: [{ hash: entryHash("Old rule A"), reason: "superseded by the squash rule" }],
  });
  assert.equal(r.stats.archived, 2);
  const arc = body(w, ARCHIVE_SLUG)!;
  assert.match(arc, /- Old rule A — from memory-index · superseded by the squash rule/);
  assert.match(arc, /- Old rule B — from memory-index · rewritten away/);
  assert.doesNotMatch(arc, /Keeps its place/);
});

test("retiring a branch archives its lines; a line moved to another branch is not 'lost'", () => {
  const w = mkWs("dream-retire");
  createNote({ workspace_id: w.id, slug: "memory-old", title: "Memory: old", body: "# Memory: old\n\n- Moves over\n- Dies with it\n" });
  const b = dreamContext(w);
  applyPlan(w, { run: b.run, hot: "", branches: { "memory-old": null, "memory-new": "# Memory: new\n\n- Moves over\n" } });
  assert.equal(notes.bySlug(w.id, "memory-old"), undefined);
  const arc = body(w, ARCHIVE_SLUG)!;
  assert.match(arc, /- Dies with it — from memory-old · branch retired/);
  assert.doesNotMatch(arc, /Moves over/);
});

test("drop-secret: the text is kept nowhere — not the archive, not the undo snapshot", () => {
  const w = mkWs("dream-secret");
  captureLearnings(w.id, ["The staging password is hunter2-horse-battery"], "s1");
  const b = dreamContext(w);
  applyPlan(w, { run: b.run, hot: "", inbox: [{ id: b.inbox.lines[0].id, to: "drop-secret" }] });
  assert.doesNotMatch(body(w, ARCHIVE_SLUG)!, /hunter2/);
  assert.match(body(w, ARCHIVE_SLUG)!, /dropped as a secret — text not kept/);
  assert.doesNotMatch(dreamRuns.get(b.run)!.snapshot!, /hunter2/);
  undoRun(w, b.run);
  assert.doesNotMatch(body(w, INBOX_SLUG)!, /hunter2/, "undo does not resurrect it");
});

test("conflict: the standing line stays, an open conflicts_with row is recorded; undo removes it", () => {
  const w = mkWs("dream-conflict");
  createNote({ workspace_id: w.id, slug: INDEX_SLUG, title: "Memory index", context: true, body: `${HEAD}\n## Git\n- PRs target main\n` });
  captureLearnings(w.id, ["PRs in this workspace target develop, not main"], "s1");
  const b = dreamContext(w);
  const r = applyPlan(w, { run: b.run, hot: "", inbox: [{ id: b.inbox.lines[0].id, to: "conflict", with: entryHash("PRs target main"), why: "branch policy" }] });
  assert.equal(r.stats.conflicts, 1);
  const rel = memoryRelations.list({ workspace_id: w.id, status: "open" });
  assert.equal(rel.length, 1);
  assert.equal(rel[0].relation, "conflicts_with");
  assert.equal(rel[0].judged_by, "dreamer");
  assert.match(body(w, INDEX_SLUG)!, /PRs target main/);
  undoRun(w, b.run);
  assert.equal(memoryRelations.list({ workspace_id: w.id }).length, 0);
});

// ───────────────────────────── clocks: reinforcement requires evidence ─────────────────────────────

function seedAged(now = new Date()) {
  const w = mkWs("dream-clock");
  const idx = createNote({ workspace_id: w.id, slug: INDEX_SLUG, title: "Memory index", context: true, body:
    `${HEAD}\n## Git\n- Squash-merge only → memory-git\n- Rebase before pushing\n\n## Pinned\n- Never force-push main\n` });
  const git = createNote({ workspace_id: w.id, slug: "memory-git", title: "Memory: git", body: "# Memory: git\n\n- Squash-merge only, the repo settings enforce it\n- Old branch lore nobody reads\n" });
  const old = daysAgo(INDEX_STALE_DAYS + 5, now);
  for (const t of ["Squash-merge only", "Rebase before pushing", "Never force-push main", "Squash-merge only, the repo settings enforce it"]) memoryClocks.set(w.id, entryHash(t), old, old);
  memoryClocks.set(w.id, entryHash("Old branch lore nobody reads"), daysAgo(BRANCH_STALE_DAYS + 1, now), daysAgo(200, now));
  return { w, idx, git };
}

test("stale index line with no evidence is demoted to its branch; pinned lines never age", () => {
  const { w } = seedAged();
  const b = dreamContext(w);
  const r = applyPlan(w, { run: b.run, hot: "" });
  assert.equal(r.stats.demoted, 2);
  const idx = body(w, INDEX_SLUG)!;
  assert.doesNotMatch(idx, /Squash-merge only → memory-git/);
  assert.doesNotMatch(idx, /## Git/, "an emptied topic heading goes too");
  assert.match(idx, /Never force-push main/);
  const git = body(w, "memory-git")!;
  assert.match(git, /- Squash-merge only\n/, "demoted into the branch it pointed at");
  assert.match(git, /- Rebase before pushing\n/, "no pointer → the branch of its topic");
  assert.match(body(w, ARCHIVE_SLUG)!, /- Old branch lore nobody reads — from memory-git · unreinforced 91d/);
  assert.doesNotMatch(body(w, ARCHIVE_SLUG)!, /Squash-merge only — from/, "demoted ≠ archived");
});

test("a read of the branch it points at keeps an index line (and restamps its clock)", () => {
  const { w, git } = seedAged();
  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: git.id, source: "api" });
  const b = dreamContext(w);
  const r = applyPlan(w, { run: b.run, hot: "" });
  assert.match(body(w, INDEX_SLUG)!, /Squash-merge only → memory-git/);
  assert.equal(memoryClocks.map(w.id).get(entryHash("Squash-merge only"))!.reinforced, new Date().toISOString().slice(0, 10));
  assert.ok(r.stats.reinforced >= 2, "the branch lines were read too");
  assert.match(body(w, "memory-git")!, /Old branch lore/, "the read also reinforced the stale branch line");
});

test("a recall that names the line, or an inbox fact that re-learns it, is evidence; the dreamer's say-so is not", () => {
  const { w, idx } = seedAged();
  memoryUsage.add({ workspace_id: w.id, kind: "recall_hit", ref_kind: "note", ref: idx.id, query: "rebase pushing", source: "api" });
  captureLearnings(w.id, ["Always squash-merge only, the repo enforces it"], "s9");
  const b = dreamContext(w);
  const bogus = errOf(() => applyPlan(w, { run: b.run, hot: "", inbox: [{ id: b.inbox.lines[0].id, to: "drop" }], reinforce: [{ hash: entryHash("Squash-merge only"), by: "nope" }] }));
  assert.match(bogus.message, /"by" must be an inbox id this plan consumes/);
  applyPlan(w, { run: b.run, hot: "", inbox: [{ id: b.inbox.lines[0].id, to: "memory-git" }] });
  const idxBody = body(w, INDEX_SLUG)!;
  assert.match(idxBody, /Rebase before pushing/, "recalled by name");
  assert.match(idxBody, /Squash-merge only → memory-git/, "re-learned");
});

test("rewording a stale rule does not reset its clock", () => {
  const { w } = seedAged();
  const b = dreamContext(w);
  applyPlan(w, { run: b.run, hot: "", index: `${HEAD}\n## Git\n- Squash-merge only, always → memory-git\n\n## Pinned\n- Never force-push main\n` });
  assert.doesNotMatch(body(w, INDEX_SLUG)!, /Squash-merge only, always/, "inherited the old clock → demoted");
  assert.match(body(w, "memory-git")!, /Squash-merge only, always/);
});

// ───────────────────────────── injection ─────────────────────────────

test("contextBlock order: the index first, hot right after, then other ★ memos — within budget with a full operator profile", () => {
  const w = mkWs("dream-inject");
  createNote({ workspace_id: w.id, title: "Aaa big context memo", context: true, body: "A".repeat(7000) });
  createNote({ workspace_id: w.id, slug: HOT_SLUG, title: "Memory hot", context: true, body: "- hot thread\n" + "h".repeat(1480) });
  createNote({ workspace_id: w.id, slug: INDEX_SLUG, title: "Memory index", context: true, body: `${HEAD}\n## Git\n- rule\n` + "i".repeat(2800) });
  const home = mkWs("dream-inject-home");
  const g = createNote({ workspace_id: home.id, title: `Operator profile ${randomUUID().slice(0, 4)}`, context: true, body: "P".repeat(1900) });
  updateNote(g.id, { scope: "global" });
  try {
    const ctx = contextBlock(w.id);
    const iIdx = ctx.indexOf("(memory-index)");
    const iHot = ctx.indexOf("(memory-hot)");
    assert.ok(iIdx > 0 && iHot > iIdx, "index, then hot");
    assert.ok(ctx.includes("h".repeat(1480)), "hot is whole");
    assert.ok(ctx.includes("i".repeat(2800)), "the index is whole");
    assert.ok(!ctx.includes("A".repeat(7000)), "the big memo is the one that gets cut");
  } finally {
    updateNote(g.id, { scope: "workspace", context: false });
  }
});

// ───────────────────────────── the wall ─────────────────────────────

test("every dream door is walled: another workspace's token gets 404; a run id of another workspace is 404", () => {
  const a = seedHappy();
  const bws = mkWs("dream-wall-b");
  const tokA = workspaces.get(a.id)!.token!;
  const tokB = workspaces.get(bws.id)!.token!;
  const bundleA = dreamContext(a);
  createNote({ workspace_id: a.id, slug: "memory-secret-stuff", title: "Memory: secret stuff", body: "# A's detail\n" });

  const cross = { "x-mc-workspace-token": tokB };
  const calls: [string, (req: any, res: any) => void, any][] = [
    ["context", routes.contextRoute, fakeReq({ id: a.id }, cross)],
    ["branch", routes.branchRoute, fakeReq({ id: a.id, slug: "memory-secret-stuff" }, cross)],
    ["apply", routes.applyRoute, fakeReq({ id: a.id }, cross, { body: happyPlan(a, bundleA.run) })],
    ["runs", routes.runsRoute, fakeReq({ id: a.id }, cross)],
    ["undo", routes.undoRoute, fakeReq({ id: a.id, run: bundleA.run }, cross)],
  ];
  for (const [name, fn, req] of calls) {
    const res = fakeRes();
    fn(req, res);
    assert.equal(res.statusCode, 404, `${name} crossed the wall`);
  }
  // B's own door, A's run id: still not found — and A's pass is untouched.
  const own = { "x-mc-workspace-token": tokB };
  const r1 = fakeRes();
  routes.contextRoute(fakeReq({ id: bws.id }, own, { query: { run: bundleA.run } }), r1);
  assert.equal(r1.statusCode, 404);
  const r2 = fakeRes();
  routes.applyRoute(fakeReq({ id: bws.id }, own, { body: { ...happyPlan(a, bundleA.run) } }), r2);
  assert.equal(r2.statusCode, 404);
  assert.equal(errOf(() => dreamBranch(bws, "memory-secret-stuff")).status, 404);
  assert.equal(dreamRuns.get(bundleA.run)!.status, "gathered");
  // A's own token works.
  const r3 = fakeRes();
  routes.runsRoute(fakeReq({ id: a.id }, { "x-mc-workspace-token": tokA }, { query: {} }), r3);
  assert.equal(r3.statusCode, 200);
  assert.ok(r3.body.runs.every((x: any) => x.snapshot === undefined), "snapshots never leave the daemon");
});

test("POST /dream/run is admin-only", () => {
  const w = mkWs("dream-admin");
  const res = fakeRes();
  routes.runNowRoute(fakeReq({}, { "x-mc-workspace-token": workspaces.get(w.id)!.token! }, { body: { workspace: w.slug } }), res);
  assert.equal(res.statusCode, 403);
  const res2 = fakeRes();
  routes.runNowRoute(fakeReq({}, {}, { body: { workspace: w.slug } }), res2);
  assert.equal(res2.statusCode, 403, "no header is not admin either");
});

// ───────────────────────────── scheduling ─────────────────────────────

test("isActive: an inbox backlog always counts; everything else only when new", () => {
  const none = { inbox_lines: 0, worklog_changed: false, sessions_ended: 0, lessons_new: 0, usage_rows: 0 };
  assert.equal(isActive(none), false);
  for (const k of Object.keys(none) as (keyof typeof none)[]) assert.equal(isActive({ ...none, [k]: k === "worklog_changed" ? true : 1 }), true, k);
  const ws = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(pickActive(ws, (w) => ({ ...none, inbox_lines: w.id === "b" ? 3 : 0 })).map((w) => w.id), ["b"]);
});

test("activitySignals: counts only what happened after the last pass", () => {
  const w = mkWs("dream-signals");
  assert.equal(isActive(activitySignals(w, null)), false, "a brand-new workspace has nothing to dream about");
  memoryUsage.add({ workspace_id: w.id, kind: "recall", query: "x", hits: 0, source: "api", ts: "2026-01-01T00:00:00.000Z" });
  assert.equal(activitySignals(w, null).usage_rows, 1);
  assert.equal(activitySignals(w, "2026-02-01T00:00:00.000Z").usage_rows, 0);
  captureLearnings(w.id, ["Something durable about the build"], "s");
  assert.equal(activitySignals(w, new Date().toISOString()).inbox_lines, 1, "a backlog is activity whatever the date");
});

test("startDream: one read-only dream: job on the workspace's profile and default model, no code-writing tools", () => {
  const w = mkWs("dream-start");
  const seen: string[] = [];
  const r = startDream(w, { source: "manual", dispatch: ((jobId: string) => { seen.push(jobId); return { run_id: "fake-run", status: "queued" }; }) as any });
  assert.equal(r.error, undefined);
  const job = jobs.get(seen[0])!;
  assert.equal(job.name, `dream:${w.slug}`);
  assert.equal(job.workspace_id, w.id);
  assert.equal(job.backend, "claude-code");
  assert.equal(job.model, null, "the profile's default model, never haiku");
  assert.equal(job.disallowed_tools, "Edit,Write,MultiEdit,NotebookEdit");
  assert.equal(job.retry_max, 0);
  assert.match(job.append_system!, /You are the DREAMER/);
  assert.match(job.goal, new RegExp(`mc dream context --run ${r.run}`));
  const run = dreamRuns.get(r.run!)!;
  assert.equal(run.job_id, job.id);
  assert.equal(run.run_id, "fake-run");
  // A second start supersedes the open pass (its job run is not live).
  const r2 = startDream(w, { source: "manual", dispatch: (() => ({ run_id: "fake-2", status: "queued" })) as any });
  assert.equal(dreamRuns.get(r.run!)!.status, "abandoned");
  assert.notEqual(r2.run, r.run);
  const failed = startDream(w, { source: "slot", slot: "2026-09-23@13", dispatch: (() => ({ error: "daily budget reached" })) as any });
  assert.equal(failed.error, "daily budget reached");
  assert.equal(dreamRuns.get(failed.run!)!.status, "failed");
});

test("dream: runs are read-only, internal, and reaped as ephemeral once done", () => {
  assert.equal(isReadOnlyRun("dream:gfm"), true);
  assert.equal(isReadOnlyRun("fallback:dream:gfm"), true);
  assert.equal(isInternalJob("dream:gfm"), true);
  assert.ok(EPHEMERAL_JOB_PREFIXES.includes("dream:"));
  const w = mkWs("dream-reap");
  const job = jobs.create({ name: `dream:${w.slug}`, goal: "x", workspace_id: w.id, trigger_type: "manual" });
  db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(new Date(Date.now() - 3 * 86_400_000).toISOString(), job.id);
  reapEphemeralJobs();
  assert.equal(jobs.get(job.id), undefined);
});

test("receiptLine: one line, only what happened", () => {
  const s = { rules_before: 4, rules_after: 5, rules_added: 1, demoted: 0, archived: 0, inbox_triaged: 0, inbox_left: 0, hot_items: 3, branches_written: [], branches_retired: [], reinforced: 0, conflicts: 0 };
  assert.equal(receiptLine("gfm", s), "gfm: +1 rule, hot rebuilt (3 threads)");
  assert.equal(receiptLine("gfm", { ...s, rules_added: 3, rules_after: 5, archived: 12, inbox_triaged: 40, inbox_left: 360, demoted: 2 }),
    "gfm: +3 rules, 4→5 in index, 2 demoted, 12 archived, 40 inbox triaged (360 left), hot rebuilt (3 threads)");
});

// Keep CONFIG referenced so a future admin-token test can flip it without a new import.
void CONFIG;
