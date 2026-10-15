import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { notes, skills, workspaces, repos, searchIndex } from "./store.js";
import { validScope, contextBlock, createNote, captureLearnings } from "./notes.js";
import { relevanceBlock } from "./recall.js";
import type { Note, Skill } from "./types.js";

const mkWs = (slug: string) => workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}-${randomUUID()}` });

function seedNote(p: { ws: string; title: string; context?: boolean; scope?: "workspace" | "global"; body?: string; repo_ids?: string[] | null }): Note {
  const ts = new Date().toISOString();
  const slug = `${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const row: Note = {
    id: randomUUID(), workspace_id: p.ws, title: p.title, slug, file_path: `/tmp/${slug}.md`,
    body: p.body ?? `# ${p.title}\nbody`, pinned: 0, context: p.context ? 1 : 0,
    scope: p.scope ?? "workspace", repo_ids: p.repo_ids ?? null, created_at: ts, updated_at: ts,
  };
  return notes.insert(row);
}

const mkRepo = (ws: string, name: string) =>
  repos.create({ workspace_id: ws, name, path: `/tmp/mc-test/${name}-${randomUUID()}` });

function seedSkill(ws: string, name: string): Skill {
  const ts = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const row: Skill = {
    id: randomUUID(), workspace_id: ws, slug, name, description: name, category: null, tags: null,
    status: "active", version: 1, usage_count: 0, last_used_at: null, file_path: `/tmp/${slug}/SKILL.md`,
    source: "operator", created_at: ts, updated_at: ts,
  };
  return skills.insert(row);
}

// ───────────────────────────── Feature A: scope + global injection ─────────────────────────────

test("validScope defaults to workspace and rejects unknown values", () => {
  assert.equal(validScope(undefined), "workspace");
  assert.equal(validScope("workspace"), "workspace");
  assert.equal(validScope("global"), "global");
  assert.throws(() => validScope("client"));
  assert.throws(() => validScope("GLOBAL"));
});

test("globalContextNotes returns only scope=global AND context=1, across workspaces", () => {
  const a = mkWs("gcn-a"), b = mkWs("gcn-b");
  const g = seedNote({ ws: a.id, title: "Operator bio", scope: "global", context: true });
  seedNote({ ws: a.id, title: "Global-but-unflagged", scope: "global", context: false });
  seedNote({ ws: b.id, title: "Workspace note", scope: "workspace", context: true });
  const got = notes.globalContextNotes();
  assert.ok(got.some((n) => n.id === g.id), "returns the flagged global note");
  assert.ok(got.every((n) => n.scope === "global" && n.context === 1), "only global+context rows");
  assert.ok(!got.some((n) => n.title === "Global-but-unflagged"), "excludes unflagged global");
  assert.ok(!got.some((n) => n.title === "Workspace note"), "excludes workspace-scope");
});

test("contextBlock puts the operator profile before workspace notes and injects across workspaces", () => {
  const a = mkWs("cb-a"), b = mkWs("cb-b");
  seedNote({ ws: a.id, title: "About the operator", scope: "global", context: true, body: "Operator prefers TDD." });
  seedNote({ ws: b.id, title: "B house style", scope: "workspace", context: true, body: "Two-space indent." });
  const block = contextBlock(b.id); // global note lives in A, still injected into B
  assert.match(block, /Operator profile — applies across all workspaces/);
  assert.match(block, /Standing workspace notes/);
  assert.ok(block.indexOf("Operator profile") < block.indexOf("Standing workspace notes"), "global section first");
  assert.match(block, /Operator prefers TDD/);
  assert.match(block, /Two-space indent/);
});

test("contextBlock does not duplicate a global note whose home is the current workspace", () => {
  const w = mkWs("cb-dup");
  seedNote({ ws: w.id, title: "Operator profile note", scope: "global", context: true, body: "unique-marker-xyz" });
  seedNote({ ws: w.id, title: "Local note", scope: "workspace", context: true });
  const block = contextBlock(w.id);
  assert.equal(block.split("unique-marker-xyz").length - 1, 1, "global body appears exactly once");
});

test("contextBlock caps the operator-profile section at GLOBAL_CAP", () => {
  const w = mkWs("cb-cap");
  seedNote({ ws: w.id, title: "Huge profile", scope: "global", context: true, body: "x".repeat(3000) });
  const block = contextBlock(w.id);
  assert.match(block, /truncated at 2000 chars/);
});

// ───────────────────────────── Feature A2: repo-scoped context memos ─────────────────────────────

test("contextBlock: a repo-scoped memo loads only for agents in one of its repos", () => {
  const w = mkWs("rs-load");
  const docs = mkRepo(w.id, "inventory-docs"), other = mkRepo(w.id, "orders-api");
  seedNote({ ws: w.id, title: "Northstar", context: true, body: "design-doc-marker", repo_ids: [docs.id] });
  // agent in the scoped repo → memo present
  assert.match(contextBlock(w.id, docs.id), /design-doc-marker/, "loads for in-scope repo");
  // agent in a different repo → memo absent
  assert.ok(!/design-doc-marker/.test(contextBlock(w.id, other.id)), "hidden for out-of-scope repo");
  // no-repo agent (workspace chat) → memo absent
  assert.ok(!/design-doc-marker/.test(contextBlock(w.id, null)), "hidden for no-repo agent");
  assert.ok(!/design-doc-marker/.test(contextBlock(w.id)), "hidden when repo_id omitted");
});

test("contextBlock: a workspace-wide memo still loads for every agent (repo or not)", () => {
  const w = mkWs("rs-wide");
  const r = mkRepo(w.id, "some-repo");
  seedNote({ ws: w.id, title: "Wide note", context: true, body: "wide-marker" });
  assert.match(contextBlock(w.id, r.id), /wide-marker/, "loads for a repo agent");
  assert.match(contextBlock(w.id, null), /wide-marker/, "loads for a no-repo agent");
});

test("contextBlock: a memo scoped to multiple repos loads for each of them", () => {
  const w = mkWs("rs-multi");
  const a = mkRepo(w.id, "repo-a"), b = mkRepo(w.id, "repo-b"), c = mkRepo(w.id, "repo-c");
  seedNote({ ws: w.id, title: "Two repos", context: true, body: "multi-marker", repo_ids: [a.id, b.id] });
  assert.match(contextBlock(w.id, a.id), /multi-marker/);
  assert.match(contextBlock(w.id, b.id), /multi-marker/);
  assert.ok(!/multi-marker/.test(contextBlock(w.id, c.id)), "hidden for a repo not in the list");
});

test("createNote validates repo_ids belong to the workspace and clears empty→null", () => {
  const w = mkWs("rs-valid"), foreign = mkWs("rs-foreign");
  const mine = mkRepo(w.id, "mine"), theirs = mkRepo(foreign.id, "theirs");
  // valid repo id → stored as an array
  const ok = createNote({ workspace_id: w.id, title: "Scoped", context: true, repo_ids: [mine.id] });
  assert.deepEqual(ok.repo_ids, [mine.id]);
  // foreign repo id → rejected
  assert.throws(() => createNote({ workspace_id: w.id, title: "Bad", context: true, repo_ids: [theirs.id] }), /not in this workspace/);
  // empty array → workspace-wide (null)
  const wide = createNote({ workspace_id: w.id, title: "Wide2", context: true, repo_ids: [] });
  assert.equal(wide.repo_ids, null);
});

// ───────────────────────────── Feature B: FTS relevance injection ─────────────────────────────

test("relevanceBlock surfaces matching notes/skills and never event/session kinds", () => {
  const w = mkWs("rel-a");
  const n = seedNote({ ws: w.id, title: "Widget deploy runbook", context: true });
  searchIndex.add({ kind: "note", ref_id: n.id, workspace: w.id, title: n.title, body: "how to deploy the widget to staging safely" });
  const s = seedSkill(w.id, "deploy-widget");
  searchIndex.add({ kind: "skill", ref_id: s.id, workspace: w.id, title: s.name, body: "procedure for widget deploy rollout" });
  // Noise that must never leak into the block:
  searchIndex.add({ kind: "event", ref_id: randomUUID(), workspace: w.id, title: "widget deploy transcript", body: "widget deploy widget deploy noisy transcript" });
  searchIndex.add({ kind: "session", ref_id: randomUUID(), workspace: w.id, title: "widget deploy session", body: "widget deploy session chatter" });

  const block = relevanceBlock({ id: w.id }, "widget deploy", [], "REL-1");
  assert.match(block, /Possibly relevant workspace knowledge/);
  assert.match(block, new RegExp(`mc memo get ${n.slug}`));
  assert.match(block, new RegExp(`mc skill view ${s.slug}`));
  assert.ok(!/transcript/.test(block), "no event kind");
  assert.ok(!/chatter/.test(block), "no session kind");
});

test("relevanceBlock returns empty string when nothing matches or query is blank", () => {
  const w = mkWs("rel-b");
  assert.equal(relevanceBlock({ id: w.id }, "", []), "");
  assert.equal(relevanceBlock({ id: w.id }, "nonexistent-term-zzz", []), "");
});

test("relevanceBlock strips FTS snippet highlight brackets", () => {
  const w = mkWs("rel-c");
  const n = seedNote({ ws: w.id, title: "Caching guide", context: true });
  searchIndex.add({ kind: "note", ref_id: n.id, workspace: w.id, title: n.title, body: "enable redis caching for the api layer" });
  const block = relevanceBlock({ id: w.id }, "caching", []);
  assert.match(block, /caching/);
  assert.ok(!block.includes("["), "no open bracket marker");
  assert.ok(!block.includes("]"), "no close bracket marker");
});

// ───────────────────────────── session-learnings capture ─────────────────────────────

test("captureLearnings skips near-duplicate bullets and keeps distinct facts", () => {
  const w = mkWs("learn-dedupe");
  const first = captureLearnings(w.id, ["Flyway migrations live under db/migration and are never edited once applied."], "s1");
  assert.ok(first);
  assert.match(first!.body, /Flyway migrations live under/);

  const again = captureLearnings(
    w.id,
    [
      "Flyway migrations live under db/migrations and are never edited once applied.", // near-dup
      "Redshift unload needs explicit IAM role on the COPY.", // new
    ],
    "s2",
  );
  assert.ok(again);
  const flywayCount = (again!.body.match(/Flyway migrations/g) || []).length;
  assert.equal(flywayCount, 1, "near-duplicate flyway bullet must not be written twice");
  assert.match(again!.body, /Redshift unload/);
});

test("captureLearnings returns the memo unchanged when every fact is a duplicate", () => {
  const w = mkWs("learn-noop");
  captureLearnings(w.id, ["Prefer the existing Button component over new markup."], "a");
  const before = notes.bySlug(w.id, "session-learnings")!.body;
  const after = captureLearnings(w.id, ["Prefer the existing Button component over new markup."], "b");
  assert.equal(after!.body, before);
});
