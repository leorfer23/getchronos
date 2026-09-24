import { CONFIG } from "./config.js";
import { kv } from "./store.js";

// The dream slot: the moments of the day when memory maintenance runs, after the operator's work
// blocks instead of during them. A slot is a local date + hour, keyed `YYYY-MM-DD@HH`.
//
// Catch-up, not a clock match: the laptop sleeps through slots, and the old `hour === digestHour`
// gates simply never fired. The most recent slot whose time has passed is due until something marks
// it, so a Mac that wakes at 15:40 runs the 13:00 pass then. Only that latest slot — two slots
// missed over a weekend are one pass, not a backlog. The mark lives in kv, so a restart does not
// rerun a slot it already ran.
//
// All arithmetic is on local calendar fields (getFullYear/getMonth/getDate/getHours), never on
// ms offsets, so a 23- or 25-hour DST day cannot shift or skip a slot.

const pad = (n: number) => String(n).padStart(2, "0");

export function slotKey(day: Date, hour: number): string {
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}@${pad(hour)}`;
}

/** The latest slot at or before `now`, or null when there are no slot hours (off). */
export function latestSlot(now: Date, hours: number[]): string | null {
  if (!hours.length) return null;
  const today = hours.filter((h) => h <= now.getHours());
  if (today.length) return slotKey(now, Math.max(...today));
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return slotKey(yesterday, Math.max(...hours));
}

/**
 * The slot the caller named by `kvKey` should run now, or null. Keys are zero-padded so they sort as
 * strings; a stored key at or after the latest slot (already ran, or the clock went backwards) holds.
 */
export function dueSlot(
  kvKey: string,
  now = new Date(),
  hours = CONFIG.dreamHours,
  get: (k: string) => string | undefined = kv.get,
): string | null {
  const slot = latestSlot(now, hours);
  if (!slot) return null;
  const last = get(kvKey);
  return last && last >= slot ? null : slot;
}

/** Record that `kvKey` ran `slot`. Mark before the work, so a pass that throws is not retried every tick. */
export function markSlot(kvKey: string, slot: string, set: (k: string, v: string) => void = kv.set): void {
  set(kvKey, slot);
}

/** The local calendar day of a slot key, as a Date at local midnight. */
export function slotDay(slot: string): Date {
  const [y, m, d] = slot.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Hook for the per-workspace dream pass (PR 3 of the dream series). Wired into the monitor tick next
// to maybeHygiene so the schedule is live and exercised; until then it neither reads nor marks a
// slot, so the first real pass still runs on the first slot after it ships.
export async function maybeDream(): Promise<void> {}
