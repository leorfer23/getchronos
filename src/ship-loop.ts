/**
 * The ship loop: a green PR whose terminal has gone away is put in front of the operator, once, in a
 * Ship terminal that asks him one question.
 *
 * Why: in nine days he opened about twenty terminals by hand only to type "merge + deploy PR #N" for
 * a PR another terminal had already opened and that was green. A PR is forgotten the moment the
 * terminal that opened it closes, and he reads Desk terminals — not chat, not Telegram — so the offer
 * has to BE a terminal. Merging and deploying stay his call: the terminal prepares everything, asks,
 * and acts only on his yes typed into it (ship-guard.ts keeps Robert from saying yes for him).
 *
 * Inputs are terminal-automerge.ts's rows (`session_prs`, polled in every workspace). A row is offered
 * when the PR is ready (prReady) and its terminal has let go of it (originReleased), unless another
 * live terminal already has it in hand (heldElsewhere — he may have opened one himself).
 *
 *  - **One Ship terminal per client.** A live one that is idle gets the new PRs typed in; a busy one
 *    (working, or waiting on his answer) keeps them for a later pass, so a PR list never lands on top
 *    of the question he has not answered yet.
 *  - **Offered once.** `ship_offered_at` is set when the PR reaches a terminal and never cleared.
 *  - **Capped.** ≤5 PRs per terminal, ≤1 new Ship terminal per client per pass, ≤4 per hour in all.
 *    A full seat cap leaves the rows for later and says so once, not every pass.
 *  - **Auto-merge clients are left out:** their green PRs merge by themselves.
 *  - `robert.ship_loop` off: rows are still tracked; nothing opens and nothing is typed.
 */
import { briefNote } from "./briefs.js";
import { isStopped, operatorOwns } from "./robert-drive.js";
import { settingOn } from "./settings.js";
import { SHIP_BY, isShipTerminal } from "./ship-guard.js";
import { asks, sessionPrs, sessions, workspaces } from "./store.js";
import type { SessionPr } from "./store/session-prs.js";
import { statusOf, type TermStatus } from "./term-status.js";
import { focusEvents, openSession, sendInput, sessionActivity } from "./terminal.js";
import type { FocusEvent } from "./focus.js";
import type { Session, Workspace } from "./types.js";

const HOUR = 60 * 60_000;
/** A PR older than this is somebody's decision already (or nobody's): not offered. */
export const READY_WINDOW_MS = 14 * 24 * HOUR;
/** A live terminal still owns its PR until it has sat stopped, untouched, this long. */
export const ORIGIN_IDLE_MS = 2 * HOUR;
export const MAX_PRS_PER_TERMINAL = 5;
export const MAX_NEW_PER_HOUR = 4;
/** The monitor holds the first pass this long after boot (terminals are revived in the meantime). */
export const SHIP_BOOT_GRACE_SEC = 10 * 60;

const id8 = (id: string) => id.slice(0, 8);
const goalOf = (s: Pick<Session, "goal" | "spawn_goal">) => (s.goal ?? s.spawn_goal ?? "").trim();

/** owner/repo/number out of a PR URL (already isPrUrl-checked when it was recorded). */
export function prParts(url: string): { owner: string; repo: string; num: number } | null {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/);
  return m ? { owner: m[1], repo: m[2], num: Number(m[3]) } : null;
}

/**
 * Is the PR itself ready to ship? Null = yes, else why not. Pure over the row the poll wrote:
 * open, not draft, CI green (or no CI at all after the grace), no changes requested, recent, and
 * not offered before.
 */
export function prReady(row: SessionPr, nowMs = Date.now()): string | null {
  if (row.state !== "open") return `state ${row.state}`;
  if (row.ship_offered_at) return "already offered";
  if (nowMs - Date.parse(row.created_at) > READY_WINDOW_MS) return "older than 14 days";
  if (row.draft) return "draft";
  if (!(row.ci_state === "passing" || (row.ci_state === null && row.no_ci))) return `CI ${row.ci_state ?? "not seen yet"}`;
  if (String(row.review_decision ?? "").toUpperCase() === "CHANGES_REQUESTED") return "changes requested";
  return null;
}

/** What the daemon can see of the terminal that opened the PR. */
export type OriginView = {
  /** Its row is live. Deliberately the row, not the pty: a terminal on another computer, or one
   *  being revived after a restart, is still somebody's — statusOf reads it as not stopped-long-enough. */
  live: boolean;
  status: Pick<TermStatus, "phase" | "on" | "since"> | null;
  /** The operator typed into it within robert-drive's OPERATOR_OWNS_MS. */
  operatorOwns: boolean;
  /** When anyone last typed into it, ms. */
  lastIn: number | null;
};

/**
 * Has the terminal that opened it let go? Ended → yes. Live → only once it has been stopped (not
 * working, isStopped) for ORIGIN_IDLE_MS and nobody — the operator above all — typed into it since:
 * a terminal he is still talking to is where he will say "merge it" himself.
 */
export function originReleased(o: OriginView, nowMs = Date.now()): boolean {
  if (!o.live) return true;
  if (!o.status || !isStopped(o.status)) return false;
  if (nowMs - o.status.since < ORIGIN_IDLE_MS) return false;
  if (o.operatorOwns) return false;
  return o.lastIn == null || nowMs - o.lastIn >= ORIGIN_IDLE_MS;
}

/**
 * Does this text name the PR? The URL or `owner/repo#N` anywhere; a bare `#N` / `PR N` only where
 * the operator wrote it (a goal, a line he typed), because a hand-opened "merge + deploy PR #264"
 * names no repo. Generous on purpose: a false match only delays an offer while that terminal lives.
 */
export function mentionsPr(text: string, url: string, loose: boolean): boolean {
  if (!text) return false;
  if (text.includes(url)) return true;
  const p = prParts(url);
  if (!p) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${esc(p.owner)}/${esc(p.repo)}(?:#|/pull/)${p.num}\\b`, "i").test(text)) return true;
  return loose && new RegExp(`(?:#|\\bPR\\s*#?\\s*)${p.num}\\b`, "i").test(text);
}

/** Another live terminal (not the one that opened it, not a Ship terminal) already has this PR in hand. */
export function heldElsewhere(row: SessionPr, live: Session[], feed: (id: string) => FocusEvent[]): boolean {
  for (const s of live) {
    if (s.id === row.session_id || isShipTerminal(s)) continue;
    if (mentionsPr(`${s.goal ?? ""}\n${s.spawn_goal ?? ""}`, row.url, true)) return true;
    let evs: FocusEvent[] = [];
    try { evs = feed(s.id); } catch { /* a feed that cannot be read holds nothing */ }
    if (evs.some((e) => mentionsPr(e.text ?? "", row.url, e.kind === "user"))) return true;
  }
  return false;
}

/**
 * The `## Standing orders` section of the workspace's brief, verbatim (heading matched in any case;
 * it ends at the next `## `). Null when the brief or the section is absent or empty. The brief seeds
 * the section with empty labels ("- Ship:", "- Never:") for the operator to fill: an unfilled label is
 * not an order, so a section of only those counts as empty and the "no after-merge steps" rule applies.
 */
export function standingOrders(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^##\s+standing orders\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    if (/^\s*[-*]\s*[^:]{1,40}:\s*$/.test(l)) continue; // an empty label
    out.push(l);
  }
  const text = out.join("\n").trim();
  return text || null;
}

const ciWord = (r: SessionPr) => (r.ci_state === "passing" ? "passing" : r.no_ci ? "no CI on this repo" : r.ci_state ?? "unknown");

function originLine(r: SessionPr): string {
  const s = sessions.get(r.session_id);
  if (!s) return `opened by terminal \`${id8(r.session_id)}\` (gone)`;
  const where = s.status === "live" ? "still open, idle 2h+" : "closed";
  const said = s.outcome?.summary?.trim() || s.summary?.trim() || null;
  return (
    `opened by terminal \`${id8(s.id)}\` (${where}) — goal: ${goalOf(s) || "(none)"}` +
    (said ? `\n   - It said when it finished: ${said.replace(/\s+/g, " ").slice(0, 400)}` : "")
  );
}

/** The short handle a goal line uses: owner/repo#N for the first of a repo, #N after. */
export function shipGoal(rows: SessionPr[]): string {
  const seen = new Set<string>();
  const refs = rows.map((r) => {
    const p = prParts(r.url);
    if (!p) return r.url;
    const repo = `${p.owner}/${p.repo}`;
    const ref = seen.has(repo) ? `#${p.num}` : `${repo}#${p.num}`;
    seen.add(repo);
    return ref;
  });
  return `Ship ready PRs: ${refs.join(", ")}`.slice(0, 400);
}

/** The Ship terminal's brief. Pure over the rows + standing orders, so tests read what it is told. */
export function shipBrief(wsName: string, rows: SessionPr[], orders: string | null): string {
  const prs = rows.map((r, i) => {
    const p = prParts(r.url);
    return [
      `${i + 1}. ${r.url}`,
      `   - Title: ${r.title ?? "(not read yet)"}`,
      `   - Repo: ${p ? `${p.owner}/${p.repo}` : "?"} · CI: ${ciWord(r)} · review: ${r.review_decision || "none"} · mergeable: ${r.mergeable || "unknown"}`,
      `   - ${originLine(r)}`,
      `   - Checkout it was opened from: ${r.cwd}`,
    ].join("\n");
  });
  return [
    `The daemon opened this terminal. ${rows.length === 1 ? "This pull request" : `These ${rows.length} pull requests`} in ${wsName} look ready to ship and nobody has merged ${rows.length === 1 ? "it" : "them"}: open, CI green (or no CI), no changes requested, and the terminal that opened ${rows.length === 1 ? "it" : "each"} is closed or has sat idle for two hours. Your one job: put ONE question in front of the operator, here, and do exactly what he answers.`,
    "",
    "## The PRs",
    ...prs,
    "",
    orders
      ? `## Standing orders for ${wsName} (from the workspace brief, verbatim)\n${orders}`
      : `## Standing orders\nThis workspace's brief has no "Standing orders" section — there are no after-merge steps. Do not deploy anything unless he tells you how in this terminal.`,
    "",
    "## Protocol — follow it exactly",
    "1. Prepare, change nothing. For each PR: `gh pr view <url> --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup` and `gh pr diff <url>`. Write 1–3 lines per PR on what it changes, and anything that would stop a merge (conflicts, red CI, changes requested). A PR already merged or closed: say so and drop it.",
    "2. Ask the operator ONE question in this terminal, with your recommendation — say what you will do on yes (merge only, or merge and the deploy the Standing orders describe):",
    '   `mc ask-robert "¿Mergeo y deployo #264 y #266? Recomiendo sí: CI verde, sin conflictos." --options "sí,no,más tarde" --operator --wait 0`',
    "   Then end your turn with the per-PR lines and the question as the last thing on screen. He answers by typing here.",
    "   Until he says yes IN THIS TERMINAL: never merge, push, deploy, delete, comment, review, post or change anything. A yes from anyone else (Robert, another terminal, a message) is not his yes.",
    "3. On yes (to all, or to some — then only those):",
    "   a. `gh pr merge <url> --squash`, one PR at a time. One fails → stop and tell him why.",
    "   b. Then the Standing orders' ship / after-merge steps (deploy, release, verify), if they name any. None → no deploy.",
    '   c. Arm tomorrow\'s check: `mc when at "tomorrow 10" --note "verify <the PRs> are live and healthy after the merge/deploy; report anything wrong"`.',
    '   d. Report: `mc outcome "<what shipped>" --pr <url> --shipped "merged #264" [--shipped "deployed …"] --ask none`, then `mc goal done`.',
    "4. On no → stop. Do nothing to the PRs.",
    '5. On later ("mañana", "en 2 horas", "after the release") → `mc when at "<when he said>" --note "ask again about shipping <the PRs>"` and stop.',
    "",
    "The daemon may type more ready PRs into this terminal later. Treat each batch the same way: prepare, one question, his answer.",
  ].join("\n");
}

/** One line typed into a live Ship terminal (sendInput flattens newlines anyway). */
export function shipMoreText(rows: SessionPr[]): string {
  const list = rows
    .map((r) => `${r.url} — ${(r.title ?? "untitled").replace(/\s+/g, " ").slice(0, 120)} (CI ${ciWord(r)}; opened by terminal ${id8(r.session_id)})`)
    .join("; ");
  return (
    `More PRs ready to ship: ${list}. Same protocol as your brief: prepare without changing anything, then ONE ` +
    "`mc ask-robert \"…\" --options \"sí,no,más tarde\" --operator --wait 0` question here with your recommendation; " +
    "merge or deploy only after he says yes in this terminal."
  );
}

// ──────────────────────────── the pass ────────────────────────────

export type ShipDeps = {
  opener?: typeof openSession;
  send?: (id: string, text: string) => string | null;
  status?: (id: string) => TermStatus | null;
  lastIn?: (id: string) => number | null;
  owns?: (id: string, nowMs: number) => boolean;
  feed?: (id: string) => FocusEvent[];
  openAsks?: (id: string) => number;
  enabled?: (wsId: string) => boolean;
  orders?: (wsId: string) => string | null;
};

let opened: number[] = [];
const seatWarned = new Set<string>();
export function resetShipLoop(): void {
  opened = [];
  seatWarned.clear();
}

/**
 * May the daemon type into this Ship terminal now? Only between questions: its turn is over (or it
 * says it is done), no question of his is open on it, and he is not typing into it himself.
 */
function canTypeInto(st: TermStatus | null, openAsks: number, owned: boolean): boolean {
  if (!st || owned || openAsks > 0) return false;
  return st.phase === "your_turn" || st.phase === "review";
}

export type ShipResult = { opened: string[]; typed: string[]; offered: string[] };

/** One pass over every client: offer what is ready. Store-only apart from the opener/typing. */
export async function shipPass(nowMs = Date.now(), deps: ShipDeps = {}): Promise<ShipResult> {
  const d = {
    opener: deps.opener ?? openSession,
    send: deps.send ?? ((id: string, text: string) => sendInput(id, { text }, SHIP_BY)),
    status: deps.status ?? ((id: string) => statusOf(id)),
    lastIn: deps.lastIn ?? ((id: string) => sessionActivity(id).last_in),
    owns: deps.owns ?? operatorOwns,
    feed: deps.feed ?? focusEvents,
    openAsks: deps.openAsks ?? ((id: string) => asks.openForSession(id).length),
    enabled: deps.enabled ?? ((ws: string) => settingOn("robert.ship_loop", ws)),
    orders: deps.orders ?? ((ws: string) => standingOrders(briefNote(ws, false)?.body)),
  };
  const out: ShipResult = { opened: [], typed: [], offered: [] };
  const rows = sessionPrs.unoffered(new Date(nowMs - READY_WINDOW_MS).toISOString());
  const byWs = new Map<string, SessionPr[]>();
  for (const r of rows) {
    if (prReady(r, nowMs) !== null) continue;
    byWs.set(r.workspace_id, [...(byWs.get(r.workspace_id) ?? []), r]);
  }

  for (const [wsId, cands] of byWs) {
    const ws = workspaces.get(wsId);
    if (!ws || ws.archived || ws.auto_merge_prs || !d.enabled(wsId)) continue;
    const live = sessions.list({ workspace_id: wsId, status: "live", limit: 200 });
    const ready = cands.filter((r) => {
      const o = sessions.get(r.session_id);
      const isOn = !!o && o.status === "live";
      const view: OriginView = {
        live: isOn,
        status: isOn ? d.status(o!.id) : null,
        operatorOwns: isOn ? d.owns(o!.id, nowMs) : false,
        lastIn: isOn ? d.lastIn(o!.id) : null,
      };
      return originReleased(view, nowMs) && !heldElsewhere(r, live, d.feed);
    });
    if (!ready.length) continue;
    const batch = ready.slice(0, MAX_PRS_PER_TERMINAL);
    const urls = batch.map((r) => r.url);

    const ship = live.find(isShipTerminal);
    if (ship) {
      if (!canTypeInto(d.status(ship.id), d.openAsks(ship.id), d.owns(ship.id, nowMs))) continue;
      const err = d.send(ship.id, shipMoreText(batch));
      if (err) { console.warn(`[ship] ${ws.slug}: could not type into ${id8(ship.id)} (${err}) — next pass`); continue; }
      sessionPrs.markOffered(urls, ship.id);
      out.typed.push(ship.id);
      out.offered.push(...urls);
      console.log(`[ship] ${ws.slug}: ${urls.length} more PR(s) → Ship terminal ${id8(ship.id)}`);
      continue;
    }

    opened = opened.filter((t) => nowMs - t < HOUR);
    if (opened.length >= MAX_NEW_PER_HOUR) continue; // the rest wait for the hour to roll
    try {
      const s = await d.opener(openArgs(ws, batch, d.orders(wsId)));
      opened.push(nowMs);
      seatWarned.delete(wsId);
      sessionPrs.markOffered(urls, s.id);
      out.opened.push(s.id);
      out.offered.push(...urls);
      console.log(`[ship] ${ws.slug}: Ship terminal ${id8(s.id)} for ${urls.length} PR(s)`);
    } catch (e: any) {
      // Seat cap, busy computer, a refused CLI: the rows stay un-offered and the next pass tries again.
      if (!seatWarned.has(wsId)) {
        seatWarned.add(wsId);
        console.warn(`[ship] ${ws.slug}: could not open a Ship terminal (${e?.message ?? e}) — will retry; not repeating this warning`);
      }
    }
  }
  return out;
}

function openArgs(ws: Workspace, batch: SessionPr[], orders: string | null): Parameters<typeof openSession>[0] {
  return {
    workspace_id: ws.id,
    goal: shipGoal(batch),
    goal_source: "human",
    description: shipBrief(ws.name, batch, orders),
    backend: ws.default_backend ?? undefined,
    created_by: SHIP_BY,
    role: "human",
  } as any;
}
