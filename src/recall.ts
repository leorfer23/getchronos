/**
 * Recall — retrieval-first workspace memory.
 *
 * The vault (memos, skills, lessons, session digests) grew faster than any context window should
 * carry: acme's learnings memo alone was 37k chars, none of it reaching a future agent because
 * injecting it whole was never an option. The answer is not a bigger injection — it's making the
 * memory SEARCHABLE and making agents actually search it.
 *
 * Two exports, two halves of the loop:
 *  - recall():      one workspace-walled query across every memory kind, with pointers to read the
 *                   full source. Behind `mc recall`, the API, and the Telegram/desk command.
 *  - memoryBlock(): the tiny standing block injected into every agent — an INDEX of what the vault
 *                   holds (titles, not bodies) plus the contract: recall before you build, capture
 *                   as you learn, never cross the workspace wall.
 *
 * The wall is absolute by construction: every FTS query filters on workspace_id and lessons come
 * from the workspace's own table. Global (operator-profile) knowledge crosses workspaces through
 * exactly one sanctioned door — contextBlock's scope='global' section — never through recall.
 */
import { searchIndex, notes as notesStore, skills as skillsStore, sessions as sessionsStore } from "./store.js";
import { relevantLessons } from "./lessons.js";
import { guard } from "./guard.js";
import type { Workspace } from "./types.js";

export interface RecallHit {
  kind: "note" | "skill" | "session" | "lesson";
  title: string;
  snippet: string;
  /** How to read the full source, when there is more than the snippet. */
  open: string | null;
  /** Stable id of the underlying row (note/skill/session/lesson), for provenance. */
  source_ref: string | null;
  /** ISO timestamp of the source row when known (created/updated). */
  age: string | null;
}

const FTS_KINDS = ["note", "skill", "session"] as const;
const PER_KIND = 6;
const MAX_HITS = 8;
const MAX_LESSONS = 4;

/**
 * How many hits of one kind may occupy the answer.
 *
 * Session digests are a transcript of what happened once; a memo or a skill is knowledge that is
 * meant to hold. Ranked on text alone the digests win on volume — measured, `mc recall "worktree"`
 * came back with six sessions and a single memo, burying the standing rule under six retellings of
 * people applying it. Capping the transcript-derived kind is the cheap fix: sessions still answer
 * "has anyone done this before", they just stop crowding out the answer to "what is the rule".
 */
const KIND_CAP: Partial<Record<(typeof FTS_KINDS)[number], number>> = { session: 3 };

const cleanSnippet = (s: string) =>
  s.replace(/[[\]]/g, "").replace(/\s+/g, " ").replace(/"/g, "'").trim();

function ageLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const days = Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Search one workspace's memory. Never falls back to an unscoped search: an empty workspace_id is
 * a caller bug, answered with nothing rather than with someone else's client data.
 *
 * FTS hits stay in bm25 rank order; lessons with positive text relevance are merged after, without
 * displacing a better FTS match, then the combined set is capped at `limit`.
 */
export function recall(workspace_id: string, q: string, limit = MAX_HITS): RecallHit[] {
  const query = q.trim();
  if (!workspace_id || !query) return [];

  const ranked = FTS_KINDS.flatMap((kind) =>
    searchIndex.search(query, { workspace: workspace_id, kind, limit: PER_KIND }),
  )
    .filter((h) => h.score < 0) // bm25: lower is better; positive scores are non-matches
    // Each kind is searched separately, so one kind can fall back to OR while another matched on
    // AND. Their bm25 scores are not comparable across that line: rank every exact hit above every
    // salvaged one, then by score within each group.
    .sort((a, b) => Number(a.lax ?? false) - Number(b.lax ?? false) || a.score - b.score);

  const perKind = new Map<string, number>();
  const fts: typeof ranked = [];
  for (const h of ranked) {
    if (fts.length >= limit) break;
    const cap = KIND_CAP[h.kind as (typeof FTS_KINDS)[number]];
    const used = perKind.get(h.kind) ?? 0;
    if (cap != null && used >= cap) continue;
    perKind.set(h.kind, used + 1);
    fts.push(h);
  }

  const hits: RecallHit[] = [];
  for (const h of fts) {
    if (h.kind === "note") {
      const n = notesStore.get(h.ref_id);
      if (!n || n.workspace_id !== workspace_id) continue;
      hits.push({
        kind: "note",
        title: n.title,
        snippet: cleanSnippet(h.snippet),
        open: `mc memo get ${n.slug}`,
        source_ref: n.id,
        age: ageLabel(n.updated_at || n.created_at),
      });
    } else if (h.kind === "skill") {
      const s = skillsStore.get(h.ref_id);
      if (!s || s.workspace_id !== workspace_id) continue;
      hits.push({
        kind: "skill",
        title: s.name,
        snippet: cleanSnippet(h.snippet),
        open: `mc skill view ${s.slug}`,
        source_ref: s.id,
        age: ageLabel(s.updated_at || s.created_at),
      });
    } else {
      const s = sessionsStore.get(h.ref_id);
      if (!s || s.workspace_id !== workspace_id) continue;
      // Digest rides in the snippet; open pointer is read-only focus on the ended terminal.
      hits.push({
        kind: "session",
        title: `${s.ticket_key ? s.ticket_key + " " : ""}${s.title ?? "session"}`,
        snippet: cleanSnippet(s.summary || h.snippet),
        open: `mc session focus ${s.id.slice(0, 8)}`,
        source_ref: s.id,
        age: ageLabel(s.created_at),
      });
    }
  }

  // Lessons live outside FTS; relevantLessons already requires positive text relevance for queries.
  const room = Math.max(0, limit - hits.length);
  const lessonCap = Math.min(MAX_LESSONS, room);
  if (lessonCap > 0) {
    for (const l of relevantLessons(workspace_id, { text: query, limit: lessonCap })) {
      hits.push({
        kind: "lesson",
        title: `[${l.topic}]`,
        snippet: l.rule,
        open: l.source_ref ? `lesson from ${l.source_ref}` : `lesson ${l.id.slice(0, 8)}`,
        source_ref: l.id,
        age: ageLabel(l.created_at),
      });
    }
  }
  return hits.slice(0, limit);
}

/** Render hits as terminal/prompt text. Workspace-authored content → guarded as one block. */
export function renderRecall(workspace_id: string, q: string, hits: RecallHit[]): string {
  if (!hits.length) return `(no memory matching "${q.trim()}" in this workspace)`;
  const lines = hits.map((h) => {
    const meta = [h.age, h.open].filter(Boolean).join(" · ");
    return `· [${h.kind}] ${h.title} — "${h.snippet.slice(0, 160)}"${meta ? ` → ${meta}` : ""}`;
  });
  return guard(`🧠 ${hits.length} memory hit(s) for "${q.trim()}":\n${lines.join("\n")}`, "recall", workspace_id);
}

// ───────────────────────────── the standing contract ─────────────────────────────

const INDEX_CAP = 700; // chars of memo index — titles only, never bodies

/**
 * The memory contract injected into every agent of a workspace. Deliberately tiny: an index of the
 * vault (so the agent knows recall will pay off) plus the three-source capture rule. Bodies are
 * NEVER injected here — ★ memos already travel via contextBlock; everything else is one
 * `mc recall` away.
 */
export function memoryBlock(workspace_id: string): string {
  // Index the memos NOT already injected in full (★ context memos ride contextBlock).
  const memos = notesStore.list(workspace_id).filter((n) => !n.context);
  let index = "";
  let used = 0;
  let shown = 0;
  for (const n of memos) {
    const piece = `${shown ? " · " : ""}${n.slug}`;
    if (used + piece.length > INDEX_CAP) { index += ` · …+${memos.length - shown} more (mc memo list)`; break; }
    index += piece; used += piece.length; shown++;
  }

  const lines = [
    `## Memory — recall before you build`,
    `This workspace has persistent memory: memos, skills, lessons and past-session digests, all searchable.`,
    `- ALWAYS \`mc recall "<topic>"\` before starting work, and again whenever you hit an unfamiliar system, error or decision — a past session may have solved it.`,
    index ? `- Memo vault (\`mc memo get <slug>\`): ${index}` : null,
    `- The operator says "remember / always / from now on …" → \`mc remember "<short rule>" --topic <T> [--detail "…"]\`: it lands in the ★ memory-index every future agent here loads. Keep the line short; detail goes to the topic's memory-<t> memo. If refused for size, condense the index first.`,
    `- The moment you learn a durable fact yourself (a gotcha, a convention, where something lives), note it: \`mc learn "<fact>"\` (an inbox the operator promotes from). Most sessions produce none — never record task status or secrets.`,
    `- Memory is private to THIS workspace. Never store, seek or mention other clients' or workspaces' information.`,
  ].filter(Boolean);
  return guard(lines.join("\n"), "memory-contract", workspace_id);
}

// ───────────────────────────── FTS relevance injection ─────────────────────────────

// At dispatch, surface THIS workspace's own notes/skills that match the ticket, so the agent knows
// what standing knowledge to read in full before starting. Cheap synchronous FTS (sub-ms). Only
// note|skill kinds — never event/session (transcript noise). Pure + exported so it's testable
// without dispatching. Returns "" when nothing relevant. `key` only labels the guard pass.
const REL_LIMIT = 8;

export function relevanceBlock(ws: Pick<Workspace, "id">, title: string, tags: string[] = [], key?: string): string {
  const q = [title, ...tags].join(" ").trim();
  if (!q) return "";
  const hits = [
    ...searchIndex.search(q, { workspace: ws.id, kind: "note", limit: REL_LIMIT }),
    ...searchIndex.search(q, { workspace: ws.id, kind: "skill", limit: REL_LIMIT }),
  ]
    .filter((h) => h.score < 0) // bm25: lower is better; positive scores are non-matches/noise
    // Exact hits only. This block is injected into every dispatch prompt without anyone asking for
    // it, so a loose OR match is not worth the tokens — `mc recall` is where widening pays off.
    .filter((h) => !h.lax)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  const lines: string[] = [];
  for (const h of hits) {
    const ref = h.kind === "note" ? notesStore.get(h.ref_id) : skillsStore.get(h.ref_id);
    if (!ref) continue;
    const view = h.kind === "note" ? `mc memo get ${ref.slug}` : `mc skill view ${ref.slug}`;
    lines.push(`- ${h.title} (${h.kind} ${ref.slug}) — "${cleanSnippet(h.snippet)}" → read in full: ${view}`);
  }
  if (!lines.length) return "";
  // Guard the whole block (titles + snippets are workspace-authored → possible injection surface),
  // mirroring skillIndexBlock. One pass covers every string before it enters the goal prompt.
  return guard(`Possibly relevant workspace knowledge:\n${lines.join("\n")}`, `relevance ${key ?? "ticket"}`, ws.id);
}
