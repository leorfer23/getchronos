import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, activity, jobs, runs } from "./store.js";
import { bus } from "./bus.js";
import { startActivity } from "./activity.js";

startActivity(); // registers the single bus listener for this process

const count = () => (db.prepare("SELECT COUNT(*) c FROM activity").get() as { c: number }).c;
const last = () => db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 1").get() as any;

beforeEach(() => {
  db.exec("DELETE FROM activity; DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs;");
});

test("persists a bus event with topic, entity, workspace and detail", () => {
  bus.publish({ topic: "ticket.created", ticket_id: "t1", workspace_id: "ws1" });
  const r = last();
  assert.equal(r.topic, "ticket.created");
  assert.equal(r.entity, "t1");
  assert.equal(r.workspace_id, "ws1");
  assert.equal(r.actor, "system");
  assert.match(r.detail, /t1/);
});

test("skips high-frequency run.event", () => {
  bus.publish({ topic: "run.event", run_id: "r1", event: {} });
  assert.equal(count(), 0);
});

test("derives ai:planner / ai:builder from the run's job name", () => {
  const plan = jobs.create({ name: "plan:AB-1", goal: "g" });
  const pr = runs.create(plan.id, "plan:AB-1");
  bus.publish({ topic: "run.started", run_id: pr.id, job_id: plan.id });
  assert.equal(last().actor, "ai:planner");

  const build = jobs.create({ name: "ticket:AB-1", goal: "g" });
  const br = runs.create(build.id, "ticket:AB-1");
  bus.publish({ topic: "run.started", run_id: br.id, job_id: build.id });
  assert.equal(last().actor, "ai:builder");
});

test("derives cron from trigger_src and honors an explicit actor", () => {
  const j = jobs.create({ name: "nightly", goal: "g" });
  const r = runs.create(j.id, "cron");
  bus.publish({ topic: "run.ended", run_id: r.id, status: "success" });
  assert.equal(last().actor, "cron");

  bus.publish({ topic: "review.updated", review_id: "rv1", state: "approved", actor: "ai:reviewer" });
  assert.equal(last().actor, "ai:reviewer");
});

test("prune keeps only the last N rows", () => {
  for (let i = 0; i < 6; i++) activity.add({ topic: "t", actor: "system" });
  activity.prune(3);
  assert.equal(count(), 3);
});
