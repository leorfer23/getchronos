/**
 * The stow pass — one sweep that reinforces, decays, archives and budgets an agent's memory.
 *
 * Memory used to be append-only: every fact an agent ever learned was injected on every turn, and
 * the only way one left was an agent rewriting the whole file from judgment. So it grew into noise,
 * and nothing distinguished "still true" from "was true once". A pass fixes that with a clock
 * (src/memory-tiers.ts) and a ceiling (src/memory-budget.ts), and with one rule that makes the whole
 * thing trustworthy:
 *
 *   **Reinforcement requires evidence.** The pass NEVER refreshes a date on its own. A caller hands
 *   in the hashes of entries this session actually exercised — and the pass treats importance,
 *   plausibility and the entry's own confident wording as no evidence at all.
 *
 * And the second rule: stale is not deleted. Everything that leaves the memory file is appended to
 * `memory-archive-<agent>.md`, with provenance, in the same directory. That file is never injected
 * and never counted, so retiring a fact costs nothing and recovering one is a grep.
 *
 * Semantics copied from the open-source firstmate project's `stow` skill; the pass ordering below
 * (report → read → reinforce → clocks → budget → re-report) is that skill's.
 */
import path from "node:path";
import { CONFIG } from "./config.js";
import { workspaces, notes as store, lessons as lessonStore } from "./store.js";
import { createNote, appendNote, learningBullets } from "./notes.js";
import { MEM_WS_SLUG, agentMemoryNote, rewriteMemory } from "./agent-memory.js";
import { estimateTokens, report, type BudgetReport } from "./memory-budget.js";
import {
  daysBetween,
  defaultTierFor,
  entryHash,
  parseMemory,
  perishableLacksCondition,
  renderEntry,
  staleness,
  today,
  type Entry,
  type Tier,
} from "./memory-tiers.js";

export interface ArchivedEntry {
  hash: string;
  text: string;
  tier: Tier;
  reinforced: string | null;
  /** `unreinforced 39d` | `unreinforced 11p` | `budget oldest-first` | `legacy-unvalidated`. */
  reason: string;
  /** Basename of the file it left. */
  from: string;
}

export interface StowReceipt {
  ok: boolean;
  agent: string;
  date: string;
  before: BudgetReport;
  after: BudgetReport;
  /** Hashes whose entries were re-stamped — one per piece of evidence the caller supplied. */
  reinforced: string[];
  /** Unmarked legacy entries that spent their one grace pass this time: kept, not stamped. */
  graced: string[];
  /** Graced entries an unattended pass left standing: only evidence, not a clock, may retire them. */
  awaitingValidation: string[];
  archived: ArchivedEntry[];
  /** Perishables whose prose names nothing checkable — reported, never acted on. */
  perishablesLackingCondition: string[];
  /** What the pass may not touch, when that is what keeps the file over budget. */
  pinnedFloor: { tokens: number; entries: string[] };
  /** Non-null whenever the pass could not end within budget — never a silent overrun. */
  decision: string | null;
}

const ARCHIVE_SEED = (agent: string) =>
  `# Memory archive — ${agent}\n\n` +
  `Cold tier: entries retired from memory-${agent}.md by the stow pass. Append-only, never injected,\n` +
  `never counted against the memory budget. Recovery is grep plus copy back.\n`;

/** The cold tier, created on first archival. Lives beside the memory file, as an ordinary note. */
function archiveNote(agent: string) {
  const ws = workspaces.getBySlug(MEM_WS_SLUG);
  if (!ws) return null;
  const slug = `memory-archive-${agent}`;
  const existing = store.bySlug(ws.id, slug);
  if (existing) return existing;
  return createNote({ workspace_id: ws.id, title: `Memory archive — ${agent}`, body: ARCHIVE_SEED(agent) });
}

const provenance = (a: ArchivedEntry): string =>
  `- (from ${a.from}, tier: ${a.tier}, reinforced: ${a.reinforced ?? "never"}) ${a.text.trim()} [archived: ${a.reason}]`;

/** Append this pass's retirements under a dated heading, reusing today's heading if it is already there. */
function writeArchive(agent: string, archived: ArchivedEntry[], date: string): void {
  if (!archived.length) return;
  const note = archiveNote(agent);
  if (!note) return;
  const heading = `${date} stow`;
  const block = archived.map(provenance).join("\n");
  appendNote(note.id, block, note.body.includes(`## ${heading}`) ? undefined : heading);
}

export interface StowOptions {
  /** Entry hashes (or exact entry texts) this session exercised. Anything else is not reinforced. */
  reinforced?: Iterable<string>;
  now?: Date;
  /** Defaults to CONFIG.stowPassHorizon. */
  passHorizon?: boolean;
  /**
   * False for the unattended hygiene pass: a graced legacy entry with no evidence is kept and
   * reported instead of archived. Without this, the second Sunday after deploy would retire an
   * agent's entire pre-marker memory on the strength of nobody having quoted it back verbatim.
   */
  resolveGrace?: boolean;
}

/** Accept hashes and raw entry text interchangeably — Robert can name either. */
export function toHashes(items: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of items ?? []) {
    const s = raw.trim();
    if (!s) continue;
    if (/^[0-9a-f]{12}$/.test(s)) out.add(s);
    else out.add(entryHash(s));
  }
  return out;
}

export function runStowPass(agent: string, opts: StowOptions = {}): StowReceipt {
  const now = opts.now ?? new Date();
  const date = today(now);
  const passHorizon = opts.passHorizon ?? CONFIG.stowPassHorizon;
  const evidence = toHashes(opts.reinforced);
  const resolveGrace = opts.resolveGrace ?? true;

  // Step 1: report before considering a write.
  const before = report(agent);
  const note = agentMemoryNote(agent, false);
  const receipt: StowReceipt = {
    ok: true,
    agent,
    date,
    before,
    after: before,
    reinforced: [],
    graced: [],
    awaitingValidation: [],
    archived: [],
    perishablesLackingCondition: [],
    pinnedFloor: { tokens: 0, entries: [] },
    decision: null,
  };
  if (!note) return receipt; // nothing written yet: an absent file is absent, not an empty one to fill

  // Step 2: read the whole file. Only the agent's own memory is editable here — the operator's
  // global profile notes are counted by the budget and never touched by the pass.
  const from = path.basename(note.file_path);
  const parsed = parseMemory(note.body, defaultTierFor(note.file_path));
  const dropped = new Set<number>();
  const archived: ArchivedEntry[] = [];
  const archive = (e: Entry, reason: string) => {
    dropped.add(e.index);
    archived.push({ hash: e.hash, text: e.text, tier: e.tier, reinforced: e.reinforced, reason, from });
  };

  // Steps 4 and 5: reinforce on evidence, then read the clocks of everything that was not reinforced.
  for (const e of parsed.entries) {
    if (e.tier === "perishable" && perishableLacksCondition(e)) receipt.perishablesLackingCondition.push(e.hash);
    if (e.tier === "pinned") continue; // no clock is ever read for a pinned entry

    if (evidence.has(e.hash)) {
      e.reinforced = date;
      e.passes = 0;
      e.grace = false;
      parsed.lines[e.index] = renderEntry(e);
      receipt.reinforced.push(e.hash);
      continue;
    }

    // Legacy migration: a clock-tiered entry that never carried a marker cannot be judged stale —
    // there is no last-reinforced date to measure. It gets exactly one grace pass, and is never
    // both graced and resolved in the same invocation.
    if (!e.reinforced) {
      if (e.grace) {
        if (resolveGrace) archive(e, "legacy-unvalidated");
        else receipt.awaitingValidation.push(e.hash);
      } else {
        e.grace = true;
        parsed.lines[e.index] = renderEntry(e);
        receipt.graced.push(e.hash);
      }
      continue;
    }

    if (passHorizon) {
      e.passes += 1; // the pass tick: this pass evaluated the entry and did not reinforce it
      parsed.lines[e.index] = renderEntry(e);
    }
    const st = staleness(e, now, passHorizon);
    if (st.stale) archive(e, st.reason!);
  }

  const fixedTokens = before.files.filter((f) => !f.editable).reduce((n, f) => n + f.tokens, 0);
  const bodyWithout = (drop: Set<number>) =>
    parsed.lines.filter((_l, i) => !drop.has(i)).join("\n");
  const totalWithout = (drop: Set<number>) => estimateTokens(bodyWithout(drop)) + fixedTokens;

  const surviving = parsed.entries.filter((e) => !dropped.has(e.index));
  const pinned = surviving.filter((e) => e.tier === "pinned");
  receipt.pinnedFloor = {
    tokens: pinned.reduce((n, e) => n + estimateTokens(renderEntry(e)), 0) + fixedTokens,
    entries: pinned.map((e) => e.text.trim()),
  };

  // Step 7: still over budget after decay. Eviction considers only dated aging entries — a graced
  // legacy entry is ineligible, so budget pressure can never cancel a promised grace cycle, and
  // pinned entries are never moved by an automatic process at all.
  if (totalWithout(dropped) > before.budget) {
    const pool = surviving
      .filter((e) => e.tier === "aging" && e.reinforced && !e.grace)
      .sort((a, b) =>
        a.reinforced === b.reinforced ? a.index - b.index : daysBetween(b.reinforced!, now) - daysBetween(a.reinforced!, now),
      );
    // Convergence precondition: evicting the WHOLE eligible pool has to reach the budget. When even
    // that would not, evicting part of it destroys knowledge and still ends over budget — so the pass
    // archives nothing for budget reasons and hands the operator the pinned floor instead.
    const wholePool = new Set(dropped);
    for (const e of pool) wholePool.add(e.index);
    if (totalWithout(wholePool) <= before.budget) {
      for (const e of pool) {
        if (totalWithout(dropped) <= before.budget) break;
        archive(e, "budget oldest-first");
      }
    }
  }

  // Step 3/6 (consolidation and merging near-duplicates) is judgment, not mechanism: the pass never
  // rewrites an entry's prose. It reports, and the agent consolidates through PUT .../memory.
  const nextBody = bodyWithout(dropped);
  if (nextBody !== note.body) rewriteMemory(agent, nextBody);
  writeArchive(agent, archived, date);

  // Step 8: re-report, and never end over budget silently.
  receipt.archived = archived;
  receipt.after = report(agent);
  receipt.ok = receipt.after.over === 0;
  if (!receipt.ok) {
    receipt.decision = `over budget by ${receipt.after.over} tokens (${receipt.after.total}/${receipt.after.budget}) after ${archived.length} archived: raise the budget or approve trimming the pinned floor (${receipt.pinnedFloor.tokens} tokens${receipt.pinnedFloor.entries.length ? `, pinned: ${receipt.pinnedFloor.entries.join(" | ")}` : ""})`;
  }
  return receipt;
}

// ───────────────────────────── evidence ─────────────────────────────

const LEARN_SLUG = "session-learnings";
const HEADING_DATE_RE = /^#{1,6}\s+(\d{4}-\d{2}-\d{2})/;

/**
 * Evidence the daemon can name by itself, for the unattended (hygiene) pass: entries whose prose was
 * written down somewhere else in the last `days` — a lesson filed or fired, or a bullet captured into
 * a workspace's session-learnings memo under a dated heading.
 *
 * Deliberately exact-hash, not fuzzy: a near-match is a resemblance, and a resemblance is not
 * evidence. And deliberately NOT the activity trail — `note.updated` rows (src/activity.ts) carry the
 * note id and nothing about which entry changed, so the trail proves a memory file was written and
 * cannot say which fact it confirmed. No signal → an empty set → nothing is reinforced, which is the
 * correct outcome rather than a convenient one.
 */
export function recentReinforcement(now = new Date(), days = 7): Set<string> {
  const fresh = (ts: string | null | undefined) =>
    !!ts && (now.getTime() - Date.parse(ts)) / 86_400_000 <= days;
  const texts: string[] = [];

  for (const l of lessonStore.list({})) {
    if (fresh(l.created_at) || fresh(l.last_fired)) texts.push(l.rule);
  }

  for (const n of store.list()) {
    if (n.slug !== LEARN_SLUG) continue;
    let recent = false;
    for (const line of n.body.split("\n")) {
      const h = line.match(HEADING_DATE_RE);
      if (h) {
        recent = daysBetween(h[1], now) <= days;
        continue;
      }
      if (recent && /^\s*[-*]\s+/.test(line)) texts.push(...learningBullets(line));
    }
  }

  return toHashes(texts);
}
