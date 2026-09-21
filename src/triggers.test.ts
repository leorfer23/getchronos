import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, jobs, triggers } from "./store.js";
import { setExecutor } from "./dispatcher.js";
import { matchCondition, matchFilter, getPath, fireTrigger } from "./triggers.js";
import type { TriggerCondition } from "./types.js";

const event = {
  method: "POST",
  headers: { "x-source": "cloudflare" },
  body: { alert_type: "http_5xx_spike", count: 42, tags: ["prod", "api"], msg: "errors rising" },
};

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM triggers; DELETE FROM jobs;");
});
afterEach(() => setExecutor(null));

test("getPath resolves nested dot-paths", () => {
  assert.equal(getPath(event, "body.alert_type"), "http_5xx_spike");
  assert.equal(getPath(event, "headers.x-source"), "cloudflare");
  assert.equal(getPath(event, "body.nope"), undefined);
  assert.equal(getPath(event, "body.deep.missing"), undefined);
});

test("matchCondition covers each operator", () => {
  const cases: Array<[TriggerCondition, boolean]> = [
    [{ path: "body.alert_type", op: "equals", value: "http_5xx_spike" }, true],
    [{ path: "body.alert_type", op: "equals", value: "other" }, false],
    [{ path: "body.msg", op: "contains", value: "rising" }, true],
    [{ path: "body.tags", op: "contains", value: "prod" }, true],
    [{ path: "body.tags", op: "contains", value: "staging" }, false],
    [{ path: "body.alert_type", op: "regex", value: "^http_\\d?xx" }, true],
    [{ path: "body.count", op: "gt", value: 10 }, true],
    [{ path: "body.count", op: "gt", value: 100 }, false],
    [{ path: "body.count", op: "lt", value: 100 }, true],
    [{ path: "body.alert_type", op: "exists" }, true],
    [{ path: "body.missing", op: "exists" }, false],
  ];
  for (const [cond, expected] of cases) {
    assert.equal(matchCondition(cond, event), expected, `${cond.path} ${cond.op} ${cond.value}`);
  }
});

test("matchFilter ANDs conditions; empty filter matches all", () => {
  assert.equal(matchFilter(null, event), true);
  assert.equal(matchFilter([], event), true);
  assert.equal(
    matchFilter(
      [
        { path: "body.alert_type", op: "equals", value: "http_5xx_spike" },
        { path: "body.count", op: "gt", value: 10 },
      ],
      event
    ),
    true
  );
  assert.equal(
    matchFilter(
      [
        { path: "body.alert_type", op: "equals", value: "http_5xx_spike" },
        { path: "body.count", op: "gt", value: 1000 }, // fails -> whole filter fails
      ],
      event
    ),
    false
  );
});

test("regex with invalid pattern is safe (no throw, no match)", () => {
  assert.equal(matchCondition({ path: "body.msg", op: "regex", value: "(" }, event), false);
});

test("fireTrigger dispatches on match, injects context, bumps fire_count", () => {
  let seenContext: string | null | undefined;
  setExecutor(async () => "success"); // don't spawn; we assert on the run row synchronously
  const job = jobs.create({ name: "responder", goal: "handle the alert" });
  const trig = triggers.create({
    name: "cf-5xx",
    job_id: job.id,
    inject: "goal",
    filter: [{ path: "body.alert_type", op: "equals", value: "http_5xx_spike" }],
  });

  const res = fireTrigger(trig, event);
  assert.equal(res.matched, true);
  assert.ok(res.run_id);

  const run = runs_get(res.run_id!);
  assert.equal(run.trigger_src, "trigger:cf-5xx");
  assert.ok(run.context && run.context.includes("http_5xx_spike"), "event body injected as context");
  seenContext = run.context;
  assert.ok(seenContext);

  const after = triggers.get(trig.id)!;
  assert.equal(after.fire_count, 1);
  assert.ok(after.last_fired_at);
});

test("fireTrigger does not dispatch when filter fails", () => {
  const job = jobs.create({ name: "responder2", goal: "x" });
  const trig = triggers.create({
    name: "only-staging",
    job_id: job.id,
    filter: [{ path: "body.alert_type", op: "equals", value: "never-matches" }],
  });
  const res = fireTrigger(trig, event);
  assert.equal(res.matched, false);
  assert.equal(res.run_id, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM runs").get().c, 0);
  assert.equal(triggers.get(trig.id)!.fire_count, 0);
});

test("inject 'none' fires without context", () => {
  setExecutor(async () => "success");
  const job = jobs.create({ name: "responder3", goal: "x" });
  const trig = triggers.create({ name: "plain", job_id: job.id, inject: "none" });
  const res = fireTrigger(trig, event);
  assert.equal(res.matched, true);
  assert.equal(runs_get(res.run_id!).context, null);
});

test("http trigger gets a unique token", () => {
  const job = jobs.create({ name: "j", goal: "x" });
  const a = triggers.create({ name: "a", job_id: job.id });
  const b = triggers.create({ name: "b", job_id: job.id });
  assert.ok(a.token && a.token.length >= 32);
  assert.notEqual(a.token, b.token);
  assert.equal(triggers.getByToken(a.token!)!.id, a.id);
});

// helper: read a run row
function runs_get(id: string): any {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
}
