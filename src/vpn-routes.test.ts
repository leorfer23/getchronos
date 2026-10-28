/**
 * `/api/vpn` over real HTTP with the real store and authz (vpn-routes.ts), the holds over a fake
 * driver. What is under test is the workspace boundary (CLAUDE.md gotcha #4): a workspace token
 * switches only the VPN its own workspace names, holds only for its own terminals/runs, and never
 * sees another workspace's holders — plus the vpn_config column round-trip the routes depend on.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const { workspaces, sessions } = await import("./store.js");
const routes = await import("./vpn-routes.js");
const vpnMod = await import("./vpn.js");
const { PatchWorkspaceSchema } = await import("./validation.js");
import type { VpnDriver, VpnState } from "./vpn.js";

class FakeVpn implements VpnDriver {
  constructor(public now: VpnState = "down") {}
  async state() { return this.now; }
  async up() { this.now = "up"; }
  async down() { this.now = "down"; }
}
const drivers = new Map<string, FakeVpn>();
vpnMod.setVpnLeasesForTest(new vpnMod.VpnLeases({
  driver: (c) => {
    const k = vpnMod.vpnKey(c);
    if (!drivers.has(k)) drivers.set(k, new FakeVpn());
    return drivers.get(k)!;
  },
  isLive: vpnMod.holderLive,
  load: () => undefined,
  save: () => {},
  graceMs: 60_000,
  log: () => {},
}));

const t = Date.now();
const A = workspaces.create({ slug: `vpa-${t}`, name: "A", config_dir: "/tmp/vpa", vpn_config: { kind: "tailscale" } });
const B = workspaces.create({ slug: `vpb-${t}`, name: "B", config_dir: "/tmp/vpb", vpn_config: { kind: "tunnelblick", name: "corp-b" } });
const C = workspaces.create({ slug: `vpc-${t}`, name: "C", config_dir: "/tmp/vpc" });
const D = workspaces.create({ slug: `vpd-${t}`, name: "D", config_dir: "/tmp/vpd", vpn_config: { kind: "tailscale" } });
const sA = sessions.create({ cwd: "/tmp", title: "a", workspace_id: A.id } as any);
const sB = sessions.create({ cwd: "/tmp", title: "b", workspace_id: B.id } as any);
const sC = sessions.create({ cwd: "/tmp", title: "c", workspace_id: C.id } as any);
const sD = sessions.create({ cwd: "/tmp", title: "d", workspace_id: D.id } as any);
const sGone = sessions.create({ cwd: "/tmp", title: "gone", workspace_id: A.id } as any);
sessions.end(sGone.id);

const app = express();
app.use(express.json());
const api = express.Router();
routes.mountVpnRoutes(api);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.close(); vpnMod.setVpnLeasesForTest(null); });

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { "x-mc-workspace-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as any };
}

test("vpn_config: stored as JSON, kept by unrelated patches, cleared by null; the schema refuses junk", () => {
  assert.deepEqual(JSON.parse(workspaces.get(B.id)!.vpn_config!), { kind: "tunnelblick", name: "corp-b" });
  workspaces.update(B.id, { name: "B2" });
  assert.deepEqual(JSON.parse(workspaces.get(B.id)!.vpn_config!), { kind: "tunnelblick", name: "corp-b" });
  const tmp = workspaces.create({ slug: `vpt-${t}`, name: "T", config_dir: "/tmp/vpt", vpn_config: { kind: "tailscale" } });
  workspaces.update(tmp.id, { vpn_config: { kind: "tunnelblick", name: "corp-t" } });
  assert.deepEqual(JSON.parse(workspaces.get(tmp.id)!.vpn_config!), { kind: "tunnelblick", name: "corp-t" });
  workspaces.update(tmp.id, { vpn_config: null });
  assert.equal(workspaces.get(tmp.id)!.vpn_config, null);
  assert.equal(PatchWorkspaceSchema.safeParse({ vpn_config: { kind: "tailscale" } }).success, true);
  assert.equal(PatchWorkspaceSchema.safeParse({ vpn_config: { kind: "tunnelblick", name: "" } }).success, false);
  assert.equal(PatchWorkspaceSchema.safeParse({ vpn_config: { kind: "tunnelblick", name: "a\nb" } }).success, false);
  assert.equal(PatchWorkspaceSchema.safeParse({ vpn_config: { kind: "wireguard" } }).success, false);
});

test("a workspace holds its own VPN for its own terminal", async () => {
  const r = await call("POST", "/vpn/up", A.token, { session_id: sA.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, "up");
  assert.equal(r.json.turned_on, true);
  assert.deepEqual(r.json.holders.map((h: any) => h.id), [sA.id]);
  assert.equal(drivers.get("tailscale")!.now, "up");
});

test("another workspace's terminal, or another workspace by name, reads as not found", async () => {
  const r1 = await call("POST", "/vpn/up", A.token, { session_id: sB.id });
  assert.equal(r1.status, 404);
  const r2 = await call("POST", "/vpn/up", A.token, { workspace: B.slug, session_id: sA.id });
  assert.equal(r2.status, 404);
  assert.equal(drivers.get("tunnelblick:corp-b")?.now ?? "down", "down", "B's VPN was never touched");
});

test("a token with no terminal/run cannot switch the VPN; an ended terminal cannot hold it", async () => {
  assert.equal((await call("POST", "/vpn/up", A.token, {})).status, 400);
  assert.equal((await call("POST", "/vpn/down", A.token, {})).status, 400, "only the operator turns it off outright");
  const gone = await call("POST", "/vpn/up", A.token, { session_id: sGone.id });
  assert.equal(gone.status, 409);
});

test("a workspace with no VPN set is refused", async () => {
  const r = await call("POST", "/vpn/up", C.token, { session_id: sC.id });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /no VPN set/);
});

test("two workspaces sharing a VPN: each sees its own holds, the other only as a count", async () => {
  const d = await call("POST", "/vpn/up", D.token, { session_id: sD.id });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.turned_on, false, "A already turned it on");
  assert.deepEqual(d.json.holders.map((h: any) => h.id), [sD.id]);
  assert.equal(d.json.other_holders, 1);
  const s = await call("GET", "/vpn", A.token);
  assert.deepEqual(s.json.holders.map((h: any) => h.id), [sA.id]);
  assert.equal(s.json.other_holders, 1);
});

test("down drops the caller's hold only; the VPN stays up while another holds it", async () => {
  const r = await call("POST", "/vpn/down", A.token, { session_id: sA.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.released, true);
  assert.equal(r.json.state, "up");
  assert.equal(r.json.turns_off_at, null, "D still holds it");
  const again = await call("POST", "/vpn/down", A.token, { session_id: sA.id });
  assert.equal(again.json.released, false);
});

test("the operator (no token on this Mac) sees every workspace with a VPN, and can turn one off outright", async () => {
  const all = await call("GET", "/vpn", null);
  assert.equal(all.status, 200);
  const slugs = all.json.map((v: any) => v.workspace);
  assert.ok(slugs.includes(A.slug) && slugs.includes(B.slug) && slugs.includes(D.slug));
  assert.ok(!slugs.includes(C.slug));
  const off = await call("POST", "/vpn/down", null, { workspace: D.slug });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(off.json.state, "down");
  assert.equal(off.json.holders.length, 0);
  assert.equal(drivers.get("tailscale")!.now, "down");
  assert.equal((await call("POST", "/vpn/up", null, {})).status, 400, "the operator names the workspace");
});

test("the prompt line appears only for a workspace with a VPN", () => {
  assert.match(vpnMod.vpnPromptLine(workspaces.get(A.id)), /mc vpn up/);
  assert.equal(vpnMod.vpnPromptLine(workspaces.get(C.id)), "");
});
