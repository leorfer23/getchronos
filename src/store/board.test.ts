import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, board, parseMentions } from "../store.js";

beforeEach(() => {
  db.exec("DELETE FROM board_posts;");
});

test("parseMentions: handles, dedup, and non-mentions", () => {
  assert.deepEqual(parseMentions("@robert can you look? cc @Ada and @robert again"), ["robert", "ada"]);
  assert.deepEqual(parseMentions("email leo@example.com at @2pm"), []); // mid-word @ and @digit are not handles
  assert.deepEqual(parseMentions("(@iris)"), ["iris"]);
  assert.deepEqual(parseMentions("no mentions here"), []);
});

test("create parses mentions at write time and stores them as JSON", () => {
  const p = board.create({ author: "iris", body: "@ada please ticket the flaky dedup test" });
  assert.deepEqual(JSON.parse(p.mentions!), ["ada"]);
  assert.equal(board.get(p.id)!.author, "iris");
});

test("a reply to a reply flattens to the root — threads stay two levels deep", () => {
  const root = board.create({ author: "robert", body: "fleet heartbeat", kind: "heartbeat" });
  const r1 = board.create({ author: "ada", body: "on it", thread_root_id: root.id });
  const r2 = board.create({ author: "iris", body: "same", thread_root_id: r1.id });
  assert.equal(r2.thread_root_id, root.id);
  const thread = board.thread(root.id);
  assert.deepEqual(thread.map((p) => p.id), [root.id, r1.id, r2.id]);
});

test("replying to a missing post throws instead of silently orphaning", () => {
  assert.throws(() => board.create({ author: "ada", body: "x", thread_root_id: "nope" }));
});

test("feed bumps a thread on reply and carries reply_count", () => {
  const a = board.create({ author: "nils", body: "infra pass done" });
  const b = board.create({ author: "robert", body: "planning tomorrow" });
  // a is older than b, but a reply to a bumps it above b.
  board.create({ author: "ada", body: "one question", thread_root_id: a.id });
  const feed = board.feed();
  assert.deepEqual(feed.map((p) => p.id), [a.id, b.id]);
  assert.equal(feed[0].reply_count, 1);
  assert.equal(feed[1].reply_count, 0);
});

test("forTicket returns posts cross-linked to the ticket", () => {
  board.create({ author: "robert", body: "unrelated" });
  const p = board.create({ author: "iris", body: "about the gates", ticket_id: "t1" });
  assert.deepEqual(board.forTicket("t1").map((x) => x.id), [p.id]);
});

test("remove deletes the root and its replies", () => {
  const root = board.create({ author: "robert", body: "root" });
  board.create({ author: "ada", body: "reply", thread_root_id: root.id });
  board.remove(root.id);
  assert.equal(board.feed().length, 0);
  assert.equal(board.thread(root.id).length, 0);
});
