/**
 * The cold tier's ceiling (src/cold-tier.ts): archive age + size cap, worklog roll, brief retirement,
 * and the things it must never touch (pinned, ★, live owners, the block `mc dream undo` removes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, notes, sessions, workspaces, memoryUsage } from "./store.js";
import { captureLearnings, createNote, updateNote } from "./notes.js";
import { applyPlan, dreamContext, inboxLines, undoRun, type DreamPlan } from "./dream-pass.js";
import { ARCHIVE_SLUG, INBOX_SLUG } from "./memory-tree.js";
import { entryBlock, parseWorklog, WORKLOG_SLUG } from "./worklog.js";
import {
  BRIEF_ARCHIVE_SLUG, capColdNote, isColdNote, judgeBriefs, rollWorklog, sweepWorkspace, WORKLOG_ARCHIVE_SLUG,
} from "./cold-tier.js";
import type { Workspace } from "./types.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const day = (d: number) => ago(d).toISOString().slice(0, 10);
const CFG = { enabled: true, archiveDays: 90, archiveMaxChars: 60_000, worklogDays: 30, briefDays: 14, briefEndedDays: 3 };
const mkWs = (slug: string): Workspace =>
  workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: `/tmp/cold-test/${slug}-${randomUUID()}` });
const body = (ws: Workspace, slug: string) => notes.bySlug(ws.id, slug)?.body ?? null;
const SEED = "# Memory archive\n\nCold tier.\n";
const block = (date: string, n: number, fill = 10) => `## dream ${date} 01:00 · run ${String(n).padStart(8, "0")}\n${"- line\n".repeat(fill)}`;
/** Backdate a memo the way time would have: the store stamps updated_at with the real clock. */
const backdate = (id: string, d: number) => db.prepare("UPDATE notes SET updated_at = ?, created_at = ? WHERE id = ?").run(ago(d).toISOString(), ago(d).toISOString(), id);

test("cold notes: archives only — never the index, hot, branches or other memos", () => {
  for (const s of ["memory-archive", "memory-archive-robert", "worklog-archive", "brief-archive", "session-learnings-archive-2026-09-17"]) assert.ok(isColdNote(s), s);
  for (const s of ["memory-index", "memory-hot", "memory-deploy", "worklog", "session-learnings", "robert-brief", "brief-android"]) assert.ok(!isColdNote(s), s);
});

test("archive cap: sections older than the window leave; the rest is a byte-exact suffix", () => {
  const b = SEED + "\n" + block(day(200), 1) + block(day(120), 2) + block(day(30), 3) + block(day(1), 4);
  const r = capColdNote(b, { now: NOW, days: 90, maxChars: 0, fallbackDate: day(300) });
  assert.equal(r.sections, 2);
  assert.equal(r.body, SEED + "\n" + block(day(30), 3) + block(day(1), 4));
  assert.ok(b.endsWith(r.body.slice(SEED.length + 1)));
  assert.equal(r.chars, b.length - r.body.length);
  assert.deepEqual(capColdNote(r.body, { now: NOW, days: 90, maxChars: 0, fallbackDate: day(300) }).sections, 0, "idempotent");
});

test("archive cap: oldest go first until it fits; the newest section always stays", () => {
  const b = SEED + "\n" + block(day(5), 1, 100) + block(day(4), 2, 100) + block(day(3), 3, 100) + block(day(2), 4, 400);
  const r = capColdNote(b, { now: NOW, days: 90, maxChars: 2000, fallbackDate: day(10) });
  assert.equal(r.sections, 3, "even over the cap, the last block is kept — dream undo removes it by exact text");
  assert.equal(r.body, SEED + "\n" + block(day(2), 4, 400));
  const fits = capColdNote(b, { now: NOW, days: 90, maxChars: b.length - block(day(5), 1, 100).length, fallbackDate: day(10) });
  assert.equal(fits.sections, 1);
});

test("archive cap: undated headings inherit the date before them (the note's own first)", () => {
  const b = "# Session learnings archive\n\n## Repo Structure\nold\n## Gotchas\nold\n## " + day(5) + " 10:00 · agent\nnew\n";
  assert.equal(capColdNote(b, { now: NOW, days: 90, maxChars: 0, fallbackDate: day(100) }).body, "# Session learnings archive\n\n## " + day(5) + " 10:00 · agent\nnew\n");
  assert.equal(capColdNote(b, { now: NOW, days: 90, maxChars: 0, fallbackDate: day(10) }).sections, 0);
});

test("sweep: memory-archive is capped and the last dream pass can still be undone", () => {
  const w = mkWs("cold-undo");
  captureLearnings(w.id, ["Flyway migrations live in db/migrations and CI applies them on merge"], "s1");
  const arc = createNote({ workspace_id: w.id, slug: ARCHIVE_SLUG, title: "Memory archive", body: SEED + "\n" + block(day(200), 1, 50) + block(day(100), 2, 50) + block(day(10), 3, 50) });
  const ctx = dreamContext(w);
  const lineId = inboxLines(body(w, INBOX_SLUG)!)[0].id;
  const plan: DreamPlan = {
    run: ctx.run,
    index: "# Memory index\n\nOne line per rule, grouped by topic. `→ memory-x` = details in that memo (`mc memo get memory-x`).\n\n## Db\n- Flyway migrations live in db/migrations\n",
    hot: "# Memory hot\n\n- nothing\n",
    inbox: [{ id: lineId, to: "index" }],
  };
  applyPlan(w, plan, { now: NOW });
  const applied = body(w, ARCHIVE_SLUG)!;
  assert.match(applied, /triaged→index/);

  const st = sweepWorkspace(w, NOW, { ...CFG, archiveMaxChars: 300 });
  assert.equal(st.archiveSections, 3, "two by age, one by size");
  const capped = body(w, ARCHIVE_SLUG)!;
  assert.ok(capped.startsWith(SEED), "the preamble stays");
  assert.match(capped, /triaged→index/, "the newest block — the pass's own — survives");
  assert.ok(applied.endsWith(capped.slice(SEED.length)));

  undoRun(w, ctx.run, NOW);
  assert.doesNotMatch(body(w, ARCHIVE_SLUG)!, /triaged→/, "undo still finds and removes its block");
  assert.equal(notes.get(arc.id)!.id, arc.id);
});

test("sweep: a pinned archive is never touched", () => {
  const w = mkWs("cold-pinned");
  const b = SEED + "\n" + block(day(200), 1) + block(day(1), 2);
  const n = createNote({ workspace_id: w.id, slug: ARCHIVE_SLUG, title: "Memory archive", body: b });
  updateNote(n.id, { pinned: true });
  assert.equal(sweepWorkspace(w, NOW, CFG).archiveSections, 0);
  assert.equal(body(w, ARCHIVE_SLUG), b);
});

const wl = (when: Date, what: string) => entryBlock({ what, outcome: "done", pending: ["a thing"], next: [] }, `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} 10:00`);
const WL_HEAD = "# Worklog\n\nEvery finished terminal and build in this workspace, newest last.\n";

test("worklog roll: entries older than the window move out whole; the header and recent ones stay", () => {
  const b = [WL_HEAD, wl(ago(60), "old one"), "", wl(ago(40), "old two"), "", wl(ago(5), "fresh"), ""].join("\n");
  const r = rollWorklog(b, NOW, 30);
  assert.equal(r.entries, 2);
  assert.match(r.rolled, /old one[\s\S]*- pending: a thing[\s\S]*old two/);
  assert.doesNotMatch(r.keep, /old one|old two/);
  assert.ok(r.keep.startsWith(WL_HEAD));
  assert.deepEqual(parseWorklog(r.keep).map((x) => x.what), ["fresh"]);
  assert.equal(rollWorklog(r.keep, NOW, 30).entries, 0, "idempotent");
  assert.equal(rollWorklog(b, NOW, 0).entries, 0, "0 = off");
});

test("sweep: the worklog keeps its window, the rest lands in worklog-archive and is still parseable", () => {
  const w = mkWs("cold-wl");
  createNote({ workspace_id: w.id, slug: WORKLOG_SLUG, title: "Worklog", body: [WL_HEAD, wl(ago(45), "shipped the old thing"), "", wl(ago(2), "shipped the new thing")].join("\n") });
  const st = sweepWorkspace(w, NOW, CFG);
  assert.equal(st.worklogEntries, 1);
  assert.deepEqual(parseWorklog(body(w, WORKLOG_SLUG)!).map((x) => x.what), ["shipped the new thing"]);
  const arc = body(w, WORKLOG_ARCHIVE_SLUG)!;
  assert.match(arc, new RegExp(`## worklog through ${wl(ago(45), "x").slice(4, 14)} · 1 entry`));
  assert.deepEqual(parseWorklog(arc).map((x) => x.what), ["shipped the old thing"]);
  assert.equal(sweepWorkspace(w, NOW, CFG).worklogEntries, 0);
});

function brief(w: Workspace, slug: string, ageDays: number, extra: { pinned?: boolean; context?: boolean } = {}) {
  const n = createNote({ workspace_id: w.id, slug, title: slug, body: `# ${slug}\n\n## Paso\nhacé la tajada\n`, context: extra.context });
  if (extra.pinned) updateNote(n.id, { pinned: true });
  backdate(n.id, ageDays);
  return n;
}
const endAt = (id: string, d: number) => db.prepare("UPDATE sessions SET status='ended', ended_at=? WHERE id=?").run(ago(d).toISOString(), id);
const spawn = (w: Workspace, goal: string, extra: { role?: string; lead_id?: string } = {}) =>
  sessions.create({ workspace_id: w.id, cwd: "/tmp", goal, role: extra.role as any, lead_id: extra.lead_id } as any);

test("briefs: a live owner keeps it, a live Lead keeps its workers' briefs, pinned/★ are never candidates", () => {
  const w = mkWs("cold-brief");
  brief(w, "brief-live", 30);
  spawn(w, "Leé mc memo get brief-live y seguilo");
  const lead = spawn(w, "Lead: android", { role: "lead" });
  brief(w, "brief-worker", 30);
  const worker = spawn(w, "mc memo get brief-worker", { lead_id: lead.id });
  endAt(worker.id, 20);
  brief(w, "brief-pinned", 300, { pinned: true });
  brief(w, "brief-star", 300, { context: true });
  const v = new Map(judgeBriefs(w, NOW, CFG).map((x) => [x.note.slug, x] as const));
  assert.equal(v.get("brief-live")!.retire, false);
  assert.match(v.get("brief-live")!.reason, /owner .* is live/);
  assert.equal(v.get("brief-worker")!.retire, false);
  assert.match(v.get("brief-worker")!.reason, /lead .* is live/);
  assert.ok(!v.has("brief-pinned") && !v.has("brief-star"));
  assert.equal(sweepWorkspace(w, NOW, CFG).briefs, 0);
});

test("briefs: untouched past the window with no owner, or owners ended past the grace → brief-archive", () => {
  const w = mkWs("cold-brief2");
  brief(w, "brief-orphan", 20);
  brief(w, "brief-young", 5);
  brief(w, "brief-done", 5);
  const s = spawn(w, "mc memo get brief-done");
  endAt(s.id, 4);
  brief(w, "brief-just-ended", 5);
  endAt(spawn(w, "mc memo get brief-just-ended").id, 1);
  // The memo-vault index line names every memo; it is not ownership.
  const bystander = spawn(w, "something else");
  db.prepare("UPDATE sessions SET first_prompt=? WHERE id=?").run("- Memo vault (`mc memo get <slug>`): brief-orphan · brief-young", bystander.id);

  const v = new Map(judgeBriefs(w, NOW, CFG).map((x) => [x.note.slug, x] as const));
  assert.equal(v.get("brief-orphan")!.retire, true);
  assert.match(v.get("brief-orphan")!.reason, /untouched 20d/);
  assert.equal(v.get("brief-young")!.retire, false, "no owner, but not idle long enough");
  assert.equal(v.get("brief-done")!.retire, true);
  assert.match(v.get("brief-done")!.reason, /owners ended 4d ago/);
  assert.equal(v.get("brief-just-ended")!.retire, false, "owners ended inside the grace");

  const st = sweepWorkspace(w, NOW, CFG);
  assert.equal(st.briefs, 2);
  assert.equal(notes.bySlug(w.id, "brief-orphan"), undefined);
  assert.equal(notes.bySlug(w.id, "brief-done"), undefined);
  const arc = body(w, BRIEF_ARCHIVE_SLUG)!;
  assert.match(arc, /## retired brief-orphan · 2026-10-02 · untouched 20d, no live owner\n> # brief-orphan/);
  assert.match(arc, /> ## Paso/, "brief headings are quoted, so they never split the archive's sections");
  assert.ok(notes.bySlug(w.id, "brief-young"));
  assert.equal(sweepWorkspace(w, NOW, CFG).briefs, 0, "idempotent");
});

test("briefs: a recent `mc memo get` counts as a touch and its session as an owner", () => {
  const w = mkWs("cold-brief3");
  const n = brief(w, "brief-read", 30);
  const s = spawn(w, "a worker");
  memoryUsage.add({ workspace_id: w.id, kind: "memo_get", ref_kind: "note", ref: n.id, session_id: s.id, ts: ago(1).toISOString() });
  const v = judgeBriefs(w, NOW, CFG).find((x) => x.note.slug === "brief-read")!;
  assert.equal(v.retire, false);
  assert.match(v.reason, /is live/);
  endAt(s.id, 1);
  const v2 = judgeBriefs(w, NOW, CFG).find((x) => x.note.slug === "brief-read")!;
  assert.equal(v2.retire, false, "read a day ago — inside the grace");
});
