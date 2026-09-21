import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, board } from "./store.js";
import { bus } from "./bus.js";
import {
  BOARD_WAKE_MAX_DEPTH,
  frameBoardWake,
  mentionedExecs,
  postToBoard,
  setBoardAsker,
  startBoardWatcher,
} from "./board.js";

// startBoardWatcher subscribes once per process; tests share the subscription.
let watcherUp = false;
beforeEach(() => {
  db.exec("DELETE FROM board_posts; DELETE FROM tickets; DELETE FROM workspaces;");
  if (!watcherUp) {
    startBoardWatcher();
    watcherUp = true;
  }
});
afterEach(() => setBoardAsker(null));

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

test("mentionedExecs resolves the live handle, drops unknowns and the author", () => {
  assert.deepEqual(mentionedExecs(["robert", "nobody"], "operator"), ["robert"]);
  assert.deepEqual(mentionedExecs(["robert"], "robert"), []);
});

// The point of the retirement: the old handles are not re-pointed at Robert, they resolve to nobody.
test("retired handles wake no one — @ada, @nils, @iris and @vega are dead letters", () => {
  for (const h of ["ada", "nils", "nils", "iris", "iris", "vega"])
    assert.deepEqual(mentionedExecs([h], "operator"), [], `@${h} must resolve to nobody`);
  // Mixed in with a live handle, only Robert survives — the post is not dropped, the ghosts are.
  assert.deepEqual(mentionedExecs(["ada", "robert", "iris"], "operator"), ["robert"]);
});

test("a mention wakes the executive and their reply lands in the thread", async () => {
  const asked: string[] = [];
  setBoardAsker(async (execId, text) => {
    asked.push(execId);
    assert.match(text, /NEW POST by operator/);
    return "On it — ticketed.";
  });
  const root = postToBoard({ author: "operator", body: "@robert please triage the export bug" });
  await settle();
  assert.deepEqual(asked, ["robert"]);
  const thread = board.thread(root.id);
  assert.equal(thread.length, 2);
  assert.equal(thread[1].author, "robert");
  assert.equal(thread[1].body, "On it — ticketed.");
});

// With one executive the old ping-pong (ada → iris → ada …) can no longer form at all: the
// only handle left belongs to the only author, and mentionedExecs drops the author. Both halves of
// that are worth pinning — the self-mention below, and the depth cap here, which is still the guard
// that stops a chain if a second executive ever comes back.
test("wake chains stop at BOARD_WAKE_MAX_DEPTH", async () => {
  let wakes = 0;
  setBoardAsker(async () => {
    wakes++;
    return "";
  });
  postToBoard({ author: "operator", body: "@robert one below the cap", depth: BOARD_WAKE_MAX_DEPTH - 1 });
  await settle();
  assert.equal(wakes, 1);
  postToBoard({ author: "operator", body: "@robert at the cap", depth: BOARD_WAKE_MAX_DEPTH });
  await settle();
  assert.equal(wakes, 1); // unchanged: a post at the cap wakes nobody
});

test("a reply that mentions the only executive cannot chain — he is his own author", async () => {
  let wakes = 0;
  setBoardAsker(async () => {
    wakes++;
    return "@robert and again"; // would ping-pong forever if the author check were dropped
  });
  postToBoard({ author: "operator", body: "@robert kick it off" });
  await settle();
  assert.equal(wakes, 1);
});

test("an asker error posts a capped-depth warning into the thread and wakes nobody", async () => {
  let wakes = 0;
  setBoardAsker(async () => {
    wakes++;
    throw new Error("backend down @robert"); // a handle in the error must not re-wake
  });
  const root = postToBoard({ author: "operator", body: "@robert thoughts?" });
  await settle();
  assert.equal(wakes, 1);
  const thread = board.thread(root.id);
  assert.equal(thread.length, 2);
  assert.match(thread[1].body, /⚠️ robert hit an error/);
});

test("the author's own reply never wakes themselves", async () => {
  let wakes = 0;
  setBoardAsker(async () => {
    wakes++;
    return "noted";
  });
  postToBoard({ author: "robert", body: "@robert note to self" });
  await settle();
  assert.equal(wakes, 0);
});

test("frameBoardWake includes the thread and flags the operator vs a peer", () => {
  const root = board.create({ author: "operator", body: "@robert dig into this" });
  const framed = frameBoardWake("robert", root, board.thread(root.id));
  assert.match(framed, /You are Robert/);
  assert.match(framed, /the operator mentioned you/);
  // "peer" is unreachable in practice with one executive, but the branch is still live: a worker or
  // any non-operator author takes it, and it is what a returning second executive would land on.
  const reply = board.create({ author: "worker", body: "@robert ping", thread_root_id: root.id });
  const framed2 = frameBoardWake("robert", reply, board.thread(root.id));
  assert.match(framed2, /Your peer worker mentioned you/);
  assert.match(framed2, /THREAD SO FAR:\n\[operator\] @robert dig into this/);
});

test("board.posted carries parsed mentions and depth for downstream consumers", async () => {
  const seen: any[] = [];
  const listener = (e: any) => e.topic === "board.posted" && seen.push(e);
  bus.on("event", listener);
  try {
    setBoardAsker(async () => "");
    postToBoard({ author: "operator", body: "@robert check the gate" });
    await settle();
    assert.equal(seen.length, 1); // empty reply → no second post
    assert.deepEqual(seen[0].mentions, ["robert"]);
    assert.equal(seen[0].depth, 0);
  } finally {
    bus.removeListener("event", listener);
  }
});
