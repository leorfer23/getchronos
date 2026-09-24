/**
 * Memory usage telemetry (src/memory-usage.ts): what gets recorded, how it rolls up, when it ages
 * out — and that one workspace can never read another's usage.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { db, memoryUsage, notes, skills, sessions, workspaces, searchIndex } from "./store.js";
import { recall, relevanceBlock } from "./recall.js";
import {
  parseSince, pruneMemoryUsage, recordRead, recordRecall, recordRelevance, sessionFor, usageReport, usageRoute,
} from "./memory-usage.js";
import type { Note, Skill } from "./types.js";

beforeEach(() => db.exec("DELETE FROM memory_usage;"));

const mkWs = (slug: string) => workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: `/tmp/mu-${randomUUID()}` });

function seedNote(ws: string, title: string, body: string): Note {
  const ts = new Date().toISOString();
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const n = notes.insert({
    id: randomUUID(), workspace_id: ws, title, slug, file_path: `/tmp/${slug}.md`, body,
    pinned: 0, context: 0, scope: "workspace", repo_ids: null, created_at: ts, updated_at: ts,
  } as Note);
  searchIndex.add({ kind: "note", ref_id: n.id, workspace: ws, title: n.title, body: n.body });
  return n;
}

function seedSkill(ws: string, name: string, description: string): Skill {
  const ts = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 4)}`;
  const s = skills.insert({
    id: randomUUID(), workspace_id: ws, slug, name, description, category: null, tags: null,
    status: "active", version: 1, usage_count: 0, last_used_at: null, file_path: `/tmp/${slug}/SKILL.md`,
    source: "operator", created_at: ts, updated_at: ts,
  } as Skill);
  searchIndex.add({ kind: "skill", ref_id: s.id, workspace: ws, title: s.name, body: s.description });
  return s;
}

// req/res fakes — same shape authz.test.ts / holds.test.ts use.
const fakeReq = (id: string, headers: Record<string, string> = {}, query: Record<string, string> = {}): any =>
  ({ params: { id }, query, get: (h: string) => headers[h.toLowerCase()] });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

// ───────────────────────────── the recorder ─────────────────────────────

test("a recall records the query with its hit count, plus one row per hit", () => {
  const w = mkWs("mu-recall");
  const n = seedNote(w.id, "Kafka consumer lag", "When kafka consumer lag spikes, restart the partition rebalancer.");
  const hits = recall(w.id, "kafka lag");
  assert.ok(hits.length >= 1);
  recordRecall(w.id, "kafka lag", hits, { source: "api" });

  const rows = memoryUsage.list(w.id);
  const q = rows.filter((r) => r.kind === "recall");
  assert.equal(q.length, 1);
  assert.equal(q[0].query, "kafka lag");
  assert.equal(q[0].hits, hits.length);
  assert.equal(q[0].ref, null);
  const hitRows = rows.filter((r) => r.kind === "recall_hit");
  assert.equal(hitRows.length, hits.filter((h) => h.source_ref).length);
  assert.ok(hitRows.some((r) => r.ref === n.id && r.ref_kind === "note" && r.query === "kafka lag"));
});

test("an empty recall is recorded as a miss; a blank query or workspace records nothing", () => {
  const w = mkWs("mu-miss");
  recordRecall(w.id, "  zebra migration  ", [], { source: "command" });
  recordRecall(w.id, "   ", [], { source: "api" });
  recordRecall("", "anything", [], { source: "api" });
  const rows = memoryUsage.list(w.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, "zebra migration");
  assert.equal(rows[0].hits, 0);
  assert.equal(rows[0].source, "command");
  assert.deepEqual(usageReport(w.id).misses.map((m) => m.query), ["zebra migration"]);
});

test("recall queries are truncated", () => {
  const w = mkWs("mu-trunc");
  recordRecall(w.id, "x".repeat(1000), [], { source: "api" });
  assert.equal(memoryUsage.list(w.id)[0].query!.length, 200);
});

test("recording never throws into the request path", () => {
  // No such workspace: the FK refuses the insert, the recorder swallows it.
  assert.doesNotThrow(() => recordRecall("no-such-ws", "q", [], { source: "api" }));
  assert.doesNotThrow(() => recordRead("no-such-ws", { kind: "memo_get", ref: "x" }, { source: "api" }));
  assert.doesNotThrow(() => recordRelevance("no-such-ws", [{ kind: "note", ref: "x" }], { source: "dispatch" }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_usage").get().n, 0);
});

test("relevanceBlock records what it surfaced, with the door and session it came through", () => {
  const w = mkWs("mu-rel");
  const n = seedNote(w.id, "Terraform state locking", "terraform state lock stuck: force-unlock with the lock id");
  const sk = seedSkill(w.id, "terraform-plan", "run terraform plan against the staging workspace");
  const s = sessions.create({ workspace_id: w.id, title: "t", backend: "claude-code", cwd: "/tmp" } as any);

  const block = relevanceBlock(w, "terraform", [], "REL-1", { source: "spawn", session_id: s.id });
  assert.ok(block.includes(n.slug));
  const rows = memoryUsage.list(w.id).filter((r) => r.kind === "relevance_inject");
  assert.deepEqual(new Set(rows.map((r) => r.ref)), new Set([n.id, sk.id]));
  assert.ok(rows.every((r) => r.source === "spawn" && r.session_id === s.id));

  // Default door is dispatch; nothing relevant → nothing recorded.
  relevanceBlock(w, "terraform");
  assert.ok(memoryUsage.list(w.id).some((r) => r.source === "dispatch"));
  const before = memoryUsage.list(w.id).length;
  assert.equal(relevanceBlock(w, "quux-nothing-matches"), "");
  assert.equal(memoryUsage.list(w.id).length, before);
});

test("sessionFor keeps a session id only when it belongs to the same workspace", () => {
  const a = mkWs("mu-sa");
  const b = mkWs("mu-sb");
  const s = sessions.create({ workspace_id: b.id, title: "t", backend: "claude-code", cwd: "/tmp" } as any);
  assert.equal(sessionFor(b.id, s.id), s.id);
  assert.equal(sessionFor(a.id, s.id), null, "B's session can't be stamped on A's usage");
  assert.equal(sessionFor(a.id, "nope"), null);
  assert.equal(sessionFor(a.id, undefined), null);
  assert.equal(sessionFor(a.id, ["x"]), null);
});

// ───────────────────────────── the aggregate ─────────────────────────────

test("usageReport rolls rows up per ref: count, last use, kinds, distinct sessions, label", () => {
  const w = mkWs("mu-agg");
  const n = seedNote(w.id, "Deploy runbook", "how we deploy");
  const sk = seedSkill(w.id, "cut-release", "cut a release");
  const s1 = sessions.create({ workspace_id: w.id, title: "a", backend: "claude-code", cwd: "/tmp" } as any);
  const s2 = sessions.create({ workspace_id: w.id, title: "b", backend: "claude-code", cwd: "/tmp" } as any);

  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: n.id, session_id: s1.id, ts: "2026-09-10T00:00:00.000Z" });
  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: n.id, session_id: s2.id, ts: "2026-09-12T00:00:00.000Z" });
  memoryUsage.add({ workspace_id: w.id, kind: "recall_hit", ref_kind: "note", ref: n.id, query: "deploy", session_id: s1.id, ts: "2026-09-11T00:00:00.000Z" });
  memoryUsage.add({ workspace_id: w.id, kind: "skill_view", ref_kind: "skill", ref: sk.id, ts: "2026-09-11T00:00:00.000Z" });
  memoryUsage.add({ workspace_id: w.id, kind: "recall", query: "deploy", hits: 1, ts: "2026-09-11T00:00:00.000Z" });
  // Outside the window.
  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: n.id, ts: "2026-08-01T00:00:00.000Z" });

  const r = usageReport(w.id, "2026-09-01T00:00:00.000Z");
  assert.equal(r.recalls, 1);
  assert.equal(r.refs.length, 2);
  const note = r.refs[0];
  assert.equal(note.ref, n.id);
  assert.equal(note.count, 3);
  assert.deepEqual(note.kinds, { memo_get: 2, recall_hit: 1 });
  assert.equal(note.last_used, "2026-09-12T00:00:00.000Z");
  assert.equal(note.sessions, 2);
  assert.equal(note.label, n.slug);
  assert.equal(r.refs[1].label, sk.slug);
  assert.deepEqual(r.misses, []);

  // Without a window, the default reaches back 30 days — the August row drops out with the rest.
  assert.equal(usageReport(w.id, null, Date.parse("2026-09-20T00:00:00.000Z")).refs.find((x) => x.ref === n.id)!.count, 3);
});

test("a ref whose source is gone keeps its counts but loses its label", () => {
  const w = mkWs("mu-gone");
  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: "deleted-note-id" });
  const r = usageReport(w.id, "2000-01-01T00:00:00.000Z");
  assert.equal(r.refs[0].count, 1);
  assert.equal(r.refs[0].label, null);
});

test("parseSince reads 7d / 24h / 30m / 2w and ISO; junk is null", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  assert.equal(parseSince("7d", now), "2026-09-16T12:00:00.000Z");
  assert.equal(parseSince("24h", now), "2026-09-22T12:00:00.000Z");
  assert.equal(parseSince("30m", now), "2026-09-23T11:30:00.000Z");
  assert.equal(parseSince("2w", now), "2026-09-09T12:00:00.000Z");
  assert.equal(parseSince("2026-09-01T00:00:00Z", now), "2026-09-01T00:00:00.000Z");
  assert.equal(parseSince("yesterday-ish", now), null);
  assert.equal(parseSince("", now), null);
  assert.equal(parseSince(undefined, now), null);
});

// ───────────────────────────── retention ─────────────────────────────

test("retention drops rows older than the window and keeps the rest", () => {
  const w = mkWs("mu-ret");
  const now = Date.parse("2026-09-23T00:00:00.000Z");
  memoryUsage.add({ workspace_id: w.id, kind: "recall", query: "old", hits: 0, ts: "2026-07-20T00:00:00.000Z" }); // 65d
  memoryUsage.add({ workspace_id: w.id, kind: "recall", query: "edge", hits: 0, ts: "2026-07-26T00:00:00.000Z" }); // 59d
  memoryUsage.add({ workspace_id: w.id, kind: "recall", query: "new", hits: 0, ts: "2026-09-22T00:00:00.000Z" });
  assert.equal(CONFIG.memoryUsageRetainDays, 60);
  assert.equal(pruneMemoryUsage(now), 1);
  assert.deepEqual(memoryUsage.list(w.id).map((r) => r.query), ["edge", "new"]);
  assert.equal(pruneMemoryUsage(now, 0), 0, "0 = keep forever");
});

test("the monitor's retention sweep prunes memory usage", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/monitor.ts"), "utf8");
  const at = src.indexOf("function maybeRetentionSweep");
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 1200), /pruneMemoryUsage\(\)/);
});

// ───────────────────────────── the wall ─────────────────────────────

test("aggregate never mixes workspaces", () => {
  const a = mkWs("mu-wa");
  const b = mkWs("mu-wb");
  memoryUsage.add({ workspace_id: a.id, kind: "memo_get", ref_kind: "note", ref: "a-note" });
  memoryUsage.add({ workspace_id: b.id, kind: "memo_get", ref_kind: "note", ref: "b-note" });
  recordRecall(b.id, "b secret query", [], { source: "api" });
  const ra = usageReport(a.id, "2000-01-01T00:00:00.000Z");
  assert.deepEqual(ra.refs.map((r) => r.ref), ["a-note"]);
  assert.equal(ra.recalls, 0);
  assert.deepEqual(ra.misses, []);
  assert.deepEqual(memoryUsage.aggregate(""), [], "an empty workspace id answers nothing, never everything");
});

test("labels resolve only inside the wall: B's memo id recorded under A shows no label", () => {
  const a = mkWs("mu-la");
  const b = mkWs("mu-lb");
  const bn = seedNote(b.id, "B private memo", "b stuff");
  memoryUsage.add({ workspace_id: a.id, kind: "memo_get", ref_kind: "note", ref: bn.id });
  assert.equal(usageReport(a.id, "2000-01-01T00:00:00.000Z").refs[0].label, null);
});

test("GET /workspaces/:id/memory/usage: own token reads, another workspace's token gets 404, admin reads any", () => {
  const a = mkWs("mu-ra");
  const b = mkWs("mu-rb");
  memoryUsage.add({ workspace_id: b.id, kind: "memo_get", ref_kind: "note", ref: "b-note" });
  const tokA = workspaces.get(a.id)!.token!;
  const tokB = workspaces.get(b.id)!.token!;
  assert.ok(tokA && tokB);

  const cross = fakeRes();
  usageRoute(fakeReq(b.id, { "x-mc-workspace-token": tokA }), cross);
  assert.equal(cross.statusCode, 404);
  assert.equal(JSON.stringify(cross.body).includes("b-note"), false);

  const bad = fakeRes();
  usageRoute(fakeReq(b.id, { "x-mc-workspace-token": "forged" }), bad);
  assert.equal(bad.statusCode, 401);

  const own = fakeRes();
  usageRoute(fakeReq(b.id, { "x-mc-workspace-token": tokB }, { since: "2000-01-01T00:00:00Z" }), own);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.body.refs.map((r: any) => r.ref), ["b-note"]);

  const prev = CONFIG.adminToken;
  (CONFIG as any).adminToken = "test-admin-token";
  try {
    const admin = fakeRes();
    usageRoute(fakeReq(b.id, { "x-mc-admin": "test-admin-token" }, { since: "7d" }), admin);
    assert.equal(admin.statusCode, 200);
  } finally { (CONFIG as any).adminToken = prev; }

  const junk = fakeRes();
  usageRoute(fakeReq(b.id, { "x-mc-workspace-token": tokB }, { since: "soon" }), junk);
  assert.equal(junk.statusCode, 400);

  const missing = fakeRes();
  usageRoute(fakeReq("no-such-ws", {}), missing);
  assert.equal(missing.statusCode, 404);
});

test("api wiring: recall, memo reads (?use=1) and skill views record usage; the usage route is registered", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  assert.match(api, /api\.get\("\/workspaces\/:id\/memory\/usage", usageRoute\)/);
  const recallAt = api.indexOf('api.get("/workspaces/:id/recall"');
  assert.match(api.slice(recallAt, recallAt + 600), /recordRecall\(req\.params\.id, q, hits, \{ source: "api", session_id: sessionFor\(req\.params\.id, req\.query\.session\) \}\)/);
  const noteAt = api.indexOf('api.get("/notes/:id"');
  const noteBody = api.slice(noteAt, noteAt + 600);
  assert.ok(noteBody.indexOf("checkScope") < noteBody.indexOf("recordRead"), "record only after the scope check");
  assert.match(noteBody, /req\.query\.use === "1"/);
  const skillAt = api.indexOf('api.get("/skills/:id"');
  assert.match(api.slice(skillAt, skillAt + 900), /kind: "skill_view"/);
});
