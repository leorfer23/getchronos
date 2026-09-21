/**
 * Robert's wake queue — every wake is a durable row before it is a turn.
 *
 * Before this, robert-wake.ts held its debounce in a Map and fired `askManagerWeb` fire-and-forget:
 * a daemon restart, or a turn that threw, lost the wake with nothing left on disk to say it ever
 * happened. The shape is borrowed from the open-source firstmate project (docs/architecture.md
 * "Event-driven supervision", docs/turnend-guard.md): write the actionable wake to a durable queue
 * FIRST, drain everything unacked in generation order into ONE presentation, ack only after the
 * handling side effect landed, and keep a beacon the supervision predicate can read to prove the
 * drain loop is alive. None of its bash is copied — this is the same contract on our runtime.
 *
 * Four properties are the point:
 *  - **Written, then handled.** enqueue() returns after the row is committed, never before.
 *  - **Queued-key dedup.** An unacked row with the same key absorbs a repeat (hits+1), so a chatty
 *    event source costs one turn, not twenty.
 *  - **Drain-before-act.** One turn presents every unacked wake for that workspace together.
 *  - **Ack-through on success only.** A throw leaves the rows queued with `last_error` and one more
 *    attempt; past the cap a row is PARKED and surfaced, never silently dropped.
 */
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { kv, robertWakes, tickets, type RobertWake } from "./store.js";
import { postRobertToDesk } from "./robert-desk.js";
import type { RobertStep } from "./robert-steps.js";
import { postToBoard, BOARD_WAKE_MAX_DEPTH } from "./board.js";
import { notify } from "./telegram/api.js";
import { askManagerWeb } from "./telegram/agent.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { robertModelFor, wakePromptFor, wakesRobert, type RobertWakeEvent } from "./robert-wake.js";

/** One Robert turn per subject per window — unchanged from the Map it replaces, table-backed now. */
export const WAKE_DEBOUNCE_MS = 15 * 60_000;
/**
 * Key prefix of a waiting-terminal prompt (src/terminal-prompts.ts). Exempt from the per-subject
 * window below: a SECOND question on the same terminal is new news, and the terminal is blocked on
 * it. Swallowing it for 15 minutes is the exact failure this feature exists to remove — the key
 * already carries the prompt's hash, so a repeat of the SAME question is still absorbed by dedupe.
 */
export const TERMINAL_PROMPT_KEY = "terminal-prompt:";
/** Key prefix of a stopped-terminal wake (src/robert-drive.ts). Same exemption, same reason: one wake per stop is in the key. */
export const TERMINAL_DRIVE_KEY = "term-drive:";
/** How often the drain loop looks for queued wakes. Also sets the beacon cadence. */
export const WAKE_DRAIN_MS = 30_000;
/** Failed turns before a row is parked for a human instead of retried forever. */
export const WAKE_ATTEMPT_CAP = Math.max(1, Number(process.env.CHRONOS_ROBERT_WAKE_ATTEMPTS ?? 5));
export const WAKE_BEACON_KEY = "robert.wake.beat";

/**
 * Beacon grace, firstmate's formula: max(300s, poll + 60s). A flat 300s stops bounding staleness
 * once the poll approaches it — a perfectly healthy loop mid-wait would read stale at the edge of
 * every cycle.
 */
export function wakeBeaconGraceMs(): number {
  return Math.max(300_000, WAKE_DRAIN_MS + 60_000);
}

type WakeAsker = (prompt: string, wsId: string | null, model: string) => Promise<string | { reply: string; steps?: RobertStep[]; turn?: string }>;
type WakePoster = (p: { body: string; ticket_id: string | null; workspace_id: string | null; steps?: RobertStep[]; turn?: string }) => void;
type WakeNotifier = (text: string) => Promise<unknown>;

let asker: WakeAsker = async (prompt, wsId, model) => {
  const out = await askManagerWeb(prompt, undefined, wsId, { model, label: "woken" });
  return { reply: out.reply, steps: out.steps, turn: out.turn };
};
let poster: WakePoster = (p) => {
  // Depth pinned to the cap: an automatic triage post must never chain-wake anyone.
  void postToBoard({ author: "robert", body: p.body, ticket_id: p.ticket_id, workspace_id: p.workspace_id, depth: BOARD_WAKE_MAX_DEPTH });
  // The Desk never renders the board. What Robert did on his own has to land in the one thread the
  // operator reads, or a woken Robert looks exactly like a sleeping one.
  postRobertToDesk({ body: p.body, ws: p.workspace_id, steps: p.steps, turn: p.turn });
};
let notifier: WakeNotifier = (text) => notify(text);

export function setWakeAsker(fn: WakeAsker): void { asker = fn; }
export function setWakePoster(fn: WakePoster): void { poster = fn; }
export function setWakeNotifier(fn: WakeNotifier): void { notifier = fn; }

export const scopeOf = (wsId: string | null | undefined): string => wsId ?? "default";
const wsOfScope = (scope: string): string | null => (scope === "default" ? null : scope);

export function touchWakeBeacon(nowMs = Date.now()): void {
  kv.set(WAKE_BEACON_KEY, String(nowMs));
}

export function wakeBeaconAgeMs(nowMs = Date.now()): number | null {
  const raw = Number(kv.get(WAKE_BEACON_KEY) ?? NaN);
  return Number.isFinite(raw) ? nowMs - raw : null;
}

export function wakeBeaconFresh(nowMs = Date.now()): boolean {
  const age = wakeBeaconAgeMs(nowMs);
  return age !== null && age <= wakeBeaconGraceMs();
}

/** Pure: has this subject's window closed? Source of truth is the row it last handled. */
export function wakeDue(lastHandledAt: string | null | undefined, nowMs: number): boolean {
  if (!lastHandledAt) return true;
  const t = Date.parse(lastHandledAt);
  return Number.isNaN(t) || nowMs - t >= WAKE_DEBOUNCE_MS;
}

/** The dedupe key for a bus wake. `ask:` / `review:` / `ticket-blocked:` + the thing's own id. */
export function wakeKeyFor(e: RobertWakeEvent): string {
  if (e.topic === "ask.created") return `ask:${e.ask_id}`;
  if (e.topic === "review.created") return `review:${e.review_id}`;
  return `ticket-blocked:${e.ticket_id}`;
}

export interface EnqueueWake {
  topic: string;
  key: string;
  /** What it is about — the debounce window is per subject. A ticket id for every bus wake today. */
  subject?: string | null;
  workspace_id?: string | null;
  payload?: unknown;
}

/**
 * Queue a wake and let the drain pick it up. Returns the row id (or the absorbing row's) so a caller
 * can say what it queued; the drain is kicked on the next tick, never inline, so a slow turn can
 * never hold up the publisher that caused it.
 */
export function enqueueWake(w: EnqueueWake): string {
  const { row, deduped } = robertWakes.enqueue(w);
  if (!deduped) kickDrain(scopeOf(w.workspace_id ?? null));
  return row.id;
}

export function enqueueBusWake(e: RobertWakeEvent): string | null {
  if (!CONFIG.robertWake) return null;
  const ticketId = e.ticket_id;
  if (!ticketId) return null;
  const wsId = tickets.get(ticketId)?.workspace_id ?? null;
  return enqueueWake({ topic: e.topic, key: wakeKeyFor(e), subject: ticketId, workspace_id: wsId, payload: e });
}

function kickDrain(scope: string): void {
  setTimeout(() => void drainScope(scope).catch((err) => console.error("[wake-queue]", err)), 0).unref?.();
}

/** Rows this drain may present: not parked, and past their subject's debounce window. */
export function dueRows(rows: RobertWake[], nowMs = Date.now()): RobertWake[] {
  const handled = new Map<string, string | null>();
  return rows.filter((r) => {
    if (r.attempts >= WAKE_ATTEMPT_CAP) return false;
    if (!r.subject || r.key.startsWith(TERMINAL_PROMPT_KEY) || r.key.startsWith(TERMINAL_DRIVE_KEY)) return true;
    if (!handled.has(r.subject)) handled.set(r.subject, robertWakes.lastHandledAt(r.subject));
    return wakeDue(handled.get(r.subject), nowMs);
  });
}

function eventOf(row: RobertWake): RobertWakeEvent | null {
  if (!row.payload) return null;
  try {
    const e = JSON.parse(row.payload) as BusEvent;
    return wakesRobert(e) ? e : null;
  } catch {
    return null;
  }
}

/** One wake in Robert's words. A payload we can't read still says something rather than vanishing. */
export function wakeSection(row: RobertWake): string {
  const e = eventOf(row);
  const repeat = row.hits > 1 ? `\n(this happened ${row.hits} times since it queued)` : "";
  if (e) return wakePromptFor(e) + repeat;
  let say: string | null = null;
  try {
    say = row.payload ? ((JSON.parse(row.payload) as { say?: string }).say ?? null) : null;
  } catch {}
  return (
    `${OP_PREFIX}${say ?? `something happened that needs a call: ${row.topic} (${row.key})`} the operator did NOT ask you ` +
    `anything; you are being woken because this needs a call. Post ONE or TWO lines: what it is, and the call you ` +
    `would make.${repeat}`
  );
}

/**
 * The whole queue as one prompt. A single wake is presented exactly as it was before the queue
 * existed — the batch framing only appears when there is more than one thing to say.
 */
export function batchPrompt(rows: RobertWake[]): string {
  const parts = rows.map(wakeSection);
  if (parts.length === 1) return parts[0];
  return (
    `${OP_PREFIX}${parts.length} things queued up while you were busy (or while the daemon was down) and all of them ` +
    `still need a call. Handle them ALL in this ONE reply, in the order below, one or two lines each, every line ` +
    `naming its ticket. The rules inside each wake still apply.\n\n` +
    parts.map((p, i) => `── wake ${i + 1} of ${parts.length} ──\n${p}`).join("\n\n")
  );
}

const draining = new Set<string>();
const parkedAnnounced = new Set<string>();

export type DrainOutcome = "busy" | "idle" | "drained" | "failed";

/**
 * Drain one workspace's queue in ONE turn. The mutex is per scope, so two ticks (or a tick racing
 * the startup replay) can never double-handle the same rows.
 */
export async function drainScope(scope: string, nowMs = Date.now()): Promise<DrainOutcome> {
  if (draining.has(scope)) return "busy";
  draining.add(scope);
  try {
    const queued = robertWakes.unackedForScope(scope);
    await surfaceParked(queued);
    const rows = dueRows(queued, nowMs);
    if (!rows.length) return "idle";
    const wsId = wsOfScope(scope);
    const ids = rows.map((r) => r.id);
    robertWakes.claim(ids);
    const prompt = batchPrompt(rows);
    try {
      const out = await asker(prompt, wsId, robertModelFor(prompt));
      const { reply, steps, turn } = typeof out === "string" ? { reply: out, steps: undefined, turn: undefined } : out;
      const text = (reply || "").trim();
      // A turn that produced no words still happened; acking it is what keeps an empty reply from
      // re-presenting the same wakes every 30 seconds forever.
      if (text || steps?.length) poster({ body: text, ticket_id: rows.length === 1 ? rows[0].subject : null, workspace_id: wsId, steps, turn });
      robertWakes.ackIds(ids, WAKE_ATTEMPT_CAP);
      return "drained";
    } catch (e: any) {
      robertWakes.fail(ids, String(e?.message ?? e));
      console.warn(`[wake-queue] ${scope} turn failed, ${ids.length} wake(s) stay queued:`, e?.message ?? e);
      await surfaceParked(robertWakes.unackedForScope(scope));
      return "failed";
    }
  } finally {
    draining.delete(scope);
  }
}

/** Past the attempt cap a wake stops being retried — so it has to become someone's problem out loud. */
async function surfaceParked(rows: RobertWake[]): Promise<void> {
  for (const r of rows) {
    if (r.attempts < WAKE_ATTEMPT_CAP || parkedAnnounced.has(r.id)) continue;
    parkedAnnounced.add(r.id);
    console.error(
      `[wake-queue] PARKED wake ${r.id.slice(0, 8)} (${r.key}) after ${r.attempts} attempts: ${r.last_error ?? "?"}`,
    );
    await notifier(
      `🅿️ <b>Robert wake parked</b> <code>${r.id.slice(0, 8)}</code> ${r.key} — ${r.attempts} failed turns, ` +
        `last: ${String(r.last_error ?? "?").slice(0, 120)}. <code>mc robert wakes</code>`,
    ).catch(() => {});
  }
}

/** Every scope with something queued, one turn each. Startup replay and the tick share this. */
export async function drainAll(nowMs = Date.now()): Promise<void> {
  for (const scope of robertWakes.unackedScopes()) {
    try {
      await drainScope(scope, nowMs);
    } catch (e: any) {
      console.error("[wake-queue] drain", scope, e?.message ?? e);
    }
  }
}

/** True once the bus listener is registered — half of what the supervision predicate calls "armed". */
export function wakeBusArmed(): boolean {
  return busArmed;
}
let busArmed = false;

/** Test seam: drop the in-process state so a "restart" can be simulated against the same DB. */
export function resetWakeQueueState(): void {
  draining.clear();
  parkedAnnounced.clear();
  busArmed = false;
}

export function startWakeQueue(): void {
  bus.on("event", (e: BusEvent) => {
    if (wakesRobert(e)) {
      try {
        enqueueBusWake(e);
      } catch (err) {
        console.error("[wake-queue] enqueue failed", err);
      }
    }
  });
  busArmed = true;
  touchWakeBeacon();
  const tick = async () => {
    touchWakeBeacon();
    await drainAll();
  };
  setInterval(() => void tick().catch((e) => console.error("[wake-queue]", e)), WAKE_DRAIN_MS).unref?.();
  // Replay first: a restart mid-turn left rows claimed and unacked, and they are the wakes most
  // likely to matter. Then say whether anything is still watching the fleet at all.
  setTimeout(() => {
    void (async () => {
      await tick();
      const { checkSupervision } = await import("./supervision-guard.js");
      await checkSupervision();
    })().catch((e) => console.error("[wake-queue] replay", e));
  }, 3_000).unref?.();
  console.log(`[wake-queue] durable wakes drained every ${WAKE_DRAIN_MS / 1000}s (cap ${WAKE_ATTEMPT_CAP} attempts)`);
}
