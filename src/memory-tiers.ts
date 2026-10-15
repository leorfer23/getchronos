/**
 * Memory tiers — the marker language that lets an agent's memory decay instead of only growing.
 *
 * Persona memory (src/agent-memory.ts) is injected on every single turn, and until now nothing in it
 * ever expired: a fact learned once was paid for forever, and the only way to remove one was for an
 * agent to rewrite the whole file from judgment. This module gives each bullet a tier and a clock,
 * written as a trailing HTML comment so the marker is invisible to a reader and cheap in tokens
 * (marker bytes are counted content — that is why the spellings are this short):
 *
 *   - Treehouse pool slots share one repo, so branch before editing. <!--a:2026-08-03-->
 *   - While the sync is broken the daemon owns triage (tracked: MC-91). <!--p:2026-09-01-->
 *   - Never restart the daemon while runs are active. <!--P-->
 *
 * `a:` aging (re-prove itself or retire), `p:` perishable (stored expecting disposal, its prose must
 * name a checkable expiry condition), `P` pinned (no clock is ever read for it), `g` grace (a legacy
 * entry that has spent its one free pass). `/N` counts passes that evaluated an entry without
 * reinforcing it, and only exists in a daemon that opted into CONFIG.stowPassHorizon.
 *
 * Semantics are copied from the open-source firstmate project's `stow` skill. Pure module: no I/O,
 * no store, no clock of its own — src/stow.ts owns the pass, this owns the language.
 */
import { createHash } from "node:crypto";

export type Tier = "aging" | "perishable" | "pinned";

/** Wall-clock horizons: days since last-reinforced at which an entry of this tier is stale. */
export const STALE_DAYS: Record<Exclude<Tier, "pinned">, number> = { aging: 30, perishable: 7 };
/** Pass horizons, read only when CONFIG.stowPassHorizon is on: unreinforced passes before stale. */
export const STALE_PASSES: Record<Exclude<Tier, "pinned">, number> = { aging: 10, perishable: 3 };

export interface Entry {
  /** Index into the parsed file's `lines`, so a mutation rewrites exactly one line. */
  index: number;
  raw: string;
  /** The bullet prefix as found (indent + `- `), preserved so a rewrite is byte-faithful. */
  prefix: string;
  /** The prose, marker stripped. */
  text: string;
  /** Whitespace between prose and marker, preserved for the same reason. */
  gap: string;
  hash: string;
  tier: Tier;
  /** True when the line carried an explicit tier marker (not the file/section default). */
  marked: boolean;
  reinforced: string | null;
  passes: number;
  grace: boolean;
}

export interface ParsedMemory {
  lines: string[];
  entries: Entry[];
}

const DATED_RE = /(\s*)<!--(a|p):(\d{4}-\d{2}-\d{2})(?:\/(\d+))?-->\s*$/;
const PINNED_RE = /(\s*)<!--P-->\s*$/;
const GRACE_RE = /(\s*)<!--g-->\s*$/;
const BULLET_RE = /^(\s*[-*]\s+)(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;

/**
 * The tier an unmarked entry in this file carries. A persona memory file and a lessons file hold
 * operational facts that must re-prove themselves; anything else (the operator's own profile notes)
 * is preference and authority, which does not age.
 */
export function defaultTierFor(file: string): Tier {
  const base = (file.split("/").pop() ?? file).toLowerCase();
  if (base.startsWith("memory-") || base.includes("lesson")) return "aging";
  return "pinned";
}

/** A `## Pinned` heading (or any heading whose text starts with "pinned") pins its section. */
export function sectionPins(headingText: string): boolean {
  return /^pinned\b/i.test(headingText.trim());
}

/** Stable identity of an entry: its prose, whitespace- and case-normalized. */
export function entryHash(text: string): string {
  const norm = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

export interface Marker {
  /** null when the marker declares no tier (grace carries no tier and no date). */
  tier: Tier | null;
  date: string | null;
  passes: number;
  grace: boolean;
  gap: string;
  /** The prose with the marker removed. */
  text: string;
}

/** Parse the trailing marker off one line's prose. Returns null when there is none. */
export function parseMarker(prose: string): Marker | null {
  const dated = prose.match(DATED_RE);
  if (dated) {
    return {
      tier: dated[2] === "a" ? "aging" : "perishable",
      date: dated[3],
      passes: dated[4] ? Number(dated[4]) : 0,
      grace: false,
      gap: dated[1],
      text: prose.slice(0, dated.index),
    };
  }
  const pinned = prose.match(PINNED_RE);
  if (pinned) {
    return { tier: "pinned", date: null, passes: 0, grace: false, gap: pinned[1], text: prose.slice(0, pinned.index) };
  }
  const grace = prose.match(GRACE_RE);
  if (grace) {
    return { tier: null, date: null, passes: 0, grace: true, gap: grace[1], text: prose.slice(0, grace.index) };
  }
  return null;
}

/** The marker an entry's current state serializes to, or "" for an unmarked default-tier entry. */
export function serializeMarker(e: Pick<Entry, "tier" | "reinforced" | "passes" | "grace">): string {
  if (e.grace) return "<!--g-->";
  if (e.tier === "pinned") return "<!--P-->";
  if (!e.reinforced) return "";
  const letter = e.tier === "aging" ? "a" : "p";
  return `<!--${letter}:${e.reinforced}${e.passes > 0 ? `/${e.passes}` : ""}-->`;
}

/** One entry back to its line. `renderEntry(parsed.entries[i]) === parsed.entries[i].raw` untouched. */
export function renderEntry(e: Entry): string {
  const marker = serializeMarker(e);
  return marker ? `${e.prefix}${e.text}${e.gap || " "}${marker}` : `${e.prefix}${e.text}`;
}

/**
 * Split a memory file into its lines and the bullet entries among them. Only bullets are entries:
 * headings, prose paragraphs and the file's own header pointer are structure and are left alone.
 */
export function parseMemory(body: string, fileDefault: Tier = "aging"): ParsedMemory {
  const lines = body.split("\n");
  const entries: Entry[] = [];
  let sectionDefault = fileDefault;
  lines.forEach((raw, index) => {
    const h = raw.match(HEADING_RE);
    if (h) {
      sectionDefault = sectionPins(h[1]) ? "pinned" : fileDefault;
      return;
    }
    const b = raw.match(BULLET_RE);
    if (!b) return;
    const [, prefix, prose] = b;
    const m = parseMarker(prose);
    const text = m ? m.text : prose;
    entries.push({
      index,
      raw,
      prefix,
      text,
      gap: m?.gap ?? " ",
      hash: entryHash(text),
      tier: m?.tier ?? sectionDefault,
      marked: !!m && m.tier !== null,
      reinforced: m?.date ?? null,
      passes: m?.passes ?? 0,
      grace: m?.grace ?? false,
    });
  });
  return { lines, entries };
}

export function serializeMemory(parsed: ParsedMemory): string {
  return parsed.lines.join("\n");
}

/** Whole days between two YYYY-MM-DD instants, date-only so a time of day never shifts a boundary. */
export function daysBetween(from: string, now: Date): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

export const today = (now: Date): string => now.toISOString().slice(0, 10);

export interface Staleness {
  stale: boolean;
  /** Archive reason, in the cold tier's spelling: `unreinforced 39d` / `unreinforced 11p`. */
  reason: string | null;
}

/**
 * Has this entry's clock run out? Pinned entries have no clock and an undated entry has nothing to
 * measure — both come back not stale (an undated legacy entry is the grace path in src/stow.ts, not
 * a decay one). The wall clock is checked before the pass counter so the counter only ever appears
 * in a reason when the pass horizon itself is what expired the entry.
 */
export function staleness(e: Entry, now: Date, passHorizon = false): Staleness {
  if (e.tier === "pinned" || e.grace || !e.reinforced) return { stale: false, reason: null };
  const days = daysBetween(e.reinforced, now);
  if (days >= STALE_DAYS[e.tier]) return { stale: true, reason: `unreinforced ${days}d` };
  if (passHorizon && e.passes >= STALE_PASSES[e.tier])
    return { stale: true, reason: `unreinforced ${e.passes}p` };
  return { stale: false, reason: null };
}

/**
 * A perishable entry whose prose names no checkable expiry condition — a date, a version floor or a
 * backlog id. We cannot verify what prose MEANS, so the pass reports these rather than acting on
 * them: an entry nobody can check against anything is an `aging` entry that was filed in the wrong
 * tier, and only the agent that wrote it can say which.
 */
export function perishableLacksCondition(e: Entry): boolean {
  if (e.tier !== "perishable") return false;
  return !/\d{4}-\d{2}-\d{2}|\bv?\d+\.\d+|\b[A-Z]{2,5}-\d+\b/.test(e.text);
}
