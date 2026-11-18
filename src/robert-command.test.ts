/**
 * Command (src/robert-command.ts): the operator's per-workspace grant that lets Robert approve a
 * hand-off in his place — asked of the running API with GitHub and the keyboard faked. Off by default;
 * on, it covers exactly what the grant says, in that workspace only, and never raises itself.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { repos, sessions, workspaces } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const { clearPrOwnershipCache } = await import("./pr-ownership.js");
const { setApprovalDeps } = await import("./card-approval-routes.js");
const { approvalsOf } = await import("./card-approval.js");
const { fleetLine } = await import("./fleet-line.js");
const { writeSetting, setting } = await import("./settings.js");
const { grantCovers, shipGrant, robertApprovalRefusal, commandLine, closesWhenDone } = await import("./robert-command.js");
const { closeRefusal } = await import("./auto-close.js");
const { driveSay } = await import("./robert-drive.js");
const { sweepSay } = await import("./robert-sweep.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); setApprovalDeps(null); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-command-"));
const A = workspaces.create({ slug: `cmd-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `cmd-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
repos.create({ workspace_id: A.id, name: "app", path: path.join(tmp, "app"), git_remote: "https://github.com/acme-co/app.git" } as any);
repos.create({ workspace_id: B.id, name: "site", path: path.join(tmp, "site"), git_remote: "https://github.com/initech-co/site.git" } as any);
clearPrOwnershipCache();

const json = { "content-type": "application/json" };
const robertA = { ...json, "x-mc-admin": robertToken(A.id, "rw", "wake") };
const HEAD = "4f1c2d3a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e";
const pr = (n: number) => `https://github.com/acme-co/app/pull/${n}`;
const PR_B = "https://github.com/initech-co/site/pull/7";

let gh: Record<string, { state: string; head: string | null }> = {};
let typed: Array<{ id: string; text: string; by?: string }> = [];
setApprovalDeps({
  readPr: async (_ws, url) => {
    const v = gh[url];
    if (!v) throw new Error("no such PR");
    return { state: v.state, head: v.head, merge_commit: null };
  },
  type: async (s, text, by) => { typed.push({ id: s.id, text, by }); return null; },
});
beforeEach(() => {
  gh = {}; typed = [];
  writeSetting("robert.ship", "off", A.id);
  writeSetting("robert.ship", "off", B.id);
  writeSetting("robert.close_done", false, A.id);
});

function terminal(ws: string, prs: string[], ask = "merge", over: Record<string, unknown> = {}) {
  const s = sessions.create({ workspace_id: ws, cwd: tmp, goal: "open the rollback PR", ...over } as any);
  const o = { summary: "The rollback is ready.", changes: [], proof: [], prs, shots: [], ask, shipped: [], at: new Date(Date.now() - 60_000).toISOString() };
  sessions.setOutcome(s.id, o as any);
  return { s: sessions.get(s.id)!, o };
}
async function approve(id: string, body: unknown, headers: Record<string, string>) {
  const r = await fetch(`${base}/sessions/${id}/approve`, { method: "POST", headers, body: JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

test("the grant is off until the operator turns it on: Robert is refused, told why, and nothing is typed", async () => {
  const { s, o } = terminal(A.id, [pr(301)]);
  gh[pr(301)] = { state: "OPEN", head: HEAD };
  assert.equal(shipGrant(A.id), "off");
  const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, robertA);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /robert\.ship is off/);
  assert.equal(typed.length, 0);
  assert.equal(approvalsOf(s.id).length, 0);
});

test("with the merge grant, the workspace's Robert approves that PR at GitHub's commit, on record as his", async () => {
  writeSetting("robert.ship", "merge", A.id);
  const { s, o } = terminal(A.id, [pr(302)]);
  gh[pr(302)] = { state: "OPEN", head: HEAD };
  const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, robertA);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(typed.length, 1);
  assert.equal(typed[0].by, "robert");
  assert.match(typed[0].text, /^Approved by Robert, who decides hand-offs for the operator in this workspace \(approval ap-[0-9a-f]{8}/);
  assert.match(typed[0].text, new RegExp(`gh pr merge ${pr(302)} --match-head-commit ${HEAD}`));
  assert.match(typed[0].text, /Don't deploy\./);
  const rec = approvalsOf(s.id).at(-1)!;
  assert.equal(rec.approved_by, "robert");
  assert.equal(rec.prs[0].sha, HEAD);
  const row = fleetLine(A.id).split("\n").find((l) => l.startsWith(`- ${s.id.slice(0, 8)}`)) ?? "";
  assert.match(row, /✓ Robert approved for the operator (just now|\d+m ago): merge PR #302 @4f1c2d3/);
});

test("the merge grant stops at the merge: a deploy, alone or with it, is still the operator's", async () => {
  writeSetting("robert.ship", "merge", A.id);
  const { s, o } = terminal(A.id, [pr(303)], "merge+deploy");
  gh[pr(303)] = { state: "OPEN", head: HEAD };
  for (const kind of ["merge+deploy", "deploy"]) {
    const r = await approve(s.id, { kind, outcome_at: o.at }, robertA);
    assert.equal(r.status, 403, kind);
    assert.match(r.json.error, /hand the deploy up/);
  }
  assert.equal(typed.length, 0);
  writeSetting("robert.ship", "merge+deploy", A.id);
  const ok = await approve(s.id, { kind: "merge+deploy", outcome_at: o.at }, robertA);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.match(typed[0].text, /Then deploy what you merged\./);
});

test("the grant is one workspace's: no other Robert, no fleet-wide or read-only Robert, no agent uses it", async () => {
  writeSetting("robert.ship", "merge+deploy", A.id);
  const { s, o } = terminal(A.id, [pr(304)]);
  gh[pr(304)] = { state: "OPEN", head: HEAD };
  const lead = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
  const tries: Array<[string, Record<string, string>]> = [
    ["B's Robert", { ...json, "x-mc-admin": robertToken(B.id, "rw", "operator") }],
    ["the fleet-wide Robert", { ...json, "x-mc-admin": robertToken(null, "rw", "operator") }],
    ["A's read-only Robert", { ...json, "x-mc-admin": robertToken(A.id, "ro", "operator") }],
    ["A's workspace token", { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token }],
    ["A's Lead", { ...json, "x-mc-lead": sessions.leadToken(lead.id)! }],
    ["A's Robert beside an agent's header", { ...robertA, "x-mc-session": s.id }],
    ["nobody", json],
  ];
  for (const [who, h] of tries) {
    const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, h);
    assert.ok(r.status === 401 || r.status === 403, `${who}: ${r.status}`);
  }
  assert.equal(typed.length, 0);
  // And A's grant says nothing about B's terminals, even to A's Robert.
  const other = terminal(B.id, [PR_B]);
  gh[PR_B] = { state: "OPEN", head: HEAD };
  const cross = await approve(other.s.id, { kind: "merge", outcome_at: other.o.at }, robertA);
  assert.ok(cross.status === 401 || cross.status === 403, `A's Robert on B's terminal: ${cross.status}`);
  assert.equal(typed.length, 0);
});

test("a PR from another workspace on the hand-off refuses the whole approval, grant or not", async () => {
  writeSetting("robert.ship", "merge+deploy", A.id);
  const { s, o } = terminal(A.id, [pr(305), PR_B]);
  gh[pr(305)] = { state: "OPEN", head: HEAD };
  gh[PR_B] = { state: "OPEN", head: HEAD };
  const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, robertA);
  assert.equal(r.status, 403);
  assert.equal(typed.length, 0);
});

test("what a grant never covers: boxed terminals, no hand-off, an open question, a stale card", async () => {
  writeSetting("robert.ship", "merge+deploy", A.id);
  for (const over of [{ created_by: "inbox" }, { created_by: "trigger" }, { created_by: "proactive" }, { created_by: "robert", tagged: true }] as Array<{ created_by: string; tagged?: boolean }>) {
    const { s, o } = terminal(A.id, [pr(306)], "merge", { created_by: over.created_by });
    if (over.tagged) sessions.setMeta(s.id, { tags: ["proactive"] });
    gh[pr(306)] = { state: "OPEN", head: HEAD };
    const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, robertA);
    assert.equal(r.status, 403, JSON.stringify(over));
    assert.match(r.json.error, /always the operator's/);
  }
  const bare = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "no hand-off yet" } as any);
  const none = await approve(bare.id, { kind: "merge" }, robertA);
  assert.equal(none.status, 403);
  assert.match(none.json.error, /has not filed a hand-off/);
  const { s, o } = terminal(A.id, [pr(307)]);
  gh[pr(307)] = { state: "OPEN", head: HEAD };
  assert.match(robertApprovalRefusal(s, "merge", () => 1)!, /open question/);
  // A hand-off newer than the one he looked at is a new question for him too.
  const stale = await approve(s.id, { kind: "merge", outcome_at: new Date(Date.parse(o.at) - 5_000).toISOString() }, robertA);
  assert.equal(stale.status, 409);
  assert.equal(typed.length, 0);
});

test("Robert can never raise his own authority: his credential writes no setting", async () => {
  for (const h of [robertA, { ...json, "x-mc-admin": robertToken(null, "rw", "operator") }]) {
    const r = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ key: "robert.ship", value: "merge+deploy", workspace_id: A.id }) });
    assert.equal(r.status, 403, `ship: ${r.status}`);
    assert.match((await r.json()).error, /operator-only: robert\.ship/);
    const c = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ key: "robert.close_done", value: true, workspace_id: A.id }) });
    assert.equal(c.status, 403, `close_done: ${c.status}`);
  }
  assert.equal(setting("robert.ship", A.id), "off");
  assert.equal(setting("robert.close_done", A.id), false);
  // The operator's own token does.
  const ok = await fetch(`${base}/settings`, { method: "PUT", headers: { ...json, "x-mc-admin": CONFIG.adminToken }, body: JSON.stringify({ key: "robert.ship", value: "merge", workspace_id: A.id }) });
  assert.equal(ok.status, 200);
  assert.equal(shipGrant(A.id), "merge");
  assert.equal(shipGrant(B.id), "off");
  assert.equal(shipGrant(null), "off");
});

test("pure: what each grant covers, and what a wake tells him", () => {
  assert.equal(grantCovers("off", "merge"), false);
  assert.equal(grantCovers("merge", "merge"), true);
  assert.equal(grantCovers("merge", "merge+deploy"), false);
  assert.equal(grantCovers("merge", "deploy"), false);
  assert.equal(grantCovers("merge+deploy", "deploy"), true);
  const { s } = terminal(A.id, [pr(308)]);
  assert.equal(commandLine(s), "");
  const say = (k: "review" | "decide") => driveSay(sessions.get(s.id)!, k, { line: "tests green" }, { result: "PR #308 open", said: null }, "Acme");
  assert.doesNotMatch(say("review"), /YOU HOLD THE OPERATOR'S YES/);
  writeSetting("robert.ship", "merge", A.id);
  assert.match(say("review"), /YOU HOLD THE OPERATOR'S YES HERE/);
  assert.match(say("review"), new RegExp(`mc session approve ${s.id.slice(0, 8)} <merge>`));
  assert.match(say("decide"), /a deploy is still the operator's/);
  writeSetting("robert.ship", "merge+deploy", A.id);
  assert.match(say("review"), /<merge \| merge\+deploy \| deploy>/);
  const boxed = terminal(A.id, [pr(309)], "merge", { created_by: "inbox" });
  assert.equal(commandLine(boxed.s), "");
  assert.doesNotMatch(sweepSay("Acme", 2, 5), /YOU HOLD/);
  assert.match(sweepSay("Acme", 2, 5, "merge+deploy"), /YOU HOLD THE OPERATOR'S YES IN THIS WORKSPACE for merges and deploys/);
});

test("\"Robert closes finished terminals\" makes every terminal in that workspace auto-close, and only there", () => {
  const facts = { live: true, quiet: true, phase: "review" as const, openAsks: 0, liveWorkers: 0, hostOnline: true };
  const row = { auto_close: false, status: "live", cloud_agent_id: null, outcome: null, role: "human", workspace_id: A.id } as any;
  assert.match(closeRefusal(row, facts)!, /auto-close is off/);
  writeSetting("robert.close_done", true, A.id);
  assert.equal(closesWhenDone(row), true);
  assert.equal(closeRefusal(row, facts), null);
  assert.match(closeRefusal({ ...row, workspace_id: B.id }, facts)!, /auto-close is off/);
  // The guards that protect work still hold: a hand-off that waits on a merge is not closed.
  const waits = { ...row, outcome: { summary: "ready", changes: [], ask: "merge", shipped: [], prs: [pr(310)] } };
  assert.match(closeRefusal(waits, facts)!, /asks the operator to merge/);
});
