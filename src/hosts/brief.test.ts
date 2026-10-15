/**
 * `GET /api/hosts/brief` (src/hosts/brief.ts): where work can go, for a caller with only a workspace
 * token — and nothing about any other workspace's policy.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { hosts, sessions, workspaces, LOCAL_HOST_ID } from "../store.js";
import { hostBriefRoutes, hostsBrief } from "./brief.js";
import type { HostCandidate } from "./placement.js";

const acme = workspaces.create({ slug: "brief-acme", name: "Acme", config_dir: "/tmp/brief-acme", sandbox_mode: "off" } as any);
const globex = workspaces.create({ slug: "brief-globex", name: "Globex", config_dir: "/tmp/brief-globex", sandbox_mode: "off" } as any);
hosts.create({ id: "h_br_m2", name: "m2", token_hash: "x".repeat(64), status: "online" });
sessions.create({ workspace_id: acme.id, goal: "x", cwd: "", host_id: "h_br_m2" } as any);

const load = { load1: 2, ncpu: 8, loadPerCore: 0.25, swapUsedMb: 0, swapTotalMb: 0, pressureLevel: 1 as const };
const cand = (over: Partial<HostCandidate>): HostCandidate => ({
  id: "h_br_m2", name: "m2", is_brain: false, online: true, status: "online", deny: [], veto: [], platform: "darwin",
  sandbox: true, clis: ["claude"], unauthed: [], profiles: [{ name: "claude", exists: true }], checkouts: [], auto_clone: true, procs: true, egress: true,
  load, ram_pct: 40, ...over,
});
const cands = (): HostCandidate[] => [
  cand({ id: LOCAL_HOST_ID, name: "local", is_brain: true, clis: [] }),
  // m2: policy keeps Globex off it.
  cand({ deny: [globex.slug] }),
  cand({ id: "h_br_m5", name: "m5", online: false, status: "offline", load: null, ram_pct: null }),
];

test("hostsBrief: room, live count and up/down for everyone; may_run only for the asking workspace", () => {
  const none = hostsBrief(null, cands());
  assert.deepEqual(none.map((h) => [h.name, h.online, h.may_run]), [["local", true, null], ["m2", true, null], ["m5", false, null]]);
  const m2 = none[1];
  assert.equal(m2.live, 1);
  assert.equal(typeof m2.headroom, "number");
  assert.equal(none[2].headroom, null, "no reading, no number");
  assert.equal(none[2].full, "offline");

  const a = hostsBrief(acme.id, cands());
  assert.deepEqual(a.map((h) => h.may_run), [true, true, false]);
  assert.equal(a[2].why_not, "offline");
  const g = hostsBrief(globex.id, cands());
  assert.equal(g[1].may_run, false);
  assert.match(g[1].why_not!, /brief-globex is not allowed on host m2/);
});

const app = express();
app.use("/api", hostBriefRoutes(cands));
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(() => server.close());

test("GET /hosts/brief: a workspace token answers for its own workspace, whatever it asks for", async () => {
  const r = await fetch(`${base}/hosts/brief?workspace=${globex.slug}`, { headers: { "x-mc-workspace-token": (acme as any).token } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.workspace_id, acme.id, "cannot ask on another workspace's behalf");
  assert.deepEqual(body.hosts.map((h: any) => h.may_run), [true, true, false]);
  // Nothing in it is another workspace's: no policy, no veto, no inventory.
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /globex/i);
  assert.doesNotMatch(text, /deny|veto|token|policy/);
});

test("GET /hosts/brief: a bad token is refused; the operator may name a workspace or none", async () => {
  assert.equal((await fetch(`${base}/hosts/brief`, { headers: { "x-mc-workspace-token": "nope" } })).status, 401);
  const op = await (await fetch(`${base}/hosts/brief?workspace=${globex.slug}`)).json();
  assert.equal(op.workspace_id, globex.id);
  assert.equal(op.hosts[1].may_run, false);
  const bare = await (await fetch(`${base}/hosts/brief`)).json();
  assert.equal(bare.workspace_id, null);
  assert.ok(bare.hosts.every((h: any) => h.may_run === null));
});
