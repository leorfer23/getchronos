import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, tickets } from "./store.js";
import { activeBuildSlots, shouldGrade } from "./autoplan.js";
import { CONFIG } from "./config.js";

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

function seedTicket(wsId: string, key: string, statusSource: "local" | "external") {
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(), title: `${key} title`,
    status: "in_progress", status_source: statusSource, priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
}

test("activeBuildSlots: a tracker-mirrored in_progress ticket doesn't eat a real build slot", () => {
  const ws = workspaces.create({ slug: "ap-" + randomUUID().slice(0, 8), name: "Autoplan ws", config_dir: "/tmp/ap" } as any);
  assert.equal(activeBuildSlots(ws.id), CONFIG.buildConcurrencyPerWs, "no tickets in flight → full capacity");

  seedTicket(ws.id, "AP-1", "external"); // ClickUp/Jira mirror, no agent on it
  assert.equal(activeBuildSlots(ws.id), CONFIG.buildConcurrencyPerWs, "mirror ticket must not consume a slot");

  seedTicket(ws.id, "AP-2", "local"); // Chronos is genuinely building this one
  assert.equal(activeBuildSlots(ws.id), CONFIG.buildConcurrencyPerWs - 1, "real in-flight work does consume a slot");
});

test("shouldGrade: skips entirely when complexity_source is 'human' — the operator's call is authoritative", () => {
  const wsOn = { auto_grade: true };
  const wsOff = { auto_grade: false };

  // Not planned yet → never grade regardless of source.
  assert.equal(shouldGrade({ status: "backlog", complexity_source: null }, wsOn), false);

  // ws opted out of auto_grade → never grade even on a fresh plan.
  assert.equal(shouldGrade({ status: "planned", complexity_source: null }, wsOff), false);

  // Normal second-pass flow: ungraded or scout-graded tickets still get graded.
  assert.equal(shouldGrade({ status: "planned", complexity_source: null }, wsOn), true);
  assert.equal(shouldGrade({ status: "planned", complexity_source: "scout" }, wsOn), true);

  // The operator set it by hand → grading never runs, not even to "double check".
  assert.equal(shouldGrade({ status: "planned", complexity_source: "human" }, wsOn), false);

  // No ticket / no workspace found → safe false, not a throw.
  assert.equal(shouldGrade(undefined, wsOn), false);
  assert.equal(shouldGrade({ status: "planned", complexity_source: null }, undefined), false);
});
