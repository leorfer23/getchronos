import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, jobs, runs, tickets } from "./store.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

// Seed a run with a fixed started_at + cost/token totals (runs.create leaves those null).
function seedRun(jobId: string, startedAt: string, cost: number, tin: number, tout: number) {
  const r = runs.create(jobId, "manual");
  runs.patch(r.id, { started_at: startedAt, status: "success", cost_usd: cost, tokens_in: tin, tokens_out: tout } as any);
  return r;
}

// jobs.ticket_id is a real FK (PER-44) — seed the ticket row it points at.
function seedTicket(id: string, workspaceId: string) {
  return tickets.create({
    id, workspace_id: workspaceId, repo_id: null, key: id, slug: id.toLowerCase(),
    title: id, status: "backlog", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${id}.md`, external_system: null, external_id: null,
    external_url: null, tags: null,
  } as any);
}

test("groups by workspace + stage with derived stage, tokens and date filter", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const plan = jobs.create({ name: "plan:AB-1", goal: "g", workspace_id: ws.id });
  const build = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id });
  const review = jobs.create({ name: "review:AB-1", goal: "g", workspace_id: ws.id });

  seedRun(plan.id, "2026-07-05T10:00:00.000Z", 0.30, 1000, 200);
  seedRun(build.id, "2026-07-06T10:00:00.000Z", 4.00, 5000, 900);
  seedRun(build.id, "2026-07-07T10:00:00.000Z", 0.10, 500, 100);
  seedRun(review.id, "2026-07-08T10:00:00.000Z", 0.80, 800, 150);
  // Out of window — must be excluded.
  seedRun(build.id, "2026-06-15T10:00:00.000Z", 9.99, 1, 1);

  const rows = runs.costReport({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-31T23:59:59.999Z" });
  const byStage = new Map(rows.map((r) => [r.stage, r]));

  assert.equal(rows.length, 3);
  assert.equal(byStage.get("plan")!.cost_usd, 0.30);
  assert.equal(byStage.get("build")!.runs, 2);
  assert.equal(byStage.get("build")!.cost_usd.toFixed(2), "4.10");
  assert.equal(byStage.get("build")!.tokens_in, 5500);
  assert.equal(byStage.get("build")!.tokens_out, 1000);
  assert.equal(byStage.get("review")!.cost_usd, 0.80);
  for (const r of rows) { assert.equal(r.workspace_id, ws.id); assert.equal(r.ws_slug, "acme"); }
});

test("dailyCosts groups by day + model, sums tokens/cost, honors date window", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const opus = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id, model: "claude-opus-4-8" });
  const k3 = jobs.create({ name: "ticket:AB-2", goal: "g", workspace_id: ws.id, model: "kimi-k3" });

  // Two opus runs same day → collapse into one (day, model) row.
  seedRun(opus.id, "2026-07-06T09:00:00.000Z", 2.00, 1000, 300);
  seedRun(opus.id, "2026-07-06T18:00:00.000Z", 1.00, 500, 100);
  seedRun(k3.id, "2026-07-06T12:00:00.000Z", 0.05, 4000, 800);
  seedRun(opus.id, "2026-07-07T10:00:00.000Z", 3.00, 2000, 400);
  seedRun(opus.id, "2026-06-01T10:00:00.000Z", 9.99, 1, 1); // out of window

  const rows = runs.dailyCosts({ from: "2026-07-01", to: "2026-07-31T23:59:59Z" });
  const key = (d: string, m: string) => rows.find((r) => r.day === d && r.model === m);

  assert.equal(rows.length, 3);
  const o6 = key("2026-07-06", "claude-opus-4-8")!;
  assert.equal(o6.cost_usd, 3.0);
  assert.equal(o6.tokens_in, 1500);
  assert.equal(o6.tokens_out, 400);
  assert.equal(o6.runs, 2);
  assert.equal(key("2026-07-06", "kimi-k3")!.tokens_in, 4000);
  assert.equal(key("2026-07-07", "claude-opus-4-8")!.cost_usd, 3.0);
  assert.equal(rows[0]!.day, "2026-07-06"); // ordered by day asc
});

test("null-workspace and deleted-job runs land in the unscoped bucket as 'other'", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const scoped = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id });
  const loose = jobs.create({ name: "nightly-cleanup", goal: "g" }); // no workspace, no stage prefix

  seedRun(scoped.id, "2026-07-06T10:00:00.000Z", 1.00, 10, 10);
  seedRun(loose.id, "2026-07-06T11:00:00.000Z", 0.50, 5, 5);

  const rows = runs.costReport({ from: "2026-07-01", to: "2026-07-31T23:59:59Z" });
  const unscoped = rows.find((r) => r.ws_slug === "unscoped");
  assert.ok(unscoped, "expected an unscoped bucket");
  assert.equal(unscoped!.workspace_id, null);
  assert.equal(unscoped!.stage, "other");
  assert.equal(unscoped!.cost_usd, 0.50);
});

test("listForTicket returns every attempt for a ticket, past the global feed cap", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  seedTicket("T-AB-9", ws.id);
  seedTicket("T-NOISE", ws.id);
  // First attempt on the ticket.
  const first = jobs.create({ name: "ticket:AB-9", goal: "g", workspace_id: ws.id, ticket_id: "T-AB-9" });
  const r1 = runs.create(first.id, "manual");
  // Bury it under >100 unrelated runs so runs.list()'s global LIMIT 100 window excludes it.
  const noise = jobs.create({ name: "ticket:NOISE", goal: "g", workspace_id: ws.id, ticket_id: "T-NOISE" });
  for (let i = 0; i < 120; i++) runs.create(noise.id, "manual");
  // Retry: second job/run for the same ticket.
  const second = jobs.create({ name: "ticket:AB-9", goal: "g", workspace_id: ws.id, ticket_id: "T-AB-9" });
  const r2 = runs.create(second.id, "manual");

  const global = runs.list();
  assert.ok(!global.some((r) => r.id === r1.id), "first attempt should have fallen out of the global cap");

  const scoped = runs.listForTicket("T-AB-9");
  const ids = new Set(scoped.map((r) => r.id));
  assert.ok(ids.has(r1.id) && ids.has(r2.id), "both attempts must survive in the ticket-scoped list");
  assert.equal(scoped.length, 2);
});

test("workspace_id filter restricts to that client", () => {
  const a = workspaces.create({ slug: "a", name: "A", config_dir: "/tmp/a" });
  const b = workspaces.create({ slug: "b", name: "B", config_dir: "/tmp/b" });
  seedRun(jobs.create({ name: "ticket:1", goal: "g", workspace_id: a.id }).id, "2026-07-06T10:00:00Z", 1, 1, 1);
  seedRun(jobs.create({ name: "ticket:2", goal: "g", workspace_id: b.id }).id, "2026-07-06T10:00:00Z", 2, 1, 1);

  const rows = runs.costReport({ workspace_id: a.id, from: "2026-07-01", to: "2026-07-31T23:59:59Z" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ws_slug, "a");
  assert.equal(rows[0].cost_usd, 1);
});
