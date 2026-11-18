/**
 * Auto-close: the operator lets Robert close a terminal once its goal is met.
 *
 * The operator, 2026-11-17: "me gustaría poder definir en agentes … si quiero que se auto-closeen
 * cuando llegan al objetivo, onda que Robert chequee y si está terminado que se cierre" — "desde un
 * toggle o diciéndoles una keyword como auto-close".
 *
 * Three parties, three jobs:
 *  - The OPERATOR grants it (sessions.auto_close): the Focus toggle, or the keyword in a goal, brief or
 *    line he typed (autoCloseWord). Nobody else can set it — an agent that could mark itself closable
 *    could end its own oversight, and Robert granting it to himself would make the grant meaningless.
 *  - ROBERT judges "is the goal really met": a wake on its stop says AUTO-CLOSE (robert-drive.ts), he
 *    looks, and closes it with `mc session close <id> "<what landed>"`.
 *  - The DAEMON refuses any close that would lose something (closeRefusal), whatever Robert decided:
 *    still writing, an open question, a hand-off that still asks the operator for a merge/deploy/review
 *    or says it waits on him, uncommitted or unpushed work (read on whichever computer holds the tree),
 *    a computer that is offline, a cloud terminal, a Lead with live workers.
 */
import { closesWhenDone } from "./robert-command.js";
import { asks, sessions } from "./store.js";
import { killSession, sessionActivity } from "./terminal.js";
import { tickAllGoals } from "./goals.js";
import { treeStrands, waitsOnOperator } from "./background.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import { hostOnline } from "./hosts/index.js";
import { listAllWorktrees } from "./worktrees.js";
import type { Outcome, Session } from "./types.js";
import type { Phase } from "./term-status.js";

// ───────────────────────────── the keyword ─────────────────────────────

const WORD = String.raw`auto[-_ ]?close`;
const NEG = String.raw`(?:no|not|don'?t|sin|nunca|never)[-_ ]+`;
/** The whole line is the keyword: `auto-close`, `autoclose`, `no auto-close`. */
const WHOLE = new RegExp(String.raw`^\s*[#/]?(${NEG})?${WORD}[\s.!]*$`, "i");
/** A tag anywhere: `#auto-close`, `--auto-close`, `#no-auto-close`. */
const TAG = new RegExp(String.raw`(^|\s)(?:#|--)(${NEG})?${WORD}(?=$|[\s.,;:!?)])`, "i");
/** At the start with a colon or comma: `auto-close: fix the flaky test`. */
const LEAD = new RegExp(String.raw`^\s*(${NEG})?${WORD}\s*[:,;]\s*`, "i");
/** At the end after a separator: `fix the flaky test, auto-close` · `… — auto-close`. */
const TAIL = new RegExp(String.raw`\s*(?:[,;·|]|\s[-–—]|\.(?=\s))\s*(${NEG})?${WORD}[\s.!]*$`, "i");

/**
 * Does this text the operator typed turn auto-close on (true) or off (false), and what is left of it
 * once the keyword is taken out (null when nothing is said about it).
 *
 * Deliberately NOT any mention of the word: "the modal should auto-close on save" is a feature being
 * described, not a wish about the terminal. Only the forms above count — the line on its own, a tag,
 * or the word set off at the start or end of the line.
 */
export function autoCloseWord(text: string | null | undefined): { on: boolean; text: string } | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const tidy = (s: string) => s.replace(/[ \t]{2,}/g, " ").trim();
  let m = WHOLE.exec(t);
  if (m) return { on: !m[1], text: "" };
  m = TAG.exec(t);
  if (m) return { on: !m[2], text: tidy(t.slice(0, m.index) + m[1] + t.slice(m.index + m[0].length)) };
  m = LEAD.exec(t);
  if (m) return { on: !m[1], text: tidy(t.slice(m[0].length)) };
  m = TAIL.exec(t);
  if (m) return { on: !m[1], text: tidy(t.slice(0, m.index)) };
  return null;
}

/**
 * A new terminal's open request (POST /sessions): the operator's `auto-close` in its goal or brief turns
 * it on and leaves the card without the word; from anyone else the field is dropped and the words are
 * left alone — Robert's or a Lead's goal saying "auto-close" grants nothing.
 */
export function spawnAutoClose(body: { goal?: string | null; description?: string | null; auto_close?: boolean }, operator: boolean): void {
  if (!operator) { delete body.auto_close; return; }
  for (const k of ["goal", "description"] as const) {
    const w = typeof body[k] === "string" ? autoCloseWord(body[k]) : null;
    if (!w) continue;
    body.auto_close = w.on;
    if (w.text) body[k] = w.text;
    else if (k === "goal") body.goal = null;
    else delete body.description;
  }
}

// ───────────────────────────── the guard ─────────────────────────────

export type CloseFacts = {
  /** Its pty is running (sessionActivity). */
  live: boolean;
  /** Not writing right now. */
  quiet: boolean;
  /** Its resolved card phase (term-status.ts), null when unknown. */
  phase: Phase | null;
  /** Open `mc ask-robert` questions. */
  openAsks: number;
  /** A Lead's live workers (0 for anything else). */
  liveWorkers: number;
  /** The computer it runs on is connected (always true for this one). */
  hostOnline: boolean;
};

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** A hand-off that still wants something from the operator, as the reason — or null. */
export function handoffWants(o: Outcome | null | undefined): string | null {
  if (!o) return null;
  const want = o.ask ?? "none";
  const done = (o.shipped ?? []).join(" ").toLowerCase();
  if (want === "review") return "its hand-off asks the operator to review it";
  if (want.includes("merge") && !/\bmerg/.test(done)) return `its hand-off asks the operator to ${want}`;
  if (want.includes("deploy") && !/\bdeploy/.test(done)) return `its hand-off asks the operator to ${want}`;
  const line = waitsOnOperator([o.summary, ...(o.changes ?? [])]);
  return line ? `its hand-off still waits on the operator: “${clip(line, 120)}”` : null;
}

/**
 * Why this terminal may not be closed for being done, or null. Pure over what the caller read — the
 * tree check (treeStrands) runs after, since it is the one that touches git.
 */
export function closeRefusal(
  s: Pick<Session, "auto_close" | "status" | "cloud_agent_id" | "outcome" | "role"> & { workspace_id?: string | null },
  f: CloseFacts,
): string | null {
  // His mark on this terminal, or his word for the whole workspace (`robert.close_done`, robert-command.ts).
  if (!closesWhenDone({ auto_close: s.auto_close, workspace_id: s.workspace_id ?? null }))
    return "auto-close is off for this terminal — only the operator turns it on (the Focus toggle, `auto-close`, or \"Robert closes finished terminals\" for the workspace)";
  if (s.status !== "live" || !f.live) return "it is not running";
  if (s.cloud_agent_id) return "it is a cloud terminal — the operator closes those";
  if (!f.hostOnline) return "its computer is offline — try again once it reconnects";
  if (s.role === "lead" && f.liveWorkers > 0) return `it is a Lead with ${f.liveWorkers} live worker(s)`;
  if (!f.quiet) return "still working — its terminal is writing right now";
  if (f.openAsks > 0) return "it has an open question";
  if (f.phase && f.phase !== "review" && f.phase !== "your_turn") return `its card says "${f.phase}", not finished`;
  return handoffWants(s.outcome);
}

// ───────────────────────────── the close ─────────────────────────────

/**
 * treeStrands for a terminal on another computer: its claimed worktree as that computer reports it
 * (worktrees.ts listAllWorktrees asks every online host). A tree that cannot be found there refuses
 * the close — unread is not clean.
 */
export async function remoteTreeStrands(
  s: Pick<Session, "host_id" | "worktree_path" | "workspace_id">,
  list: (ws?: string) => Promise<Array<{ host_id: string; path: string; dirty: boolean; dirty_files: number; unpushed: number }>> = listAllWorktrees,
): Promise<string | null> {
  if (!s.worktree_path) return null; // it never claimed one, like the local rule
  const wt = (await list(s.workspace_id ?? undefined)).find((t) => t.host_id === s.host_id && t.path === s.worktree_path);
  if (!wt) return "could not read its worktree on that computer";
  if (wt.dirty) return `${wt.dirty_files} uncommitted file(s) in its worktree`;
  if (wt.unpushed) return `${wt.unpushed} commit(s) in its worktree not on any remote`;
  return null;
}

type Deps = {
  activity?: typeof sessionActivity;
  status?: (id: string) => { phase: Phase } | null;
  strands?: (s: Session) => Promise<string | null>;
  kill?: typeof killSession;
  hostOnline?: (id: string | null | undefined) => boolean;
};

/**
 * Close a terminal Robert (or the operator) found done: every guard first, then the goal ticked (done
 * is done — the day's log should say so) and the pty ended with the reason on its Recent row.
 */
export async function closeWhenDone(
  id: string,
  why: string,
  by: "robert" | "operator",
  deps: Deps = {},
): Promise<{ closed: true } | { refused: string }> {
  const s = sessions.get(id);
  if (!s) return { refused: "no such terminal" };
  const act = (deps.activity ?? sessionActivity)(id);
  const status = deps.status ?? (await import("./term-status.js")).statusOf;
  const facts: CloseFacts = {
    live: act.live,
    quiet: act.quiet,
    phase: status(id)?.phase ?? null,
    openAsks: asks.openForSession(id).length,
    liveWorkers: s.role === "lead" ? sessions.workersOf(id, { status: "live" }).length : 0,
    hostOnline: (deps.hostOnline ?? hostOnline)(s.host_id),
  };
  const pre = closeRefusal(s, facts);
  if (pre) return { refused: pre };
  const local = (s.host_id || LOCAL_HOST_ID) === LOCAL_HOST_ID;
  const strands = await (deps.strands ?? (local ? treeStrands : (x: Session) => remoteTreeStrands(x)))(s).catch((e) => `could not read its tree: ${String(e?.message ?? e).slice(0, 120)}`);
  if (strands) return { refused: strands };
  try {
    if (!s.goal_done_at) tickAllGoals(id);
  } catch {}
  const who = by === "robert" ? "Robert" : "you";
  (deps.kill ?? killSession)(id, `closed by ${who} — goal met: ${clip(why, 200)}`);
  console.log(`[auto-close] ${id.slice(0, 8)} closed by ${by}: ${clip(why, 100)}`);
  return { closed: true };
}
