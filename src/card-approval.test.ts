/**
 * The operator's yes on a hand-off card, bound to what it covers (src/card-approval.ts and
 * src/card-approval-routes.ts) — asked of the running API with GitHub and the terminal's keyboard faked:
 * the line names the PR and the exact commit, a head that moved is never typed as a merge, Robert sees
 * what was approved, and nothing crosses from one workspace into another.
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
const { repos, sessionPrs, sessions, workspaces } = await import("./store.js");
const { requests } = await import("./store/requests.js");
const { robertToken } = await import("./authz.js");
const { clearPrOwnershipCache } = await import("./pr-ownership.js");
const { setApprovalDeps } = await import("./card-approval-routes.js");
const { approvalLine, approvalsOf } = await import("./card-approval.js");
const { fleetLine } = await import("./fleet-line.js");
const { agentPrompt } = await import("./agent-defs.js");
const { bus } = await import("./bus.js");
const { setLedgerPhaseProvider } = await import("./ledger.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); setApprovalDeps(null); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approve-"));
const A = workspaces.create({ slug: `ap-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `ap-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
repos.create({ workspace_id: A.id, name: "app", path: path.join(tmp, "app"), git_remote: "https://github.com/acme-co/app.git" } as any);
repos.create({ workspace_id: B.id, name: "site", path: path.join(tmp, "site"), git_remote: "https://github.com/initech-co/site.git" } as any);
clearPrOwnershipCache();

const json = { "content-type": "application/json" };
/** The operator's own hand: his token, from this Mac, with the header only his surfaces send. */
const hand = { ...json, "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1" };
const HEAD = "4f1c2d3a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e";
const NEWER = "abc1234def56789000000000000000000000beef";
const pr = (n: number) => `https://github.com/acme-co/app/pull/${n}`;
const PR_B = "https://github.com/initech-co/site/pull/7";

// GitHub and the keyboard, faked: what each PR is now, every read made (and under whose workspace), every line typed.
let gh: Record<string, { state: string; head: string | null; merge_commit?: string | null } | Error> = {};
let reads: Array<{ ws: string | null; url: string }> = [];
let typed: Array<{ id: string; text: string }> = [];
setApprovalDeps({
  readPr: async (ws, url) => {
    reads.push({ ws: ws?.id ?? null, url });
    const v = gh[url];
    if (!v) throw new Error("no such PR");
    if (v instanceof Error) throw v;
    return { state: v.state, head: v.head, merge_commit: v.merge_commit ?? null };
  },
  type: async (s, text) => { typed.push({ id: s.id, text }); return null; },
});
beforeEach(() => { gh = {}; reads = []; typed = []; });

/** A live terminal in `ws` whose newest hand-off names `prs`. */
function terminal(ws: string, prs: string[], ask = "merge") {
  const s = sessions.create({ workspace_id: ws, cwd: tmp, goal: "open the rollback PR" } as any);
  const o = { summary: "The rollback is ready.", changes: [], proof: [], prs, shots: [], ask, shipped: [], at: new Date(Date.now() - 60_000).toISOString() };
  sessions.setOutcome(s.id, o as any);
  return { s: sessions.get(s.id)!, o };
}
/** The request that owns that hand-off in the ledger, with a merge item on the PR (bound to `hash`, or not yet). */
function ledgerFor(s: { id: string; workspace_id: string | null }, o: { at: string }, url: string, hash: string | null) {
  const r = requests.create({ workspace_id: s.workspace_id, words: "open the rollback PR", via: "hand" } as any);
  requests.link({ request_id: r.id, session_id: s.id, role: "opened", primary: true, linked_at: new Date(Date.now() - 3_600_000).toISOString() });
  const d = requests.upsertDeliverable({ request_id: r.id, session_id: s.id, kind: "pr", ref: url, label: "the PR", target_hash: hash, source_at: o.at });
  const { item } = requests.upsertItem({ request_id: r.id, action: "merge", label: "the PR", item_key: `merge|${d.id}|${o.at}`, deliverable_id: d.id, target_hash: hash, source_at: o.at });
  return { r, d, item };
}
async function approve(id: string, body: unknown, headers: Record<string, string> = hand) {
  const r = await fetch(`${base}/sessions/${id}/approve`, { method: "POST", headers, body: JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

test("the line names the PR, the exact commit and who approved it — only that PR, though the terminal opened others", async () => {
  const { s, o } = terminal(A.id, [pr(200)]);
  sessionPrs.record({ url: pr(198), session_id: s.id, workspace_id: A.id, cwd: tmp }); // shipped earlier in its life
  gh[pr(200)] = { state: "OPEN", head: HEAD };
  const seen: any[] = [];
  const onEvent = (e: any) => { if (e.topic === "session.approval") seen.push(e); };
  bus.on("event", onEvent);
  const r = await approve(s.id, { kind: "merge", outcome_at: o.at, surface: "desk" });
  bus.off("event", onEvent);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(typed.map((t) => t.id), [s.id], "one line, into that terminal only");
  const line = typed[0].text;
  assert.match(line, /^Approved by the operator on the Desk card \(approval ap-[0-9a-f]{8}, for your hand-off of /);
  assert.ok(line.includes(`PR #200 (${pr(200)}) at head 4f1c2d3`), line);
  assert.ok(line.includes(`--match-head-commit ${HEAD}`), "the command GitHub refuses on any other commit");
  assert.match(line, /If its head is no longer 4f1c2d3, do not merge: file a fresh `mc outcome` for the new head/);
  assert.match(line, /Don't deploy\./);
  assert.ok(line.includes('`mc outcome --shipped "merged #200"`'));
  assert.doesNotMatch(line, /#198/, "the PR it shipped earlier is not what he approved");
  assert.deepEqual(reads, [{ ws: A.id, url: pr(200) }], "the head is read under the terminal's own workspace");
  // The record: who, where, what, which commit, when, which hand-off.
  const [a] = approvalsOf(s.id);
  assert.equal(a.id, r.json.approval.id);
  assert.ok(line.includes(a.id), "the transcript points at the record");
  assert.deepEqual(
    { by: a.approved_by, surface: a.surface, kind: a.kind, outcome_at: a.outcome_at, ws: a.workspace_id, prs: a.prs },
    { by: "operator", surface: "desk", kind: "merge", outcome_at: o.at, ws: A.id, prs: [{ url: pr(200), repo: "acme-co/app", num: 200, sha: HEAD, state: "open" }] },
  );
  assert.ok(Math.abs(Date.parse(a.at) - Date.now()) < 60_000);
  assert.deepEqual(seen.map((e) => [e.result, e.approval_id, e.workspace_id, e.prs[0].sha]), [["approved", a.id, A.id, HEAD]], "the activity trail keeps it");
});

test("Robert sees it: FLEET NOW marks the terminal, GET /approvals answers its workspace and its Robert — and no one else", async () => {
  const { s, o } = terminal(A.id, [pr(201)]);
  gh[pr(201)] = { state: "OPEN", head: HEAD };
  assert.equal((await approve(s.id, { kind: "merge", outcome_at: o.at })).status, 200);
  const row = fleetLine(A.id).split("\n").find((l) => l.startsWith(`- ${s.id.slice(0, 8)}`)) ?? "";
  assert.match(row, /✓ the operator approved on the Desk card (just now|\d+m ago): merge PR #201 @4f1c2d3 \(ap-[0-9a-f]{8}\)/);
  assert.doesNotMatch(fleetLine(B.id), /PR #201/, "another workspace's Robert never sees it");
  assert.doesNotMatch(fleetLine(null), /PR #201/, "the fleet-wide view stays counts only");
  const lead = sessions.create({ workspace_id: B.id, role: "lead", cwd: tmp } as any);
  const tries: Array<[string, Record<string, string>, number]> = [
    ["the operator", hand, 200],
    ["A's workspace token", { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token }, 200],
    ["A's Robert", { ...json, "x-mc-admin": robertToken(A.id, "rw", "wake") }, 200],
    ["B's workspace token", { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token }, 404],
    ["B's Robert", { ...json, "x-mc-admin": robertToken(B.id, "rw", "operator") }, 404],
    ["B's Lead", { ...json, "x-mc-lead": sessions.leadToken(lead.id)! }, 404],
  ];
  for (const [who, h, want] of tries) {
    const r = await fetch(`${base}/sessions/${s.id}/approvals`, { headers: h });
    assert.ok(want === 200 ? r.status === 200 : r.status === 404 || r.status === 401 || r.status === 403, `${who}: ${r.status}`);
    if (want === 200) assert.equal((await r.json()).approvals[0].prs[0].sha, HEAD, who);
  }
  // His prompt, on both surfaces, says what that mark means.
  for (const surface of ["web", "telegram"]) {
    const p = agentPrompt("robert", surface);
    assert.match(p, /THE OPERATOR'S CARD APPROVALS ARE HIS DECISION/, surface);
    assert.match(p, /Never countermand it/, surface);
    assert.match(p, /GET \/api\/sessions\/<id>\/approvals/, surface);
  }
});

test("the ledger hears it: the PR's merge item is decided yes on the approved commit, and the request lists the approval", async (t) => {
  const { s, o } = terminal(A.id, [pr(202)]);
  const { r, item } = ledgerFor(s, o, pr(202), null); // the verifier has not bound it yet
  gh[pr(202)] = { state: "OPEN", head: HEAD };
  // Its terminal is waiting on CI before it merges — the moment the incident's Robert read it.
  setLedgerPhaseProvider((id) => (id === s.id ? { phase: "waiting", line: "PR #202 last check, then merge" } : null));
  t.after(() => setLedgerPhaseProvider(null));
  const res = await approve(s.id, { kind: "merge", outcome_at: o.at });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const it = requests.item(item.id)!;
  assert.deepEqual({ status: it.status, decision: it.decision, hash: it.target_hash, by: it.decided_by }, { status: "decided", decision: "yes", hash: HEAD, by: "desk" });
  assert.match(it.words ?? "", /approved on the Desk card \(ap-[0-9a-f]{8}\): merge PR #202 at 4f1c2d3/);
  assert.deepEqual(res.json.approval.ledger, { request_id: r.id, item_ids: [item.id] });
  const det = await (await fetch(`${base}/ledger/${r.id}`, { headers: hand })).json();
  assert.deepEqual(det.approvals.map((a: any) => [a.id, a.prs[0].sha]), [[res.json.approval.id, HEAD]]);
  // The compact ledger his Robert reads says it on that request's line — and another workspace's never does.
  const text = async (h: Record<string, string>) => (await (await fetch(`${base}/ledger?format=text`, { headers: h })).json()).text as string;
  const mine = await text({ ...json, "x-mc-admin": robertToken(A.id, "rw", "operator") });
  assert.match(mine, /✓ he approved merge PR #202 @4f1c2d3 on its card/);
  assert.doesNotMatch(await text({ ...json, "x-mc-admin": robertToken(B.id, "rw", "operator") }), /PR #202/);
});

test("a head that moved since it was put to him is never typed as a merge: the terminal is told to hand off again", async () => {
  const { s, o } = terminal(A.id, [pr(203)]);
  const { r, item } = ledgerFor(s, o, pr(203), HEAD); // the phone's card showed 4f1c2d3, verified
  gh[pr(203)] = { state: "OPEN", head: NEWER };        // a push since
  const res = await approve(s.id, { kind: "merge", outcome_at: o.at, surface: "phone", ledger: { request: r.id, item: item.id } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json.moved, [{ num: 203, url: pr(203), was: HEAD, now: NEWER }]);
  assert.equal(res.json.told, true);
  assert.equal(typed.length, 1);
  assert.match(typed[0].text, /^Not approved yet: .*PR #203 was put to him at 4f1c2d3 and GitHub has abc1234 now\. Do not merge or deploy it\. File a fresh `mc outcome`/);
  assert.doesNotMatch(typed[0].text, /gh pr merge|Approved by|--match-head-commit/, "no merge instruction of any kind");
  assert.deepEqual(approvalsOf(s.id), [], "nothing recorded as approved");
  assert.equal(requests.item(item.id)!.status, "open", "the ledger still asks him");
  // The head back where he saw it: approved, bound to that commit, said where he approved it.
  gh[pr(203)] = { state: "OPEN", head: HEAD };
  typed = [];
  const ok = await approve(s.id, { kind: "merge", outcome_at: o.at, surface: "phone", ledger: { request: r.id, item: item.id } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(typed[0].text.includes(`--match-head-commit ${HEAD}`));
  assert.match(typed[0].text, /^Approved by the operator on the phone's card/);
});

test("a card no longer on top, a PR already merged, or GitHub out of reach: nothing typed, nothing recorded", async () => {
  const { s, o } = terminal(A.id, [pr(204)]);
  gh[pr(204)] = { state: "OPEN", head: HEAD };
  const stale = await approve(s.id, { kind: "merge", outcome_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /newer hand-off/);
  gh[pr(204)] = { state: "MERGED", head: HEAD, merge_commit: "f".repeat(40) };
  const merged = await approve(s.id, { kind: "merge", outcome_at: o.at });
  assert.equal(merged.status, 409);
  assert.match(merged.json.error, /nothing left to merge: PR #204 is merged/);
  gh[pr(204)] = new Error("could not resolve host");
  const down = await approve(s.id, { kind: "merge", outcome_at: o.at });
  assert.equal(down.status, 502);
  assert.match(down.json.error, /could not read PR #204 on GitHub/);
  const wrong = await approve(s.id, { kind: "deploy", outcome_at: o.at });
  assert.equal(wrong.status, 409, "its hand-off asked for a merge, not a deploy");
  assert.equal(typed.length, 0);
  assert.deepEqual(approvalsOf(s.id), []);
});

test("no hand-off filed: its one open PR is the card; with several open, nothing is guessed", async () => {
  const s = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "fix the login bug" } as any);
  sessionPrs.record({ url: pr(205), session_id: s.id, workspace_id: A.id, cwd: tmp });
  gh[pr(205)] = { state: "OPEN", head: HEAD };
  const one = await approve(s.id, { kind: "merge", outcome_at: null });
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.equal(one.json.approval.outcome_at, null);
  assert.ok(typed[0].text.includes(`PR #205 (${pr(205)}) at head 4f1c2d3`));
  sessionPrs.record({ url: pr(206), session_id: s.id, workspace_id: A.id, cwd: tmp });
  typed = [];
  const two = await approve(s.id, { kind: "merge", outcome_at: null });
  assert.equal(two.status, 409);
  assert.match(two.json.error, /2 open PRs and no hand-off naming one/);
  assert.equal(typed.length, 0);
});

test("merge + deploy keeps the deploy, merge keeps \"Don't deploy\", deploy approves only the deploy its hand-off asked for", async () => {
  const { s, o } = terminal(A.id, [pr(207)]);
  gh[pr(207)] = { state: "OPEN", head: HEAD };
  assert.equal((await approve(s.id, { kind: "merge+deploy", outcome_at: o.at })).status, 200, "the operator may widen a merge ask to merge + deploy");
  const md = typed[0].text;
  assert.match(md, /Then deploy what you merged\./);
  assert.match(md, /do not merge or deploy/);
  assert.doesNotMatch(md, /Don't deploy/);
  assert.ok(md.includes('`mc outcome --shipped "merged #207" --shipped "deployed"`'));
  // Deploy only, after the merge: the hand-off asked for it, and its PR is named with what it merged as.
  const { s: s2, o: o2 } = terminal(A.id, [pr(208)], "deploy");
  gh[pr(208)] = { state: "MERGED", head: HEAD, merge_commit: "f".repeat(40) };
  typed = [];
  assert.equal((await approve(s2.id, { kind: "deploy", outcome_at: o2.at })).status, 200);
  assert.match(typed[0].text, /deploy it — the deploy that hand-off asks for \(PR #208, merged as fffffff\), nothing more\. Then run `mc outcome --shipped "deployed"`\./);
  assert.doesNotMatch(typed[0].text, /gh pr merge/);
  // Two PRs on one hand-off: each with its own commit.
  const two = approvalLine({
    id: "ap-0000abcd", session_id: "s", workspace_id: "w", outcome_at: null, kind: "merge", approved_by: "operator", surface: "desk", at: new Date().toISOString(), ledger: null,
    prs: [{ url: pr(1), repo: "acme-co/app", num: 1, sha: HEAD, state: "open" }, { url: pr(2), repo: "acme-co/app", num: 2, sha: NEWER, state: "open" }],
  });
  assert.ok(two.includes(`gh pr merge ${pr(1)} --match-head-commit ${HEAD}`) && two.includes(`gh pr merge ${pr(2)} --match-head-commit ${NEWER}`));
  assert.match(two, /If any head is no longer the commit named here, do not merge that PR/);
  assert.ok(two.includes('--shipped "merged #1" --shipped "merged #2"'));
});

test("a cross-workspace approval is refused: another workspace's request item, or a PR of another workspace's repo", async () => {
  const { s: sA, o: oA } = terminal(A.id, [pr(209)]);
  const { s: sB, o: oB } = terminal(B.id, [PR_B]);
  const { r: rB, item: iB } = ledgerFor(sB, oB, PR_B, null);
  gh[pr(209)] = { state: "OPEN", head: HEAD };
  gh[PR_B] = { state: "OPEN", head: HEAD };
  // A's terminal, B's request item: the same 404 an item that does not exist gets.
  const cross = await approve(sA.id, { kind: "merge", outcome_at: oA.at, ledger: { request: rB.id, item: iB.id } });
  assert.equal(cross.status, 404);
  assert.equal(requests.item(iB.id)!.status, "open", "B's item untouched");
  // A request of A's own workspace that this terminal never served: the same 404.
  const { s: other, o: oOther } = terminal(A.id, [pr(210)]);
  const { r: rOther, item: iOther } = ledgerFor(other, oOther, pr(210), null);
  assert.equal((await approve(sA.id, { kind: "merge", outcome_at: oA.at, ledger: { request: rOther.id, item: iOther.id } })).status, 404);
  // A's terminal whose hand-off names B's PR: refused before GitHub is even asked.
  const { s: sX, o: oX } = terminal(A.id, [PR_B]);
  const foreign = await approve(sX.id, { kind: "merge", outcome_at: oX.at });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error, /belongs to another workspace/);
  // One foreign PR beside its own: nothing is approved, not even its own.
  const { s: sY, o: oY } = terminal(A.id, [pr(211), PR_B]);
  gh[pr(211)] = { state: "OPEN", head: HEAD };
  assert.equal((await approve(sY.id, { kind: "merge", outcome_at: oY.at })).status, 403);
  assert.deepEqual(typed, [], "nothing typed into any terminal");
  assert.deepEqual(reads, [], "no PR was read for a refused approval");
  for (const id of [sA.id, sX.id, sY.id]) assert.deepEqual(approvalsOf(id), []);
});

test("only the operator's own hand approves: no workspace, Lead or Robert credential, and not his token without the hand header", async () => {
  const { s, o } = terminal(A.id, [pr(212)]);
  gh[pr(212)] = { state: "OPEN", head: HEAD };
  const lead = sessions.create({ workspace_id: A.id, role: "lead", cwd: tmp } as any);
  const tries: Array<[string, Record<string, string>]> = [
    ["A's workspace token", { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token }],
    ["A's Lead", { ...json, "x-mc-lead": sessions.leadToken(lead.id)! }],
    ["A's Robert", { ...json, "x-mc-admin": robertToken(A.id, "rw", "operator"), "x-mc-operator": "1" }],
    ["the fleet-wide Robert", { ...json, "x-mc-admin": robertToken(null, "rw", "operator"), "x-mc-operator": "1" }],
    ["his token without the hand header", { ...json, "x-mc-admin": CONFIG.adminToken }],
    ["his token beside an agent's header", { ...hand, "x-mc-session": s.id }],
    ["nobody", json],
  ];
  for (const [who, h] of tries) {
    const r = await approve(s.id, { kind: "merge", outcome_at: o.at }, h);
    assert.ok(r.status === 401 || r.status === 403, `${who}: ${r.status}`);
  }
  assert.equal(typed.length, 0);
  assert.deepEqual(approvalsOf(s.id), []);
  assert.equal((await approve(s.id, { kind: "merge", outcome_at: o.at })).status, 200, "his hand gets through");
});

test("the Desk's Approve button names only the button and the hand-off it was drawn from — the page never writes the line", async () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  const at = html.indexOf("async function approveHandoff(");
  assert.ok(at >= 0, "approveHandoff is on the page");
  const src = html.slice(at, html.indexOf("\n}\n", at) + 2);
  const calls: any[] = [];
  const toasts: string[] = [];
  const shipping: string[][] = [];
  const reread: string[] = [];
  let reply: any = { ok: true, approval: { kind: "merge", prs: [{ num: 200, sha: HEAD }] } };
  const env: Record<string, unknown> = {
    api: async (p: string, o: any) => { calls.push({ p, headers: o.headers, body: JSON.parse(o.body) }); if (reply instanceof Error) throw reply; return reply; },
    D: { id: "s1", outcome: { at: "2026-11-13T19:03:26.699Z" } },
    S: { answered: new Map(), notifyCount: new Map() },
    APPROVING: new Set(),
    shipStart: (s: any, kind: string) => shipping.push([s.id, kind]),
    renderStory: () => {}, renderCounts: () => {}, syncBadge: () => {},
    toast: (m: string) => toasts.push(m),
    errMsg: (e: any) => { try { return JSON.parse(e.message).error || e.message; } catch { return e.message; } },
    decisionsLoad: (s: any) => reread.push(s.id),
  };
  const approveHandoff = new Function(...Object.keys(env), src + "; return approveHandoff;")(...Object.values(env));
  await approveHandoff({ id: "s1" }, "merge");
  assert.deepEqual(calls, [{ p: "/sessions/s1/approve", headers: { "x-mc-operator": "1" }, body: { kind: "merge", outcome_at: "2026-11-13T19:03:26.699Z", surface: "desk" } }]);
  assert.deepEqual(shipping, [["s1", "merge"]], "the dock turns into Merging… once it was typed");
  assert.equal(toasts.at(-1), "approved · merge #200 @4f1c2d3", "it says exactly what was approved");
  // Refused (the card moved under him): the reason shows, the card is read again, nothing is marked shipping.
  calls.length = 0; shipping.length = 0;
  reply = Object.assign(new Error(JSON.stringify({ error: "a newer hand-off landed since that card was drawn — have another look" })), { status: 409 });
  await approveHandoff({ id: "s1" }, "merge+deploy");
  assert.equal(calls.length, 1);
  assert.deepEqual(shipping, []);
  assert.deepEqual(reread, ["s1"]);
  assert.match(toasts.at(-1)!, /^a newer hand-off landed/);
  // A card drawn with no hand-off on it says so, so a hand-off that has landed since is a refusal, not a guess.
  calls.length = 0;
  await approveHandoff({ id: "s2" }, "merge");
  assert.equal(calls[0].body.outcome_at, null);
});
