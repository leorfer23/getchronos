/**
 * The data diff's rules (src/data-diff.ts): which repo is a data repo, which files move a table's
 * numbers, and what a data PR's hand-off must carry — rows and key aggregates before vs after over a
 * bounded range, the commands, the model's own tests run (not compiled), and every big swing explained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changedModels, classifyDataRepo, dataRepoOf, isTransformPath, judgeDataDiff, measureNumber, normalizeDataDiff, probeCheckout, swingPct,
  type DataRepoKind,
} from "./data-diff.js";

const tmp = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "data-repo-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
};

test("a data repo: a dbt project, an Airflow dags/ folder (also one level down), or the operator's setting", () => {
  assert.deepEqual(probeCheckout(tmp({ "dbt_project.yml": "name: shop" })), { dbtProject: true, dags: false });
  assert.deepEqual(probeCheckout(tmp({ "pipelines/dags/daily.py": "" })), { dbtProject: false, dags: true }, "a monorepo of DAG folders");
  assert.deepEqual(probeCheckout(tmp({ "transform/dbt_project.yml": "" })), { dbtProject: true, dags: false });
  assert.deepEqual(probeCheckout(tmp({ "src/app.ts": "", "a/b/dags/x.py": "" })), { dbtProject: false, dags: false }, "deeper than one level is not looked at");
  assert.deepEqual(probeCheckout("/no/such/checkout"), { dbtProject: false, dags: false });

  assert.equal(dataRepoOf({ path: tmp({ "dbt_project.yml": "" }), data_repo: null }, []).data, true);
  assert.equal(dataRepoOf({ path: tmp({ "src/app.ts": "" }), data_repo: null }, ["src/app.ts"]).data, false);
  assert.equal(dataRepoOf({ path: tmp({ "src/app.ts": "" }), data_repo: 1 }, []).data, true, "the setting says so");
  const off = dataRepoOf({ path: tmp({ "dbt_project.yml": "" }), data_repo: 0 }, []);
  assert.equal(off.data, false, "and the setting can say it is not");
  assert.match(off.why, /setting says it is not/);
  // No checkout on this computer: the PR's own files are the signal.
  assert.equal(classifyDataRepo({ setting: null, dbtProject: false, dags: false, files: ["dags/daily.py"] }).data, true);
  assert.equal(classifyDataRepo({ setting: null, dbtProject: false, dags: false, files: ["models/x.sql", "dbt_project.yml"] }).dbt, true);
  assert.equal(classifyDataRepo({ setting: null, dbtProject: false, dags: false, files: ["src/deep/dags/x.py"] }).data, false);
});

test("what moves a table's numbers: SQL, dbt models and seeds, DAG code — never tests or docs", () => {
  for (const f of ["models/marts/fct_orders.sql", "macros/cents.sql", "models/py/score.py", "seeds/fx.csv", "pipelines/dags/daily_report.py", "sql/report.sqlx"]) assert.ok(isTransformPath(f), f);
  for (const f of ["tests/assert_positive.sql", "models/marts/schema.yml", "README.md", "analyses/adhoc.sql", "dags/tests/test_daily.py", "src/app.ts", "dags/daily_test.py"]) assert.ok(!isTransformPath(f), f);
  assert.deepEqual(changedModels(["models/marts/fct_orders.sql", "models/py/Score.py", "macros/cents.sql", "tests/x.sql"]).sort(), ["fct_orders", "score"]);
});

test("the filed diff is read leniently: numbers as the agent wrote them, bad parts dropped, never the whole", () => {
  assert.equal(measureNumber("12,400"), 12400);
  assert.equal(measureNumber("12.5%"), 12.5);
  assert.equal(measureNumber("$1.2k"), 1200);
  assert.equal(measureNumber("n/a"), null);
  assert.equal(normalizeDataDiff(null), null);
  assert.equal(normalizeDataDiff({ unrelated: true }), null);
  const d = normalizeDataDiff({
    range: "2026-10-01..2026-10-07",
    models: [{ name: "fct_orders", rows: { before: "1,200", after: 1188 }, aggregates: [{ name: "sum(amount)", before: 10, after: 11 }, "junk"], query: "select 1" }, { nope: 1 }],
    tests: "dbt build -s fct_orders",
  })!;
  assert.equal(d.models.length, 1, "a model with no name is dropped");
  assert.deepEqual(d.models[0].rows, { name: "rows", before: 1200, after: 1188, explain: null });
  assert.equal(d.models[0].aggregates.length, 1);
  assert.equal(d.models[0].cmd, "select 1");
  assert.deepEqual(d.tests, [{ cmd: "dbt build -s fct_orders", result: null }]);
  assert.equal(Math.round(swingPct(12400, 56300)), 354);
  assert.equal(swingPct(0, 5), Infinity);
  assert.equal(swingPct(0, 0), 0);
});

const DBT: DataRepoKind = { data: true, dbt: true, why: "a dbt project (dbt_project.yml)" };
const AIRFLOW: DataRepoKind = { data: true, dbt: false, why: "an Airflow repo (a dags/ directory)" };
const APP: DataRepoKind = { data: false, dbt: false, why: "no dbt_project.yml, no Airflow dags/ directory, and no repo setting saying it is a data repo" };
const good = () => normalizeDataDiff({
  range: "2026-10-01..2026-10-07",
  models: [{ name: "analytics.core.fct_orders", rows: { before: 1200, after: 1188 }, aggregates: [{ name: "sum(amount)", before: 52340.5, after: 52101 }], cmd: "select count(*), sum(amount) from fct_orders where day between …" }],
  tests: [{ cmd: "dbt build -s fct_orders", result: "Done. PASS=12 WARN=0 ERROR=0 SKIP=0 TOTAL=12" }],
});

test("n/a where it does not apply: not a data repo, or nothing in the diff moves a table — never a pass, never owed", () => {
  const app = judgeDataDiff({ repo: APP, files: ["models/x.sql"], diff: null, swingLimit: 20 });
  assert.equal(app.status, "na");
  assert.match(app.note, /not a data repo/);
  const docs = judgeDataDiff({ repo: DBT, files: ["models/schema.yml", "README.md"], diff: null, swingLimit: 20 });
  assert.equal(docs.status, "na");
  assert.match(docs.note, /no model, SQL or transform changed/);
  assert.equal(judgeDataDiff({ repo: DBT, files: null, diff: null, swingLimit: 20 }).status, "skip", "file list unknown: not decided");
});

test("a data PR with no data diff fails, told what to file and that it measures with its own warehouse tools", () => {
  const c = judgeDataDiff({ repo: DBT, files: ["models/marts/fct_orders.sql"], diff: null, swingLimit: 20 });
  assert.equal(c.status, "fail");
  assert.equal(c.tellable, true);
  assert.match(c.note, /has no data diff/);
  assert.match(c.note, /--data-diff/);
  assert.match(c.note, /own warehouse tools and vars \(`mc vars`\)/);
});

test("a complete diff passes: every changed model, rows + aggregates, a bounded range, the commands, dbt build green", () => {
  const c = judgeDataDiff({ repo: DBT, files: ["models/marts/fct_orders.sql", "models/marts/schema.yml"], diff: good(), swingLimit: 20 });
  assert.equal(c.status, "pass", c.note);
  assert.match(c.note, /1 model: rows \+ 1 aggregate over 2026-10-01\.\.2026-10-07/);
  assert.match(c.note, /nothing moved past ±20%/);
  assert.ok(c.evidence!.some((e) => e.ref === "model:analytics.core.fct_orders" && String(e.meta?.rows).startsWith("1,200 → 1,188")));
});

test("what is missing is each said: an uncovered model, no range, no command, no aggregate", () => {
  const d = normalizeDataDiff({ models: [{ name: "fct_orders", rows: { before: 1, after: 1 } }], tests: [{ cmd: "dbt build", result: "PASS=3 ERROR=0" }] })!;
  const c = judgeDataDiff({ repo: DBT, files: ["models/fct_orders.sql", "models/dim_users.sql"], diff: d, swingLimit: 20 });
  assert.equal(c.status, "fail");
  for (const re of [/no before\/after for model dim_users/, /bounded range/, /fct_orders: no key aggregate/, /fct_orders: no query or command/]) assert.match(c.note, re);
});

test("a swing past the threshold is a fail until it is explained — the threshold is the caller's (the setting)", () => {
  // A daily table's minutes jump several-fold after a fix while its rows stay the same.
  const raw = {
    range: "2026-09-20..2026-09-22",
    models: [{ name: "daily_activity", rows: { before: 3, after: 3 }, aggregates: [{ name: "active_minutes", before: 12400, after: 56300 }], cmd: "select day, sum(active_minutes) …" }],
  };
  const bad = judgeDataDiff({ repo: AIRFLOW, files: ["pipelines/dags/daily_activity.py"], diff: normalizeDataDiff(raw), swingLimit: 20 });
  assert.equal(bad.status, "fail");
  assert.match(bad.note, /daily_activity\.active_minutes moved 12,400 → 56,300 \(\+354%\), past ±20%, unexplained/);
  const roomy = judgeDataDiff({ repo: AIRFLOW, files: ["pipelines/dags/daily_activity.py"], diff: normalizeDataDiff(raw), swingLimit: 400 });
  assert.equal(roomy.status, "pass", "within a looser threshold it is not a swing");
  raw.models[0].aggregates[0] = { ...raw.models[0].aggregates[0], explain: "late close events now count toward a session's full length; checked against the raw events" } as any;
  const ok = judgeDataDiff({ repo: AIRFLOW, files: ["pipelines/dags/daily_activity.py"], diff: normalizeDataDiff(raw), swingLimit: 20 });
  assert.equal(ok.status, "pass", ok.note);
  assert.match(ok.note, /explained: daily_activity\.active_minutes \+354% — late close events/);
  // A model-wide explanation covers every one of its numbers; a table that appears from nothing is a swing too.
  const fresh = normalizeDataDiff({ range: "2026-10-01..2026-10-02", models: [{ name: "new_table", rows: { before: 0, after: 40 }, aggregates: [{ name: "sum(x)", before: 0, after: 9 }], cmd: "q", explain: "a new table: nothing before" }] });
  assert.equal(judgeDataDiff({ repo: AIRFLOW, files: ["dags/new_table.py"], diff: fresh, swingLimit: 20 }).status, "pass");
});

test("dbt: only compile is not testing; a failed build fails; a green dbt CI check counts as the tests run", () => {
  const files = ["models/marts/fct_orders.sql"];
  const compiled = good()!;
  compiled.tests = [{ cmd: "dbt compile -s fct_orders", result: "ok" }];
  const c1 = judgeDataDiff({ repo: DBT, files, diff: compiled, swingLimit: 20 });
  assert.equal(c1.status, "fail");
  assert.match(c1.note, /only `dbt compile` ran — compiling is not testing/);
  const failed = good()!;
  failed.tests = [{ cmd: "dbt build -s fct_orders+", result: "Done. PASS=10 WARN=0 ERROR=2 SKIP=0 TOTAL=12" }];
  assert.match(judgeDataDiff({ repo: DBT, files, diff: failed, swingLimit: 20 }).note, /the dbt run failed/);
  const none = good()!;
  none.tests = [];
  assert.match(judgeDataDiff({ repo: DBT, files, diff: none, swingLimit: 20 }).note, /the model's own tests did not run/);
  const ci = judgeDataDiff({ repo: DBT, files, diff: none, swingLimit: 20, ciPassing: ["lint", "dbt Cloud CI"] });
  assert.equal(ci.status, "pass", ci.note);
  assert.match(ci.note, /dbt ran in CI \(dbt Cloud CI, green\)/);
  const quiet = good()!;
  quiet.tests = [{ cmd: "dbt build -s fct_orders", result: null }];
  assert.match(judgeDataDiff({ repo: DBT, files, diff: quiet, swingLimit: 20 }).note, /a run with no result is a claim/);
  // A warehouse's quoted name still covers the model.
  const quoted = good()!;
  quoted.models[0].name = "`proj.analytics.fct_orders`";
  assert.equal(judgeDataDiff({ repo: DBT, files, diff: quoted, swingLimit: 20 }).status, "pass");
  // An Airflow repo has no dbt models: its data diff stands on the numbers and their commands.
  const airflow = good()!;
  airflow.tests = [];
  assert.equal(judgeDataDiff({ repo: AIRFLOW, files: ["dags/orders.py"], diff: airflow, swingLimit: 20 }).status, "pass");
});
