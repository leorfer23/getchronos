/**
 * The file shelf (src/shared-files.ts + src/file-routes.ts) over real HTTP, with the same routes and
 * validators api.ts mounts — and the real `scripts/mc` driving them, since `mc file put` on one
 * computer and `mc file get` on another IS the feature.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-files-")));
// Before anything imports shared-files.ts: the shelf lands in the tmp dir, not the operator's ~/.mc.
process.env.CHRONOS_FILES = path.join(tmp, "shelf");
process.env.CHRONOS_FILES_MAX_MB = "8";
process.env.CHRONOS_FILES_QUOTA_MB = "12";

const { workspaces } = await import("./store.js");
const { CONFIG } = await import("./config.js");
const { validate, NewSharedFileSchema, SharedFileChunkSchema, SharedFileCompleteSchema } = await import("./validation.js");
const shelf = await import("./shared-files.js");
const routes = await import("./file-routes.js");

const mk = (slug: string) => workspaces.create({ slug, name: slug, config_dir: path.join(tmp, ".claude-" + slug), sandbox_mode: "off" } as any);
const acme = mk("files-acme");
const globex = mk("files-globex");

const app = express();
app.use(express.json({ limit: "16mb" }));
const api = express.Router();
api.post("/files", validate(NewSharedFileSchema), routes.createRoute);
api.get("/files", routes.listRoute);
api.get("/files/:id", routes.getRoute);
api.post("/files/:id/chunk", validate(SharedFileChunkSchema), routes.chunkInRoute);
api.post("/files/:id/complete", validate(SharedFileCompleteSchema), routes.completeRoute);
api.get("/files/:id/chunk", routes.chunkOutRoute);
api.delete("/files/:id", routes.removeRoute);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const as = (ws: { token: string }) => ({ "x-mc-workspace-token": ws.token });
const call = async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
};
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Put `bytes` on `ws`'s shelf in `step`-sized chunks, the way `mc file put` does. */
async function put(ws: { token: string }, name: string, bytes: Buffer, step = 700) {
  const f = await call("POST", "/files", as(ws), { name, size: bytes.length });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  for (let off = 0; off < bytes.length; off += step) {
    const c = await call("POST", `/files/${f.body.id}/chunk`, as(ws), { offset: off, data_base64: bytes.subarray(off, off + step).toString("base64") });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  const done = await call("POST", `/files/${f.body.id}/complete`, as(ws), { sha256: sha(bytes) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body;
}

test("a file goes up in chunks and comes back byte for byte", async () => {
  const bytes = crypto.randomBytes(2500);
  const f = await put(acme, "../../etc/demo video.mp4", bytes);
  assert.equal(f.status, "ready");
  assert.equal(f.name, "demo video.mp4", "the name cannot walk out of a directory");
  assert.equal(f.sha256, sha(bytes));
  assert.equal(f.from_host, "local");
  assert.ok(f.expires_at > Date.now());

  const parts: Buffer[] = [];
  for (let off = 0, eof = false; !eof; ) {
    const c = await call("GET", `/files/${f.id}/chunk?offset=${off}&length=1000`, as(acme));
    assert.equal(c.status, 200);
    parts.push(Buffer.from(c.body.data_base64, "base64"));
    off += parts.at(-1)!.length;
    eof = c.body.eof;
  }
  assert.ok(Buffer.concat(parts).equals(bytes));
  assert.equal((await call("GET", "/files/" + f.id.slice(0, 8), as(acme))).body.id, f.id, "by id prefix");
  assert.equal((await call("GET", "/files/" + encodeURIComponent("demo video.mp4"), as(acme))).body.id, f.id, "by name");
});

test("the workspace wall: another client's token sees nothing and can touch nothing", async () => {
  const f = await put(acme, "acme-only.txt", Buffer.from("acme's secret plan"));
  assert.deepEqual((await call("GET", "/files", as(globex))).body, []);
  assert.deepEqual((await call("GET", "/files?workspace=" + acme.id, as(globex))).body, [], "naming the other workspace is not a way in");
  for (const [method, url, body] of [
    ["GET", `/files/${f.id}`],
    ["GET", `/files/${encodeURIComponent(f.name)}`],
    ["GET", `/files/${f.id}/chunk?offset=0`],
    ["POST", `/files/${f.id}/chunk`, { offset: 0, data_base64: "eA==" }],
    ["POST", `/files/${f.id}/complete`, {}],
    ["DELETE", `/files/${f.id}`],
  ] as Array<[string, string, unknown?]>) {
    const r = await call(method, url, as(globex), body);
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.deepEqual(r.body, { error: "not found" });
  }
  assert.equal((await call("POST", "/files", as(globex), { name: "x", size: 1, workspace_id: acme.id })).status, 404, "nor put INTO it");
  assert.equal((await call("GET", "/files", { "x-mc-workspace-token": "nope" })).status, 401);
  assert.equal((await call("GET", `/files/${f.id}`, as(acme))).status, 200, "still there for its owner");
});

test("the operator's own files (no workspace) are invisible to every workspace token", async () => {
  const admin = { "x-mc-admin": CONFIG.adminToken };
  const f = await call("POST", "/files", admin, { name: "mine.bin", size: 3 });
  assert.equal(f.body.workspace_id, null);
  assert.equal((await call("GET", `/files/${f.body.id}`, as(acme))).status, 404);
  assert.ok((await call("GET", "/files", admin)).body.some((x: any) => x.id === f.body.id), "the admin scope lists every shelf");
  assert.equal((await call("POST", "/files", admin, { name: "x", size: 1, workspace_id: "no-such-ws" })).status, 400);
  assert.equal((await call("DELETE", `/files/${f.body.id}`, admin)).status, 200);
});

test("an upload is append-only: a resent chunk is a no-op, a gap or an overrun is refused", async () => {
  const f = (await call("POST", "/files", as(acme), { name: "a.bin", size: 6 })).body;
  const chunk = (offset: number, s: string) => call("POST", `/files/${f.id}/chunk`, as(acme), { offset, data_base64: Buffer.from(s).toString("base64") });
  assert.equal((await chunk(3, "def")).status, 409, "a gap");
  assert.equal((await chunk(0, "abc")).body.received, 3);
  assert.equal((await chunk(0, "abc")).body.received, 3, "the same chunk again (its answer was lost)");
  assert.equal((await call("POST", `/files/${f.id}/complete`, as(acme), {})).status, 409, "incomplete");
  assert.equal((await call("GET", `/files/${f.id}/chunk?offset=0`, as(acme))).status, 409, "not readable while uploading");
  assert.equal((await chunk(3, "defg")).status, 400, "more than was declared");
  assert.equal((await chunk(3, "def")).body.received, 6);
  const bad = await call("POST", `/files/${f.id}/complete`, as(acme), { sha256: "0".repeat(64) });
  assert.equal(bad.status, 422);
  assert.equal(shelf.getFile(f.id), null, "bytes that fail their checksum do not stay on the shelf");
});

test("limits: one file's size, a workspace's quota, and a ref that is not an id never reaches the disk", async () => {
  assert.equal((await call("POST", "/files", as(globex), { name: "big", size: 9 * 1024 * 1024 })).status, 413);
  const held = await call("POST", "/files", as(globex), { name: "a", size: 7 * 1024 * 1024 });
  assert.equal(held.status, 201);
  const over = await call("POST", "/files", as(globex), { name: "b", size: 6 * 1024 * 1024 });
  assert.equal(over.status, 413);
  assert.match(over.body.error, /shelf is full/);
  assert.equal((await call("POST", "/files", as(acme), { name: "c", size: 6 * 1024 * 1024 })).status, 201, "the quota is per workspace");
  assert.equal((await call("POST", "/files", as(acme), { name: "empty", size: 0 })).status, 400);
  assert.equal(shelf.getFile("../" + held.body.id), null);
  shelf.removeFile("..");
  assert.ok(fs.existsSync(shelf.filesRoot()), "removeFile ignores anything that is not an id");
});

test("a file leaves when its time is up, and so does an upload nobody finished", async () => {
  const done = await put(acme, "old.txt", Buffer.from("x"));
  const half = (await call("POST", "/files", as(acme), { name: "half.txt", size: 10 })).body;
  assert.equal(shelf.sweepFiles(Date.now() + 3_600_000), 0, "an hour on, both are still there");
  shelf.sweepFiles(Date.now() + 2 * 86_400_000);
  assert.equal(shelf.getFile(half.id), null, "an abandoned upload goes after a day");
  assert.ok(shelf.getFile(done.id));
  shelf.sweepFiles(done.expires_at + 1);
  assert.equal(shelf.getFile(done.id), null);
});

test("the shelf is sealed from every agent's sandbox — the API is the only door", () => {
  assert.ok(CONFIG.sandbox.sealed.includes(shelf.filesRoot()));
});

// The real CLI, async: a spawnSync would block the event loop the test server answers on.
const mc = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [path.resolve("scripts/mc"), ...args], { cwd, env: { ...process.env, MC_API: base, MC_SESSION: "", MC_LEAD_TOKEN: "", ...env } }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as any).code === "number" ? (e as any).code : 1) : 0, out, err }));
  });

test("mc file put on one computer, mc file get on another: several chunks, same bytes", async () => {
  const m5 = path.join(tmp, "m5"), m3 = path.join(tmp, "m3");
  fs.mkdirSync(m5); fs.mkdirSync(m3);
  const bytes = crypto.randomBytes(2 * 1024 * 1024 + 4321);
  fs.writeFileSync(path.join(m5, "clip.mp4"), bytes);
  const env = { MC_WORKSPACE: acme.id, MC_WORKSPACE_TOKEN: acme.token, MC_AGENT_NAME: "worker-1" };

  const up = await mc(m5, env, "file", "put", "clip.mp4", "--note", "the demo");
  assert.equal(up.code, 0, up.err);
  const id8 = /on the shelf as ([0-9a-f]{8})/.exec(up.out)?.[1];
  assert.ok(id8, up.out);

  const ls = await mc(m3, env, "file", "ls");
  assert.match(ls.out, new RegExp(`${id8}\\s+2\\.0 MB\\s+clip\\.mp4\\s+— from local \\(worker-1\\), 7d left\\s+· the demo`));
  assert.match((await mc(m3, { MC_WORKSPACE: globex.id, MC_WORKSPACE_TOKEN: globex.token }, "files")).out, /shelf is empty/);

  const down = await mc(m3, env, "file", "get", id8!);
  assert.equal(down.code, 0, down.err);
  assert.equal(down.out.trim(), path.join(m3, "clip.mp4"));
  assert.ok(fs.readFileSync(path.join(m3, "clip.mp4")).equals(bytes));
  assert.ok(!fs.existsSync(path.join(m3, "clip.mp4.part")));

  const again = await mc(m3, env, "file", "get", "clip.mp4");
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists \(--force/);
  assert.equal((await mc(m3, env, "file", "get", "clip.mp4", "renamed.mp4")).code, 0, "by name, to a path");
  assert.ok(fs.readFileSync(path.join(m3, "renamed.mp4")).equals(bytes));

  const other = await mc(m3, { MC_WORKSPACE: globex.id, MC_WORKSPACE_TOKEN: globex.token }, "file", "get", id8!, "stolen.mp4");
  assert.equal(other.code, 1);
  assert.match(other.err, /not found/);
  assert.ok(!fs.existsSync(path.join(m3, "stolen.mp4")));

  assert.match((await mc(m3, env, "file", "rm", id8!)).out, /removed clip\.mp4/);
  assert.match((await mc(m3, env, "file", "get", id8!, "gone.mp4")).err, /not found/);
});
