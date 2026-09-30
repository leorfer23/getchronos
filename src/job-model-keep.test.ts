import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, jobs, workspaces } from "./store.js";
import { ensureTriageJob } from "./slack.js";
import { ensureCleanupJob, CLEANUP_PREFIX } from "./inbox-cleanup.js";
import { reloadSchedules } from "./scheduler.js";

// A model the operator picks on the Desk Jobs page must survive the boot-time re-sync that rewrites
// the system jobs (slack-triage, inbox-cleanup) from their templates.

afterEach(() => { db.exec("DELETE FROM jobs; DELETE FROM workspaces;"); reloadSchedules(); });

const mkWs = () => workspaces.create({
  slug: "jm-" + randomUUID().slice(0, 8), name: "Acme", config_dir: `/tmp/mc-test/${randomUUID()}`,
  slack_config: { enabled: true, triage: true },
} as any);

for (const [kind, ensure, prefix] of [
  ["slack-triage", ensureTriageJob, "slack-triage:"],
  ["inbox-cleanup", ensureCleanupJob, CLEANUP_PREFIX],
] as const) {
  test(`${kind}: a CLI + model picked on the Jobs page outlives a re-sync; the goal still refreshes`, () => {
    const ws = mkWs();
    ensure(ws);
    const job = jobs.list().find((j) => j.name === prefix + ws.slug)!;
    assert.ok(job.model, "created with the template's default model");
    jobs.update(job.id, { backend: "grok", model: "grok-4.5", goal: "stale" } as any);
    ensure(ws);
    const after = jobs.get(job.id)!;
    assert.equal(after.model, "grok-4.5");
    assert.equal(after.backend, "grok");
    assert.notEqual(after.goal, "stale", "everything else is still the template's");
  });
}
