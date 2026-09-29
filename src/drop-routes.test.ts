/**
 * The drop doors (src/drop-routes.ts) over real HTTP: an Express app built with the SAME body
 * parsers startServer mounts (mountBodyParsers) and the same two routes, so what a dropped .json
 * goes through here is what it goes through on the Desk. The remote host is a real RemoteHost on a
 * stub link (as in host-failover.test.ts) — the brain side of the forward is exercised, nothing
 * leaves the process.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-drop-routes-")));
// Before anything imports drops.ts: local drops land in the tmp dir, not the operator's ~/.mc.
process.env.CHRONOS_DROPS = path.join(tmp, "drops");

const { sessions, hosts } = await import("./store.js");
const { CONFIG } = await import("./config.js");
const { registerHost } = await import("./hosts/index.js");
const { RemoteHost } = await import("./hosts/remote.js");
const { MAX_DROP_BYTES } = await import("./drops.js");
const routes = await import("./drop-routes.js");

// The M2, online, answering `drop` the way hostd does: the path it writes on ITS disk.
const forwarded: any[] = [];
const port = {
  isOnline: () => true,
  sendControl: () => true,
  request: async (_h: string, op: string, args: any) => {
    assert.equal(op, "drop");
    forwarded.push(args);
    const size = Buffer.from(args.b64, "base64").length;
    return { path: `/Users/leorfer/.mc/drops/${args.session_id}/${args.filename}`, name: args.filename, size, mime: args.mime || "application/octet-stream" };
  },
};
const M2 = "h_drop_m2";
const m2 = new RemoteHost(M2, port);
m2.setOnline({ name: "m2" } as any);
registerHost(m2);
hosts.create({ id: M2, name: "m2", status: "online", token_hash: "x".repeat(64) });

const local = sessions.create({ cwd: tmp, title: "here" });
const remote = sessions.create({ cwd: "/Users/leorfer", title: "there", host_id: M2 });

const app = express();
routes.mountBodyParsers(app);
const api = express.Router();
api.post("/sessions/:id/drop", express.raw({ type: () => true, limit: MAX_DROP_BYTES }), routes.dropRoute);
api.post("/sessions/:id/drop-path", routes.dropPathRoute);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/`;
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ADMIN = { "x-mc-admin": CONFIG.adminToken };
const post = async (url: string, body: BodyInit, headers: Record<string, string>) => {
  const r = await fetch(base + url, { method: "POST", body, headers });
  return { status: r.status, body: (await r.json()) as any };
};

const JSON_FILE = '{"project_info":{"project_id":"demo"}}';

test("a dropped .json keeps its bytes — express.json does not get to it first (local)", async () => {
  const r = await post(`${local.id}/drop?filename=google-services.json`, JSON_FILE, { ...ADMIN, "content-type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, "google-services.json");
  assert.equal(r.body.mime, "application/json");
  assert.equal(fs.readFileSync(r.body.path, "utf8"), JSON_FILE);
  assert.ok(r.body.path.startsWith(path.join(tmp, "drops") + path.sep));
});

test("a dropped .json reaches a terminal on another computer with its bytes and type", async () => {
  forwarded.length = 0;
  const r = await post(`${remote.id}/drop?filename=google-services.json`, JSON_FILE, { ...ADMIN, "content-type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.path, `/Users/leorfer/.mc/drops/${remote.id}/google-services.json`);
  assert.equal(forwarded.length, 1);
  assert.equal(Buffer.from(forwarded[0].b64, "base64").toString(), JSON_FILE);
  assert.equal(forwarded[0].mime, "application/json");
});

test("every other route still gets parsed JSON", async () => {
  // drop-path takes a JSON body: the pre-parser is for /drop alone, and must not swallow its sibling.
  const f = path.join(tmp, "notes.txt");
  fs.writeFileSync(f, "hello");
  const r = await post(`${local.id}/drop-path`, JSON.stringify({ paths: [f] }), { ...ADMIN, "content-type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test("drop and drop-path are the operator's alone", async () => {
  const f = path.join(tmp, "secret.txt");
  fs.writeFileSync(f, "s");
  for (const headers of [{}, { "x-mc-admin": "nope" }] as Record<string, string>[]) {
    const a = await post(`${remote.id}/drop-path`, JSON.stringify({ paths: [f] }), { ...headers, "content-type": "application/json" });
    assert.equal(a.status, 403);
    const b = await post(`${remote.id}/drop?filename=x`, "x", { ...headers, "content-type": "application/octet-stream" });
    assert.equal(b.status, 403);
  }
});

test("drop-path copies a file on this Mac into a local terminal's drop dir", async () => {
  const f = path.join(tmp, "Screen Shot.png");
  fs.writeFileSync(f, "png-bytes");
  const r = await post(`${local.id}/drop-path`, JSON.stringify({ paths: [f] }), { ...ADMIN, "content-type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.paths.length, 1);
  assert.notEqual(r.body.paths[0], f);
  assert.equal(path.basename(r.body.paths[0]), "Screen Shot.png");
  assert.equal(fs.readFileSync(r.body.paths[0], "utf8"), "png-bytes");
});

test("drop-path forwards a brain file to a terminal on another computer — the path back is over there", async () => {
  forwarded.length = 0;
  const f = path.join(tmp, "google-services.json");
  fs.writeFileSync(f, JSON_FILE);
  const r = await post(`${remote.id}/drop-path`, JSON.stringify({ paths: [f] }), { ...ADMIN, "content-type": "application/json" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.paths, [`/Users/leorfer/.mc/drops/${remote.id}/google-services.json`]);
  assert.equal(Buffer.from(forwarded[0].b64, "base64").toString(), JSON_FILE);
  assert.equal(forwarded[0].session_id, remote.id);
});

test("drop-path refuses folders, relative and missing paths — before a single byte moves", async () => {
  forwarded.length = 0;
  const ok = path.join(tmp, "ok.txt");
  fs.writeFileSync(ok, "ok");
  const dir = path.join(tmp, "a-folder");
  fs.mkdirSync(dir, { recursive: true });
  const send = (paths: unknown) => post(`${remote.id}/drop-path`, JSON.stringify({ paths }), { ...ADMIN, "content-type": "application/json" });
  const d = await send([ok, dir]);
  assert.equal(d.status, 400);
  assert.match(d.body.error, /not a regular file/);
  assert.equal(forwarded.length, 0, "the good file in the same drop was not sent either");
  assert.equal((await send(["relative/x.txt"])).status, 400);
  assert.equal((await send([path.join(tmp, "nope.txt")])).status, 404);
  assert.equal((await send([])).status, 400);
  assert.equal((await send("x")).status, 400);
  assert.equal((await send(Array(routes.DROP_PATHS_MAX + 1).fill(ok))).status, 400);
  assert.equal((await post(`nope/drop-path`, JSON.stringify({ paths: [ok] }), { ...ADMIN, "content-type": "application/json" })).status, 404);
});

test("drop-path holds each terminal to its own cap: 25MB here, 16MB over the link", async () => {
  // Sparse files: the size is what stat reports, no 25MB is ever written.
  const big = path.join(tmp, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, MAX_DROP_BYTES + 1);
  const mid = path.join(tmp, "mid.bin");
  fs.writeFileSync(mid, "");
  fs.truncateSync(mid, routes.REMOTE_DROP_MAX + 1);
  const send = (id: string, p: string) => post(`${id}/drop-path`, JSON.stringify({ paths: [p] }), { ...ADMIN, "content-type": "application/json" });
  assert.equal((await send(local.id, big)).status, 413);
  forwarded.length = 0;
  const r = await send(remote.id, mid);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /max 16MB/);
  assert.equal(forwarded.length, 0);
  assert.equal(routes.dropCap(local), MAX_DROP_BYTES);
  assert.equal(routes.dropCap(remote), routes.REMOTE_DROP_MAX);
});

test("a terminal whose computer is offline says so instead of writing anything here", async () => {
  const gone = sessions.create({ cwd: "/x", title: "gone", host_id: "h_not_registered" });
  const r = await post(`${gone.id}/drop?filename=a.txt`, "a", { ...ADMIN, "content-type": "text/plain" });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /offline/);
});
