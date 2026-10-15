/**
 * Robert's brief — one standing page per workspace: what the project is, what the operator wants
 * from it, how work is done there, what happened recently and what comes next.
 *
 * Persona memory (agent-memory.ts) is about the OPERATOR — one file, every conversation. A brief is
 * about ONE PROJECT, and it is the thing that makes Robert "aligned with my goals and understanding
 * of each workspace": the operator writes it once, Robert keeps it current as terminals close and
 * decisions land, and every turn on the desk starts with all of them in front of him.
 *
 * A brief is an ordinary note in its workspace (`notes/<ws>/robert-brief.md`): same store, same FTS,
 * same read-time guard, editable from the Desk. It is NOT ★context — workers get the workspace's
 * own context notes; this page is Robert's.
 */
import { workspaces, notes as store } from "./store.js";
import { createNote, appendNote, updateNote, renderNotes } from "./notes.js";
import { similarity } from "./text-similarity.js";
import { CONFIG } from "./config.js";
import type { Note } from "./types.js";

export const BRIEF_SLUG = "robert-brief";
export const RECENTLY = "Recently";
export const NEXT = "Next";
const BRIEF_TITLE = "Robert — brief";
const PER_WS_CAP = 3000;   // one brief in the prompt
const ALL_CAP = 14000;     // every brief, for the unscoped desk Robert

export const BRIEF_SEED =
  `# ${BRIEF_TITLE}\n\n` +
  `## What this is\n\n` +
  `## What the operator wants (goals)\n\n` +
  `## How work is done here\n\n` +
  `## Recently\n\n` +
  `## Next\n`;

/** The workspace's brief, created on first use unless `create` is false. */
export function briefNote(workspace_id: string, create = true): Note | null {
  const ws = workspaces.get(workspace_id);
  if (!ws) return null;
  const existing = store.bySlug(ws.id, BRIEF_SLUG);
  if (existing || !create) return existing ?? null;
  return createNote({ workspace_id: ws.id, title: BRIEF_TITLE, body: BRIEF_SEED });
}

/** Every workspace with its brief (null where none has been written yet). */
export function listBriefs(): Array<{ workspace_id: string; name: string; slug: string; note: Note | null }> {
  return workspaces.list().map((w) => ({ workspace_id: w.id, name: w.name, slug: w.slug, note: store.bySlug(w.id, BRIEF_SLUG) ?? null }));
}

/** Fingerprint for "has any brief changed since the warm process spawned". */
export function briefStamp(): string {
  return listBriefs().map((b) => b.note?.updated_at ?? "").join("|");
}

export function appendBrief(workspace_id: string, fact: string, heading?: string): Note {
  const n = briefNote(workspace_id);
  if (!n) throw new Error("workspace not found");
  return appendNote(n.id, fact.trim(), heading);
}

export function rewriteBrief(workspace_id: string, body: string): Note {
  const n = briefNote(workspace_id);
  if (!n) throw new Error("workspace not found");
  return updateNote(n.id, { body });
}

const isSeed = (n: Note) => n.body.trim() === BRIEF_SEED.trim();

// ───────────────────────────── the two living sections ─────────────────────────────
// "Recently" and "Next" are the only parts of a brief anything but a human writes, and the worklog
// (src/worklog.ts) rewrites them on every finished piece of work. appendNote() would staple a SECOND
// "## Recently" onto the end of the page each time, so these do section surgery instead: the
// operator's prose in the other headings is never touched, and the two lists stay lists.

const headingRe = (h: string) => new RegExp(`^##\\s+${h}\\s*$`, "i");
const isHeading = (l: string) => /^##\s+/.test(l);

function sectionRange(lines: string[], heading: string): { start: number; end: number } | null {
  const at = lines.findIndex((l) => headingRe(heading).test(l.trim()));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  return { start: at + 1, end };
}

function ensureSection(lines: string[], heading: string): { start: number; end: number } {
  const found = sectionRange(lines, heading);
  if (found) return found;
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push("", `## ${heading}`);
  return { start: lines.length, end: lines.length };
}

/** Replace a section's body with `items`, keeping one blank line after it. */
function spliceSection(lines: string[], r: { start: number; end: number }, items: string[]): string {
  lines.splice(r.start, r.end - r.start, ...items, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Newest-last log of what shipped, capped: older lines roll off into the worklog ledger. */
export function mergeRecently(body: string, line: string, max = CONFIG.briefRecentlyMax): string {
  const lines = (body || "").split("\n");
  const r = ensureSection(lines, RECENTLY);
  const kept = lines.slice(r.start, r.end).map((l) => l.trimEnd()).filter(Boolean);
  kept.push(line.trim().startsWith("-") ? line.trim() : `- ${line.trim()}`);
  return spliceSection(lines, r, kept.slice(-Math.max(1, max)));
}

const NEXT_DEDUPE = 0.55; // "same follow-up, said differently" — same bar as the learnings memo
const NEXT_TICK = 0.6;    // "this entry IS that follow-up" — a shade stricter, it closes an item

/** "- [ ] ship the export (from …, 2026-09-12)" → "ship the export" */
export function nextItemText(line: string): string {
  return line
    .replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "")
    .replace(/\s*\(from .*?,\s*\d{4}-\d{2}-\d{2}\)\s*$/, "")
    .trim();
}

/**
 * Merge a finished entry into "## Next": tick the open items this work closed (same ticket key, or
 * near-identical text), then add its own leftovers — skipping anything already listed.
 */
export function mergeNext(
  body: string,
  add: string[],
  ctx: { what: string; date: string; ticket?: string | null },
): string {
  const lines = (body || "").split("\n");
  const r = ensureSection(lines, NEXT);
  const items = lines.slice(r.start, r.end).map((l) => l.trimEnd()).filter(Boolean);
  const key = ctx.ticket ? new RegExp(`\\b${ctx.ticket.replace(/[^\w-]/g, "")}\\b`) : null;

  const ticked = items.map((l) => {
    const open = /^\s*[-*]\s*\[\s\]/.test(l);
    if (!open) return l;
    const text = nextItemText(l);
    // The key must be in the ITEM, not in the "(from …)" provenance — otherwise a ticket's second
    // build round would tick the leftovers its first round wrote.
    const closes = (key && key.test(text)) || similarity(text, ctx.what) >= NEXT_TICK;
    return closes ? l.replace(/\[\s\]/, "[x]") : l;
  });

  for (const raw of add) {
    const item = raw.replace(/\s+/g, " ").trim();
    if (!item) continue;
    if (ticked.some((l) => similarity(nextItemText(l), item) >= NEXT_DEDUPE)) continue;
    ticked.push(`- [ ] ${item} (from ${ctx.what}, ${ctx.date})`);
  }
  return spliceSection(lines, r, ticked);
}

/**
 * The brief as Robert should read it when it no longer fits his budget. renderNotes drops a note
 * WHOLE when it overruns, so a brief that grows past PER_WS_CAP would vanish from the prompt
 * entirely — taking the two sections he needs most with it. Recently + Next go first (trimmed from
 * their oldest lines if either alone is over budget), then the operator's standing prose fills
 * whatever is left.
 */
export function briefPromptBody(body: string, cap: number): string {
  const text = (body || "").trim();
  if (cap <= 0) return "";
  if (text.length <= cap) return text;

  const blocks: string[][] = [];
  for (const l of text.split("\n")) {
    if (isHeading(l) || !blocks.length) blocks.push([]);
    blocks[blocks.length - 1].push(l);
  }
  const nameOf = (b: string[]) => (b[0].match(/^##\s+(.*)$/)?.[1] ?? "").trim().toLowerCase();
  const head = blocks.filter((b) => !isHeading(b[0]));
  const priority = [RECENTLY, NEXT]
    .map((h) => blocks.find((b) => nameOf(b) === h.toLowerCase()))
    .filter((b): b is string[] => !!b);
  const rest = blocks.filter((b) => isHeading(b[0]) && !priority.includes(b));

  const out: string[] = [];
  let used = 0;
  const fit = (b: string[], trimmable: boolean): void => {
    let piece = b.join("\n").trimEnd();
    // A priority section over budget keeps its heading and its NEWEST lines rather than being dropped.
    while (trimmable && piece.length + used + 2 > cap && b.length > 2) {
      b.splice(1, 1);
      piece = b.join("\n").trimEnd();
    }
    if (!piece || used + piece.length + 2 > cap) return;
    out.push(piece);
    used += piece.length + 2;
  };
  head.forEach((b) => fit(b, false));
  priority.forEach((b) => fit(b, true));
  rest.forEach((b) => fit(b, false));
  return out.join("\n\n");
}

/**
 * The block injected into Robert's system prompt: one brief when he is scoped to a workspace, every
 * written brief when he is the unscoped desk manager. Empty when nothing has been written yet.
 */
export function briefsBlock(workspace_id?: string | null): string {
  const rows = listBriefs().filter((b) => b.note && !isSeed(b.note) && (!workspace_id || b.workspace_id === workspace_id));
  if (!rows.length) return "";
  let used = 0;
  const parts: string[] = [];
  const cap = workspace_id ? PER_WS_CAP : ALL_CAP;
  for (const b of rows) {
    // Headroom for the title line renderNotes adds, so the reordered body is what actually fits.
    const body = briefPromptBody(b.note!.body, cap - used - b.note!.title.length - 120);
    const r = renderNotes([{ ...b.note!, body }], "brief", cap, b.workspace_id, used);
    if (!r.text) break;
    parts.push(`\n\n### ${b.name} (workspace ${b.workspace_id})${r.text}`);
    used = r.used;
    if (used >= ALL_CAP) break;
  }
  return (
    `YOUR STANDING UNDERSTANDING OF EACH PROJECT — written by the operator, kept current by you. ` +
    `Treat the goals as his goals and act on them without being told again:` + parts.join("")
  );
}
