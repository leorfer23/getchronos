/**
 * "Later" is an answer — the pure half.
 *
 * An item the operator owes a decision on (an ask, a pending review, a stalled-work call) used to
 * have two states on his list: live, or gone. "Not now" had nowhere to go, so it either stayed
 * live-looking and kept pinging, or somebody closed it with an invented answer. A dated hold is the
 * third state: the item leaves the live list and comes BACK on its date.
 *
 * Everything here is a pure function over structured fields. Never classify from hold-reason prose:
 * the bucket is `hold_until` and `created_at`, nothing else.
 *
 * Buckets, in order:
 *   dated — `hold_until` is in the future. The durable mechanism; the date is what brings it back.
 *   aged  — UNDATED (no hold_until at all) and older than the threshold. A presentation safety net
 *           only, so an item nobody dated can't rot in silence. Never a substitute for a date.
 *   live  — everything else, including a hold whose date has passed but whose sweep hasn't run yet:
 *           its moment has come, so it belongs on the list.
 *
 * No `blocked` bucket: asks, reviews and recovery stalls carry no blocker field in this schema. If
 * one is ever added, it goes FIRST (ahead of `dated`), the way firstmate's bearings orders them.
 */
import { CONFIG } from "./config.js";

export type HoldBucket = "live" | "dated" | "aged";
/** `all` is a query option, never a bucket a row can be in. */
export type BucketFilter = HoldBucket | "all";

/** The only fields a bucket is computed from. Asks, reviews and stalls all satisfy it. */
export interface Holdable {
  hold_until?: string | null;
  created_at: string;
}

const parse = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function holdBucket(
  item: Holdable,
  now: number = Date.now(),
  agedAfterMs: number = CONFIG.holdAgedHours * 3_600_000,
): HoldBucket {
  const until = parse(item.hold_until);
  // Strictly in the future: at the instant the hold expires it is live again, not dated.
  if (until !== null && until > now) return "dated";
  if (until !== null) return "live"; // dated, and the date has arrived — back on the list
  if (!agedAfterMs) return "live"; // 0 = aging off; only dates hold anything back
  const born = parse(item.created_at);
  return born !== null && now - born >= agedAfterMs ? "aged" : "live";
}

/** `?bucket=` → filter. Anything unrecognised (including absent) means the live "needs you" list. */
export function parseBucketFilter(v: unknown): BucketFilter {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "dated" || s === "aged" || s === "all" ? s : "live";
}

export function filterByBucket<T extends Holdable>(
  rows: T[],
  bucket: BucketFilter,
  now: number = Date.now(),
  agedAfterMs: number = CONFIG.holdAgedHours * 3_600_000,
): (T & { bucket: HoldBucket })[] {
  return rows
    .map((r) => ({ ...r, bucket: holdBucket(r, now, agedAfterMs) }))
    .filter((r) => bucket === "all" || r.bucket === bucket);
}

/**
 * "tomorrow 9:00" as an ISO instant, in the daemon's local timezone — the one Later choice that is a
 * wall-clock time rather than an offset. Always strictly tomorrow, even when tapped at 08:00.
 */
export function tomorrowAt(nowMs: number, hour = 9): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ── divergence ───────────────────────────────────────────────────────────────

/**
 * One decision can be written down twice, and the two records can disagree: a ticket marked done
 * while its question is still open, a PR merged while its review still says pending. This reports
 * that contradiction and CLOSES NOTHING — a call closed wrongly leaves review entirely, which is
 * worse than the noise. Read a line as "these two records disagree", never as "someone forgot to
 * file the answer": the premise may simply have dissolved.
 */
export interface DivergenceAsk {
  id: string;
  question: string;
  workspace_id: string | null;
  ticket_key: string | null;
  /** True when the ticket this ask belongs to is in a closed status. */
  ticket_closed: boolean;
  /** The asking run's terminal status, or null when it is still going / there is no run. */
  run_done_status: string | null;
  /** Read-only runs (plan:/review:/…) ask advisory questions and end on purpose — never a divergence. */
  run_read_only: boolean;
}

export interface DivergenceReview {
  id: string;
  workspace_id: string | null;
  ticket_key: string | null;
  /** The ticket's PR delivery state: only 'merged' / 'closed' contradict a pending review. */
  pr_state: string | null;
}

export interface DivergenceInput {
  /** Open asks only. */
  asks: DivergenceAsk[];
  /** Pending reviews only. */
  reviews: DivergenceReview[];
}

export interface Divergence {
  kind: "ask" | "review";
  id: string;
  id8: string;
  workspace_id: string | null;
  ticket_key: string | null;
  /** One operator-facing line naming BOTH records and how they disagree. */
  line: string;
}

export function holdDivergence(input: DivergenceInput): Divergence[] {
  const out: Divergence[] = [];
  for (const a of input.asks) {
    const ref = a.ticket_key ?? "(no ticket)";
    // A read-only run's question is fire-and-forget by design (see isReadOnlyRun) — its run ending
    // is the expected shape, not a contradiction.
    const runDone = !a.run_read_only && a.run_done_status === "success";
    if (!a.ticket_closed && !runDone) continue;
    const what = a.ticket_closed ? `${ref} is closed` : `its build run finished ${a.run_done_status}`;
    out.push({
      kind: "ask",
      id: a.id,
      id8: a.id.slice(0, 8),
      workspace_id: a.workspace_id,
      ticket_key: a.ticket_key,
      line: `ask ${a.id.slice(0, 8)} is still open but ${what} — “${a.question.replace(/\s+/g, " ").slice(0, 90)}”`,
    });
  }
  for (const r of input.reviews) {
    if (r.pr_state !== "merged" && r.pr_state !== "closed") continue;
    out.push({
      kind: "review",
      id: r.id,
      id8: r.id.slice(0, 8),
      workspace_id: r.workspace_id,
      ticket_key: r.ticket_key,
      line: `review ${r.id.slice(0, 8)} is still pending but ${r.ticket_key ?? "its"} PR is ${r.pr_state}`,
    });
  }
  return out;
}
