import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { notes, skills, sessions, workspaces, searchIndex, lessons as lessonStore } from "./store.js";
import { recall, renderRecall, memoryBlock } from "./recall.js";
import { hygieneDue } from "./hygiene.js";
import type { Note, Skill } from "./types.js";

const mkWs = (slug: string) => workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}-${randomUUID()}` });

function seedNote(p: { ws: string; title: string; context?: boolean; body?: string }): Note {
  const ts = new Date().toISOString();
  const slug = `${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const row: Note = {
    id: randomUUID(), workspace_id: p.ws, title: p.title, slug, file_path: `/tmp/${slug}.md`,
    body: p.body ?? `# ${p.title}\nbody`, pinned: 0, context: p.context ? 1 : 0,
    scope: "workspace", repo_ids: null, created_at: ts, updated_at: ts,
  };
  const n = notes.insert(row);
  searchIndex.add({ kind: "note", ref_id: n.id, workspace: p.ws, title: n.title, body: n.body });
  return n;
}

function seedSkill(ws: string, name: string, description: string): Skill {
  const ts = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const row: Skill = {
    id: randomUUID(), workspace_id: ws, slug, name, description, category: null, tags: null,
    status: "active", version: 1, usage_count: 0, last_used_at: null, file_path: `/tmp/${slug}/SKILL.md`,
    source: "operator", created_at: ts, updated_at: ts,
  };
  const s = skills.insert(row);
  searchIndex.add({ kind: "skill", ref_id: s.id, workspace: ws, title: s.name, body: s.description });
  return s;
}

// ───────────────────────────── recall ─────────────────────────────

test("recall finds notes, skills, sessions and lessons in one query, with read-in-full pointers", () => {
  const w = mkWs("rc-all");
  const n = seedNote({ ws: w.id, title: "Flyway conventions", body: "Flyway migrations live in db/migrations; never edit an applied one." });
  const sk = seedSkill(w.id, "run-flyway-repair", "when a flyway checksum mismatches, run repair");
  const sess = sessions.create({ workspace_id: w.id, title: "fix flyway drift", backend: "claude-code", cwd: "/tmp" });
  searchIndex.add({ kind: "session", ref_id: sess.id, workspace: w.id, title: "fix flyway drift", body: "repaired flyway checksums after hotfix" });
  lessonStore.create({ workspace_id: w.id, repo_id: null, scope: null, topic: "build", rule: "Run flyway repair before retrying a failed migration.", source: "operator", source_ref: null, state: "active" });

  const hits = recall(w.id, "flyway");
  const kinds = new Set(hits.map((h) => h.kind));
  assert.ok(kinds.has("note") && kinds.has("skill") && kinds.has("session") && kinds.has("lesson"), `all kinds surface: ${[...kinds]}`);
  assert.equal(hits.find((h) => h.kind === "note")!.open, `mc memo get ${n.slug}`);
  assert.equal(hits.find((h) => h.kind === "skill")!.open, `mc skill view ${sk.slug}`);
  const sessHit = hits.find((h) => h.kind === "session")!;
  assert.equal(sessHit.open, `mc session focus ${sess.id.slice(0, 8)}`);
  assert.equal(sessHit.source_ref, sess.id);
  assert.ok(sessHit.age);
  const lessonHit = hits.find((h) => h.kind === "lesson")!;
  assert.ok(lessonHit.open?.startsWith("lesson"));
  assert.ok(lessonHit.source_ref);
});

test("recall drops unrelated lessons and caps the combined result set", () => {
  const w = mkWs("rc-cap");
  for (let i = 0; i < 6; i++) {
    seedNote({ ws: w.id, title: `Flyway note ${i}`, body: `flyway migration convention number ${i}` });
  }
  lessonStore.create({
    workspace_id: w.id, repo_id: null, scope: null, topic: "build",
    rule: "Never widen a public API without a deprecation note.",
    source: "operator", source_ref: null, state: "active",
  });
  const hits = recall(w.id, "flyway", 5);
  assert.ok(hits.length <= 5, `capped at limit, got ${hits.length}`);
  assert.ok(!hits.some((h) => h.kind === "lesson"), "zero-overlap lesson must not pad the result");
});

test("recall: an unrelated query returns no lessons", () => {
  const w = mkWs("rc-noise");
  lessonStore.create({
    workspace_id: w.id, repo_id: null, scope: null, topic: "build",
    rule: "Timestamps must be UTC at the API edge.",
    source: "operator", source_ref: null, state: "active",
  });
  assert.deepEqual(recall(w.id, "redshift warehouse refresh gotcha"), []);
});

test("recall is workspace-walled: another workspace's memory never surfaces", () => {
  const mine = mkWs("rc-mine"), theirs = mkWs("rc-theirs");
  seedNote({ ws: theirs.id, title: "Their secret roadmap", body: "clientzz confidential roadmap details" });
  seedNote({ ws: mine.id, title: "My note", body: "clientzz roadmap as seen from my own workspace" });
  const hits = recall(mine.id, "clientzz roadmap");
  assert.ok(hits.length > 0, "own workspace still matches");
  assert.ok(!hits.some((h) => h.title.includes("Their secret")), "cross-workspace hit leaked");
});

test("recall returns nothing without a workspace or query — never an unscoped search", () => {
  const w = mkWs("rc-empty");
  seedNote({ ws: w.id, title: "Something", body: "searchable body text here" });
  assert.deepEqual(recall("", "searchable"), []);
  assert.deepEqual(recall(w.id, "   "), []);
});

test("renderRecall guards and formats; empty result says so", () => {
  const w = mkWs("rc-render");
  const n = seedNote({ ws: w.id, title: "Deploy notes", body: "deploys go through jenkins stage first" });
  const text = renderRecall(w.id, "jenkins deploy", recall(w.id, "jenkins deploy"));
  assert.match(text, /memory hit/);
  assert.match(text, new RegExp(`mc memo get ${n.slug}`));
  assert.match(renderRecall(w.id, "zzz", []), /no memory matching/);
});

// ───────────────────────────── memoryBlock ─────────────────────────────

test("memoryBlock indexes non-context memo slugs only and carries the contract", () => {
  const w = mkWs("mb-ws");
  const plain = seedNote({ ws: w.id, title: "Runbook", body: "x" });
  const starred = seedNote({ ws: w.id, title: "Injected already", context: true, body: "y" });
  const block = memoryBlock(w.id);
  assert.match(block, /mc recall/);
  assert.match(block, /mc learn/);
  assert.match(block, /private to THIS workspace/);
  assert.ok(block.includes(plain.slug), "plain memo indexed");
  assert.ok(!block.includes(starred.slug), "★ memo not re-indexed (already injected in full)");
  assert.ok(!block.includes("never edit an applied"), "no bodies injected");
});

test("memoryBlock caps the index instead of growing with the vault", () => {
  const w = mkWs("mb-cap");
  for (let i = 0; i < 60; i++) seedNote({ ws: w.id, title: `Long memo title number ${i} padding padding`, body: "b" });
  const block = memoryBlock(w.id);
  const indexLine = block.split("\n").find((l) => l.includes("Memo vault"))!;
  assert.ok(indexLine.length < 1000, `index line stays bounded, got ${indexLine.length}`);
  assert.match(indexLine, /more \(mc memo list\)/);
});

// ───────────────────────────── hygiene cadence ─────────────────────────────

test("hygieneDue: never-run fires after digestHour, recent run holds, 6+ day gap fires again", () => {
  const at = (iso: string) => new Date(iso);
  // digestHour passed explicitly: the daemon's self-deploy runs this suite under its own env, where
  // the daemon's secrets file sets CHRONOS_DIGEST_HOUR=-1 (digest off) — reading CONFIG here blocked
  // every deploy.
  assert.equal(hygieneDue(undefined, at("2026-08-31T10:00:00"), 8), true, "never ran → due");
  assert.equal(hygieneDue(undefined, at("2026-08-31T05:00:00"), 8), false, "before digestHour → wait");
  assert.equal(hygieneDue("2026-08-29T10:00:00Z", at("2026-08-31T10:00:00"), 8), false, "2 days ago → not due");
  assert.equal(hygieneDue("2026-08-24T10:00:00Z", at("2026-08-31T10:00:00"), 8), true, "7 days ago → due");
  assert.equal(hygieneDue(undefined, at("2026-08-31T10:00:00"), -1), false, "digest off → hygiene off");
});

// ───────────────────────────── ranking ─────────────────────────────

test("search weights a title hit above a passing mention in a long body", () => {
  const w = mkWs("rk-title");
  const titled = seedNote({ ws: w.id, title: "Worktree rules", body: "Claim one before writing." });
  seedNote({
    ws: w.id,
    title: "Deploy checklist",
    body: `Check the fleet is idle, then build, then restart. ${"Unrelated prose about the pipeline. ".repeat(20)} A worktree is mentioned once here in passing.`,
  });

  const hits = recall(w.id, "worktree");
  assert.equal(hits[0].title, "Worktree rules", `title hit ranks first, got: ${hits.map((h) => h.title)}`);
  assert.ok(hits.find((h) => h.title === "Deploy checklist"), "the body mention still matches, it just ranks lower");
});

test("a prose question falls back to OR instead of returning nothing", () => {
  const w = mkWs("rk-prose");
  seedNote({ ws: w.id, title: "Branch policy", body: "Pull requests target develop, never main." });

  // Every token ANDed matches no single row — the pre-fallback behaviour was an empty answer.
  const strict = searchIndex.search("which branch do pull requests go to", { workspace: w.id, kind: "note" });
  assert.ok(strict.length > 0, "the OR fallback salvages a query that ANDs to nothing");
  assert.ok(strict.every((h) => h.lax), "salvaged hits are marked lax");

  const hits = recall(w.id, "which branch do pull requests go to");
  assert.equal(hits[0].title, "Branch policy");
});

test("an exact hit is never outranked by a salvaged one", () => {
  const w = mkWs("rk-exact");
  seedNote({ ws: w.id, title: "Flyway repair", body: "Run repair before retrying a failed migration." });
  const sess = sessions.create({ workspace_id: w.id, title: "migration work", backend: "claude-code", cwd: "/tmp" });
  searchIndex.add({ kind: "session", ref_id: sess.id, workspace: w.id, title: "migration work", body: "a failed run, retried" });

  // "flyway repair" ANDs inside the note; the session only matches via the OR fallback.
  const hits = recall(w.id, "flyway repair");
  assert.equal(hits[0].kind, "note", `exact match leads, got: ${hits.map((h) => `${h.kind}:${h.title}`)}`);
});

test("session digests cannot crowd out the standing memo", () => {
  const w = mkWs("rk-cap");
  seedNote({ ws: w.id, title: "Worktree policy", body: "Every agent claims a worktree before writing." });
  for (let i = 0; i < 6; i++) {
    const s = sessions.create({ workspace_id: w.id, title: `worktree session ${i}`, backend: "claude-code", cwd: "/tmp" });
    searchIndex.add({ kind: "session", ref_id: s.id, workspace: w.id, title: `worktree session ${i}`, body: "claimed a worktree and pushed" });
  }

  const hits = recall(w.id, "worktree");
  const sessions_ = hits.filter((h) => h.kind === "session");
  assert.ok(sessions_.length <= 3, `sessions capped, got ${sessions_.length}`);
  assert.ok(hits.some((h) => h.kind === "note"), "the memo survives the flood of digests");
});

test("search survives a query that is not a valid FTS expression", () => {
  const w = mkWs("rk-bad");
  seedNote({ ws: w.id, title: "Anything", body: "body" });
  assert.deepEqual(searchIndex.search('"', { workspace: w.id, kind: "note" }), []);
  assert.deepEqual(searchIndex.search("*", { workspace: w.id, kind: "note" }), []);
});
