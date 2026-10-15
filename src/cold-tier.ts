/**
 * The cold tier's ceiling — the memos nothing else ever shrinks.
 *
 * The dream pass keeps L1/L2 small by moving what it removes into `memory-archive`, the stow pass does
 * the same into `memory-archive-<agent>`, the worklog appends one block per finished terminal, and a
 * Lead writes a `brief-<slice>` memo for every worker it spawns. All four were append-only, so the
 * cold tier grew without bound (300k-char archives, 157 dead briefs in one workspace). This sweep,
 * run from the monitor's retention sweep (hourly, with or without a dream), is the bound. It is
 * deterministic — no model call — idempotent, and cheap when there is nothing to do:
 *
 *   capColdNote    a cold note is a preamble plus `## ` sections in append order. Sections older than
 *                  coldTier.archiveDays leave, then the oldest leave until the note fits
 *                  coldTier.archiveMaxChars. The newest section always stays: it is the block the
 *                  last dream pass wrote, and `mc dream undo` removes it by exact text. What is kept
 *                  is a byte-exact suffix of the note, so every surviving block still matches its run.
 *   rollWorklog    `worklog` keeps coldTier.worklogDays of entries; older ones move, verbatim, into
 *                  `worklog-archive` — itself a cold note, so it is capped like the rest. Moved, not
 *                  dropped: FTS recall still finds them until the archive cap ages them out.
 *   retireBriefs   a `brief-*` memo leaves for `brief-archive` once no live terminal, live Lead or
 *                  enabled job owns it and it went untouched for coldTier.briefDays — or sooner
 *                  (coldTier.briefEndedDays) when the terminals that used it are known and all ended.
 *
 * Briefs carry no owner column. Ownership is evidence: a session whose spawn goal / goal / first
 * prompt names the slug (the "Memo vault" index line every agent gets is ignored — it lists every
 * memo), or a session that `mc memo get` it (memory_usage). A worker's Lead counts as an owner too, so
 * a live Lead keeps every brief its workers used. "Touched" is the later of the memo's last edit and
 * its last `mc memo get`.
 *
 * Never touched here: pinned memos, ★ context memos, memory-index / memory-hot / memory-<topic>
 * (already capped by the dream pass), robert-brief, and every other memo.
 */
import { CONFIG } from "./config.js";
import { db, notes as noteStore, workspaces } from "./store.js";
import { createNote, deleteNote, updateNote } from "./notes.js";
import { ARCHIVE_SLUG } from "./memory-tree.js";
import { WORKLOG_SLUG } from "./worklog.js";
import type { Note, Workspace } from "./types.js";

export const WORKLOG_ARCHIVE_SLUG = "worklog-archive";
export const BRIEF_ARCHIVE_SLUG = "brief-archive";
const DAY = 86_400_000;

const WORKLOG_ARCHIVE_SEED =
  "# Worklog archive\n\nCold tier: worklog entries older than the live ledger keeps, moved here verbatim. " +
  "Never injected — `mc recall` finds them. Trimmed by age and size like every archive.\n";
const BRIEF_ARCHIVE_SEED =
  "# Brief archive\n\nCold tier: `brief-*` memos whose terminals and Lead have ended, moved here with why. " +
  "Never injected — `mc recall` finds them. Recovery is copy back into a new memo.\n";

/** The memos this sweep caps: every archive the daemon appends to. */
export function isColdNote(slug: string): boolean {
  return slug === ARCHIVE_SLUG || slug.startsWith(`${ARCHIVE_SLUG}-`) || slug === WORKLOG_ARCHIVE_SLUG
    || slug === BRIEF_ARCHIVE_SLUG || /^session-learnings-archive(?:-|$)/.test(slug);
}

export function isBriefCandidate(n: Pick<Note, "slug" | "pinned" | "context">): boolean {
  return /^brief-[a-z0-9]/.test(n.slug) && n.slug !== BRIEF_ARCHIVE_SLUG && !n.pinned && !n.context;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const localDay = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ───────────────────────────── archive cap ─────────────────────────────

interface Section { text: string; date: string }

/** Preamble + `## ` sections. An undated heading inherits the date before it (the note's own, first). */
export function splitSections(body: string, fallbackDate: string): { preamble: string; sections: Section[] } {
  const starts: number[] = [];
  const re = /^## /gm;
  for (let m = re.exec(body); m; m = re.exec(body)) starts.push(m.index);
  if (!starts.length) return { preamble: body, sections: [] };
  let date = fallbackDate;
  const sections = starts.map((s, i) => {
    const text = body.slice(s, starts[i + 1] ?? body.length);
    const d = text.split("\n", 1)[0].match(/\d{4}-\d{2}-\d{2}/);
    if (d) date = d[0];
    return { text, date };
  });
  return { preamble: body.slice(0, starts[0]), sections };
}

export interface CapResult { body: string; sections: number; chars: number }

/**
 * Drop a prefix of sections: those older than `days`, then the oldest until the note is within
 * `maxChars`. Never the last section. The result is the preamble plus an exact suffix of the body.
 */
export function capColdNote(body: string, opts: { now: Date; days: number; maxChars: number; fallbackDate: string }): CapResult {
  const { preamble, sections } = splitSections(body, opts.fallbackDate);
  if (sections.length < 2) return { body, sections: 0, chars: 0 };
  const cutoff = opts.days > 0 ? isoDay(new Date(opts.now.getTime() - opts.days * DAY)) : "";
  let len = body.length;
  let i = 0;
  while (i < sections.length - 1) {
    const s = sections[i];
    const old = !!cutoff && s.date < cutoff;
    const over = opts.maxChars > 0 && len > opts.maxChars;
    if (!old && !over) break;
    len -= s.text.length;
    i++;
  }
  if (!i) return { body, sections: 0, chars: 0 };
  const next = preamble + sections.slice(i).map((s) => s.text).join("");
  return { body: next, sections: i, chars: body.length - next.length };
}

// ───────────────────────────── worklog roll ─────────────────────────────

const ENTRY_RE = /^### (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/;

/**
 * Split the ledger at the first entry newer than `days` (local dates, like the ledger's stamps).
 * Everything before it — a contiguous prefix of whole entries — is `rolled`; the header stays.
 */
export function rollWorklog(body: string, now: Date, days: number): { keep: string; rolled: string; entries: number; from: string; to: string } {
  const none = { keep: body, rolled: "", entries: 0, from: "", to: "" };
  if (!(days > 0)) return none;
  const cutoff = localDay(new Date(now.getTime() - days * DAY));
  const lines = body.split("\n");
  const first = lines.findIndex((l) => ENTRY_RE.test(l));
  if (first < 0) return none;
  let end = first;
  let entries = 0;
  let from = "";
  let to = "";
  for (let i = first; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_RE);
    if (!m) continue;
    if (m[1] >= cutoff) break;
    entries++;
    from ||= m[1];
    to = m[1];
    end = i + 1;
    while (end < lines.length && !ENTRY_RE.test(lines[end])) end++;
    i = end - 1;
  }
  if (!entries) return none;
  const head = lines.slice(0, first).join("\n").replace(/\n*$/, "\n\n");
  const rest = lines.slice(end).join("\n").replace(/^\n+/, "");
  return { keep: head + rest, rolled: lines.slice(first, end).join("\n").trim(), entries, from, to };
}

// ───────────────────────────── brief retirement ─────────────────────────────

interface SessionRef { id: string; role: string; lead_id: string | null; ended_at: string | null; text: string }

const mentions = (text: string, slug: string) =>
  new RegExp(`(^|[^a-z0-9-])${slug.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`).test(text);

/** The prompt minus the memo-vault index line, which names every memo and so proves nothing. */
const ownText = (...parts: (string | null)[]) =>
  parts.filter(Boolean).join("\n").split("\n").filter((l) => !l.includes("Memo vault (")).join("\n");

export interface BriefVerdict { note: Note; retire: boolean; reason: string }

export function judgeBriefs(ws: Workspace, now: Date, cfg = CONFIG.coldTier): BriefVerdict[] {
  const briefs = noteStore.list(ws.id).filter(isBriefCandidate);
  if (!briefs.length || !(cfg.briefDays > 0)) return [];
  const since = new Date(Math.min(...briefs.map((b) => Date.parse(b.created_at))) - DAY).toISOString();
  const sessions = (db.prepare(
    `SELECT id, role, lead_id, ended_at, goal, spawn_goal, first_prompt FROM sessions
      WHERE workspace_id = ? AND (created_at >= ? OR ended_at IS NULL)`,
  ).all(ws.id, since) as Array<SessionRef & { goal: string | null; spawn_goal: string | null; first_prompt: string | null }>)
    .map((s) => ({ id: s.id, role: s.role, lead_id: s.lead_id, ended_at: s.ended_at, text: ownText(s.spawn_goal, s.goal, s.first_prompt) }));
  const byId = new Map(sessions.map((s) => [s.id, s] as const));
  const leadEnded = new Map<string, string | null>();
  const leadOf = (id: string) => {
    if (!leadEnded.has(id)) {
      const r = db.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(id) as { ended_at: string | null } | undefined;
      leadEnded.set(id, r ? r.ended_at : "gone");
    }
    return leadEnded.get(id)!;
  };
  const usage = db.prepare(
    `SELECT ref, session_id, MAX(ts) ts FROM memory_usage WHERE workspace_id = ? AND kind = 'memo_get' AND ref_kind = 'note' GROUP BY ref, session_id`,
  ).all(ws.id) as { ref: string; session_id: string | null; ts: string }[];
  const jobText = (db.prepare("SELECT goal, append_system FROM jobs WHERE workspace_id = ? AND enabled = 1").all(ws.id) as { goal: string | null; append_system: string | null }[])
    .map((j) => `${j.goal ?? ""}\n${j.append_system ?? ""}`).join("\n");

  return briefs.map((note) => {
    const keep = (reason: string): BriefVerdict => ({ note, retire: false, reason });
    if (jobText && mentions(jobText, note.slug)) return keep("named by an enabled job");
    const reads = usage.filter((u) => u.ref === note.id);
    const owners = new Set<string>(reads.map((u) => u.session_id).filter((x): x is string => !!x));
    for (const s of sessions) if (mentions(s.text, note.slug)) owners.add(s.id);
    let lastEnd = "";
    for (const id of owners) {
      const s = byId.get(id);
      const ended = s ? s.ended_at : leadOf(id);
      if (!ended) return keep(`owner ${id.slice(0, 8)} is live`);
      if (s?.lead_id && !leadOf(s.lead_id)) return keep(`lead ${s.lead_id.slice(0, 8)} is live`);
      if (ended !== "gone" && ended > lastEnd) lastEnd = ended;
    }
    const touched = [note.updated_at, ...reads.map((u) => u.ts)].reduce((a, b) => (b > a ? b : a));
    const idle = (now.getTime() - Date.parse(touched)) / DAY;
    if (idle >= cfg.briefDays) return { note, retire: true, reason: `untouched ${Math.floor(idle)}d, no live owner` };
    const endedFor = lastEnd ? (now.getTime() - Date.parse(lastEnd)) / DAY : -1;
    if (owners.size && cfg.briefEndedDays > 0 && idle >= cfg.briefEndedDays && endedFor >= cfg.briefEndedDays)
      return { note, retire: true, reason: `owners ended ${Math.floor(endedFor)}d ago` };
    return keep(owners.size ? "owners ended recently" : "recent");
  });
}

// ───────────────────────────── the sweep ─────────────────────────────

export interface ColdTierStats { archiveSections: number; archiveChars: number; worklogEntries: number; worklogChars: number; briefs: number; briefChars: number }

function coldNote(ws: Workspace, slug: string, title: string, seed: string): Note {
  return noteStore.bySlug(ws.id, slug) ?? createNote({ workspace_id: ws.id, slug, title, body: seed });
}

const appendSection = (n: Note, section: string) => updateNote(n.id, { body: n.body.replace(/\n*$/, "\n\n") + section.trim() + "\n" });

export function sweepWorkspace(ws: Workspace, now = new Date(), cfg = CONFIG.coldTier): ColdTierStats {
  const st: ColdTierStats = { archiveSections: 0, archiveChars: 0, worklogEntries: 0, worklogChars: 0, briefs: 0, briefChars: 0 };

  const wl = noteStore.bySlug(ws.id, WORKLOG_SLUG);
  if (wl && !wl.pinned) {
    const r = rollWorklog(wl.body, now, cfg.worklogDays);
    if (r.entries) {
      const arc = coldNote(ws, WORKLOG_ARCHIVE_SLUG, "Worklog archive", WORKLOG_ARCHIVE_SEED);
      if (!arc.pinned) {
        appendSection(arc, `## worklog through ${r.to} · ${r.entries} entr${r.entries === 1 ? "y" : "ies"} since ${r.from}\n${r.rolled}`);
        updateNote(wl.id, { body: r.keep });
        st.worklogEntries = r.entries;
        st.worklogChars = wl.body.length - r.keep.length;
      }
    }
  }

  const retire = judgeBriefs(ws, now, cfg).filter((v) => v.retire);
  if (retire.length) {
    const arc = coldNote(ws, BRIEF_ARCHIVE_SLUG, "Brief archive", BRIEF_ARCHIVE_SEED);
    if (!arc.pinned) {
      for (const { note, reason } of retire) {
        const quoted = note.body.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
        appendSection(noteStore.get(arc.id)!, `## retired ${note.slug} · ${isoDay(now)} · ${reason}\n${quoted}`);
        deleteNote(note.id);
        st.briefs++;
        st.briefChars += note.body.length;
      }
    }
  }

  for (const n of noteStore.list(ws.id)) {
    if (n.pinned || n.context || !isColdNote(n.slug)) continue;
    const r = capColdNote(n.body, { now, days: cfg.archiveDays, maxChars: cfg.archiveMaxChars, fallbackDate: n.created_at.slice(0, 10) });
    if (!r.sections) continue;
    updateNote(n.id, { body: r.body });
    st.archiveSections += r.sections;
    st.archiveChars += r.chars;
  }
  return st;
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Every workspace, one line each when something moved. Errors stay per workspace. */
export function sweepColdTier(now = new Date()): Record<string, ColdTierStats> {
  const out: Record<string, ColdTierStats> = {};
  if (!CONFIG.coldTier.enabled) return out;
  for (const ws of workspaces.list()) {
    try {
      const s = sweepWorkspace(ws, now);
      out[ws.slug] = s;
      if (s.archiveSections || s.worklogEntries || s.briefs)
        console.log(`[cold-tier] ${ws.slug}: archives -${s.archiveSections} sections/-${k(s.archiveChars)} chars · worklog rolled ${s.worklogEntries} · briefs retired ${s.briefs}`);
    } catch (e: any) {
      console.warn(`[cold-tier] ${ws.slug}`, e?.message ?? e);
    }
  }
  return out;
}
