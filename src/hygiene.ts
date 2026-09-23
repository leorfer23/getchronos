import { CONFIG } from "./config.js";
import { workspaces, repos, jobs, runs, kv, notes } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { awaitingRecovery } from "./recovery.js";
import * as noteSvc from "./notes.js";
import { decayLessons } from "./lessons.js";
import { MEMORY_AGENTS, agentMemoryNote } from "./agent-memory.js";
import { runStowPass, recentReinforcement } from "./stow.js";
import { notify, notifyInfo, esc } from "./telegram/api.js";
import { kb } from "./telegram/keyboards.js";
import type { Note } from "./types.js";
import { REPO_ROOT } from "./repo-root.js";

const LEARN_SLUG = "session-learnings";
const todayStr = () => new Date().toISOString().slice(0, 10);
const HYGIENE_KV = "hygiene.last_run";
const HYGIENE_EVERY_DAYS = 6;

// Jobs created purely to run once (rate-limit fallback clones, this file's own compaction jobs)
// and never re-dispatched by id afterward — nothing schedules or reruns them. Left alone they pile
// up in the jobs table/UI forever.
const EPHEMERAL_JOB_PREFIXES = ["fallback:", "hygiene:", "prose:"];
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

// A memo worth compacting has grown past the point where duplicates and stale facts pile up.
export function needsCompaction(body: string): boolean {
  return body.length > 3000;
}

// Bullet-style fact lines (captureLearnings writes `- <fact>`); the count is the card's "N learnings".
export function factCount(body: string): number {
  return body.split("\n").filter((l) => l.trim().startsWith("-")).length;
}

// Offer to ★-promote an un-flagged learnings memo once it holds ≥10 facts. After an Ignore we store
// the size in kv and stay quiet until the memo doubles, so the card doesn't nag every Sunday.
export function shouldOfferPromotion(note: Note | undefined, kvGet: (k: string) => string | undefined): boolean {
  if (!note || note.context) return false;
  if (factCount(note.body) < 10) return false;
  const ignoredAt = kvGet(`hygiene.ignored.${note.id}`);
  return !ignoredAt || note.body.length > Number(ignoredAt) * 2;
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

const goal =
  `MEMORY HYGIENE (read-only code — you edit ONE memo via the mc CLI, never the filesystem). ` +
  `Compact this workspace's session-learnings memo WITHOUT losing information.\n` +
  `1. Read it: \`mc memo get session-learnings\`.\n` +
  `2. Rewrite the whole body: \`mc memo edit session-learnings --body "<full new body>"\`.\n` +
  `Rules: merge duplicates, collapse near-identical facts into one, drop transient/dated items that no longer matter, ` +
  `keep EVERY still-true durable fact. Group under short ## headings (Repo, Conventions, Operator preferences, Gotchas). ` +
  `Keep the body under ~4000 chars. Compact — do not summarize real facts away.`;

// Weekly-ish memory hygiene. Per non-archived workspace whose session-learnings memo has grown big →
// dispatch a read-only agent to compact it in place; independently, offer to ★-promote un-flagged
// memos that carry enough facts to be worth feeding back into agents.
//
// Catch-up semantics, NOT a fixed slot: the old "Sunday, exactly hour==digestHour" gate never fired
// once in four weeks — the laptop was asleep or the daemon restarted at that hour every single time,
// and the in-memory lastHygieneDay meant a restart forgot it had fired anyway. Now the last run is
// kv-persisted and the sweep fires on the first tick that is ≥6 days after it (past digestHour, so
// it still lands in the same quiet part of the day), whenever that tick happens to come.
export function hygieneDue(last: string | undefined, now = new Date(), digestHour = CONFIG.digestHour): boolean {
  if (digestHour < 0) return false;
  const daysSince = last ? (now.getTime() - Date.parse(last)) / 86_400_000 : Infinity;
  return daysSince >= HYGIENE_EVERY_DAYS && now.getHours() >= digestHour;
}

export async function maybeHygiene() {
  if (!hygieneDue(kv.get(HYGIENE_KV))) return;
  kv.set(HYGIENE_KV, new Date().toISOString());

  // Retire rules that stopped meaning anything before compacting anything else — a lesson vault
  // that only ever grows is a prompt tax, and a rule nobody's code matches any more is noise.
  const retired = decayLessons();
  if (retired) console.log(`[hygiene] archived ${retired} stale lesson(s)`);

  const stowNudges = stowMemories();
  if (stowNudges.length) await notifyInfo(`🧹 <b>Memory</b> ${esc(stowNudges.join(" · "))}`).catch(() => {});

  const compacted: string[] = [];
  for (const w of workspaces.list()) {
    const memo = notes.bySlug(w.id, LEARN_SLUG);
    if (!memo) continue;

    if (needsCompaction(memo.body)) {
      const cwd = repos.list(w.id)[0]?.path || REPO_ROOT;
      const job = jobs.create({
        name: `hygiene:${w.slug}`,
        description: `Compact session-learnings for ${w.name}`,
        goal,
        workspace_id: w.id,
        // pure text merge/dedup of learnings — no code reasoning; pinned to claude/haiku so a
        // workspace's alternate review backend never gets an invalid model name
        backend: "claude-code",
        model: "haiku",
        cwd,
        sandbox: w.sandbox_mode,
        disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
        trigger_type: "manual",
      });
      dispatch(job.id, `hygiene:${w.slug}`);
      compacted.push(w.name);
    }

    if (shouldOfferPromotion(memo, kv.get)) {
      const i = memo.id.slice(0, 8);
      await notify(
        `🧠 <b>${esc(w.name)}</b> has ${factCount(memo.body)} learnings not fed back into agents`,
        kb([[{ text: "★ Promote", data: `lp.y.${i}` }, { text: "Ignore", data: `lp.n.${i}` }]])
      ).catch(() => {});
    }
  }
  if (compacted.length)
    await notifyInfo(`🧹 <b>Memory hygiene</b> · ${todayStr()}\nCompacting: ${compacted.map(esc).join(", ")}`).catch(() => {});
}
