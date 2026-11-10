/**
 * The executor (src/executor.ts) against a fake gh and a fake draft sender — nothing real is ever
 * merged or sent from here (the real gh refuses to run under CHRONOS_TEST, and that is tested too).
 *
 * What it must hold: with the kill switch off nothing changes; a yes is carried out once (a replay is
 * refused), only before it expires, only if the real target is still the version he approved, only
 * inside the workspace the yes was given in, only past the verifier's checks (or his logged override),
 * and every ending — done, refused, failed — lands in the log with the hashes and the error.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, kv, repos, sessions, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { executorStore } from "./store/executor.js";
import * as L from "./ledger.js";
import * as X from "./executor.js";
import { draftHash } from "./ledger-model.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";
import { setRemoteReader } from "./pr-ownership.js";
import { bus } from "./bus.js";

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: "finished its turn" }));
L.setLedgerProgressProvider(() => null);

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const PR = "https://github.com/atlas-co/api/pull/12";
const FOREIGN_PR = "https://github.com/cedar-co/web/pull/3";

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: slug, config_dir: `/tmp/ex-${slug}-${Math.random()}` } as any);

type Call = { args: string[]; env: NodeJS.ProcessEnv };
let calls: Call[] = [];
/** A fake gh: the PR's live state, and what a merge does. */
function fakeGh(o: { head?: string; state?: string; draft?: boolean; mergeError?: string; after?: string; viewError?: string } = {}) {
  calls = [];
  X.setExecutorGh(async (args, { env }) => {
    calls.push({ args, env });
    if (args[0] === "pr" && args[1] === "view" && args.includes("state,isDraft,headRefOid,url")) {
      if (o.viewError) throw Object.assign(new Error("exit 1"), { stderr: o.viewError });
      return JSON.stringify({ state: o.state ?? "OPEN", isDraft: !!o.draft, headRefOid: o.head ?? SHA, url: args[2] });
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (o.mergeError) throw Object.assign(new Error("exit 1"), { stderr: o.mergeError });
      return "";
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: o.after ?? "MERGED", mergeCommit: { oid: "c".repeat(40) } });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  });
}
const merges = () => calls.filter((c) => c.args[1] === "merge");

let told: Array<{ sid: string; text: string }> = [];
X.setExecutorTell((sid, text) => told.push({ sid, text }));
let events: any[] = [];
bus.on("event", (e: any) => { if (e?.topic === "executor.result") events.push(e); });
after(() => { X.setExecutorGh(null); X.setExecutorTell(null); X.setDraftSender("email", null); X.setDraftSender("slack", null); });

const SETTINGS = ["executor.enabled", "executor.merge_pr", "executor.send_draft", "executor.ttl_minutes", "executor.no_checks", "executor.merge_method"];

type Fx = { A: any; B: any; s: any; r: any; d: any; item: any };
let fx: Fx;
function build(prUrl = PR): Fx {
  const A = mkWs("atlas");
  const B = mkWs("cedar");
  repos.create({ workspace_id: A.id, name: "api", path: "/tmp/ex-api-nonexistent", git_remote: "https://github.com/atlas-co/api.git" } as any);
  repos.create({ workspace_id: B.id, name: "web", path: "/tmp/ex-web-nonexistent", git_remote: "https://github.com/cedar-co/web.git" } as any);
  const s = sessions.create({ workspace_id: A.id, cwd: "/tmp", goal: "fix the login redirect", goal_kind: "pr", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  sessions.setOutcome(s.id, {
    summary: "redirect loop gone", changes: [], proof: [], prs: [prUrl], shots: [], ask: "merge", shipped: [],
    at: new Date(Date.now() + 1000).toISOString(),
  } as any);
  L.onLedgerEvent({ topic: "session.updated", session_id: s.id });
  const r = requests.get(requests.primaryAt(s.id)!.request_id)!;
  const d = requests.deliverables(r.id).find((x) => x.kind === "pr")!;
  // The verifier's stamp: the head it checked.
  requests.bindTarget(d.id, SHA);
  const item = requests.items(r.id).find((i) => i.action === "merge")!;
  return { A, B, s, r, d, item };
}
/** The verifier's four required checks for a backend PR, all passing on `hash`. */
function passChecks(f: Fx, hash = SHA, over: Record<string, "pass" | "fail" | "skip"> = {}) {
  for (const name of ["tests", "regression", "pr_ready", "matches_request"]) {
    requests.addCheck({ request_id: f.r.id, deliverable_id: f.d.id, name, status: over[name] ?? "pass", target_hash: hash, ran_by: "verifier" } as any);
  }
}
/** His yes, recorded the way the decision route records it. */
function sayYes(f: Fx, by = "phone-voice:strong", words = "dale, mergealo") {
  const out = L.recordDecision({ request: f.r.id, item: f.item.id, decision: "yes", target_hash: SHA, words, by });
  assert.ok(out.ok, JSON.stringify(out));
  return out as Extract<typeof out, { ok: true }>;
}

beforeEach(() => {
  db.exec("DELETE FROM executor_log; DELETE FROM executor_approvals; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM sessions; DELETE FROM repos;");
  for (const k of SETTINGS) writeSetting(k, null);
  _resetSettingsCache();
  setRemoteReader(() => null); // clears pr-ownership's memo: each test registers its own repos
  L.resetLedgerMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  told = [];
  events = [];
  fakeGh();
  fx = build();
});

// ── the kill switch ──────────────────────────────────────────────────────────────────────────────

test("kill switch off (the default): a yes is recorded exactly as before — no approval, no log, no gh, nothing executed", async () => {
  passChecks(fx);
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { words: "dale", by: "phone" });
  assert.deepEqual(c, { executed: false, executor: "off" });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM executor_approvals").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM executor_log").get()!.n, 0);
  assert.equal(calls.length, 0);
  assert.equal(requests.item(fx.item.id)!.status, "decided");
  assert.equal(requests.deliverable(fx.d.id)!.state, "open");
  assert.equal(events.length, 0);
});

test("a per-action switch off, a deploy, a 'no', and a weak spoken yes create no approval", async () => {
  writeSetting("executor.enabled", true);
  writeSetting("executor.merge_pr", false, fx.A.id);
  passChecks(fx);
  const out = sayYes(fx);
  assert.deepEqual(await X.carryOutDecision(out.item, out.request, { by: "phone" }), { executed: false, executor: "merge_pr is switched off" });
  writeSetting("executor.merge_pr", null, fx.A.id);
  // A deploy is a disabled seam: never carried out in v1.
  const dep = { ...out.item, action: "deploy" as const };
  const c = await X.carryOutDecision(dep, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.match(c.executor!, /deploy is not carried out/);
  assert.deepEqual(await X.carryOutDecision({ ...out.item, decision: "no" }, out.request, {}), { executed: false });
  // "ok" on something irreversible is no yes: refused before any approval, and logged.
  const weak = await X.carryOutDecision(out.item, out.request, { by: "phone-voice:weak", words: "ok" });
  assert.equal(weak.executed, false);
  assert.equal(weak.execution?.code, "weak");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM executor_approvals").get()!.n, 0);
  assert.equal(calls.length, 0);
});

// ── the happy path ───────────────────────────────────────────────────────────────────────────────

test("a yes on a verified PR: merged once, under the workspace's env, with --match-head-commit, logged with his words; the ledger closes and the terminal is told", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx, "phone-voice:strong", "dale, mergealo");
  const c = await X.carryOutDecision(out.item, out.request, { words: "dale, mergealo", by: "phone-voice:strong" });
  assert.equal(c.executed, true, JSON.stringify(c));
  assert.equal(c.execution!.status, "done");
  assert.deepEqual(c.execution!.say, { es: "Mergeado.", en: "Merged." });
  const m = merges();
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].args, ["pr", "merge", PR, "--squash", "--match-head-commit", SHA]);
  assert.ok(!m[0].args.some((a) => /admin|auto|delete-branch/.test(a)), "never --admin, --auto or --delete-branch");
  // Read with the same identity it merges with: the workspace's own env.
  assert.ok(calls.every((x) => x.env === calls[0].env));
  assert.equal(requests.deliverable(fx.d.id)!.state, "merged");
  // Nothing is owed any more: no "approved — waits to be carried out" (its terminal is merely still open).
  assert.equal(requests.get(fx.r.id)!.state, "done");
  assert.doesNotMatch(requests.get(fx.r.id)!.state_line ?? "", /waits to be carried out/);
  const a = executorStore.approval(c.execution!.approval_id!)!;
  assert.equal(a.used_at !== null, true);
  assert.equal(a.result, "done");
  assert.equal(a.how, "voice_strong");
  assert.equal(a.surface, "phone");
  assert.equal(a.transcript, "dale, mergealo");
  const [log] = executorStore.logRows();
  assert.equal(log.status, "done");
  assert.equal(log.words, "dale, mergealo");
  assert.equal(log.approved_hash, SHA);
  assert.equal(log.live_hash, SHA);
  assert.equal(log.ran, `gh pr merge ${PR} --squash --match-head-commit ${SHA}`);
  assert.equal(told.length, 1);
  assert.equal(told[0].sid, fx.s.id);
  assert.match(told[0].text, /executor merged .*Do not merge it again/);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "done");
});

// ── single use, expiry ───────────────────────────────────────────────────────────────────────────

test("replay: the same approval a second time is refused, and nothing runs twice", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, true);
  const again = await X.executeApproval(c.execution!.approval_id!);
  assert.equal(again.status, "refused");
  assert.equal(again.code, "replay");
  assert.equal(merges().length, 1);
  // One yes, one approval: a second approval for the same decision item cannot even be written.
  const dup = X.approve({ item: requests.item(fx.item.id)!, request: requests.get(fx.r.id)!, action: "merge_pr", how: "tap", meta: {} });
  assert.ok("refused" in dup);
  const statuses = executorStore.logRows().map((l) => `${l.status}:${l.code}`);
  assert.deepEqual(statuses.sort(), ["done:merged", "refused:replay"].sort());
});

test("expiry: an approval run after its minutes is void — nothing runs, and the question comes back", async () => {
  writeSetting("executor.enabled", true);
  writeSetting("executor.ttl_minutes", 2);
  passChecks(fx);
  const out = sayYes(fx);
  const t0 = Date.now();
  const a = X.approve({ item: out.item, request: out.request, action: "merge_pr", how: "tap", meta: { words: "yes" } }, t0);
  assert.ok(!("refused" in a));
  const late = await X.executeApproval((a as any).id, t0 + 2 * 60_000 + 1000);
  assert.equal(late.status, "refused");
  assert.equal(late.code, "expired");
  assert.equal(calls.length, 0, "not even a read");
  assert.ok(executorStore.approval((a as any).id)!.used_at, "used up: it can never run later");
  // The spent yes is history; a fresh item asks him again, still bound to the same version.
  assert.equal(requests.item(fx.item.id)!.status, "superseded");
  const fresh = requests.item(late.reraised_item!)!;
  assert.equal(fresh.status, "open");
  assert.equal(fresh.target_hash, SHA);
  assert.equal((await X.executeApproval((a as any).id, t0 + 10_000)).code, "replay", "and an expired one never comes back to life");
});

// ── the target moved ─────────────────────────────────────────────────────────────────────────────

test("hash moved between the yes and the run: GitHub's head is not the one he approved → refused, nothing merged, the target unbound until re-verified", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  fakeGh({ head: SHA2 });
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.code, "moved");
  assert.equal(c.execution!.live_hash, SHA2);
  assert.equal(c.execution!.approved_hash, SHA);
  assert.equal(merges().length, 0);
  assert.equal(requests.deliverable(fx.d.id)!.target_hash, null, "no yes goes through until the verifier binds the new head");
  const fresh = requests.item(c.execution!.reraised_item!)!;
  assert.equal(fresh.status, "open");
  assert.equal(fresh.target_hash, null);
  const [log] = executorStore.logRows();
  assert.equal(log.live_hash, SHA2);
  assert.equal(log.approved_hash, SHA);
  assert.match(log.error!, /head is/i);
});

test("GitHub refusing the merge because the head moved after the read is caught as 'moved' too", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  fakeGh({ mergeError: "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)" });
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.execution!.status, "failed");
  assert.equal(c.execution!.code, "moved");
  assert.equal(requests.deliverable(fx.d.id)!.target_hash, null);
});

test("the item re-bound after the yes (a newer head stamped) → refused before GitHub is asked", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx);
  const a = X.approve({ item: out.item, request: out.request, action: "merge_pr", how: "tap", meta: {} });
  // A decided item is not re-bound by bindTarget; simulate the row changing under the approval.
  db.prepare("UPDATE request_decisions SET target_hash = ? WHERE id = ?").run(SHA2, fx.item.id);
  const x = await X.executeApproval((a as any).id);
  assert.equal(x.code, "moved");
  assert.equal(calls.length, 0);
});

// ── the wall ─────────────────────────────────────────────────────────────────────────────────────

test("wrong workspace: a PR from another workspace's repo is never merged under this one's identity", async () => {
  db.exec("DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM sessions; DELETE FROM repos;");
  setRemoteReader(() => null);
  fx = build(FOREIGN_PR);
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.code, "wall");
  assert.equal(calls.length, 0, "GitHub is not even asked");
});

test("wrong workspace: an approval whose workspace no longer matches its request's is refused", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx);
  const a = X.approve({ item: out.item, request: out.request, action: "merge_pr", how: "tap", meta: {} }) as any;
  db.prepare("UPDATE executor_approvals SET workspace_id = ? WHERE id = ?").run(fx.B.id, a.id);
  const x = await X.executeApproval(a.id);
  assert.equal(x.code, "wall");
  assert.equal(calls.length, 0);
});

test("a request with no workspace has no identity of its own to merge under: refused", async () => {
  writeSetting("executor.enabled", true);
  const none = requests.create({ workspace_id: null, words: "merge it", via: "typed" });
  const nd = requests.upsertDeliverable({ request_id: none.id, kind: "pr", ref: PR, label: "PR #12" });
  requests.bindTarget(nd.id, SHA);
  const ni = requests.upsertItem({ request_id: none.id, action: "merge", label: "PR #12", item_key: "merge|none", deliverable_id: nd.id, target_hash: SHA }).item;
  const dec = L.recordDecision({ request: none.id, item: ni.id, decision: "yes", target_hash: SHA, by: "phone" });
  assert.ok(dec.ok);
  const c = await X.carryOutDecision((dec as any).item, (dec as any).request, { by: "phone" });
  assert.equal(c.execution?.code, "no_workspace");
  assert.equal(calls.length, 0);
});

// ── the verifier's checks ────────────────────────────────────────────────────────────────────────

test("missing checks: no rows → refused by default, and the question comes back; his logged override or the setting lets it through", async () => {
  writeSetting("executor.enabled", true);
  let out = sayYes(fx);
  let c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.code, "no_checks");
  assert.equal(calls.length, 0);
  const fresh = requests.item(c.execution!.reraised_item!)!;
  assert.equal(fresh.status, "open");
  // He says it again, with "without checks": merged, and the override is in the log.
  const again = L.recordDecision({ request: fx.r.id, item: fresh.id, decision: "yes", target_hash: SHA, words: "mergealo sin checks", by: "phone" });
  assert.ok(again.ok);
  c = await X.carryOutDecision((again as any).item, (again as any).request, { by: "phone", words: "mergealo sin checks", override: "no_checks" });
  assert.equal(c.executed, true, JSON.stringify(c));
  assert.equal(executorStore.logRows({ status: "done" })[0].override, "no_checks:operator");

  // The setting instead of the override.
  db.exec("DELETE FROM executor_log; DELETE FROM executor_approvals; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM sessions; DELETE FROM repos;");
  setRemoteReader(() => null);
  fx = build();
  writeSetting("executor.no_checks", "allow");
  out = sayYes(fx);
  c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, true);
  assert.equal(executorStore.logRows({ status: "done" })[0].override, "no_checks:setting");
});

test("checks for an older head, a failing check, a missing or skipped required check: refused, never overridable", async () => {
  writeSetting("executor.enabled", true);
  const cases: Array<[() => void, string]> = [
    [() => passChecks(fx, SHA2), "checks_stale"],
    [() => passChecks(fx, SHA, { regression: "fail" }), "checks_failed"],
    [() => passChecks(fx, SHA, { matches_request: "skip" }), "checks_missing"],
    [() => requests.addCheck({ request_id: fx.r.id, deliverable_id: fx.d.id, name: "tests", status: "pass", target_hash: SHA, ran_by: "verifier" } as any), "checks_missing"],
  ];
  for (const [arrange, code] of cases) {
    db.exec("DELETE FROM request_checks; DELETE FROM executor_approvals;");
    db.prepare("UPDATE request_decisions SET status = 'open', decision = NULL, decided_at = NULL WHERE id = ?").run(fx.item.id);
    arrange();
    const out = sayYes(fx);
    const c = await X.carryOutDecision(out.item, out.request, { by: "phone", override: "no_checks" });
    assert.equal(c.execution!.code, code, `${code}: ${JSON.stringify(c.execution)}`);
    assert.equal(merges().length, 0);
    fx.item = requests.item(c.execution!.reraised_item!) ?? fx.item;
  }
});

test("checksGate: the newest run of a check counts, and only a check that names this head", () => {
  const row = (name: string, status: "pass" | "fail", ran_at: string, target_hash = SHA) =>
    ({ id: name + ran_at, request_id: "r", deliverable_id: "d", name, status, evidence: [], note: null, target_hash, ran_by: "verifier", ran_at, created_at: ran_at }) as any;
  const all = ["tests", "regression", "pr_ready", "matches_request"].map((n) => row(n, "pass", "2026-01-02"));
  assert.deepEqual(X.checksGate("pr", "d", SHA, all, "refuse", null), { ok: true, override: null });
  // A failure, then a later pass of the same check: the later run counts.
  assert.equal(X.checksGate("pr", "d", SHA, [row("tests", "fail", "2026-01-01"), ...all], "refuse", null).ok, true);
  assert.equal(X.checksGate("pr", "d", SHA, [...all, row("tests", "fail", "2026-01-03")], "refuse", null).ok, false);
  // Another deliverable's checks do not vouch for this one.
  assert.equal(X.checksGate("pr", "other", SHA, all.map((c) => ({ ...c, deliverable_id: "x" })), "refuse", null).ok, false);
});

// ── failures are logged with the error ──────────────────────────────────────────────────────────

test("GitHub refuses the merge: failed, the error text logged, the yes retired and asked again", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  fakeGh({ mergeError: "GraphQL: Pull Request is not mergeable (mergePullRequest)" });
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.status, "failed");
  assert.equal(c.execution!.code, "gh_failed");
  assert.match(c.execution!.say.es, /^No pude: GitHub rechazó el merge/);
  const [log] = executorStore.logRows();
  assert.equal(log.status, "failed");
  assert.match(log.error!, /not mergeable/);
  assert.equal(log.ran, `gh pr merge ${PR} --squash --match-head-commit ${SHA}`);
  assert.equal(requests.deliverable(fx.d.id)!.state, "open");
  assert.equal(requests.item(fx.item.id)!.status, "superseded");
  assert.equal(requests.item(c.execution!.reraised_item!)!.status, "open");
  assert.equal(requests.get(fx.r.id)!.state, "needs_operator");
  assert.equal(told.length, 0, "the terminal is told only when it was done");
});

test("reading the PR fails, the PR is closed or a draft: logged, nothing merged", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  fakeGh({ viewError: "HTTP 502: Bad Gateway" });
  let out = sayYes(fx);
  let c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.execution!.code, "read_failed");
  assert.match(executorStore.logRows()[0].error!, /502/);
  fx.item = requests.item(c.execution!.reraised_item!)!;
  fakeGh({ draft: true });
  out = sayYes(fx);
  c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.execution!.code, "draft_pr");
  fx.item = requests.item(c.execution!.reraised_item!)!;
  fakeGh({ state: "CLOSED" });
  out = sayYes(fx);
  c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.execution!.code, "not_open");
  assert.equal(requests.deliverable(fx.d.id)!.state, "closed", "GitHub's word settles it");
  assert.equal(merges().length, 0);
});

test("a merge GitHub accepted but did not merge yet (a merge queue) is 'queued', not done", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  fakeGh({ after: "OPEN" });
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.status, "queued");
  assert.equal(requests.deliverable(fx.d.id)!.state, "open");
});

test("under test the real gh never runs, whatever a test forgot to stub", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  X.setExecutorGh(null);
  const out = sayYes(fx);
  const c = await X.carryOutDecision(out.item, out.request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.code, "read_failed");
  assert.match(executorStore.logRows()[0].error!, /never runs the real gh under test/);
});

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────

function draftFixture(text = "Hola Ana, ya quedó.") {
  const live = { channel: "email" as const, to: "ana@example.com", subject: "Login", text };
  const hash = draftHash(live);
  L.noteDraft(fx.s.id, { label: "Email draft → ana@example.com · Login", tool: { name: "mcp__x__create_draft" }, target: { channel: "email", to: "ana@example.com", hash } });
  const item = requests.items(fx.r.id).find((i) => i.action === "send")!;
  return { live, hash, item };
}

test("send_draft with no sender (today, for every workspace): refused with the reason, nothing re-asked, the yes stays recorded", async () => {
  writeSetting("executor.enabled", true);
  writeSetting("executor.send_draft", true);
  const { hash, item } = draftFixture();
  const out = L.recordDecision({ request: fx.r.id, item: item.id, decision: "yes", target_hash: hash, words: "mandalo", by: "phone" });
  assert.ok(out.ok);
  const c = await X.carryOutDecision((out as any).item, (out as any).request, { by: "phone" });
  assert.equal(c.executed, false);
  assert.equal(c.execution!.code, "no_sender");
  assert.match(c.execution!.error!, /Gmail/);
  assert.equal(c.execution!.reraised_item, null);
  assert.equal(requests.item(item.id)!.status, "decided");
});

test("send_draft re-reads the provider's draft and sends exactly that — refused when the live words differ from the approved hash", async () => {
  writeSetting("executor.enabled", true);
  writeSetting("executor.send_draft", true);
  const { live, hash, item } = draftFixture();
  let provider = { ...live };
  const sent: any[] = [];
  X.setDraftSender("email", {
    unavailable: () => null,
    read: async () => ({ ...provider }),
    send: async (_d, l) => { sent.push(l); return { id: "msg-1" }; },
  });
  // The agent edited the draft after it was announced: the live words are not the approved ones.
  provider = { ...live, text: "Hola Ana, mandame tu clave." };
  let out = L.recordDecision({ request: fx.r.id, item: item.id, decision: "yes", target_hash: hash, words: "mandalo", by: "phone" });
  let c = await X.carryOutDecision((out as any).item, (out as any).request, { by: "phone" });
  assert.equal(c.execution!.code, "moved");
  assert.equal(sent.length, 0);
  assert.notEqual(c.execution!.live_hash, hash);
  // Put back as approved, and he says yes again (the draft is re-announced by its hook with its hash).
  provider = { ...live };
  requests.bindTarget(requests.items(fx.r.id).find((i) => i.action === "send" && i.status === "open")!.deliverable_id!, hash);
  const fresh = requests.items(fx.r.id).find((i) => i.action === "send" && i.status === "open")!;
  out = L.recordDecision({ request: fx.r.id, item: fresh.id, decision: "yes", target_hash: hash, words: "ahora sí", by: "phone" });
  c = await X.carryOutDecision((out as any).item, (out as any).request, { by: "phone" });
  assert.equal(c.executed, true, JSON.stringify(c));
  assert.deepEqual(sent, [live], "exactly the draft that was read and hashed");
  assert.deepEqual(c.execution!.say, { es: "Enviado.", en: "Sent." });
  assert.equal(requests.deliverable(fresh.deliverable_id!)!.state, "sent");
});

// ── boot ─────────────────────────────────────────────────────────────────────────────────────────

test("boot: an approval nobody used is void and logged — never run late", async () => {
  writeSetting("executor.enabled", true);
  passChecks(fx);
  const out = sayYes(fx);
  const a = X.approve({ item: out.item, request: out.request, action: "merge_pr", how: "tap", meta: {} }) as any;
  assert.equal(X.startExecutor(), 1);
  assert.equal(executorStore.approval(a.id)!.result, "void");
  assert.equal((await X.executeApproval(a.id)).code, "replay");
  assert.equal(calls.length, 0);
  assert.ok(executorStore.logRows().some((l) => l.status === "void" && l.code === "restart"));
});

// ── who can reach it ─────────────────────────────────────────────────────────────────────────────

test("the source holds the line: only the decision route creates or consumes an approval", () => {
  const src = path.dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(src);
  const callers = files.filter((f) => {
    const t = fs.readFileSync(f, "utf8");
    return /\b(carryOutDecision|executeApproval|approve)\b/.test(t) && /from "\.\.?\/(?:[\w/]*\/)?executor\.js"/.test(t);
  }).map((f) => path.relative(src, f)).filter((f) => f !== "executor.ts").sort();
  assert.deepEqual(callers, ["ledger-routes.ts"]);
  // No route takes an approval id.
  const routes = fs.readFileSync(path.join(src, "executor-routes.ts"), "utf8");
  assert.doesNotMatch(routes, /api\.(post|put|patch|delete)\(/);
});
