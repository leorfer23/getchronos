/**
 * GET /api/robert/runs, asked of the running API: the operator reads every workspace's wake turns,
 * a workspace (its token, or its own Robert) reads only its own — never another's, never the
 * fleet-wide scope's — and no credential reads nothing.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertToken } = await import("./authz.js");
const { db, robertRuns, sessions, workspaces } = await import("./store.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-robert-runs-"));
const A = workspaces.create({ slug: `rr-acme-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a") } as any);
const B = workspaces.create({ slug: `rr-globex-${Date.now()}`, name: "Globex", config_dir: path.join(tmp, "cfg-b") } as any);
const admin = { "x-mc-admin": CONFIG.adminToken };
const asA = { "x-mc-workspace-token": workspaces.get(A.id)!.token };
const robertA = { "x-mc-admin": robertToken(A.id, "rw", "wake") };
const leadA = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
const asLeadA = { "x-mc-lead": sessions.leadToken(leadA.id)! };

const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
db.prepare("DELETE FROM robert_runs").run();
robertRuns.record({ workspace_id: A.id, started_at: recent(30), ended_at: recent(29), wakes: [{ key: "ask:a1", topic: "ask.created" }], outcome: "posted", cost_usd: 0.1, tokens_in: 5, tokens_out: 9 });
robertRuns.record({ workspace_id: A.id, started_at: recent(20), ended_at: recent(19), wakes: [{ key: "robert-sweep:a", topic: "robert.sweep" }], outcome: "quiet" });
robertRuns.record({ workspace_id: B.id, started_at: recent(10), ended_at: recent(9), wakes: [{ key: "ask:b1", topic: "ask.created" }], outcome: "failed", error: "engine down" });
robertRuns.record({ workspace_id: null, started_at: recent(5), ended_at: recent(4), wakes: [{ key: "term-drive:x", topic: "session.stopped" }], outcome: "empty" });
// Outside the default 24h window.
robertRuns.record({ workspace_id: A.id, started_at: recent(3 * 24 * 60), ended_at: recent(3 * 24 * 60), wakes: [{ key: "ask:old", topic: "ask.created" }], outcome: "posted" });

async function get(p: string, headers: Record<string, string>) {
  const r = await fetch(base + p, { headers });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const wsOf = (j: any) => [...new Set(j.runs.map((r: any) => r.workspace_id))].sort();

test("the operator reads every scope, with a rollup of the window", async () => {
  const { status, json } = await get("/robert/runs", admin);
  assert.equal(status, 200);
  assert.equal(json.runs.length, 4, "last 24h by default");
  assert.deepEqual(json.rollup.by_outcome, { posted: 1, quiet: 1, empty: 1, dropped: 0, failed: 1 });
  assert.equal(json.rollup.by_workspace[A.id].workspace, A.slug);
  assert.equal(json.rollup.by_workspace.default.runs, 1);
  assert.equal(json.rollup.by_topic["ask.created"].runs, 2);
  assert.deepEqual(json.runs[0].wake_keys, ["term-drive:x"], "newest first, keys as an array");
  assert.equal((await get("/robert/runs?since=7d", admin)).json.runs.length, 5);
});

test("the operator narrows to one workspace by slug, or to the default scope", async () => {
  const one = await get(`/robert/runs?ws=${B.slug}`, admin);
  assert.deepEqual(wsOf(one.json), [B.id]);
  const dflt = await get("/robert/runs?ws=default", admin);
  assert.deepEqual(wsOf(dflt.json), [null]);
  assert.equal((await get("/robert/runs?ws=no-such-ws", admin)).status, 404);
  assert.equal((await get("/robert/runs?since=whenever", admin)).status, 400);
});

test("a workspace token reads only its own rows — asking for another workspace changes nothing", async () => {
  const own = await get("/robert/runs", asA);
  assert.equal(own.status, 200);
  assert.deepEqual(wsOf(own.json), [A.id]);
  assert.equal(own.json.rollup.runs, 2);
  assert.deepEqual(Object.keys(own.json.rollup.by_workspace), [A.id]);
  for (const ws of [B.slug, B.id, "default"]) {
    const other = await get(`/robert/runs?ws=${ws}`, asA);
    assert.deepEqual(wsOf(other.json), [A.id], `?ws=${ws} must not reach past its own wall`);
  }
});

test("a workspace's own Robert reads only that workspace", async () => {
  const r = await get(`/robert/runs?ws=${B.slug}`, robertA);
  assert.equal(r.status, 200);
  assert.deepEqual(wsOf(r.json), [A.id]);
});

test("no credential, a bad one, or a Lead's alone reads nothing", async () => {
  assert.equal((await get("/robert/runs", {})).status, 401);
  assert.equal((await get("/robert/runs", { "x-mc-workspace-token": "nope" })).status, 401);
  assert.equal((await get("/robert/runs", asLeadA)).status, 401);
});
