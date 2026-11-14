/**
 * The data diff: what a data PR owes before the operator hears it (LEDGER.md → The verifier).
 *
 * A fix to a daily table can be green in every test and still move a metric four-fold: nobody sees it
 * until someone compares the numbers after the PR is open. So a PR that changes models, SQL or
 * transforms in a DATA repo hands off with the comparison itself — per changed model or table, its
 * rows and 1–3 key aggregates before vs after over a bounded range, the commands that produced them,
 * and (in a dbt project) the model's own tests run, not only compiled. A swing past the workspace's
 * threshold (setting verifier.data_swing_pct, ±20%) carries its explanation, or the hand-off fails.
 *
 * The agent measures it with its workspace's own warehouse tools and vars; the daemon never touches a
 * warehouse. It only reads what the hand-off filed (`mc outcome --data-diff diff.json`) and judges it.
 *
 * Pure but for `probeCheckout`, which reads a repo's own checkout to tell whether it is a data repo.
 */
import fs from "node:fs";
import path from "node:path";
import type { Evidence } from "./ledger-model.js";
import { isTestPath, type CheckResult } from "./verify-model.js";

// ───────────────────────────── what the hand-off files ─────────────────────────────

/** One number before and after: a row count or a key aggregate. null = not measured (a new or removed model). */
export type DataMeasure = { name: string; before: number | null; after: number | null; explain: string | null };
export type DataModel = {
  /** The model or table, as the warehouse names it (`fct_orders`, `analytics.core.fct_orders`). */
  name: string;
  rows: DataMeasure | null;
  aggregates: DataMeasure[];
  /** The query or command that produced its numbers (else the diff's shared `cmd`). */
  cmd: string | null;
  /** Why its numbers moved — covers every measure of the model. */
  explain: string | null;
  /** E.g. "new model: no before". */
  note: string | null;
};
export type DataTests = { cmd: string; result: string | null };
export type DataDiff = { range: string | null; cmd: string | null; models: DataModel[]; tests: DataTests[] };

const MAX_MODELS = 20;
const MAX_AGGREGATES = 5;
const MAX_TESTS = 6;
const clip = (v: unknown, n: number): string | null => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : "";
  return s ? (s.length > n ? s.slice(0, n - 1) + "…" : s) : null;
};
/** 12400 · "12,400" · "12.5%" · "$1.2k" are numbers here; anything else is not measured. */
export function measureNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = /^\s*[~≈]?\s*[$€£]?\s*(-?\d[\d,_ ]*(?:\.\d+)?)\s*(%|[kmb])?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1].replace(/[,_ ]/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  return unit === "k" ? n * 1e3 : unit === "m" ? n * 1e6 : unit === "b" ? n * 1e9 : n;
}
const measure = (v: any, fallbackName: string): DataMeasure | null => {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  return { name: clip(v.name, 120) ?? fallbackName, before: measureNumber(v.before), after: measureNumber(v.after), explain: clip(v.explain ?? v.why, 400) };
};

/**
 * What `mc outcome --data-diff` sent → the shape kept on the hand-off, or null when it is not a data
 * diff at all. Lenient like the rest of the hand-off: a bad part is dropped (the verifier then says
 * what is missing), never the whole hand-off.
 */
export function normalizeDataDiff(raw: unknown): DataDiff | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  const models = (Array.isArray(r.models) ? r.models : [])
    .filter((m: any) => m && typeof m === "object" && !Array.isArray(m) && clip(m.name ?? m.table ?? m.model, 160))
    .slice(0, MAX_MODELS)
    .map((m: any): DataModel => ({
      name: clip(m.name ?? m.table ?? m.model, 160)!,
      rows: measure(m.rows, "rows"),
      aggregates: (Array.isArray(m.aggregates) ? m.aggregates : [])
        .map((a: any, i: number) => measure(a, `aggregate ${i + 1}`))
        .filter((a: DataMeasure | null): a is DataMeasure => !!a)
        .slice(0, MAX_AGGREGATES),
      cmd: clip(m.cmd ?? m.query ?? m.command, 1500),
      explain: clip(m.explain ?? m.why, 400),
      note: clip(m.note, 200),
    }));
  const tl = Array.isArray(r.tests) ? r.tests : r.tests ? [r.tests] : [];
  const tests = tl
    .map((t: any): DataTests | null => (typeof t === "string" ? { cmd: clip(t, 400)!, result: null } : t && typeof t === "object" && clip(t.cmd ?? t.command, 400) ? { cmd: clip(t.cmd ?? t.command, 400)!, result: clip(t.result ?? t.output, 400) } : null))
    .filter((t: DataTests | null): t is DataTests => !!t && !!t.cmd)
    .slice(0, MAX_TESTS);
  if (!models.length && !tests.length && !clip(r.range, 120)) return null;
  return { range: clip(r.range, 120), cmd: clip(r.cmd ?? r.query, 1500), models, tests };
}

// ───────────────────────────── is it a data repo, does the PR change its data ─────────────────────────────

/** A path whose change can move a table's numbers: SQL, dbt models and seeds, Airflow DAG code. Tests and docs are not. */
export function isTransformPath(p: string): boolean {
  const f = p.toLowerCase();
  if (isTestPath(f)) return false;
  if (/\.(sql|sqlx)$/.test(f)) return !/(^|\/)(analyses|analysis|docs?)\//.test(f);
  if (/(^|\/)models\/.+\.py$/.test(f)) return true;
  if (/(^|\/)seeds\/.+\.csv$/.test(f)) return true;
  return /(^|\/)dags\/.+\.py$/.test(f);
}

/** The dbt models a diff touches, by name: `models/…/<name>.sql` (or .py). Macros, seeds and DAGs name no model. */
export function changedModels(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (!isTransformPath(f)) continue;
    const m = /(?:^|\/)models\/(?:.+\/)?([^/]+)\.(sql|sqlx|py)$/i.exec(f);
    if (m) out.add(m[1].toLowerCase());
  }
  return [...out];
}

export type DataRepoKind = { data: boolean; dbt: boolean; why: string };

/**
 * A data repo: it has a dbt_project.yml or an Airflow dags/ directory (at its root or one level down,
 * as in a monorepo of DAG folders), or the repo's own setting says so (`repos.data_repo`, the
 * operator's: true/false; null = decide from the checkout). The PR's own file list counts as a
 * checkout signal when the checkout is not on this computer.
 */
export function classifyDataRepo(sig: { setting: boolean | null; dbtProject: boolean; dags: boolean; files: string[] | null }): DataRepoKind {
  const files = sig.files ?? [];
  const dbt = sig.dbtProject || files.some((f) => /(^|\/)dbt_project\.yml$/i.test(f));
  const dags = sig.dags || files.some((f) => /^([^/]+\/)?dags\//i.test(f));
  if (sig.setting === false) return { data: false, dbt, why: "the repo's setting says it is not a data repo" };
  if (sig.setting === true) return { data: true, dbt, why: "the repo's setting says it is a data repo" };
  if (dbt) return { data: true, dbt, why: "a dbt project (dbt_project.yml)" };
  if (dags) return { data: true, dbt, why: "an Airflow repo (a dags/ directory)" };
  return { data: false, dbt, why: "no dbt_project.yml, no Airflow dags/ directory, and no repo setting saying it is a data repo" };
}

/** What a checkout on this disk shows: a dbt_project.yml or a dags/ dir at its root or one level down. */
export function probeCheckout(root: string | null | undefined): { dbtProject: boolean; dags: boolean } {
  const out = { dbtProject: false, dags: false };
  if (!root) return out;
  const look = (dir: string) => {
    try { if (fs.statSync(path.join(dir, "dbt_project.yml")).isFile()) out.dbtProject = true; } catch { /* none */ }
    try { if (fs.statSync(path.join(dir, "dags")).isDirectory()) out.dags = true; } catch { /* none */ }
  };
  try {
    if (!fs.statSync(root).isDirectory()) return out;
    look(root);
    for (const e of fs.readdirSync(root, { withFileTypes: true }).slice(0, 300)) {
      if (out.dbtProject && out.dags) break;
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") look(path.join(root, e.name));
    }
  } catch { /* unreadable: no signal */ }
  return out;
}

/** The repo row (if this workspace has one for the PR) and the PR's files → is it a data repo. */
export function dataRepoOf(repo: { path?: string | null; data_repo?: number | boolean | null } | null | undefined, files: string[] | null): DataRepoKind {
  const s = repo?.data_repo;
  const setting = s === null || s === undefined ? null : s === true || s === 1;
  return classifyDataRepo({ setting, ...probeCheckout(repo?.path), files });
}

// ───────────────────────────── the judgement ─────────────────────────────

/** The instruction every fail carries: what to file, and that the agent measures it with its own tools. */
export const DATA_DIFF_HOW =
  "file it on the hand-off: `mc outcome … --data-diff diff.json` — per changed model or table: rows and 1–3 key aggregates, before vs after, over a bounded range, " +
  "with the query or command behind them; in a dbt project also the `dbt build`/`dbt test` run on the changed models. Measure it with this workspace's own warehouse tools and vars (`mc vars`)";

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 100) / 100));
/** The move in percent of `before`; Infinity when something appears from zero. */
export function swingPct(before: number, after: number): number {
  if (before === after) return 0;
  if (before === 0) return Infinity;
  return ((after - before) / Math.abs(before)) * 100;
}
const pctText = (p: number) => (p === Infinity ? "from 0" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.round(Math.abs(p) * 10) / 10}%`);
const moveText = (m: DataMeasure) => (m.before == null || m.after == null ? `${m.before ?? "?"} → ${m.after ?? "?"}` : `${fmt(m.before)} → ${fmt(m.after)} (${pctText(swingPct(m.before, m.after))})`);

const DBT_RAN = /\bdbt\b[^|;&]*\b(build|test)\b/i;
const DBT_COMPILE = /\bdbt\b[^|;&]*\bcompile\b/i;
const RUN_FAILED = /\berror\s*=\s*[1-9]|\bfail(?:ed|ures?)?\s*=\s*[1-9]|completed with [1-9]\d* errors?|\b[1-9]\d* (?:tests? )?fail(?:ed|ures?)\b/i;

/**
 * data_diff, for one PR. `na` when it does not apply (not a data repo, or nothing in the diff moves a
 * table's numbers); `skip` when the file list is unknown; otherwise the filed diff is complete, the
 * model's tests ran, and every swing past `swingLimit` percent is explained — or it fails, told back.
 * `ciPassing` = the PR's green CI checks: a dbt job among them counts as the model's tests run.
 */
export function judgeDataDiff(inp: { repo: DataRepoKind; files: string[] | null; diff: DataDiff | null; swingLimit: number; ciPassing?: string[] }): CheckResult {
  const na = (note: string): CheckResult => ({ name: "data_diff", status: "na", note });
  if (!inp.repo.data) return na(`n/a: not a data repo (${inp.repo.why})`);
  if (!inp.files) return { name: "data_diff", status: "skip", note: "the PR's file list could not be read — whether it changes models is unknown" };
  const transforms = inp.files.filter(isTransformPath);
  if (!transforms.length) return na(`n/a: a data repo (${inp.repo.why}), but no model, SQL or transform changed`);
  const touched = `${transforms.length} model/SQL/transform file${transforms.length === 1 ? "" : "s"} (${clip(transforms.slice(0, 4).join(", "), 160)})`;
  const fail = (problems: string[], evidence?: Evidence[]): CheckResult => ({
    name: "data_diff", status: "fail", tellable: true, evidence,
    note: `${clip(problems.join("; "), 600)} — ${DATA_DIFF_HOW}`,
  });
  const d = inp.diff;
  if (!d || !d.models.length) return fail([`this PR changes ${touched} in a data repo and the hand-off has no data diff`]);

  const problems: string[] = [];
  const evidence: Evidence[] = [];
  if (!d.range || !/\d/.test(d.range)) problems.push("say the bounded range it was measured over (e.g. 2026-10-01..2026-10-07)");
  const names = d.models.map((m) => m.name.toLowerCase().replace(/[`"'\[\]]/g, ""));
  const expected = changedModels(inp.files);
  for (const model of expected) {
    if (!names.some((n) => n === model || n.split(".").pop() === model)) problems.push(`no before/after for model ${model}`);
  }
  const limit = Math.max(0, inp.swingLimit);
  const explained: string[] = [];
  for (const m of d.models) {
    const meta: Record<string, string | number | boolean> = {};
    const measures = [...(m.rows ? [{ ...m.rows, name: "rows" }] : []), ...m.aggregates];
    if (!m.rows || ((m.rows.before == null || m.rows.after == null) && !m.note)) problems.push(`${m.name}: no row counts before and after`);
    if (!m.aggregates.length) problems.push(`${m.name}: no key aggregate (1–3: a sum, a distinct count, an average)`);
    if (!m.cmd && !d.cmd) problems.push(`${m.name}: no query or command behind its numbers`);
    for (const a of measures) {
      meta[a.name.slice(0, 60)] = moveText(a);
      if (a.before == null || a.after == null) {
        if (!m.note && a.name !== "rows") problems.push(`${m.name}.${a.name}: before and after are not both measured`);
        continue;
      }
      const p = swingPct(a.before, a.after);
      if (Math.abs(p) <= limit) continue;
      const why = a.explain ?? m.explain;
      if (why) explained.push(`${m.name}.${a.name} ${pctText(p)} — ${clip(why, 140)}`);
      else problems.push(`${m.name}.${a.name} moved ${moveText(a)}, past ±${limit}%, unexplained — say why in its "explain", or fix it`);
    }
    if (m.cmd) meta.cmd = clip(m.cmd, 300)!;
    if (m.explain) meta.explain = m.explain;
    if (m.note) meta.note = m.note;
    evidence.push({ ref: `model:${m.name}`, label: m.name, meta });
  }
  let testsNote = "";
  if (inp.repo.dbt) {
    const ran = d.tests.filter((t) => DBT_RAN.test(t.cmd));
    const ci = (inp.ciPassing ?? []).filter((n) => /\bdbt\b/i.test(n));
    const failed = ran.find((t) => RUN_FAILED.test(t.result ?? ""));
    const said = ran.find((t) => t.result);
    if (failed) problems.push(`the dbt run failed (${clip(failed.result, 160)})`);
    else if (said) testsNote = ` · ${clip(said.cmd, 80)} → ${clip(said.result, 80)}`;
    else if (ci.length) testsNote = ` · dbt ran in CI (${clip(ci.join(", "), 80)}, green)`;
    else if (ran.length) problems.push(`say what \`${clip(ran[0].cmd, 80)}\` printed (its PASS/ERROR summary) in its "result" — a run with no result is a claim`);
    else problems.push(d.tests.some((t) => DBT_COMPILE.test(t.cmd))
      ? "only `dbt compile` ran — compiling is not testing: run `dbt build -s <changed models>` (or `dbt test`) and file it under \"tests\""
      : "the model's own tests did not run — run `dbt build -s <changed models>` (or `dbt test`) and file it under \"tests\"");
    for (const t of d.tests) evidence.push({ ref: "tests", label: t.cmd, meta: { result: t.result ?? "" } });
  }
  if (problems.length) return fail(problems, evidence);
  const aggs = d.models.reduce((n, m) => n + m.aggregates.length, 0);
  return {
    name: "data_diff", status: "pass", evidence,
    note: clip(`${d.models.length} model${d.models.length === 1 ? "" : "s"}: rows + ${aggs} aggregate${aggs === 1 ? "" : "s"} over ${d.range}${testsNote}` +
      (explained.length ? ` · swings past ±${limit}%, explained: ${explained.join("; ")}` : ` · nothing moved past ±${limit}%`), 900)!,
  };
}
