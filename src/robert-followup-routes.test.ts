/**
 * Who may create, see and cancel Robert's follow-ups — asked of the running API, so requireAdmin,
 * robert-scope.ts and the handler are all in the path. Each refusal is paired with a call that gets
 * through, so a route that vanished (404 for everyone) cannot pass for one that is guarded.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertToken } = await import("./authz.js");
const { continuations, workspaces } = await import("./store.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const A = workspaces.create({ slug: `fu-a-${Date.now()}`, name: "Acme", config_dir: "/tmp/fu-acme" } as any);
const B = workspaces.create({ slug: `fu-b-${Date.now()}`, name: "Globex", config_dir: "/tmp/fu-globex" } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const robertA = { ...json, "x-mc-admin": robertToken(A.id, "rw", "wake") };
const robertB = { ...json, "x-mc-admin": robertToken(B.id, "rw", "operator") };
const robertAro = { ...json, "x-mc-admin": robertToken(A.id, "ro", "operator") };
const fleet = { ...json, "x-mc-admin": robertToken(null, "rw", "operator") };
const termA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token! };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}
const ids = (r: { json: any }) => (Array.isArray(r.json) ? r.json.map((f: any) => f.id) : r.json);

test("a workspace's Robert sets, sees and cancels his own follow-ups — never another workspace's", async () => {
  const mine = await call("POST", "/robert/followups", robertA, { when: "+1h", note: "check CI on PR 12", subject: "https://github.com/acme/app/pull/12" });
  assert.equal(mine.status, 201, JSON.stringify(mine.json));
  assert.equal(mine.json.workspace_id, A.id, "pinned to his workspace");
  assert.equal(mine.json.status, "pending");
  assert.equal(mine.json.subject, "https://github.com/acme/app/pull/12");
  assert.equal(mine.json.created_by, "robert");
  const id = mine.json.id as string;

  assert.deepEqual(ids(await call("GET", "/robert/followups", robertA)), [id]);
  assert.deepEqual(ids(await call("GET", "/robert/followups", robertB)), [], "another Robert does not see it");
  assert.equal((await call("GET", `/robert/followups?workspace=${A.id}`, robertB)).status, 403, "nor by naming the workspace");

  assert.equal((await call("POST", `/robert/followups/${id.slice(0, 8)}/cancel`, robertB, {})).status, 403, "nor cancel it");
  assert.equal((await call("POST", "/robert/followups", robertB, { when: "+1h", note: "x", workspace_id: A.id })).status, 403, "nor set one there");
  assert.equal(continuations.get(id)!.status, "armed");

  const done = await call("POST", `/robert/followups/${id.slice(0, 8)}/cancel`, robertA, { why: "CI went green" });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.status, "cancelled");
  assert.equal((await call("POST", `/robert/followups/${id}/cancel`, robertA, {})).status, 409, "already cancelled");
});

test("a terminal's workspace token, the fleet-wide Robert and the read-only Robert are refused", async () => {
  const f = await call("POST", "/robert/followups", robertA, { when: "+2h", note: "did the operator answer about the deploy?" });
  assert.equal(f.status, 201);
  const id = f.json.id as string;

  for (const [who, h] of [["terminal", termA], ["fleet Robert", fleet]] as const) {
    assert.equal((await call("POST", "/robert/followups", h, { when: "+1h", note: "x", workspace_id: A.id })).status, 403, `${who} create`);
    assert.equal((await call("GET", "/robert/followups", h)).status, 403, `${who} list`);
    assert.equal((await call("POST", `/robert/followups/${id}/cancel`, h, {})).status, 403, `${who} cancel`);
  }
  assert.equal((await call("POST", "/robert/followups", robertAro, { when: "+1h", note: "x" })).status, 403, "read-only Robert cannot set one");
  assert.deepEqual(ids(await call("GET", "/robert/followups", robertAro)), [id], "but may read his own");

  // The generic `mc when` doors do not leak it to a terminal of the same workspace either.
  const listed = await call("GET", "/continuations", termA);
  assert.equal(listed.status, 200);
  assert.ok(!listed.json.some((c: any) => c.id === id), "not listed to a terminal");
  assert.equal((await call("GET", `/continuations/${id}`, termA)).status, 404);
  assert.equal((await call("POST", `/continuations/${id}/fire`, termA, {})).status, 404);
  assert.equal((await call("POST", `/continuations/${id}/cancel`, termA, {})).status, 404);
  assert.equal(continuations.get(id)!.status, "armed");
  assert.ok((await call("GET", "/continuations", admin)).json.some((c: any) => c.id === id), "the operator's Desk still lists it");
});

test("the operator names the workspace, sees every workspace's, and may cancel any", async () => {
  assert.equal((await call("POST", "/robert/followups", admin, { when: "+1h", note: "x" })).status, 400, "which workspace?");
  const f = await call("POST", "/robert/followups", admin, { when: "+3h", note: "look at the globex rollout", workspace_id: B.id });
  assert.equal(f.status, 201, JSON.stringify(f.json));
  assert.equal(f.json.created_by, "operator");
  assert.ok(ids(await call("GET", `/robert/followups?workspace=${B.id}`, admin)).includes(f.json.id));
  assert.equal((await call("POST", `/robert/followups/${f.json.id}/cancel`, admin, {})).status, 200);
  assert.equal((await call("POST", "/robert/followups", robertA, { when: "+1h", note: "again", every: "1h" })).status, 400, "no recurrence");
});
