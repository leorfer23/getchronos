import { CONFIG } from "./config.js";
import { jobs, runs, kv } from "./store.js";
import { awaitingRecovery } from "./recovery.js";
import { decayLessons } from "./lessons.js";
import { MEMORY_AGENTS, agentMemoryNote } from "./agent-memory.js";
import { runStowPass, recentReinforcement } from "./stow.js";
import { notifyInfo, esc } from "./telegram/api.js";
import { latestSlot, slotDay } from "./dream.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const HYGIENE_KV = "hygiene.last_run";
const HYGIENE_EVERY_DAYS = 6;

// Jobs created purely to run once (rate-limit fallback clones, the dream pass's per-slot jobs, the
// retired hygiene compaction jobs still in old DBs) and never re-dispatched by id afterward — nothing
// schedules or reruns them. Left alone they pile up in the jobs table/UI forever.
export const EPHEMERAL_JOB_PREFIXES = ["fallback:", "hygiene:", "prose:", "dream:"];
let lastReapDay = "";

// Once a day, delete ephemeral jobs that are done (no running/queued run) and old enough that a
// delayed rate-limit resume (maybeResume in dispatcher.ts, capped by CONFIG.resumeAfterRateLimitMaxHours)
// can no longer target them.
export function reapEphemeralJobs(): void {
  if (lastReapDay === todayStr()) return;
  lastReapDay = todayStr();
  const cutoff = Date.now() - 24 * 3600_000;
  for (const job of jobs.list()) {
    if (!EPHEMERAL_JOB_PREFIXES.some((p) => job.name.startsWith(p))) continue;
    if (Date.parse(job.created_at) > cutoff) continue;
    if (runs.list(job.id).some((r) => r.status === "running" || r.status === "queued")) continue;
    // A stall awaiting the operator's call still needs its job: recovery.ts resumes by re-dispatching
    // job.id, so reaping it here would silently turn "resume?" into "can't".
    if (awaitingRecovery(job.id)) continue;
    jobs.remove(job.id);
  }
}

/**
 * The unattended stow pass, once per hygiene sweep, for every persona that has a memory file.
 *
 * Reinforcement here is only what the daemon can point at on its own (recentReinforcement: a lesson
 * filed or fired, a learning captured, in the last 7 days). That set is usually small, and that is
 * the design — an unattended pass that reinforced everything it found important would just be growth
 * with extra steps. Nothing is ever deleted, so the cost of retiring a fact the sweep could not see
 * evidence for is one grep in memory-archive-<agent>.md.
 */
export function stowMemories(now = new Date()): string[] {
  const evidence = recentReinforcement(now);
  const nudges: string[] = [];
  for (const agent of MEMORY_AGENTS) {
    if (!agentMemoryNote(agent, false)) continue;
    try {
      // resolveGrace off: the sweep may run clocks, but retiring a never-validated legacy entry
      // takes evidence only the agent itself can name.
      const r = runStowPass(agent, { reinforced: evidence, now, resolveGrace: false });
      console.log(
        `[hygiene] stow ${agent}: ${r.reinforced.length} reinforced, ${r.graced.length} graced, ` +
          `${r.awaitingValidation.length} awaiting validation, ${r.archived.length} archived, ` +
          `${r.after.total}/${r.after.budget} tokens` + (r.decision ? ` — ${r.decision}` : ""),
      );
      const pending = r.graced.length + r.awaitingValidation.length;
      if (pending || r.decision) {
        nudges.push(
          `${agent}: ${pending} memory entr${pending === 1 ? "y" : "ies"} waiting for ${agent} to run stow with evidence` +
            (r.decision ? `; ${r.decision}` : ""),
        );
      }
    } catch (e) {
      // A memory pass must never take the weekly sweep down with it.
      console.error(`[hygiene] stow ${agent} failed`, e);
    }
  }
  return nudges;
}

// Weekly memory hygiene: retire lessons nobody's code matches any more, and run the stow pass over
// the personas' own memory files (Robert's). Workspace memory — the session-learnings inbox, the
// index, branches — is the dream pass's (src/dream-pass.ts, twice a day): the haiku job that used to
// compact session-learnings in place here, and the card offering to ★ the whole inbox, are gone. The
// compaction only ever rewrote an inbox no agent loads, and ★-ing a 70k inbox would have put all of it
// in every prompt; the dream pass instead promotes line by line, under caps, and empties the inbox.
//
// Rides the dream slot (src/dream.ts), not the digest hour: gating on digestHour meant that turning
// the morning message off (CHRONOS_DIGEST_HOUR=-1) turned memory maintenance off with it, silently,
// from 2026-08-31 on. It fires at the first slot on a calendar day ≥6 days after the last run's —
// or on the first tick after that slot if the Mac slept through it.
//
// Weekly, not every slot: lesson decay is measured in weeks, and the stow nudges are Telegram
// messages — twice a day would be nagging.
//
// Returns the slot to record, or null. `last` is that slot key, or an ISO timestamp from before the
// slot existed (read as its local day).
export function hygieneDue(last: string | undefined, now = new Date(), hours = CONFIG.dreamHours): string | null {
  const slot = latestSlot(now, hours);
  if (!slot) return null;
  if (!last) return slot;
  const lastDay = last.includes("@") ? slotDay(last) : new Date(new Date(last).setHours(0, 0, 0, 0));
  if (Number.isNaN(lastDay.getTime())) return slot;
  const days = Math.round((slotDay(slot).getTime() - lastDay.getTime()) / 86_400_000);
  return days >= HYGIENE_EVERY_DAYS ? slot : null;
}

export async function maybeHygiene() {
  const slot = hygieneDue(kv.get(HYGIENE_KV));
  if (!slot) return;
  kv.set(HYGIENE_KV, slot);

  // A lesson vault that only ever grows is a prompt tax, and a rule nobody's code matches any more is noise.
  const retired = decayLessons();
  if (retired) console.log(`[hygiene] archived ${retired} stale lesson(s)`);

  const stowNudges = stowMemories();
  if (stowNudges.length) await notifyInfo(`🧹 <b>Memory</b> ${esc(stowNudges.join(" · "))}`).catch(() => {});
}
