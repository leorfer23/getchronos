/**
 * Memory conflicts — noticing that two remembered facts disagree.
 *
 * Capture has always been able to ask "have I been told this already?" — `recordLesson` folds a
 * near-duplicate into the rule it repeats, and the memory tree refuses a line too close to one it
 * already holds. Neither can ask the other question: "does this CONTRADICT something I hold?"
 * So the vault accumulated rules that disagree — "claim a worktree before writing" next to
 * "for a one-line change, edit in place" — and an agent acted on whichever it happened to read.
 *
 * Two stages, cheap then expensive:
 *
 *  1. `candidatesFor()` — pure, no I/O, no model. Picks the handful of existing facts the new one
 *     might be about.
 *  2. `judge()` — ONE model call for the whole batch, returning a verb from a closed vocabulary
 *     per candidate. Verdicts land in `memory_relations`; only `conflicts_with` and `supersedes`
 *     are worth anyone's attention, the rest are recorded so the pair is never paid for twice.
 *
 * The shape is borrowed from engram (MIT, Gentleman-Programming/engram) — its two-stage scan and
 * its locked six-verb vocabulary. The candidate stage is NOT: engram ranks candidates with BM25
 * over titles, which on a 6-memory corpus proposed 13 pairs out of a possible 15, of which one was
 * real. Paying for a model call per pair at that precision does not survive contact with a vault
 * this size. See `subjectOverlap` for what we do instead. Engram also judges pair-by-pair because
 * it backfills in bulk; we judge at capture time, so one call covers every candidate at once.
 */
import { CONFIG } from "./config.js";
import { guard } from "./guard.js";
import { memoryRelations, workspaces } from "./store.js";
import { helperModel, oneShotText } from "./summarize.js";
import { tokens } from "./text-similarity.js";
import type {
  MemoryRelationKind,
  MemoryRelationVerb,
  Workspace,
} from "./types.js";

/** Facts worth a model call for one capture. Bounds the cost of a single `mc remember`. */
export const MAX_CANDIDATES = 6;
/**
 * A candidate must score at least this fraction of the best candidate's score to be worth judging.
 *
 * Relative, not absolute, because an absolute floor cannot be calibrated across pool sizes: idf
 * over three facts and idf over three hundred are not the same number, and a threshold tuned for
 * one silently rejects everything or accepts everything in the other. Relative asks the only
 * question that travels: is this candidate in the same league as the best one we found?
 */
export const RELATIVE_FLOOR = 0.25;
const JUDGE_TIMEOUT_MS = 25_000;
const TEXT_CAP = 400;

const VERBS = new Set<MemoryRelationVerb>([
  "conflicts_with",
  "supersedes",
  "scoped",
  "related",
  "compatible",
  "not_conflict",
]);

/** The verdicts a human needs to see. Everything else is bookkeeping. */
export const ACTIONABLE: ReadonlySet<MemoryRelationVerb> = new Set<MemoryRelationVerb>([
  "conflicts_with",
  "supersedes",
]);

export interface MemoryFact {
  kind: MemoryRelationKind;
  /** Stable identity: a lesson id, or the prose hash of a memory-tree line. */
  ref: string;
  text: string;
}

// ───────────────────────────── stage 1: candidates ─────────────────────────────

/**
 * How strongly two facts look like they are about the same subject.
 *
 * NOT Jaccard, which is what the rest of capture uses — and which is actively wrong here.
 * Contradictions share their subject and differ in their predicate, so they score LOW on overlap:
 * "worktrees are mandatory before any write" against "worktrees are optional for small edits"
 * shares exactly one token out of seven, a Jaccard of 0.14, far under any dedupe threshold. That
 * one shared token is also the entire signal — it is the rare word both sentences are about.
 *
 * So: sum the inverse document frequency of the shared tokens over the candidate pool. A shared
 * rare word ("worktree", "flyway") is strong evidence; a shared common one ("agent", "run") is
 * nearly free. Symmetric, needs no index, and costs one pass over the pool.
 */
export function subjectOverlap(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  let score = 0;
  for (const t of a) if (b.has(t)) score += idf.get(t) ?? 0;
  return score;
}

/** Inverse document frequency of every token in a pool of facts. */
export function idfOver(texts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of texts) for (const tok of tokens(t)) df.set(tok, (df.get(tok) ?? 0) + 1);
  const total = Math.max(1, texts.length);
  const idf = new Map<string, number>();
  for (const [tok, n] of df) idf.set(tok, Math.log((total + 1) / (n + 0.5)));
  return idf;
}

/**
 * The existing facts a new one might contradict, best first.
 *
 * `pool` is already the narrow set the caller believes is comparable — lessons of the same topic,
 * or the lines under one `## Topic` heading of the memory index. Narrowing by structure first is
 * what keeps this affordable; the score only orders what is left.
 */
export function candidatesFor(
  fact: MemoryFact,
  pool: MemoryFact[],
  opts: { limit?: number; floor?: number } = {},
): MemoryFact[] {
  const others = pool.filter((p) => p.ref !== fact.ref && p.text.trim());
  if (!others.length) return [];
  // idf over the pool alone. Including the new fact would count its own words against it: a term
  // it shares with exactly one old fact would look one-third common in a pool of two.
  const idf = idfOver(others.map((p) => p.text));
  const mine = tokens(fact.text);
  const scored = others
    .map((p) => ({ p, score: subjectOverlap(mine, tokens(p.text), idf) }))
    .filter((c) => c.score > 0) // no shared vocabulary at all → not about the same thing
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const cut = scored[0].score * (opts.floor ?? RELATIVE_FLOOR);
  return scored
    .filter((c) => c.score >= cut)
    .slice(0, opts.limit ?? MAX_CANDIDATES)
    .map((c) => c.p);
}

// ───────────────────────────── stage 2: the judge ─────────────────────────────

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TEXT_CAP);

export function buildJudgePrompt(fact: MemoryFact, candidates: MemoryFact[]): string {
  const listed = candidates.map((c, i) => `${i + 1}. ${clip(c.text)}`).join("\n");
  return (
    `You audit a team's memory for contradictions. A NEW fact was just recorded. Classify how it ` +
    `relates to each EXISTING fact.\n\n` +
    `NEW FACT:\n${clip(fact.text)}\n\n` +
    `EXISTING FACTS:\n${listed}\n\n` +
    `For each existing fact, choose EXACTLY ONE relation:\n` +
    `- conflicts_with — the two make contradictory claims; following one means breaking the other\n` +
    `- supersedes — the NEW fact replaces the existing one (same rule, updated)\n` +
    `- scoped — one is a narrower case of the other, so both can hold at once\n` +
    `- related — same subject, no contradiction\n` +
    `- compatible — consistent and complementary\n` +
    `- not_conflict — no meaningful overlap\n\n` +
    `Be strict about conflicts_with: two rules about the same subject that can BOTH be followed are ` +
    `not in conflict. A narrower exception to a general rule is "scoped", not a contradiction.\n\n` +
    `Return ONLY a JSON array, one object per existing fact, no prose:\n` +
    `[{"n":1,"relation":"<verb>","confidence":0.0,"reason":"<=160 chars"}]`
  );
}

export interface Verdict {
  n: number;
  relation: MemoryRelationVerb;
  confidence: number;
  reason: string;
}

/** Parse the judge's reply. A malformed or partial answer yields the verdicts that did parse. */
export function parseVerdicts(out: string | null, candidateCount: number): Verdict[] {
  if (!out) return [];
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out_: Verdict[] = [];
  for (const raw of arr) {
    const x = raw as Record<string, unknown>;
    const n = Number(x?.n);
    const relation = String(x?.relation ?? "") as MemoryRelationVerb;
    if (!Number.isInteger(n) || n < 1 || n > candidateCount) continue;
    if (!VERBS.has(relation)) continue;
    if (seen.has(n)) continue; // one verdict per candidate; first wins
    seen.add(n);
    const c = Number(x?.confidence);
    out_.push({
      n,
      relation,
      confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0,
      reason: String(x?.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    });
  }
  return out_;
}

/** One model call for the whole batch. Returns [] on any failure — this never throws. */
export async function judge(
  ws: Workspace,
  fact: MemoryFact,
  candidates: MemoryFact[],
): Promise<Verdict[]> {
  if (!candidates.length) return [];
  const out = await oneShotText(
    buildJudgePrompt(fact, candidates),
    ws.config_dir,
    ws,
    JUDGE_TIMEOUT_MS,
    null,
    "conflict",
  );
  return parseVerdicts(out, candidates.length);
}

// ───────────────────────────── orchestration ─────────────────────────────

/**
 * Judge a newly captured fact against a pool and record what comes back.
 *
 * Returns the relations written. Pairs already on file are skipped before the model is called, so
 * re-capturing the same rule costs nothing.
 */
export async function checkFact(
  ws: Workspace,
  fact: MemoryFact,
  pool: MemoryFact[],
): Promise<number> {
  if (!CONFIG.memoryConflictChecks) return 0;
  if (!fact.text.trim() || !fact.ref) return 0;

  const candidates = candidatesFor(fact, pool).filter(
    (c) => !memoryRelations.judged(ws.id, fact.ref, c.ref),
  );
  if (!candidates.length) return 0;

  const verdicts = await judge(ws, fact, candidates);
  let written = 0;
  for (const v of verdicts) {
    const target = candidates[v.n - 1];
    if (!target) continue;
    const row = memoryRelations.record({
      workspace_id: ws.id,
      source_kind: fact.kind,
      source_ref: fact.ref,
      // Guarded: both sides are workspace-authored prose that will be rendered into a prompt.
      source_text: guard(clip(fact.text), "memory-relation", ws.id),
      target_kind: target.kind,
      target_ref: target.ref,
      target_text: guard(clip(target.text), "memory-relation", ws.id),
      relation: v.relation,
      confidence: v.confidence,
      reason: guard(v.reason, "memory-relation", ws.id),
      // The model that actually ran, not the workspace preference — they differ whenever
      // review_model is unset and the backend supplies its own default.
      judged_by: helperModel(ws),
    });
    if (row) written++;
  }
  return written;
}

/**
 * Fire-and-forget wrapper. Capture must never fail because the auditor did — a rule that was
 * learned is more valuable than knowing whether it disagrees with an older one.
 */
export function checkFactAsync(workspace_id: string, fact: MemoryFact, pool: MemoryFact[]): void {
  if (!CONFIG.memoryConflictChecks) return;
  const ws = workspaces.get(workspace_id);
  if (!ws) return;
  void checkFact(ws, fact, pool).catch((e) => console.error("[memory-conflicts] check failed", e));
}

// ───────────────────────────── surfacing ─────────────────────────────

/** Open contradictions in this workspace, worst first. */
export function openConflicts(workspace_id: string, limit = 5) {
  return memoryRelations
    .list({ workspace_id, status: "open", limit: limit * 4 })
    .filter((r) => ACTIONABLE.has(r.relation))
    .slice(0, limit);
}

/**
 * The block an agent sees when its memory disagrees with itself. Deliberately short and pointed:
 * the agent cannot resolve a contradiction on its own authority, it just must not act as though
 * the vault were consistent.
 */
export function conflictBlock(workspace_id: string, limit = 3): string {
  const open = openConflicts(workspace_id, limit);
  if (!open.length) return "";
  const lines = open.map(
    (r) =>
      `- "${r.source_text}" vs "${r.target_text}"` +
      `${r.reason ? ` — ${r.reason}` : ""} (\`mc memory conflicts\` to settle it)`,
  );
  return guard(
    `## Memory conflicts — these two things you were told disagree\n` +
      `Do not silently pick one. If the answer matters for your work, ask.\n${lines.join("\n")}`,
    "memory-conflicts",
    workspace_id,
  );
}
