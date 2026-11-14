/**
 * The red-team trial end to end over real ledger rows (src/red-team-trial.ts, src/request-verifier.ts):
 * hand-offs filed the way api.ts files them, verifier passes with the world's edges stubbed (the second
 * reader and the red team answer from scripts), and the report read back per workspace.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, jobs, kv, sessions, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { trials } from "./store/trials.js";
import * as L from "./ledger.js";
import * as V from "./request-verifier.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";
import { fileOutcome, normalizeOutcome } from "./session-outcome.js";
import { isReadOnlyRun } from "./runner.js";
import { PROTOCOL, RED_TEAM } from "./red-team.js";
import { noteOperatorTurn, notePaneInput, noteTrialHandoff, redTeamOn, resetTrialMemory, trialProtocol, trialReportView, withFindingClaims } from "./red-team-trial.js";
import { deskSeed } from "./terminal.js";
import type { Session } from "./types.js";

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: null }));
L.setLedgerProgressProvider(() => null);
V.setVerifierDelay(0);

const wt = fs.mkdtempSync(path.join(os.tmpdir(), "red-team-wt-"));
const PASS = 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":true,"crosscheck":true,"assumptions":true}}';
const FINDINGS = 'REDTEAM {"findings":[{"claim":"cohort A counts only manual cancellations, but he asked for every cancellation","why":"the filter keeps manual cancellations","check":"re-run with every cancellation"},{"claim":"the amounts look like cents","check":"compare one row with its invoice"}]}';

type Call = { prompt: string; backend: string; model: string; label: string };
let w: { verdict: string; redteam: string | null; redteamStatus: string; calls: Call[]; told: Array<{ sid: string; text: string }> };

beforeEach(() => {
  db.exec("DELETE FROM trial_handoffs; DELETE FROM request_verifications; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM sessions;");
  L.resetLedgerMemory();
  V.resetVerifierMemory();
  resetTrialMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  w = { verdict: PASS, redteam: FINDINGS, redteamStatus: "success", calls: [], told: [] };
  V.setVerifierDeps({
    review: async (_ws, prompt, o) => {
      w.calls.push({ prompt, backend: o.backend, model: o.model, label: o.label ?? "verify" });
      return o.label === "redteam" ? { text: w.redteam, run_id: `rt-${w.calls.length}`, status: w.redteamStatus } : { text: w.verdict, run_id: `rd-${w.calls.length}`, status: "success" };
    },
    tell: async (sid, text) => { w.told.push({ sid, text }); return null; },
    draftText: async () => null,
  });
});

/** A workspace, with the trial on or off, and one analysis terminal in it (the ledger has opened its request). */
function world(on: boolean, over: { backend?: string; model?: string; review_backend?: string; review_model?: string; goal?: string } = {}) {
  const ws = workspaces.create({ slug: `lab-${Math.random().toString(36).slice(2, 8)}`, name: "lab", config_dir: `/tmp/rt-${Math.random()}` } as any);
  if (over.review_backend) db.prepare("UPDATE workspaces SET review_backend = ?, review_model = ? WHERE id = ?").run(over.review_backend, over.review_model ?? null, ws.id);
  if (on) writeSetting("trial.red_team", true, ws.id);
  _resetSettingsCache();
  const s = sessions.create({ workspace_id: ws.id, cwd: wt, goal: over.goal ?? "how much balance is still held after cancelling", goal_kind: "investigation", created_by: "operator", backend: over.backend ?? "claude-code", model: over.model ?? "opus" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  return { ws: workspaces.get(ws.id)!, s: sessions.get(s.id)! };
}
let tick = 0;
/** `mc outcome`, filed the way POST /sessions/:id/outcome files it (api.ts). Returns the hand-off's time. */
function handOff(s: Session, body: Record<string, unknown>): string {
  const cur = sessions.get(s.id)!;
  const at = new Date(Date.now() + 1000 + tick++ * 1000);
  const o = withFindingClaims(cur, normalizeOutcome(s.id, { ask: "review", ...body }, at));
  const filed = fileOutcome(cur.outcome, cur.outcome_prev, o, null);
  sessions.setOutcome(s.id, filed.latest, filed.earlier);
  noteTrialHandoff(s.id);
  L.syncSession(s.id);
  return o.at;
}
const reqOf = (s: Session) => requests.get(requests.primaryAt(s.id)!.request_id)!;
const latestCheck = (rid: string, name: string) => requests.checks(rid).filter((c) => c.name === name).pop();
const redTeamCalls = () => w.calls.filter((c) => c.label === "redteam");
const chain = (s: Session) => trials.find(RED_TEAM, s.id, reqOf(s).id)!;
const later = (iso: string, s = 1) => new Date(Date.parse(iso) + s * 1000).toISOString();

test("the protocol: only for an analysis terminal, only where the trial is on — the next workspace never gets it", () => {
  const a = world(true).ws;
  const b = world(false).ws;
  assert.equal(redTeamOn(a.id), true);
  assert.equal(redTeamOn(b.id), false, "A's setting is A's alone");
  assert.equal(trialProtocol("investigation", a.id), PROTOCOL);
  assert.equal(trialProtocol("investigation", b.id), null);
  assert.equal(trialProtocol("pr", a.id), null);
  assert.equal(trialProtocol("investigation", null), null, "no workspace, no trial");
});

test("an answer with no figures is never red-teamed: no run, no check, nothing told", async () => {
  const { s } = world(true, { goal: "why did the nightly job fail" });
  handOff(s, { summary: "The nightly cleanup job timed out: the machine was asleep when it fired, and it was killed at the next wake (exit 143)." });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 0);
  assert.equal(latestCheck(r.id, "red_team"), undefined);
  assert.equal(out.ready, true, out.reason ?? "");
  assert.equal(chain(s).red_team, null);
  assert.equal(chain(s).arm, "on");
});

test("an answer with figures: red-teamed once, by another model than the worker's; its findings ride the verifier's own round", async () => {
  const { s } = world(true);
  handOff(s, { summary: "412 accounts still hold $3.2M after cancelling", hypotheses: ["old accounts hold most of it | split by created date | survived"] });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 1);
  const rt = redTeamCalls()[0];
  assert.ok(rt.backend !== "claude-code" || rt.model !== "opus", `not the worker's own engine: ${rt.backend} ${rt.model}`);
  assert.match(rt.prompt, /The figures it states: 412, \$3\.2M/);
  assert.match(rt.prompt, /\[survived\] old accounts hold most of it — test: split by created date/);
  assert.equal(latestCheck(r.id, "red_team")!.status, "fail");
  assert.equal(latestCheck(r.id, "matches_request")!.status, "pass");
  assert.equal(out.ready, false, "not ready while a finding is unanswered");
  assert.equal(w.told.length, 1, "one line typed: the verifier's round");
  assert.match(w.told[0].text, /round 1 of 2/);
  assert.match(w.told[0].text, /red_team F1: cohort A counts only manual cancellations, but he asked for every cancellation — settle it: re-run with every cancellation/);
  assert.match(w.told[0].text, /red_team F2: the amounts look like cents/);

  // Re-filed answering one of the two: judged on its answers — the red team never runs a second time.
  handOff(s, { summary: "431 accounts still hold $3.4M after cancelling", findings: ["F1=fixed: re-ran with every cancellation: 431 accounts, $3.4M"] });
  const out2 = await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 1, "one red-team run per request");
  assert.equal(out2.ready, false);
  assert.match(w.told[1].text, /round 2 of 2/);
  assert.match(w.told[1].text, /does not answer F2/);
  assert.ok(!/F1/.test(w.told[1].text.replace(/"F1=|F1=fixed|F1=holds-not/g, "")), "only what is still open is told");

  // Both answered: ready, and the hand-off carries each finding beside its answer.
  handOff(s, { summary: "431 accounts still hold $3.4M after cancelling", findings: ["F1=fixed: re-ran with every cancellation", "F2=holds-not: amounts are dollars — one row matches its invoice to the cent"] });
  const out3 = await V.verifyRequest(r.id);
  assert.equal(out3.ready, true, out3.reason ?? "");
  assert.equal(w.told.length, 2, "nothing more to tell");
  assert.equal(redTeamCalls().length, 1);
  assert.equal(latestCheck(r.id, "red_team")!.status, "pass");
  const carried = sessions.get(s.id)!.outcome!.findings!;
  assert.deepEqual(carried.map((f) => [f.id, f.resolution, f.claim]), [["F1", "fixed", "cohort A counts only manual cancellations, but he asked for every cancellation"], ["F2", "holds-not", "the amounts look like cents"]]);

  const row = chain(s);
  assert.deepEqual(
    { arm: row.arm, red_team: row.red_team, findings: row.findings, answered: row.answered, changed: row.changed, rounds: row.rounds, rejections: row.rejections, aspects: row.aspects, hypotheses: row.hypotheses, handoffs: row.handoffs, ready: !!row.ready_at },
    { arm: "on", red_team: "ran", findings: 2, answered: 2, changed: 1, rounds: 2, rejections: 0, aspects: { red_team: 2 }, hypotheses: 1, handoffs: 3, ready: true },
  );
});

test("a red team that gives no verdict is spent: skipped, never told, never run again for the request", async () => {
  const { s } = world(true);
  w.redteamStatus = "timeout";
  w.redteam = null;
  handOff(s, { summary: "412 signups last week, up 12%" });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(latestCheck(r.id, "red_team")!.status, "skip");
  assert.equal(out.ready, true, "a skip is no gate");
  assert.equal(w.told.length, 0);
  w.redteamStatus = "success";
  w.redteam = FINDINGS;
  handOff(s, { summary: "415 signups last week, up 13%" });
  await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 1, "the cost guard: one run per request, whatever it came to");
  assert.equal(chain(s).red_team, "skipped");
});

test("the worker's own engine cannot red-team it: not run, nothing spent, nothing told", async () => {
  const { s } = world(true, { backend: "codex", model: "gpt-x", review_backend: "codex", review_model: "gpt-x" });
  handOff(s, { summary: "412 signups last week, up 12%" });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 0);
  assert.match(latestCheck(r.id, "red_team")!.note!, /^not run: the reader is the same engine as the writer/);
  assert.ok(!w.told.some((t) => /red_team/.test(t.text)));
});

test("the trial off: the same analysis runs no red team and is counted in the off arm", async () => {
  const { s } = world(false);
  handOff(s, { summary: "412 accounts still hold $3.2M after cancelling" });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(redTeamCalls().length, 0);
  assert.equal(latestCheck(r.id, "red_team"), undefined);
  assert.equal(out.ready, true, out.reason ?? "");
  const row = chain(s);
  assert.equal(row.arm, "off");
  assert.equal(row.protocol, false);
  assert.ok(row.ready_at);
});

test("his own typed turns after the hand-off are counted — before it, or once the terminal moved on to new work, they are not", async () => {
  const { s } = world(false);
  noteOperatorTurn(s.id); // before any hand-off: steering, not a follow-up
  const at = handOff(s, { summary: "412 signups last week" });
  noteOperatorTurn(s.id, later(at));
  noteOperatorTurn(s.id, later(at, 2));
  assert.equal(chain(s).operator_turns, 2);
  // The terminal takes on another request: what he types now is that request's, not a follow-up to this one.
  const r2 = L.openRequest({ workspace_id: s.workspace_id!, words: "now the weekly churn", via: "typed", kind: "investigation", turn_id: "t-2" });
  requests.closeLink(reqOf(s).id, s.id, later(at, 3));
  requests.link({ request_id: r2.id, session_id: s.id, role: "steer", primary: true, linked_at: later(at, 3), linked_by: "robert" } as any);
  noteOperatorTurn(s.id, later(at, 4));
  assert.equal(trials.list(RED_TEAM, s.workspace_id!, "2000-01-01")[0].operator_turns, 2);
});

test("the pane counts a line sent once the hand-off is in", () => {
  const { s } = world(false);
  const rid = reqOf(s).id;
  trials.open({ trial: RED_TEAM, workspace_id: s.workspace_id!, session_id: s.id, request_id: rid, arm: "off", protocol: false, started_at: "2026-11-10T09:00:00.000Z", handoff_at: "2026-11-10T10:00:00.000Z", hypotheses: 0 });
  notePaneInput(s.id, "\x1b[A");
  notePaneInput(s.id, "\r");
  assert.equal(trials.find(RED_TEAM, s.id, rid)!.operator_turns, 0, "a menu pick is not a turn");
  notePaneInput(s.id, "w");
  notePaneInput(s.id, "hy?\r");
  assert.equal(trials.find(RED_TEAM, s.id, rid)!.operator_turns, 1);
});

test("the report: on vs off for one workspace, counted from its own rows — another workspace's token gets the 404 a missing one gets", async () => {
  // Workspace A, trial on: one analysis red-teamed (2 findings, 1 fixed), one without figures.
  const A = world(true);
  handOff(A.s, { summary: "412 accounts hold $3.2M", hypotheses: ["old accounts | split by age | survived", "a tracking gap | server counts | rejected"] });
  await V.verifyRequest(reqOf(A.s).id);
  const atA = handOff(A.s, { summary: "431 accounts hold $3.4M", findings: ["F1=fixed: every cancellation", "F2=holds-not: dollars, checked"] });
  await V.verifyRequest(reqOf(A.s).id);
  noteOperatorTurn(A.s.id, later(atA));
  const s2 = sessions.create({ workspace_id: A.ws.id, cwd: wt, goal: "why did the job fail", goal_kind: "investigation", created_by: "operator", backend: "claude-code", model: "opus" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s2.id });
  handOff(sessions.get(s2.id)!, { summary: "it timed out while the machine slept" });
  await V.verifyRequest(reqOf(sessions.get(s2.id)!).id);
  // Workspace B, trial off: one analysis sent back once by the verifier's own reader.
  const B = world(false);
  w.verdict = 'VERDICT {"pass":false,"reasons":["cohort definitions are swapped against the request"],"aspects":{"queries":true,"crosscheck":true,"assumptions":true}}';
  const atB = handOff(B.s, { summary: "120 of 52K accounts (0.2%)" });
  await V.verifyRequest(reqOf(B.s).id);
  noteOperatorTurn(B.s.id, later(atB));
  noteOperatorTurn(B.s.id, later(atB, 2));

  const mine = trialReportView({ ws: A.ws.id }, { trial: "red-team" });
  assert.equal(mine.status, 200);
  const body = mine.body as any;
  assert.equal(body.workspaces.length, 1, "a workspace reads its own block only");
  const a = body.workspaces[0];
  assert.equal(a.workspace.id, A.ws.id);
  assert.equal(a.trial_on, true);
  assert.deepEqual(
    { analyses: a.arms.on.analyses, with_hypotheses: a.arms.on.with_hypotheses, rounds: a.arms.on.rounds, rejected: a.arms.on.rejected, aspects: a.arms.on.aspects, red_team: a.arms.on.red_team, operator_turns: a.arms.on.operator_turns, ready: a.arms.on.ready },
    { analyses: 2, with_hypotheses: 1, rounds: 1, rejected: 0, aspects: { red_team: 1 }, red_team: { ran: 1, skipped: 0, findings: 2, answered: 2, changed: 1 }, operator_turns: 1, ready: 2 },
  );
  assert.equal(a.arms.off.analyses, 0, "B's analysis never lands in A's off arm");

  const theirs = trialReportView({ ws: B.ws.id }, { trial: "red_team" }).body as any;
  const b = theirs.workspaces[0];
  assert.equal(b.trial_on, false);
  assert.deepEqual(
    { analyses: b.arms.off.analyses, rounds: b.arms.off.rounds, rejected: b.arms.off.rejected, aspects: b.arms.off.aspects, operator_turns: b.arms.off.operator_turns, ready: b.arms.off.ready, red_team: b.arms.off.red_team.ran },
    { analyses: 1, rounds: 1, rejected: 1, aspects: { matches_request: 1 }, operator_turns: 2, ready: 0, red_team: 0 },
  );
  assert.equal(b.arms.on.analyses, 0);

  assert.equal(trialReportView({ ws: A.ws.id }, { trial: "red-team", workspace: B.ws.slug }).status, 404, "A naming B: the same 404 as no such workspace");
  assert.equal(trialReportView({ ws: A.ws.id }, { trial: "red-team", workspace: "no-such-ws" }).status, 404);
  assert.equal(trialReportView(null, { trial: "red-team" }).status, 401);
  assert.equal(trialReportView({ ws: null }, { trial: "nope" }).status, 404);
  const all = trialReportView({ ws: null }, { trial: "red-team" }).body as any;
  assert.deepEqual(all.workspaces.map((x: any) => x.workspace.id).sort(), [A.ws.id, B.ws.id].sort(), "the operator: every workspace with rows, one block each");
  assert.equal((trialReportView({ ws: null }, { trial: "red-team", workspace: A.ws.slug }).body as any).workspaces[0].arms.on.analyses, 2);
});

test("the red team is a read-only run: dispatched as review:redteam-…, no writes, no commands", async () => {
  const ws = workspaces.create({ slug: `rtr-${Math.random().toString(36).slice(2, 8)}`, name: "redteam", config_dir: `/tmp/rt-${Math.random()}`, sandbox_mode: "off" } as any);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "red-team-reader-"));
  const keepAlive = setInterval(() => {}, 1000);
  const out = await V.defaultVerifierDeps.review(ws, "RED TEAM (read-only). break it", { cwd, backend: "mock", model: "", requestId: "cafebabe-0000", label: "redteam" }).finally(() => clearInterval(keepAlive));
  const job = jobs.list().find((j) => j.workspace_id === ws.id && j.name.startsWith("review:redteam-cafebabe"));
  assert.ok(job, "dispatched under its own name");
  assert.ok(isReadOnlyRun(job!.name), "review: is a read-only run — it never parks on an ask");
  assert.match(job!.disallowed_tools ?? "", /\bEdit\b.*\bWrite\b.*\bBash\b/);
  assert.equal(job!.workspace_id, ws.id, "in the request's own workspace");
  assert.equal(out.status, "success");
});

test("only an analysis terminal in a workspace is counted, and its arm says whether its first prompt carried the protocol", () => {
  const { ws, s } = world(true);
  sessions.setMeta(s.id, { first_prompt: deskSeed("how much is held", "investigation", null, null, null, trialProtocol("investigation", ws.id)) });
  handOff(sessions.get(s.id)!, { summary: "412 accounts hold $3.2M" });
  assert.equal(chain(s).protocol, true);
  assert.equal(chain(s).arm, "on");
  const pr = sessions.create({ workspace_id: ws.id, cwd: wt, goal: "fix the export", goal_kind: "pr", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: pr.id });
  handOff(sessions.get(pr.id)!, { summary: "the export is fixed" });
  assert.equal(trials.hasSession(pr.id), false, "a PR is not an analysis");
  const loose = sessions.create({ workspace_id: null, cwd: wt, goal: "count signups", goal_kind: "investigation", created_by: "operator" } as any);
  handOff(sessions.get(loose.id)!, { summary: "412 signups" });
  assert.equal(trials.hasSession(loose.id), false, "no workspace, no trial");
});
