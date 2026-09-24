/**
 * GET /api/hosts/bar — the brain menu bar's one read (bar.ts). Shape, the admin gate (the real one's
 * rule: `tokenOk(x-mc-admin, CONFIG.adminToken)`), "working" from the brain's own pty activity for local
 * AND remote terminals, runs, and that nothing secret rides along.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { db, jobs, runs, sessions, workspaces, LOCAL_HOST_ID } from "../store.js";
import { CONFIG } from "../config.js";
import { tokenOk } from "../authz.js";
import { barRoutes, fleetBar, type ActivityFn } from "./bar.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM workspaces;");
  db.exec("DELETE FROM hosts WHERE id != 'local'; UPDATE hosts SET name = 'studio' WHERE id = 'local';");
});

const T0 = Date.parse("2026-09-24T10:00:00Z");

function addHost(id: string, name: string, o: { revoked?: boolean; lastSeen?: string } = {}) {
  db.prepare("INSERT INTO hosts (id,name,platform,status,token_hash,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, name, "darwin", "online", o.revoked ? null : "sha256:SECRET-HASH-" + id, o.lastSeen ?? null, new Date(T0).toISOString());
}

function addSession(o: { host?: string; goal?: string | null; title?: string | null; cwd: string; worktree?: string | null; backend?: string; status?: "live" | "ended"; cloud?: boolean }) {
  const w = workspaces.list()[0] ?? workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const s = sessions.create({ workspace_id: w.id, cwd: o.cwd, backend: o.backend ?? "claude-code" } as any);
  db.prepare("UPDATE sessions SET host_id = ?, status = ?, goal = ?, title = ?, worktree_path = ?, created_at = ?, cloud_agent_id = ? WHERE id = ?")
    .run(o.host ?? LOCAL_HOST_ID, o.status ?? "live", o.goal ?? null, o.title ?? null, o.worktree ?? null, new Date(T0 - 12 * 60_000).toISOString(), o.cloud ? "bc-1" : null, s.id);
  return s.id;
}

function addRun(o: { host?: string; name: string; cwd: string; backend?: string; status?: string }) {
  const j = jobs.create({ name: o.name, goal: "g", cwd: o.cwd, backend: o.backend ?? "codex" });
  const r = runs.create(j.id, "manual");
  // runs.cwd is where it actually ran (what a host reports); the job's cwd is sanitised to a real dir.
  db.prepare("UPDATE runs SET status = ?, host_id = ?, started_at = ?, cwd = ? WHERE id = ?")
    .run(o.status ?? "running", o.host ?? LOCAL_HOST_ID, new Date(T0 - 3 * 3600_000).toISOString(), o.cwd, r.id);
  return r.id;
}

const linkOf = (ids: string[]) => ({ list: () => ids.map((host_id) => ({ host_id, connected_at: T0 - 5 * 60_000 })) }) as any;

/** The brain's activity registry, faked: `working` ids produce bytes, `quiet` ids are live and silent. */
const activityOf = (working: string[], quiet: string[] = []): ActivityFn => (id) =>
  working.includes(id) ? { live: true, quiet: false, last_out: T0 - 1000 }
  : quiet.includes(id) ? { live: true, quiet: true, last_out: T0 - 90_000 }
  : { live: false, quiet: true, last_out: null };

test("the fleet: the brain first, working = the brain's own pty activity for local and remote terminals, runs count", () => {
  addHost("h_m2", "m2");
  addHost("h_m5", "m5", { lastSeen: new Date(T0 - 7 * 60_000).toISOString() });
  addHost("h_gone", "gone", { revoked: true });
  const a = addSession({ goal: "open the rollback PR", cwd: "/Users/leo/src/app", worktree: "/Users/leo/src/.chronos-worktrees/app/ACM-12" });
  const b = addSession({ title: "tidy the docs", cwd: "/Users/leo/src/docs" });
  const c = addSession({ host: "h_m2", goal: "fix the dbt model", cwd: "/Users/m2/work/dbt", backend: "codex" });
  addSession({ host: "h_m5", cwd: "/Users/m5" });
  addSession({ cwd: "/x/ended", status: "ended" });
  addSession({ cwd: "/x/cloud", cloud: true });
  addSession({ host: "h_gone", cwd: "/x/revoked" });
  const r = addRun({ name: "nightly-sweep", cwd: "/Users/leo/src/api" });
  addRun({ name: "done-already", cwd: "/x", status: "success" });

  const bar = fleetBar(linkOf(["h_m2"]), activityOf([a, c], [b]), T0);
  assert.deepEqual(bar.brain, { name: "studio" });
  assert.deepEqual(bar.computers.map((x) => [x.name, x.is_brain, x.connected, x.link_state, x.working, x.total]), [
    ["studio", true, true, "online", 2, 3],
    ["m2", false, true, "online", 1, 1],
    ["m5", false, false, "offline", 0, 1],
  ], "revoked host and its rows gone; ended + cloud sessions not counted");
  assert.deepEqual(bar.totals, { working: 3, total: 5 });

  const [brain, m2, m5] = bar.computers;
  assert.equal(brain.since, null);
  assert.equal(m2.since, T0 - 5 * 60_000, "connected: since the link came up");
  assert.equal(m5.since, T0 - 7 * 60_000, "offline: since it was last heard from");
  assert.deepEqual(brain.items.map((i) => [i.kind, i.repo, i.title, i.backend, i.active]), [
    ["run", "api", "nightly-sweep", "codex", true],
    ["terminal", "app", "open the rollback PR", "claude-code", true],
    ["terminal", "docs", "tidy the docs", "claude-code", false],
  ], "active first, then oldest; a worktree reports its repo, never its (ticket-key) branch");
  assert.equal(brain.items[0].id8, r.slice(0, 8));
  assert.equal(brain.items[0].started_at, T0 - 3 * 3600_000);
  assert.equal(brain.items[1].id8, a.slice(0, 8));
  assert.equal(brain.items[1].last_output_at, T0 - 1000);
  assert.equal(brain.items[1].started_at, T0 - 12 * 60_000);
  assert.deepEqual(m2.items.map((i) => [i.repo, i.title, i.active]), [["dbt", "fix the dbt model", true]], "a remote pty's bytes reach the brain: it knows m2 is working");
  assert.deepEqual(m5.items.map((i) => [i.repo, i.title, i.active, i.last_output_at]), [[null, null, false, T0 - 12 * 60_000]], "link down: live row, not seen producing; a home dir is no repo");
});

test("an idle fleet is zeros, not an error", () => {
  const bar = fleetBar(linkOf([]), activityOf([]), T0);
  assert.deepEqual(bar, { brain: { name: "studio" }, computers: [{ id: LOCAL_HOST_ID, name: "studio", is_brain: true, connected: true, link_state: "online", since: null, working: 0, total: 0, items: [] }], totals: { working: 0, total: 0 } });
});

test("GET /api/hosts/bar: admin only (the real gate's rule), and nothing secret in the reply", async () => {
  addHost("h_m2", "m2");
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const s = addSession({ host: "h_m2", goal: "ship it", cwd: "/Users/m2/work/app" });
  db.prepare("UPDATE sessions SET lead_token = 'LEAD-SECRET' WHERE id = ?").run(s);
  const app = express();
  // Exactly api.ts's requireAdmin.
  const requireAdmin: express.RequestHandler = (req, res, next) =>
    tokenOk(req.get("x-mc-admin"), CONFIG.adminToken) ? next() : void res.status(403).json({ error: "admin token required" });
  app.use("/api", barRoutes(requireAdmin, { link: () => linkOf(["h_m2"]), activity: activityOf([s]) }));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/api/hosts/bar`;
  try {
    assert.equal((await fetch(url)).status, 403, "no token");
    assert.equal((await fetch(url, { headers: { "x-mc-workspace-token": w.token } })).status, 403, "a workspace token is not the admin token");
    assert.equal((await fetch(url, { headers: { "x-mc-admin": w.token } })).status, 403, "nor is it one when sent as the admin header");
    const ok = await fetch(url, { headers: { "x-mc-admin": CONFIG.adminToken } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const raw = await ok.text();
    const body = JSON.parse(raw);
    assert.deepEqual(body.totals, { working: 1, total: 1 });
    assert.deepEqual(Object.keys(body.computers[1].items[0]).sort(), ["active", "backend", "id8", "kind", "last_output_at", "repo", "started_at", "title"], "an allowlist: no cwd, env, pid, prompt");
    for (const leak of ["SECRET-HASH", "LEAD-SECRET", w.token, CONFIG.adminToken, "/Users/m2/work", "token", "env"]) assert.ok(!raw.includes(leak), `no ${leak} in the reply`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
