import { postToBoard } from "./board.js";
import type { Session } from "./types.js";

/**
 * Desk incidents — the failures Robert has to hear about for the self-improvement loop to run
 * without the operator noticing first.
 *
 * The 2026-09-13 grok deaths are the template: three seeded terminals died 3s after spawn, their
 * pty scrollback went with them, nothing was logged, no one was woken. The operator saw empty cards
 * hours later and had to ask a human agent to dig the cause out of ~/.grok/logs. Everything that
 * post needed was in memory at the moment of exit — the screen, the backend, who opened it, how
 * long it lived — so this captures it right there and puts it in front of Robert with the fix path.
 *
 * "Early" = the seed was typed (there was a task), nobody killed it on purpose, the goal is not
 * done, and it lived under EARLY_DEATH_MS. A bare chat someone closed is none of those.
 */
export const EARLY_DEATH_MS = 120_000;
/** One post per (backend, cwd) per window; a Robert retrying the same spawn must not flood the board. */
export const INCIDENT_THROTTLE_MS = 10 * 60_000;

export function isEarlyDeath(i: { aliveMs: number; seeded: boolean; killed: boolean; goalDone: boolean }): boolean {
  return i.seeded && !i.killed && !i.goalDone && i.aliveMs < EARLY_DEATH_MS;
}

/** The last lines that carry text — what the terminal was showing when it went. */
export function evidenceLines(lines: string[], max = 12): string[] {
  return lines.map((l) => l.trimEnd()).filter(Boolean).slice(-max);
}

export function earlyDeathPost(s: Session, aliveMs: number, screen: string[]): string {
  const secs = Math.max(1, Math.round(aliveMs / 1000));
  const who = s.created_by ?? "operator";
  const goal = (s.goal || s.spawn_goal || "").trim();
  const ev = evidenceLines(screen);
  const logHint =
    s.backend === "grok"
      ? "`~/.grok/logs/unified.jsonl` filtered by this pty's pid — `startup interactive` without `session created` means it never got past a startup dialog"
      : s.backend === "claude-code"
        ? "the profile's `~/.claude/projects/<cwd>/<session>.jsonl` (empty = it never took the seed) and `chronos.err.log`"
        : "`chronos.err.log` and the CLI's own log under its home dir";
  return (
    `@robert 🧯 **Terminal died ${secs}s after spawn** — \`${s.id.slice(0, 8)}\` ${s.backend}${s.model ? `/${s.model}` : ""} · opened by ${who} · \`${s.cwd}\`\n` +
    (goal ? `Goal: ${goal.slice(0, 160)}\n` : "") +
    `The seed was typed and no goal was ticked, so nothing was done. Last screen:\n` +
    "```\n" + (ev.length ? ev.join("\n") : "(blank — the CLI produced no output)") + "\n```\n" +
    `Diagnose from ${logHint}. If it is a Chronos bug, fix it yourself: skill \`chronos-hotfix-deploy\` (branch → test → PR → merge → POST /api/self-deploy). ` +
    `If it is a quota/auth wall, say so and stop spawning on that backend until it clears.`
  );
}

const lastPosted = new Map<string, number>();
export function resetIncidentThrottle(): void { lastPosted.clear(); }

/** Log it always; post it to the board unless the same (backend, cwd) already did within the window. */
export function reportEarlyDeath(s: Session, aliveMs: number, screen: string[], now = Date.now()): "posted" | "throttled" {
  const ev = evidenceLines(screen, 4);
  console.warn(
    `[incident] terminal ${s.id.slice(0, 8)} (${s.backend}, by ${s.created_by ?? "operator"}) died ${Math.round(aliveMs / 1000)}s after spawn ` +
    `with its seed typed and no goal done — cwd ${s.cwd}; last screen: ${ev.length ? ev.join(" ⏎ ") : "(blank)"}`,
  );
  const key = `${s.backend}|${s.cwd}`;
  const prev = lastPosted.get(key);
  if (prev != null && now - prev < INCIDENT_THROTTLE_MS) return "throttled";
  lastPosted.set(key, now);
  try {
    postToBoard({ author: "chronos", body: earlyDeathPost(s, aliveMs, screen), workspace_id: s.workspace_id ?? null });
  } catch (e: any) {
    console.warn("[incident] board post failed", e?.message ?? e);
  }
  return "posted";
}
