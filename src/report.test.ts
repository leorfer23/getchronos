import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, jobs, runs, tickets, reviews, connectorSyncs } from "./store.js";
import { buildReport } from "./report.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM reviews; DELETE FROM tickets; DELETE FROM connector_syncs; DELETE FROM workspaces;"
  );
});

const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-07-31T23:59:59.999Z";

function seedRun(jobId: string, startedAt: string, status: string, cost = 0, tin = 0, tout = 0) {
  const r = runs.create(jobId, "manual");
  runs.patch(r.id, { started_at: startedAt, status, cost_usd: cost, tokens_in: tin, tokens_out: tout } as any);
  return r;
}
function seedTicket(wsId: string, key: string, o: Partial<any> = {}) {
  return tickets.create({
    id: key.toLowerCase(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(),
    title: `${key} title`, status: "backlog", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null,
    external_url: null, tags: null, ...o,
  } as any);
}

test("composes shipped / in-flight / builds / reviews / cost with the window", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });

  const shipped = seedTicket(ws.id, "AB-1", { status: "done", priority: "P1" });
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run("2026-07-10T00:00:00.000Z", shipped.id);
  seedTicket(ws.id, "AB-2", { status: "in_progress", priority: "P0" });
  seedTicket(ws.id, "AB-3", { status: "backlog" }); // backlog excluded from in-flight
  const oldDone = seedTicket(ws.id, "AB-4", { status: "done" });
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run("2026-06-01T00:00:00.000Z", oldDone.id); // out of window

  const build = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id });
  const okRun = seedRun(build.id, "2026-07-05T10:00:00.000Z", "success", 4.0, 5000, 900);
  seedRun(build.id, "2026-07-06T10:00:00.000Z", "failed", 0.1, 500, 100);
  seedRun(build.id, "2026-06-01T10:00:00.000Z", "success", 9.9, 1, 1); // out of window

  const rev = reviews.create({ run_id: okRun.id, ticket_id: shipped.id, diff_ref: null });
  reviews.setState(rev.id, "approved", "ok", "human");
  db.prepare("UPDATE reviews SET reviewed_at = ? WHERE id = ?").run("2026-07-10T00:00:00.000Z", rev.id);

  const { markdown, summary } = buildReport(ws.id, FROM, TO);

  assert.match(markdown, /# Acme — Weekly Report/);
  assert.match(markdown, /\*\*AB-1\*\* AB-1 title _\(P1\)_/); // shipped
  assert.match(markdown, /\*\*AB-2\*\* AB-2 title — in_progress/); // in flight
  assert.doesNotMatch(markdown, /AB-3/); // backlog excluded
  assert.doesNotMatch(markdown, /AB-4/); // out-of-window done excluded
  assert.match(markdown, /2 builds run · 50% success \(1\/2\)/);
  assert.match(markdown, /Approved 1 · Changes requested 0 · Merged 0/);
  assert.match(markdown, /1 human · 0 automated/);
  assert.match(markdown, /— internal —/);
  assert.match(markdown, /\*\*Headless\*\* \| \| \*\*\$4\.10\*\*/);
  assert.match(markdown, /\*\*Combined total: \$4\.10\*\*/);

  assert.equal(summary.shipped, 1);
  assert.equal(summary.inFlight, 1);
  assert.deepEqual(summary.builds, { ok: 1, total: 2 });
  assert.equal(summary.reviews.approved, 1);
  assert.equal(summary.costTotal.toFixed(2), "4.10");
  assert.equal(summary.costRuns, 4.1);
  assert.equal(summary.costSessions, 0);
});

test("empty workspace renders the graceful placeholders", () => {
  const ws = workspaces.create({ slug: "empty", name: "Empty", config_dir: "/tmp/empty" });
  const { markdown, summary } = buildReport(ws.id, FROM, TO);
  assert.match(markdown, /_Nothing shipped this period._/);
  assert.match(markdown, /_Nothing in flight._/);
  assert.match(markdown, /_No builds this period._/);
  assert.match(markdown, /_No reviews this period._/);
  assert.equal(summary.costTotal, 0);
});

test("ai:reviewer verdicts count as automated; sync note appears when present", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const t = seedTicket(ws.id, "AB-1", { status: "done" });
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run("2026-07-10T00:00:00.000Z", t.id);
  const build = jobs.create({ name: "ticket:AB-1", goal: "g", workspace_id: ws.id });
  const r = seedRun(build.id, "2026-07-05T10:00:00.000Z", "success", 1, 1, 1);
  const rev = reviews.create({ run_id: r.id, ticket_id: t.id, diff_ref: null });
  reviews.setState(rev.id, "changes_requested", "fix", "ai:reviewer");
  db.prepare("UPDATE reviews SET reviewed_at = ? WHERE id = ?").run("2026-07-10T00:00:00.000Z", rev.id);
  connectorSyncs.add({ workspace_id: ws.id, connector: "clickup", pulled: 3, created: 1, updated: 2, pushed: 0 });

  const { markdown, summary } = buildReport(ws.id, FROM, TO);
  assert.match(markdown, /0 human · 1 automated/);
  assert.match(markdown, /Last synced via clickup/);
  assert.equal(summary.reviews.ai, 1);
});
