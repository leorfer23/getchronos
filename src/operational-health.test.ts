import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { operationalHealth } from "./operational-health.js";
import { CONFIG } from "./config.js";
import { db, workspaces, repos, tickets, reviews, jobs, runs, connectorSyncs, kv } from "./store.js";
import { createTicket } from "./tickets.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM reviews; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM repos; DELETE FROM connector_syncs; DELETE FROM workspaces; DELETE FROM kv;",
  );
});

test("operationalHealth: connector credential error is critical", () => {
  const ws = workspaces.create({
    slug: "acm-" + randomUUID().slice(0, 6),
    name: "Acme",
    config_dir: "/tmp/acm-oh",
    ticket_connector: "clickup",
    connector_config: JSON.stringify({ token: "x", list_id: "1" }),
  } as any);
  connectorSyncs.add({
    workspace_id: ws.id,
    connector: "clickup",
    pulled: 0,
    created: 0,
    updated: 0,
    pushed: 0,
    error: 'clickup pull 401: {"err":"Token invalid","ECODE":"OAUTH_025"}',
  });

  const h = operationalHealth();
  assert.equal(h.status, "degraded");
  const iss = h.issues.find((i) => i.id === `connector-error:${ws.id}`);
  assert.ok(iss, "connector error surfaced");
  assert.equal(iss!.severity, "critical");
  assert.match(iss!.fix, /set-connector-token/);
});

test("operationalHealth: pending review after ticket landed is a stale_review warn", () => {
  const ws = workspaces.create({
    slug: "stale-" + randomUUID().slice(0, 6),
    name: "Stale",
    config_dir: "/tmp/stale-oh",
  } as any);
  const t = createTicket({ workspace_id: ws.id, title: "Already shipped" });
  tickets.update(t.id, { status: "done", pr_state: "merged" } as any);
  const job = jobs.create({ name: "ticket:" + t.key, goal: "g", workspace_id: ws.id, ticket_id: t.id } as any);
  const run = runs.create(job.id, "manual");
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });

  const h = operationalHealth();
  assert.equal(h.status, "degraded");
  assert.ok(h.issues.some((i) => i.id === `stale-review-landed:${r.id}`));
});

test("operationalHealth: no budget/concurrency caps are info, not degraded alone", () => {
  // Fresh DB, native workspaces only, no syncs, no stalls — only guardrail infos.
  workspaces.create({ slug: "plain-" + randomUUID().slice(0, 6), name: "Plain", config_dir: "/tmp/plain-oh" } as any);
  // Force the global caps off regardless of the test runner's env (CHRONOS_DAILY_BUDGET=5 in npm test).
  const prevB = CONFIG.dailyBudgetUsd;
  const prevC = CONFIG.maxConcurrent;
  (CONFIG as any).dailyBudgetUsd = 0;
  (CONFIG as any).maxConcurrent = 0;
  try {
    const h = operationalHealth();
    assert.equal(h.status, "ok", "info-only issues must not degrade");
    assert.ok(h.issues.some((i) => i.id === "guardrail-budget"));
    assert.ok(h.issues.some((i) => i.id === "guardrail-concurrency"));
  } finally {
    (CONFIG as any).dailyBudgetUsd = prevB;
    (CONFIG as any).maxConcurrent = prevC;
  }
});
