import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jots, workspaces } from "./store.js";
import {
  fireFollowUp, followUpBrief, followUpPolicy, parseFollowUpAt, sweepFollowUps,
  MAX_AGENT_FOLLOW_UPS, RETRY_MS, FIRE_PER_SWEEP,
} from "./jot-followup.js";

beforeEach(() => {
  db.exec("DELETE FROM jots; DELETE FROM workspaces;");
});

const mkWs = (slug = `fu-${randomUUID().slice(0, 6)}`) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });

// Wed 2026-09-23 10:30 local
const NOW = new Date(2026, 8, 23, 10, 30, 0, 0).getTime();
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

test("parseFollowUpAt reads what people and agents actually type", () => {
  assert.equal(parseFollowUpAt("+30m", NOW), new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(parseFollowUpAt("2h", NOW), new Date(NOW + 2 * 3_600_000).toISOString());
  assert.equal(parseFollowUpAt("+2d", NOW), new Date(NOW + 2 * 86_400_000).toISOString());
  assert.equal(parseFollowUpAt("+1w", NOW), new Date(NOW + 7 * 86_400_000).toISOString());
  assert.equal(parseFollowUpAt("tomorrow", NOW), local(2026, 9, 24, 9));
  assert.equal(parseFollowUpAt("mañana 14:30", NOW), local(2026, 9, 24, 14, 30));
  assert.equal(parseFollowUpAt("today 5pm", NOW), local(2026, 9, 23, 17));
  assert.equal(parseFollowUpAt("monday 10", NOW), local(2026, 9, 28, 10));
  assert.equal(parseFollowUpAt("jueves", NOW), local(2026, 9, 24, 9));
  assert.equal(parseFollowUpAt("wednesday", NOW), local(2026, 9, 30, 9), "a weekday is the NEXT one, never today");
  assert.equal(parseFollowUpAt("2026-10-01", NOW), local(2026, 10, 1, 9));
  assert.equal(parseFollowUpAt("2026-10-01 14:00", NOW), local(2026, 10, 1, 14));
  assert.equal(parseFollowUpAt("2026-10-01T14:00:00Z", NOW), "2026-10-01T14:00:00.000Z");
  assert.equal(parseFollowUpAt("whenever", NOW), null);
  assert.equal(parseFollowUpAt("tomorrow 25:00", NOW), null);
  assert.equal(parseFollowUpAt("", NOW), null);
});

test("the operator schedules anything; a terminal only its own client's agent notes or the note it was opened for", () => {
  const ws = "ws-a";
  const at = new Date(NOW + 2 * 86_400_000).toISOString();
  const agentNote = { workspace_id: ws, source: "agent" as const, follow_up_session: null, follow_up_count: 0 };
  const opNote = { workspace_id: ws, source: "operator" as const, follow_up_session: "sess-1", follow_up_count: 0 };

  assert.equal(followUpPolicy({ admin: true, scopedWs: null, session: null }, opNote, { at, nowMs: NOW }).ok, true);
  assert.equal(followUpPolicy({ admin: false, scopedWs: ws, session: "x" }, agentNote, { at, nowMs: NOW }).ok, true);
  assert.equal(followUpPolicy({ admin: false, scopedWs: "ws-b", session: "x" }, agentNote, { at, nowMs: NOW }).ok, false, "another client's note");
  assert.equal(followUpPolicy({ admin: false, scopedWs: null, session: null }, agentNote, { at, nowMs: NOW }).ok, false, "no token is not the operator");
  assert.equal(followUpPolicy({ admin: false, scopedWs: ws, session: "other" }, opNote, { at, nowMs: NOW }).ok, false, "the operator's own note");
  assert.equal(followUpPolicy({ admin: false, scopedWs: ws, session: "sess-1" }, opNote, { at, nowMs: NOW }).ok, true, "the follow-up terminal of that note");
});

test("agents cannot loop: 30-minute floor and a cap on how many times they push a note forward", () => {
  const caller = { admin: false, scopedWs: "ws", session: "s" };
  const note = { workspace_id: "ws", source: "agent" as const, follow_up_session: null, follow_up_count: 0 };
  const soon = new Date(NOW + 5 * 60_000).toISOString();
  const later = new Date(NOW + 3 * 3_600_000).toISOString();
  assert.equal(followUpPolicy(caller, note, { at: soon, nowMs: NOW }).ok, false);
  assert.equal(followUpPolicy(caller, note, { at: later, nowMs: NOW }).ok, true);
  const worn = { ...note, follow_up_count: MAX_AGENT_FOLLOW_UPS };
  const r = followUpPolicy(caller, worn, { at: later, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(followUpPolicy({ admin: true, scopedWs: null, session: null }, worn, { at: soon, nowMs: NOW }).ok, true, "the operator is never capped");
  assert.equal(followUpPolicy(caller, worn, {}).ok, true, "resolving is always allowed");
});

test("a due follow-up opens one terminal, is claimed exactly once, and records who followed up", async () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "is the backfill done?", body: "dataform-ml #479", source: "agent" });
  jots.setFollowUp(j.id, new Date(NOW - 60_000).toISOString(), "check the DAU table for Jul 30–Aug 26");
  const opened: any[] = [];
  const opener = (async (o: any) => { opened.push(o); return { id: "sess-" + opened.length } as any; }) as any;

  const [a, b] = await Promise.all([fireFollowUp(j.id, NOW, opener), fireFollowUp(j.id, NOW, opener)]);
  assert.equal(opened.length, 1, "two racing sweeps open one terminal");
  assert.ok(a || b);
  const row = jots.get(j.id)!;
  assert.equal(row.follow_up_at, null);
  assert.equal(row.follow_up_count, 1);
  assert.equal(row.follow_up_session, "sess-1");
  assert.equal(row.status, "open", "following up does not close the note — the terminal decides");
  assert.match(opened[0].goal, /^Follow up: is the backfill done\?/);
  assert.match(opened[0].description, /check the DAU table/);
  assert.match(opened[0].description, /dataform-ml #479/);
  assert.match(opened[0].description, new RegExp(`mc pad resolve ${j.id.slice(0, 8)}`));
  assert.match(opened[0].description, new RegExp(`mc pad follow ${j.id.slice(0, 8)}`));
});

test("a follow-up that cannot open a terminal is put back, not lost", async () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  jots.setFollowUp(j.id, new Date(NOW - 1000).toISOString());
  const r = await fireFollowUp(j.id, NOW, (async () => { throw new Error("session cap reached"); }) as any);
  assert.equal(r, null);
  assert.equal(jots.get(j.id)!.follow_up_at, new Date(NOW + RETRY_MS).toISOString());
  assert.equal(jots.get(j.id)!.follow_up_count, 0, "a terminal that never opened is not a follow-up that happened");
});

test("the sweep fires only what is due, one per client, and a few at a time", async () => {
  const a = mkWs(), b = mkWs(), c = mkWs(), d = mkWs();
  const past = new Date(NOW - 60_000).toISOString();
  const future = new Date(NOW + 3_600_000).toISOString();
  const a1 = jots.create({ workspace_id: a.id, title: "a1" }); jots.setFollowUp(a1.id, past);
  const a2 = jots.create({ workspace_id: a.id, title: "a2" }); jots.setFollowUp(a2.id, past);
  const b1 = jots.create({ workspace_id: b.id, title: "b1" }); jots.setFollowUp(b1.id, future);
  for (const w of [c, d, mkWs()]) { const x = jots.create({ workspace_id: w.id, title: "x" }); jots.setFollowUp(x.id, past); }
  const done = jots.create({ workspace_id: b.id, title: "done" }); jots.setFollowUp(done.id, past); jots.update(done.id, { status: "done" });

  let n = 0;
  const fired = await sweepFollowUps(NOW, (async () => ({ id: "s" + ++n })) as any);
  assert.equal(fired, FIRE_PER_SWEEP);
  assert.equal(jots.get(b1.id)!.follow_up_at, future, "not due yet");
  assert.equal(jots.get(done.id)!.follow_up_at, null, "closing a note cancels its follow-up");
  const aLeft = [a1, a2].filter((x) => jots.get(x.id)!.follow_up_at).length;
  assert.equal(aLeft, 1, "one follow-up per client per pass");
});

test("a done note cannot be scheduled, and running a note cancels its follow-up", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  jots.update(j.id, { status: "done" });
  assert.throws(() => jots.setFollowUp(j.id, new Date(NOW + 86_400_000).toISOString()), /reopen/);
  const k = jots.create({ workspace_id: ws.id, title: "k", follow_up_at: new Date(NOW + 86_400_000).toISOString() });
  jots.ran(k.id, "sess-x");
  assert.equal(jots.get(k.id)!.follow_up_at, null);
});

test("moving the time keeps the question; null clears it", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t" });
  jots.setFollowUp(j.id, new Date(NOW + 86_400_000).toISOString(), "did review land?");
  jots.setFollowUp(j.id, new Date(NOW + 2 * 86_400_000).toISOString());
  assert.equal(jots.get(j.id)!.follow_up_check, "did review land?");
  jots.setFollowUp(j.id, null, null);
  assert.equal(jots.get(j.id)!.follow_up_at, null);
  assert.equal(jots.get(j.id)!.follow_up_check, null);
});

test("the brief falls back to a generic question when none was written", () => {
  const ws = mkWs();
  const j = jots.create({ workspace_id: ws.id, title: "t", source: "operator" });
  const brief = followUpBrief(jots.get(j.id)!, "Galley");
  assert.match(brief, /Galley's pad/);
  assert.match(brief, /Is this still open\?/);
  assert.match(brief, /\(no detail was written\)/);
  assert.match(brief, /mc ask/);
});
