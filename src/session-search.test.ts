import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, kv, repos, searchIndex, sessionPrs, sessions, sessionSearchHook, workspaces } from "./store.js";
import { indexSession, installSessionSearchHooks, sessionSearchBody } from "./session-search.js";

// Wire the store → FTS hook the same way boot does (tests don't load index.ts).
sessionSearchHook.set(indexSession);

const mkWs = (slug: string) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-ss/${slug}-${randomUUID()}` });

test("sessionSearchBody includes branch, repo name, cwd leaf and PR urls", () => {
  const w = mkWs("ss-body");
  const repo = repos.create({
    workspace_id: w.id,
    name: "inventory-docs",
    path: "/Users/dev/GitHub/inventory-docs",
  });
  const s = sessions.create({
    workspace_id: w.id,
    repo_id: repo.id,
    title: "ping",
    goal: "ping",
    backend: "claude-code",
    cwd: "/Users/dev/GitHub/inventory-docs",
  });
  sessions.setWorktree(s.id, {
    path: "/Users/dev/.chronos-worktrees/inventory-docs/lf-fix-recipe-yield",
    branch: "lf/fix/recipe-yield",
    repo_id: repo.id,
  });
  sessionPrs.record({
    url: "https://github.com/acme/inventory-docs/pull/42",
    session_id: s.id,
    workspace_id: w.id,
    cwd: "/Users/dev/.chronos-worktrees/inventory-docs/lf-fix-recipe-yield",
  });
  const fresh = sessions.get(s.id)!;
  const body = sessionSearchBody(fresh);
  assert.match(body, /lf\/fix\/recipe-yield/);
  assert.match(body, /inventory-docs/);
  assert.match(body, /pull\/42/);
  assert.match(body, /ping/);
});

test("vague goal still findable by worktree branch after setWorktree reindexes", () => {
  const w = mkWs("ss-branch");
  const s = sessions.create({
    workspace_id: w.id,
    title: "look around",
    goal: "look around",
    backend: "claude-code",
    cwd: "/tmp",
  });
  indexSession(s.id);
  assert.equal(
    searchIndex.search("recipe-yield", { workspace: w.id, kind: "session" }).length,
    0,
    "branch not indexed yet",
  );

  sessions.setWorktree(s.id, {
    path: "/tmp/.chronos-worktrees/app/lf-fix-recipe-yield",
    branch: "lf/fix/recipe-yield",
  });
  const hits = searchIndex.search("recipe-yield", { workspace: w.id, kind: "session" });
  assert.ok(hits.some((h) => h.ref_id === s.id), `expected session hit, got ${JSON.stringify(hits)}`);
});

test("new PR url is searchable after sessionPrs.record", () => {
  const w = mkWs("ss-pr");
  const s = sessions.create({
    workspace_id: w.id,
    title: "ship it",
    goal: "ship it",
    backend: "claude-code",
    cwd: "/tmp/app",
  });
  indexSession(s.id);
  const ok = sessionPrs.record({
    url: "https://github.com/acme/widget/pull/99",
    session_id: s.id,
    workspace_id: w.id,
    cwd: "/tmp/app",
  });
  assert.equal(ok, true);
  const hits = searchIndex.search("pull/99", { workspace: w.id, kind: "session" });
  assert.ok(hits.some((h) => h.ref_id === s.id));
});

test("session search stays workspace-walled", () => {
  const a = mkWs("ss-wall-a");
  const b = mkWs("ss-wall-b");
  const sa = sessions.create({
    workspace_id: a.id,
    goal: "shared-token-xyz",
    backend: "claude-code",
    cwd: "/tmp/a",
  });
  const sb = sessions.create({
    workspace_id: b.id,
    goal: "shared-token-xyz",
    backend: "claude-code",
    cwd: "/tmp/b",
  });
  indexSession(sa.id);
  indexSession(sb.id);
  const onlyA = searchIndex.search("shared-token-xyz", { workspace: a.id, kind: "session" });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].ref_id, sa.id);
});

test("installSessionSearchHooks reindexes existing rows once", () => {
  const w = mkWs("ss-reindex");
  const s = sessions.create({
    workspace_id: w.id,
    goal: "vague",
    backend: "claude-code",
    cwd: "/tmp",
  });
  sessions.setWorktree(s.id, { path: "/tmp/wt", branch: "feat/pre-enrichment-marker" });
  searchIndex.removeRef(s.id);
  kv.del("search.session.enriched.v2");
  installSessionSearchHooks();
  const hits = searchIndex.search("pre-enrichment-marker", { workspace: w.id, kind: "session" });
  assert.ok(hits.some((h) => h.ref_id === s.id));
  // Second call must not throw and must keep the flag.
  installSessionSearchHooks();
  assert.ok(kv.get("search.session.enriched.v2"));
});

test("what a terminal delivered is findable: its hand-off joins the index when it is filed", () => {
  const w = mkWs("ss-outcome");
  const s = sessions.create({ workspace_id: w.id, title: "apply the new rules", goal: "apply the new rules", backend: "claude-code", cwd: "/tmp" });
  indexSession(s.id);
  assert.equal(searchIndex.search("08_Allocation_Rules", { workspace: w.id, kind: "session" }).length, 0, "the goal never named the file");
  sessions.setOutcome(s.id, {
    summary: "Read 08_Allocation_Rules.md and added Rule D for a blank processor.",
    changes: ["masters rerun for ten months"], proof: ["row counts tie to the ledger-zeta export"], prs: [], shots: [], ask: "none", shipped: [],
    at: new Date().toISOString(),
  } as any);
  for (const q of ["08_Allocation_Rules", "Rule D blank processor", "ledger-zeta"]) {
    const hits = searchIndex.search(q, { workspace: w.id, kind: "session" });
    assert.ok(hits.some((h) => h.ref_id === s.id), `"${q}" should find it, got ${JSON.stringify(hits)}`);
  }
  // The wall holds for what was delivered too.
  const other = mkWs("ss-outcome-b");
  assert.equal(searchIndex.search("08_Allocation_Rules", { workspace: other.id, kind: "session" }).length, 0);
});

test("a session hit is dated by when the terminal opened, so --since means recent terminals", () => {
  const w = mkWs("ss-since");
  const old = sessions.create({ workspace_id: w.id, title: "quarterly-marker old", goal: "quarterly-marker old", backend: "claude-code", cwd: "/tmp" });
  db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run("2026-01-05T10:00:00.000Z", old.id);
  const fresh = sessions.create({ workspace_id: w.id, title: "quarterly-marker new", goal: "quarterly-marker new", backend: "claude-code", cwd: "/tmp" });
  indexSession(old.id); // re-indexed today, opened in January
  indexSession(fresh.id);
  const all = searchIndex.search("quarterly-marker", { workspace: w.id, kind: "session" });
  assert.equal(all.find((h) => h.ref_id === old.id)?.ts, "2026-01-05T10:00:00.000Z");
  const recent = searchIndex.search("quarterly-marker", { workspace: w.id, kind: "session", since: new Date(Date.now() - 86_400_000).toISOString() });
  assert.deepEqual(recent.map((h) => h.ref_id), [fresh.id]);
});
