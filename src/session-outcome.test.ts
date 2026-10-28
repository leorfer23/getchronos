/**
 * Focus's first and last card as data (Leo 2026-10-28): the finish line (`done_when`), what a
 * terminal may do once green (`ship`, operator only), and the hand-off (`mc outcome`) he approves from.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { asks, db, sessions } from "./store.js";
import { decodeDoneWhen, encodeDoneWhen, normalizeOutcome, saveShot, shipLine, shotFile, MAX_SHOT_BYTES } from "./session-outcome.js";
import { deskSeed } from "./terminal.js";
import { resolve, setProgress, statusOf } from "./term-status.js";

process.env.CHRONOS_OUTCOMES = fs.mkdtempSync(path.join(os.tmpdir(), "outcomes-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MC = path.join(import.meta.dirname, "..", "scripts", "mc");
const api = fs.readFileSync(path.join(import.meta.dirname, "api.ts"), "utf8");

beforeEach(() => {
  db.exec("DELETE FROM asks; DELETE FROM sessions; DELETE FROM workspaces;");
});

test("the finish line round-trips through the session row, clipped and capped", () => {
  const s = sessions.create({ cwd: "/tmp", goal: "ship the board" });
  assert.deepEqual(s.done_when, [], "no finish line yet reads as an empty list, never null");
  sessions.setFinish(s.id, { done_when: ["timeline gone", "  ", "x".repeat(500)] });
  const got = sessions.get(s.id)!.done_when;
  assert.equal(got.length, 2, "blank checks are dropped");
  assert.equal(got[1].length, 200, "a check is one line, not an essay");
  sessions.setFinish(s.id, { done_when: null });
  assert.deepEqual(sessions.get(s.id)!.done_when, []);
  assert.equal(encodeDoneWhen(Array.from({ length: 20 }, (_, i) => "c" + i))!.length > 0, true);
  assert.equal(decodeDoneWhen(encodeDoneWhen(Array.from({ length: 20 }, (_, i) => "c" + i))).length, 8);
  assert.deepEqual(decodeDoneWhen("not json"), []);
});

test("ship is stored at spawn and patchable; null reads as ask everywhere", () => {
  const a = sessions.create({ cwd: "/tmp", ship: "deploy" });
  assert.equal(a.ship, "deploy");
  const b = sessions.create({ cwd: "/tmp" });
  assert.equal(b.ship, null);
  sessions.setFinish(b.id, { ship: "merge" });
  assert.equal(sessions.get(b.id)!.ship, "merge");
});

test("only the operator grants ship — at spawn and on the card", () => {
  // The PATCH refuses a workspace/Lead caller BEFORE writing anything, and the spawn route drops the
  // field unless the admin token came with it: an agent cannot widen its own permission.
  assert.match(api, /if \(ship !== undefined && !admin\) return res\.status\(403\)/);
  const patchAt = api.indexOf('api.patch("/sessions/:id"');
  const gate = api.indexOf("if (ship !== undefined && !admin)", patchAt);
  const firstWrite = api.indexOf("sessionGoals.patch(", patchAt);
  assert.ok(gate > patchAt && gate < firstWrite, "the gate runs before the first write");
  assert.match(api, /if \(!tokenOk\(req\.get\("x-mc-admin"\), CONFIG\.adminToken\)\) delete body\.ship;/);
  // A change reaches the running agent as a typed line, because its first prompt predates it.
  assert.match(api, /sendInput\(s\.id, \{ text: shipLine\(ship \?\? "ask"\), enter: true \}, "operator"\)/);
  assert.match(shipLine("deploy"), /merge it and deploy/);
  assert.match(shipLine("merge"), /Do NOT deploy/);
  assert.match(shipLine("ask"), /stop and ask/);
});

test("the first prompt says what it may ship and asks it to define done before working", () => {
  const seed = deskSeed("fix the export", "pr", null, null, "merge");
  assert.match(seed, /may merge the PR once its checks pass/);
  assert.match(seed, /Do not deploy/);
  assert.match(seed, /--done-when/);
  assert.match(seed, /ask him first/);
  assert.match(deskSeed("fix the export", "pr"), /file `mc outcome`, and stop/, "default is ask");
  assert.match(deskSeed("", null, "look at the export", null, "deploy"), /AND deploy it/);
});

test("a hand-off keeps only real PR links and shots this terminal uploaded", () => {
  const s = sessions.create({ cwd: "/tmp" });
  const shot = saveShot(s.id, "Before", "png", PNG);
  assert.ok("name" in shot);
  const o = normalizeOutcome(s.id, {
    summary: "Board shipped.",
    changes: ["three cards", ""],
    proof: ["npm test → green"],
    prs: ["https://github.com/o/r/pull/12", "https://evil.example/pull/1", "#12"],
    shots: [{ name: (shot as any).name, label: "before" }, { name: "../../etc/passwd", label: "x" }, { name: "after-0123456789ab.png", label: "never uploaded" }],
    ask: "merge+deploy",
  });
  assert.deepEqual(o.prs, ["https://github.com/o/r/pull/12"]);
  assert.deepEqual(o.changes, ["three cards"]);
  assert.equal(o.shots.length, 1);
  assert.equal(o.shots[0].label, "before");
  assert.equal(o.ask, "merge+deploy");
  assert.equal(normalizeOutcome(s.id, { summary: "x", ask: "rm -rf" }).ask, "review", "an unknown ask is a read, not an approval");
  sessions.setOutcome(s.id, o);
  const back = sessions.get(s.id)!;
  assert.equal(back.outcome!.summary, "Board shipped.");
  assert.equal(back.outcome_at, o.at);
  sessions.setOutcome(s.id, null);
  assert.equal(sessions.get(s.id)!.outcome, null);
});

test("a shot is opened only by a name saveShot wrote — no paths, no traversal", () => {
  const s = sessions.create({ cwd: "/tmp" });
  const r = saveShot(s.id, "after", ".PNG", PNG) as { name: string };
  assert.match(r.name, /^after-[0-9a-f]{12}\.png$/);
  assert.equal(shotFile(s.id, r.name)!.mime, "image/png");
  assert.equal(shotFile(s.id, "../" + r.name), null);
  assert.equal(shotFile(s.id, "/etc/passwd"), null);
  assert.equal(shotFile("other-session", r.name), null, "another terminal's shot is not reachable by name");
  assert.deepEqual(saveShot(s.id, "x", "svg", PNG), { error: "a screenshot is png, jpg, webp or gif" }, "no svg: it is a document that can carry script");
  assert.match((saveShot(s.id, "x", "png", Buffer.alloc(MAX_SHOT_BYTES + 1)) as any).error, /over/);
});

test("Focus reads every ask a terminal filed, open and answered, oldest first", () => {
  const s = sessions.create({ cwd: "/tmp" });
  const a = asks.create({ session_id: s.id, route: "robert", question: "drop the view?", options: JSON.stringify(["drop", "keep"]) });
  const b = asks.create({ session_id: s.id, route: "operator", question: "which finish line?" });
  const other = sessions.create({ cwd: "/tmp" });
  asks.create({ session_id: other.id, route: "robert", question: "not mine" });
  const rows = asks.forSession(s.id);
  assert.deepEqual(rows.map((r) => r.id), [a.id, b.id]);
  assert.match(api, /api\.get\("\/sessions\/:id\/decisions"/);
  assert.match(api, /if \(!checkScope\(req, res, s\.workspace_id\)\) return;\s*const own = asks\.forSession\(s\.id\);/, "scoped like every other per-terminal read");
});

test("progress carries the agent's step words and its guess of the time left", () => {
  const s = sessions.create({ cwd: "/tmp" });
  const now = Date.now();
  setProgress(s.id, { n: 2, of: 5, label: "migrations", eta_min: 20 }, now);
  const sig = { progress: { n: 2, of: 5, label: "migrations", at: now, eta_at: now + 20 * 60_000 } };
  const r = resolve({ live: true, goalDoneAt: null, goal: null, signals: sig, quiet: false, lastOut: now, lastIn: null, prompt: null, ask: null, daemonBlock: null, demandInspection: false, narration: null, result: null, now } as any);
  assert.deepEqual(r.progress, { n: 2, of: 5, label: "migrations", at: now, eta_at: now + 20 * 60_000 });
  assert.equal(r.line, "2/5 · migrations");
  assert.equal(statusOf("no-such"), null);
});

// ── the mc side ────────────────────────────────────────────────────────────────────────────────
type Hit = { method: string; url: string; body: any };
async function stub(answer: (h: Hit) => [number, unknown]) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      const h = { method: req.method ?? "", url: req.url ?? "", body: d ? JSON.parse(d) : null };
      hits.push(h);
      const [status, body] = answer(h);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(process.execPath, [MC, ...args], {
        env: { ...process.env, MC_API: `http://127.0.0.1:${port}/api`, MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "tok-1", MC_SESSION: "sess-1", MC_HOST_ID: "", MC_TICKET: "" },
      }, (err, stdout, stderr) => done({ code: err ? Number((err as any).code) || 1 : 0, stdout, stderr })));
  return { hits, run, close: () => server.close() };
}

test("mc goal set --done-when sends every check, in order", async () => {
  const s = await stub((h) => [200, { goal: h.body?.goal, done_when: h.body?.done_when ?? [] }]);
  const r = await s.run(["goal", "set", "ship the board", "--kind", "pr", "--done-when", "timeline gone", "--done-when", "npm test green"]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.hits[0].body, { goal: "ship the board", goal_source: "agent", goal_kind: "pr", done_when: ["timeline gone", "npm test green"] });
  assert.match(r.stdout, /☐ timeline gone/);
});

test("mc progress --eta sends minutes left", async () => {
  const s = await stub(() => [200, { word: "working", line: "2/5 · plan" }]);
  const r = await s.run(["progress", "2/5", "plan", "--eta", "20m"]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.hits[0].body, { n: 2, of: 5, label: "plan", eta_min: 20 });
});

test("mc outcome uploads screenshots as bytes, then files the hand-off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-shot-"));
  const before = path.join(dir, "before.png");
  fs.writeFileSync(before, PNG);
  const s = await stub((h) => (h.url.endsWith("/outcome/shot") ? [201, { name: "before-0123456789ab.png" }] : [201, { ...h.body, prs: h.body.prs, shots: h.body.shots }]));
  const r = await s.run(["outcome", "Board shipped.", "--change", "three cards", "--proof", "npm test green", "--shot", `before=${before}`, "--pr", "https://github.com/o/r/pull/12", "--ask", "merge"]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(s.hits[0].url, "/api/sessions/sess-1/outcome/shot");
  assert.equal(s.hits[0].body.label, "before");
  assert.equal(s.hits[0].body.ext, "png");
  assert.equal(Buffer.from(s.hits[0].body.data_base64, "base64").toString("hex"), PNG.toString("hex"));
  assert.equal(s.hits[0].body.path, undefined, "no path travels — the Desk may be on another computer");
  assert.deepEqual(s.hits[1].body, {
    summary: "Board shipped.", changes: ["three cards"], proof: ["npm test green"], prs: ["https://github.com/o/r/pull/12"],
    shots: [{ name: "before-0123456789ab.png", label: "before" }], ask: "merge", shipped: [],
  });
  assert.match(r.stdout, /hand-off filed/);
});

test("mc outcome refuses an ask it does not know, and mc ask-robert --operator goes past Robert", async () => {
  const s = await stub((h) => (h.url === "/api/asks" ? [201, { id: "a1b2c3d4e5", route: h.body.route }] : [200, { status: "answered", answer: "A", answered_by: "operator" }]));
  const bad = await s.run(["outcome", "x", "--ask", "yolo"]);
  assert.notEqual(bad.code, 0);
  const r = await s.run(["ask-robert", "which finish line?", "--options", "A,B", "--operator", "--wait", "1"]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  const ask = s.hits.find((h) => h.url === "/api/asks")!;
  assert.equal(ask.body.route, "operator");
  assert.match(r.stdout, /asked the operator/);
});
