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
export const GOALS = "What the operator wants (goals)";
export const HOW = "How work is done here";
export const STANDING = "Standing orders";
const BRIEF_TITLE = "Robert — brief";
const PER_WS_CAP = 3000;   // one brief in the prompt
const ALL_CAP = 20000;     // every brief, for the unscoped desk Robert (fair share each)
/** Ticked Next items kept so a recent closure is still visible; older ones are history (the ledger). */
const NEXT_TICKED_KEEP = 5;

/**
 * The operator's rules for one workspace, in OpenClaw's standing-order shape (scope, triggers,
 * approval gates): what "ship it" means here, what follows a merge, and where Robert's hands stop.
 * Empty labels are left in the page as a prompt to fill them and never reach the model.
 */
export const STANDING_TEMPLATE = [
  "- Ship:",
  "- After merge:",
  "- Robert may do alone:",
  "- Ask first:",
  "- Never:",
];

export const BRIEF_SEED =
  `# ${BRIEF_TITLE}\n\n` +
  `## What this is\n\n` +
  `## ${GOALS}\n\n` +
  `## ${HOW}\n\n` +
  `## ${STANDING}\n${STANDING_TEMPLATE.join("\n")}\n\n` +
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

/**
 * Add a fact under a heading. appendNote() would staple a SECOND "## <heading>" onto the end of the
 * page every time — that is how a live brief collected sixty "## Recently" sections — so a heading
 * the page already has gets the fact inside it, and Recently/Next go through their own merges.
 */
export function appendBrief(workspace_id: string, fact: string, heading?: string): Note {
  const n = briefNote(workspace_id);
  if (!n) throw new Error("workspace not found");
  const text = fact.trim();
  const h = heading?.trim();
  if (!h) return appendNote(n.id, text);
  const today = new Date().toISOString().slice(0, 10);
  if (sameHeading(h, RECENTLY)) return rewriteBrief(workspace_id, mergeRecently(n.body, text));
  if (sameHeading(h, NEXT)) {
    const items = text.split("\n").map((l) => nextItemText(l)).filter(Boolean);
    return rewriteBrief(workspace_id, mergeNext(n.body, items, { what: "a note", date: today }));
  }
  const lines = n.body.split("\n");
  const r = sectionRange(lines, h);
  if (!r) return appendNote(n.id, text, h);
  const kept = lines.slice(r.start, r.end);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return rewriteBrief(workspace_id, spliceSection(lines, r, [...kept, text]));
}

/** Every write lands normalized: one section per heading, Recently and Next within their caps. */
export function rewriteBrief(workspace_id: string, body: string): Note {
  const n = briefNote(workspace_id);
  if (!n) throw new Error("workspace not found");
  return updateNote(n.id, { body: normalizeBrief(body) });
}

// Normalized first: a page seeded before Standing orders existed is still an untouched seed.
const isSeed = (n: Note) => normalizeBrief(n.body).trim() === BRIEF_SEED.trim();

// ───────────────────────────── the two living sections ─────────────────────────────
// "Recently" and "Next" are the only parts of a brief anything but a human writes, and the worklog
// (src/worklog.ts) rewrites them on every finished piece of work. appendNote() would staple a SECOND
// "## Recently" onto the end of the page each time, so these do section surgery instead: the
// operator's prose in the other headings is never touched, and the two lists stay lists.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Escaped: "What the operator wants (goals)" is a heading, and its parentheses are not a group.
const headingRe = (h: string) => new RegExp(`^##\\s+${escapeRe(h.trim())}\\s*$`, "i");
const isHeading = (l: string) => /^##\s+/.test(l);
const headingName = (l: string) => (l.match(/^##\s+(.*)$/)?.[1] ?? "").trim().toLowerCase();
const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
  // Normalized first, so the new line lands in the one Recently and is not cut by folding duplicates.
  const lines = normalizeBrief(body || "").split("\n");
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
  const lines = normalizeBrief(body || "").split("\n");
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
  return spliceSection(lines, r, capNext(ticked));
}

const isTicked = (l: string) => /^\s*[-*]\s*\[[xX]\]/.test(l);

/**
 * Next is a queue Robert works from, not an archive: the newest `max` open items and the last few
 * ticked ones, in their original order. What rolls off is still in the worklog ledger.
 */
export function capNext(items: string[], max = CONFIG.briefNextMax): string[] {
  const keep = new Set<number>();
  let open = 0, done = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (isTicked(items[i])) { if (done++ < NEXT_TICKED_KEEP) keep.add(i); }
    else if (open++ < Math.max(1, max)) keep.add(i);
  }
  return items.filter((_, i) => keep.has(i));
}

/**
 * One section per heading, in first-seen order, with a repeat's lines folded into the first —
 * then Recently and Next cut to their caps, and a Standing orders section where there is none.
 * Idempotent, so it runs on every write and on every read into the prompt.
 */
export function normalizeBrief(body: string): string {
  const text = (body || "").replace(/\r\n/g, "\n");
  const pre: string[] = [];
  const order: string[] = [];
  const sections = new Map<string, { heading: string; lines: string[] }>();
  let cur: string[] = pre;
  for (const l of text.split("\n")) {
    if (isHeading(l)) {
      const key = headingName(l);
      let s = sections.get(key);
      if (!s) {
        s = { heading: l.trim(), lines: [] };
        sections.set(key, s);
        order.push(key);
      }
      cur = s.lines;
      continue;
    }
    cur.push(l);
  }
  if (!order.length) return text;

  const tidy = (ls: string[]) => {
    const out = ls.map((l) => l.trimEnd());
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  const items = (ls: string[]) => ls.map((l) => l.trimEnd()).filter((l) => l.trim());

  const recently = sections.get(RECENTLY.toLowerCase());
  if (recently) recently.lines = items(recently.lines).slice(-Math.max(1, CONFIG.briefRecentlyMax));
  const next = sections.get(NEXT.toLowerCase());
  if (next) next.lines = capNext(items(next.lines));

  if (!sections.has(STANDING.toLowerCase())) {
    // Beside the operator's other rules: after "How work is done here", else before Recently.
    const after = order.indexOf(HOW.toLowerCase());
    const before = order.indexOf(RECENTLY.toLowerCase());
    const at = after >= 0 ? after + 1 : before >= 0 ? before : order.length;
    sections.set(STANDING.toLowerCase(), { heading: `## ${STANDING}`, lines: [...STANDING_TEMPLATE] });
    order.splice(at, 0, STANDING.toLowerCase());
  }

  const parts: string[] = [];
  const head = tidy(pre);
  if (head.length) parts.push(head.join("\n"));
  for (const key of order) {
    const s = sections.get(key)!;
    const ls = tidy(s.lines);
    parts.push(ls.length ? `${s.heading}\n${ls.join("\n")}` : s.heading);
  }
  return parts.join("\n\n") + "\n";
}

/** Standing orders minus the labels nobody filled in — an empty "- Never:" is not a rule. */
function filledStanding(lines: string[]): string[] {
  return lines.filter((l, i) => i === 0 || (l.trim() && !/^\s*[-*]\s*[^:]{1,40}:\s*$/.test(l)));
}

/**
 * The brief as Robert should read it. Normalized first (one section per heading, capped lists),
 * empty sections and unfilled Standing-order labels left out — they say nothing. When it still
 * does not fit his budget, renderNotes would drop the note WHOLE, so the sections he acts on go
 * first: Standing orders, goals, Next, Recently (each trimmed from its oldest lines if alone over
 * budget), then the operator's other prose fills whatever is left.
 */
export function briefPromptBody(body: string, cap: number): string {
  if (cap <= 0) return "";
  const blocks: string[][] = [];
  for (const l of normalizeBrief(body || "").trim().split("\n")) {
    if (isHeading(l) || !blocks.length) blocks.push([]);
    blocks[blocks.length - 1].push(l);
  }
  const nameOf = (b: string[]) => headingName(b[0]);
  const kept = blocks
    .map((b) => (nameOf(b) === STANDING.toLowerCase() ? filledStanding(b) : b))
    .map((b) => { const c = [...b]; while (c.length && !c[c.length - 1].trim()) c.pop(); return c; })
    .filter((b) => b.length && (!isHeading(b[0]) || b.slice(1).some((l) => l.trim())));
  const text = kept.map((b) => b.join("\n")).join("\n\n");
  if (text.length <= cap) return text;

  const head = kept.filter((b) => !isHeading(b[0]));
  const priority = [STANDING, GOALS, NEXT, RECENTLY]
    .map((h) => kept.find((b) => nameOf(b) === h.toLowerCase()))
    .filter((b): b is string[] => !!b);
  const rest = kept.filter((b) => isHeading(b[0]) && !priority.includes(b));

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
  // Unscoped, every workspace gets a fair share: one long brief used to take the whole budget and
  // leave the workspaces after it out of Robert's prompt entirely.
  const share = workspace_id ? cap : Math.min(PER_WS_CAP, Math.floor(ALL_CAP / rows.length));
  for (const b of rows) {
    // Headroom for the title line renderNotes adds, so the reordered body is what actually fits.
    const room = Math.min(share, cap - used) - b.note!.title.length - 120;
    const body = briefPromptBody(b.note!.body, room);
    const r = renderNotes([{ ...b.note!, body }], "brief", cap, b.workspace_id, used);
    if (!r.text) break;
    parts.push(`\n\n### ${b.name} (workspace ${b.workspace_id})${r.text}`);
    used = r.used;
    if (used >= ALL_CAP) break;
  }
  return (
    `YOUR STANDING UNDERSTANDING OF EACH PROJECT — written by the operator, kept current by you. ` +
    `Treat the goals as his goals and act on them without being told again. Its Standing orders are his ` +
    `rules for that workspace and outrank your defaults: "Robert may do alone" you do without asking, ` +
    `"Ask first" you hand up, "Never" you never do, "Ship" / "After merge" are the steps there. ` +
    `Only he writes Standing orders — propose a change, do not make it:` + parts.join("")
  );
}
