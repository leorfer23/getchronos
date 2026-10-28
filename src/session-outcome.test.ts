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
import { addShown, boardNudge, decodeDoneWhen, encodeDoneWhen, fileOutcome, normalizeOutcome, normalizeShow, saveShot, shipLine, shotFile, MAX_SHOT_BYTES, MAX_EARLIER, MAX_SHOWN, NUDGE_STALE_MS } from "./session-outcome.js";
import type { Outcome } from "./types.js";
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
  const run = (args: string[], input?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const c = execFile(process.execPath, [MC, ...args], {
        env: { ...process.env, MC_API: `http://127.0.0.1:${port}/api`, MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "tok-1", MC_SESSION: "sess-1", MC_HOST_ID: "", MC_TICKET: "" },
      }, (err, stdout, stderr) => done({ code: err ? Number((err as any).code) || 1 : 0, stdout, stderr }));
      if (input !== undefined) c.stdin!.end(input);
    });
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

// ── checks ticked one by one, hand-offs kept, the board kept moving (Leo 2026-10-28) ────────────
test("finish-line checks tick one by one, by number, and keep their ticks when the list is rewritten", () => {
  const s = sessions.create({ cwd: "/tmp", goal: "ship the board" });
  sessions.setFinish(s.id, { done_when: ["timeline gone", "npm test green", "screenshot"] });
  assert.deepEqual(sessions.get(s.id)!.done_checked, [null, null, null]);
  sessions.setChecks(s.id, [2, 9], true);
  const got = sessions.get(s.id)!.done_checked;
  assert.equal(got[0], null);
  assert.match(String(got[1]), /^\d{4}-\d\d-\d\dT/, "a tick is the time it was met");
  assert.equal(got.length, 3, "a number off the list is ignored");
  // The agent rewrites its list: the check it kept keeps its tick, the one it dropped is gone.
  sessions.setFinish(s.id, { done_when: ["npm test green", "PR open"] });
  assert.deepEqual(sessions.get(s.id)!.done_checked.map(Boolean), [true, false]);
  sessions.setChecks(s.id, [1], false);
  assert.deepEqual(sessions.get(s.id)!.done_checked, [null, null]);
  assert.equal((sessions.get(s.id) as any).done_ticks, undefined, "the raw column never rides a row");
});

const ho = (summary: string, more: Partial<Outcome> = {}, at = "2026-10-28T10:00:00.000Z"): Outcome =>
  ({ summary, changes: [], proof: [], prs: [], shots: [], ask: "merge", shipped: [], at, ...more });
const PR = "https://github.com/o/r/pull/12", PR2 = "https://github.com/o/r/pull/13";
test("a correction replaces the hand-off on top; a follow-up goes on top and keeps the earlier one", () => {
  const first = ho("Board shipped.", { prs: [PR], proof: ["npm test green"] });
  // Re-filed with nothing new in between: a correction.
  let r = fileOutcome(first, [], ho("Board shipped, with screenshots.", { prs: [PR] }, "2026-10-28T10:05:00.000Z"), null);
  assert.equal(r.latest.summary, "Board shipped, with screenshots.");
  assert.equal(r.earlier.length, 0);
  // The operator typed to it after the hand-off: the next one is a follow-up.
  r = fileOutcome(first, [], ho("Changes done.", { prs: [PR] }, "2026-10-28T11:00:00.000Z"), Date.parse("2026-10-28T10:30:00.000Z"));
  assert.equal(r.latest.summary, "Changes done.");
  assert.deepEqual(r.earlier.map((o) => o.summary), ["Board shipped."]);
  // A PR the one on top did not have: new work.
  r = fileOutcome(first, [], ho("Second PR.", { prs: [PR2] }), null);
  assert.equal(r.earlier.length, 1);
  // The one on top was shipped and this one was not: new work.
  r = fileOutcome(ho("Merged.", { prs: [PR], shipped: ["merged #12"] }), [], ho("Follow-up.", { prs: [PR] }), null);
  assert.equal(r.earlier.length, 1);
  // Capped: the oldest fall off.
  const many = Array.from({ length: MAX_EARLIER }, (_, i) => ho("old " + i));
  r = fileOutcome(first, many, ho("newest", { prs: [PR2] }), null);
  assert.equal(r.earlier.length, MAX_EARLIER);
  assert.equal(r.earlier[r.earlier.length - 1].summary, "Board shipped.");
});

test("--shipped re-files land on the hand-off on top, even right after the operator's approval", () => {
  const top = ho("Board shipped.", { prs: [PR], proof: ["npm test green"], changes: ["three cards"] });
  const approvedAt = Date.parse("2026-10-28T10:10:00.000Z");
  // `mc outcome --shipped "merged #12"` — no summary.
  let r = fileOutcome(top, [], ho("", { shipped: ["merged #12"], ask: "review" }, "2026-10-28T10:20:00.000Z"), approvedAt);
  assert.equal(r.latest.summary, "Board shipped.");
  assert.deepEqual(r.latest.shipped, ["merged #12"]);
  assert.equal(r.latest.ask, "merge", "what it asked for stays; shipped says it is done");
  assert.equal(r.earlier.length, 0);
  // The old way: the whole hand-off re-filed with --shipped and its lists left out — same hand-off, lists kept.
  r = fileOutcome(top, [], ho("Board shipped and merged.", { prs: [PR], shipped: ["merged #12"], ask: "none" }, "2026-10-28T10:20:00.000Z"), approvedAt);
  assert.equal(r.earlier.length, 0);
  assert.deepEqual(r.latest.proof, ["npm test green"]);
  assert.deepEqual(r.latest.changes, ["three cards"]);
});

test("POST /outcome refuses an empty summary unless it is a --shipped re-file onto a hand-off", () => {
  assert.match(api, /if \(!o\.summary && !\(o\.shipped\.length && s\.outcome\)\) return res\.status\(400\)/);
  assert.match(api, /const filed = fileOutcome\(s\.outcome, s\.outcome_prev, o, operatorSaidAt\(s\.id\)\);/);
  assert.match(api, /earlier: s\.outcome_prev,/, "Focus reads the earlier ones with the rest of its decisions");
  // The rail learns a hand-off waits for a yes without carrying hand-off bodies on every row.
  assert.match(api, /handoff: s\.outcome && !s\.outcome\.shipped\?\.length && \["merge", "deploy", "merge\+deploy"\]\.includes\(s\.outcome\.ask\)/);
  const s = sessions.create({ cwd: "/tmp" });
  sessions.setOutcome(s.id, ho("two"), [ho("one")]);
  assert.deepEqual(sessions.get(s.id)!.outcome_prev.map((o) => o.summary), ["one"]);
  sessions.setOutcome(s.id, null);
  assert.deepEqual(sessions.get(s.id)!.outcome_prev, [], "clearing clears them all");
});

test("the board nudge: only while working, only once it has gone stale, and it says what the operator sees", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const base = { phase: "working", goal: "ship the board", done_when: ["tests green", "PR open"], checked: ["2026-10-28T11:30:00.000Z", null], progress: { n: 2, of: 5, label: "tests", at: now - 15 * 60_000 }, since: now - 60 * 60_000 };
  const t = boardNudge(base, now)!;
  assert.match(t, /has not moved for 15 min/);
  assert.match(t, /Progress: 2\/5 "tests" \(15 min ago\)/);
  assert.match(t, /\[x\] 1\. tests green · \[ \] 2\. PR open/);
  assert.match(t, /mc goal check <n>/);
  assert.equal(boardNudge({ ...base, phase: "decide" }, now), null, "a terminal waiting on you is not nagged");
  assert.equal(boardNudge({ ...base, progress: { ...base.progress, at: now - 60_000 } }, now), null, "moved a minute ago");
  assert.equal(boardNudge({ ...base, progress: null, checked: [null, null], since: now - NUDGE_STALE_MS + 1000 }, now), null, "a fresh terminal gets its first minutes");
  assert.match(boardNudge({ ...base, goal: null, done_when: [], checked: [], progress: null }, now)!, /Goal: none written[\s\S]*Done when: none written/);
});

test("mc goal check ticks by number and prints the list; out-of-range numbers are refused", async () => {
  const s = await stub((h) => (h.method === "GET"
    ? [200, { done_when: ["timeline gone", "npm test green"], done_checked: [null, null] }]
    : [200, { done_when: ["timeline gone", "npm test green"], done_checked: [null, "2026-10-28T10:00:00Z"] }]));
  const r = await s.run(["goal", "check", "2"]);
  const bad = await s.run(["goal", "check", "5"]);
  s.close();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.hits[1].body, { check: [2] });
  assert.match(r.stdout, /1\/2 checks met/);
  assert.match(r.stdout, /2\. ☑ npm test green/);
  assert.notEqual(bad.code, 0);
});

test("mc outcome --shipped alone files no summary; mc hook claude nudge prints one JSON object or nothing", async () => {
  let ctx: string | null = "Your Focus board has not moved for 12 min.";
  const s = await stub((h) => (h.url.endsWith("/board-nudge") ? [200, { context: ctx }] : [201, { ...h.body, changes: [], proof: [], shots: [], prs: [], earlier: 0 }]));
  const r = await s.run(["outcome", "--shipped", "merged #12"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(s.hits[0].body, { summary: "", changes: [], proof: [], prs: [], shots: [], ask: "review", shipped: ["merged #12"] });
  const ev = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "sess-1", tool_name: "Bash" });
  const said = await s.run(["hook", "claude", "nudge"], ev);
  assert.deepEqual(JSON.parse(said.stdout), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Your Focus board has not moved for 12 min." } });
  ctx = null;
  const quiet = await s.run(["hook", "claude", "nudge"], ev);
  // A child `claude -p` inside the terminal is not the card: no call, no output.
  const child = await s.run(["hook", "claude", "nudge"], JSON.stringify({ hook_event_name: "PostToolUse", session_id: "other", tool_name: "Bash" }));
  s.close();
  assert.equal(quiet.stdout, "");
  assert.equal(child.stdout, "");
  assert.equal(s.hits.filter((h) => h.url.endsWith("/board-nudge")).length, 2);
  assert.ok(!s.hits.some((h) => h.url.endsWith("/hook")), "the nudge call never posts a card event");
});

// ── mc show: images on Focus mid-work (Leo 2026-10-28: an agent listed screenshot paths and opened Finder) ──

test("a show keeps only images this terminal uploaded, rides the row, and the oldest fall off", () => {
  const s = sessions.create({ cwd: "/tmp" });
  const a = saveShot(s.id, "menu", "png", PNG) as { name: string };
  const other = sessions.create({ cwd: "/tmp" });
  const theirs = saveShot(other.id, "theirs", "png", PNG) as { name: string };
  assert.equal(normalizeShow(s.id, { caption: "x", shots: [{ name: theirs.name }] }), null, "another terminal's upload is not this one's to show");
  assert.equal(normalizeShow(s.id, { caption: "x", shots: [{ name: "../../etc/passwd" }] }), null);
  const show = normalizeShow(s.id, { caption: "The new menu", shots: [{ name: a.name, label: "menu" }, { name: "after-0123456789ab.png" }] })!;
  assert.deepEqual(show.shots, [{ name: a.name, label: "menu" }]);
  assert.equal(show.caption, "The new menu");
  assert.deepEqual(sessions.get(s.id)!.shown, [], "none yet reads as an empty list");
  assert.equal(sessions.get(s.id)!.shown_at, null);
  sessions.addShown(s.id, show);
  const back = sessions.get(s.id)!;
  assert.equal(back.shown.length, 1);
  assert.equal(back.shown_at, show.at);
  let list = [show];
  for (let i = 0; i < MAX_SHOWN + 5; i++) list = addShown(list, { ...show, caption: "c" + i });
  assert.equal(list.length, MAX_SHOWN);
  assert.equal(list[list.length - 1].caption, "c" + (MAX_SHOWN + 4), "the newest is kept");
});

test("the show route is workspace-scoped, Focus reads the list from /decisions, and /desk rows carry only its time", () => {
  const at = api.indexOf('api.post("/sessions/:id/show"');
  assert.ok(at > 0);
  const body = api.slice(at, api.indexOf("\n  });", at));
  assert.match(body, /validate\(SessionShowSchema\)/);
  assert.match(body, /checkScope\(req, res, s\.workspace_id\)/);
  assert.match(body, /normalizeShow\(s\.id, req\.body\)/);
  assert.match(api, /shown: s\.shown,/);
  assert.match(api, /outcome_prev: null,\s*\/\/[^\n]*\n\s*shown: null,/);
});

test("mc show uploads every image as bytes — a directory's in order, name=file labelled — then files one show", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-show-"));
  fs.writeFileSync(path.join(dir, "b-actions.png"), PNG);
  fs.writeFileSync(path.join(dir, "a-menu.jpg"), PNG);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  const one = path.join(os.tmpdir(), `mc-show-one-${process.pid}.webp`);
  fs.writeFileSync(one, PNG);
  let n = 0;
  const s = await stub((h) => (h.url.endsWith("/outcome/shot") ? [201, { name: `shot-${String(++n).padStart(12, "0")}.png` }] : [201, { ...h.body, at: "now" }]));
  const r = await s.run(["show", dir, `production=${one}`, "--caption", "For the kitchen team: the new menu"]);
  assert.equal(r.code, 0, r.stderr);
  const ups = s.hits.filter((h) => h.url === "/api/sessions/sess-1/outcome/shot");
  assert.deepEqual(ups.map((h) => [h.body.label, h.body.ext]), [["a-menu", "jpg"], ["b-actions", "png"], ["production", "webp"]]);
  assert.equal(Buffer.from(ups[0].body.data_base64, "base64").toString("hex"), PNG.toString("hex"));
  assert.ok(ups.every((h) => h.body.path === undefined), "no path travels — the Desk may be on another computer");
  const filed = s.hits[s.hits.length - 1];
  assert.equal(filed.url, "/api/sessions/sess-1/show");
  assert.deepEqual(filed.body, {
    caption: "For the kitchen team: the new menu",
    shots: [{ name: "shot-000000000001.png", label: "a-menu" }, { name: "shot-000000000002.png", label: "b-actions" }, { name: "shot-000000000003.png", label: "production" }],
  });
  assert.match(r.stdout, /3 images in Talk/);
  // Refused before anything is uploaded: a non-image, more than 12, nothing at all.
  const before = s.hits.length;
  const svg = path.join(dir, "x.svg"); fs.writeFileSync(svg, "<svg/>");
  for (let i = 0; i < 13; i++) fs.writeFileSync(path.join(dir, `p${i}.png`), PNG);
  const bad = await s.run(["show", svg]);
  const many = await s.run(["show", dir]);
  const none = await s.run(["show"]);
  s.close();
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /png, jpg, webp or gif/);
  assert.notEqual(many.code, 0);
  assert.match(many.stderr, /up to 12/);
  assert.notEqual(none.code, 0);
  assert.equal(s.hits.length, before, "a refused show uploads nothing");
});

test("every terminal is told to show images with mc show, and the skill says how", () => {
  const term = fs.readFileSync(path.join(import.meta.dirname, "terminal.ts"), "utf8");
  const contract = term.slice(term.indexOf("const FOCUS_CONTRACT"), term.indexOf("## Checkout + load"));
  assert.match(contract, /mc show <file\|dir>/);
  assert.match(contract, /shows them nothing/);
  const skill = fs.readFileSync(path.join(import.meta.dirname, "..", "skills", "mission-control", "SKILL.md"), "utf8");
  assert.match(skill, /## Showing images — `mc show`/);
  assert.match(skill, /\| \*\*Talk\*\* \|/);
});
