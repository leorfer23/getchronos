/**
 * Artifacts: the frame's security envelope, versions on disk, a page that asks, and the workspace wall.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifacts, asks, db, sessions, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { answerAsk } from "./asks.js";
import { callerScope } from "./authz.js";
import {
  FRAME_CSP,
  artifactFile,
  artifactMarker,
  artifactUrl,
  artifactView,
  deskBase,
  frameContext,
  frameHtml,
  publishArtifact,
  readVersion,
  sendArtifact,
  submitArtifact,
  updateArtifact,
  waitArtifactEvents,
} from "./artifacts.js";
import * as routes from "./artifact-routes.js";
import { sessionArtifacts } from "./session-artifacts.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-artifacts-"));
process.env.CHRONOS_ARTIFACTS = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const fakeReq = (params: Record<string, string>, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): any =>
  ({ params, query: {}, body: {}, get: (h: string) => headers[h.toLowerCase()], ...extra });
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined, headers: {} };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}
const ADMIN = () => ({ "x-mc-admin": CONFIG.adminToken });
const TOK = (wsId: string) => ({ "x-mc-workspace-token": workspaces.get(wsId)!.token });

let ws: { id: string };
let other: { id: string };
let term: { id: string };

beforeEach(() => {
  db.exec("DELETE FROM artifact_events; DELETE FROM artifacts; DELETE FROM asks; DELETE FROM sessions; DELETE FROM workspaces;");
  ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  other = workspaces.create({ slug: "beta", name: "Beta", config_dir: "/tmp/beta" });
  term = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
});

const PAGE = "<!doctype html><html><head><title>Pick</title></head><body><button data-chronos-submit='\"A\"'>A</button></body></html>";

// ── the frame ──────────────────────────────────────────────────────────────────────────────────

test("frameHtml puts the CSP before anything the page wrote — even a script above its own <head>", () => {
  const evil = "<!DOCTYPE html><script>fetch('http://localhost:7777/api/sessions')</script><head></head><body>x</body>";
  const a = { id: "a1", title: "t", version: 1, status: "open", question: null, options: [], answer: null, workspace: null, by: null, state: null };
  const out = frameHtml(evil, a);
  const csp = out.indexOf("Content-Security-Policy");
  const pageScript = out.indexOf("fetch(");
  assert.ok(csp > 0 && csp < pageScript, "the CSP must precede the page's first script");
  assert.equal((out.match(/<!doctype/gi) || []).length, 1, "the page's own doctype is dropped, ours stays");
  assert.match(FRAME_CSP, /connect-src 'none'/);
  assert.match(FRAME_CSP, /form-action 'none'/);
  assert.match(out, /window\.chronos = chronos/, "the SDK is inlined");
});

test("frame context cannot close the <script> it rides in", () => {
  const ctx = { id: "a1", title: "</script><script>alert(1)</script>", version: 1, status: "open", question: null, options: [], answer: null, workspace: null, by: null, state: null };
  const out = frameHtml("<p>hi</p>", ctx);
  assert.ok(!out.includes("</script><script>alert(1)"), "a title must not end the context script");
  assert.match(out, /\\u003c\/script>/);
});

test("Origin: null never gets the tokenless loopback pass", () => {
  assert.deepEqual(callerScope(fakeReq({}, {})), { ws: null }, "a bare local call is still the operator");
  assert.equal(callerScope(fakeReq({}, { origin: "null" })), null);
  assert.deepEqual(callerScope(fakeReq({}, { origin: "null", ...ADMIN() })), { ws: null }, "the admin token still works");
});

// ── pages and versions ─────────────────────────────────────────────────────────────────────────

test("publish writes v1 under the workspace; a new version keeps the old one", async () => {
  const { artifact: a, ask_id } = await publishArtifact({ title: "Report", html: "<p>one</p>", workspace_id: ws.id, session_id: term.id });
  assert.equal(ask_id, null);
  assert.equal(artifactFile(a, 1), path.join(ROOT, ws.id, a.id, "v1.html"));
  assert.equal(readVersion(a), "<p>one</p>");
  const b = updateArtifact(a, "<p>two</p>");
  assert.equal(b.version, 2);
  assert.equal(readVersion(b), "<p>two</p>");
  assert.equal(readVersion(b, 1), "<p>one</p>");
  assert.throws(() => readVersion(b, 3), /no version 3/);
});

test("a page with no question: submit records the answer and marks it answered", async () => {
  const { artifact: a } = await publishArtifact({ title: "R", html: "<p/>", workspace_id: ws.id });
  sendArtifact(a, { liked: true }, "operator");
  const out = await submitArtifact(artifacts.get(a.id)!, { pick: "B" }, "operator");
  assert.equal(out.artifact.status, "answered");
  const evs = artifacts.events(a.id);
  assert.deepEqual(evs.map((e) => e.kind), ["send", "submit"]);
  assert.deepEqual(JSON.parse(evs[1].data), { pick: "B" });
  assert.deepEqual(frameContext(artifacts.get(a.id)!).answer, { pick: "B" });
});

// ── a page that asks ───────────────────────────────────────────────────────────────────────────

test("a page that asks is an ask underneath: its submit answers it, once", async () => {
  const { artifact: a, ask_id } = await publishArtifact({
    title: "Pick one", html: PAGE, workspace_id: ws.id, session_id: term.id, created_by: "acme terminal",
    question: "which layout?", options: ["A", "B"],
  });
  assert.ok(ask_id);
  const ask = asks.get(ask_id!)!;
  assert.equal(ask.route, "operator");
  assert.equal(ask.session_id, term.id);
  assert.deepEqual(frameContext(a).options, ["A", "B"]);

  await submitArtifact(artifacts.get(a.id)!, { layout: "B", note: "less scroll" }, "operator");
  const answered = asks.get(ask_id!)!;
  assert.equal(answered.status, "answered");
  assert.deepEqual(JSON.parse(answered.answer!), { layout: "B", note: "less scroll" });
  assert.equal(artifacts.events(a.id).filter((e) => e.kind === "submit").length, 1, "the ask.answered echo must not add a second submit");

  await assert.rejects(() => submitArtifact(artifacts.get(a.id)!, "A", "operator"), /already answered/);
});

test("a string answer reaches the agent as itself, not JSON-quoted", async () => {
  const { ask_id, artifact: a } = await publishArtifact({ title: "q", html: PAGE, workspace_id: ws.id, session_id: term.id, question: "A or B?" });
  await submitArtifact(a, "A", "operator");
  assert.equal(asks.get(ask_id!)!.answer, "A");
});

test("answered some other way (Telegram, mc answer): the page is answered too", async () => {
  const { artifact: a, ask_id } = await publishArtifact({ title: "q", html: PAGE, workspace_id: ws.id, session_id: term.id, question: "A or B?" });
  const r = await answerAsk(ask_id!, "B", "telegram");
  assert.ok(r.ok);
  assert.equal(artifacts.get(a.id)!.status, "answered");
  const sub = artifacts.events(a.id).find((e) => e.kind === "submit")!;
  assert.equal(JSON.parse(sub.data), "B");
  assert.equal(sub.by, "telegram");
});

test("a question needs someone to hand the answer to", async () => {
  await assert.rejects(() => publishArtifact({ title: "q", html: PAGE, workspace_id: ws.id, question: "A or B?" }), /asking terminal or run/);
});

test("waitArtifactEvents wakes on the next event", async () => {
  const { artifact: a } = await publishArtifact({ title: "R", html: "<p/>", workspace_id: ws.id });
  const waiting = waitArtifactEvents(a.id, 0, 5000);
  setTimeout(() => sendArtifact(a, "hi", "operator"), 20);
  const evs = await waiting;
  assert.equal(evs.length, 1);
  assert.equal(JSON.parse(evs[0].data), "hi");
});

// ── the workspace wall ─────────────────────────────────────────────────────────────────────────

test("another workspace's token gets 404 on every :id door", async () => {
  const { artifact: a } = await publishArtifact({ title: "R", html: "<p/>", workspace_id: ws.id });
  for (const h of [routes.getRoute, routes.htmlRoute, routes.frameRoute]) {
    const res = fakeRes();
    h(fakeReq({ id: a.id }, TOK(other.id)), res);
    assert.equal(res.statusCode, 404, h.name);
  }
  const res = fakeRes();
  await routes.eventRoute(fakeReq({ id: a.id }, TOK(other.id), { body: { kind: "send", data: 1 } }), res);
  assert.equal(res.statusCode, 404);
});

test("list with a workspace token shows only that workspace", async () => {
  await publishArtifact({ title: "mine", html: "<p/>", workspace_id: ws.id });
  await publishArtifact({ title: "theirs", html: "<p/>", workspace_id: other.id });
  const res = fakeRes();
  routes.listRoute(fakeReq({}, TOK(ws.id)), res);
  assert.deepEqual(res.body.map((r: { title: string }) => r.title), ["mine"]);
});

test("an agent may send to a page but never answer one that asks the operator", async () => {
  const { artifact: a } = await publishArtifact({ title: "q", html: PAGE, workspace_id: ws.id, session_id: term.id, question: "A or B?" });
  const sent = fakeRes();
  await routes.eventRoute(fakeReq({ id: a.id }, TOK(ws.id), { body: { kind: "send", data: "fyi" } }), sent);
  assert.equal(sent.statusCode, 201);
  const sub = fakeRes();
  await routes.eventRoute(fakeReq({ id: a.id }, TOK(ws.id), { body: { kind: "submit", data: "A" } }), sub);
  assert.equal(sub.statusCode, 403);
  assert.equal(artifacts.get(a.id)!.status, "open");

  const op = fakeRes();
  await routes.eventRoute(fakeReq({ id: a.id }, ADMIN(), { body: { kind: "submit", data: "A", by: "operator" } }), op);
  assert.equal(op.statusCode, 201);
  assert.equal(artifacts.get(a.id)!.status, "answered");
});

test("the page's HTML is only ever returned inside JSON", async () => {
  const { artifact: a } = await publishArtifact({ title: "R", html: "<p>raw</p>", workspace_id: ws.id });
  const res = fakeRes();
  routes.frameRoute(fakeReq({ id: a.id.slice(0, 8) }, ADMIN()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.html, "string");
  assert.match(res.body.html, /<p>raw<\/p>/);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("create from a terminal is stamped with its workspace, not the one in the body", async () => {
  const res = fakeRes();
  await routes.createRoute(
    fakeReq({}, TOK(ws.id), { body: { title: "R", html: "<p/>", session_id: term.id, workspace_id: other.id } }),
    res,
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.workspace_id, ws.id);
});

// ── the link an agent prints, and where the page is pinned ─────────────────────────────────────

test("the printed link is the public Desk, never another host's loopback", () => {
  assert.equal(deskBase({ CHRONOS_DESK_URL: "https://desk.example.com/desk/" }), "https://desk.example.com");
  assert.equal(deskBase({ CHRONOS_HOST_PUBLIC_URL: "wss://desk.example.com/host" }), "https://desk.example.com");
  assert.equal(deskBase({ CHRONOS_HOST_PUBLIC_URL: " , wss://t.example.com/host" }), "https://t.example.com");
  assert.equal(deskBase({ CHRONOS_HOST_PUBLIC_URL: "not a url", CHRONOS_PORT: "7788" }), "http://localhost:7788");
  assert.equal(deskBase({}), "http://localhost:7777");
  assert.equal(artifactUrl("abc", { CHRONOS_DESK_URL: "https://d.example.com" }), "https://d.example.com/desk#artifact=abc");
});

test("every artifact the API hands back carries its link", async () => {
  const { artifact: a } = await publishArtifact({ title: "Report", html: "<p>x</p>", workspace_id: ws.id, session_id: term.id });
  assert.equal(artifactView(a).url, artifactUrl(a.id));
});

test("a new version with notify puts its card in the chat again; without, it does not", async () => {
  const { artifact: a } = await publishArtifact({ title: "Report", html: "<p>x</p>", workspace_id: ws.id, session_id: term.id });
  const cards = () => (db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE reply = ?").get(artifactMarker(a.id)) as { n: number }).n;
  const before = cards();
  updateArtifact(a, "<p>y</p>");
  assert.equal(cards(), before);
  updateArtifact(artifacts.get(a.id)!, "<p>z</p>", null, true);
  assert.equal(cards(), before + 1);
});

test("a terminal's pages are pinned beside it, and only its own", async () => {
  const mine = await publishArtifact({ title: "Mine", html: "<p>x</p>", workspace_id: ws.id, session_id: term.id });
  const elsewhere = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  await publishArtifact({ title: "Theirs", html: "<p>x</p>", workspace_id: ws.id, session_id: elsewhere.id });
  const pins = await sessionArtifacts(sessions.get(term.id)!, []);
  assert.deepEqual(pins.pages.map((p) => [p.id, p.title, p.status, p.asks]), [[mine.artifact.id, "Mine", "open", false]]);
});
