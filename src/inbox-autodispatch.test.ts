import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, inbox, kv, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { createAutoDispatcher } from "./inbox-autodispatch.js";

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
const mk = (over: any = {}) => createAutoDispatcher({ opener, now: () => clock, enabled: () => true, ...over });

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
  for (const bit of ["Bash(gh pr merge:*)", "Bash(npm run deploy:*)", "Bash(git push --force:*)", "mcp__slack"]) assert.ok(list.split(",").includes(bit), bit);
  assert.ok(!list.includes("Bash(git push:*)"), "pushing its own branch stays allowed");
});
