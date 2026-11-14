/**
 * The weekly self-retro — Chronos reading its own week in one workspace, with numbers, and turning
 * what keeps going wrong into rules the operator approves with one tap.
 *
 *   gatherRetro(ws, run)   CODE. That workspace's terminals for the week, through its own `sessions`
 *                          rows (never a guess from a profile dir: several workspaces share one), their
 *                          claude transcripts (headless `sdk-cli` runs skipped), every typed turn told
 *                          apart — the operator's, or a line the daemon typed (turn-source.ts) — plus the
 *                          verifier's rounds, hand-offs and duplicate terminals from the DB. Out come the
 *                          stats and KPIs, a report, the candidates (his corrections and repeated asks),
 *                          proposals for verifier aspects rejected twice, and `findings`.
 *   retroContext / applyRetro   the job (agents/retro, on the workspace's OWN profile) reads the bundle
 *                          and hands back ≤5 one-line rules, each citing the candidates it answers, plus
 *                          notes. Nothing is written to memory here: a rule is a PENDING proposal.
 *   decideProposal         the operator's tap: approve → the rule lands in memory-index (rememberFact,
 *                          the same write as `mc remember`); dismiss → the row stays, so it never returns.
 *
 * `findings` is the one thing allowed out of a workspace: enum → count, built by findingsOf from code
 * enums, re-validated key by key by aggregateFindings before the product workspace sums them. No model
 * output, no operator text, no names ever go into it.
 */
import { createHash } from "node:crypto";
import { activity, db, notes as noteStore, sessions } from "./store.js";
import { inputMarks } from "./store/input-marks.js";
import { retroProposals, retroRuns, type ProposalSource, type RetroProposal, type RetroRun } from "./store/retro.js";
import { bus } from "./bus.js";
import { guard } from "./guard.js";
import { similarity } from "./text-similarity.js";
import { indexSections, INDEX_SLUG, LINE_CAP, rememberFact } from "./memory-tree.js";
import { entryHash } from "./memory-tiers.js";
import { transcriptFor } from "./session-usage.js";
import { CHECK_NAMES, type CheckName } from "./ledger-model.js";
import { ASPECTS } from "./verify-model.js";
import { classifyTurns, INJECT_KINDS, marksFor, normTurn, textKey, type InjectKind } from "./turn-source.js";
import {
  API_ERROR_CLASSES, clauses, clauseSimilarity, clusterSaid, duplicateTerminals, isCorrection, repeated, scanTranscript,
  TOOL_ERROR_CLASSES, type ApiErrorClass, type Cluster, type RawScan, type Said, type ToolErrorClass,
} from "./retro-scan.js";
import type { Session, Workspace } from "./types.js";

/** Where approved rules land in the memory index. */
export const RULE_TOPIC = "Operator rules";
export const RULES_PER_WEEK = 5;
export const PRODUCT_PER_WEEK = 3;
export const NOTES_CAP = 1200;
export const CANDIDATE_CAP = 30;
/** The same rule in other words — as text-similarity.ts reads it. */
const SAME_RULE = 0.6;
/** The operator's ask said again — clause similarity (retro-scan.ts). */
const SAME_ASK = 0.6;
/** A verifier aspect rejected this many times in a week becomes a proposal. */
const ASPECT_REPEAT = 2;
const MARK_KEEP_DAYS = 45;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const bump = <K extends string>(m: Partial<Record<K, number>>, k: K, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const parse = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
/** Last week's run: one whose week ended at least five days before this one's — a re-run of the same week is not "last week". */
const prevRun = (workspace_id: string, until: string) => retroRuns.latest(workspace_id, new Date(Date.parse(until) - 5 * 86_400_000).toISOString());

export class RetroError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) { super(message); }
}

// ───────────────────────────── shapes ─────────────────────────────

export interface RetroStats {
  window: { since: string; until: string };
  /** Terminals whose transcript was read. */
  sessions: number;
  /** …of them, the ones the operator typed in himself. */
  sessions_typed: number;
  /** No transcript, another CLI, a cloud agent, or a headless run. */
  sessions_skipped: number;
  operator_turns: number;
  /** Turns the daemon typed, by who (never counted as his). */
  injected: Partial<Record<InjectKind, number>>;
  handoffs: number;
  verifier: { rejections: number; generic: number; sessions: number; aspects: Partial<Record<CheckName, number>>; examples: string[] };
  infra: { revive: number; network: number; api_network: number; sessions_hit: number };
  api_errors: Partial<Record<ApiErrorClass, number>>;
  tool_errors: Partial<Record<ToolErrorClass, number>>;
  duplicates: number;
  corrections: number;
  repeats: { clusters: number; times: number; top: { text: string; count: number; sessions: number }[] };
  /** Approved rules whose ask came back after the approval: the rule did not hold. */
  rules_failed: { id: string; text: string; times: number }[];
}

export interface Candidate {
  id: string;
  kind: "correction" | "repeat";
  /** The shortest way he said it. */
  text: string;
  count: number;
  sessions: number;
  examples: string[];
}

export interface Kpis {
  /** Verifier rounds sent back per hand-off; null with no hand-off. */
  rejection_rate: number | null;
  rejections: number;
  handoffs: number;
  /** Times he asked for the same thing again. */
  repeat_asks: number;
  rules_failed: number;
  /** Revive nudges + network nudges + turns lost to the network. */
  infra: number;
  duplicates: number;
}

export function kpisOf(s: RetroStats): Kpis {
  return {
    rejection_rate: s.handoffs ? Math.round((s.verifier.rejections / s.handoffs) * 100) / 100 : null,
    rejections: s.verifier.rejections,
    handoffs: s.handoffs,
    repeat_asks: s.repeats.times,
    rules_failed: s.rules_failed.length,
    infra: s.infra.revive + s.infra.network + s.infra.api_network,
    duplicates: s.duplicates,
  };
}

// ───────────────────────────── findings: the only thing that may leave ─────────────────────────────

export const FINDING_PLAIN = [
  "sessions", "sessions_typed", "operator_turns", "handoffs", "corrections", "repeat_asks", "repeat_clusters",
  "duplicate_terminals", "rules_failed", "verifier_rejections", "verifier_generic",
] as const;
export const FINDING_ENUMS: Record<string, readonly string[]> = {
  verifier_aspect: CHECK_NAMES,
  injected: INJECT_KINDS,
  infra: ["revive", "network", "api_network", "sessions_hit"],
  api_error: API_ERROR_CLASSES,
  tool_error: TOOL_ERROR_CLASSES,
};

/** `name` or `name:member`, every part from the closed lists above. */
export function isFindingKey(k: string): boolean {
  if ((FINDING_PLAIN as readonly string[]).includes(k)) return true;
  const i = k.indexOf(":");
  if (i <= 0) return false;
  const list = Object.prototype.hasOwnProperty.call(FINDING_ENUMS, k.slice(0, i)) ? FINDING_ENUMS[k.slice(0, i)] : null;
  return !!list && list.includes(k.slice(i + 1));
}

/** A workspace's week as enum → count. Built from the stats' numbers and enum keys only — never their texts. */
export function findingsOf(s: RetroStats): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | undefined) => { if (v && isFindingKey(k)) out[k] = v; };
  put("sessions", s.sessions);
  put("sessions_typed", s.sessions_typed);
  put("operator_turns", s.operator_turns);
  put("handoffs", s.handoffs);
  put("corrections", s.corrections);
  put("repeat_asks", s.repeats.times);
  put("repeat_clusters", s.repeats.clusters);
  put("duplicate_terminals", s.duplicates);
  put("rules_failed", s.rules_failed.length);
  put("verifier_rejections", s.verifier.rejections);
  put("verifier_generic", s.verifier.generic);
  for (const [k, v] of Object.entries(s.verifier.aspects)) put(`verifier_aspect:${k}`, v);
  for (const [k, v] of Object.entries(s.injected)) put(`injected:${k}`, v);
  for (const [k, v] of Object.entries(s.infra)) put(`infra:${k}`, v);
  for (const [k, v] of Object.entries(s.api_errors)) put(`api_error:${k}`, v);
  for (const [k, v] of Object.entries(s.tool_errors)) put(`tool_error:${k}`, v);
  return out;
}

/**
 * The cross-workspace sum (product workspace only). Every key is re-checked against the closed lists
 * and every value must be a whole count: whatever a row holds, nothing but enum → number crosses.
 */
export function aggregateFindings(list: unknown[]): { workspaces: number; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let n = 0;
  for (const f of list) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    n++;
    for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
      if (!isFindingKey(k) || typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10_000_000) continue;
      counts[k] = (counts[k] ?? 0) + v;
    }
  }
  return { workspaces: n, counts };
}

// ───────────────────────────── the DB half of the week ─────────────────────────────

/** Verifier rounds typed back into this workspace's terminals, and which checks failed in each. */
export function verifierWeek(workspace_id: string, since: string, until: string): { at: string; names: CheckName[]; reason: string | null; session_id: string | null }[] {
  const rows = db.prepare(
    `SELECT request_id, session_id, reason, started_at, finished_at FROM request_verifications
     WHERE workspace_id = ? AND told = 1 AND started_at >= ? AND started_at < ? ORDER BY started_at`,
  ).all(workspace_id, since, until) as { request_id: string; session_id: string | null; reason: string | null; started_at: string; finished_at: string | null }[];
  const fails = db.prepare("SELECT DISTINCT name FROM request_checks WHERE request_id = ? AND status = 'fail' AND ran_at >= ? AND ran_at <= ?");
  return rows.map((r) => {
    const end = r.finished_at ?? new Date(Date.parse(r.started_at) + 3600_000).toISOString();
    const names = (fails.all(r.request_id, r.started_at, end) as { name: string }[])
      .map((x) => x.name).filter((n): n is CheckName => (CHECK_NAMES as readonly string[]).includes(n));
    return { at: r.started_at, names, reason: r.reason, session_id: r.session_id };
  });
}

/** Hand-offs (`mc outcome`) filed in the window, across these terminals. */
export function handoffsIn(rows: Session[], since: string, until: string): number {
  let n = 0;
  for (const s of rows) for (const o of [...(s.outcome_prev ?? []), ...(s.outcome ? [s.outcome] : [])]) if (o?.at && o.at >= since && o.at < until) n++;
  return n;
}

/** The rule a repeated verifier aspect turns into — code, so it needs no model and says exactly what the check wants. */
export function aspectRule(name: CheckName): string | null {
  const fixed: Partial<Record<CheckName, string>> = {
    matches_request: "Before `mc outcome`, re-read the operator's exact words and say in the hand-off how each thing he asked for is met.",
    tests: "Run the repo's own check command at the PR head and fix every failure before `mc outcome`.",
    pr_ready: "Hand off a PR only when it is open (not a draft), conflict-free, up to date with its base, and CI is not red.",
    goal_test: "Add or change a test that proves the goal in every backend PR.",
    shots: "Attach before/after screenshots at phone and desktop width to every UI hand-off.",
    walkthrough: "Walk a UI change step by step with `mc show` (one shot per step) before handing off.",
    draft_bound: "After changing a draft's words, announce it again so the version he approves is the one on file.",
  };
  if (fixed[name]) return fixed[name]!;
  for (const [kind, list] of Object.entries(ASPECTS)) {
    const a = list?.find((x) => x.name === name);
    if (a) return clip(`Before handing off ${kind === "qa" ? "QA" : `an ${kind}`}: make sure ${a.ask}.`, LINE_CAP);
  }
  return null;
}

// ───────────────────────────── GATHER ─────────────────────────────

export interface GatherDeps {
  /** A terminal's transcript file, or null. Default: session-usage.ts transcriptFor (its workspace's profile, or a host mirror). */
  locate?: (s: Session) => string | null;
  scan?: (file: string, win: { since: number; until: number }) => Promise<RawScan>;
}

const candidateId = (wsId: string, text: string) => sha(`${wsId}|${normTurn(text)}`).slice(0, 10);

export async function gatherRetro(ws: Workspace, runId: string, deps: GatherDeps = {}): Promise<RetroRun> {
  const run = retroRuns.get(runId);
  if (!run || run.workspace_id !== ws.id) throw new RetroError(404, "retro run not found");
  const { since, until } = run;
  const win = { since: Date.parse(since), until: Date.parse(until) };
  const locate = deps.locate ?? ((s: Session) => transcriptFor(s.id));
  const scan = deps.scan ?? scanTranscript;

  // The wall: this workspace's own rows. Anything live during the week, including terminals opened before it.
  const ids = db.prepare(
    "SELECT id FROM sessions WHERE workspace_id = ? AND created_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY created_at LIMIT 400",
  ).all(ws.id, until, since) as { id: string }[];
  const rows = ids.map((r) => sessions.get(r.id)).filter((s): s is Session => !!s && s.workspace_id === ws.id);

  const injected: Partial<Record<InjectKind, number>> = {};
  const toolErrors: Partial<Record<ToolErrorClass, number>> = {};
  const apiErrors: Partial<Record<ApiErrorClass, number>> = {};
  const said: Said[] = [];
  const hit = new Set<string>();
  let read = 0, skipped = 0, typedIn = 0, operatorTurns = 0;

  for (const s of rows) {
    // His spawn goal is his own words even though the seed that carried it is the daemon's.
    if (s.created_by === "operator" && s.spawn_goal && s.created_at >= since && s.created_at < until)
      for (const c of clauses(s.spawn_goal)) said.push({ text: c, session_id: s.id, at: Date.parse(s.created_at), line: s.spawn_goal });
    if (s.cloud_agent_id || s.backend !== "claude-code") { skipped++; continue; }
    let raw: RawScan;
    try {
      const file = locate(s);
      if (!file) { skipped++; continue; }
      raw = await scan(file, win);
    } catch { skipped++; continue; } // a transcript that cannot be read is one terminal not counted, never a lost week
    if (raw.headless) { skipped++; continue; }
    read++;
    const trail = activity.list({ topic: "session.input", entity: s.id, limit: 1000 }) as { ts: string; detail: string | null }[];
    const seeded = !!(s.spawn_goal || s.ticket_id) && !!s.first_prompt;
    const kinds = classifyTurns(raw.turns, marksFor(s.id, trail), seeded ? textKey(s.first_prompt!) : null);
    let mine = 0;
    raw.turns.forEach((t, i) => {
      const k = kinds[i];
      if (k !== "operator") { bump(injected, k); if (k === "revive" || k === "network") hit.add(s.id); return; }
      mine++;
      for (const c of clauses(t.text)) said.push({ text: c, session_id: s.id, at: t.at, line: t.text });
    });
    if (mine) typedIn++;
    operatorTurns += mine;
    for (const [k, v] of Object.entries(raw.toolErrors)) bump(toolErrors, k as ToolErrorClass, v);
    for (const [k, v] of Object.entries(raw.apiErrors)) bump(apiErrors, k as ApiErrorClass, v);
    if (raw.apiErrors.network) hit.add(s.id);
  }

  // The verifier's rounds, aspects and the generic ones (only the catch-all reader verdict failed).
  const rounds = verifierWeek(ws.id, since, until);
  const aspects: Partial<Record<CheckName, number>> = {};
  for (const r of rounds) for (const n of r.names) bump(aspects, n);
  const generic = rounds.filter((r) => r.names.length > 0 && r.names.every((n) => n === "matches_request")).length;

  const clusters = clusterSaid(said, SAME_ASK);
  const rep = clusters.filter(repeated).sort((a, b) => b.count - a.count);
  const proposals = retroProposals.list(ws.id);

  // Rules he approved, and whether their ask came back after he approved them.
  const failed: RetroStats["rules_failed"] = [];
  for (const p of proposals.filter((x) => x.kind === "rule" && x.status === "approved" && x.decided_at)) {
    const after = Date.parse(p.decided_at!);
    let times = 0;
    if (p.key.startsWith("verifier:")) {
      const name = p.key.slice("verifier:".length);
      times = rounds.filter((r) => Date.parse(r.at) > after && (r.names as string[]).includes(name)).length;
      if (times < ASPECT_REPEAT) times = 0;
    } else if (p.match) {
      times = new Set(said.filter((x) => x.at > after && clauseSimilarity(p.match!, x.text) >= SAME_ASK).map((x) => `${x.session_id}@${x.at}`)).size;
    }
    if (times) failed.push({ id: p.id, text: p.text, times });
  }

  // What the job turns into rules: corrections (even once), standing requests said again, and anything
  // asked three times across terminals — minus what a proposal already answers, in any state.
  const answered = (c: Cluster) => proposals.some((p) => (p.match && clauseSimilarity(p.match, c.text) >= SAME_ASK) || similarity(p.text, c.text) >= SAME_RULE);
  const candidates: Candidate[] = clusters
    .filter((c) => (c.correction || (c.request && repeated(c)) || (c.count >= 3 && c.sessions >= 2)) && !answered(c))
    .sort((a, b) => Number(b.correction) - Number(a.correction) || b.count - a.count)
    .slice(0, CANDIDATE_CAP)
    .map((c) => ({
      id: candidateId(ws.id, c.text),
      kind: c.correction ? "correction" : "repeat",
      text: clip(c.text, LINE_CAP),
      count: c.count,
      sessions: c.sessions,
      examples: c.examples.map((e) => clip(oneLine(e.line ?? e.text), 240)),
    }));

  const stats: RetroStats = {
    window: { since, until },
    sessions: read,
    sessions_typed: typedIn,
    sessions_skipped: skipped,
    operator_turns: operatorTurns,
    injected,
    handoffs: handoffsIn(rows, since, until),
    verifier: {
      rejections: rounds.length, generic, sessions: new Set(rounds.map((r) => r.session_id).filter(Boolean)).size, aspects,
      examples: rounds.filter((r) => r.reason).slice(-2).map((r) => clip(oneLine(r.reason), 160)),
    },
    infra: { revive: injected.revive ?? 0, network: injected.network ?? 0, api_network: apiErrors.network ?? 0, sessions_hit: hit.size },
    api_errors: apiErrors,
    tool_errors: toolErrors,
    duplicates: duplicateTerminals(rows, since, until),
    corrections: said.filter((x) => isCorrection(x.text)).length,
    repeats: { clusters: rep.length, times: rep.reduce((a, c) => a + c.count - 1, 0), top: rep.slice(0, 3).map((c) => ({ text: clip(c.text, 100), count: c.count, sessions: c.sessions })) },
    rules_failed: failed,
  };

  // A verifier aspect sent back twice in one week is a rule by itself — code writes it, no model.
  for (const [name, n] of Object.entries(aspects) as [CheckName, number][]) {
    if (n < ASPECT_REPEAT) continue;
    const text = aspectRule(name);
    if (text) retroProposals.add({ workspace_id: ws.id, run_id: run.id, kind: "rule", source: "verifier", key: `verifier:${name}`, text, detail: `the verifier sent work back ${n}× for ${name} this week`, evidence: n });
  }

  const prev = parse<RetroStats | null>(prevRun(ws.id, until)?.stats, null);
  const pending = retroProposals.list(ws.id, { status: "pending" }).length;
  const report = renderReport(ws.name, stats, prev, pending);
  try { inputMarks.prune(new Date(win.until - MARK_KEEP_DAYS * 86_400_000).toISOString()); } catch {}
  const out = retroRuns.patch(run.id, {
    status: "gathered", gathered_at: new Date().toISOString(),
    stats: JSON.stringify(stats), findings: JSON.stringify(findingsOf(stats)), candidates: JSON.stringify(candidates), report,
  })!;
  bus.publish({ topic: "retro.updated", workspace_id: ws.id, run_id: run.id });
  return out;
}

// ───────────────────────────── the report ─────────────────────────────

const rate = (r: number | null) => (r === null ? "–" : r.toFixed(2));
const topOf = (m: Partial<Record<string, number>>, n: number) =>
  Object.entries(m).filter(([, v]) => (v ?? 0) > 0).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
const sum = (m: Partial<Record<string, number>>) => Object.values(m).reduce<number>((a, v) => a + (v ?? 0), 0);

/** What the operator reads: the top friction with counts and examples, and last week beside it. */
export function renderReport(name: string, s: RetroStats, prev: RetroStats | null, pending: number): string {
  const k = kpisOf(s);
  const p = prev ? kpisOf(prev) : null;
  const was = (v: number | string | null) => (p ? ` (last week ${v ?? "–"})` : "");
  const items: [number, string][] = [];
  if (s.verifier.rejections) {
    const asp = topOf(s.verifier.aspects, 4);
    items.push([s.verifier.rejections, `Verifier sent work back ${s.verifier.rejections}× — ${rate(k.rejection_rate)} per hand-off${was(p ? rate(p.rejection_rate) : null)}` +
      `${asp ? ` — ${asp}` : ""}${s.verifier.generic ? ` · ${s.verifier.generic} generic` : ""}${s.verifier.examples[0] ? ` — e.g. "${clip(s.verifier.examples[0], 120)}"` : ""}`]);
  }
  if (k.infra) items.push([k.infra, `Infra interruptions ${k.infra}${was(p?.infra ?? null)} — revive ${s.infra.revive}, network nudges ${s.infra.network}, turns lost to the network ${s.infra.api_network} · ${s.infra.sessions_hit} terminal${s.infra.sessions_hit === 1 ? "" : "s"} hit`]);
  if (s.repeats.times) items.push([s.repeats.times, `You asked for the same thing again ${s.repeats.times}×${was(p?.repeat_asks ?? null)} — ` + s.repeats.top.map((t) => `"${t.text}" (${t.count}× in ${t.sessions} terminals)`).join(", ")]);
  const tools = sum(s.tool_errors);
  if (tools) items.push([tools, `Tool errors ${tools} — ${topOf(s.tool_errors, 4)}`]);
  if (s.duplicates) items.push([s.duplicates, `Duplicate terminals ${s.duplicates}${was(p?.duplicates ?? null)}`]);
  const other = sum(s.api_errors) - (s.api_errors.network ?? 0);
  if (other) items.push([other, `Other API errors ${other} — ${topOf({ ...s.api_errors, network: 0 }, 3)}`]);
  items.sort((a, b) => b[0] - a[0]);

  const day = (iso: string) => iso.slice(0, 10);
  const daemon = topOf(s.injected, 6);
  return [
    `## Weekly retro · ${name} · ${day(s.window.since)} → ${day(s.window.until)}`,
    `${s.sessions} terminal${s.sessions === 1 ? "" : "s"} read · you typed in ${s.sessions_typed} (${s.operator_turns} line${s.operator_turns === 1 ? "" : "s"}) · ${s.handoffs} hand-off${s.handoffs === 1 ? "" : "s"}` +
      (s.sessions_skipped ? ` · ${s.sessions_skipped} not read (no transcript, another CLI or headless)` : ""),
    "",
    items.length ? "**Top friction**" : "**No friction recorded this week.**",
    ...items.slice(0, 6).map(([, l]) => `- ${l}`),
    ...(daemon ? ["", `Lines the daemon typed (not counted as yours): ${daemon}`] : []),
    "",
    `**Rules**: ${pending} waiting on you` + (s.rules_failed.length ? ` · ${s.rules_failed.length} not holding: ` + s.rules_failed.map((r) => `"${clip(r.text, 90)}" (asked again ${r.times}×)`).join(", ") : ""),
  ].join("\n");
}

// ───────────────────────────── the job's bundle ─────────────────────────────

const openRun = (r: RetroRun) => r.status === "gathered" || r.status === "dispatched";

function runOf(ws: Workspace, runId: string): RetroRun {
  const run = retroRuns.get(String(runId ?? ""));
  // The wall: a run of another workspace is "not found", same as one that never existed.
  if (!run || run.workspace_id !== ws.id) throw new RetroError(404, "retro run not found");
  return run;
}

function memoryRules(ws: Workspace): string[] {
  return indexSections(noteStore.bySlug(ws.id, INDEX_SLUG)?.body ?? "").flatMap((s) => s.lines.map((l) => l.replace(/\s*→\s*memory-[a-z0-9-]+$/, "")));
}

export function retroContext(ws: Workspace, runId: string) {
  const run = runOf(ws, runId);
  if (!openRun(run)) throw new RetroError(409, `retro run ${run.id.slice(0, 8)} is ${run.status}`);
  const stats = parse<RetroStats | null>(run.stats, null);
  if (!stats) throw new RetroError(409, `retro run ${run.id.slice(0, 8)} has no numbers yet`);
  const prev = parse<RetroStats | null>(prevRun(ws.id, run.until)?.stats, null);
  const g = (t: string) => guard(t, "retro-bundle", ws.id);
  const all = retroProposals.list(ws.id);
  const texts = (kind: "rule" | "product", status: RetroProposal["status"]) => all.filter((p) => p.kind === kind && p.status === status).slice(0, 40).map((p) => g(p.text));
  return {
    run: run.id,
    workspace: { slug: ws.slug, name: ws.name },
    window: { since: run.since, until: run.until },
    kpis: kpisOf(stats),
    last_week: prev ? kpisOf(prev) : null,
    stats: { ...stats, verifier: { ...stats.verifier, examples: stats.verifier.examples.map(g) }, repeats: { ...stats.repeats, top: stats.repeats.top.map((t) => ({ ...t, text: g(t.text) })) }, rules_failed: stats.rules_failed.map((r) => ({ ...r, text: g(r.text) })) },
    candidates: parse<Candidate[]>(run.candidates, []).map((c) => ({ ...c, text: g(c.text), examples: c.examples.map(g) })),
    memory_rules: memoryRules(ws).map(g),
    proposals: { pending: texts("rule", "pending"), approved: texts("rule", "approved"), dismissed: texts("rule", "dismissed") },
    product: run.aggregate
      ? {
          this_week: parse(run.aggregate, null),
          last_week: parse(retroRuns.list(ws.id, 10).find((r) => r.id !== run.id && r.aggregate && r.until < run.until)?.aggregate, null),
          proposals: { pending: texts("product", "pending"), approved: texts("product", "approved"), dismissed: texts("product", "dismissed") },
        }
      : null,
    limits: { rules: RULES_PER_WEEK, rule_chars: LINE_CAP, notes_chars: NOTES_CAP, product: run.aggregate ? PRODUCT_PER_WEEK : 0 },
  };
}

// ───────────────────────────── APPLY ─────────────────────────────

export interface RetroPlan {
  run: string;
  notes?: string | null;
  rules?: { from: string[]; rule: string }[];
  product?: { title: string; why: string; change: string }[];
}

export type PublicProposal = Pick<RetroProposal, "id" | "workspace_id" | "kind" | "source" | "text" | "detail" | "evidence" | "status" | "created_at" | "decided_at" | "ref">;
export const pubProposal = (p: RetroProposal): PublicProposal =>
  ({ id: p.id, workspace_id: p.workspace_id, kind: p.kind, source: p.source, text: p.text, detail: p.detail, evidence: p.evidence, status: p.status, created_at: p.created_at, decided_at: p.decided_at, ref: p.ref });

export function applyRetro(ws: Workspace, plan: RetroPlan, now = new Date()): { run: string; proposed: PublicProposal[]; skipped: { text: string; why: string }[] } {
  if (!plan || typeof plan !== "object") throw new RetroError(400, "the plan must be a JSON object");
  const run = runOf(ws, plan.run);
  if (!openRun(run)) throw new RetroError(409, `retro run ${run.id.slice(0, 8)} is ${run.status}`);
  const problems: string[] = [];
  const byId = new Map(parse<Candidate[]>(run.candidates, []).map((c) => [c.id, c]));
  const notes = plan.notes == null ? "" : String(plan.notes).trim();
  if (notes.length > NOTES_CAP) problems.push(`notes is ${notes.length}/${NOTES_CAP} chars — cut it`);
  const rules = plan.rules == null ? [] : Array.isArray(plan.rules) ? plan.rules : (problems.push("rules must be an array"), []);
  if (rules.length > RULES_PER_WEEK) problems.push(`at most ${RULES_PER_WEEK} rules a week (got ${rules.length}) — keep the ones that cost him most`);
  rules.forEach((r, i) => {
    const text = String(r?.rule ?? "");
    if (/[\r\n]/.test(text.trim())) problems.push(`rules[${i}]: one line — no line breaks`);
    const t = oneLine(text);
    if (t.length < 12 || t.length > LINE_CAP) problems.push(`rules[${i}]: ${t.length} chars — a rule is 12–${LINE_CAP} chars, one imperative line`);
    const from = Array.isArray(r?.from) ? r.from : [];
    if (!from.length) problems.push(`rules[${i}]: "from" must name the candidate id(s) it answers`);
    for (const id of from) if (!byId.has(String(id))) problems.push(`rules[${i}]: ${id} is not a candidate of this run`);
  });
  const product = plan.product == null ? [] : Array.isArray(plan.product) ? plan.product : (problems.push("product must be an array"), []);
  if (product.length && !run.aggregate) problems.push("product proposals belong to the product workspace's run only");
  if (product.length > PRODUCT_PER_WEEK) problems.push(`at most ${PRODUCT_PER_WEEK} product proposals (got ${product.length})`);
  product.forEach((p, i) => {
    const title = oneLine(p?.title);
    if (title.length < 8 || title.length > 120) problems.push(`product[${i}]: title is ${title.length} chars (8–120, one line)`);
    if (!oneLine(p?.why) || String(p?.why).length > 400) problems.push(`product[${i}]: "why" is required, ≤400 chars, and cites the counts`);
    if (!oneLine(p?.change) || String(p?.change).length > 700) problems.push(`product[${i}]: "change" is required, ≤700 chars`);
  });
  if (problems.length) throw new RetroError(400, problems.join("\n"), problems);

  const existing = retroProposals.list(ws.id);
  const inMemory = memoryRules(ws);
  const skipped: { text: string; why: string }[] = [];
  const created: RetroProposal[] = [];
  for (const r of rules) {
    const text = guard(oneLine(r.rule), "retro-rule", ws.id);
    const key = `rule:${sha(normTurn(text)).slice(0, 16)}`;
    const dup = existing.find((p) => p.kind === "rule" && (p.key === key || similarity(p.text, text) >= SAME_RULE));
    if (dup) { skipped.push({ text, why: dup.status === "dismissed" ? "dismissed before — never proposed again" : `already ${dup.status}` }); continue; }
    if (inMemory.some((l) => similarity(l, text) >= SAME_RULE)) { skipped.push({ text, why: "already in the memory index" }); continue; }
    const cited = r.from.map((id) => byId.get(String(id))!);
    const source: ProposalSource = cited.some((c) => c.kind === "correction") ? "correction" : "repeat";
    const p = retroProposals.add({
      workspace_id: ws.id, run_id: run.id, kind: "rule", source, key, text,
      detail: clip(`answers: ${cited.map((c) => `"${c.text}" (${c.count}×)`).join(", ")}`, 600),
      match: cited[0].text, evidence: cited.reduce((a, c) => a + c.count, 0),
    });
    if (p) { created.push(p); existing.push(p); } else skipped.push({ text, why: "already proposed" });
  }
  for (const pr of product) {
    const title = guard(oneLine(pr.title), "retro-product", ws.id);
    const key = `product:${sha(normTurn(title)).slice(0, 16)}`;
    const dup = existing.find((p) => p.kind === "product" && (p.key === key || similarity(p.text, title) >= SAME_RULE));
    if (dup) { skipped.push({ text: title, why: dup.status === "dismissed" ? "dismissed before — never proposed again" : `already ${dup.status}` }); continue; }
    const detail = guard(`${oneLine(pr.why)}\n\n${String(pr.change).trim()}`, "retro-product", ws.id);
    const p = retroProposals.add({ workspace_id: ws.id, run_id: run.id, kind: "product", source: "product", key, text: title, detail });
    if (p) { created.push(p); existing.push(p); }
  }
  const report = notes ? `${run.report ?? ""}\n\n**Notes**\n${guard(notes, "retro-notes", ws.id)}` : run.report;
  retroRuns.patch(run.id, { status: "applied", report, finished_at: now.toISOString() });
  activity.add({ topic: "retro.applied", actor: "retro", workspace_id: ws.id, entity: run.id, detail: `${created.length} proposed, ${skipped.length} skipped` });
  bus.publish({ topic: "retro.updated", workspace_id: ws.id, run_id: run.id });
  return { run: run.id, proposed: created.map(pubProposal), skipped };
}

// ───────────────────────────── the operator's tap ─────────────────────────────

/**
 * Approve or dismiss one proposal of THIS workspace. Approve: a rule goes into the memory index under
 * "Operator rules" (rememberFact — capped and deduplicated like `mc remember`); a product proposal
 * becomes a backlog ticket in that workspace with no repo, so nothing plans or builds it on its own.
 * The caller has already checked it is the operator's own hand (retro-routes.ts).
 */
export async function decideProposal(ws: Workspace, id: string, d: { decision: "approve" | "dismiss"; by: string; text?: string | null }): Promise<PublicProposal> {
  const p = retroProposals.get(String(id ?? ""));
  if (!p || p.workspace_id !== ws.id) throw new RetroError(404, "proposal not found");
  if (p.status !== "pending") throw new RetroError(409, `already ${p.status}`);
  let ref: string | null = null;
  let text: string | undefined;
  if (d.decision === "approve") {
    if (p.kind === "rule") {
      const edited = d.text == null ? null : oneLine(d.text);
      if (edited !== null && (edited.length < 12 || edited.length > LINE_CAP)) throw new RetroError(400, `a rule is 12–${LINE_CAP} chars, one line`);
      const fact = edited ?? p.text;
      const r = rememberFact(ws.id, { fact, topic: RULE_TOPIC });
      if (!r.ok) throw new RetroError(409, r.error);
      ref = entryHash(fact);
      if (edited !== null) text = guard(edited, "retro-rule", ws.id);
    } else if (ws.ticket_connector === "native") {
      const { createTicket } = await import("./tickets.js");
      const t = createTicket({ workspace_id: ws.id, title: clip(p.text, 120), status: "backlog", priority: "P3", tags: ["retro"], context: `${p.detail ?? ""}\n\nProposed by the weekly self-retro from cross-workspace counts.` });
      ref = t.key;
    }
  }
  const out = retroProposals.decide(p.id, { status: d.decision === "approve" ? "approved" : "dismissed", by: d.by, ref, text });
  if (!out) throw new RetroError(409, "decided meanwhile");
  activity.add({ topic: `retro.${out.status}`, actor: d.by, workspace_id: ws.id, entity: out.id, detail: out.kind });
  bus.publish({ topic: "retro.updated", workspace_id: ws.id, proposal_id: out.id });
  return pubProposal(out);
}

// ───────────────────────────── what the Desk and `mc retro` read ─────────────────────────────

export function publicRun(r: RetroRun) {
  return {
    id: r.id, workspace_id: r.workspace_id, slot: r.slot, source: r.source, status: r.status, since: r.since, until: r.until,
    report: r.report, error: r.error, job_run: r.run_id, created_at: r.created_at, gathered_at: r.gathered_at, finished_at: r.finished_at,
  };
}

/** One workspace's latest week: KPIs beside last week's, the report, what waits on him, which rules are not holding. */
export function retroView(ws: Workspace) {
  const cur = retroRuns.latest(ws.id);
  const stats = parse<RetroStats | null>(cur?.stats, null);
  const prev = parse<RetroStats | null>(cur ? prevRun(ws.id, cur.until)?.stats : null, null);
  return {
    workspace_id: ws.id,
    name: ws.name,
    slug: ws.slug,
    run: cur ? publicRun(cur) : null,
    kpis: stats ? kpisOf(stats) : null,
    last_week: prev ? kpisOf(prev) : null,
    pending: retroProposals.list(ws.id, { status: "pending" }).slice(0, 10).map(pubProposal),
    failing: stats?.rules_failed ?? [],
  };
}
