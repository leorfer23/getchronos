/**
 * The board and the broadcast on the API side (LEADS.md): who may read and move a Lead's plan, whose
 * workers a broadcast can reach, and the `3/7` the Desk draws.
 *
 * The scoping rules are the point. A Lead's credential is not a workspace token: its neighbour Lead
 * sits behind the same wall, and a board that could point at that neighbour's workers would be a way
 * to name — and through /desk to watch — terminals this Lead may not touch.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, leadSlices, sessions, workspaces } from "./store.js";
import { broadcastTargets, deskLeadFields } from "./api.js";
import { BoardAddSchema, BoardPatchSchema, LeadBroadcastSchema, OpenSessionSchema } from "./validation.js";

beforeEach(() => db.exec("DELETE FROM lead_slices; DELETE FROM sessions; DELETE FROM workspaces;"));

let n = 0;
const mkWs = () => workspaces.create({ slug: `board${++n}`, name: "Acme", config_dir: "/tmp/board" + n });
const mkLead = (wsId: string) => sessions.create({ workspace_id: wsId, role: "lead", goal: "ship X", cwd: "/tmp" });
const mkWorker = (wsId: string, leadId: string | null, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, role: "worker", goal: "a slice", cwd: "/tmp", lead_id: leadId, ...over } as any);

// ─────────────────────────────── the schemas ───────────────────────────────

test("BoardPatchSchema: only the five movable fields, and only the five statuses", () => {
  assert.equal(BoardPatchSchema.safeParse({ status: "shipped" }).success, false);
  assert.equal(BoardPatchSchema.safeParse({ status: "review" }).success, true);
  assert.equal(BoardPatchSchema.safeParse({ session_id: null, pr_url: null, note: null }).success, true);
  const parsed = BoardPatchSchema.parse({ status: "done", n: 4, lead_id: "somebody else" } as any);
  assert.deepEqual(parsed, { status: "done" }, "zod drops what a Lead may not set");
  assert.equal(BoardAddSchema.safeParse({ title: "" }).success, false);
  assert.equal(LeadBroadcastSchema.safeParse({ text: "" }).success, false);
});

test("`--slice` reaches the daemon but is never a session column — the Lead's board takes the link", () => {
  const parsed = OpenSessionSchema.parse({ cwd: "/tmp", role: "worker", goal: "g", slice: 3 } as any);
  assert.equal(parsed.slice, 3);
  assert.equal(OpenSessionSchema.safeParse({ cwd: "/tmp", slice: 0 }).success, false);
  assert.equal(OpenSessionSchema.safeParse({ cwd: "/tmp", slice: 1.5 }).success, false);
  // Destructured out of the body before openSession, and only ever honoured for a lead credential.
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  assert.match(api, /const \{ slice, \.\.\.body \} = req\.body \|\| \{\};/);
  assert.match(api, /if \(lead && slice\) leadSlices\.patch\(lead\.leadId, slice, \{ session_id: s\.id, status: "doing" \}\);/);
});

// ─────────────────────────────── the routes' scoping ───────────────────────────────

test("every /leads/me/board route is gated by leadGate and scoped to the Lead's id, not its workspace", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  for (const [verb, route] of [["get", "/leads/me/board"], ["post", "/leads/me/board"], ["patch", "/leads/me/board/:n"]]) {
    const at = api.indexOf(`api.${verb}("${route}"`);
    assert.ok(at > 0, `missing ${verb.toUpperCase()} ${route}`);
    const body = api.slice(at, at + 1200);
    assert.ok(body.includes("leadGate(req, res)"), `${verb} ${route} must go through leadGate`);
    assert.ok(body.includes("lead.leadId"), `${verb} ${route} must scope by the Lead's id`);
    assert.ok(!body.includes("lead.ws"), `${verb} ${route} must NOT widen to the Lead's whole workspace`);
  }
  // The one field that is not the Lead's to say freely.
  const patch = api.slice(api.indexOf('api.patch("/leads/me/board/:n"'));
  assert.ok(patch.includes('sessions.workersOf(lead.leadId)'), "a session_id is resolved against this Lead's own workers");
  assert.ok(patch.includes('"not one of your workers"'));
});

test("Lead A cannot read or move Lead B's board — the store scopes every call by lead_id", () => {
  const ws = mkWs();
  const a = mkLead(ws.id), b = mkLead(ws.id);
  leadSlices.add(a.id, "mine");
  leadSlices.add(b.id, "theirs");
  assert.deepEqual(leadSlices.list(a.id).map((s) => s.title), ["mine"]);
  assert.deepEqual(leadSlices.list(b.id).map((s) => s.title), ["theirs"]);
  // Same number, different Lead: A patching "slice 1" can only ever reach A's own slice 1.
  leadSlices.patch(a.id, 1, { status: "done" });
  assert.equal(leadSlices.get(b.id, 1)!.status, "todo");
});

test("a slice may only point at one of this Lead's own live-or-ended workers", () => {
  const ws = mkWs();
  const a = mkLead(ws.id), b = mkLead(ws.id);
  const mine = mkWorker(ws.id, a.id);
  const theirs = mkWorker(ws.id, b.id);
  const operators = sessions.create({ workspace_id: ws.id, role: "human", cwd: "/tmp" } as any);
  const own = (ref: string) => sessions.workersOf(a.id).find((w) => w.id === ref || w.id.startsWith(ref));
  assert.equal(own(mine.id.slice(0, 8))?.id, mine.id, "by id8 prefix, as the CLI passes it");
  assert.equal(own(theirs.id), undefined, "its neighbour Lead's worker");
  assert.equal(own(operators.id), undefined, "a terminal the operator opened himself");
});

// ─────────────────────────────── broadcast ───────────────────────────────

test("a broadcast reaches every live worker of this Lead, and --only/--except narrow it by id8", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const a = mkWorker(ws.id, lead.id), b = mkWorker(ws.id, lead.id), c = mkWorker(ws.id, lead.id);
  // The ended one is not in the input at all: the route asks for `status: "live"`.
  const live = [a, b, c];

  assert.deepEqual(broadcastTargets(live, {}).map((w) => w.id), [a.id, b.id, c.id]);
  assert.deepEqual(broadcastTargets(live, { only: [a.id.slice(0, 8), c.id.slice(0, 8)] }).map((w) => w.id), [a.id, c.id]);
  assert.deepEqual(broadcastTargets(live, { except: [b.id.slice(0, 8)] }).map((w) => w.id), [a.id, c.id]);
  // `except` is applied after `only`, so naming a worker in both excludes it.
  assert.deepEqual(broadcastTargets(live, { only: [a.id, b.id], except: [b.id] }).map((w) => w.id), [a.id]);
  assert.deepEqual(broadcastTargets(live, { only: ["deadbeef"] }), [], "a ref that matches nothing reaches nobody");
  assert.deepEqual(broadcastTargets(live, { only: ["  ", ""] }).map((w) => w.id), [a.id, b.id, c.id], "blank refs are not a filter");
});

test("one worker's refusal is a line in the result, never the end of the broadcast", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const at = api.indexOf('api.post("/leads/me/broadcast"');
  assert.ok(at > 0);
  const body = api.slice(at, at + 1400);
  assert.ok(body.includes("sessions.workersOf(lead.leadId, { status: \"live\" })"), "its own live workers and nothing else");
  assert.ok(body.includes("sent.push({ id8: w.id.slice(0, 8), ok: !err"), "every worker gets a result line");
  assert.ok(body.includes("BROADCAST_GAP_MS"), "spaced out, or two writes merge into one line");
  assert.ok(body.includes('`lead:${lead.leadId.slice(0, 8)}`'), "typed AS the Lead, which acks that worker's events");
  assert.ok(!body.includes("return res.status(429)"), "a rate-limited worker must not fail the call");
});

// ─────────────────────────────── the Desk figure ───────────────────────────────

test("/desk carries { done, total } on a Lead row, and null for a Lead with no board", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const live = sessions.list({ status: "live" });

  assert.equal(deskLeadFields(live, live).get(lead.id)!.board, null, "no plan and nothing done must not draw the same");

  leadSlices.add(lead.id, "one");
  leadSlices.add(lead.id, "two");
  leadSlices.patch(lead.id, 1, { status: "done" });
  const fields = deskLeadFields(live, live);
  assert.deepEqual(fields.get(lead.id)!.board, { done: 1, total: 2 });
  assert.equal(fields.get(worker.id)!.board, null, "a worker has no board of its own");
});

test("the Desk row draws it quietly, beside the worker count, and hides it without a board", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(html, /<span class="board" hidden><\/span><span class="workers" hidden>/);
  assert.match(html, /bd\.hidden = !\(s\.live && s\.role === "lead" && s\.board && s\.board\.total\);/);
  assert.match(html, /bd\.textContent = s\.board\.done \+ "\/" \+ s\.board\.total;/);
  assert.match(html, /\.row \.side \.board \{[^}]*color:var\(--faint\)/);
});
