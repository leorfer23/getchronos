import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, agentChat, chat, workspaces, quotePrompt, quoteExcerpt } from "./store.js";
import { commitTurn, resolveTurn } from "./thread-router.js";

beforeEach(() => db.exec("DELETE FROM chat_messages; DELETE FROM workspaces;"));

test("add persists an exchange and recent returns it oldest→newest", () => {
  chat.add("hi", "hello");
  chat.add("how are you", "ok", "telegram");
  const rows = chat.recent();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].you, "hi");
  assert.equal(rows[0].reply, "hello");
  assert.equal(rows[0].source, "web");
  assert.equal(rows[1].you, "how are you");
  assert.equal(rows[1].source, "telegram");
  assert.ok(rows[0].id < rows[1].id);
  assert.match(rows[0].created_at, /\d{4}-\d{2}-\d{2}/);
});

test("recent windows to the last N, still chronological", () => {
  for (let i = 0; i < 5; i++) chat.add("q" + i, "a" + i);
  const rows = chat.recent(2);
  assert.deepEqual(rows.map((r) => r.you), ["q3", "q4"]);
});

test("prune keeps only the last N rows", () => {
  for (let i = 0; i < 6; i++) chat.add("q", "a");
  chat.prune(3);
  assert.equal(chat.recent(999).length, 3);
});

test("contextBlock formats shared thread for model continuity", () => {
  chat.add("from phone", "ok telegram", "telegram");
  chat.add("from desk", "ok web", "web");
  const block = chat.contextBlock({ limit: 10 });
  assert.match(block, /Operator.manager thread/);
  assert.match(block, /\[telegram\] Operator: from phone/);
  assert.match(block, /\[web\] Manager: ok web/);
  assert.match(block, /New message from the operator/);
});

test("threads are per workspace — one workspace's rows never leak into another's", () => {
  const acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/ml" });
  chat.add("unscoped", "a");
  chat.add("acme q", "a", "web", acme.id);
  chat.add("globex q", "a", "web", globex.id);

  assert.deepEqual(chat.recent(99, acme.id).map((r) => r.you), ["acme q"]);
  assert.deepEqual(chat.recent(99, globex.id).map((r) => r.you), ["globex q"]);
  assert.deepEqual(chat.recent(99).map((r) => r.you), ["unscoped"]); // null = the unscoped thread
  assert.doesNotMatch(chat.contextBlock({ workspaceId: acme.id }), /globex|unscoped/);
});

test("one thread, N conversations: the router decides the row's workspace and the recaps stay apart", () => {
  const acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/globex" });
  // The operator types into ONE thread. Each message is resolved, then stored under where it landed —
  // which is what keeps a workspace's recap free of every other workspace's turns.
  for (const text of ["#acme the invoice job is red", "and the retry?", "#globex ship the loader", "status"]) {
    const t = resolveTurn(text, { surface: "chat-test" });
    commitTurn("chat-test", t);
    chat.add(t.text, "ok", "web", t.ws);
  }
  // "and the retry?" followed the sticky workspace, not the thread's last workspace on screen.
  assert.deepEqual(chat.recent(99, acme.id).map((r) => r.you), ["the invoice job is red", "and the retry?"]);
  assert.deepEqual(chat.recent(99, globex.id).map((r) => r.you), ["ship the loader"]);
  assert.deepEqual(chat.recent(99, null).map((r) => r.you), ["status"]);
  // The one guarantee: no workspace's context block can contain another's turns.
  const acmeBlock = chat.contextBlock({ workspaceId: acme.id });
  assert.match(acmeBlock, /invoice job is red/);
  assert.doesNotMatch(acmeBlock, /loader|status/);
  assert.doesNotMatch(chat.contextBlock({ workspaceId: globex.id }), /invoice|retry|status/);
  // And every row is still visible in the ONE thread the Desk renders.
  assert.equal(chat.recentAll(99).length, 4);
});

test("divider hides earlier turns from the model but keeps them in the rendered history", () => {
  chat.add("before the line", "old answer");
  chat.divide();
  chat.add("after the line", "new answer");

  const block = chat.contextBlock({ limit: 10 });
  assert.doesNotMatch(block, /before the line/);
  assert.match(block, /after the line/);
  // The UI still gets every row, divider included, so it can draw the "new conversation" line.
  assert.deepEqual(chat.recent(99).map((r) => r.source), ["web", "divider", "web"]);
});

test("an executive's divider is its own thread's, and every row still renders", () => {
  db.exec("DELETE FROM agent_chat");
  agentChat.add("ada", "before", "old");
  agentChat.divide("ada");
  agentChat.add("ada", "after", "new");
  agentChat.add("iris", "unrelated", "a");

  assert.deepEqual(agentChat.recent("ada").map((r) => r.source), ["web", "divider", "web"]);
  // The line belongs to Ada's thread — Iris's context is untouched by it.
  assert.deepEqual(agentChat.recent("iris").map((r) => r.source), ["web"]);
});

test("a divider only cuts its own workspace's context", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  chat.add("scoped history", "a", "web", ws.id);
  chat.divide(); // unscoped thread only
  assert.match(chat.contextBlock({ workspaceId: ws.id }), /scoped history/);
});

test("everywhere recap spans every workspace; only an unscoped divider cuts it", () => {
  const acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/globex" });
  chat.add("before the shop divider", "a");
  chat.divide();
  chat.add("acme invoice", "a", "web", acme.id);
  chat.divide(globex.id); // one project's new conversation
  chat.add("globex retry", "b", "web", globex.id);
  const block = chat.contextBlock({ everywhere: true });
  assert.match(block, /across every workspace/);
  assert.match(block, /acme invoice/);
  assert.match(block, /globex retry/);
  assert.doesNotMatch(block, /before the shop divider/);
});

test("deleting a workspace takes its conversation with it", () => {
  const ws = workspaces.create({ slug: "gone", name: "Gone", config_dir: "/tmp/gone" });
  chat.add("keep me", "a");
  chat.add("delete me", "a", "web", ws.id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
  assert.deepEqual(chat.recent(99).map((r) => r.you), ["keep me"]);
  assert.equal(chat.recent(99, ws.id).length, 0);
});

// ── reply to one bubble ─────────────────────────────────────────────────────────────────────────
test("a reply keeps the parent's id and a one-line excerpt; the words typed stay clean", () => {
  const parent = chat.add("ship it?", "Two options:\n\n1. **merge** now\n2. wait for [CI](https://x.test)");
  const q = chat.quoteOf(parent.id, "reply");
  assert.ok(q);
  assert.equal(q.side, "reply");
  assert.match(q.text, /\*\*merge\*\*/, "quoteOf hands back the whole bubble, markdown and all");
  const r = chat.add("the first one", "merging", "web", null, null, null, q);
  const row = chat.recent(9).find((m) => m.id === r.id);
  assert.equal(row.you, "the first one");
  assert.equal(row.reply_to, parent.id);
  assert.deepEqual(JSON.parse(row.reply_quote), { side: "reply", text: "Two options: merge now wait for CI" });
  // A line that is not a reply carries neither.
  const plain = chat.recent(9).find((m) => m.id === parent.id);
  assert.equal(plain.reply_to, null);
  assert.equal(plain.reply_quote, null);
});

test("quoteOf: the operator's half, and nothing for a gone row, a divider or an empty half", () => {
  const r = chat.add("check the invoice", "done");
  assert.deepEqual(chat.quoteOf(r.id, "you"), { id: r.id, side: "you", text: "check the invoice" });
  const wake = chat.add("", "I restarted the stuck worker", "robert");
  assert.equal(chat.quoteOf(wake.id, "you"), null, "a wake has no operator line");
  assert.equal(chat.quoteOf(chat.divide().id, "reply"), null);
  assert.equal(chat.quoteOf(999999, "reply"), null);
});

test("quotePrompt puts the quoted bubble above the reply, attributed", () => {
  assert.equal(quotePrompt(null), "");
  assert.equal(quotePrompt({ id: 1, side: "reply", text: "Merge now\nor wait?" }), "> Robert: Merge now\n> or wait?\n\n");
  assert.equal(quotePrompt({ id: 1, side: "you", text: "check acme" }), "> Operator: check acme\n\n");
  const long = quotePrompt({ id: 1, side: "reply", text: "x".repeat(5000) });
  assert.ok(long.length < 1600 && long.includes(" …"), "a long answer is cut, and says so");
});

test("quoteExcerpt is one line of words, capped", () => {
  assert.equal(quoteExcerpt("# Title\n> quoted\n- item `code` __b__"), "Title quoted item code b");
  assert.equal(quoteExcerpt("keep snake_case and #slug"), "keep snake_case and #slug");
  const cut = quoteExcerpt("word ".repeat(100));
  assert.ok(cut.length <= 240 && cut.endsWith("…"));
});
