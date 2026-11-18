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
 *    a computer that is offline, a cloud terminal, a Lead with live workers, work it parked to pick
 *    back up (`mc when`), and — for Robert — a conversation the operator is still having with it.
 *
 * The operator, 2026-11-18, turning it on for every workspace: Robert must judge "whether closing makes
 * sense", not only whether the goal box is ticked. The judgment is Robert's (the wake, robert-drive.ts);
 * the facts the daemon already holds are guards here, so a wrong judgment still cannot lose anything.
 *
 * A hand-off's merge/deploy ask is met when the PR shipped from ANOTHER terminal of the same workspace
 * (shippedElsewhere): that day a terminal's PR was merged and deployed by the Ship terminal, its own
 * card kept asking "merge + deploy", and it could never be closed.
 */
import { closesWhenDone } from "./robert-command.js";
import { asks, continuations, sessionPrs, sessions } from "./store.js";
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
  /** Its hand-off's PRs, shipped from elsewhere in this workspace (shippedElsewhere). Absent = nothing known. */
  elsewhere?: Elsewhere;
  /** The label of work it parked to pick back up (`mc when`, armed or met), or null. */
  parked?: string | null;
  /**
   * When the operator last typed into it (sessions.operator_last_in), for a close ROBERT asks for —
   * null when the operator himself is closing it: his own close is his call.
   */
  operatorLastInMs?: number | null;
  /** Now, for the operator-talking window. */
  nowMs?: number;
};

/**
 * The operator typed into it this recently, after its last hand-off → he is still talking to it, and
 * Robert leaves it open. Longer than robert-drive's OPERATOR_OWNS_MS (3 min, "don't type over him"):
 * closing ends the conversation, typing only interrupts it.
 */
export const OPERATOR_TALKING_MS = 30 * 60_000;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** What another terminal of the same workspace already did with this hand-off's PRs. */
export type Elsewhere = { merged: boolean; deployed: boolean; by: string | null };
const NOTHING: Elsewhere = { merged: false, deployed: false, by: null };

/**
 * A hand-off that still wants something from the operator, as the reason — or null. `elsewhere` is what
 * the rest of the workspace did with its PRs: a merge or deploy it asked for that already happened
 * there is not still wanted from him.
 */
export function handoffWants(o: Outcome | null | undefined, elsewhere: Elsewhere = NOTHING): string | null {
  if (!o) return null;
  const want = o.ask ?? "none";
  const done = (o.shipped ?? []).join(" ").toLowerCase();
  if (want === "review") return "its hand-off asks the operator to review it";
  if (want.includes("merge") && !/\bmerg/.test(done) && !elsewhere.merged) return `its hand-off asks the operator to ${want}`;
  if (want.includes("deploy") && !/\bdeploy/.test(done) && !elsewhere.deployed)
    return elsewhere.merged
      ? `its PR is merged${elsewhere.by ? ` (${elsewhere.by})` : ""}, but its hand-off still asks for the deploy and nothing in this workspace says it shipped`
      : `its hand-off asks the operator to ${want}`;
  const line = waitsOnOperator([o.summary, ...(o.changes ?? [])]);
  return line ? `its hand-off still waits on the operator: “${clip(line, 120)}”` : null;
}

const prKey = (u: string) => String(u ?? "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * Its hand-off's PRs, shipped from another terminal of the SAME workspace — the rest of the workspace
 * only, ever (store sessions.citingPr is keyed by workspace_id, and the PR row must be this workspace's).
 *  - merged: every PR is merged by GitHub's word (session_prs, polled with the operator's read login) or
 *    another hand-off here says it merged it.
 *  - deployed: another hand-off here that names the same PR says it deployed it. GitHub cannot say that.
 * Pure over the two reads, which are injected for tests.
 */
export function shippedElsewhere(
  s: Pick<Session, "id" | "workspace_id" | "outcome">,
  reads: {
    prState?: (url: string) => { state: string; workspace_id: string } | undefined;
    citing?: (ws: string, url: string) => Pick<Session, "id" | "workspace_id" | "outcome" | "outcome_prev">[];
  } = {},
): Elsewhere {
  const ws = s.workspace_id;
  const prs = (s.outcome?.prs ?? []).map((u) => String(u ?? "").trim().replace(/\/+$/, "")).filter(Boolean);
  if (!ws || !prs.length) return NOTHING;
  const prState = reads.prState ?? ((u: string) => sessionPrs.get(u));
  const citing = reads.citing ?? ((w: string, u: string) => sessions.citingPr(w, u));
  let merged = true;
  let deployed = true;
  const by = new Set<string>();
  for (const url of prs) {
    const key = prKey(url);
    const row = prState(url);
    let m = !!row && row.state === "merged" && row.workspace_id === ws;
    let d = false;
    for (const other of citing(ws, url)) {
      if (other.id === s.id || other.workspace_id !== ws) continue;
      for (const o of [other.outcome, ...(other.outcome_prev ?? [])] as (Outcome | null)[]) {
        if (!o || !(o.prs ?? []).some((u) => prKey(u) === key)) continue;
        const shipped = (o.shipped ?? []).join(" ").toLowerCase();
        if (/\bmerg/.test(shipped)) { m = true; by.add(other.id.slice(0, 8)); }
        if (/\bdeploy/.test(shipped)) { d = true; by.add(other.id.slice(0, 8)); }
      }
    }
    merged &&= m;
    deployed &&= d;
  }
  return { merged, deployed, by: by.size ? `by terminal ${[...by].join(", ")}` : merged ? "on GitHub" : null };
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
  if (f.parked) return `it parked work to pick back up (\`mc when\`: ${clip(f.parked, 80)}) — not done until that fires or is cancelled`;
  // He typed into it after its last hand-off: whatever it said since, the conversation is his and open.
  const said = Date.parse(s.outcome?.at ?? "") || 0;
  const now = f.nowMs ?? Date.now();
  if (f.operatorLastInMs != null && f.operatorLastInMs > said && now - f.operatorLastInMs < OPERATOR_TALKING_MS)
    return `the operator was talking to it ${Math.max(1, Math.round((now - f.operatorLastInMs) / 60_000))} min ago, after its last hand-off — his conversation, leave it open`;
  return handoffWants(s.outcome, f.elsewhere);
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
  const parked = continuations.list({ session_id: id, status: ["armed", "met"], limit: 1 })[0];
  const facts: CloseFacts = {
    live: act.live,
    quiet: act.quiet,
    phase: status(id)?.phase ?? null,
    openAsks: asks.openForSession(id).length,
    liveWorkers: s.role === "lead" ? sessions.workersOf(id, { status: "live" }).length : 0,
    hostOnline: (deps.hostOnline ?? hostOnline)(s.host_id),
    elsewhere: shippedElsewhere(s),
    parked: parked ? parked.label || parked.kind : null,
    operatorLastInMs: by === "robert" ? Date.parse(s.operator_last_in ?? "") || null : null,
    nowMs: Date.now(),
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
