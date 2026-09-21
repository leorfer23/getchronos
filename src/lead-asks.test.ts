/**
 * `mc ask-lead` (LEADS.md) — a worker's question goes to its own Lead, and to Robert if that fails.
 *
 * Two of these are security and read like it: a Lead's credential may answer ONLY its own workers'
 * questions (its neighbour's, another workspace's and the operator's own terminals are all refused),
 * and the fallback must fire exactly once however many sweeps reach it — triaging one question twice
 * would put two answers on a terminal that is blocked on the first.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { asks, db, leadEvents, sessions, workspaces } from "./store.js";
import { fallbackAskToRobert, fileAskToLead, leadForSession, leadMayAnswer, mayRouteToLead, setLeadTriageProbe, sweepLeadAsks } from "./lead-asks.js";
import { answerAsk, isAgentAnswer } from "./asks.js";
import { leadEventLines } from "./lead-report.js";
import { resolve } from "./term-status.js";
import { isStopped } from "./robert-drive.js";
import { NewAskSchema } from "./validation.js";

// Handing a question to Robert spawns a manager turn — the seam stands in for it and counts the calls.
let triaged: string[] = [];
beforeEach(() => {
  db.exec("DELETE FROM asks; DELETE FROM lead_events; DELETE FROM sessions; DELETE FROM workspaces;");
  triaged = [];
  setLeadTriageProbe(async (id) => { triaged.push(id); });
});

let n = 0;
const mkWs = () => workspaces.create({ slug: `ask${++n}`, name: "Acme", config_dir: "/tmp/ask" + n });
const mkLead = (wsId: string) => sessions.create({ workspace_id: wsId, role: "lead", goal: "ship X", cwd: "/tmp" });
const mkWorker = (wsId: string, leadId: string | null, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, role: "worker", goal: "the migration", cwd: "/tmp", lead_id: leadId, ...over } as any);
const mkAsk = (s: { id: string; workspace_id: string | null }, route: "lead" | "robert" = "lead") =>
  asks.create({ session_id: s.id, workspace_id: s.workspace_id, route, question: "rebaseline?", options: ["yes", "no"] });

// ─────────────────────────── the route, and what it puts in the inbox ───────────────────────────

test("NewAskSchema accepts the lead route beside operator and robert", () => {
  assert.equal(NewAskSchema.safeParse({ session_id: "s", question: "q", route: "lead" }).success, true);
  assert.equal(NewAskSchema.safeParse({ session_id: "s", question: "q", route: "nobody" }).success, false);
});

test("a lead-routed ask becomes an inbox row with the question, its options and how to answer it", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  fileAskToLead(mkAsk(worker));

  const [ev] = leadEvents.recent(lead.id);
  assert.equal(ev.kind, "ask");
  assert.equal(ev.key, null, "no stop behind it — and a worker asking twice is two questions");
  const p = JSON.parse(ev.payload!);
  assert.equal(p.question, "rebaseline?");
  assert.deepEqual(p.options, ["yes", "no"]);
  assert.equal(p.ask_id8.length, 8);
  assert.equal(p.goal, "the migration");
});

test("a terminal with no live Lead has none to ask — the CLI falls back rather than filing nothing", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const orphan = mkWorker(ws.id, null);
  assert.equal(leadForSession(orphan.id), null);
  fileAskToLead(mkAsk(orphan));
  assert.equal(leadEvents.recent(lead.id).length, 0);

  // …and the same once the Lead is gone.
  const worker = mkWorker(ws.id, lead.id);
  sessions.end(lead.id);
  assert.equal(leadForSession(worker.id), null);
});

// ─────────────────────────── who may answer it ───────────────────────────

test("a Lead may answer only its OWN workers' asks — never a neighbour Lead's, a stranger's, or a run's", () => {
  const ws = mkWs(), other = mkWs();
  const a = mkLead(ws.id), b = mkLead(ws.id);
  const mine = mkWorker(ws.id, a.id);
  const theirs = mkWorker(ws.id, b.id);
  const elsewhere = mkWorker(other.id, null);
  const operators = sessions.create({ workspace_id: ws.id, role: "human", cwd: "/tmp", goal: "scratch" } as any);

  assert.equal(leadMayAnswer(a.id, mkAsk(mine), mine), true);
  assert.equal(leadMayAnswer(a.id, mkAsk(theirs), theirs), false, "its neighbour's worker, behind the same workspace wall");
  assert.equal(leadMayAnswer(a.id, mkAsk(elsewhere), elsewhere), false, "another workspace entirely");
  assert.equal(leadMayAnswer(a.id, mkAsk(operators), operators), false, "a terminal the operator opened himself");
  assert.equal(leadMayAnswer(a.id, { session_id: null, route: "lead", escalated_at: null }, mine), false, "a dispatched run's ask — a Lead owns terminals, not jobs");
  assert.equal(leadMayAnswer(a.id, mkAsk(mine), undefined), false, "a session row that has since gone");
});

test("the answer route checks that ownership before anything else, and records the Lead as the answerer", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const at = api.indexOf('api.post("/asks/:id/answer"');
  assert.ok(at > 0);
  const body = api.slice(at, at + 1400);
  assert.ok(body.includes("leadMayAnswer(lead.leadId"), "a lead credential is checked against the ask's terminal");
  assert.ok(body.includes('res.status(404)'), "and refused as a 404, so ids cannot be probed");
  assert.ok(body.includes('`lead:${lead.leadId.slice(0, 8)}`'), "answered_by names the Lead");
  assert.ok(body.includes("checkScope(req, res, ask.workspace_id)"), "the operator/Robert path is untouched");
});

// ─────────────────────────── the card says whose turn it is ───────────────────────────

test("an open lead ask reads as waiting on its Lead, not on Robert — and counts as stopped", () => {
  const base = {
    live: true, goalDone: false, goal: "g", signals: {}, quiet: true, lastOut: 1, lastIn: null,
    prompt: null, daemonBlock: null, demandInspection: false, narration: null, result: null, now: Date.now(),
  } as any;
  const lead = resolve({ ...base, ask: { question: "rebaseline?", options: [], escalated: false, route: "lead" } });
  assert.equal(lead.phase, "waiting");
  assert.equal(lead.on, "terminal");
  assert.match(lead.line, /^its Lead is deciding: rebaseline\?/);
  // `waiting --on terminal` is a stop: a Lead that never answers still freezes the group, and the
  // daemon has to be able to see that.
  assert.equal(isStopped(lead), true);

  const robert = resolve({ ...base, ask: { question: "rebaseline?", options: [], escalated: false, route: "robert" } });
  assert.equal(robert.on, "robert");
  assert.match(robert.line, /^Robert is deciding: /);
});

// ─────────────────────────── the fallback, exactly once ───────────────────────────

test("an ask its Lead never answered becomes Robert's after the deadline — and only then", async () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const ask = mkAsk(worker);

  await sweepLeadAsks(Date.parse(ask.created_at) + 60_000); // one minute in, well inside the default 10
  assert.equal(asks.get(ask.id)!.route, "lead");
  assert.equal(triaged.length, 0);

  await sweepLeadAsks(Date.parse(ask.created_at) + 11 * 60_000);
  assert.equal(asks.get(ask.id)!.route, "robert", "it IS a Robert ask now — which is what makes it once");
  assert.equal(triaged.length, 1);

  // Every later pass, and a direct second call, find nothing left to re-route.
  await sweepLeadAsks(Date.parse(ask.created_at) + 60 * 60_000);
  assert.equal(await fallbackAskToRobert(ask.id, "again"), false);
  assert.equal(triaged.length, 1);
});

test("a Lead that ends hands its workers' open questions to Robert at once, whatever their age", async () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const ask = mkAsk(worker);
  sessions.end(lead.id);

  await sweepLeadAsks(Date.parse(ask.created_at) + 1000);
  assert.equal(asks.get(ask.id)!.route, "robert");
  assert.equal(triaged.length, 1);
});

test("an answered or cancelled lead ask is never re-routed — nobody is waiting on it", async () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const answered = mkAsk(worker);
  asks.answer(answered.id, "yes", `lead:${lead.id.slice(0, 8)}`);
  const cancelled = mkAsk(worker);
  asks.cancel(cancelled.id);

  await sweepLeadAsks(Date.now() + 60 * 60_000);
  assert.equal(triaged.length, 0);
  assert.equal(asks.get(answered.id)!.route, "lead");
});

test("the daemon sweeps lead asks on the same pass as Robert's own triage deadline", () => {
  const watch = fs.readFileSync(path.join(process.cwd(), "src/desk-watch.ts"), "utf8");
  assert.match(watch, /sweepLeadAsks\(nowMs\)/);
});

// ──────────── a Lead is an AGENT: it may not answer what Robert may not ────────────

test("ask_policy 'escalate': the lead route is refused at creation — no agent decides there", () => {
  const ws = mkWs();
  workspaces.update(ws.id, { ask_policy: "escalate" });
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  assert.equal(leadForSession(worker.id)?.id, lead.id, "it HAS a live Lead…");
  assert.equal(mayRouteToLead(worker.id), false, "…and still may not route to it");

  // The two other reasons are unchanged and independent: no Lead at all, and a Lead that ended.
  const open = mkWs();
  const openLead = mkLead(open.id);
  const openWorker = mkWorker(open.id, openLead.id);
  assert.equal(mayRouteToLead(openWorker.id), true);
  assert.equal(mayRouteToLead(mkWorker(open.id, null).id), false);
  sessions.end(openLead.id);
  assert.equal(mayRouteToLead(openWorker.id), false, "a stale MC_LEAD_ID must not mint a lead ask");
});

test("ask_policy 'escalate': a Lead's answer is refused exactly as Robert's is, and the ask stays open", async () => {
  const ws = mkWs();
  workspaces.update(ws.id, { ask_policy: "escalate" });
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const ask = mkAsk(worker, "robert");

  const asRobert = await answerAsk(ask.id, "go ahead", "robert");
  assert.equal(asRobert.ok, false);
  assert.equal(!asRobert.ok && asRobert.status, 403);

  // The hole: `lead:<id8>` did not match the `by === "robert"` gate, so a Lead could answer here.
  const asLead = await answerAsk(ask.id, "go ahead", `lead:${lead.id.slice(0, 8)}`);
  assert.equal(asLead.ok, false, "a Lead is an agent deciding for the operator, exactly like Robert");
  assert.equal(!asLead.ok && asLead.status, 403);
  assert.equal(asks.get(ask.id)!.status, "open", "refused, not lost — the operator still has it");
  assert.equal(asks.get(ask.id)!.answer, null);

  // A human is never blocked by the policy — that is the whole point of it.
  const human = await answerAsk(ask.id, "go ahead", "leo");
  assert.equal(human.ok, true);
  assert.equal(asks.get(ask.id)!.status, "answered");
});

test("isAgentAnswer names the two agents that decide for the operator, and nothing else", () => {
  assert.equal(isAgentAnswer("robert"), true);
  assert.equal(isAgentAnswer("lead:abcdef01"), true);
  for (const by of ["leo", "human", "telegram", "operator", "leader", "roberta"])
    assert.equal(isAgentAnswer(by), false, by);
});

// ──────────── an ask that has MOVED ON is no longer the Lead's ────────────

test("a Lead may not answer an ask that has moved on — fallen back, --robert, or escalated", () => {
  const ws = mkWs();
  const lead = mkLead(ws.id);
  const worker = mkWorker(ws.id, lead.id);
  const mine = mkAsk(worker);
  assert.equal(leadMayAnswer(lead.id, mine, worker), true, "while it is still the Lead's");

  // The 10-minute fallback flipped it: the operator may be looking at it on his phone by now.
  asks.setRoute(mine.id, "robert");
  assert.equal(leadMayAnswer(lead.id, asks.get(mine.id)!, worker), false);

  // The worker went over its Lead's head on purpose (`mc ask-robert --robert`).
  const overHead = mkAsk(worker, "robert");
  assert.equal(leadMayAnswer(lead.id, overHead, worker), false);

  // Robert handed it up: answering it now would decide something already on the operator's phone.
  const escalated = mkAsk(worker);
  asks.escalate(escalated.id, "needs your call");
  assert.equal(leadMayAnswer(lead.id, asks.get(escalated.id)!, worker), false);
});

test("the inbox line stops offering `mc answer` once the question is not the Lead's to settle", () => {
  const ev = {
    kind: "ask",
    session_id: "abcdef0123456789",
    payload: JSON.stringify({ id8: "abcdef01", goal: "the migration", ask_id8: "11112222", question: "rebaseline?" }),
  };
  const mine = { status: "open", route: "lead", escalated: false };
  assert.deepEqual(leadEventLines(ev, mine).at(-1), '  answer it: mc answer 11112222 "..."');
  assert.deepEqual(leadEventLines(ev, { ...mine, route: "robert" }).at(-1), "  moved on to Robert — not yours to answer");
  assert.deepEqual(leadEventLines(ev, { ...mine, escalated: true }).at(-1), "  moved on to Robert — not yours to answer");
  assert.deepEqual(leadEventLines(ev, { ...mine, status: "answered" }).at(-1), "  already answered — nothing for you to do");
  assert.deepEqual(leadEventLines(ev, { ...mine, status: "cancelled" }).at(-1), "  already cancelled — nothing for you to do");
  // An ask row whose ask has been pruned away renders without pretending to know its state.
  assert.deepEqual(leadEventLines(ev, null).at(-1), '  answer it: mc answer 11112222 "..."');
});

test("the ask route earns `lead` from the daemon, and mc says so when it did not get it", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  assert.match(api, /req\.body\.route === "lead" && !mayRouteToLead\(sess\.id\) \? fallback/);
  const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
  assert.match(mc, /if \(toLead && a\.route !== "lead"\)/);
});

test("GET /leads/me/events/wait cancels on req close — safe only because it is a bodiless GET", () => {
  // A POST long-poll must use res.on("close") + !res.writableEnded: req "close" fires as soon as
  // the body has been read, which abandoned every parked POST the day we tried it.
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const at = api.indexOf('api.get("/leads/me/events/wait"');
  assert.ok(at > 0);
  const body = api.slice(at, at + 900);
  assert.match(body, /req\.on\("close", waiter\.cancel\)/);
  assert.match(body, /bodiless GET|GET without a body|GET — on a route with a body/i);
});
