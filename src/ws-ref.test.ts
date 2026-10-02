/**
 * `wsRefs` (src/ws-ref.ts) over real HTTP: the same middleware startServer mounts, in front of stub
 * routes that run the REAL `checkScope`, so what is proven here is the order that matters — a slug is
 * resolved to its id first, and the workspace wall then runs on the id exactly as it did before.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { workspaces } from "./store.js";
import { checkScope } from "./authz.js";
import { wsRefs, wsByIdOrSlug } from "./ws-ref.js";

const mk = (slug: string) => workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });
const tag = randomUUID().slice(0, 6);
const gfm = mk(`gfm-${tag}`);
const galley = mk(`galley-${tag}`);

const app = express();
app.use(express.json());
const api = express.Router();
api.use(wsRefs);
api.get("/workspaces/:id/jots", (req, res) => {
  if (!checkScope(req, res, req.params.id)) return;
  res.json({ id: req.params.id });
});
api.get("/notes", (req, res) => res.json({ workspace: req.query.workspace ?? null }));
api.post("/notes", (req, res) => res.json({ workspace_id: req.body?.workspace_id ?? null }));
app.use("/api", api);
const server = http.createServer(app).listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

const get = async (p: string, token?: string) => {
  const r = await fetch(base() + p, { headers: token ? { "x-mc-workspace-token": token } : {} });
  return { status: r.status, body: await r.json() };
};
const post = async (p: string, body: unknown, token?: string) => {
  const r = await fetch(base() + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-mc-workspace-token": token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test("wsByIdOrSlug takes either, and nothing else", () => {
  assert.equal(wsByIdOrSlug(gfm.id)?.id, gfm.id);
  assert.equal(wsByIdOrSlug(gfm.slug)?.id, gfm.id);
  assert.equal(wsByIdOrSlug("nope"), undefined);
  assert.equal(wsByIdOrSlug(""), undefined);
  assert.equal(wsByIdOrSlug(undefined), undefined);
});

test("operator: a slug in the path reaches the route as the id; an id is untouched", async () => {
  assert.deepEqual(await get(`/workspaces/${gfm.slug}/jots`), { status: 200, body: { id: gfm.id } });
  assert.deepEqual(await get(`/workspaces/${gfm.id}/jots?status=open`), { status: 200, body: { id: gfm.id } });
});

test("an unknown workspace is a plain 404 that names it", async () => {
  assert.deepEqual(await get(`/workspaces/nope/jots`), { status: 404, body: { error: "unknown workspace nope" } });
});

test("a scoped caller: its own slug resolves; another workspace's slug looks exactly like a missing one", async () => {
  assert.deepEqual(await get(`/workspaces/${galley.slug}/jots`, galley.token), { status: 200, body: { id: galley.id } });
  const foreign = await get(`/workspaces/${gfm.slug}/jots`, galley.token);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, { error: `unknown workspace ${gfm.slug}` }, "never resolved, so the wall is never even reached");
  // Another workspace's id still meets the route's own wall, as before.
  assert.deepEqual(await get(`/workspaces/${gfm.id}/jots`, galley.token), { status: 404, body: { error: "not found" } });
});

test("an invalid token is left for the route to refuse", async () => {
  assert.deepEqual(await get(`/workspaces/${gfm.slug}/jots`, "bogus"), { status: 401, body: { error: "invalid workspace token" } });
});

test("?workspace= and a body's workspace_id: a slug becomes the id, never another client's for a scoped caller", async () => {
  assert.deepEqual((await get(`/notes?workspace=${gfm.slug}`)).body, { workspace: gfm.id });
  assert.deepEqual((await get(`/notes?workspace=${galley.slug}`, galley.token)).body, { workspace: galley.id });
  assert.deepEqual((await get(`/notes?workspace=${gfm.slug}`, galley.token)).body, { workspace: gfm.slug }, "left as the unknown id it is");
  assert.deepEqual((await get(`/notes?workspace=all`)).body, { workspace: "all" }, "a reserved filter value is not a slug");
  assert.deepEqual((await get(`/notes?workspace=nope`)).body, { workspace: "nope" });
  assert.deepEqual((await post(`/notes`, { workspace_id: gfm.slug })).body, { workspace_id: gfm.id });
  assert.deepEqual((await post(`/notes`, { workspace_id: gfm.slug }, galley.token)).body, { workspace_id: gfm.slug });
});
