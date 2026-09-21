import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { notes, sessions, workspaces } from "./store.js";
import { contextBlock, updateNote } from "./notes.js";
import { INDEX_CAP, INDEX_SLUG, indexSections, markMemorySeen, memoryNotice, rememberFact } from "./memory-tree.js";
import type { Note } from "./types.js";

const mkWs = (slug: string) => workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: `/tmp/mc-test/${slug}-${randomUUID()}` });

function seedNote(ws: string, title: string, body: string, extra: Partial<Note> = {}): Note {
  const ts = new Date().toISOString();
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  return notes.insert({
    id: randomUUID(), workspace_id: ws, title, slug, file_path: `/tmp/${slug}.md`, body, pinned: 0, context: 1,
    scope: "workspace", repo_ids: null, created_at: ts, updated_at: ts, ...extra,
  });
}

test("remember creates the ★ index and files lines under their topics", () => {
  const w = mkWs("mem-topics");
  const a = rememberFact(w.id, { fact: "PRs to shop-* target develop", topic: "git" });
  const b = rememberFact(w.id, { fact: "Never run flyway repair on prod", topic: "db" });
  const c = rememberFact(w.id, { fact: "Squash-merge only", topic: "Git" });
  assert.ok(a.ok && b.ok && c.ok);
  const idx = notes.bySlug(w.id, INDEX_SLUG)!;
  assert.equal(idx.context, 1, "the index is always loaded");
  assert.deepEqual(indexSections(idx.body), [
    { topic: "Git", lines: ["PRs to shop-* target develop", "Squash-merge only"] },
    { topic: "Db", lines: ["Never run flyway repair on prod"] },
  ]);
});

test("remember skips a near-duplicate line", () => {
  const w = mkWs("mem-dup");
  rememberFact(w.id, { fact: "PRs to shop repos target the develop branch", topic: "git" });
  const r = rememberFact(w.id, { fact: "PRs to shop repos target the develop branch.", topic: "git" });
  assert.ok(r.ok && !r.added);
  assert.equal(indexSections(notes.bySlug(w.id, INDEX_SLUG)!.body)[0].lines.length, 1);
});

test("detail goes to the topic branch and the index line points at it", () => {
  const w = mkWs("mem-branch");
  const r = rememberFact(w.id, { fact: "Target develop", topic: "Git flow", detail: "main deploys to prod on merge" });
  assert.ok(r.ok && r.branch);
  assert.equal(r.branch!.slug, "memory-git-flow");
  assert.equal(r.branch!.context, 0, "branches load on demand, not every prompt");
  assert.match(r.branch!.body, /main deploys to prod on merge/);
  assert.match(notes.bySlug(w.id, INDEX_SLUG)!.body, /- Target develop → memory-git-flow/);
});

test("remember refuses a long line and an index past its cap instead of growing", () => {
  const w = mkWs("mem-cap");
  const long = rememberFact(w.id, { fact: "x".repeat(201) });
  assert.ok(!long.ok && /capped at 200/.test(long.error));
  let refused = "";
  for (let i = 0; i < 40 && !refused; i++) {
    const r = rememberFact(w.id, { fact: `rule number ${i} ${randomUUID()} ${"word ".repeat(20)}`, topic: "t" });
    if (!r.ok) refused = r.error;
  }
  assert.match(refused, /memory index would pass/);
  assert.ok(notes.bySlug(w.id, INDEX_SLUG)!.body.length <= INDEX_CAP);
});

test("contextBlock loads the index first, and one oversized memo no longer starves the rest", () => {
  const w = mkWs("mem-budget");
  seedNote(w.id, "Aaa huge pinned design doc", "D".repeat(33000), { pinned: 1 });
  seedNote(w.id, "Flyway audit", "flyway-audit-marker");
  rememberFact(w.id, { fact: "index-line-marker", topic: "general" });
  const block = contextBlock(w.id);
  assert.match(block, /index-line-marker/);
  assert.match(block, /flyway-audit-marker/, "a small memo after a huge one still loads");
  assert.ok(block.indexOf("index-line-marker") < block.indexOf("flyway-audit-marker"), "index first");
  assert.match(block, /mc memo get aaa-huge-pinned-design-doc/, "the cut memo says where the rest is");
  assert.ok(block.length < 8000 + 1000);
});

test("memoryNotice hands a live terminal the ★ memos changed since its spawn, once", () => {
  const w = mkWs("mem-notice");
  const s = sessions.create({ workspace_id: w.id, cwd: "/tmp", backend: "claude-code" });
  markMemorySeen(s.id, new Date(Date.now() - 1000).toISOString());
  assert.equal(memoryNotice(s.id), "", "nothing changed");
  rememberFact(w.id, { fact: "fresh-rule-marker" });
  const n = memoryNotice(s.id);
  assert.match(n, /Workspace memory changed/);
  assert.match(n, /fresh-rule-marker/);
  assert.equal(memoryNotice(s.id), "", "not repeated on the next prompt");
  const other = seedNote(w.id, "Not loaded", "x", { context: 0 });
  updateNote(other.id, { body: "changed but not ★" });
  assert.equal(memoryNotice(s.id), "", "non-★ changes are not pushed");
});
