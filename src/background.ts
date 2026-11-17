/**
 * Background terminals: a terminal nobody chose to open runs out of sight until it needs the operator.
 *
 * The operator, 2026-11-15: "lo abro y de repente tengo 20 sesiones… es overwhelming". Over the week
 * before, 50 of 81 terminals were opened by the daemon (inbox 22, job check 14, ship 6, …) and he typed
 * into 9 of those 50. Most of them were reports he never had to act on: "1 fixed and green", "not an
 * outage", "#132 is healthy". They each took a rail row, and only he could close them.
 *
 * So, for a terminal opened by one of BACKGROUND_OPENERS that he has not typed into:
 *   - it is `background` (TermStatus.background) — the Desk and the phone keep it off the rail behind
 *     one "N in the background" line — until it needs him: a wall, a question, a stall, a hand-off
 *     that asks for something, or a stop with no hand-off at all;
 *   - when it finished with a hand-off that asks for nothing (quietHandoff), it closes itself after
 *     `desk.background_close_min` and lands in Recent with its summary (closeQuietBackground).
 * The moment he types into one it is his, like any terminal he opened.
 *
 * "Asks for nothing" is not the agent's `--ask none` alone: of the auto terminals that filed `none` in
 * the fortnight before this, five still waited on him in their own words ("needs you to re-auth",
 * "Okta login needed", "Draft reply … unsent", "1 still red"). waitsOnOperator reads the hand-off for
 * that, and errs toward showing it.
 */
import fs from "node:fs";
import { setting, settingOn } from "./settings.js";
import { repos, sessions } from "./store.js";
import { killSession, sessionActivity } from "./terminal.js";
import { worktreeState } from "./worktrees.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import type { Outcome, Session } from "./types.js";
import type { Phase } from "./term-status.js";

/** Openers whose terminals run in the background: nobody asked for them in the moment. */
export const BACKGROUND_OPENERS: ReadonlySet<string> = new Set(["inbox", "proactive", "trigger", "job-check", "ship", "follow-up"]);

type Row = Pick<Session, "created_by" | "role" | "lead_id" | "operator_inputs">;

/** Opened by the daemon for him, and he has not typed into it since. A Lead and its workers keep their own fold. */
export function openedInBackground(s: Row): boolean {
  if (s.role === "lead" || s.lead_id) return false;
  if ((s.operator_inputs ?? 0) > 0) return false; // he typed into it: it is his now
  return BACKGROUND_OPENERS.has((s.created_by ?? "").trim());
}

/**
 * The line of a hand-off that says something still waits on him, or null. Errs toward a match: a
 * terminal shown that did not need to be costs him a click, one hidden that did costs him the thing.
 * A draft in his own self-DM is the hand-off's copy for him (the job check sends one), not a send —
 * nor is a self-DM that could not go out (MC_OPERATOR_SLACK_DM unset).
 */
export function waitsOnOperator(lines: readonly (string | null | undefined)[]): string | null {
  for (const raw of lines) {
    const line = String(raw ?? "");
    if (!line.trim()) continue;
    // "0 still red" / "nothing still red" is the all-clear, not a red.
    const t = line.replace(/\b(0|no|nothing|none)\s+(jobs?\s+)?(is\s+|are\s+)?still red\b/gi, "");
    if (/\bstill red\b/i.test(t)) return line;
    if (/self[- ]?DM|OPERATOR_SLACK_DM/i.test(t)) continue;
    if (NEEDS_RE.test(t)) return line;
  }
  return null;
}
const NEEDS_RE = new RegExp(
  "\\b(" +
    [
      "needs? (you|your)", "for you to", "waiting (on|for) you", "waits on you", "you (need|have|must) to",
      "your (ok|okay|approval|review|yes|call|decision|login|sign-?off)",
      "log ?in", "logins?", "re-?auth\\w*", "okta", "sso", "2fa", "mfa",
      "drafts?", "unsent", "not sent",
    ].join("|") +
    ")\\b",
  "i",
);

/** A hand-off that asks for nothing at all — the one kind of finish a background terminal closes on. */
export function quietHandoff(o: Outcome | null | undefined): boolean {
  if (!o?.summary || o.ask !== "none") return false;
  return !waitsOnOperator([o.summary, ...(o.changes ?? [])]);
}

/** Did it hand off since anyone last typed to it? A hand-off older than the last input answers an older question. */
export function handoffStands(o: Outcome | null | undefined, lastIn: number | null): boolean {
  const at = Date.parse(o?.at ?? "");
  if (!at) return false;
  return !lastIn || at >= lastIn - 2000;
}

/**
 * Does a background terminal in this phase need him? Pure. `quiet` = its hand-off stands and asks
 * for nothing. Working and waiting never do; a finished turn or a reached goal does unless quiet.
 */
export function needsOperator(phase: Phase, asks: number, quiet: boolean): boolean {
  if (asks > 0) return true;
  if (phase === "blocked" || phase === "decide" || phase === "stalled") return true;
  if (phase === "review" || phase === "your_turn") return !quiet;
  return false;
}

/** ⚙ Settings → Desk `desk.background`: off puts every terminal back on the rail and nothing closes itself. */
export const backgroundOn = (workspaceId?: string | null): boolean => settingOn("desk.background", workspaceId ?? null);

/** What statusOf adds: true while the terminal is out of sight. */
export function backgroundOf(s: Row & Pick<Session, "outcome" | "workspace_id">, phase: Phase, asks: number, lastIn: number | null): boolean {
  if (phase === "ended" || !openedInBackground(s) || !backgroundOn(s.workspace_id)) return false;
  const quiet = quietHandoff(s.outcome) && handoffStands(s.outcome, lastIn);
  return !needsOperator(phase, asks, quiet);
}

/** Restarts revive terminals for a few minutes; none of them closes itself before that settles. */
export const CLOSE_BOOT_GRACE_SEC = 300;
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

type CloseDeps = {
  now?: number;
  status?: (id: string) => { phase: Phase; asks?: number; since: number } | null;
  activity?: typeof sessionActivity;
  kill?: typeof killSession;
  /** Uncommitted or unpushed work in its tree → the reason it stays open; null = nothing to strand. */
  strands?: (s: Session) => Promise<string | null>;
};

/**
 * Close every background terminal that finished, handed off asking for nothing, and has sat quiet for
 * `desk.background_close_min` minutes. Never one he typed into, one with work its tree would strand,
 * one on another computer, or a cloud one. Returns the ids it closed.
 */
export async function closeQuietBackground(deps: CloseDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now();
  const status = deps.status ?? (await import("./term-status.js")).statusOf;
  const activity = deps.activity ?? sessionActivity;
  const kill = deps.kill ?? killSession;
  const strands = deps.strands ?? treeStrands;
  const closed: string[] = [];
  for (const s of sessions.list({ status: "live", limit: 500 })) {
    if (!openedInBackground(s) || s.cloud_agent_id || !backgroundOn(s.workspace_id)) continue;
    const mins = Number(setting<number>("desk.background_close_min", s.workspace_id));
    if (!(mins > 0)) continue;
    const wait = mins * 60_000;
    if ((s.host_id || LOCAL_HOST_ID) !== LOCAL_HOST_ID) continue;
    const o = s.outcome;
    if (!quietHandoff(o)) continue;
    const act = activity(s.id);
    if (!act.live || !act.quiet || !handoffStands(o, act.last_in)) continue;
    const st = status(s.id);
    if (!st || (st.phase !== "review" && st.phase !== "your_turn") || (st.asks ?? 0) > 0) continue;
    if (now - Date.parse(o!.at) < wait || now - st.since < wait) continue;
    const why = await strands(s).catch((e) => `could not read its tree: ${String(e?.message ?? e).slice(0, 120)}`);
    if (why) continue;
    try {
      kill(s.id, "closed itself, nothing for you — " + clip(o!.summary, 160));
      closed.push(s.id);
      console.log(`[background] ${s.id.slice(0, 8)} (${s.created_by}) closed itself: ${clip(o!.summary, 100)}`);
    } catch (e: any) {
      console.warn(`[background] could not close ${s.id.slice(0, 8)}:`, e?.message ?? e);
    }
  }
  return closed;
}

/** The same guard a Lead's close uses (leadCloseRefusal): nothing uncommitted, nothing no remote has. */
export async function treeStrands(s: Session): Promise<string | null> {
  const wt = s.worktree_path;
  if (!wt || !fs.existsSync(wt)) return null; // it never claimed one, or already removed its own
  const repo = s.repo_id ? repos.get(s.repo_id) : null;
  if (!repo?.path) return "its worktree's repo is unknown";
  const st = await worktreeState(repo.path, wt, { ignoreSession: s.id });
  if (st.dirty) return `${st.dirty_files} uncommitted file(s) in its worktree`;
  if (st.unpushed) return `${st.unpushed} commit(s) in its worktree not on any remote`;
  return null;
}
