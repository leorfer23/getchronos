import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, inbox, kv, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { createAutoDispatcher, NO_WORK } from "./inbox-autodispatch.js";

const mkWs = () =>
  workspaces.create({ slug: "ia-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);
const add = (ws: string, key = randomUUID()) =>
  inbox.add({ workspace_id: ws, source: "slack", kind: "dm", external_key: key, title: "t " + key.slice(0, 4) })!;
const liveSession = (id: string, ws: string) =>
  db.prepare("INSERT INTO sessions (id, workspace_id, cwd, status, created_at) VALUES (?,?,?, 'live', ?)").run(id, ws, "/tmp", new Date().toISOString());

let clock = 0;
let opened: any[] = [];
const opener: any = async (o: any) => {
  const id = "s-" + randomUUID().slice(0, 8);
  liveSession(id, o.workspace_id);
  opened.push(o);
  return { id };
};
const work = async () => ({ work: true, why: "asks for a fix", task: null });
const mk = (over: any = {}) => createAutoDispatcher({ opener, now: () => clock, enabled: () => true, triage: work, triageOn: () => true, ...over });

beforeEach(() => {
  db.exec("DELETE FROM inbox_items; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'inbox.%';");
  clock = 1_000_000;
  opened = [];
});

test("the backlog filed before the feature ran is never auto-opened", async () => {
  const ws = mkWs();
  add(ws.id);
  const d = mk();
  await d.pump();
  clock += 10 * 60_000;
  assert.deepEqual(await d.pump(), []);
});

test("a new row opens one terminal after the grace, as an agent open with the cheap model", async () => {
  const ws = mkWs();
  const d = mk();
  await d.pump(); // stamps the cutoff
  const row = add(ws.id);
  assert.deepEqual(await d.pump(), [], "inside the grace");
  clock += CONFIG.inboxAuto.graceSec * 1000;
  assert.deepEqual(await d.pump(), [row.id]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].created_by, "inbox");
  assert.equal(opened[0].model, CONFIG.inboxAuto.model);
  assert.match(opened[0].description, /opened by itself/);
  assert.equal(inbox.get(row.id)!.state, "dispatched");
  assert.deepEqual(await d.pump(), [], "one row, one terminal");
});

test("a row closed or dismissed during the grace never opens", async () => {
  const ws = mkWs();
  const d = mk();
  await d.pump();
  const a = add(ws.id), b = add(ws.id);
  await d.pump();
  inbox.resolve(a.id, "you replied");
  inbox.dismiss(b.id);
  clock += CONFIG.inboxAuto.graceSec * 1000;
  assert.deepEqual(await d.pump(), []);
});

test("cap per workspace; closing a terminal closes its row and lets the next one open", async () => {
  const ws = mkWs(), other = mkWs();
  const d = mk();
  await d.pump();
  const rows = Array.from({ length: CONFIG.inboxAuto.perWorkspace + 1 }, () => add(ws.id));
  const o = add(other.id);
  await d.pump();
  clock += CONFIG.inboxAuto.graceSec * 1000;
  const first = await d.pump();
  assert.equal(first.filter((id) => id !== o.id).length, CONFIG.inboxAuto.perWorkspace);
  assert.ok(first.includes(o.id), "another client has its own seats");
  const waiting = rows.find((r) => !first.includes(r.id))!;
  assert.equal(inbox.get(waiting.id)!.state, "new");

  const sid = inbox.get(first[0])!.dispatched_session!;
  db.prepare("UPDATE sessions SET status='ended', ended_at=? WHERE id=?").run(new Date().toISOString(), sid);
  d.onEvent({ topic: "session.ended", session_id: sid } as any);
  await new Promise((r) => setImmediate(r));
  assert.equal(inbox.get(first[0])!.state, "resolved");
  assert.equal(inbox.get(waiting.id)!.state, "dispatched");
});

test("off for a workspace → nothing opens there", async () => {
  const ws = mkWs();
  const d = mk({ enabled: () => false });
  await d.pump();
  add(ws.id);
  clock += CONFIG.inboxAuto.graceSec * 1000 * 2;
  await d.pump();
  assert.deepEqual(await d.pump(), []);
});

test("a full seat retries later; a row that keeps failing for its own reasons stops after 3", async () => {
  const ws = mkWs();
  let err = "session cap reached";
  let tries = 0;
  const d = mk({ opener: async () => { tries++; throw new Error(err); } });
  await d.pump();
  const row = add(ws.id);
  await d.pump();
  clock += CONFIG.inboxAuto.graceSec * 1000;
  for (let i = 0; i < 5; i++) await d.pump();
  assert.equal(tries, 5, "capacity refusals never give up");
  err = "cwd does not exist";
  for (let i = 0; i < 5; i++) await d.pump();
  assert.equal(tries, 8);
  assert.equal(inbox.get(row.id)!.state, "new", "left for the operator");
  assert.ok(kv.get("inbox.auto.after") != null);
});

test("the box: rules + CLI deny list keyed off the row, so a reopen keeps them", async () => {
  const { INBOX_AUTO_RULES, inboxAutoDenyArgs, isInboxAuto } = await import("./inbox-guard.js");
  assert.ok(isInboxAuto({ created_by: "inbox" }));
  assert.ok(!isInboxAuto({ created_by: "operator" }));
  for (const bit of ["merge a PR", "deploy", "NO messages anywhere", "open a pull request"]) assert.ok(INBOX_AUTO_RULES.includes(bit), bit);
  const [flag, list] = inboxAutoDenyArgs();
  assert.equal(flag, "--disallowed-tools");
  for (const bit of ["Bash(gh pr merge:*)", "Bash(npm run deploy:*)", "Bash(git push --force:*)", "mcp__jira", "mcp__slack__slack_send_message", "mcp__slack__slack_add_reaction"]) assert.ok(list.split(",").includes(bit), bit);
  for (const ok of ["mcp__slack", "mcp__slack__slack_send_message_draft", "mcp__slack__slack_search_public_and_private", "mcp__slack__slack_read_thread"]) assert.ok(!list.split(",").includes(ok), `${ok} stays usable`);
  assert.ok(INBOX_AUTO_RULES.includes("slack_send_message_draft"));
  assert.ok(!list.includes("Bash(git push:*)"), "pushing its own branch stays allowed");
});

// ───────────────────────────── first pass: is there work? ─────────────────────────────

const pastGrace = async (d: ReturnType<typeof mk>) => { await d.pump(); clock += CONFIG.inboxAuto.graceSec * 1000; return d.pump(); };

test("no work → no terminal: the row closes with the reason, judged once", async () => {
  const ws = mkWs();
  let calls = 0;
  const d = mk({ triage: async () => { calls++; return { work: false, why: "a joke in #random", task: null }; } });
  await d.pump();
  const row = add(ws.id);
  assert.deepEqual(await pastGrace(d), []);
  assert.equal(opened.length, 0);
  const r = inbox.get(row.id)!;
  assert.equal(r.state, "resolved");
  assert.equal(r.resolved_reason, NO_WORK + "a joke in #random");
  clock += 10 * 60_000;
  await d.pump();
  assert.equal(calls, 1);
});

test("work → the terminal opens with the first pass's read of the job in its brief", async () => {
  const ws = mkWs();
  const d = mk({ triage: async () => ({ work: true, why: "asks for a data pull", task: "Pull September fees by processor for Ana" }) });
  await d.pump();
  const row = add(ws.id);
  assert.deepEqual(await pastGrace(d), [row.id]);
  assert.match(opened[0].description, /First read of the job: Pull September fees by processor for Ana/);
});

test("reopening a no-work row in the Inbox log opens it without asking again", async () => {
  const ws = mkWs();
  let calls = 0;
  const d = mk({ triage: async () => { calls++; return { work: false, why: "FYI", task: null }; } });
  await d.pump();
  const row = add(ws.id);
  await pastGrace(d);
  assert.equal(inbox.get(row.id)!.state, "resolved");
  inbox.reopen(row.id);
  assert.deepEqual(await pastGrace(d), [row.id]);
  assert.equal(calls, 1);
  assert.equal(inbox.get(row.id)!.state, "dispatched");
});

test("a work row waiting for a seat is not judged twice", async () => {
  const ws = mkWs();
  let calls = 0;
  const d = mk({ triage: async () => { calls++; return { work: true, why: "x", task: null }; } });
  await d.pump();
  const rows = Array.from({ length: CONFIG.inboxAuto.perWorkspace + 1 }, () => add(ws.id));
  await pastGrace(d);
  for (let i = 0; i < 3; i++) await d.pump();
  assert.equal(calls, rows.length);
});

test("a full client still closes its no-work rows as they arrive", async () => {
  const ws = mkWs();
  const d = mk({ triage: async (i: any) => ({ work: !i.title.startsWith("fyi"), why: "x", task: null }) });
  await d.pump();
  for (let i = 0; i < CONFIG.inboxAuto.perWorkspace; i++) add(ws.id);
  await pastGrace(d);
  assert.equal(opened.length, CONFIG.inboxAuto.perWorkspace);
  const fyi = inbox.add({ workspace_id: ws.id, source: "slack", kind: "dm", external_key: randomUUID(), title: "fyi shared a link" })!;
  await pastGrace(d);
  assert.equal(inbox.get(fyi.id)!.state, "resolved");
});

test("a failing first pass waits one tick, then opens the row as before", async () => {
  const ws = mkWs();
  let calls = 0;
  const d = mk({ triage: async () => { calls++; if (calls === 1) throw new Error("timeout"); return null; } });
  await d.pump();
  const row = add(ws.id);
  assert.deepEqual(await pastGrace(d), [], "first failure waits");
  assert.deepEqual(await d.pump(), [row.id], "second failure opens");
  assert.equal(calls, 2);
});

test("first pass off for a client → every row opens and the model is never asked", async () => {
  const ws = mkWs();
  let calls = 0;
  const d = mk({ triageOn: () => false, triage: async () => { calls++; return { work: false, why: "x", task: null }; } });
  await d.pump();
  const row = add(ws.id);
  assert.deepEqual(await pastGrace(d), [row.id]);
  assert.equal(calls, 0);
});
