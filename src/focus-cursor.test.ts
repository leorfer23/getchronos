import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "focus-cursor-"));
process.env.HOME = home;
const { snapshotFocus, hasTranscript, cursorEventsSince, focusEfficiencySnapshot } = await import("./focus.js");

function chat(cwdHash: string, id: string, said: string, mtimeSec: number) {
  const dir = path.join(home, ".cursor", "chats", cwdHash, id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "store.db");
  const db = new Database(f);
  db.exec("CREATE TABLE blobs (id TEXT, data BLOB)");
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run("u", Buffer.from(JSON.stringify({ role: "user", content: "task" })));
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run("a", Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text: said }] })));
  db.close();
  fs.utimesSync(f, mtimeSec, mtimeSec);
  return f;
}
const ctx = (sessionId: string) => ({ sessionId, backend: "cursor-agent", cwd: "/w", configDir: "", sinceMs: Date.now() - 60_000 });
const text = (evs: Array<{ text?: string }>) => evs.map((e) => e.text ?? "").join(" ");

test("each cursor terminal reads its own pinned chat, never the chat another terminal wrote last", () => {
  const now = Date.now() / 1000;
  chat("hash-spo18", "sess-18", "SPO-18 scoring pad audit", now);
  chat("hash-spo20", "sess-20", "SPO-20 shipped as PR #35", now - 30);
  assert.match(text(snapshotFocus(ctx("sess-20"))), /SPO-20 shipped/);
  assert.doesNotMatch(text(snapshotFocus(ctx("sess-20"))), /SPO-18/);
  assert.match(text(snapshotFocus(ctx("sess-18"))), /SPO-18/);
});

test("an unpinned cursor session has no transcript rather than a borrowed one", () => {
  assert.deepEqual(snapshotFocus(ctx("legacy-row")), []);
  assert.equal(hasTranscript(ctx("legacy-row")), false);
  assert.equal(hasTranscript(ctx("sess-18")), true);
});

test("the same id under two cwds (resumed elsewhere) reads the chat written last", () => {
  const now = Date.now() / 1000;
  chat("hash-a", "sess-dup", "the real conversation", now);
  chat("hash-b", "sess-dup", "an empty resume", now - 120);
  assert.match(text(snapshotFocus(ctx("sess-dup"))), /real conversation/);
});

test("a workspace with its own CURSOR_CONFIG_DIR reads its chats there, never the operator's ~/.cursor", () => {
  const now = Date.now() / 1000;
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-cursor-client-"));
  chat("hash-personal", "sess-client", "operator's personal chat", now);
  const dir = path.join(clientDir, "chats", "hash-client", "sess-client");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "store.db"));
  db.exec("CREATE TABLE blobs (id TEXT, data BLOB)");
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run("a", Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "client work" }] })));
  db.close();
  const scoped = { ...ctx("sess-client"), cursorConfigDir: clientDir };
  assert.match(text(snapshotFocus(scoped)), /client work/);
  assert.doesNotMatch(text(snapshotFocus(scoped)), /personal chat/);
  assert.equal(hasTranscript({ ...ctx("sess-18"), cursorConfigDir: clientDir }), false);
});

test("cursor polling reads only rows appended after its last rowid", () => {
  const before = focusEfficiencySnapshot().cursor;
  const f = chat("hash-incremental", "sess-inc", "first answer", Date.now() / 1000);
  const first = cursorEventsSince(f, 0);
  assert.match(text(first.events), /first answer/);
  assert.equal(first.cursor, 2);
  assert.equal(first.reset, false);

  const db = new Database(f);
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run("binary", Buffer.from([0xff, 0x00]));
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run("u2", Buffer.from(JSON.stringify({ role: "user", content: "next" })));
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
    "a2",
    Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "**Summary:** second answer" }] })),
  );
  db.close();

  const next = cursorEventsSince(f, first.cursor);
  assert.deepEqual(next.events.map((e) => e.text), ["**Summary:** second answer"]);
  assert.equal(next.cursor, 5, "skipped binary/user rows still advance the cursor");
  assert.deepEqual(cursorEventsSince(f, next.cursor).events, []);
  const after = focusEfficiencySnapshot().cursor;
  assert.equal(after.reads - before.reads, 3);
  assert.equal(after.rows_read - before.rows_read, 5);
  assert.equal(after.historical_rows_skipped - before.historical_rows_skipped, 7);
});

test("cursor polling resets safely when a database is compacted or replaced", () => {
  const f = chat("hash-reset", "sess-reset", "old answer", Date.now() / 1000);
  const old = cursorEventsSince(f, 0);
  const db = new Database(f);
  db.exec("DELETE FROM blobs; VACUUM");
  db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
    "new",
    Buffer.from(JSON.stringify({ role: "assistant", content: "replacement answer" })),
  );
  db.close();

  const replacement = cursorEventsSince(f, old.cursor);
  assert.equal(replacement.reset, true);
  assert.match(text(replacement.events), /replacement answer/);
  assert.equal(replacement.cursor, 1);
});
