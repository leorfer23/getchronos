/**
 * Lessons — the feedback loop that changes what agents do next time.
 *
 * Every `changes_requested` verdict and every correction the operator types is a labelled example
 * of this workspace getting something wrong. Until now that signal was spent once, as a rework note
 * on one ticket, and then thrown away: the next ticket made the same mistake and the operator
 * corrected it again.
 *
 * A lesson is that correction distilled into one imperative rule, scoped to where it applies, and
 * injected back into the agents that need it — builders as constraints, reviewers as extra
 * criteria, the manager as how-to-talk-to-the operator. Rules earn their place: an AI reviewer's complaint
 * starts as `proposed` and only becomes `active` once the same thing has come up more than once,
 * while the operator's own corrections are active immediately, because they do not repeat themselves.
 */
import { guard } from "./guard.js";
import { lessons as store, repos, workspaces } from "./store.js";
import { oneShotText } from "./summarize.js";
import { globMatch } from "./gates.js";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";
import { similarity, tokens } from "./text-similarity.js";
import { checkFactAsync, type MemoryFact } from "./memory-conflicts.js";
import type { Lesson, LessonSource, NewLesson, Workspace } from "./types.js";

export { similarity, tokens } from "./text-similarity.js";

const MAX_INJECTED = 8; // a standing-context budget, not a limit on how much the system can learn
const RULE_CAP = 200;

// ───────────────────────────── matching ─────────────────────────────

/**
 * Rules that apply to a piece of work, most relevant first.
 *
 * `files` (available at review time, not at build time) lets a path-scoped rule fire only for the
 * code it's about. Without files, a scoped rule still competes on text relevance — a build agent
 * about to touch the migrations directory should hear the migrations rule before it writes.
 *
 * Text query (`opts.text` non-empty) requires *positive* relevance: token overlap with the rule,
 * or a path-scope hit when files are supplied. Zero-overlap rules must not fill `mc recall` /
 * prompts just because `score > -0.4`. Topic-only standing injection (no text) keeps the prior
 * floor so a build/review prompt still hears its topic's rules.
 */
export function relevantLessons(
  workspace_id: string,
  opts: { repo_id?: string | null; topic?: string; text?: string; files?: string[]; limit?: number } = {},
): Lesson[] {
  const all = store.list({ workspace_id, state: "active", repo_id: opts.repo_id ?? undefined });
  const topic = opts.topic;
  const pool = topic ? all.filter((l) => l.topic === topic || l.topic === "any") : all;
  const text = opts.text ?? "";
  const hasText = Boolean(text.trim());

  const scored = pool.map((l) => {
    const textRel = hasText ? similarity(l.rule, text) : 0;
    let pathHit = false;
    let score = textRel;
    if (l.scope && opts.files?.length) {
      pathHit = opts.files.some((f) => globMatch(l.scope!, f));
      score = pathHit ? score + 1 : score - 0.5;
    }
    if (l.repo_id) score += 0.15; // a repo-specific rule beats a workspace-wide one at equal relevance
    return { l, score, textRel, pathHit };
  });

  return scored
    .filter((s) => {
      if (hasText) return s.textRel > 0 || s.pathHit;
      return s.score > -0.4;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? MAX_INJECTED)
    .map((s) => s.l);
}

/**
 * The prompt block. Marks each rule as fired so `hits` reflects reality and the hygiene sweep can
 * tell a live rule from one whose code no longer exists.
 */
export function lessonsBlock(
  workspace_id: string,
  opts: { repo_id?: string | null; topic?: string; text?: string; files?: string[]; limit?: number; heading?: string } = {},
): string {
  const picked = relevantLessons(workspace_id, opts);
  if (!picked.length) return "";
  store.markFired(picked.map((l) => l.id));
  const heading =
    opts.heading ??
    `## Learned here (from this operator's own corrections — follow them)`;
  const lines = picked.map((l) => `- ${l.rule}${l.scope ? ` _(applies to \`${l.scope}\`)_` : ""}`).join("\n");
  return `\n${heading}\n${lines}\n`;
}

// ───────────────────────────── capture ─────────────────────────────

/**
 * File a rule, folding it into an existing near-duplicate instead of growing a pile of restatements
 * of the same complaint. A repeat of a `proposed` rule is what promotes it to `active`.
 */
export function recordLesson(l: NewLesson): Lesson {
  const rule = guard(l.rule.replace(/\s+/g, " ").trim().slice(0, RULE_CAP), `lesson ${l.workspace_id}`, l.workspace_id);
  const existing = store.list({ workspace_id: l.workspace_id }).find(
    (e) => e.repo_id === (l.repo_id ?? null) && similarity(e.rule, rule) >= CONFIG.lessonDedupeSimilarity,
  );
  if (existing) {
    const updated = store.reinforce(existing.id, CONFIG.lessonPromoteAfter) ?? existing;
    bus.publish({ topic: "lesson.updated", lesson_id: updated.id, workspace_id: l.workspace_id, state: updated.state });
    return updated;
  }
  const created = store.create({ ...l, rule });
  bus.publish({ topic: "lesson.updated", lesson_id: created.id, workspace_id: l.workspace_id, state: created.state });
  // Dedupe above answered "is this the same rule again?". This asks the other question — whether
  // the rule we just accepted contradicts one already standing. Compared only against rules that
  // could apply to the same work: same topic (or the catch-all), same repo scope.
  checkLessonForConflicts(created);
  return created;
}

/** The rules a new lesson could plausibly contradict: same topic and repo scope, active only. */
function conflictPool(l: Lesson): MemoryFact[] {
  return store
    .list({ workspace_id: l.workspace_id, state: "active" })
    .filter((e) => e.id !== l.id)
    .filter((e) => e.topic === l.topic || e.topic === "any" || l.topic === "any")
    .filter((e) => e.repo_id === l.repo_id || e.repo_id === null || l.repo_id === null)
    .map((e) => ({ kind: "lesson" as const, ref: e.id, text: e.rule }));
}

function checkLessonForConflicts(l: Lesson): void {
  try {
    const pool = conflictPool(l);
    if (!pool.length) return;
    checkFactAsync(l.workspace_id, { kind: "lesson", ref: l.id, text: l.rule }, pool);
  } catch (e) {
    console.error("[lessons] conflict check failed", e);
  }
}

type Extracted = { rule: string; scope?: string | null; topic?: string };

function parseExtracted(out: string | null): Extracted[] {
  if (!out) return [];
  try {
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x: any) => ({
        rule: String(x?.rule ?? "").replace(/\s+/g, " ").trim().slice(0, RULE_CAP),
        scope: x?.scope ? String(x.scope).trim().slice(0, 120) : null,
        topic: x?.topic ? String(x.topic).trim().slice(0, 24) : undefined,
      }))
      .filter((x: Extracted) => x.rule.length > 10)
      .slice(0, 4);
  } catch {
    return [];
  }
}

const TOPICS = new Set(["build", "review", "comms", "any"]);

/**
 * Turn one piece of feedback into durable rules.
 *
 * Deliberately strict about what counts: a rule has to be worth telling the NEXT agent, working a
 * DIFFERENT ticket. "Fix the typo on line 40" is not a lesson; "this repo's dates are stored UTC,
 * convert at the edge" is. Most feedback yields nothing, and returning [] is the correct answer.
 */
export async function extractLessons(
  ws: Workspace,
  feedback: string,
  ctx: { repo_id?: string | null; source: LessonSource; source_ref?: string | null; topic?: string; ticketTitle?: string },
): Promise<Lesson[]> {
  const text = feedback.replace(/\s+/g, " ").trim();
  if (text.length < 20) return [];
  const repo = ctx.repo_id ? repos.get(ctx.repo_id) : undefined;

  const out = await oneShotText(
    `An operator or reviewer just gave this feedback on a coding task${ctx.ticketTitle ? ` ("${ctx.ticketTitle}")` : ""}` +
      `${repo ? ` in the repo "${repo.name}"` : ""}.\n\n` +
      `FEEDBACK:\n${text}\n\n` +
      `Extract ONLY the durable rules — things a DIFFERENT agent working a DIFFERENT ticket in this same ` +
      `codebase should know so it doesn't make the same mistake. A rule must generalise beyond this one ticket.\n` +
      `EXCLUDE: one-off fixes ("rename this variable"), restatements of the ticket, anything already obvious ` +
      `from reading the code, praise, and status.\n` +
      `Each rule: ONE imperative sentence under 160 chars, specific enough to act on.\n` +
      `"scope": a glob for the paths it applies to (e.g. "src/api/**", "**/*.sql"), or null for everywhere.\n` +
      `"topic": "build" (how to write code here), "review" (what to check), or "comms" (how to report to the operator).\n` +
      `Return ONLY a JSON array, and [] when nothing generalises — that is the common answer.\n` +
      `Example: [{"rule":"Convert timestamps to UTC at the API edge; the DB stores naive UTC.","scope":"src/api/**","topic":"build"}]`,
    ws.config_dir,
    ws,
    25_000,
    null,
    "lesson",
  );

  return parseExtracted(out).map((e) =>
    recordLesson({
      workspace_id: ws.id,
      repo_id: ctx.repo_id ?? null,
      scope: e.scope ?? null,
      topic: TOPICS.has(e.topic ?? "") ? e.topic! : (ctx.topic ?? "build"),
      rule: e.rule,
      source: ctx.source,
      source_ref: ctx.source_ref ?? null,
      // The operator does not repeat himself — his corrections apply from the next build on. A
      // reviewer's complaint has to happen twice before it becomes a standing rule for everyone.
      state: ctx.source === "operator" ? "active" : "proposed",
    }),
  );
}

/** Fire-and-forget wrapper: capture must never fail the transition that produced the feedback. */
export function captureFeedback(
  workspace_id: string,
  feedback: string | null | undefined,
  ctx: { repo_id?: string | null; source: LessonSource; source_ref?: string | null; topic?: string; ticketTitle?: string },
): void {
  if (!feedback?.trim()) return;
  const ws = workspaces.get(workspace_id);
  if (!ws) return;
  void extractLessons(ws, feedback, ctx).catch((e) => console.error("[lessons] extract failed", e));
}

// ───────────────────────────── hygiene ─────────────────────────────

/**
 * Retire rules that stopped meaning anything: a proposal nobody ever saw twice, and an active rule
 * that hasn't matched a single piece of work in months (its code moved, or the convention changed).
 * A rule that keeps firing is doing its job and is never archived for age.
 */
export function decayLessons(nowMs = Date.now()): number {
  const day = 86_400_000;
  let archived = 0;
  for (const l of store.list({})) {
    if (l.state !== "active" && l.state !== "proposed") continue;
    const age = (nowMs - Date.parse(l.created_at)) / day;
    const idle = l.last_fired ? (nowMs - Date.parse(l.last_fired)) / day : age;
    const stale =
      l.state === "proposed"
        ? age > CONFIG.lessonProposedTtlDays
        : idle > CONFIG.lessonIdleTtlDays;
    if (!stale) continue;
    store.update(l.id, { state: "archived" });
    archived++;
  }
  return archived;
}
