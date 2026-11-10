/**
 * A project's Robert is admin of ONE workspace: his derived credential acts on his own project's
 * routes and resources, reads only his slice, and is refused everywhere else. His sandbox walls off
 * every other workspace's places, Chronos's own store included.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertScopeOf, robertToken } = await import("./authz.js");
const { buildProfile } = await import("./sandbox.js");
const { sessions, workspaces } = await import("./store.js");
const { resolveNotesDir } = await import("./repo-root.js");
const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-rs-"));
const A = workspaces.create({ slug: `rs-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `rs-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const asRobertA = { "content-type": "application/json", "x-mc-admin": robertToken(A.id, "rw") };
const asReaderA = { "content-type": "application/json", "x-mc-admin": robertToken(A.id, "ro") };
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

test("a Robert token names exactly one workspace and role; it is not the admin token", () => {
  assert.deepEqual(robertScopeOf(robertToken(A.id, "rw")), { ws: A.id, role: "rw", lane: "operator" });
  assert.deepEqual(robertScopeOf(robertToken(B.id, "ro")), { ws: B.id, role: "ro", lane: "operator" });
  assert.deepEqual(robertScopeOf(robertToken(A.id, "rw", "wake")), { ws: A.id, role: "rw", lane: "wake" });
  assert.equal(robertScopeOf(CONFIG.adminToken), null);
  assert.equal(robertScopeOf("f".repeat(64)), null);
  assert.notEqual(robertToken(A.id), robertToken(B.id));
});

test("his reads are his workspace's slice", async () => {
  const ws = await call("GET", "/workspaces", asRobertA);
  assert.equal(ws.status, 200);
  assert.deepEqual(ws.json.map((w: any) => w.id), [A.id]);
  const fleet = await call("GET", "/fleet", asRobertA);
  assert.equal(fleet.status, 200);
  assert.ok(!("global" in fleet.json), "no shop-wide totals");
  assert.ok(fleet.json.workspaces.every((w: any) => w.slug === A.slug));
});

test("admin routes: his own project's yes, another's no, operator-only ones never", async () => {
  const mine = await call("PUT", `/workspaces/${A.id}/brief`, asRobertA, { body: "# Robert — brief\n\n## Next\n- [ ] ship it\n" });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  assert.equal((await call("PUT", `/workspaces/${B.id}/brief`, asRobertA, { body: "planted" })).status, 403);
  assert.equal((await call("GET", "/board", asRobertA)).status, 403, "the board spans every workspace");
  assert.equal((await call("GET", "/briefs", asRobertA)).status, 403, "every client's brief");
  assert.equal((await call("GET", "/agents/robert/memory", asRobertA)).status, 403);
  assert.equal((await call("POST", "/reviews/x/merge", asRobertA, {})).status, 403, "merging is the operator's");
  assert.equal((await call("POST", "/workspaces", asRobertA, { slug: "x", name: "x" })).status, 403);
});

test("he types into his own project's terminals, never another's", async () => {
  const b = sessions.create({ workspace_id: B.id, cwd: tmp, goal: "b work" } as any);
  const r = await call("POST", `/sessions/${b.id}/input`, asRobertA, { text: "hi" });
  assert.equal(r.status, 404);
});

test("Telegram's Robert reads with his credential and cannot write with it", async () => {
  assert.equal((await call("GET", "/workspaces", asReaderA)).status, 200);
  const w = await call("PUT", `/workspaces/${A.id}/brief`, asReaderA, { body: "x" });
  assert.equal(w.status, 403);
  assert.match(w.json.error, /read-only Robert/);
});

test("his sandbox: other workspaces' repos, notes, tickets and transcripts denied; Chronos's store denied to every agent", () => {
  const deny = workspaces.isolationDenyDirs(A.id);
  assert.ok(deny.includes(path.join(tmp, "b")), "B's landing dir");
  assert.ok(deny.includes(path.join(resolveNotesDir(), B.slug)), "B's notes mirror");
  assert.ok(deny.some((d) => d.endsWith(path.join("tickets", B.slug))), "B's tickets");
  assert.ok(deny.includes(path.join(tmp, "cfg-b", "projects")), "B's account transcripts");
  assert.ok(!deny.includes(path.join(tmp, "cfg-a", "projects")), "never his own");
  assert.ok(CONFIG.sandbox.secrets.some((s: string) => s.endsWith("chronos.db")), "the daemon's DB holds every client");
  assert.ok(CONFIG.sandbox.secrets.some((s: string) => s.endsWith(".secrets")));
});

test("a foreign place nested inside his own dir stays denied after the re-grant", () => {
  const own = path.join(tmp, "own");
  const foreign = path.join(own, "notes", "initech");
  const prof = buildProfile("guard", own, [], path.join(tmp, "cfg-a"), [foreign], false) as string;
  const lines = prof.split("\n");
  const allowAt = lines.findIndex((l) => l.startsWith("(allow file-read*") && l.includes(`"${own}"`));
  const reDenyAt = lines.map((l, i) => (l.startsWith("(deny file-read*") && l.includes(`"${foreign}"`) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(allowAt > -1 && reDenyAt > allowAt, "re-denied after the own re-grant (SBPL: last match wins)");
});

test("files pasted into a turn are handed to that project's Robert in his own dir", async () => {
  const { handFilesTo, robertHome } = await import("./telegram/agent.js");
  const src = path.join(tmp, "shot.png");
  fs.writeFileSync(src, "png");
  const [f] = handFilesTo(A.id, [{ path: src, text_path: null }]);
  assert.ok(f.path.startsWith(path.join(robertHome(A.id), "attachments")));
  assert.equal(fs.readFileSync(f.path, "utf8"), "png");
  assert.equal(handFilesTo(null, [{ path: src }])[0].path, src, "the fleet-wide Robert keeps the original");
});

test("the drafts agents leave are the operator's alone: no Robert lists them, a workspace token gets nothing", async () => {
  const { recordDraft } = await import("./draft-notify.js");
  const { ROBERT_ADMIN_ROUTES } = await import("./robert-scope.js");
  // Every workspace's outgoing words in one list (the phone's stopgap read): never on a Robert's routes.
  assert.ok(!ROBERT_ADMIN_ROUTES.has("GET /drafts"));
  recordDraft({ session_id: null, workspace_id: A.id, where: "a work", label: "draft", kind: "slack", to: null, channel: "#general", subject: null, text: "Prices hold until March." });
  recordDraft({ session_id: null, workspace_id: B.id, where: "b work", label: "draft", kind: "email", to: "ana@example.com", channel: null, subject: "Numbers", text: "The numbers are attached." });
  const none = (r: { status: number; json: any }, who: string) => {
    assert.ok(r.status === 401 || r.status === 403, `${who}: ${r.status}`);
    assert.equal(JSON.stringify(r.json ?? {}).includes("Prices hold"), false, `${who} read no draft`);
    assert.equal(r.json?.drafts, undefined, `${who} got no list`);
  };
  none(await call("GET", "/drafts", asRobertA), "his project's Robert (rw)");
  none(await call("GET", "/drafts", asReaderA), "his Telegram Robert (ro)");
  none(await call("GET", "/drafts", { "content-type": "application/json", "x-mc-workspace-token": workspaces.get(A.id)!.token }), "the workspace's own token");
  none(await call("GET", "/drafts", { "content-type": "application/json" }), "no token");
  const op = await call("GET", "/drafts", { "content-type": "application/json", "x-mc-admin": CONFIG.adminToken });
  assert.equal(op.status, 200, "the operator's phone reads them");
  assert.ok(op.json.drafts.some((d: any) => d.text === "Prices hold until March."));
});
