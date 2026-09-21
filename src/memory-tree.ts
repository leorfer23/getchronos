/**
 * Workspace memory as a tree, so it can grow without becoming unreadable.
 *
 *   Memory index (★, slug `memory-index`)   — the trunk. One short line per rule, grouped under
 *   │                                         `## Topic` headings. Injected into EVERY agent's system
 *   │                                         prompt, first, ahead of every other ★ memo.
 *   └─ Memory: <Topic> (slug `memory-<topic>`) — a branch. The expanded detail behind the index
 *                                               lines of one topic. NOT ★: agents see its slug in the
 *                                               memo index and `mc memo get` it when the topic comes up.
 *
 * Both levels are hard-capped. A write that would overflow is refused with what to condense,
 * instead of silently truncating — the index stays a map, not a dump.
 *
 * `mc learn` stays what it was: an inbox of facts the operator may promote into the tree from the
 * Desk. `mc remember` writes straight into the tree.
 */
import { notes as store, sessions } from "./store.js";
import { kv } from "./store/kv.js";
import { appendNote, createNote, updateNote } from "./notes.js";
import { guard } from "./guard.js";
import { similarity } from "./text-similarity.js";
import { entryHash } from "./memory-tiers.js";
import { checkFactAsync } from "./memory-conflicts.js";
import type { Note } from "./types.js";

export const INDEX_SLUG = "memory-index";
export const INDEX_CAP = 3000;
export const LINE_CAP = 200;
export const BRANCH_CAP = 6000;
const DEDUPE = 0.8;

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const titleCase = (s: string) => s.trim().replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase());

export const topicSlug = (topic: string) => `memory-${kebab(topic) || "general"}`;

const INDEX_HEAD =
  "# Memory index\n\nOne line per rule, grouped by topic. `→ memory-x` = details in that memo (`mc memo get memory-x`).\n";

/** `## Topic` sections of an index body, in order, with their bullet lines. */
export function indexSections(body: string): { topic: string; lines: string[] }[] {
  const out: { topic: string; lines: string[] }[] = [];
  let cur: { topic: string; lines: string[] } | null = null;
  for (const raw of (body || "").split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) { cur = { topic: h[1], lines: [] }; out.push(cur); continue; }
    const b = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (b && cur) cur.lines.push(b[1].trim());
  }
  return out;
}

function renderIndex(sections: { topic: string; lines: string[] }[]): string {
  return INDEX_HEAD + sections.filter((s) => s.lines.length).map((s) => `\n## ${s.topic}\n` + s.lines.map((l) => `- ${l}`).join("\n") + "\n").join("");
}

export function memoryIndex(workspace_id: string): Note | undefined {
  return store.bySlug(workspace_id, INDEX_SLUG);
}

function ensureIndex(workspace_id: string): Note {
  const cur = memoryIndex(workspace_id);
  if (cur) return cur.context ? cur : updateNote(cur.id, { context: true });
  const n = createNote({ workspace_id, title: "Memory index", body: INDEX_HEAD, context: true });
  if (n.slug !== INDEX_SLUG) throw new Error(`memory index slug collision: ${n.slug}`);
  return n;
}

/** Strip a line's trailing `→ memory-<topic>` pointer so only the rule's prose is compared. */
const lineProse = (l: string) => l.replace(/\s*→\s*memory-[a-z0-9-]+$/, "").trim();

/**
 * Audit a just-added index line against the other lines under its heading.
 *
 * An index line has no row of its own — it is a line inside a memo body — so it is identified by
 * the hash of its prose, the same identity `stow` uses to track an entry across rewrites.
 */
function checkIndexLineForConflicts(workspace_id: string, fact: string, sectionLines: string[]): void {
  try {
    const pool = sectionLines
      .map(lineProse)
      .filter((t) => t && t !== fact)
      .map((t) => ({ kind: "memory-line" as const, ref: entryHash(t), text: t }));
    if (!pool.length) return;
    checkFactAsync(workspace_id, { kind: "memory-line", ref: entryHash(fact), text: fact }, pool);
  } catch (e) {
    console.error("[memory-tree] conflict check failed", e);
  }
}

export type RememberResult =
  | { ok: true; note: Note; branch: Note | null; added: boolean; topic: string }
  | { ok: false; error: string };

/**
 * Put one rule into the tree: a short line under its topic in the ★ index, and — when there is more
 * to say — the detail into that topic's branch memo, with the index line pointing at it.
 */
export function rememberFact(workspace_id: string, input: { fact: string; topic?: string; detail?: string }): RememberResult {
  const fact = input.fact.replace(/\s+/g, " ").trim();
  if (!fact) return { ok: false, error: "nothing to remember" };
  if (fact.length > LINE_CAP)
    return { ok: false, error: `index lines are capped at ${LINE_CAP} chars (got ${fact.length}) — keep the rule short and put the rest in --detail` };
  const topic = titleCase(input.topic || "General");
  const detail = (input.detail || "").trim();

  const index = ensureIndex(workspace_id);
  const sections = indexSections(index.body);
  const all = sections.flatMap((s) => s.lines.map((l) => l.replace(/\s*→\s*memory-[a-z0-9-]+$/, "")));
  const dup = all.some((l) => similarity(l, fact) >= DEDUPE);

  let branch: Note | null = null;
  if (detail) {
    const slug = topicSlug(topic);
    branch = store.bySlug(workspace_id, slug) ?? null;
    const block = `- **${guard(fact, "memory-branch", workspace_id)}** — ${guard(detail, "memory-branch", workspace_id)}`;
    const nextLen = (branch?.body.length ?? 0) + block.length;
    if (nextLen > BRANCH_CAP)
      return { ok: false, error: `${slug} would pass ${BRANCH_CAP} chars — condense it first (mc memo edit ${slug} --body "…")` };
    if (!branch) {
      branch = createNote({ workspace_id, title: `Memory: ${topic}`, body: `# Memory: ${topic}\n\nDetail behind the "${topic}" lines of the memory index.\n` });
      if (branch.slug !== slug) throw new Error(`memory branch slug collision: ${branch.slug}`);
    }
    branch = appendNote(branch.id, block);
  }

  if (dup && !branch) return { ok: true, note: index, branch, added: false, topic };
  if (!dup) {
    const line = guard(fact, "memory-index", workspace_id) + (branch ? ` → ${branch.slug}` : "");
    let sec = sections.find((s) => s.topic.toLowerCase() === topic.toLowerCase());
    if (!sec) { sec = { topic, lines: [] }; sections.push(sec); }
    // Snapshot the heading's existing lines BEFORE adding this one. Identifying the new line by
    // its prose would not reliably exclude it: `guard` may have redacted a span, so the line as
    // stored no longer equals `fact`, and it would end up judged against itself.
    const siblings = [...sec.lines];
    sec.lines.push(line);
    const body = renderIndex(sections);
    if (body.length > INDEX_CAP)
      return { ok: false, error: `the memory index would pass ${INDEX_CAP} chars — merge or drop lines first (mc memo edit ${INDEX_SLUG} --body "…"), or move detail into a topic memo` };
    const saved = updateNote(index.id, { body });
    // The dedupe above only caught "we already know this". A rule can be new AND contradict one
    // already standing under the same heading — that is the pair an agent picks between at random.
    // Compared only within its own topic: the tree's own grouping is the cheap narrowing.
    checkIndexLineForConflicts(workspace_id, fact, siblings);
    return { ok: true, note: saved, branch, added: true, topic };
  }
  return { ok: true, note: index, branch, added: false, topic };
}

// ── freshness ─────────────────────────────────────────────────────────────────────────────────
// A terminal's system prompt is baked at spawn. When a ★ memo changes while it is open, the next
// prompt it receives carries the new text (the claude UserPromptSubmit hook prints it as context).

const seenKey = (sessionId: string) => `memory.seen.${sessionId}`;
const NOTICE_CAP = 3000;
const NOTE_CAP = 1500;

export function markMemorySeen(sessionId: string, at = new Date().toISOString()) {
  kv.set(seenKey(sessionId), at);
}
export function forgetMemorySeen(sessionId: string) {
  kv.del(seenKey(sessionId));
}

/** The ★ memos that changed since this terminal last saw them, as prompt text — or "" (and no mark). */
export function memoryNotice(sessionId: string, now = new Date().toISOString()): string {
  const s = sessions.get(sessionId);
  if (!s?.workspace_id) return "";
  const since = kv.get(seenKey(sessionId)) ?? s.created_at;
  const inScope = (n: Note) => !n.repo_ids || !n.repo_ids.length || (!!s.repo_id && n.repo_ids.includes(s.repo_id));
  const changed = store.contextNotes(s.workspace_id).filter((n) => n.scope !== "global" && inScope(n) && n.updated_at > since);
  if (!changed.length) return "";
  changed.sort((a, b) => (a.slug === INDEX_SLUG ? -1 : b.slug === INDEX_SLUG ? 1 : 0));
  let out = "Workspace memory changed since this terminal started. This replaces the copy in your system prompt:";
  for (const n of changed) {
    const body = guard(n.body.trim(), `memory-notice ${n.slug}`, s.workspace_id);
    const clipped = body.length > NOTE_CAP ? body.slice(0, NOTE_CAP) + `\n(…cut — mc memo get ${n.slug})` : body;
    const piece = `\n\n# ${n.title} (${n.slug})\n${clipped}`;
    if (out.length + piece.length > NOTICE_CAP) { out += `\n\n(more changed: mc memo list)`; break; }
    out += piece;
  }
  markMemorySeen(sessionId, now);
  return out;
}
