/**
 * Who may call the setup routes (src/setup-routes.ts), asked over HTTP with the real gates: reading the
 * picture and trying a CLI are admin-gated like any other route (the fleet-wide Robert passes); installing
 * software and starting a sign-in are the operator's own hand — no Robert credential, whatever robert-scope
 * would allow. The checks themselves are faked here (src/setup-check.test.ts covers them).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { CONFIG } from "./config.js";
import { workspaces } from "./store.js";
import { requireAdmin, robertToken, setRobertGate } from "./authz.js";
import { robertGateFor } from "./robert-scope.js";
import { OPERATOR_ONLY, setupRoutes, type SetupImpl } from "./setup-routes.js";

setRobertGate(robertGateFor);
const seen: string[] = [];
const impl: SetupImpl = {
  status: async (o) => { seen.push(`status fresh=${!!o.fresh}`); return { daemon: { ok: true }, projects: 0, clis: [] }; },
  smoke: async (id) => { seen.push(`smoke ${id}`); return { ok: true, ms: 5, reply: "OK" }; },
  install: async (id) => { seen.push(`install ${id}`); if (id === "grok") throw new Error("installer exploded"); return { ok: true, log_tail: "done" }; },
  login: async (id) => { seen.push(`login ${id}`); return { ok: true }; },
};
const app = express();
app.use(express.json());
const api = express.Router();
api.use(setupRoutes(requireAdmin, impl));
app.use("/api", api);
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
after(() => srv.close());
const base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/api`;

async function call(method: string, p: string, h: Record<string, string> = {}) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...h }, body: method === "POST" ? "{}" : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const admin = { "x-mc-admin": CONFIG.adminToken };
const ws = workspaces.create({ slug: `setup-rt-${Date.now()}`, name: "Acme", config_dir: fs.mkdtempSync(path.join(os.tmpdir(), "setup-rt-")) } as any);
const fleetRobert = { "x-mc-admin": robertToken(null, "rw", "operator") };
const projectRobert = { "x-mc-admin": robertToken(ws.id, "rw") };

test("status and the test prompt: admin-gated; ?fresh=1 skips the cache; an unknown CLI is a 404", async () => {
  assert.equal((await call("GET", "/setup/status")).status, 403);
  assert.equal((await call("GET", "/setup/status", { "x-mc-admin": "wrong" })).status, 403);
  seen.length = 0;
  assert.equal((await call("GET", "/setup/status", admin)).status, 200);
  assert.equal((await call("GET", "/setup/status?fresh=1", admin)).status, 200);
  assert.deepEqual(seen, ["status fresh=false", "status fresh=true"]);
  assert.deepEqual((await call("POST", "/setup/smoke/claude", admin)).json, { ok: true, ms: 5, reply: "OK" });
  assert.equal((await call("POST", "/setup/smoke/rm -rf", admin)).status, 404);
  assert.equal((await call("POST", "/setup/smoke/claude")).status, 403);
  // The fleet-wide Robert reads like the operator did (robert-scope.ts) — he can see what is installed.
  assert.equal((await call("GET", "/setup/status", fleetRobert)).status, 200);
});

test("install and sign-in: the operator's token only — never a Robert, never nobody", async () => {
  seen.length = 0;
  for (const p of ["/setup/install/claude", "/setup/login/codex"]) {
    for (const [who, h] of [["fleet Robert", fleetRobert], ["project Robert", projectRobert], ["nobody", {}], ["a wrong token", { "x-mc-admin": "nope" }]] as const) {
      const r = await call("POST", p, h);
      assert.equal(r.status, 403, `${who} → ${p}`);
      assert.equal(r.json.error, OPERATOR_ONLY);
    }
  }
  assert.deepEqual(seen, [], "nothing ran for any of them");
  assert.deepEqual((await call("POST", "/setup/install/claude", admin)).json, { ok: true, log_tail: "done" });
  assert.deepEqual((await call("POST", "/setup/login/codex", admin)).json, { ok: true });
  assert.equal((await call("POST", "/setup/login/nope", admin)).status, 404);
  const boom = await call("POST", "/setup/install/grok", admin);
  assert.deepEqual([boom.status, boom.json], [500, { error: "installer exploded" }]);
  assert.deepEqual(seen, ["install claude", "login codex", "install grok"]);
});
