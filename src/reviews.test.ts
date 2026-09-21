import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ticketBranch, createTicket } from "./tickets.js";
import { diffStats } from "./gates.js";
import { captureDiff, shipPR, landOnDefaultBranch, requestChanges, dismiss, ensureReviewForTicket, prBody, createForRun, merge, applyVerdict, prDeliveryPatch, dispatchReview, dispatchReviewPanel } from "./reviews.js";
import { workspaces, reviews, jobs, runs, tickets, db, repos } from "./store.js";
import type { Review, Ticket, RunStatus } from "./types.js";
import { listNotes } from "./notes.js";
import { bus } from "./bus.js";
import { setExecutor } from "./dispatcher.js";
import { parsePanel, REVIEW_LENSES } from "./panels.js";

// Seed an isolated workspace + ticket + pending review in the in-memory db.
function seed() {
  const ws = workspaces.create({ slug: "revlearn-" + randomUUID().slice(0, 8), name: "RevLearn", config_dir: "/tmp/revlearn" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Add widget" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });
  return { ws, t, r };
}
// Same seed, but the run's job points at a cwd the caller controls (a path that does not exist).
function seedWithCwd(cwd: string) {
  const ws = workspaces.create({ slug: "gonewt-" + randomUUID().slice(0, 8), name: "GoneWT", config_dir: "/tmp/gonewt" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Landed long ago" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  // sanitizeCwd rejects a path that doesn't exist, so the row can't be seeded with one directly —
  // write it after the fact, which is exactly how production gets here: a real worktree at create
  // time, pruned weeks later.
  db.prepare("UPDATE jobs SET cwd=? WHERE id=?").run(cwd, job.id);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });
  return { ws, t, r, job: jobs.get(job.id)! };
}

const learningsBody = (wsId: string) =>
  listNotes(wsId).find((n) => n.slug === "session-learnings")?.body ?? "";

test("ticketBranch derives + sanitizes an mc/ branch from the ticket key", () => {
  assert.equal(ticketBranch("ACM-14"), "mc/acm-14");
  assert.equal(ticketBranch("ANA-1"), "mc/ana-1");
  assert.equal(ticketBranch("bad key!/../x"), "mc/badkeyx"); // no shell/ref-unsafe chars survive
  assert.equal(ticketBranch("!!!"), "mc/ticket"); // empty after sanitize → safe fallback
});

// Fake exec: records the command sequence, returns scripted output / throws scripted errors.
function fakeRun(script: Record<string, { out?: string; err?: string }>) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    const hit = Object.entries(script).find(([k]) => key.startsWith(k))?.[1];
    if (hit?.err) { const e: any = new Error("exit 1"); e.stderr = hit.err; throw e; }
    return hit?.out ?? "";
  };
  return { run, calls };
}

test("shipPR runs add → commit → push → gh pr create and returns the URL", async () => {
  const { run, calls } = fakeRun({
    "gh pr create": { out: "https://github.com/o/r/pull/7\n" },
  });
  const url = await shipPR("mc/acm-14", "main", "ACM-14: do the thing", "body", run);
  assert.equal(url, "https://github.com/o/r/pull/7");
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ["git add", "git commit", "git push", "git fetch", "git rev-list", "gh pr"]);
  assert.deepEqual(calls[2], ["git", "push", "-u", "origin", "mc/acm-14"]);
});

test("shipPR bails with a clear error when the branch has no commits (empty PR)", async () => {
  const { run, calls } = fakeRun({
    "git rev-list": { out: "0\n" },
  });
  await assert.rejects(() => shipPR("mc/acm-14", "main", "t", "b", run), /no commits on mc\/acm-14 vs origin\/main/);
  assert.ok(!calls.some((c) => c[0] === "gh"), "gh pr create must not run on an empty branch");
});

test("shipPR tolerates nothing-to-commit and still pushes + opens PR", async () => {
  const { run, calls } = fakeRun({
    "git commit": { err: "nothing to commit, working tree clean" },
    "gh pr create": { out: "https://github.com/o/r/pull/9" },
  });
  const url = await shipPR("mc/ana-2", "main", "t", "b", run);
  assert.equal(url, "https://github.com/o/r/pull/9");
  assert.ok(calls.some((c) => c[0] === "git" && c[1] === "push"));
});

test("shipPR treats an existing PR as success and fetches its URL", async () => {
  const { run, calls } = fakeRun({
    "gh pr create": { err: "a pull request for branch \"mc/acm-14\" into \"main\" already exists" },
    "gh pr view": { out: "https://github.com/o/r/pull/3\n" },
  });
  const url = await shipPR("mc/acm-14", "main", "t", "b", run);
  assert.equal(url, "https://github.com/o/r/pull/3");
  assert.ok(calls.some((c) => c[1] === "pr" && c[2] === "view"));
});

test("shipPR throws with stderr when push fails (no transition should follow)", async () => {
  const { run } = fakeRun({ "git push": { err: "Permission denied (publickey)" } });
  await assert.rejects(() => shipPR("mc/acm-14", "main", "t", "b", run), /git push failed: Permission denied/);
});

test("shipPR surfaces a non-'already exists' gh failure", async () => {
  const { run } = fakeRun({ "gh pr create": { err: "GraphQL: some other error" } });
  await assert.rejects(() => shipPR("mc/acm-14", "main", "t", "b", run), /gh pr create failed: GraphQL/);
});

test("landOnDefaultBranch fast-forwards a clean checkout sitting on its default branch", async () => {
  const { run, calls } = fakeRun({ "git rev-parse": { out: "main\n" }, "git status": { out: "" } });
  assert.equal(await landOnDefaultBranch("mc/acm-14", "main", run), null);
  assert.deepEqual(calls.at(-1), ["git", "merge", "--ff-only", "mc/acm-14"]);
});

test("landOnDefaultBranch refuses a dirty or wrong-branch checkout without touching it", async () => {
  // Someone else's uncommitted work in the shared tree — never merge over it.
  const dirty = fakeRun({ "git rev-parse": { out: "main\n" }, "git status": { out: " M src/a.ts\n" } });
  assert.match((await landOnDefaultBranch("mc/acm-14", "main", dirty.run)) ?? "", /uncommitted changes/);
  assert.ok(!dirty.calls.some((c) => c[1] === "merge"), "must not merge into a dirty tree");

  // Another ticket has the tree checked out on its own branch.
  const other = fakeRun({ "git rev-parse": { out: "someone/ACM-58-export\n" } });
  assert.match((await landOnDefaultBranch("mc/acm-59", "main", other.run)) ?? "", /is on 'someone\/ACM-58-export'/);
  assert.ok(!other.calls.some((c) => c[1] === "merge"), "must not merge into another ticket's branch");
});

test("landOnDefaultBranch reports a non-fast-forward instead of throwing (work stays on the branch)", async () => {
  const { run } = fakeRun({
    "git rev-parse": { out: "main\n" },
    "git status": { out: "" },
    "git merge": { err: "fatal: Not possible to fast-forward, aborting." },
  });
  assert.match((await landOnDefaultBranch("mc/acm-14", "main", run)) ?? "", /Not possible to fast-forward/);
});

test("requestChanges by a human captures the notes as a review-feedback learning", () => {
  const { ws, t, r } = seed();
  requestChanges(r.id, "Handle the empty list case", "human");
  assert.match(learningsBody(ws.id), new RegExp(`Operator requested changes on ${t.key}.*Handle the empty list case`));
});

test("requestChanges does NOT capture AI-reviewer verdicts or empty notes", () => {
  const ai = seed();
  requestChanges(ai.r.id, "AI reviewer requested changes", "ai:reviewer");
  assert.equal(learningsBody(ai.ws.id), ""); // no memo created

  const empty = seed();
  requestChanges(empty.r.id, "   ", "human");
  assert.equal(learningsBody(empty.ws.id), "");
});

test("requestChanges twice on one review captures the learning only once", () => {
  const { ws, t, r } = seed();
  requestChanges(r.id, "Fix the race", "human");
  requestChanges(r.id, "Fix the race", "human"); // already changes_requested → skip
  const body = learningsBody(ws.id);
  const hits = body.split(`Operator requested changes on ${t.key}`).length - 1;
  assert.equal(hits, 1);
});

// A later build of the same ticket gets its own run + pending review, as createForRun would make.
function addReview(ws: { id: string }, t: Ticket): Review {
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  return reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });
}

test("one-pass cap: a second AI 'changes' verdict ships with a follow-up ticket instead of looping", async () => {
  const { ws, t, r } = seed();
  // Round 1 spends the rework budget (reviewMaxReworks defaults to 1).
  await applyVerdict(r.id, "changes", "round 1: regex too loose");
  assert.equal(reviews.get(r.id)!.state, "changes_requested");
  assert.equal(tickets.get(t.id)!.status, "ready"); // normal rework path

  // Round 2 — the reviewer objects again. No third build: the review takes the approve lane
  // (here: recommend-approve pending for the human, since the seed repo has no handed-over gate).
  const r2 = addReview(ws, t);
  const out = await applyVerdict(r2.id, "changes", "round 2: regex too tight");
  assert.notEqual(out!.state, "changes_requested");
  assert.match(out!.notes ?? "", /one-pass review cap/);

  const follow = tickets.list({ workspace_id: ws.id }).find((x) => x.title === `Follow-up: unresolved review notes on ${t.key}`);
  assert.ok(follow, "objections must be preserved as a follow-up ticket");
});

test("one-pass cap: gate reworks (ai:gate) don't spend the reviewer's rework budget", async () => {
  const { ws, t, r } = seed();
  requestChanges(r.id, "Evidence gate failed — tests red", "ai:gate"); // broken build, must rework
  const r2 = addReview(ws, t);
  const out = await applyVerdict(r2.id, "changes", "reviewer: handle the empty case");
  assert.equal(out!.state, "changes_requested"); // reviewer still gets their one pass
});

test("one-pass cap: a panel 'changes' resolution past the budget also ships instead of looping", async () => {
  const { ws, t, r } = seed();
  requestChanges(r.id, "round 1: too strict", "ai:reviewer");
  const r2 = addReview(ws, t);
  reviews.setPanel(r2.id, JSON.stringify({ lenses: ["spec"], votes: [] }));
  const out = await applyVerdict(r2.id, "changes", "spec: still not conforming", "spec");
  assert.notEqual(out!.state, "changes_requested");
  assert.match(out!.notes ?? "", /one-pass review cap/);
});

test("dismiss closes the review and leaves the ticket status alone", () => {
  const { t, r } = seed();
  const before = tickets.get(t.id)!.status;
  const out = dismiss(r.id, "already landed by hand");
  assert.equal(out?.state, "dismissed");
  assert.equal(out?.notes, "already landed by hand");
  assert.equal(tickets.get(t.id)!.status, before); // no ship, no reopen
  assert.equal(reviews.list("pending").some((x) => x.id === r.id), false);
});

test("dismiss refuses to reopen a review that was already decided", () => {
  const { r } = seed();
  reviews.setState(r.id, "merged", null, "human");
  assert.equal(dismiss(r.id)?.state, "merged");
});

test("ensureReviewForTicket creates a pending review from the latest run, idempotently", async () => {
  const ws = workspaces.create({ slug: "ensure-" + randomUUID().slice(0, 8), name: "Ensure", config_dir: "/tmp/ensure" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Interactive work" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");

  const r1 = await ensureReviewForTicket(t.id);
  assert.ok(r1);
  assert.equal(r1!.state, "pending");
  assert.equal(r1!.run_id, run.id);

  const r2 = await ensureReviewForTicket(t.id); // already pending → same review, no dup
  assert.equal(r2!.id, r1!.id);
  assert.equal(reviews.byTicket(t.id).length, 1);
});

test("ensureReviewForTicket is a no-op for a ticket with zero runs", async () => {
  const ws = workspaces.create({ slug: "norun-" + randomUUID().slice(0, 8), name: "NoRun", config_dir: "/tmp/norun" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Never ran" });
  assert.equal(await ensureReviewForTicket(t.id), undefined);
  assert.equal(reviews.byTicket(t.id).length, 0);
});

test("prBody uses the ticket handoff, falling back to review notes then title, plus an external ref", () => {
  const base = { title: "Add widget", report: null, external_url: null } as Ticket;
  const r = { notes: null } as Review;
  assert.equal(prBody(base, r), "Add widget\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)");
  assert.match(prBody({ ...base, report: "## Summary\ndid the thing" }, r), /^## Summary\ndid the thing\n\n🤖/);
  assert.match(prBody(base, { notes: "reviewer note" } as Review), /^reviewer note\n\n🤖/); // report absent → notes win
  assert.match(prBody({ ...base, external_url: "https://x/AB-1" }, r), /Ref: https:\/\/x\/AB-1/);
});

test("createForRun reuses a pending review instead of opening a second for the same build", async () => {
  const ws = workspaces.create({ slug: "dedup-" + randomUUID().slice(0, 8), name: "Dedup", config_dir: "/tmp/dedup" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Build it" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id, cwd: "/tmp/dedup-nonrepo" } as any);
  const run = runs.create(job.id, "manual");
  // Agent ran `mc review --report` → a pending review already exists when the run ends.
  const pre = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });

  await createForRun(job as any, run.id, "success");
  assert.equal(reviews.byTicket(t.id).length, 1, "no duplicate review row");
  assert.equal(reviews.byTicket(t.id)[0].id, pre.id, "the pre-existing pending review is reused");
  assert.equal(tickets.get(t.id)!.status, "review");
});

// Settled tickets must not be yanked back to `review` by a late createForRun (merge-gate end was
// the path that did this in PER-4 / PER-13). Status shipping/done + pr_state merged refuse;
// pr_state=closed alone must NOT — markPrClosed → ready rebuild still needs a review filed.
test("createForRun is a no-op when the ticket is already shipping or landed", async () => {
  const ws = workspaces.create({ slug: "settled-" + randomUUID().slice(0, 8), name: "Settled", config_dir: "/tmp/settled" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Already shipping" });
  tickets.update(t.id, { status: "shipping", pr_url: "https://github.com/o/r/pull/1", pr_state: "open" });
  const job = jobs.create({ name: "merge-gate:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id, cwd: "/tmp/settled-nonrepo" } as any);
  const run = runs.create(job.id, "manual");
  const before = reviews.byTicket(t.id).length;

  await createForRun(job as any, run.id, "success");
  assert.equal(reviews.byTicket(t.id).length, before, "no new review on a shipping ticket");
  assert.equal(tickets.get(t.id)!.status, "shipping", "status must stay shipping");

  tickets.update(t.id, { status: "done", pr_state: "merged" });
  await createForRun(job as any, run.id, "success");
  assert.equal(tickets.get(t.id)!.status, "done");
  assert.equal(reviews.byTicket(t.id).length, before);
});

// markPrClosed sets pr_state=closed + status=ready so autoplan can rebuild. After that rebuild,
// pr_state is still "closed" until re-ship — createForRun must still file a review.
test("createForRun files a review after closed-PR rework (ready + pr_state closed)", async () => {
  const ws = workspaces.create({ slug: "reclosed-" + randomUUID().slice(0, 8), name: "Reclosed", config_dir: "/tmp/reclosed" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Rebuild after abandoned PR" });
  tickets.update(t.id, { status: "ready", pr_url: "https://github.com/o/r/pull/7", pr_state: "closed" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id, cwd: "/tmp/reclosed-nonrepo" } as any);
  const run = runs.create(job.id, "manual");

  await createForRun(job as any, run.id, "success");
  assert.equal(tickets.get(t.id)!.status, "review", "ready+closed rebuild must enter review");
  assert.ok(reviews.byTicket(t.id).length >= 1, "a review row must exist");
});

// First ship (or re-ship after closed) arms delivery polling; a redundant merge() on an already
// open/merged PR must not bounce pr_state/ci_state (PER-4 / PER-13).
test("prDeliveryPatch arms once, then only refreshes the URL", () => {
  const url = "https://github.com/o/r/pull/9";
  assert.deepEqual(prDeliveryPatch({ pr_state: null }, url), { pr_url: url, pr_state: "open", ci_state: "pending" });
  assert.deepEqual(prDeliveryPatch({ pr_state: "closed" }, url), { pr_url: url, pr_state: "open", ci_state: "pending" });
  assert.deepEqual(prDeliveryPatch({ pr_state: "open", ci_state: "passing" }, url), { pr_url: url });
  assert.deepEqual(prDeliveryPatch({ pr_state: "merged", ci_state: "passing" }, url), { pr_url: url });
});

// A worktree is pruned when its ticket lands, but the review row can outlive it by weeks. Spawning
// git with a missing cwd surfaces as "spawn git ENOENT" — which reads as a broken git install and
// cost a real debugging detour ("the daemon lost git on PATH") before the cwd was suspected.
test("merge on a run whose worktree is gone closes the review when the ticket already landed", async () => {
  const { t, r, job } = seedWithCwd("/tmp/definitely-not-here-" + randomUUID());
  tickets.update(t.id, { status: "done" });
  const out = await merge(r.id, "clearing stale review");
  assert.equal(out?.state, "merged");
  assert.match(out?.notes ?? "", /worktree gone/);
  assert.match(out?.notes ?? "", /no code shipped/);
  assert.equal(tickets.get(t.id)!.status, "done"); // untouched — nothing was actually shipped
  assert.ok(!fs.existsSync(job.cwd!));
});

test("merge on a gone worktree refuses (naming the cwd) when the work has NOT landed", async () => {
  const { t, r } = seedWithCwd("/tmp/definitely-not-here-" + randomUUID());
  tickets.update(t.id, { status: "review" });
  await assert.rejects(() => merge(r.id), /working directory gone/);
  assert.equal(reviews.get(r.id)!.state, "pending"); // stays actionable, never silently closed
});

// PER-34: ticket deleted → reviews.ticket_id SET NULL. Old merge() still committed in the worktree,
// skipped land-on-default (gated on t), and returned merged — orphaned mc/<key> branch, Inbox OK.
test("merge refuses when the ticket is gone (would strand the commit on the worktree branch)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-strand-"));
  try {
    const { t, r, job } = seedWithCwd(dir);
    // Simulate the pre-guard delete path: SET NULL ticket_id the way the FK does.
    db.prepare("UPDATE reviews SET ticket_id = NULL WHERE id = ?").run(r.id);
    tickets.remove(t.id);
    assert.equal(reviews.get(r.id)!.ticket_id, null);
    assert.ok(fs.existsSync(job.cwd!));

    await assert.rejects(() => merge(r.id), /ticket gone/);
    assert.equal(reviews.get(r.id)!.state, "pending", "must stay pending — never fake a successful merge");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── diff capture ─────────────────────────────────────────────────────────────────────────────────

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-diff-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

// The regression. A build agent that commits its own work leaves a clean working tree, so the old
// plain `git diff` captured nothing — the reviewer got no diff and riskFor([]) scored the change the
// safest tier there is. Ten of the first twelve reviews on this machine were stored that way.
test("captureDiff sees work the agent already committed", async (t) => {
  const dir = tmpRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("checkout", "-qb", "mc/PER-1");
  fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 2;\n");
  git("add", "-A");
  git("commit", "-qm", "the agent committed as it went");

  assert.equal(await captureDiff(dir), null, "precondition: the working tree really is clean");
  const diff = await captureDiff(dir, "main");
  assert.ok(diff, "committed work must still reach the review");
  assert.ok(diff!.includes("export const a = 2"), "the change itself is missing from the diff");
  assert.deepEqual(diffStats(diff).files, ["src.ts"]);
});

test("captureDiff still sees uncommitted work, including new files", async (t) => {
  const dir = tmpRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["-C", dir, "checkout", "-qb", "mc/PER-2"]);
  fs.writeFileSync(path.join(dir, "added.ts"), "export const b = 2;\n"); // untracked
  fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 3;\n");

  const diff = await captureDiff(dir, "main");
  assert.ok(diff!.includes("export const b = 2"), "untracked file missing (intent-to-add lost)");
  assert.ok(diff!.includes("export const a = 3"), "modified file missing");
});

test("captureDiff: committed and uncommitted work land in ONE diff", async (t) => {
  const dir = tmpRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("checkout", "-qb", "mc/PER-3");
  fs.writeFileSync(path.join(dir, "committed.ts"), "export const c = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "half the work");
  fs.writeFileSync(path.join(dir, "loose.ts"), "export const d = 1;\n");

  const files = diffStats(await captureDiff(dir, "main")).files.sort();
  assert.deepEqual(files, ["committed.ts", "loose.ts"]);
});

// Fails open, never closed: a repo we cannot reason about must not silently produce an empty diff
// that then scores as low risk.
test("captureDiff falls back to the working tree when the base cannot be resolved", async (t) => {
  const dir = tmpRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 9;\n");
  const diff = await captureDiff(dir, "no-such-branch");
  assert.ok(diff!.includes("export const a = 9"), "unknown base must not swallow the working tree");
});

// PER-32: dispatch() invokes the executor before it returns, so a panel lens can cast a real vote
// while dispatchReviewPanel is still looping. The post-loop setPanel that trims lenses must keep
// those votes — resetting votes:[] wiped them and left resolvePanel waiting forever on a lens that
// had already voted.
test("dispatchReviewPanel preserves votes cast during the sync dispatch loop", async (t) => {
  t.after(() => setExecutor(null));

  const ws = workspaces.create({
    slug: "panelwipe-" + randomUUID().slice(0, 8),
    name: "PanelWipe",
    config_dir: "/tmp/panelwipe",
    sandbox_mode: "off",
    default_backend: "mock",
    review_backend: "mock",
    review_panel: true,
  } as any);
  const ticket = createTicket({ workspace_id: ws.id, title: "High-risk panel change" });
  const buildJob = jobs.create({
    name: "ticket:" + ticket.key,
    goal: "g",
    workspace_id: ws.id,
    ticket_id: ticket.id,
    cwd: os.homedir(),
    backend: "mock",
    sandbox: "off",
    retry_max: 0,
  } as any);
  const buildRun = runs.create(buildJob.id, "manual");
  const review = reviews.create({
    run_id: buildRun.id,
    ticket_id: ticket.id,
    diff_ref: "diff --git a/x b/x\n",
    risk: "high",
  });

  // Scripted executor: the first lens votes synchronously inside applyVerdict → castPanelVote
  // (setPanel runs before any await), mirroring a mock reviewer that finishes inline mid-loop.
  setExecutor(async (job, runId) => {
    if (job.name.endsWith(":spec")) {
      void applyVerdict(review.id, "approve", "sync mid-loop vote", "spec");
    }
    runs.patch(runId, {
      status: "success",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cost_usd: 0,
    });
    return "success" satisfies RunStatus;
  });

  const lenses = dispatchReviewPanel(review.id);
  assert.ok(lenses?.includes("spec"), `spec lens must have dispatched; got ${lenses}`);
  const panel = parsePanel(reviews.get(review.id)!.panel_json);
  assert.ok(panel, "panel_json must remain a panel after trim");
  assert.deepEqual(panel.lenses.slice().sort(), lenses!.slice().sort());
  assert.ok(
    panel.votes.some((v) => v.lens === "spec" && v.notes === "sync mid-loop vote"),
    `mid-loop vote must survive lens trim; got ${JSON.stringify(panel.votes)}`,
  );
});

// PER-31: ensureReviewForTicket + createForRun both publish review.created for the same pending
// review. Without an in-flight guard, auto-review dispatches two full reviewer runs.
function seedReviewDispatch() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-revdisp-"));
  const ws = workspaces.create({
    slug: "revdisp-" + randomUUID().slice(0, 8),
    name: "RevDisp",
    config_dir: cwd,
    default_backend: "mock",
    sandbox_mode: "off",
    auto_review: true,
  } as any);
  const repo = repos.create({ workspace_id: ws.id, name: "r", path: cwd, default_branch: "main" } as any);
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Ship the fix" });
  const buildJob = jobs.create({
    name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id, cwd, sandbox: "off", backend: "mock", retry_max: 0,
  } as any);
  const buildRun = runs.create(buildJob.id, "manual");
  const r = reviews.create({ run_id: buildRun.id, ticket_id: t.id, diff_ref: "diff --git a/x b/x\n" });
  return { ws, t, r, cwd, buildRun };
}

function countJobsNamed(name: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name = ?").get(name) as { n: number }).n;
}

test("dispatchReview refuses a second concurrent no-lens reviewer for the same ticket", () => {
  const { t, r } = seedReviewDispatch();
  // Simulate the first reviewer already in flight (queued counts as active).
  const first = jobs.create({
    name: `review:${t.key}`, goal: "qa", workspace_id: t.workspace_id, ticket_id: t.id, cwd: "/tmp", sandbox: "off", backend: "mock", retry_max: 0,
  } as any);
  runs.create(first.id, "manual");
  assert.equal(runs.hasActiveJobNamed(t.id, `review:${t.key}`), true);

  const out = dispatchReview(r.id);
  assert.equal(out.status, "skipped: already running");
  assert.equal(countJobsNamed(`review:${t.key}`), 1, "must not create a second review: job");
});

test("dispatchReview lens jobs do not block sibling panel lenses", () => {
  const { t, r } = seedReviewDispatch();
  const [a, b] = REVIEW_LENSES;
  const first = jobs.create({
    name: `review:${t.key}:${a.id}`, goal: "qa", workspace_id: t.workspace_id, ticket_id: t.id, cwd: "/tmp", sandbox: "off", backend: "mock", retry_max: 0,
  } as any);
  runs.create(first.id, "manual");

  setExecutor(async () => "success");
  try {
    const out = dispatchReview(r.id, { lens: b });
    assert.ok(!out.status?.startsWith("skipped"), "sibling lens must still dispatch");
    assert.ok(!out.status?.startsWith("error"), `dispatch failed: ${out.status}`);
    assert.equal(countJobsNamed(`review:${t.key}:${b.id}`), 1);
    assert.equal(countJobsNamed(`review:${t.key}:${a.id}`), 1, "existing lens job untouched");
  } finally {
    setExecutor(null);
  }
});

test("publishing review.created twice for the same review id creates only one review: job", () => {
  // One-shot listener mirroring startAutoPlan → onReviewCreated (avoid startAutoPlan's setInterval
  // keeping the test event loop alive).
  const onEvent = (e: { topic: string; review_id?: string }) => {
    if (e.topic === "review.created" && e.review_id) {
      try { dispatchReview(e.review_id); } catch { /* same swallow as onReviewCreated */ }
    }
  };
  bus.on("event", onEvent);
  setExecutor(async () => "success"); // leave runs queued (= active) without spawning
  try {
    const { t, r, buildRun } = seedReviewDispatch();
    const evt = {
      topic: "review.created" as const,
      review_id: r.id,
      run_id: buildRun.id,
      ticket_id: t.id,
      ticket_key: t.key,
      workspace_id: t.workspace_id,
    };
    bus.publish(evt);
    bus.publish(evt); // PER-30 shape: second publish for the same review id
    assert.equal(countJobsNamed(`review:${t.key}`), 1, "second review.created must not spawn another reviewer");
  } finally {
    bus.off("event", onEvent);
    setExecutor(null);
  }
});
