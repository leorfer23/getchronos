/**
 * The house style and the critic's renders over HTTP (src/style-routes.ts), asked of the running API:
 * a workspace's own token and the operator's get through, another workspace's token gets the same 404
 * a missing id does, no token gets nothing. Each refusal is paired with a call that gets through.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-style-routes-"));
process.env.CHRONOS_CRITIC_DIR = path.join(tmp, "critic");
const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { sessions, workspaces } = await import("./store.js");
const { criticRoot } = await import("./visual-critic.js");
const { STYLE_CAP } = await import("./house-style.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const A = workspaces.create({ slug: `st-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a") } as any);
const B = workspaces.create({ slug: `st-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b") } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token };
const asB = { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get("content-type") ?? "";
  const out: any = type.includes("json") ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer());
  return { status: r.status, json: out, type };
}

test("mc style: its own workspace and the operator read it; another workspace and nobody do not", async () => {
  const mine = await call("GET", `/workspaces/${A.id}/style?kind=report`, asA);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.kind, "report");
  assert.match(mine.json.text, /The bar every dashboard, report and page is checked against/);
  assert.match(mine.json.text, /## A report/);
  assert.equal(mine.json.guide.slug, "house-style", "nothing of its own: the default page was written");
  assert.equal((await call("GET", `/workspaces/${A.id}/style`, admin)).status, 200);
  assert.equal((await call("GET", `/workspaces/${A.id}/style`, asB)).status, 404);
  assert.equal((await call("GET", `/workspaces/${A.id}/style/sources`, asB)).status, 404);
  assert.equal((await call("GET", `/workspaces/${A.id}/style/notes`, asB)).status, 404);
  assert.equal((await call("GET", `/workspaces/${A.id}/style`, json)).status, 401);
});

test("notes: the origin is the caller's, never the body's; another workspace cannot write them", async () => {
  const relayed = await call("POST", `/workspaces/${A.id}/style/notes`, asA, { text: "No pie charts in client reports", origin: "operator" });
  assert.equal(relayed.status, 201);
  assert.equal(relayed.json.note.origin, "agent", "a terminal relaying his words is an agent");
  const his = await call("POST", `/workspaces/${A.id}/style/notes`, admin, { text: "KPI row first, always" });
  assert.equal(his.json.note.origin, "operator");
  assert.equal((await call("POST", `/workspaces/${A.id}/style/notes`, asB, { text: "Globex wants magenta everywhere" })).status, 404);
  const list = await call("GET", `/workspaces/${A.id}/style/notes`, asA);
  assert.deepEqual(list.json.map((n: any) => n.text), ["No pie charts in client reports", "KPI row first, always"]);
  assert.deepEqual((await call("GET", `/workspaces/${B.id}/style/notes`, asB)).json, []);
});

test("the page: one page or refused; another workspace cannot replace it or start its rewrite", async () => {
  assert.equal((await call("PUT", `/workspaces/${A.id}/style/guide`, asA, { body: "x".repeat(STYLE_CAP + 1) })).status, 409);
  assert.equal((await call("PUT", `/workspaces/${A.id}/style/guide`, asB, { body: "# Globex rules" })).status, 404);
  const ok = await call("PUT", `/workspaces/${A.id}/style/guide`, asA, { body: "# House style\n- teal accents" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.body, "# House style\n- teal accents");
  assert.equal((await call("POST", `/workspaces/${A.id}/style/learn`, asB)).status, 404);
  // Nothing to learn from yet: refused before anything is dispatched.
  const C = workspaces.create({ slug: `st-c-${Date.now()}`, name: "Empty", config_dir: path.join(tmp, "cfg-c") } as any);
  const asC = { ...json, "x-mc-workspace-token": workspaces.get(C.id)!.token };
  const none = await call("POST", `/workspaces/${C.id}/style/learn`, asC);
  assert.equal(none.status, 409);
  assert.match(none.json.error, /nothing to learn from yet/);
});

test("the critic's verdict and renders: only its own terminal's, only its own workspace's files", async () => {
  const sa = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "a dashboard" } as any);
  const sb = sessions.create({ workspace_id: B.id, cwd: tmp, goal: "theirs" } as any);
  assert.deepEqual((await call("GET", `/workspaces/${A.id}/style/critique?session=${sa.id}`, asA)).json, { critique: null });
  assert.equal((await call("GET", `/workspaces/${A.id}/style/critique?session=${sb.id}`, asA)).status, 404, "a terminal of another workspace");
  assert.equal((await call("GET", `/workspaces/${B.id}/style/critique?session=${sb.id}`, asA)).status, 404);
  const pass = "abcdef12-20261113100000000";
  const dir = path.join(criticRoot(), A.id, pass);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p1-desktop-1.png"), Buffer.from("\x89PNG\r\n\x1a\nrest", "binary"));
  const img = await call("GET", `/workspaces/${A.id}/critic/${pass}/p1-desktop-1.png`, asA);
  assert.equal(img.status, 200);
  assert.equal(img.type, "image/png");
  assert.equal((await call("GET", `/workspaces/${A.id}/critic/${pass}/p1-desktop-1.png`, admin)).status, 200);
  assert.equal((await call("GET", `/workspaces/${A.id}/critic/${pass}/p1-desktop-1.png`, asB)).status, 404);
  assert.equal((await call("GET", `/workspaces/${B.id}/critic/${pass}/p1-desktop-1.png`, asB)).status, 404, "B's directory holds nothing of A's");
  assert.equal((await call("GET", `/workspaces/${A.id}/critic/${pass}/..%2F..%2Fsecret.png`, asA)).status, 404);
  assert.equal((await call("GET", `/workspaces/${A.id}/critic/..%2F${B.id}/p1-desktop-1.png`, asA)).status, 404);
});
