/**
 * GET /api/robert/outbox, asked of the running API: the operator reads every workspace's record; a
 * workspace token — or that workspace's own Robert — reads its own and nothing else, and asking for
 * another workspace (or the default thread) is refused the same way whether it exists or not.
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
const { workspaces } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const { sayUnprompted } = await import("./robert-outbox.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const A = workspaces.create({ slug: `acme-ob-${Date.now()}`, name: "Acme", config_dir: "/tmp/ob-acme" } as any);
const G = workspaces.create({ slug: `globex-ob-${Date.now()}`, name: "Globex", config_dir: "/tmp/ob-globex" } as any);
sayUnprompted({ source: "wake", body: "ACME-LINE: PR #12 is ready for your OK.", ws: A.id, episode: "pr:12" });
sayUnprompted({ source: "wake", body: "ACME-OLD: said three hours ago.", ws: A.id, episode: "pr:9" }, Date.now() - 3 * 3_600_000);
sayUnprompted({ source: "watch", body: "GLOBEX-LINE: the import job is red again.", ws: G.id, episode: "session:g" });
sayUnprompted({ source: "failover", body: "FLEET-LINE: m2 offline 6m, moved 1 terminal here.", ws: null, episode: "host:m2" });

const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": A.token };
const asG = { ...json, "x-mc-workspace-token": G.token };
const asRobertA = { ...json, "x-mc-admin": robertToken(A.id, "rw", "wake") };
async function call(p: string, headers: Record<string, string>) {
  const r = await fetch(base + p, { headers });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out, raw: JSON.stringify(out) };
}
const bodies = (r: { json: any }) => (r.json.rows as Array<{ body: string }>).map((x) => x.body.split(":")[0]).sort();

test("the operator reads every workspace's outbox, one workspace by id or slug, or the default thread", async () => {
  assert.deepEqual(bodies(await call("/robert/outbox", admin)), ["ACME-LINE", "ACME-OLD", "FLEET-LINE", "GLOBEX-LINE"]);
  assert.deepEqual(bodies(await call(`/robert/outbox?ws=${A.slug}`, admin)), ["ACME-LINE", "ACME-OLD"]);
  assert.deepEqual(bodies(await call(`/robert/outbox?ws=${A.id}`, admin)), ["ACME-LINE", "ACME-OLD"]);
  assert.deepEqual(bodies(await call("/robert/outbox?ws=default", admin)), ["FLEET-LINE"]);
  assert.equal((await call("/robert/outbox?ws=nobody-here", admin)).status, 404);
  const one = (await call(`/robert/outbox?ws=${G.slug}`, admin)).json.rows[0];
  assert.equal(one.workspace, G.slug);
  assert.equal(one.source, "watch");
  assert.equal(one.status, "held");
  assert.equal(one.reason, "desk posts off");
  assert.equal(one.episode, "session:g");
});

test("a workspace token reads its own outbox only; another workspace or the default thread is refused, and nothing leaks", async () => {
  assert.deepEqual(bodies(await call("/robert/outbox", asA)), ["ACME-LINE", "ACME-OLD"]);
  assert.deepEqual(bodies(await call(`/robert/outbox?ws=${A.slug}`, asA)), ["ACME-LINE", "ACME-OLD"]);
  assert.deepEqual(bodies(await call("/robert/outbox", asG)), ["GLOBEX-LINE"]);
  for (const ref of [G.slug, G.id, "default", "nobody-here"]) {
    const r = await call(`/robert/outbox?ws=${encodeURIComponent(ref)}`, asA);
    assert.equal(r.status, 403, `ws=${ref}`);
    assert.doesNotMatch(r.raw, /GLOBEX-LINE|FLEET-LINE/, `ws=${ref} leaked another scope`);
  }
  assert.equal((await call("/robert/outbox?ws=default", asG)).status, 403);
});

test("a project's Robert reads his own workspace's outbox, not another's", async () => {
  assert.deepEqual(bodies(await call("/robert/outbox", asRobertA)), ["ACME-LINE", "ACME-OLD"]);
  const r = await call(`/robert/outbox?ws=${G.slug}`, asRobertA);
  assert.equal(r.status, 403);
  assert.doesNotMatch(r.raw, /GLOBEX-LINE/);
});

test("no token, or a token nobody issued, reads nothing", async () => {
  for (const h of [json, { ...json, "x-mc-workspace-token": "not-a-token" }]) {
    const r = await call("/robert/outbox", h);
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.raw, /LINE/);
  }
});

test("since and status narrow the record; a bad one is a 400", async () => {
  assert.deepEqual(bodies(await call(`/robert/outbox?ws=${A.slug}&since=1h`, admin)), ["ACME-LINE"]);
  assert.deepEqual(bodies(await call(`/robert/outbox?ws=${A.slug}&since=24h`, admin)), ["ACME-LINE", "ACME-OLD"]);
  assert.equal((await call("/robert/outbox?status=delivered", admin)).json.rows.length, 0);
  assert.equal((await call("/robert/outbox?status=held", admin)).json.rows.length, 4);
  assert.equal((await call("/robert/outbox?status=shouted", admin)).status, 400);
  assert.equal((await call("/robert/outbox?since=whenever", admin)).status, 400);
});
