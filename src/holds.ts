/**
 * "Later" is an answer — the wiring half (src/hold-bucket.ts is the pure half).
 *
 * Three things can sit on the operator's "needs you" list: an open ask, a pending review, a stalled
 * -work call. Holding one dates it OFF that list and brings it back on its date. What a hold is NOT:
 *
 *  - it is not a close. A held item is never resolved because the surrounding work finished; only a
 *    recorded answer (verbatim operator words — asks already keep `answer` + `answered_by`) or an
 *    explicit decision resolves it.
 *  - it is not a guess. The point of the button is that "not now" has somewhere to go, so nobody
 *    invents an answer to clear a card.
 *
 * Resurfacing re-sends the ORIGINAL card with a "⏰ back from later" lead line, exactly once per
 * hold (the store's resurface UPDATE is guarded on `hold_until IS NOT NULL`). An undated hold has no
 * date to come back on, so it only ever gets a gentle once-a-day nudge line — aging is a
 * presentation safety net, never the mechanism.
 */
import { CONFIG } from "./config.js";
import { asks, jobs, kv, reviews, runs, tickets } from "./store.js";
import { isClosedTicketStatus, type Review } from "./types.js";
import type { Ask } from "./store/asks.js";
import { parseUntil } from "./watches.js";
import { isReadOnlyRun } from "./runner.js";
import { holdBucket, holdDivergence, type Divergence } from "./hold-bucket.js";
import { askCard } from "./asks.js";
import { holdStall, listStalls, resurfaceStall, stallCard, stallHold } from "./recovery.js";
import { notify, esc } from "./telegram/api.js";
import { kb, reviewKb } from "./telegram/keyboards.js";

export type HoldKind = "ask" | "review" | "recovery";

export interface HoldTarget {
  kind: HoldKind;
  id: string;
  /** The workspace that owns it — what an endpoint runs `checkScope` against (CLAUDE.md gotcha 4). */
  workspace_id: string | null;
  /** False when the item is already answered/decided: there is nothing left to defer. */
  holdable: boolean;
  label: string;
}

const reviewWorkspace = (r: { ticket_id: string | null }): string | null =>
  (r.ticket_id ? tickets.get(r.ticket_id)?.workspace_id : null) ?? null;

/**
 * Resolve `<kind>/<id-or-prefix>` to the row AND the workspace that owns it. Split out from the
 * hold itself so the API can scope-check before mutating anything — a hold on another workspace's
 * ask is the same boundary violation as answering it.
 */
export function resolveHoldTarget(kind: HoldKind, idOrRef: string): HoldTarget | undefined {
  if (kind === "ask") {
    const a = asks.get(idOrRef) ?? asks.findByIdPrefix(idOrRef);
    if (!a) return undefined;
    return { kind, id: a.id, workspace_id: a.workspace_id, holdable: a.status === "open", label: a.question.slice(0, 80) };
  }
  if (kind === "review") {
    const r = reviews.get(idOrRef) ?? reviews.list().find((x) => x.id.startsWith(idOrRef));
    if (!r) return undefined;
    const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
    return { kind, id: r.id, workspace_id: reviewWorkspace(r), holdable: r.state === "pending", label: t?.key ?? r.id.slice(0, 8) };
  }
  const s = listStalls().find((x) => x.id.toLowerCase() === idOrRef.trim().toLowerCase() || x.id.slice(2).toLowerCase() === idOrRef.trim().toLowerCase());
  if (!s) return undefined;
  return { kind, id: s.id, workspace_id: s.workspace_id, holdable: true, label: s.action };
}

export interface HoldResult {
  ok: true;
  kind: HoldKind;
  id: string;
  hold_until: string | null;
  hold_reason: string | null;
  label: string;
}

/**
 * Apply (or lift, with `until: null`) a hold. `until` accepts the same grammar watches do —
 * `+20m` / `+48h` / `+2d` / an ISO date — so an operator never has to type a timestamp.
 */
export function applyHold(
  target: HoldTarget,
  until: unknown,
  reason: string | null,
  nowMs = Date.now(),
): HoldResult | { ok: false; error: string; status: number } {
  if (!target.holdable) return { ok: false, error: `${target.kind} is already decided`, status: 409 };
  let iso: string | null = null;
  if (until !== null && until !== undefined && String(until).trim() !== "") {
    iso = parseUntil(until, nowMs);
    if (!iso) return { ok: false, error: "until must be an ISO date or a relative offset like +2h / +48h / +2d", status: 400 };
    if (Date.parse(iso) <= nowMs) return { ok: false, error: "until must be in the future", status: 400 };
  }
  const clean = reason?.trim() ? reason.trim().slice(0, 400) : null;
  if (target.kind === "ask") asks.hold(target.id, iso, clean);
  else if (target.kind === "review") reviews.hold(target.id, iso, clean);
  else holdStall(target.id, iso, clean);
  return { ok: true, kind: target.kind, id: target.id, hold_until: iso, hold_reason: iso ? clean : null, label: target.label };
}

// ── resurface + nudge sweep ──────────────────────────────────────────────────

const NUDGED_PREFIX = "hold.nudged.";
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function reviewCard(r: Review, lead: string): { text: string; keyboard: ReturnType<typeof kb> } {
  const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
  return {
    text: `${esc(lead)}\n🟡 <b>Review waiting</b>${t ? " — " + esc(t.key + " " + t.title) : ""}`,
    keyboard: reviewKb(r),
  };
}

const BACK = "⏰ back from later";

/**
 * Bring every hold whose date has passed back onto the list, once, as the card it came from. Returns
 * how many it resurfaced — the monitor logs it, the tests assert on it.
 */
export async function resurfaceDueHolds(nowMs = Date.now()): Promise<number> {
  const nowIso = new Date(nowMs).toISOString();
  let n = 0;

  for (const a of asks.holdsDue(nowIso)) {
    const back = asks.resurface(a.id, nowIso);
    if (!back) continue; // someone else already cleared it — never two cards for one hold
    n++;
    const job = back.job_id ? jobs.get(back.job_id) : undefined;
    const card = askCard(back, job, `${BACK}${back.hold_reason ? ` — ${back.hold_reason}` : ""}`);
    await notify(card.text, card.keyboard, { board: false }).catch((e) => console.error("[holds] ask resurface notify", e));
  }

  for (const r of reviews.holdsDue(nowIso)) {
    const back = reviews.resurface(r.id, nowIso);
    if (!back) continue;
    n++;
    const card = reviewCard(back, `${BACK}${r.hold_reason ? ` — ${r.hold_reason}` : ""}`);
    await notify(card.text, card.keyboard, { board: false }).catch((e) => console.error("[holds] review resurface notify", e));
  }

  for (const s of listStalls()) {
    const hold = stallHold(s.id);
    if (!hold.until || Date.parse(hold.until) > nowMs) continue;
    if (!resurfaceStall(s.id, nowIso)) continue;
    n++;
    const card = stallCard(s, `${BACK}${hold.reason ? ` — ${hold.reason}` : ""}`);
    await notify(card.text, card.keyboard, { board: false }).catch((e) => console.error("[holds] stall resurface notify", e));
  }

  return n;
}

/** Every item currently in the `aged` bucket, as one line each. Pure read. */
export function agedItems(nowMs = Date.now()): { key: string; line: string }[] {
  const out: { key: string; line: string }[] = [];
  for (const a of asks.list({ status: "open" })) {
    if (holdBucket(a, nowMs) !== "aged") continue;
    out.push({ key: `ask:${a.id}`, line: `❓ ${a.id.slice(0, 8)} — ${a.question.replace(/\s+/g, " ").slice(0, 80)}` });
  }
  for (const r of reviews.list("pending")) {
    if (holdBucket(r, nowMs) !== "aged") continue;
    const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
    out.push({ key: `review:${r.id}`, line: `🟡 ${r.id.slice(0, 8)} — ${t?.key ?? "review"} ${t?.title?.slice(0, 60) ?? ""}`.trim() });
  }
  for (const s of listStalls()) {
    if (holdBucket(s, nowMs) !== "aged") continue;
    out.push({ key: `recovery:${s.id}`, line: `🩺 ${s.line.split("\n")[0]}` });
  }
  return out;
}

/**
 * An undated item has no date to come back on, so it gets a nudge instead of a card — once per day
 * per item, batched into one message. Deliberately gentle and deliberately not actionable buttons:
 * the fix for an aged item is to give it a date (or an answer), not to re-ask the same question.
 */
export async function nudgeAgedHolds(nowMs = Date.now()): Promise<number> {
  const today = dayOf(nowMs);
  const due = agedItems(nowMs).filter((i) => kv.get(NUDGED_PREFIX + i.key) !== today);
  if (!due.length) return 0;
  for (const i of due) kv.set(NUDGED_PREFIX + i.key, today); // before the send: a failed notify must not re-nudge all day
  const hrs = CONFIG.holdAgedHours;
  await notify(
    `🕰 <b>${due.length} decision(s) older than ${hrs}h with no date</b> — give one a date with ` +
      `<code>mc ask hold &lt;id8&gt; +2d "why"</code>, or answer it:\n` +
      due.slice(0, 10).map((i) => esc(i.line)).join("\n") +
      (due.length > 10 ? `\n+${due.length - 10} more` : ""),
    undefined,
    { board: false },
  ).catch((e) => console.error("[holds] aged nudge notify", e));
  return due.length;
}

/** Both halves of the sweep, in the order the monitor wants them. */
export async function sweepHolds(nowMs = Date.now()): Promise<{ resurfaced: number; nudged: number }> {
  const resurfaced = await resurfaceDueHolds(nowMs);
  const nudged = await nudgeAgedHolds(nowMs);
  if (resurfaced) console.log(`[holds] ${resurfaced} item(s) back from later`);
  return { resurfaced, nudged };
}

// ── divergence ───────────────────────────────────────────────────────────────

/** Gather the structured facts holdDivergence judges. Read-only; it closes nothing, ever. */
export function divergenceInput(workspace_id?: string | null) {
  const wsOk = (id: string | null | undefined) => !workspace_id || id === workspace_id;
  const openAsks = asks.list({ status: "open" }).filter((a) => wsOk(a.workspace_id));
  const pending = reviews.list("pending");
  return {
    asks: openAsks.map((a: Ask) => {
      const t = a.ticket_id ? tickets.get(a.ticket_id) : undefined;
      const run = a.run_id ? runs.get(a.run_id) : undefined;
      const job = run ? jobs.get(run.job_id) : undefined;
      const ended = run && run.status !== "running" && run.status !== "queued" && run.status !== "paused";
      return {
        id: a.id,
        question: a.question,
        workspace_id: a.workspace_id,
        ticket_key: t?.key ?? null,
        ticket_closed: !!t && isClosedTicketStatus(t.status),
        run_done_status: ended ? run!.status : null,
        run_read_only: !!job && isReadOnlyRun(job.name),
      };
    }),
    reviews: pending
      .map((r) => {
        const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
        return { id: r.id, workspace_id: t?.workspace_id ?? null, ticket_key: t?.key ?? null, pr_state: t?.pr_state ?? null };
      })
      .filter((r) => wsOk(r.workspace_id)),
  };
}

/** The divergence report for one workspace (or the whole fleet). Reports; never resolves. */
export function divergences(workspace_id?: string | null): Divergence[] {
  return holdDivergence(divergenceInput(workspace_id));
}

/** One operator-facing line for the Desk digest / fleet board. Empty string when nothing disagrees. */
export function divergenceLine(rows: Divergence[]): string {
  if (!rows.length) return "";
  return (
    `⚠ divergence: ${rows.length} record(s) disagree (nothing was closed) — ` +
    rows.slice(0, 3).map((d) => d.line).join(" · ") +
    (rows.length > 3 ? ` · +${rows.length - 3} more` : "")
  );
}
