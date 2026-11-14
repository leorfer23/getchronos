/**
 * Who typed a line (src/turn-source.ts): the daemon's lines are marked when it types them, and a
 * transcript's typed turns are told apart by those marks, the `session.input` trail, the daemon's own
 * fixed openings, and the seed — whatever matches nothing is the operator's.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { activity, db, sessions, workspaces } from "./store.js";
import { inputMarks } from "./store/input-marks.js";
import { adoptRemoteSession, sendInput } from "./terminal.js";
import { stopFocus } from "./focus.js";
import { REVIVE_NUDGE } from "./revive.js";
import { tellLine } from "./verify-model.js";
import { continuationMessage } from "./continuations.js";
import { holderAnswerLine } from "./asks.js";
import { classifyTurns, kindOfBy, markInput, marksFor, openingKind, textKey, type Mark } from "./turn-source.js";

beforeEach(() => {
  db.exec("DELETE FROM input_marks; DELETE FROM activity; DELETE FROM sessions;");
});

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const mark = (kind: Mark["kind"], text: string, at: number): Mark => ({ kind, key: textKey(text), at });

test("kindOfBy: the operator, the daemon's own hands, Leads, continuations, and any other name is an agent's tell", () => {
  const cases: [string | null, string][] = [
    [null, "operator"], ["", "operator"], ["operator", "operator"], ["verifier", "verifier"], ["net-nudge", "network"],
    ["ask", "ask"], ["lead:ab12cd34", "lead"], ["continuation:ab12cd34", "continuation"], ["cache-keeper", "system"],
    ["executor", "system"], ["failover", "system"], ["budget", "system"], ["ship", "system"], ["daemon", "system"],
    ["robert", "robert"], ["some-agent-handle", "robert"],
  ];
  for (const [by, kind] of cases) assert.equal(kindOfBy(by), kind, String(by));
});

test("textKey ignores case, whitespace and bracketed-paste markers, and only the opening words count", () => {
  assert.equal(textKey("Put it in   Downloads"), textKey("put it in downloads"));
  assert.equal(textKey("\x1b[200~put it in downloads\x1b[201~"), textKey("put it in downloads"));
  const long = "x".repeat(120);
  assert.equal(textKey(long + " tail one"), textKey(long + " tail two"), "a CLI's edit past the opening does not change the identity");
  assert.notEqual(textKey("put it in downloads"), textKey("put it in documents"));
});

test("each producer of a daemon line is recognised by its opening, even with no mark (turns from before marks existed)", () => {
  assert.equal(openingKind(tellLine(1, ["tests: the repo's checks fail"])), "verifier");
  assert.equal(openingKind(REVIVE_NUDGE), "revive");
  assert.equal(openingKind("Your last turn died because the network was down (or the Mac slept): it is back now."), "network");
  const c = { id: "c0ffee00-0000-0000-0000-000000000000", label: "PR #12 approved", outcome: "met", evidence: "approved", note: null } as any;
  assert.equal(openingKind(continuationMessage(c).replace(/\n/g, " · ")), "continuation");
  assert.equal(openingKind(continuationMessage({ ...c, outcome: "broken" })), "continuation");
  const ask = { id: "a5a5a5a5-0000-0000-0000-000000000000", question: "Which schema?", answer: "staging" } as any;
  assert.equal(openingKind(holderAnswerLine(ask)), "ask");
  assert.equal(openingKind("always put the csv in downloads"), null, "his words have no daemon opening");
});

test("classifyTurns: a mark claims the earliest matching turn once; a merged queued turn matches by line; the rest is his", () => {
  const turns = [
    { text: "Run the migration again", at: T0, first: true },
    { text: "Run the migration again", at: T0 + 60_000 },
    { text: "ok\nThe network is fine now, carry on", at: T0 + 120_000 },
    { text: "always put exports in downloads", at: T0 + 180_000 },
  ];
  const marks = [mark("robert", "Run the migration again", T0 - 1000), mark("network", "The network is fine now, carry on", T0 + 100_000)];
  assert.deepEqual(classifyTurns(turns, marks), ["robert", "operator", "network", "operator"]);
});

test("classifyTurns: a mark stamped long after the turn is not its author; a queued line still is, within the queue window", () => {
  const t = [{ text: "carry on", at: T0 }];
  assert.deepEqual(classifyTurns(t, [mark("system", "carry on", T0 + 5 * 60_000)]), ["operator"], "typed after the turn landed — cannot have typed it");
  assert.deepEqual(classifyTurns(t, [mark("system", "carry on", T0 - 2 * 3600_000)]), ["system"], "sat in the CLI's queue for two hours");
  assert.deepEqual(classifyTurns(t, [mark("system", "carry on", T0 - 20 * 3600_000)]), ["operator"], "older than any queue holds");
});

test("classifyTurns: the seed is the transcript's first turn only", () => {
  const seed = "Goal: fix the login redirect\n\nBrief from your operator: be careful with prod";
  const turns = [{ text: seed, at: T0, first: true }, { text: seed, at: T0 + 1000 }];
  assert.deepEqual(classifyTurns(turns, [], textKey(seed)), ["seed", "operator"]);
  assert.deepEqual(classifyTurns(turns, []), ["operator", "operator"], "no seed known → his");
});

test("marksFor: its own rows plus the session.input trail — key presses are not lines; rows of other terminals never count", () => {
  markInput({ session_id: "s1", workspace_id: null, kind: "verifier", by: "verifier", text: "[verifier] Not ready", at: new Date(T0).toISOString() });
  markInput({ session_id: "s2", workspace_id: null, kind: "robert", by: "robert", text: "elsewhere", at: new Date(T0).toISOString() });
  markInput({ session_id: "s1", workspace_id: null, kind: "system", by: "x", text: "   ", at: new Date(T0).toISOString() });
  const trail = [
    { ts: new Date(T0 + 1000).toISOString(), detail: JSON.stringify({ by: "lead:ab12cd34", text: "split the work", session_id: "s1" }) },
    { ts: new Date(T0 + 2000).toISOString(), detail: JSON.stringify({ by: "operator", text: "<down><enter>", session_id: "s1" }) },
    { ts: new Date(T0 + 3000).toISOString(), detail: "not json" },
  ];
  const m = marksFor("s1", trail);
  assert.deepEqual(m.map((x) => x.kind), ["verifier", "lead"]);
  assert.equal(m[1].key, textKey("split the work"));
});

test("sendInput marks the line it types with who it is really from — and never the operator's own keystrokes as the daemon's", () => {
  const ws = workspaces.create({ slug: `ts-${Date.now()}`, name: "ts", config_dir: "/tmp/ts-test" } as any);
  const row = sessions.create({ workspace_id: ws.id, cwd: "/tmp", host_id: "h-ts" } as any);
  const writes: string[] = [];
  const term: any = { pid: 1, cols: 80, rows: 24, write: (d: string) => writes.push(d), resize() {}, kill() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
  assert.equal(adoptRemoteSession(sessions.get(row.id)!, term), true);
  try {
    assert.equal(sendInput(row.id, { text: "[verifier] Not ready for the operator yet" }, "verifier"), null);
    assert.equal(sendInput(row.id, { text: "y" }, "operator", "approval"), null);
    assert.equal(sendInput(row.id, { text: "split it in two" }, "operator", "lead"), null, "a Lead typing with no name of its own");
    assert.equal(sendInput(row.id, { keys: ["down", "enter"] }, "operator"), null);
    const rows = inputMarks.forSession(row.id);
    assert.deepEqual(rows.map((r) => [r.kind, r.workspace_id]), [["verifier", ws.id], ["approval", ws.id], ["lead", ws.id]], "a key press is not a line");
    assert.ok(rows.every((r) => !("text" in r)), "the text itself is never stored");
  } finally {
    stopFocus(row.id);
  }
});

void activity;
