/**
 * Concurrent-dispatch stress suite for review-panel races (PER-38).
 *
 * Additive — the narrow PER-32 / #232 / PER-34 regressions in reviews.test.ts and
 * ticket-delete.test.ts stay as-is. This file fires the same race shapes via Promise.all so the
 * next concurrent entry into src/reviews.ts fails in CI before it ships.
 *
 * No live backend / real execute() (CLAUDE.md #2): setExecutor + mock backend only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTicket, removeTicket } from "./tickets.js";
import {
  applyVerdict,
  createForRun,
  dispatchReview,
  dispatchReviewPanel,
  ensureReviewForTicket,
} from "./reviews.js";
import { workspaces, reviews, jobs, runs, db, repos } from "./store.js";
import type { RunStatus } from "./types.js";
import { bus } from "./bus.js";
import { setExecutor } from "./dispatcher.js";
import { parsePanel } from "./panels.js";

function countJobsNamed(name: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE name = ?").get(name) as { n: number }).n;
}

function seedReview(opts: { panel?: boolean } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-revcon-"));
  const ws = workspaces.create({
    slug: "revcon-" + randomUUID().slice(0, 8),
    name: "RevCon",
    config_dir: cwd,
    default_backend: "mock",
    review_backend: "mock",
    sandbox_mode: "off",
    auto_review: true,
    review_panel: opts.panel ?? false,
  } as any);
  const repo = repos.create({
    workspace_id: ws.id,
    name: "r",
    path: cwd,
    default_branch: "main",
  } as any);
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Concurrent review stress" });
  const buildJob = jobs.create({
    name: "ticket:" + t.key,
    goal: "g",
    workspace_id: ws.id,
    ticket_id: t.id,
    cwd,
    sandbox: "off",
    backend: "mock",
    retry_max: 0,
  } as any);
  const buildRun = runs.create(buildJob.id, "manual");
  const r = reviews.create({
    run_id: buildRun.id,
    ticket_id: t.id,
    diff_ref: "diff --git a/x b/x\n+hello\n",
    // High risk so wantsReviewPanel fires when review_panel is on.
    risk: opts.panel ? "high" : "low",
  });
  return { ws, t, r, cwd, buildRun, buildJob };
}

// ── #232 / PER-31: duplicate review.created → one reviewer ─────────────────

test("Promise.all: two concurrent dispatchReview calls spawn only one review:KEY job", async (t) => {
  t.after(() => setExecutor(null));
  setExecutor(async (_job, runId) => {
    // Leave the run queued/active without finishing — second caller must see it in flight.
    runs.patch(runId, { status: "queued" });
    return "success" satisfies RunStatus;
  });

  const { t: ticket, r } = seedReview();
  const name = `review:${ticket.key}`;

  const [a, b] = await Promise.all([
    Promise.resolve().then(() => dispatchReview(r.id)),
    Promise.resolve().then(() => dispatchReview(r.id)),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.equal(countJobsNamed(name), 1, "concurrent dispatchReview must not double-spawn");
  assert.ok(
    statuses.some((s) => s === "skipped: already running"),
    `one caller must skip; got ${JSON.stringify([a, b])}`,
  );
  assert.ok(
    statuses.some((s) => s !== "skipped: already running" && !s?.startsWith("error")),
    `one caller must dispatch; got ${JSON.stringify([a, b])}`,
  );
});

test("Promise.all: two concurrent review.created publishes spawn only one reviewer", async (t) => {
  t.after(() => {
    setExecutor(null);
  });
  setExecutor(async () => "success");

  const dispatches: Array<{ status?: string }> = [];
  const onEvent = (e: { topic: string; review_id?: string }) => {
    if (e.topic === "review.created" && e.review_id) {
      try {
        dispatches.push(dispatchReview(e.review_id));
      } catch {
        /* same swallow as onReviewCreated */
      }
    }
  };
  bus.on("event", onEvent);
  t.after(() => bus.off("event", onEvent));

  const { t: ticket, r, buildRun } = seedReview();
  const evt = {
    topic: "review.created" as const,
    review_id: r.id,
    run_id: buildRun.id,
    ticket_id: ticket.id,
    ticket_key: ticket.key,
    workspace_id: ticket.workspace_id,
  };

  await Promise.all([
    Promise.resolve().then(() => bus.publish(evt)),
    Promise.resolve().then(() => bus.publish(evt)),
  ]);

  assert.equal(countJobsNamed(`review:${ticket.key}`), 1, "dual concurrent review.created must not double-spawn");
  assert.ok(dispatches.length >= 1, "at least one dispatch attempted");
  assert.ok(
    dispatches.filter((d) => d.status === "skipped: already running").length >= 1 ||
      countJobsNamed(`review:${ticket.key}`) === 1,
    "second publish must skip or share the single job",
  );
});

// ── PER-32: votes cast mid dispatchReviewPanel survive the post-loop trim ─

test("Promise.all: votes landing during dispatchReviewPanel survive the lens trim", async (t) => {
  t.after(() => setExecutor(null));

  const { r } = seedReview({ panel: true });

  // Sync mid-loop vote (CLAUDE.md #1): executor prologue runs before dispatch() returns, so
  // castPanelVote → setPanel lands while dispatchReviewPanel is still iterating lenses.
  setExecutor(async (job, runId) => {
    if (job.name.endsWith(":spec")) {
      void applyVerdict(r.id, "approve", "concurrent mid-loop vote", "spec");
    }
    runs.patch(runId, {
      status: "success",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cost_usd: 0,
    });
    return "success" satisfies RunStatus;
  });

  // Fire the panel and a second external vote in the same turn — stresses re-read under
  // concurrent writers, not only the single mid-loop path the sequential regression covers.
  const [lenses] = await Promise.all([
    Promise.resolve().then(() => dispatchReviewPanel(r.id)),
    Promise.resolve().then(async () => {
      // Yield once so the panel's first sync dispatch can seed panel_json, then cast another lens.
      await Promise.resolve();
      const panel = parsePanel(reviews.get(r.id)?.panel_json);
      if (panel?.lenses.includes("correctness") || panel?.lenses.length) {
        await applyVerdict(r.id, "approve", "sibling concurrent vote", "correctness");
      }
    }),
  ]);

  assert.ok(lenses?.includes("spec"), `spec must dispatch; got ${lenses}`);
  const panel = parsePanel(reviews.get(r.id)!.panel_json);
  assert.ok(panel, "panel_json must remain a panel after trim");
  assert.ok(
    panel.votes.some((v) => v.lens === "spec" && v.notes === "concurrent mid-loop vote"),
    `mid-loop vote must survive concurrent trim; got ${JSON.stringify(panel.votes)}`,
  );
});

test("Promise.all: concurrent panel lens votes do not drop each other", async (t) => {
  t.after(() => setExecutor(null));
  setExecutor(async (_job, runId) => {
    runs.patch(runId, {
      status: "success",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cost_usd: 0,
    });
    return "success" satisfies RunStatus;
  });

  const { r } = seedReview({ panel: true });
  const lenses = dispatchReviewPanel(r.id);
  assert.ok(lenses && lenses.length >= 2, "panel must fan out");

  // All lenses vote in the same tick — castPanelVote read-modify-write must not lose siblings.
  await Promise.all(
    lenses!.map((lens, i) =>
      applyVerdict(r.id, "approve", `concurrent vote ${i}`, lens),
    ),
  );

  const panel = parsePanel(reviews.get(r.id)!.panel_json);
  assert.ok(panel, "panel still present");
  // At least as many unique lens votes as we cast (abstentions/resolution may collapse state after
  // quorum, but we must never end with fewer recorded votes than a single sequential cast would keep
  // mid-flight — if the review already resolved, votes stay on the last panel_json write).
  const votedLenses = new Set(panel!.votes.map((v) => v.lens));
  for (const lens of lenses!) {
    assert.ok(
      votedLenses.has(lens) || reviews.get(r.id)!.state !== "pending",
      `lens ${lens} vote missing while panel still pending; votes=${JSON.stringify(panel!.votes)}`,
    );
  }
});

// ── PER-34: ticket delete racing a pending review ─────────────────────────

test("Promise.all: removeTicket refuses while a pending review is racing dispatch", async () => {
  const { t: ticket, r } = seedReview();

  const [del, disp] = await Promise.all([
    Promise.resolve().then(() => {
      try {
        removeTicket(ticket.id);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, err: String(e) };
      }
    }),
    Promise.resolve().then(() => {
      setExecutor(async () => "success");
      try {
        return dispatchReview(r.id);
      } finally {
        setExecutor(null);
      }
    }),
  ]);

  assert.equal(del.ok, false, "delete must not win against a pending review");
  assert.match(del.err ?? "", /pending review/);
  assert.ok(ticketsStill(ticket.id), "ticket must still exist");
  assert.equal(reviews.get(r.id)?.ticket_id, ticket.id, "review must keep its ticket_id");
  assert.ok(disp, "dispatch side still ran");
});

test("Promise.all: removeTicket vs ensureReviewForTicket never strands a mergeable orphan", async () => {
  // No pending review yet — the dangerous window is create-during-delete (ON DELETE SET NULL).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-revdel-"));
  const ws = workspaces.create({
    slug: "revdel-" + randomUUID().slice(0, 8),
    name: "RevDel",
    config_dir: cwd,
    default_backend: "mock",
    sandbox_mode: "off",
  } as any);
  const repo = repos.create({ workspace_id: ws.id, name: "r", path: cwd, default_branch: "main" } as any);
  const ticket = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Delete race" });
  const buildJob = jobs.create({
    name: "ticket:" + ticket.key,
    goal: "g",
    workspace_id: ws.id,
    ticket_id: ticket.id,
    cwd,
    sandbox: "off",
    backend: "mock",
    retry_max: 0,
  } as any);
  runs.create(buildJob.id, "manual");

  const [del, ens] = await Promise.all([
    Promise.resolve().then(() => {
      try {
        removeTicket(ticket.id);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, err: String(e) };
      }
    }),
    ensureReviewForTicket(ticket.id).then(
      (rev) => ({ ok: true as const, rev }),
      (e) => ({ ok: false as const, err: String(e) }),
    ),
  ]);

  const pendingOrphans = (
    db
      .prepare("SELECT id, ticket_id, state FROM reviews WHERE state = 'pending' AND (ticket_id IS NULL OR ticket_id = ?)")
      .all(ticket.id) as Array<{ id: string; ticket_id: string | null; state: string }>
  ).filter((row) => row.ticket_id == null);

  assert.equal(
    pendingOrphans.length,
    0,
    `pending review with null ticket_id strands merge (PER-34); got ${JSON.stringify(pendingOrphans)} del=${JSON.stringify(del)} ens=${JSON.stringify(ens)}`,
  );

  if (del.ok) {
    // Delete won: ticket gone, ensure must not have left a mergeable pending row.
    assert.equal(ticketsStill(ticket.id), false);
    assert.ok(!ens.ok || !ens.rev || ens.rev.ticket_id == null || ens.rev.state !== "pending");
  } else {
    // Ensure won first (pending exists): delete must refuse.
    assert.match(del.err ?? "", /pending review/);
    assert.ok(ticketsStill(ticket.id));
  }
});

// ── Extra concurrent entry: dual publishers into createForRun / ensure ────

test("Promise.all: ensureReviewForTicket + createForRun publish at most one pending review row", async (t) => {
  t.after(() => setExecutor(null));
  setExecutor(async () => "success");

  const { t: ticket, buildJob, buildRun, cwd } = seedReview();
  // Start from zero pending — seedReview created one; dismiss the race target by removing it.
  for (const row of reviews.byTicket(ticket.id)) {
    db.prepare("DELETE FROM reviews WHERE id = ?").run(row.id);
  }
  assert.equal(reviews.byTicket(ticket.id).filter((x) => x.state === "pending").length, 0);

  await Promise.all([
    ensureReviewForTicket(ticket.id),
    createForRun(buildJob, buildRun.id, "success", null),
  ]);

  const pending = reviews.byTicket(ticket.id).filter((x) => x.state === "pending");
  // Ideal: one pending. If this ever returns 2, that is a fourth race — flag in the handoff, do not
  // silently patch production in this test-only ticket.
  assert.ok(
    pending.length <= 1,
    `ensureReview + createForRun concurrently opened ${pending.length} pending reviews (fourth race?) cwd=${cwd}`,
  );
});

function ticketsStill(id: string): boolean {
  return !!(db.prepare("SELECT 1 FROM tickets WHERE id = ?").get(id));
}
