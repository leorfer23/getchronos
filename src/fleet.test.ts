import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, jobs, runs, tickets } from "./store.js";
import { composeFleet, fleetData, type FleetData, type FleetTicket, type FleetWs } from "./fleet.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

// ── composeFleet (pure) ──────────────────────────────────────────────────────

const mkWs = (over: Partial<FleetWs> = {}): FleetWs => ({
  name: "Acme", slug: "acme", live: [], queued: 0, sessionsLive: 0,
  agents: { blocked: 0, working: 0, done: 0, blockedAgents: [] },
  today: { done: 0, failed: 0, blocked: 0, inReview: 0 },
  prs: { open: 0, mergedToday: 0 }, spendToday: 0, spendRunsToday: 0, spendSessionsToday: 0, budget: null, windowTokens: 0, rateLimitResetsAt: null,
  divergent: [], divergentCount: 0,
  ...over,
});
const mkTicket = (over: Partial<FleetTicket> = {}): FleetTicket => ({
  key: "ACM-1", title: "t", status: "in_progress", statusSource: "local", externalStatus: null,
  divergent: false, priority: "P2", assignee: "agent", prState: null, ciState: null,
  ...over,
});
const mkData = (ws: FleetWs[], global?: Partial<FleetData["global"]>): FleetData => ({
  workspaces: ws,
  global: { live: 0, queued: 0, spendToday: 0, spendRunsToday: 0, spendSessionsToday: 0, spendScope: "global", unpricedRunsToday: 0, estimatedSessionsToday: 0, budget: 10, windowTokens: 0, blocked: 0, working: 0, ...global },
});

test("skips idle-and-zero workspaces, keeps active ones", () => {
  const { text } = composeFleet(mkData([
    mkWs({ name: "Idle" }),
    mkWs({ name: "Busy", live: [{ runId8: "abcd1234", jobName: "ACM-14 build", elapsedSec: 720, costSoFar: 0.84, model: "opus" }] }),
  ]));
  assert.ok(!text.includes("Idle"), "idle ws omitted");
  assert.ok(text.includes("<b>Busy</b>"), "active ws present");
});

test("workspace header line matches the compact format", () => {
  const { text } = composeFleet(mkData([
    mkWs({ name: "Acme", live: [{ runId8: "x", jobName: "ACM-14 build", elapsedSec: 60, costSoFar: 0.1, model: "opus" }],
      queued: 1, today: { done: 4, failed: 1, blocked: 0, inReview: 2 },
      prs: { open: 1, mergedToday: 3 }, spendToday: 3.2, windowTokens: 840_000 }),
  ]));
  const head = text.split("\n").find((l) => l.startsWith("<b>Acme</b>"))!;
  assert.equal(head, "<b>Acme</b> ▶1 ⏳1 · today ✅4 ✗1 ⟳2 · PR 🔀1 ✅🔀3 · $3.20 · 🪙840k/5h");
});

test("renders a live-run line per running run", () => {
  const { text } = composeFleet(mkData([
    mkWs({ live: [{ runId8: "abcd1234", jobName: "ACM-14 build", elapsedSec: 720, costSoFar: 0.84, model: "opus" }] }),
  ]));
  assert.ok(text.includes("  ▶ ACM-14 build · 12m · $0.84 (opus)"), text);
});

test("renders a rate-limit line when a workspace is limited", () => {
  const iso = "2026-07-12T14:30:00.000Z";
  const expected = (() => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })();
  const { text } = composeFleet(mkData([mkWs({ rateLimitResetsAt: iso })]));
  assert.ok(text.includes(`  ⏸ limited, resets ${expected}`), text);
});

test("footer carries global totals", () => {
  const { text } = composeFleet(mkData([mkWs({ name: "Idle" })], { live: 3, queued: 2, spendToday: 5, budget: 10, windowTokens: 1_200_000 }));
  const footer = text.split("\n").pop()!;
  // "(all ws)" is load-bearing: this pair was read as one workspace's spend against that
  // workspace's ceiling on 2026-08-05, and the wrong thing got throttled (PER-24).
  assert.equal(footer, "▶3 live · 2 queued · $5.00/$10 today (all ws) · 🪙1.2M/5h");
});

test("footer says how many of the day's runs nobody priced", () => {
  const { text } = composeFleet(
    mkData([mkWs({ name: "Idle" })], { live: 0, queued: 0, spendToday: 14.01, budget: 50, windowTokens: 0, unpricedRunsToday: 63 }),
  );
  const footer = text.split("\n").pop()!;
  // The shape of the real 2026-08-05 reading: $14.01 metered, 63 runs of unknown cost.
  assert.match(footer, /\$14\.01\/\$50 today \(all ws \+63 unpriced\)/);
});

test("returns a refresh keyboard (fl.r)", () => {
  const { keyboard } = composeFleet(mkData([]));
  assert.equal((keyboard as any).inline_keyboard[0][0].callback_data, "fl.r");
});

// ── store helpers (in-memory db) ─────────────────────────────────────────────

function seedRun(jobId: string, patch: any) {
  const r = runs.create(jobId, "manual");
  runs.patch(r.id, patch);
  return r;
}

test("activeByWorkspace returns running + queued runs joined to their job", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const build = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id, model: "opus" });
  seedRun(build.id, { status: "running", started_at: "2026-07-12T10:00:00.000Z", cost_usd: 0.5 });
  runs.create(build.id, "manual"); // stays 'queued'
  seedRun(build.id, { status: "success", started_at: "2026-07-12T09:00:00.000Z" }); // excluded

  const rows = runs.activeByWorkspace();
  assert.equal(rows.length, 2);
  const running = rows.find((r) => r.status === "running")!;
  assert.equal(running.workspace_id, ws.id);
  assert.equal(running.job_name, "ticket:AB-1");
  assert.equal(running.model, "opus");
  assert.equal(rows.filter((r) => r.status === "queued").length, 1);
});

function seedTicket(wsId: string, key: string, over: Partial<Parameters<typeof tickets.create>[0]> = {}) {
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(), title: `${key} title`,
    status: "in_progress", status_source: "local", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
    ...over,
  } as any);
}

test("fleetData tickets carry statusSource, and mirror tickets are excluded from inReview", () => {
  const ws = workspaces.create({ slug: "fl-" + randomUUID().slice(0, 8), name: "Fleet ws", config_dir: "/tmp/fl" } as any);
  seedTicket(ws.id, "FLT-1", { status: "in_progress", status_source: "local" });
  seedTicket(ws.id, "FLT-2", { status: "in_progress", status_source: "external" });
  seedTicket(ws.id, "FLT-3", { status: "review", status_source: "external" });

  const data = fleetData();
  const w = data.workspaces.find((x) => x.slug === ws.slug)!;
  const byKey = Object.fromEntries(w.tickets.map((t) => [t.key, t]));
  assert.equal(byKey["FLT-1"].statusSource, "local");
  assert.equal(byKey["FLT-2"].statusSource, "external");
  // A mirror sitting in 'review' is tracker state, not an actual review in flight.
  assert.equal(w.today.inReview, 0);
});

// A ticket Chronos closed while ClickUp still shows it open is invisible in `tickets` by
// construction (TICKET_ORDER is open-only) — that's exactly how ACM-3 kept getting reported as an
// open P1. `divergent` is the list that doesn't drop it.
test("fleetData surfaces divergent tickets, including closed ones the open board never shows", () => {
  const ws = workspaces.create({ slug: "fl-" + randomUUID().slice(0, 8), name: "Fleet ws", config_dir: "/tmp/fl" } as any);
  seedTicket(ws.id, "FLT-1", { status: "dismissed", status_source: "local", external_status: "in progress", priority: "P1" });
  seedTicket(ws.id, "FLT-2", { status: "in_progress", status_source: "external", external_status: "In Progress" }); // agrees
  seedTicket(ws.id, "FLT-3", { status: "planning", status_source: "local", external_status: "in progress" }); // collapse, not clash
  seedTicket(ws.id, "FLT-4", { status: "review", status_source: "local", external_status: "To Do", priority: "P3" });

  const data = fleetData();
  const w = data.workspaces.find((x) => x.slug === ws.slug)!;
  assert.deepEqual(w.divergent.map((t) => t.key), ["FLT-1", "FLT-4"], "P0-first, agreeing tickets excluded");
  assert.equal(w.divergentCount, 2);
  assert.equal(w.divergent[0].externalStatus, "in progress");
  assert.ok(!w.tickets.some((t) => t.key === "FLT-1"), "the closed one is absent from the open list — the whole problem");
  assert.equal(w.tickets.find((t) => t.key === "FLT-4")!.divergent, true, "open tickets carry the flag inline too");
  assert.equal(w.tickets.find((t) => t.key === "FLT-3")!.divergent, false);
});

test("composeFleet names the disagreeing tickets and un-idles a workspace that has them", () => {
  const { text } = composeFleet(mkData([
    mkWs({ name: "Acme", divergentCount: 3, divergent: [
      mkTicket({ key: "ACM-3", status: "dismissed", externalStatus: "in progress" }),
      mkTicket({ key: "ACM-9", status: "done", externalStatus: "To Do" }),
      mkTicket({ key: "ACM-11", status: "done", externalStatus: "To Do" }),
    ] }),
  ]));
  assert.ok(text.includes("<b>Acme</b>"), "a workspace whose only news is the mismatch still renders");
  assert.ok(text.includes("  ⚠ tracker disagrees: ACM-3 dismissed↔in progress, ACM-9 done↔To Do +1"), text);
});

test("windowByWorkspace sums 5h tokens and picks latest rate-limit reset in 24h", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const job = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id });
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
  seedRun(job.id, { status: "success", started_at: ago(1), tokens_in: 500, tokens_out: 340 }); // in 5h window
  seedRun(job.id, { status: "success", started_at: ago(10), tokens_in: 999, tokens_out: 999 }); // outside 5h, inside 24h → tokens excluded
  seedRun(job.id, { status: "rate_limited", started_at: ago(3), resets_at: "2998-01-01T00:00:00.000Z" }); // earlier reset
  seedRun(job.id, { status: "rate_limited", started_at: ago(2), resets_at: "2999-01-01T00:00:00.000Z" }); // latest reset

  const rows = runs.windowByWorkspace(ago(5), ago(24));
  const mine = rows.find((r) => r.workspace_id === ws.id)!;
  assert.equal(mine.tokens, 840, "only 5h-window tokens summed");
  assert.equal(mine.resets_at, "2999-01-01T00:00:00.000Z", "latest (MAX) reset wins");
});
