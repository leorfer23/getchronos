import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, asks, kv, sessions, workspaces } from "./store.js";
import { operatorAnswered, operatorKeys } from "./ask-in-terminal.js";
import { holderAsk, holderBrief, ROBERT_ASKER } from "./robert-asks.js";
import { cancelSessionAsks } from "./ask-robert.js";

let n = 0;
const mkWs = () => workspaces.create({ slug: "ait-" + n++ + "-" + Math.random().toString(36).slice(2, 7), name: "AIT", config_dir: "/tmp/ait-" + n });
const mkSession = (ws: string) => {
  const id = "s" + Math.random().toString(36).slice(2, 10) + "-0000-0000-0000-000000000000";
  db.prepare("INSERT INTO sessions (id, workspace_id, cwd, status, created_at) VALUES (?,?,?, 'live', ?)").run(id, ws, "/tmp", new Date().toISOString());
  return id;
};
let answered: { id: string; text: string; by: string }[] = [];
const answer: any = async (id: string, text: string, by: string) => { answered.push({ id, text, by }); asks.answer(id, text, by); return { ok: true }; };

beforeEach(() => {
  db.exec("DELETE FROM asks; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'ask.holder:%';");
  answered = [];
});

test("his Enter in the terminal answers the ask that is his — typed line, backspace honoured", async () => {
  const ws = mkWs();
  const sid = mkSession(ws.id);
  const mine = asks.create({ session_id: sid, workspace_id: ws.id, route: "operator", question: "Ship it?", asked_by: "agent" } as any);
  const roberts = asks.create({ session_id: sid, workspace_id: ws.id, route: "robert", question: "routine?", asked_by: "agent" } as any);
  assert.equal(operatorKeys(sid, "yes, shipx", answer), null, "no Enter yet");
  assert.equal(operatorKeys(sid, "\x7f", answer), null);
  assert.equal(await operatorKeys(sid, "\r", answer), 1);
  assert.deepEqual(answered, [{ id: mine.id, text: "yes, ship", by: "operator" }]);
  assert.equal(asks.get(roberts.id)!.status, "open", "an ask still with Robert is not his to close");
});

test("a menu pick (arrows + Enter) answers with a placeholder; nothing open → nothing happens", async () => {
  const ws = mkWs();
  const sid = mkSession(ws.id);
  assert.equal(await operatorKeys(sid, "\r", answer), 0);
  const a = asks.create({ session_id: sid, workspace_id: ws.id, route: "robert", question: "Q", asked_by: "agent" } as any);
  asks.escalate?.(a.id, null);
  db.prepare("UPDATE asks SET escalated_at=? WHERE id=?").run(new Date().toISOString(), a.id);
  operatorKeys(sid, "\x1b[B", answer);
  assert.equal(await operatorKeys(sid, "\x1b[B\r", answer), 1);
  assert.equal(answered[0].text, "(answered in the terminal)");
});

test("Robert's question held by a terminal: answered there, dropped when it closes unanswered", async () => {
  const ws = mkWs();
  const a = asks.create({ asked_by: ROBERT_ASKER, route: "operator", question: "Which region?", options: JSON.stringify(["us", "eu"]), workspace_id: ws.id } as any);
  const sid = mkSession(ws.id);
  kv.set(`ask.holder:${sid}`, a.id);
  assert.equal(holderAsk(sid)!.id, a.id);
  assert.equal(await operatorAnswered(sid, "eu", answer), 1);
  assert.equal(holderAsk(sid), undefined, "answered → no longer held");

  const b = asks.create({ asked_by: ROBERT_ASKER, route: "operator", question: "Again?", workspace_id: ws.id } as any);
  const sid2 = mkSession(ws.id);
  kv.set(`ask.holder:${sid2}`, b.id);
  cancelSessionAsks(sid2);
  assert.equal(asks.get(b.id)!.status, "cancelled");
});

test("the holder brief: question, options, recommend, decide, and Robert acts — not the terminal", () => {
  const b = holderBrief({ question: "Which region?", options: JSON.stringify(["us", "eu"]) } as any);
  for (const bit of ["Which region?", '"us" / "eu"', "recommend", "mc state decide", "Robert receives the answer", "Do not carry out the decision yourself"])
    assert.ok(b.includes(bit), bit);
});
