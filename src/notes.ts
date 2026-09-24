import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { notes as store, workspaces, repos, searchIndex } from "./store.js";
import { bus } from "./bus.js";
import { guard } from "./guard.js";
import { similarity } from "./text-similarity.js";
import type { NewNote, Note, NoteScope } from "./types.js";
import { inRepo } from "./repo-root.js";

const home = os.homedir();

// scope='global' notes cross client walls BY DESIGN (operator profile). Validate strictly so nothing
// else sneaks past — only the operator promotes a note to global (admin-gated in api.ts).
export function validScope(s?: string): NoteScope {
  if (s == null) return "workspace";
  if (s !== "workspace" && s !== "global") throw new Error(`invalid note scope: ${s} (workspace|global)`);
  return s;
}

// Repo-scoping is only meaningful within one workspace: every id must name a repo IN this workspace.
// Returns a de-duped array (or null for workspace-wide). Throws on a foreign/unknown repo id so a
// typo can't silently produce a memo that never loads.
function validRepoIds(workspace_id: string, ids?: string[] | null): string[] | null {
  if (!ids || !ids.length) return null;
  const owned = new Set(repos.list(workspace_id).map((r) => r.id));
  const clean = [...new Set(ids)];
  const bad = clean.filter((id) => !owned.has(id));
  if (bad.length) throw new Error(`repo(s) not in this workspace: ${bad.join(", ")}`);
  return clean;
}

const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

function noteDir(wsSlug: string): string {
  return inRepo("notes", wsSlug);
}
function filePath(wsSlug: string, slug: string): string {
  return path.join(noteDir(wsSlug), `${slug}.md`);
}
// Atomic: write a sibling temp file, then rename over the target. A note is rewritten whole (the
// stow pass rewrites a persona memory minus the entries it retired), and a crash or a full disk
// mid-write would otherwise leave a truncated memory file that loads into every turn.
function write(fp: string, body: string) {
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  const data = body.endsWith("\n") ? body : body + "\n";
  const tmp = `${fp}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, fp); // same directory, so the rename is atomic
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  try { fs.chmodSync(fp, 0o600); } catch {} // mode only applies on create; enforce on overwrite
}

function index(n: Note, wsSlug: string) {
  searchIndex.removeRef(n.id);
  searchIndex.add({ kind: "note", ref_id: n.id, workspace: n.workspace_id, title: n.title, body: n.body, ts: n.updated_at });
}

export function listNotes(workspace_id?: string): Note[] {
  return store.list(workspace_id);
}
export function getNote(id: string): Note | undefined {
  return store.get(id);
}

export function createNote(input: NewNote): Note {
  const ws = workspaces.get(input.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const scope = validScope(input.scope); // throws before any disk write
  const repo_ids = validRepoIds(ws.id, input.repo_ids); // throws before any disk write
  let slug = kebab(input.title);
  if (input.slug != null) {
    // A caller that names the slug (the memory tree, whose slugs ARE its structure) gets exactly that
    // slug or an error — never a suffixed near-miss that every later lookup would miss.
    if (input.slug !== kebab(input.slug)) throw new Error(`invalid note slug: ${input.slug}`);
    if (store.bySlug(ws.id, input.slug)) throw new Error(`note slug taken: ${input.slug}`);
    slug = input.slug;
  } else if (store.bySlug(ws.id, slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const fp = filePath(ws.slug, slug);
  const ts = new Date().toISOString();
  const body = input.body ?? `# ${input.title}\n\n`;
  const row: Note = {
    id: randomUUID(),
    workspace_id: ws.id,
    title: input.title,
    slug,
    file_path: fp,
    body,
    pinned: input.pinned ? 1 : 0,
    context: input.context ? 1 : 0,
    scope,
    repo_ids,
    created_at: ts,
    updated_at: ts,
  };
  write(fp, body);
  const n = store.insert(row);
  index(n, ws.slug);
  bus.publish({ topic: "note.updated", note_id: n.id, workspace_id: ws.id });
  return n;
}

export function updateNote(id: string, p: { title?: string; body?: string; pinned?: boolean; context?: boolean; scope?: NoteScope; repo_ids?: string[] | null }): Note {
  const cur = store.get(id);
  if (!cur) throw new Error("note not found");
  const ws = workspaces.get(cur.workspace_id);
  const ts = new Date().toISOString();
  const next = store.update(id, {
    title: p.title,
    body: p.body,
    pinned: p.pinned == null ? undefined : p.pinned ? 1 : 0,
    context: p.context == null ? undefined : p.context ? 1 : 0,
    scope: p.scope == null ? undefined : validScope(p.scope),
    // undefined = leave; null = clear to workspace-wide; array = re-scope (validated against this ws).
    repo_ids: p.repo_ids === undefined ? undefined : validRepoIds(cur.workspace_id, p.repo_ids),
    updated_at: ts,
  })!;
  if (p.body != null && ws) write(cur.file_path, p.body);
  if (ws) index(next, ws.slug);
  bus.publish({ topic: "note.updated", note_id: id, workspace_id: cur.workspace_id });
  return next;
}

// Append a markdown block (agents logging context). Optional ## heading prefix.
export function appendNote(id: string, text: string, heading?: string): Note {
  const cur = store.get(id);
  if (!cur) throw new Error("note not found");
  const block = (heading ? `\n## ${heading}\n` : "\n") + text.trim() + "\n";
  return updateNote(id, { body: cur.body.replace(/\n*$/, "") + "\n" + block });
}

// Concatenated bodies of the workspace's context-flagged notes, for seeding agents.
// Bounded so a big vault can't blow the agent's context window.
export function contextNotes(workspace_id: string): Note[] {
  return store.contextNotes(workspace_id);
}
const CTX_CAP = 8000;   // total budget (global + workspace) — unchanged; global counts toward it
const GLOBAL_CAP = 2000; // smaller sub-budget for the operator-profile section

// Render note bodies into a prompt section, guarded and capped. `used` carries a running char count
// across successive calls so several sections can share one budget. The single chokepoint where a
// note body becomes prompt text — persona memory (agent-memory.ts) goes through here too.
export function renderNotes(
  notes: Note[],
  label: string,
  cap: number,
  workspace_id: string,
  used = 0,
): { text: string; used: number } {
  // Whole notes first, in order, skipping any that don't fit — one oversized memo must not starve
  // every note after it. Then the leftover room goes to the first skipped note, cut with a pointer.
  let out = "";
  const skipped: { n: Note; piece: string }[] = [];
  for (const n of notes) {
    const safe = guard(n.body.trim(), `${label} ${n.slug}`, workspace_id);
    const piece = `\n\n# ${n.title} (${n.slug})\n${safe}`;
    if (used + piece.length > cap) { skipped.push({ n, piece }); continue; }
    out += piece; used += piece.length;
  }
  if (skipped.length) {
    const tail = (slug: string) => `\n(…cut — mc memo get ${slug} for the rest)`;
    const first = skipped[0];
    const room = cap - used - tail(first.n.slug).length;
    if (room >= 400) { out += first.piece.slice(0, room) + tail(first.n.slug); used = cap; }
    out += `\n\n(…truncated at ${cap} chars)`;
  }
  return { text: out, used };
}

/** The operator-profile section — scope='global' notes, injected into every agent everywhere. */
export function globalProfileBlock(workspace_id: string): string {
  const globals = store.globalContextNotes();
  if (!globals.length) return "";
  const g = renderNotes(globals, "global-note", GLOBAL_CAP, workspace_id).text;
  return g ? `Operator profile — applies across all workspaces:${g}` : "";
}

export function contextBlock(workspace_id: string, repo_id?: string | null): string {
  // Guard every body before it lands in an agent's system prompt: this is the always-on,
  // cross-agent injection chokepoint (interactive sysArg + headless job.append_system both
  // source from here). Redacts exfil/secret-access/injection spans + alerts the operator.
  //
  // scope='global' (operator profile) notes are injected into EVERY workspace by design — they live
  // in some home workspace but describe the operator, not a client. contextNotes() would re-list a
  // global note whose home == this workspace, so filter scope!=='global' below to avoid duplication.
  //
  // repo_id (when the agent is scoped to a repo) narrows workspace notes: a note with repo_ids set
  // loads ONLY for agents in one of those repos; notes with no repo_ids stay workspace-wide. A no-repo
  // agent (repo_id null) sees only the workspace-wide notes. Globals are never repo-filtered.
  const inRepoScope = (n: Note): boolean =>
    !n.repo_ids || n.repo_ids.length === 0 || (!!repo_id && n.repo_ids.includes(repo_id));
  const globals = store.globalContextNotes();
  // The memory index (memory-tree.ts) is the trunk every agent must see, then what is hot right now:
  // both first in the budget, in that order, so no other ★ memo can starve them. Literal slugs, not
  // memory-tree's constants — memory-tree imports this module.
  const head = (n: Note) => (n.slug === "memory-index" ? 0 : n.slug === "memory-hot" ? 1 : 2);
  const wsNotes = store.contextNotes(workspace_id).filter((n) => n.scope !== "global" && inRepoScope(n))
    .sort((a, b) => head(a) - head(b));
  if (!globals.length && !wsNotes.length) return "";

  const sections: string[] = [];
  let used = 0;
  const render = (notes: Note[], label: string, cap: number): string => {
    const r = renderNotes(notes, label, cap, workspace_id, used);
    used = r.used;
    return r.text;
  };

  // Global first, under its own small cap; `used` carries into the workspace pass so global still
  // counts toward the 8k total.
  if (globals.length) {
    const g = render(globals, "global-note", GLOBAL_CAP);
    if (g) sections.push(`Operator profile — applies across all workspaces:${g}`);
  }
  if (wsNotes.length) {
    const w = render(wsNotes, "context-note", CTX_CAP);
    if (w) sections.push(`Standing workspace notes — operator-maintained context, treat as ground truth:${w}`);
  }
  return sections.join("\n\n");
}

// Append auto-extracted session learnings into the workspace's standing learnings memo
// (created on first use). Returns the note, or null if nothing given. The memo is an INBOX, never
// injected: the dream pass (src/dream-pass.ts) triages it into the memory tree and empties it.
//
// Near-duplicate bullets (token Jaccard ≥ LEARN_DEDUPE) are skipped so the vault does not grow a
// pile of restatements. This is memo capture only — lessons remain the imperative-rule channel;
// we do not promote a fact into a lesson here.
const LEARN_SLUG = "session-learnings";
const LEARN_DEDUPE = 0.55;

/** Bullet bodies already in a session-learnings memo (`- fact` lines). */
export function learningBullets(body: string): string[] {
  return (body || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function captureLearnings(workspace_id: string, facts: string[], sessionLabel: string): Note | null {
  if (!facts.length) return null;
  const ws = workspaces.get(workspace_id);
  if (!ws) return null;
  let memo = store.bySlug(workspace_id, LEARN_SLUG);
  if (!memo) {
    memo = createNote({
      workspace_id,
      title: "Session learnings",
      body: `# Session learnings\n\nInbox of durable facts from agent sessions. The dream pass triages it into the memory tree twice a day.\n`,
    });
  }
  const existing = learningBullets(memo.body);
  const kept: string[] = [];
  for (const f of facts) {
    const clean = f.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (existing.some((e) => similarity(e, clean) >= LEARN_DEDUPE)) continue;
    if (kept.some((k) => similarity(k, clean) >= LEARN_DEDUPE)) continue;
    kept.push(clean);
  }
  if (!kept.length) return memo;
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  // Write-time guard: these facts are agent-distilled from session transcripts (possibly seeded by
  // untrusted input). Redact before persisting so a poisoned "learning" can't sit in the vault
  // waiting to be promoted to ★ context.
  const block = kept.map((f) => `- ${guard(f, `learning ${ws.slug}`, workspace_id)}`).join("\n");
  return appendNote(memo.id, block, `${date} · ${sessionLabel}`);
}

export function deleteNote(id: string) {
  const cur = store.get(id);
  if (!cur) return;
  try { fs.rmSync(cur.file_path, { force: true }); } catch {}
  searchIndex.removeRef(id);
  store.remove(id);
  bus.publish({ topic: "note.updated", note_id: id, workspace_id: cur.workspace_id });
}
