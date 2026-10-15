import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applyPrState,
  ciChecks,
  ciRollup,
  isPrUrl,
  markDelivered,
  orphanReviewCandidates,
  pollList,
  reconcileOrphanReviews,
  setViewPr,
} from "./delivery.js";
import { createTicket, ticketBranch } from "./tickets.js";
import { workspaces, reviews, jobs, runs, tickets, repos } from "./store.js";
import type { Ticket } from "./types.js";

test("applyPrState maps gh states to transitions (case-insensitive)", () => {
  assert.deepEqual(applyPrState("MERGED"), { pr_state: "merged", delivered: true });
  assert.deepEqual(applyPrState("merged\n"), { pr_state: "merged", delivered: true });
  assert.deepEqual(applyPrState("CLOSED"), { pr_state: "closed", delivered: false });
  assert.equal(applyPrState("OPEN"), null); // still open → no change
  assert.equal(applyPrState(""), null);
  assert.equal(applyPrState("garbage"), null);
});

test("isPrUrl accepts only well-formed github PR urls", () => {
  assert.ok(isPrUrl("https://github.com/o/r/pull/7"));
  assert.ok(isPrUrl("https://github.com/my-org/my.repo/pull/1234"));
  assert.ok(!isPrUrl("http://github.com/o/r/pull/7")); // not https
  assert.ok(!isPrUrl("https://github.com/o/r/issues/7")); // not a PR
  assert.ok(!isPrUrl("https://evil.com/o/r/pull/7"));
  assert.ok(!isPrUrl("https://github.com/o/r/pull/x")); // non-numeric
  assert.ok(!isPrUrl(null));
  assert.ok(!isPrUrl(undefined));
  assert.ok(!isPrUrl(""));
});

test("pollList caps at 20 and reports overflow", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) } as Ticket));
  const under = pollList(mk(5));
  assert.equal(under.poll.length, 5);
  assert.equal(under.overflow, 0);

  const over = pollList(mk(23));
  assert.equal(over.poll.length, 20);
  assert.equal(over.overflow, 3);
});

test("ciRollup: no checks → null (repo has no CI)", () => {
  assert.equal(ciRollup(null), null);
  assert.equal(ciRollup(undefined), null);
  assert.equal(ciRollup([]), null);
});

test("ciRollup: any failing check → failing", () => {
  assert.equal(ciRollup([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ]), "failing");
  assert.equal(ciRollup([{ state: "ERROR" }]), "failing"); // legacy StatusContext
});

test("ciRollup: in-progress/queued → pending", () => {
  assert.equal(ciRollup([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "IN_PROGRESS", conclusion: "" },
  ]), "pending");
  assert.equal(ciRollup([{ state: "PENDING" }]), "pending");
});

test("ciRollup: all complete + green → passing", () => {
  assert.equal(ciRollup([
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "SKIPPED" },
    { state: "SUCCESS" },
  ]), "passing");
});

test("ciRollup: failing wins over pending", () => {
  assert.equal(ciRollup([
    { status: "IN_PROGRESS", conclusion: "" },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ]), "failing");
});

test("markDelivered auto-dismisses a pending review left over from the merge", async () => {
  const ws = workspaces.create({ slug: "delivlearn-" + randomUUID().slice(0, 8), name: "DelivLearn", config_dir: "/tmp/delivlearn" } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Add widget" });
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });

  await markDelivered({ ...t, pr_url: "https://github.com/o/r/pull/1" } as Ticket);

  const after = reviews.get(r.id)!;
  assert.equal(after.state, "dismissed");
  assert.match(after.notes ?? "", /auto-resolved: PR merged/);
  assert.equal(tickets.get(t.id)!.pr_state, "merged");
  assert.equal(tickets.get(t.id)!.status, "done");
});

test("ciChecks: normalizes CheckRun + StatusContext into per-check rows", () => {
  assert.equal(ciChecks([]), null);
  assert.deepEqual(
    ciChecks([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u1" },
      { name: "test", status: "IN_PROGRESS", conclusion: "" },
      { context: "lint", state: "FAILURE", targetUrl: "u3" },
    ]),
    [
      { name: "build", state: "passing", url: "u1" },
      { name: "test", state: "pending", url: null },
      { name: "lint", state: "failing", url: "u3" },
    ],
  );
});

test("orphanReviewCandidates: pending delivery=pr review with no pr_url", () => {
  const ws = workspaces.create({ slug: "orphan-" + randomUUID().slice(0, 8), name: "Orphan", config_dir: "/tmp/orphan" } as any);
  const repo = repos.create({
    workspace_id: ws.id,
    name: "app",
    path: "/tmp/orphan-repo",
    default_branch: "main",
    delivery: "pr",
  } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Scope worktrees", repo_id: repo.id });
  tickets.update(t.id, { status: "review" } as any);
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "diff" });

  const cands = orphanReviewCandidates();
  assert.ok(cands.some((c) => c.id === t.id), "orphan ticket is a candidate");
});

test("reconcileOrphanReviews: MERGED branch dismisses pending review and closes ticket", async () => {
  const ws = workspaces.create({ slug: "recon-" + randomUUID().slice(0, 8), name: "Recon", config_dir: "/tmp/recon" } as any);
  const repo = repos.create({
    workspace_id: ws.id,
    name: "chronos",
    path: "/tmp/recon-repo",
    default_branch: "main",
    delivery: "pr",
  } as any);
  const t = createTicket({ workspace_id: ws.id, title: "PER-92 fix", repo_id: repo.id });
  tickets.update(t.id, { status: "review" } as any);
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "diff" });

  const expectedBranch = ticketBranch(t.key);
  // Other tests leave orphan candidates in the shared in-memory DB — only answer for ours.
  setViewPr(async (branch) => {
    if (branch !== expectedBranch) return null;
    return {
      url: "https://github.com/acme-co/chronos/pull/264",
      state: "MERGED",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    };
  });
  try {
    const n = await reconcileOrphanReviews();
    assert.ok(n >= 1);
    const after = tickets.get(t.id)!;
    assert.equal(after.status, "done");
    assert.equal(after.pr_state, "merged");
    assert.equal(after.pr_url, "https://github.com/acme-co/chronos/pull/264");
    assert.equal(reviews.get(r.id)!.state, "dismissed");
  } finally {
    setViewPr(null);
  }
});

test("reconcileOrphanReviews: no PR leaves the review alone", async () => {
  const ws = workspaces.create({ slug: "nopr-" + randomUUID().slice(0, 8), name: "NoPr", config_dir: "/tmp/nopr" } as any);
  const repo = repos.create({
    workspace_id: ws.id,
    name: "app",
    path: "/tmp/nopr-repo",
    default_branch: "main",
    delivery: "pr",
  } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Still pending", repo_id: repo.id });
  tickets.update(t.id, { status: "review" } as any);
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: "diff" });

  setViewPr(async () => null);
  try {
    const n = await reconcileOrphanReviews();
    assert.equal(n, 0);
    assert.equal(reviews.get(r.id)!.state, "pending");
    assert.equal(tickets.get(t.id)!.status, "review");
    assert.equal(tickets.get(t.id)!.pr_url, null);
  } finally {
    setViewPr(null);
  }
});
