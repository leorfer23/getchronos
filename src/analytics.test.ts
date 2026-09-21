import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, jobs, runs, sessions } from "./store.js";
import { analytics, analyticsWithDelta, bucketKey, bucketsBetween, resolveRange, stageOf } from "./analytics.js";

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM workspaces;");
});

const ws = (name: string, extra: Record<string, unknown> = {}) =>
  workspaces.create({
    slug: name.toLowerCase() + "-" + randomUUID().slice(0, 6),
    name,
    config_dir: "/tmp/alt-" + randomUUID().slice(0, 8),
    ...extra,
  } as any);

/** A finished headless run at a given instant. */
function run(opts: {
  ws?: string; at: string; cost?: number | null; status?: string; model?: string;
  name?: string; tin?: number; tout?: number; turns?: number;
}) {
  const j = jobs.create({
    name: opts.name ?? "ticket:ABC-1 build",
    goal: "g",
    cwd: "/tmp",
    workspace_id: opts.ws ?? null,
    model: opts.model ?? "opus",
  } as any);
  const r = runs.create(j.id, "manual");
  runs.patch(r.id, {
    started_at: opts.at,
    ended_at: opts.at,
    status: (opts.status ?? "success") as any,
    cost_usd: opts.cost === undefined ? 1 : opts.cost,
    tokens_in: opts.tin ?? 1000,
    tokens_out: opts.tout ?? 100,
    num_turns: opts.turns ?? 4,
  } as any);
  return r.id;
}

/** A Desk terminal created at a given instant. `at` is written straight onto the row (create() stamps now()). */
function term(opts: {
  ws?: string; at: string; cost?: number | null; estimated?: boolean; turns?: number;
  ended?: string | null; model_ms?: number; agent?: string | null;
}) {
  const s = sessions.create({ workspace_id: opts.ws ?? null, cwd: "/tmp", agent_name: opts.agent ?? null } as any);
  db.prepare("UPDATE sessions SET created_at=?, ended_at=?, status=? WHERE id=?").run(
    opts.at,
    opts.ended === null ? null : (opts.ended ?? opts.at),
    opts.ended === null ? "live" : "ended",
    s.id,
  );
  sessions.setLedger(s.id, {
    cost_usd: opts.cost === undefined ? 2 : (opts.cost as number),
    cost_estimated: !!opts.estimated,
    turns: opts.turns ?? 3,
    tokens_in: 500,
    tokens_out: 50,
    model_ms: opts.model_ms ?? 60_000,
  });
  return s.id;
}

/** Local-midnight ISO for a Y-M-D + hour, so tests read in the same clock the buckets use. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0).toISOString();

// ── ranges ────────────────────────────────────────────────────────────────────────────────────

test("resolveRange: presets are half-open windows in local time", () => {
  const now = new Date(2026, 8, 9, 15, 30); // 2026-09-09 15:30 local (September = month 8)

  const today = resolveRange("today", { now });
  assert.equal(new Date(today.from).getDate(), 9);
  assert.equal(new Date(today.from).getHours(), 0);
  assert.equal(new Date(today.to).getDate(), 10, "`to` is tomorrow's midnight, exclusive");

  const mtd = resolveRange("mtd", { now });
  assert.equal(new Date(mtd.from).getMonth(), 8);
  assert.equal(new Date(mtd.from).getDate(), 1);

  const lastMonth = resolveRange("last-month", { now });
  assert.equal(new Date(lastMonth.from).getMonth(), 7, "August");
  assert.equal(new Date(lastMonth.to).getMonth(), 8, "exclusive end = 1 Sep");

  const qtd = resolveRange("qtd", { now });
  assert.equal(new Date(qtd.from).getMonth(), 6, "Q3 starts in July");
  assert.equal(new Date(qtd.from).getDate(), 1);

  const lastQ = resolveRange("last-quarter", { now });
  assert.equal(new Date(lastQ.from).getMonth(), 3, "Q2 starts in April");
  assert.equal(new Date(lastQ.to).getMonth(), 6, "exclusive end = 1 Jul");

  const d30 = resolveRange("30d", { now });
  assert.equal(d30.days, 30);
  assert.equal(new Date(d30.from).getDate(), 11, "30 days back inclusive = 11 Aug");
});

test("resolveRange: a bare custom `to` date includes that whole day, and beats the preset", () => {
  const now = new Date(2026, 8, 9, 15, 30);
  const r = resolveRange("30d", { from: "2026-09-01", to: "2026-09-03", now });
  assert.equal(r.preset, "custom");
  assert.equal(new Date(r.from).getDate(), 1);
  assert.equal(new Date(r.to).getDate(), 4, "exclusive end is the next midnight, so the 3rd counts");
});

test("resolveRange: an unknown preset falls back to 30d rather than throwing", () => {
  const r = resolveRange("nonsense", { now: new Date(2026, 8, 9) });
  assert.equal(r.preset, "30d");
  assert.equal(r.bucket, "day");
});

test("bucketKey: weeks start Monday; months collapse to YYYY-MM", () => {
  const wed = new Date(2026, 8, 9, 23, 30).toISOString(); // Wednesday
  assert.equal(bucketKey(wed, "day"), "2026-09-09");
  assert.equal(bucketKey(wed, "week"), "2026-09-07", "Monday of that week");
  assert.equal(bucketKey(wed, "month"), "2026-09");
  const mon = new Date(2026, 8, 7, 0, 5).toISOString();
  assert.equal(bucketKey(mon, "week"), "2026-09-07", "Monday is its own week start");
});

test("bucketsBetween: fills idle days and steps calendar months, not 30-day blocks", () => {
  const from = new Date(2026, 8, 1).toISOString();
  const to = new Date(2026, 8, 5).toISOString();
  assert.deepEqual(bucketsBetween(from, to, "day"), [
    "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
  ]);
  const yearFrom = new Date(2026, 0, 15).toISOString();
  const yearTo = new Date(2026, 3, 2).toISOString();
  assert.deepEqual(bucketsBetween(yearFrom, yearTo, "month"), ["2026-01", "2026-02", "2026-03", "2026-04"]);
});

test("stageOf: same taxonomy as runs.costReport", () => {
  assert.equal(stageOf("plan:ABC-1"), "plan");
  assert.equal(stageOf("ticket:ABC-1 build"), "build");
  assert.equal(stageOf("review:ABC-1"), "review");
  assert.equal(stageOf("nightly-backup"), "other");
});

// ── the pass ──────────────────────────────────────────────────────────────────────────────────

test("analytics: runs and terminals are summed once each, never cross-attributed", () => {
  const w = ws("Alpha");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: w.id, at: at(2026, 9, 9, 10), cost: 3 });
  term({ ws: w.id, at: at(2026, 9, 9, 11), cost: 5 });

  const a = analytics({ preset: "today", now });
  assert.equal(a.totals.runs_usd, 3);
  assert.equal(a.totals.sessions_usd, 5);
  assert.equal(a.totals.usd, 8, "one honest total, no double count");
  assert.equal(a.totals.runs, 1);
  assert.equal(a.totals.sessions, 1);
  assert.equal(a.totals.turns, 7, "4 run turns + 3 terminal turns");

  const row = a.by_workspace.find((r) => r.workspace_id === w.id)!;
  assert.equal(row.usd, 8);
  assert.equal(row.runs_usd, 3);
  assert.equal(row.sessions_usd, 5);
  assert.equal(row.share, 100);
  assert.equal(row.name, "Alpha");
});

test("analytics: an estimated terminal is counted in the total but stays labelled as an estimate", () => {
  const w = ws("Beta");
  const now = new Date(2026, 8, 9, 18);
  term({ ws: w.id, at: at(2026, 9, 9, 9), cost: 4, estimated: true });
  term({ ws: w.id, at: at(2026, 9, 9, 10), cost: 6 });
  // A finished terminal the CLI never priced is a hole in the ledger, not a free one.
  term({ ws: w.id, at: at(2026, 9, 9, 11), cost: null });

  const a = analytics({ preset: "today", now });
  assert.equal(a.totals.usd, 10);
  assert.equal(a.totals.estimated_usd, 4);
  assert.equal(a.coverage.estimated_usd, 4);
  assert.equal(a.coverage.estimated_sessions, 1);
  assert.equal(a.coverage.unpriced_sessions, 1);
  assert.equal(a.coverage.priced_usd, 6, "priced dollars exclude the estimate");
});

test("analytics: buckets follow the LOCAL day, so a late-evening terminal stays on today", () => {
  const w = ws("Gamma");
  const now = new Date(2026, 8, 9, 23, 50);
  term({ ws: w.id, at: at(2026, 9, 9, 23), cost: 7 }); // 23:00 local — tomorrow in UTC at UTC-3

  const a = analytics({ preset: "today", now });
  assert.equal(a.totals.usd, 7, "still today's money");
  assert.equal(a.series.length, 1);
  assert.equal(a.series[0].bucket, "2026-09-09");
  assert.equal(a.series[0].usd, 7);
});

test("analytics: the series covers every bucket in the window, idle days included", () => {
  const w = ws("Delta");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: w.id, at: at(2026, 9, 7, 10), cost: 2 });
  run({ ws: w.id, at: at(2026, 9, 9, 10), cost: 4 });

  const a = analytics({ preset: "7d", now });
  assert.equal(a.series.length, 7);
  assert.deepEqual(a.series.map((p) => p.usd), [0, 0, 0, 0, 2, 0, 4], "3-9 Sep, two spending days");
  assert.equal(a.series.at(-1)!.bucket, "2026-09-09");
  assert.equal(a.series[0].bucket, "2026-09-03");
});

test("analytics: per-bucket workspace split feeds the stacked bars", () => {
  const a1 = ws("One");
  const a2 = ws("Two");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: a1.id, at: at(2026, 9, 9, 10), cost: 3 });
  term({ ws: a2.id, at: at(2026, 9, 9, 11), cost: 5 });

  const a = analytics({ preset: "today", now });
  assert.equal(a.series[0].by_ws[a1.id], 3);
  assert.equal(a.series[0].by_ws[a2.id], 5);
});

test("analytics: workspace filter narrows the window AND its previous-period comparison", () => {
  const mine = ws("Mine");
  const other = ws("Other");
  const now = new Date(2026, 8, 9, 18);
  // Previous 7-day window (27 Aug - 2 Sep) vs current (3-9 Sep).
  run({ ws: mine.id, at: at(2026, 8, 30, 10), cost: 10 });
  run({ ws: other.id, at: at(2026, 8, 30, 10), cost: 99 });
  run({ ws: mine.id, at: at(2026, 9, 8, 10), cost: 20 });
  run({ ws: other.id, at: at(2026, 9, 8, 10), cost: 99 });

  const a = analyticsWithDelta({ preset: "7d", workspace_id: mine.id, now });
  assert.equal(a.totals.usd, 20);
  assert.equal(a.previous.usd, 10, "the other client's spend never leaks into the comparison");
  assert.equal(a.delta.usd, 100, "+100%");
  assert.equal(a.by_workspace.length, 1);
});

test("analytics: outcomes and success rate come from run statuses only", () => {
  const w = ws("Eps");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: w.id, at: at(2026, 9, 9, 9), status: "success" });
  run({ ws: w.id, at: at(2026, 9, 9, 10), status: "success" });
  run({ ws: w.id, at: at(2026, 9, 9, 11), status: "failed" });
  run({ ws: w.id, at: at(2026, 9, 9, 12), status: "interrupted" });

  const a = analytics({ preset: "today", now });
  assert.equal(a.totals.ok, 2);
  assert.equal(a.totals.failed, 1);
  assert.equal(a.totals.success_rate, 67, "interrupted is neither a pass nor a fail");
  assert.equal(a.outcomes.interrupted, 1);
});

test("analytics: stage, model and opener breakdowns split the same dollars", () => {
  const w = ws("Zeta");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: w.id, at: at(2026, 9, 9, 9), cost: 3, name: "plan:ABC-1", model: "sonnet" });
  run({ ws: w.id, at: at(2026, 9, 9, 10), cost: 5, name: "ticket:ABC-1 build", model: "opus" });
  term({ ws: w.id, at: at(2026, 9, 9, 11), cost: 2, agent: "robert" });

  const a = analytics({ preset: "today", now });
  assert.equal(a.by_stage.find((s) => s.stage === "plan")!.usd, 3);
  assert.equal(a.by_stage.find((s) => s.stage === "build")!.usd, 5);
  assert.equal(a.by_stage.reduce((t, s) => t + s.usd, 0), 8, "stages cover the headless half exactly");
  assert.equal(a.by_model.find((m) => m.model === "opus")!.usd, 5);
  assert.equal(a.by_opener.find((o) => o.opener === "robert")!.usd, 2);
  assert.equal(a.top_jobs[0].job, "ticket:ABC-1 build");
  assert.equal(a.top_terminals[0].usd, 2);
});

test("analytics: a live terminal is counted, its window is measured to now, and it is not 'unpriced'", () => {
  const w = ws("Eta");
  const now = new Date(2026, 8, 9, 18);
  term({ ws: w.id, at: at(2026, 9, 9, 9), cost: null, ended: null });

  const a = analytics({ preset: "today", now });
  assert.equal(a.totals.sessions, 1);
  assert.equal(a.totals.live_sessions, 1);
  assert.equal(a.coverage.unpriced_sessions, 0, "a running terminal has not failed to be priced yet");
});

test("analytics: unscoped work lands in its own row rather than being dropped", () => {
  const now = new Date(2026, 8, 9, 18);
  run({ at: at(2026, 9, 9, 10), cost: 4 });

  const a = analytics({ preset: "today", now });
  const row = a.by_workspace.find((r) => r.workspace_id === "")!;
  assert.ok(row, "unscoped runs are visible");
  assert.equal(row.name, "Unscoped");
  assert.equal(row.usd, 4);
});

test("analytics: an empty window returns a full, zeroed shape rather than nothing", () => {
  const now = new Date(2026, 8, 9, 18);
  const a = analytics({ preset: "7d", now });
  assert.equal(a.totals.usd, 0);
  assert.equal(a.totals.success_rate, null);
  assert.equal(a.series.length, 7);
  assert.deepEqual(a.by_workspace, []);
  assert.deepEqual(a.top_terminals, []);
});

test("analytics: a scoped caller never learns the other clients exist", () => {
  const mine = ws("Mine");
  const other = ws("Other");
  const now = new Date(2026, 8, 9, 18);
  run({ ws: mine.id, at: at(2026, 9, 9, 10), cost: 1 });
  run({ ws: other.id, at: at(2026, 9, 9, 10), cost: 9 });

  const scoped = analytics({ preset: "today", workspace_id: mine.id, scope_ws: mine.id, now });
  assert.deepEqual(scoped.workspaces.map((w) => w.id), [mine.id], "roster is trimmed to the caller");

  // The operator filtering to one client still needs the full strip to draw the filter chips.
  const operator = analytics({ preset: "today", workspace_id: mine.id, now });
  assert.equal(operator.workspaces.length, 2);
});
