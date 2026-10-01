/**
 * Robert hears about computers: which host trouble wakes him, once per host per state, and the
 * switches and ceiling that keep it quiet when it should be.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, hosts, robertWakes, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import { setWakeAsker, setWakeNotifier, setWakePoster } from "./wake-queue.js";
import { writeSetting } from "./settings.js";
import { resetRobertDriveState } from "./robert-drive.js";
import {
  fireOffline,
  fireStuck,
  HOST_DRIVE_KEY,
  hostWake,
  noteHostOffline,
  noteHostOnline,
  noteStuck,
  offlineGraceMs,
  onPolicyViolation,
  resetHostDriveState,
  setHostViewProbe,
  sweepHosts,
} from "./robert-host-drive.js";
import { CONFIG } from "./config.js";
import type { HostView } from "./hostlink/view.js";

setWakeAsker(async () => "noted");
setWakePoster(() => {});
setWakeNotifier(async () => {});

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 60 * 60_000;
let ws: ReturnType<typeof workspaces.create>;

beforeEach(() => {
  db.exec(`DELETE FROM robert_wakes; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv; DELETE FROM hosts WHERE id != '${LOCAL_HOST_ID}';`);
  resetHostDriveState();
  resetRobertDriveState();
  ws = workspaces.create({ slug: "hd-acme", name: "Acme", config_dir: "/tmp/hd-acme" });
  hosts.create({ id: "h_m2", name: "m2", token_hash: "x".repeat(64), status: "offline" });
});

const wakes = () => db.prepare("SELECT * FROM robert_wakes ORDER BY generation").all() as Array<{ key: string; topic: string; subject: string; workspace_id: string | null; payload: string; acked_at: string | null }>;
const say = (w: { payload: string }) => JSON.parse(w.payload).say as string;
const onM2 = (goal: string) => sessions.create({ workspace_id: ws.id, goal, cwd: "", host_id: "h_m2" } as any);

test("offline with work on it: one wake past the grace, naming what still waits there", () => {
  const s = onM2("ship the rollback");
  noteHostOffline("h_m2", "2 missed pings", NOW, false);
  const id = fireOffline("h_m2", NOW + offlineGraceMs());
  assert.ok(id);
  const [w] = wakes();
  assert.equal(w.key, `${HOST_DRIVE_KEY}h_m2:offline:${NOW}`);
  assert.equal(w.topic, "host.offline");
  assert.equal(w.workspace_id, null, "computers are the whole fleet's: Robert's all-workspaces thread");
  assert.match(say(w), /m2 has not been heard from for \d+m \(2 missed pings\)/);
  assert.match(say(w), new RegExp(s.id.slice(0, 8)));
  assert.match(say(w), /ship the rollback/);
  assert.match(say(w), /operator's call/, "drain/disable/update stay confirm-first");
  assert.equal(fireOffline("h_m2", NOW + offlineGraceMs() + 1), null, "once per episode");
});

test("offline: nothing running there, back before the grace, or taken down by the operator → no wake", () => {
  noteHostOffline("h_m2", "lid closed", NOW, false);
  assert.equal(fireOffline("h_m2", NOW + offlineGraceMs()), null, "an idle laptop closing is not news");

  onM2("x");
  noteHostOffline("h_m2", "wifi", NOW, false);
  noteHostOnline("h_m2");
  assert.equal(fireOffline("h_m2", NOW + offlineGraceMs()), null);

  hosts.update("h_m2", { status: "disabled" });
  noteHostOffline("h_m2", "disabled from the Desk", NOW, false);
  assert.equal(fireOffline("h_m2", NOW + offlineGraceMs()), null);
  assert.equal(wakes().length, 0);
});

test("stuck failover inside the grace rides the offline wake; a later one gets its own, once per episode", () => {
  const a = onM2("migrate the db");
  const b = onM2("write the runbook");
  noteHostOffline("h_m2", "link lost", NOW, false);
  noteStuck("h_m2", a.id, "no computer can run acme", NOW, false);
  fireOffline("h_m2", NOW + offlineGraceMs());
  assert.equal(wakes().length, 1);
  assert.match(say(wakes()[0]), /COULD NOT MOVE:\n- `.{8}` Acme: migrate the db — no computer can run acme/);

  noteStuck("h_m2", b.id, "profile missing", NOW, false);
  assert.ok(fireStuck("h_m2", NOW + offlineGraceMs() + 60_000));
  const second = wakes()[1];
  assert.equal(second.key, `${HOST_DRIVE_KEY}h_m2:stuck:${NOW}`);
  assert.match(say(second), /write the runbook — profile missing/);
  // Another stuck one in the same pass, before Robert handled it: same row, newest list.
  noteStuck("h_m2", "c".repeat(36), "offline", NOW, false);
  fireStuck("h_m2", NOW + offlineGraceMs() + 61_000);
  assert.equal(wakes().length, 2);
  assert.match(say(wakes()[1]), /ccccccc/);
});

test("stuck with no offline seen (the brain restarted): it opens the episode itself", () => {
  hosts.update("h_m2", { last_seen_at: new Date(NOW - 30 * 60_000).toISOString() });
  const a = onM2("x");
  noteStuck("h_m2", a.id, "nowhere to go", NOW, false);
  assert.ok(fireStuck("h_m2", NOW));
  assert.equal(wakes()[0].key, `${HOST_DRIVE_KEY}h_m2:stuck:${NOW - 30 * 60_000}`);
  assert.match(say(wakes()[0]), /offline \(30m\)/);
});

test("a handled key never wakes him again; Robert off, host wakes off, or the hourly ceiling → nothing", () => {
  const w = { host_id: "h_m2", kind: "policy" as const, state: "s1", say: "x" };
  assert.ok(hostWake(w, NOW));
  robertWakes.ackIds(wakes().map((r: any) => r.id), 5);
  assert.equal(hostWake(w, NOW), null, "handled");

  writeSetting("robert.hosts", false);
  assert.equal(hostWake({ ...w, state: "s2" }, NOW), null);
  writeSetting("robert.hosts", null);
  writeSetting("robert.enabled", false);
  assert.equal(hostWake({ ...w, state: "s3" }, NOW), null);
  writeSetting("robert.enabled", null);

  writeSetting("robert.per_hour", 1);
  assert.ok(hostWake({ ...w, state: "s4" }, NOW + 2 * HOUR));
  assert.equal(hostWake({ ...w, state: "s5" }, NOW + 2 * HOUR + 1), null, "shares robert.per_hour with terminal wakes");
  assert.ok(hostWake({ ...w, state: "s4" }, NOW + 2 * HOUR + 2), "a repeat of a still-queued key is not a new wake");
  writeSetting("robert.per_hour", null);
});

test("policy violation: once per workspace per policy; a changed policy is new news", () => {
  const e = { host_id: "h_m2", workspace_id: ws.id, session_id: null, reason: "workspace hd-acme is not allowed on host m2 (brain policy)" };
  assert.ok(onPolicyViolation(e, NOW));
  const k1 = wakes()[0].key;
  assert.match(say(wakes()[0]), /Acme on m2, which it may NOT use/);
  assert.match(say(wakes()[0]), /Never loosen the policy yourself/);
  robertWakes.ackIds(wakes().map((r: any) => r.id), 5);
  assert.equal(onPolicyViolation(e, NOW), null);
  hosts.update("h_m2", { policy_json: JSON.stringify({ deny: ["hd-acme", "other"] }) });
  assert.ok(onPolicyViolation(e, NOW));
  assert.notEqual(wakes()[1].key, k1);
  assert.equal(onPolicyViolation({ ...e, host_id: "" }, NOW), null, "a refusal with no computer named is not a host's");
});

function hv(over: Partial<HostView>): HostView {
  return {
    id: "h_m2", name: "m2", platform: "darwin", status: "online", connected: true, is_brain: false, created_at: "",
    last_seen_at: null, policy: { deny: [] }, reserve: null, link: null, version: "1.0.0",
    vitals: { history: [], load_per_core: null, pressure: null, swap_pct: null, ram: null },
    admission: { ok: true }, live_sessions: 1,
    checklist: { clis: [], profiles: [], workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, allowed: true, denied_by: null, profile: null, repos: [] }], veto: [], reported_at: null },
    commit: "a".repeat(40), install: "git", update: null,
    ...over,
  } as HostView;
}

test("sweep: behind the brain only wakes after the configured hours, once per brain commit", () => {
  const update = { available: true, supported: true, target: { version: "1.0.0", commit: "b".repeat(40) }, manual: null, status: null };
  setHostViewProbe(() => [hv({ update })]);
  assert.deepEqual(sweepHosts(NOW), [], "the clock starts");
  assert.deepEqual(sweepHosts(NOW + 2 * HOUR), []);
  const out = sweepHosts(NOW + CONFIG.robertDrive.hostBehindHours * HOUR);
  assert.equal(out.length, 1);
  const w = wakes()[0];
  assert.equal(w.key, `${HOST_DRIVE_KEY}h_m2:behind:${"b".repeat(12)}`);
  assert.match(say(w), /BEHIND the brain/);
  assert.match(say(w), /mc hosts update m2/);
  robertWakes.ackIds(wakes().map((r: any) => r.id), 5);
  assert.deepEqual(sweepHosts(NOW + 30 * HOUR), [], "same commit, already handled");
  // Updated: the clock is cleared.
  setHostViewProbe(() => [hv({ update: { ...update, available: false } })]);
  assert.deepEqual(sweepHosts(NOW + 31 * HOUR), []);
});

test("sweep: a CLI placement needs there is logged out → one wake; logging back in re-arms it", () => {
  const out = (auth: "no" | "yes") => hv({ checklist: { ...hv({}).checklist, clis: [{ name: "claude", ok: auth === "yes", version: "2.0", auth }, { name: "grok", ok: false, version: null, auth: "no" }] } });
  setHostViewProbe(() => [out("no")]);
  const first = sweepHosts(NOW);
  assert.equal(first.length, 1, "claude is what Acme runs on; grok is nobody's default here");
  assert.match(say(wakes()[0]), /claude is NOT LOGGED IN on m2, and it is what Acme run on/);
  assert.deepEqual(sweepHosts(NOW + 60_000), [], "still logged out: same state");
  setHostViewProbe(() => [out("yes")]);
  sweepHosts(NOW + 2 * 60_000);
  setHostViewProbe(() => [out("no")]);
  robertWakes.ackIds(wakes().map((r: any) => r.id), 5);
  assert.deepEqual(sweepHosts(NOW + 3 * 60_000), [], "logged out again the same day: that day's wake was had");
  assert.equal(sweepHosts(NOW + 25 * HOUR).length, 0, "no transition since — not a new state");
});

test("sweep: a host already offline with work when the brain came up gets the offline wake", () => {
  setHostViewProbe(() => [hv({ connected: false, status: "offline", live_sessions: 2, last_seen_at: new Date(NOW - HOUR).toISOString() })]);
  onM2("still there");
  const out = sweepHosts(NOW);
  assert.equal(out.length, 1);
  assert.match(say(wakes()[0]), /not back since the brain restarted/);
  assert.deepEqual(sweepHosts(NOW + 60_000), [], "the episode is known now");
});

test("sweep costs nothing on a single-computer install", () => {
  db.exec(`DELETE FROM hosts WHERE id != '${LOCAL_HOST_ID}'`);
  let read = 0;
  setHostViewProbe(() => { read++; return []; });
  assert.deepEqual(sweepHosts(NOW), []);
  assert.equal(read, 0);
});
