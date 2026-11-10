/**
 * The ledger's rows (migration 156, src/store/requests.ts): every write is an idempotent upsert, a
 * decision moves an item once, a re-bound target voids what was heard before, and a workspace's rows
 * go with it.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces } from "../store.js";
import { requests } from "./requests.js";

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/rq-${slug}-${Math.random()}` } as any);

beforeEach(() => db.exec("DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests;"));

test("a request row: words, how it arrived, work type, prerequisites; list filters and urgency order", () => {
  const atlas = mkWs("atlas");
  const cedar = mkWs("cedar");
  const a = requests.create({ workspace_id: atlas.id, words: "fix the login redirect", via: "voice", surface: "desk", kind: "pr", prereqs: [{ kind: "vpn", source: "workspace" }] });
  assert.equal(a.state, "working");
  assert.equal(a.kind_source, "terminal");
  assert.deepEqual(a.prereqs, [{ kind: "vpn", source: "workspace" }]);
  const b = requests.create({ workspace_id: cedar.id, words: "export numbers for the week", via: "typed" });
  requests.setState(b.id, "needs_operator", "send: Slack draft → #ops");
  const c = requests.create({ workspace_id: atlas.id, words: "old", via: "hand" });
  requests.setState(c.id, "closed", "finished");
  assert.deepEqual(requests.list().map((r) => r.id), [b.id, a.id, c.id], "needs you, then working, then closed");
  assert.deepEqual(requests.list({ workspace_id: atlas.id }).map((r) => r.id), [a.id, c.id]);
  assert.deepEqual(requests.list({ states: ["working", "needs_operator"] }).map((r) => r.id), [b.id, a.id]);
  assert.equal(requests.resolve(a.id.slice(0, 8))?.id, a.id, "id8 resolves");
  assert.equal(requests.resolve("zzzzzzzz"), undefined);
});

test("setState writes only on change; state_at moves with the state, not with a new line", async () => {
  const r = requests.create({ workspace_id: null, words: "x", via: "typed" });
  assert.equal(requests.setState(r.id, "working", null), false, "same state, same line: nothing written");
  assert.equal(requests.setState(r.id, "stuck", "stalled"), true);
  const at = requests.get(r.id)!.state_at;
  await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(requests.setState(r.id, "stuck", "stalled 20m"), false, "a new line under the same state is not a move");
  assert.equal(requests.get(r.id)!.state_at, at);
  assert.equal(requests.get(r.id)!.state_line, "stalled 20m");
});

test("one turn, one row per workspace: the turn index refuses a duplicate", () => {
  const atlas = mkWs("atlas");
  requests.create({ workspace_id: atlas.id, words: "x", via: "typed", turn_id: "t1" });
  assert.throws(() => requests.create({ workspace_id: atlas.id, words: "x", via: "typed", turn_id: "t1" }), /UNIQUE/);
  // The fleet-wide parent (no workspace) is unique per turn too — COALESCE in the index.
  requests.create({ workspace_id: null, words: "x", via: "typed", turn_id: "t1" });
  assert.throws(() => requests.create({ workspace_id: null, words: "x", via: "typed", turn_id: "t1" }), /UNIQUE/);
  assert.equal(requests.byTurn("t1", atlas.id)?.workspace_id, atlas.id);
  assert.equal(requests.byTurn("t1", null)?.workspace_id, null);
});

test("links: idempotent, windows close, the primary at a moment is the one whose window holds it", () => {
  const r1 = requests.create({ workspace_id: null, words: "first", via: "typed" });
  const r2 = requests.create({ workspace_id: null, words: "second", via: "typed" });
  assert.equal(requests.link({ request_id: r1.id, session_id: "s1", role: "opened", primary: true, linked_at: "2026-11-09T10:00:00.000Z" }), true);
  assert.equal(requests.link({ request_id: r1.id, session_id: "s1", role: "steer", primary: false }), false, "an existing link is left as it is");
  assert.equal(requests.linksFor(r1.id)[0].role, "opened");
  requests.closeLink(r1.id, "s1", "2026-11-09T11:00:00.000Z");
  requests.link({ request_id: r2.id, session_id: "s1", role: "steer", primary: true, linked_at: "2026-11-09T11:00:00.000Z" });
  assert.equal(requests.primaryAt("s1")?.request_id, r2.id, "now: the request it serves today");
  assert.equal(requests.primaryAt("s1", "2026-11-09T10:30:00.000Z")?.request_id, r1.id, "then: the one that owned it then");
  assert.equal(requests.primaryAt("s1", "2026-11-09T09:00:00.000Z"), undefined, "before any link");
  assert.deepEqual(requests.linksOfSession("s1", { open: true }).map((l) => l.request_id), [r2.id]);
  assert.equal(requests.linksOfSession("s1")[0].primary, true);
});

test("deliverables and items: upserts are keyed, an item's history is never overwritten", () => {
  const r = requests.create({ workspace_id: null, words: "x", via: "typed" });
  const d1 = requests.upsertDeliverable({ request_id: r.id, kind: "pr", ref: "https://github.com/atlas/api/pull/12", label: "PR #12", source_at: "2026-11-09T10:00:00.000Z" });
  const d2 = requests.upsertDeliverable({ request_id: r.id, kind: "pr", ref: "https://github.com/atlas/api/pull/12", target_hash: "a".repeat(40), source_at: "2026-11-09T09:00:00.000Z" });
  assert.equal(d1.id, d2.id, "same (request, kind, ref) = same deliverable");
  assert.equal(d2.label, "PR #12", "a missing label never erases one");
  assert.equal(d2.target_hash, "a".repeat(40));
  assert.equal(d2.source_at, "2026-11-09T10:00:00.000Z", "source only moves forward");
  const first = requests.upsertItem({ request_id: r.id, action: "merge", label: "PR #12", item_key: "merge|x|1", deliverable_id: d1.id, target_hash: d2.target_hash });
  assert.equal(first.created, true);
  assert.equal(requests.decide(first.item.id, { decision: "yes", words: "dale", by: "voice" })?.status, "decided");
  const again = requests.upsertItem({ request_id: r.id, action: "merge", label: "changed", item_key: "merge|x|1", deliverable_id: d1.id });
  assert.equal(again.created, false);
  assert.equal(again.item.status, "decided", "replaying the same question does not reopen it");
  assert.equal(again.item.label, "PR #12");
  assert.equal(requests.decide(first.item.id, { decision: "no" }), undefined, "a second answer to one item is refused");
});

test("bindTarget re-binds every open item on the deliverable in the same breath", () => {
  const r = requests.create({ workspace_id: null, words: "x", via: "typed" });
  const d = requests.upsertDeliverable({ request_id: r.id, kind: "pr", ref: "https://github.com/atlas/api/pull/7", target_hash: "a".repeat(40) });
  const open = requests.upsertItem({ request_id: r.id, action: "merge", label: "PR #7", item_key: "merge|7|1", deliverable_id: d.id, target_hash: d.target_hash }).item;
  const decided = requests.upsertItem({ request_id: r.id, action: "review", label: "PR #7", item_key: "review|7|1", deliverable_id: d.id, target_hash: d.target_hash }).item;
  requests.decide(decided.id, { decision: "yes" });
  assert.equal(requests.bindTarget(d.id, "b".repeat(40)), 1, "only the open one moves");
  assert.equal(requests.item(open.id)?.target_hash, "b".repeat(40));
  assert.equal(requests.item(decided.id)?.target_hash, "a".repeat(40), "a decided item keeps what he decided on");
  assert.equal(requests.deliverable(d.id)?.target_hash, "b".repeat(40));
});

test("later: held, comes back when due; supersede retires an item once", () => {
  const r = requests.create({ workspace_id: null, words: "x", via: "typed" });
  const it = requests.upsertItem({ request_id: r.id, action: "review", label: "the answer", item_key: "review|a|1" }).item;
  assert.equal(requests.decide(it.id, { decision: "later", hold_until: "2026-11-09T09:00:00.000Z" })?.status, "held");
  assert.deepEqual(requests.holdsDue("2026-11-09T08:00:00.000Z"), []);
  assert.deepEqual(requests.holdsDue("2026-11-09T10:00:00.000Z").map((i) => i.id), [it.id]);
  assert.equal(requests.reopen(it.id), true);
  assert.equal(requests.item(it.id)?.status, "open");
  assert.equal(requests.supersede(it.id, "newer"), true);
  assert.equal(requests.supersede(it.id, "newest"), false);
  assert.equal(requests.item(it.id)?.superseded_by, "newer");
});

test("pending items: open and held, one workspace or all, never another workspace's", () => {
  const atlas = mkWs("atlas");
  const cedar = mkWs("cedar");
  const ra = requests.create({ workspace_id: atlas.id, words: "a", via: "typed" });
  const rc = requests.create({ workspace_id: cedar.id, words: "c", via: "typed" });
  requests.upsertItem({ request_id: ra.id, action: "merge", label: "A", item_key: "k1" });
  requests.upsertItem({ request_id: rc.id, action: "send", label: "C", item_key: "k2" });
  assert.deepEqual(requests.pendingItems(atlas.id).map((i) => i.label), ["A"]);
  assert.deepEqual(requests.pendingItems().map((i) => i.label).sort(), ["A", "C"]);
  // Twins of a deliverable are looked up inside one workspace only.
  requests.upsertDeliverable({ request_id: ra.id, kind: "slack_draft", ref: "slack:#general" });
  requests.upsertDeliverable({ request_id: rc.id, kind: "slack_draft", ref: "slack:#general" });
  assert.equal(requests.deliverablesByRef("slack_draft", "slack:#general", atlas.id).length, 1);
});

test("checks: the verifier's slot holds evidence refs; a workspace's rows go with the workspace", () => {
  const atlas = mkWs("atlas");
  const r = requests.create({ workspace_id: atlas.id, words: "x", via: "typed", kind: "ui" });
  const c = requests.addCheck({
    request_id: r.id, name: "shots", status: "pass", ran_by: "verifier", target_hash: "c".repeat(40),
    evidence: [{ ref: "shot:s1/after-settings-0123456789ab.png", label: "after · settings · phone", meta: { screen: "settings", viewport: 390, side: "after" } }],
  });
  assert.deepEqual(requests.checks(r.id)[0].evidence[0].meta, { screen: "settings", viewport: 390, side: "after" });
  assert.equal(c.ran_by, "verifier");
  requests.link({ request_id: r.id, session_id: "s9", role: "opened", primary: true });
  workspaces.remove(atlas.id);
  assert.equal(workspaces.get(atlas.id), undefined);
  assert.equal(requests.get(r.id), undefined, "cascade: the workspace's requests are gone");
  assert.deepEqual(requests.checks(r.id), []);
  assert.deepEqual(requests.linksOfSession("s9"), []);
});
