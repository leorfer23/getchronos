/**
 * /api/ws-triggers asked of the running API (the handlers' rules are in src/ws-triggers.test.ts): the
 * routes are mounted, validated and walled — another workspace's token gets the 404 an unknown id gets,
 * a terminal's token proposes (saved off), and a call with no token is refused.
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
const { workspaces, wsTriggers } = await import("./store.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-wstrig-api-"));
const A = workspaces.create({ slug: `tr-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: tmp } as any);
const B = workspaces.create({ slug: `tr-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: tmp } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token! };
const asB = { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token! };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

test("/api/ws-triggers: mounted, validated and walled per workspace", async () => {
  assert.equal((await call("POST", "/ws-triggers", json, { kind: "command", target: "true" })).status, 401, "no token, no trigger");
  assert.equal((await call("POST", "/ws-triggers", asA, { kind: "command", target: "true", every: { x: 1 } })).status, 400, "the body is validated");
  assert.equal((await call("POST", "/ws-triggers", asB, { kind: "command", target: "true", workspace_id: A.id })).status, 404, "B cannot add one into A");

  const made = await call("POST", "/ws-triggers", asA, { kind: "command", target: "true", goal: "check it" });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.workspace_id, A.id);
  assert.equal(made.json.enabled, false, "a workspace token proposes; it is saved off");
  const id = made.json.id;

  assert.deepEqual((await call("GET", "/ws-triggers", asB)).json, []);
  assert.equal((await call("GET", "/ws-triggers", asA)).json.length, 1);
  for (const [m, p, b] of [["GET", `/ws-triggers/${id}`], ["PATCH", `/ws-triggers/${id}`, { enabled: false }], ["POST", `/ws-triggers/${id}/test`, {}], ["DELETE", `/ws-triggers/${id}`]] as const) {
    assert.equal((await call(m, p, asB, b)).status, 404, `${m} ${p} as B`);
  }
  assert.equal((await call("PATCH", `/ws-triggers/${id}`, asA, { enabled: true })).status, 403, "a terminal does not arm it");
  const armed = await call("PATCH", `/ws-triggers/${id.slice(0, 8)}`, admin, { enabled: true });
  assert.equal(armed.status, 200);
  assert.equal(armed.json.enabled, true);
  assert.equal((await call("DELETE", `/ws-triggers/${id}`, asA)).status, 403);
  assert.equal((await call("DELETE", `/ws-triggers/${id}`, admin)).status, 200);
  assert.equal(wsTriggers.get(id), undefined);
});
