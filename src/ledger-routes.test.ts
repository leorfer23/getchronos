/**
 * `/api/ledger` over HTTP (src/ledger-routes.ts): the operator reads every workspace; a workspace
 * token or a project Robert's token reads only its own (a foreign row is a 404, a fleet-wide row is
 * never theirs); no token reads nothing; a decision is recorded only from the operator's hand, only
 * against the target he was shown, and executes nothing.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { CONFIG } from "./config.js";
import { robertToken } from "./authz.js";
import { db, kv, sessions, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import * as L from "./ledger.js";
import { mountLedgerRoutes } from "./ledger-routes.js";

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: "finished its turn" }));
L.setLedgerProgressProvider(() => null);

let server: any;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  const api = express.Router();
  mountLedgerRoutes(api);
  app.use("/api", api);
  await new Promise<void>((ok) => { server = app.listen(0, "127.0.0.1", () => ok()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(() => server?.close?.());

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/lr-${slug}-${Math.random()}` } as any);
const ADMIN = () => ({ "x-mc-admin": CONFIG.adminToken });
const HAND = () => ({ ...ADMIN(), "x-mc-operator": "1" });
async function call(method: string, p: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

type Fx = { A: any; B: any; ra: any; rb: any; parent: any; prItem: any; draftItem: any; askItem: any; prDeliverable: any };
let fx: Fx;
beforeEach(() => {
  db.exec("DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM sessions;");
  L.resetLedgerMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  const A = mkWs("atlas");
  const B = mkWs("cedar");
  // atlas: a terminal opened by hand that handed off a PR to merge, and left a Slack draft.
  const sa = sessions.create({ workspace_id: A.id, cwd: "/tmp", goal: "fix the login redirect", goal_kind: "pr", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: sa.id });
  sessions.setOutcome(sa.id, {
    summary: "redirect loop gone", changes: [], proof: [], prs: ["https://github.com/atlas/api/pull/12"], shots: [], ask: "merge", shipped: [],
    at: new Date(Date.now() + 1000).toISOString(),
  });
  L.onLedgerEvent({ topic: "session.updated", session_id: sa.id });
  L.noteDraft(sa.id, { label: "Slack draft → #ops: it is fixed", tool: { name: "mcp__x__slack_send_message_draft" }, target: { channel: "slack", to: "#ops", hash: "sha256:" + "1".repeat(64) } });
  const ra = requests.get(requests.primaryAt(sa.id)!.request_id)!;
  // cedar: one request of its own, with an open question for the operator.
  const sb = sessions.create({ workspace_id: B.id, cwd: "/tmp", goal: "weekly numbers", goal_kind: "investigation", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: sb.id });
  const rb = requests.get(requests.primaryAt(sb.id)!.request_id)!;
  const askItem = requests.upsertItem({ request_id: rb.id, action: "answer", label: "which week counts?", item_key: "answer|q1", ask_id: "q1" }).item;
  L.recompute(rb.id);
  // A fleet-wide message's own row: the operator's only.
  const parent = requests.create({ workspace_id: null, words: "how is everything going", via: "voice", turn_id: "t-fleet" });
  const items = requests.items(ra.id);
  fx = {
    A, B, ra, rb, parent, askItem,
    prItem: items.find((i) => i.action === "merge"),
    draftItem: items.find((i) => i.action === "send"),
    prDeliverable: requests.deliverables(ra.id).find((d) => d.kind === "pr"),
  };
});

// ── reads and the wall ──────────────────────────────────────────────────────────────────────────

test("the operator reads every workspace's rows, fleet-wide ones included, and can narrow to one", async () => {
  const all = await call("GET", "/ledger?state=all", ADMIN());
  assert.equal(all.status, 200);
  assert.deepEqual(new Set(all.json.map((r: any) => r.id)), new Set([fx.ra.id, fx.rb.id, fx.parent.id]));
  const one = await call("GET", `/ledger?state=all&workspace=${fx.A.slug}`, ADMIN());
  assert.deepEqual(one.json.map((r: any) => r.id), [fx.ra.id]);
  assert.equal((await call("GET", "/ledger?workspace=nope", ADMIN())).status, 404);
  const row = all.json.find((r: any) => r.id === fx.ra.id);
  assert.equal(row.state, "needs_operator");
  assert.equal(row.open_decisions, 2);
  assert.equal(row.title, "fix the login redirect");
  assert.equal(row.workspace.slug, fx.A.slug);
});

test("a workspace token sees only its own workspace — whatever it asks for", async () => {
  const tokA = { "x-mc-workspace-token": fx.A.token };
  const mine = await call("GET", "/ledger?state=all", tokA);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.map((r: any) => r.id), [fx.ra.id]);
  const sneaky = await call("GET", `/ledger?state=all&workspace=${fx.B.id}`, tokA);
  assert.deepEqual(sneaky.json.map((r: any) => r.id), [fx.ra.id], "naming another workspace changes nothing");
  assert.equal((await call("GET", `/ledger/${fx.rb.id}`, tokA)).status, 404, "a foreign row is not found");
  assert.equal((await call("GET", `/ledger/${fx.rb.id.slice(0, 8)}`, tokA)).status, 404, "…by prefix either");
  assert.equal((await call("GET", `/ledger/${fx.parent.id}`, tokA)).status, 404, "a fleet-wide row is never a workspace's");
  const own = await call("GET", `/ledger/${fx.ra.id}`, tokA);
  assert.equal(own.status, 200);
  assert.equal(own.json.decisions.length, 2);
  const queue = await call("GET", "/ledger/queue", tokA);
  assert.deepEqual(queue.json.items.map((i: any) => i.request_id), [fx.ra.id, fx.ra.id]);
  assert.ok(!JSON.stringify(queue.json).includes("which week counts"), "no other workspace's question leaks into the queue");
  const text = await call("GET", "/ledger?format=text", tokA);
  assert.ok(!text.json.text.includes("weekly numbers"));
  assert.ok(text.json.text.includes("fix the login redirect"));
});

test("a project Robert's token (acting or read-only) is his workspace's slice and nothing more", async () => {
  for (const role of ["rw", "ro"] as const) {
    const rob = { "x-mc-admin": robertToken(fx.B.id, role) };
    const rows = await call("GET", "/ledger?state=all", rob);
    assert.equal(rows.status, 200, role);
    assert.deepEqual(rows.json.map((r: any) => r.id), [fx.rb.id], role);
    assert.equal((await call("GET", `/ledger/${fx.ra.id}`, rob)).status, 404, role);
    const q = await call("GET", "/ledger/queue", rob);
    assert.deepEqual(q.json.items.map((i: any) => i.action), ["answer"], role);
  }
});

test("no token, a bad token: no ledger at all", async () => {
  assert.equal((await call("GET", "/ledger")).status, 401, "the tokenless pass older routes allow does not reach the ledger");
  assert.equal((await call("GET", "/ledger/queue")).status, 401);
  assert.equal((await call("GET", `/ledger/${fx.ra.id}`)).status, 401);
  assert.equal((await call("GET", "/ledger", { "x-mc-workspace-token": "f".repeat(48) })).status, 401);
  assert.equal((await call("GET", "/ledger", { "x-mc-admin": "wrong" })).status, 401);
});

test("filters: state, needs a decision, since, the terminal it serves; bad values are refused", async () => {
  const needs = await call("GET", "/ledger?needs=decision&state=all", ADMIN());
  assert.deepEqual(new Set(needs.json.map((r: any) => r.id)), new Set([fx.ra.id, fx.rb.id]), "an open question is a decision he owes too");
  assert.ok(needs.json.every((r: any) => r.state === "needs_operator"));
  assert.ok(!needs.json.some((r: any) => r.id === fx.parent.id));
  const open = await call("GET", "/ledger?state=open", ADMIN());
  assert.ok(open.json.every((r: any) => ["needs_operator", "stuck", "working"].includes(r.state)));
  const terminal = fx.ra && requests.linksFor(fx.ra.id)[0].session_id;
  assert.deepEqual((await call("GET", `/ledger?state=all&session=${terminal}`, ADMIN())).json.map((r: any) => r.id), [fx.ra.id]);
  assert.equal((await call("GET", "/ledger?since=1h&state=all", ADMIN())).json.length, 3);
  assert.equal((await call("GET", "/ledger?since=2999-01-01T00:00:00Z&state=all", ADMIN())).json.length, 0);
  assert.equal((await call("GET", "/ledger?state=bogus", ADMIN())).status, 400);
  assert.equal((await call("GET", "/ledger?since=yesterdayish", ADMIN())).status, 400);
});

test("the audit list: ?ambiguous=1 is the requests whose turn was a guess, and the detail says how each link was decided", async () => {
  const s = sessions.create({ workspace_id: fx.A.id, cwd: "/tmp", goal: "a guessed one", created_by: "robert" } as any);
  requests.link({ request_id: fx.ra.id, session_id: s.id, role: "opened", primary: true, attribution: "recent", ambiguous: true });
  const list = await call("GET", "/ledger?ambiguous=1&state=all", ADMIN());
  assert.deepEqual(list.json.map((r: any) => r.id), [fx.ra.id]);
  const d = (await call("GET", `/ledger/${fx.ra.id}`, ADMIN())).json;
  const t = d.terminals.find((x: any) => x.session_id === s.id);
  assert.deepEqual([t.attribution, t.ambiguous], ["recent", true]);
  assert.equal((await call("GET", "/ledger?ambiguous=1&state=all", { "x-mc-workspace-token": fx.B.token })).json.length, 0, "and only one's own");
});

test("one request in full: terminals, result, deliverables, decisions, checks and the evidence slots of its work type", async () => {
  const d = (await call("GET", `/ledger/${fx.ra.id}`, ADMIN())).json;
  assert.equal(d.work.kind, "pr");
  assert.equal(d.result.length, 1);
  assert.equal(d.result[0].outcome.summary, "redirect loop gone");
  assert.deepEqual(d.deliverables.map((x: any) => x.kind).sort(), ["pr", "slack_draft"]);
  assert.deepEqual(d.checks, []);
  assert.deepEqual(d.expected_checks.map((c: any) => [c.name, c.status]), [["tests", "missing"], ["regression", "missing"], ["goal_test", "missing"], ["pr_ready", "missing"], ["matches_request", "missing"]]);
  assert.equal(d.terminals[0].role, "opened");
});

test("the queue: the operator hears every workspace, in order — bound before unbound, blocked questions first", async () => {
  const q = (await call("GET", "/ledger/queue", ADMIN())).json;
  assert.deepEqual(q.items.map((i: any) => i.action), ["answer", "send", "merge"]);
  assert.equal(q.items[1].bound, true);
  assert.equal(q.items[2].bound, false);
  assert.match(q.items[2].line, /not bound yet/);
  assert.match(q.items[0].line, /^Answer: which week counts\? in cedar$/);
});

// ── decisions ───────────────────────────────────────────────────────────────────────────────────

test("only the operator's hand records a decision", async () => {
  const body = { item: fx.draftItem.id, decision: "yes", target_hash: fx.draftItem.target_hash };
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, { "x-mc-workspace-token": fx.A.token }, body)).status, 403);
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, { "x-mc-admin": robertToken(fx.A.id, "rw"), "x-mc-operator": "1" }, body)).status, 403, "not even his project's Robert");
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, ADMIN(), body)).status, 403, "the admin token alone is not his hand");
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, { ...HAND(), "x-mc-session": "abc" }, body)).status, 403, "an agent header is never his hand");
  assert.equal(requests.item(fx.draftItem.id)!.status, "open", "none of those recorded anything");
});

test("a yes binds to the target he heard: a changed target is refused, an unbound one cannot be approved", async () => {
  const stale = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.draftItem.id, decision: "yes", target_hash: "sha256:" + "2".repeat(64) });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /target changed/);
  assert.equal(stale.json.target_hash, "sha256:" + "1".repeat(64), "it says what the target is now");
  const missing = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.draftItem.id, decision: "yes" });
  assert.equal(missing.status, 409, "a yes that names no target is no yes");
  const unbound = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.prItem.id, decision: "yes" });
  assert.equal(unbound.status, 409);
  assert.match(unbound.json.error, /not bound yet/);
  // The verifier binds the PR head; then the head moves before he answers.
  requests.bindTarget(fx.prDeliverable.id, "a".repeat(40));
  requests.bindTarget(fx.prDeliverable.id, "b".repeat(40));
  const moved = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.prItem.id, decision: "yes", target_hash: "a".repeat(40) });
  assert.equal(moved.status, 409);
  const ok = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.prItem.id, decision: "yes", target_hash: "b".repeat(40), words: "dale", by: "voice", audio_ref: "rec-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.item.status, ok.json.item.decision, ok.json.item.words, ok.json.item.decided_by, ok.json.item.audio_ref], ["decided", "yes", "dale", "voice", "rec-1"]);
  // Recording it executed nothing.
  assert.equal(requests.deliverable(fx.prDeliverable.id)!.state, "open");
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.prItem.id, decision: "no" })).status, 409, "decided once");
});

test("a request owing two needs the item named; an answer item belongs to its ask; bad bodies are refused", async () => {
  const which = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { decision: "later" });
  assert.equal(which.status, 409);
  assert.equal(which.json.items.length, 2);
  const ans = await call("POST", `/ledger/${fx.rb.id}/decision`, HAND(), { decision: "yes" });
  assert.equal(ans.status, 409);
  assert.equal(ans.json.ask_id, "q1");
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { decision: "maybe" })).status, 400);
  assert.equal((await call("POST", `/ledger/nope/decision`, HAND(), { decision: "no" })).status, 404);
  const later = await call("POST", `/ledger/${fx.ra.id}/decision`, HAND(), { item: fx.draftItem.id.slice(0, 8), decision: "later", until: "+1d", words: "mañana" });
  assert.equal(later.status, 200);
  assert.equal(later.json.item.status, "held");
  const q = (await call("GET", "/ledger/queue", ADMIN())).json;
  assert.ok(!q.items.some((i: any) => i.item_id === fx.draftItem.id), "a held item is out of the live queue");
  assert.ok(q.held.some((i: any) => i.item_id === fx.draftItem.id), "…and listed as held");
});

test("closing a request: his hand only; whatever it owed stops being a question", async () => {
  assert.equal((await call("POST", `/ledger/${fx.ra.id}/close`, ADMIN(), {})).status, 403);
  const r = await call("POST", `/ledger/${fx.ra.id}/close`, HAND(), { words: "drop it", by: "voice" });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, "closed");
  assert.match(r.json.state_line, /closed by voice: drop it/);
  assert.ok(requests.items(fx.ra.id).every((i) => i.status === "superseded"));
  assert.equal((await call("GET", "/ledger/queue", ADMIN())).json.items.filter((i: any) => i.request_id === fx.ra.id).length, 0);
});
