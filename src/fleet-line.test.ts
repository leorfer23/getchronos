/**
 * The fleet block at the top of Robert's turn, once there is more than one computer: a HOSTS line he
 * can read where work can go from, and every terminal on another computer saying which one.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, hosts, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import { fleetLine, hostsLine, hostSuffix } from "./fleet-line.js";
import type { HostView } from "./hostlink/view.js";

beforeEach(() => {
  db.exec(`DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM hosts WHERE id != '${LOCAL_HOST_ID}';`);
});

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

function view(over: Partial<HostView> & { name: string }): HostView {
  return {
    id: `h_${over.name}`, platform: "darwin", status: "online", connected: true, is_brain: false,
    created_at: "", last_seen_at: null, policy: { deny: [] }, reserve: null, link: null, version: "1.0.0",
    vitals: { history: [{ at: NOW, cpu: 25, ram: 62, gpu: null }], load_per_core: 0.4, pressure: 1, swap_pct: 0, ram: null },
    admission: { ok: true }, live_sessions: 0,
    checklist: { clis: [], profiles: [], workspaces: [], veto: [], reported_at: null },
    commit: null, install: "git", update: null,
    ...over,
  } as HostView;
}

test("hostsLine: one computer says nothing — a single-Mac install's turn reads as it always did", () => {
  assert.equal(hostsLine([view({ name: "local", id: LOCAL_HOST_ID, is_brain: true })], NOW), "");
  assert.equal(hostsLine([], NOW), "");
});

test("hostsLine: load and live per computer, offline for how long, and what is wrong on each", () => {
  const line = hostsLine([
    view({ name: "local", id: LOCAL_HOST_ID, is_brain: true, live_sessions: 3 }),
    view({ name: "m2", live_sessions: 1, vitals: { history: [{ at: NOW, cpu: 45, ram: 50, gpu: null }], load_per_core: 1, pressure: 1, swap_pct: 0, ram: null } }),
    view({ name: "m5", connected: false, status: "offline", last_seen_at: new Date(NOW - 12 * 60_000).toISOString(), live_sessions: 2, vitals: { history: [], load_per_core: null, pressure: null, swap_pct: null, ram: null } }),
    view({
      name: "atlas", status: "draining", admission: { ok: false, reason: "load 3.1/core" },
      checklist: { clis: [{ name: "claude", ok: false, version: null, auth: "no" }], profiles: [{ name: "claude-acme", ok: false, auth: "no" }, { name: "claude", ok: true, auth: "unknown" }], gh: [], workspaces: [], veto: [], reported_at: null },
      update: { available: true, supported: true, target: { version: "1.0.0", commit: "b".repeat(40) }, manual: null, status: null },
    }),
  ], NOW);
  assert.equal(
    line,
    "HOSTS: local (brain) cpu 25% ram 62% 3 live · m2 cpu 45% ram 50% 1 live · m5 OFFLINE 12m 2 live · " +
      "atlas cpu 25% ram 62% 0 live, draining, full (load 3.1/core), claude logged out, profile claude-acme logged out, behind brain (update)",
  );
});

test("hostsLine: a disabled computer says so instead of OFFLINE; a failed update outranks 'behind'", () => {
  const line = hostsLine([
    view({ name: "local", id: LOCAL_HOST_ID, is_brain: true }),
    view({ name: "cedar", connected: false, status: "disabled" }),
    view({ name: "m2", update: { available: true, supported: true, target: { version: "1", commit: null }, manual: null, status: { id: "u", target: { version: "1", commit: null }, state: "failed", at: NOW } } }),
  ], NOW);
  assert.match(line, /cedar disabled/);
  assert.match(line, /m2 cpu 25% ram 62% 0 live, update failed$/);
});

test("hostSuffix: nothing for the brain, @name for a host, and a warning while its link is down", () => {
  const nameOf = (id: string) => ({ h_m2: "m2" } as Record<string, string>)[id] ?? id;
  assert.equal(hostSuffix({ host_id: LOCAL_HOST_ID, status: "live" }, nameOf), "");
  assert.equal(hostSuffix({ host_id: null, status: "live" }, nameOf), "");
  // Never registered on this brain = not online: the card must not read as fine.
  assert.equal(hostSuffix({ host_id: "h_m2", status: "live" }, nameOf), " · @m2 · ⚠ m2 offline");
  // An ended row is not "offline", it is ended.
  assert.equal(hostSuffix({ host_id: "h_m2", status: "ended" }, nameOf), " · @m2");
});

test("fleetLine: no joined host → no HOSTS line; one joined → HOSTS leads and the remote row names its computer", () => {
  const ws = workspaces.create({ slug: "fl-acme", name: "Acme", config_dir: "/tmp/fl-acme" });
  sessions.create({ workspace_id: ws.id, goal: "fix the login bug", cwd: "/tmp" } as any);
  const solo = fleetLine(ws.id);
  assert.doesNotMatch(solo, /HOSTS:/);
  assert.doesNotMatch(solo, /@/);

  hosts.create({ id: "h_fl_m2", name: "m2", token_hash: "x".repeat(64), status: "offline" });
  sessions.create({ workspace_id: ws.id, goal: "ship the rollback", cwd: "", host_id: "h_fl_m2" } as any);
  const out = fleetLine(ws.id);
  const [head, ...rest] = out.split("\n");
  assert.match(head, /^HOSTS: .*\(brain\).* · m2 OFFLINE/);
  assert.match(rest[0], /^FLEET NOW \(2 open/);
  const remote = rest.find((l) => l.includes("ship the rollback"))!;
  assert.match(remote, / · @m2 · ⚠ m2 offline$/);
  const local = rest.find((l) => l.includes("fix the login bug"))!;
  assert.doesNotMatch(local, /@/);
});
