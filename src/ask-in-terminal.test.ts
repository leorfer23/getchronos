import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, asks, kv, sessions, workspaces } from "./store.js";
import { operatorAnswered, operatorKeys } from "./ask-in-terminal.js";
import { holderAsks, holderBrief, ROBERT_ASKER } from "./robert-asks.js";
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
  db.exec("DELETE FROM asks; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv WHERE key LIKE 'ask.holder:%' OR key LIKE 'ask.at:%';");
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
  assert.equal(holderAsks(sid)[0].id, a.id);
  assert.equal(await operatorAnswered(sid, "eu", answer), 1);
  assert.deepEqual(holderAsks(sid), [], "answered → no longer held");

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

test("Robert's question about a live terminal rides on it: no new terminal, red count, answered by typing there", async () => {
  const { raiseRobertAsk, targetTerminal, holderAsks, heldBy } = await import("./robert-asks.js");
  const { statusOf } = await import("./term-status.js");
  const ws = mkWs();
  const { randomUUID } = await import("node:crypto");
  const mkLive = () => {
    const id = randomUUID();
    db.prepare("INSERT INTO sessions (id, workspace_id, cwd, status, created_at) VALUES (?,?,?, 'live', ?)").run(id, ws.id, "/tmp", new Date().toISOString());
    return id;
  };
  const sid = mkLive();
  const other = mkLive();
  assert.equal(targetTerminal({ question: "merge?", terminal: sid.slice(0, 8), workspace_id: ws.id })!.id, sid, "named by id8");
  assert.equal(targetTerminal({ question: `PR triage (${sid.slice(0, 8)}): merge #577?`, workspace_id: ws.id })!.id, sid, "named in the text");
  assert.equal(targetTerminal({ question: `${sid.slice(0, 8)} or ${other.slice(0, 8)}?`, workspace_id: ws.id }), null, "ambiguous → none");
  assert.equal(targetTerminal({ question: "merge?", terminal: sid.slice(0, 8), workspace_id: mkWs().id }), null, "another workspace's terminal");

  const before = (db.prepare("SELECT count(*) n FROM sessions").get() as any).n;
  const a = raiseRobertAsk({ question: "Merge #577?", options: ["yes", "no"], workspace_id: ws.id, terminal: sid.slice(0, 8) });
  const b = raiseRobertAsk({ question: `And close #147 (${sid.slice(0, 8)})?`, options: null, workspace_id: ws.id });
  assert.equal((db.prepare("SELECT count(*) n FROM sessions").get() as any).n, before, "no terminal opened");
  assert.deepEqual(holderAsks(sid).map((x) => x.id), [a.id, b.id]);
  assert.equal(heldBy(a.id), sid);
  assert.equal(a.session_id ?? null, null, "still Robert's own ask — his wake hears the answer");

  const st = statusOf(sid);
  if (st && st.phase !== "ended") assert.equal(st.asks, 2);

  assert.equal(await operatorAnswered(sid, "yes to both", answer), 2);
  assert.deepEqual(holderAsks(sid), []);
});

test("the Desk rail paints the question count on the row", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../static/desk.html", import.meta.url), "utf8");
  assert.ok(html.includes('<span class="asks" hidden></span>'));
  assert.ok(html.includes("s.status?.asks"));
});
