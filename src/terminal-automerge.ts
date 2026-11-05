/**
 * The PRs Desk terminals open: tracked in every workspace, auto-merged in the ones that ask for it
 * (`workspaces.auto_merge_prs`).
 *
 * Tickets are retired, so delivery.ts's ticket poll never sees a Desk terminal's PR — the terminal
 * just runs `gh pr create`. This module is the replacement:
 *
 *   harvest — PR URLs a terminal produced (its Focus feed, or what the Desk read off its screen via
 *             /sessions/:id/artifacts) land in `session_prs`, first sighting wins.
 *   poll    — every open row: `gh pr view`; merged/closed → done. In an auto-merge workspace CI green →
 *             `gh pr merge --squash`. Everywhere else the poll only records what it read (CI, review,
 *             draft, title): a green PR whose terminal has closed is src/ship-loop.ts's to offer.
 *
 * "Opened by this terminal" is enforced, not assumed: a feed also carries PRs the agent merely quoted,
 * so a row only stays open when the PR's author is the workspace's own gh account AND it was created
 * after the terminal started. Anything else is marked `skipped` with the reason — in every workspace,
 * because the ship loop must not offer a teammate's PR either.
 *
 * Never merges: drafts, red or pending CI, repos with no CI at all (null rollup = nobody checked it).
 * Outside auto-merge workspaces a repo with no CI is not given up on: `no_ci` marks it, and the ship
 * loop asks the operator, which is exactly what "merge by hand" meant.
 * `gh` is injectable so tests never shell out (CLAUDE.md).
 */
import fs from "node:fs";
import os from "node:os";
import { execFileTimed } from "./exec.js";
import { childEnv, ghReadEnv } from "./child-env.js";
import { ciRollup, isPrUrl } from "./delivery.js";
import { artifactsFromFeed } from "./session-artifacts.js";
import { prBelongsTo } from "./pr-ownership.js";
import { repos, sessions, sessionPrs, workspaces } from "./store.js";
import { notifyInfo } from "./telegram/api.js";
import type { FocusEvent } from "./focus.js";
import type { Session, Workspace } from "./types.js";

export type GhFn = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

const realGh: GhFn = async (args, cwd, env) =>
  (await execFileTimed("gh", args, { cwd, env, encoding: "utf8", timeout: 30_000 })).stdout.trim();

let gh: GhFn = realGh;
/** Swap the gh shell-out for tests. Pass null to restore. */
export function setGh(fn: GhFn | null): void {
  gh = fn ?? realGh;
  viewers.clear();
}

// A PR with no checks yet may just be CI that has not registered — wait this long before deciding
// the repo has no CI and giving up on it.
const NO_CI_GRACE_MS = 10 * 60_000;
// A row only tracked (not auto-merged) has nobody waiting on it by the second: re-read it this often.
// Auto-merge rows keep the ciPollSec cadence they always had.
const TRACK_POLL_MS = 5 * 60_000;
// gh calls per pass, whatever the backlog: the oldest-polled rows go first, the rest next pass.
const MAX_VIEWS = 20;
// Ended terminals are harvested once, for this long after they end (their feed is a transcript read).
const ENDED_HARVEST_MS = 2 * 60 * 60_000;
// A PR may be created a little before the session row's timestamp settles (clock skew, resume).
const CREATED_SLACK_MS = 60_000;

const viewers = new Map<string, string | null>();
async function viewerLogin(ws: Workspace, cwd: string): Promise<string | null> {
  if (viewers.has(ws.id)) return viewers.get(ws.id)!;
  let login: string | null = null;
  try {
    login = (await gh(["api", "user", "--jq", ".login"], cwd, childEnv(ws))).trim() || null;
  } catch {
    return null; // not cached: gh may just be offline this tick
  }
  viewers.set(ws.id, login);
  return login;
}

function sessionCwd(s: Session): string {
  const repo = s.repo_id ? repos.get(s.repo_id) : undefined;
  for (const d of [s.worktree_path, repo?.path, s.cwd]) if (d && fs.existsSync(d)) return d;
  return os.homedir(); // `gh pr view <url>` needs no checkout; any dir works
}

/** Record PR URLs a terminal produced (any live workspace; an archived one is left alone). */
export function recordSessionPrs(s: Session, urls: string[]): number {
  if (!s.workspace_id) return 0;
  const ws = workspaces.get(s.workspace_id);
  if (!ws || ws.archived) return 0;
  const cwd = sessionCwd(s);
  let n = 0;
  for (const url of urls) {
    // The wall (pr-ownership.ts): a PR this terminal only QUOTED from another workspace's repo is
    // never tracked here — not offered, not merged, not shown as this workspace's.
    if (isPrUrl(url) && !prBelongsTo(ws.id, url).ok) {
      noteForeign(ws.id, url);
      continue;
    }
    if (isPrUrl(url) && sessionPrs.record({ url, session_id: s.id, workspace_id: ws.id, cwd })) n++;
  }
  return n;
}

const harvestedEnded = new Set<string>();
const foreignSeen = new Set<string>();
function noteForeign(wsId: string, url: string): void {
  const k = `${wsId}|${url}`;
  if (foreignSeen.has(k)) return;
  foreignSeen.add(k);
  console.log(`[automerge] not tracked in ${wsId.slice(0, 8)}: ${url} — ${prBelongsTo(wsId, url).why}`);
}

/** Sweep live (and just-ended) terminals of every workspace for PR links in their feed. */
export function harvestSessionPrs(eventsOf: (id: string) => FocusEvent[], nowMs = Date.now()): number {
  let n = 0;
  for (const ws of workspaces.list()) {
    if (ws.archived) continue;
    for (const s of sessions.list({ workspace_id: ws.id, limit: 50 })) {
      if (s.status !== "live") {
        const ended = s.ended_at ? Date.parse(s.ended_at) : 0;
        if (!ended || nowMs - ended > ENDED_HARVEST_MS || harvestedEnded.has(s.id)) continue;
        harvestedEnded.add(s.id);
      }
      const { prs } = artifactsFromFeed(eventsOf(s.id));
      n += recordSessionPrs(s, prs.map((p) => p.url));
    }
  }
  return n;
}

type PrView = {
  state?: string;
  isDraft?: boolean;
  author?: { login?: string };
  createdAt?: string;
  statusCheckRollup?: any[];
  reviewDecision?: string | null;
  mergeable?: string | null;
  title?: string | null;
};

const failAlerted = new Set<string>();

/**
 * Poll the open rows once, least recently polled first: record what each PR is now, and in an
 * auto-merge workspace merge the green ones. Returns the URLs merged this pass.
 */
export async function pollSessionPrs(nowMs = Date.now()): Promise<string[]> {
  const merged: string[] = [];
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let views = 0;
  for (const row of sessionPrs.open(MAX_VIEWS * 3)) {
    if (views >= MAX_VIEWS) break;
    const ws = workspaces.get(row.workspace_id);
    if (!ws) continue;
    const auto = !!ws.auto_merge_prs;
    const owned = prBelongsTo(ws.id, row.url);
    if (!owned.ok) {
      sessionPrs.update(row.url, { state: "skipped", skip_reason: `not this workspace's: ${owned.why}` });
      continue;
    }
    if (!auto && (ws.archived || nowMs - Date.parse(row.updated_at) < TRACK_POLL_MS)) continue;
    views++;
    const cwd = fs.existsSync(row.cwd) ? row.cwd : os.homedir();
    const env = childEnv(ws); // the merge: the workspace's own credential
    const readEnv = ghReadEnv(ws); // the look (state + CI): see child-env.ts ghReadEnv

    let v: PrView;
    try {
      v = JSON.parse(await gh(["pr", "view", row.url, "--json", "state,isDraft,author,createdAt,statusCheckRollup,reviewDecision,mergeable,title"], cwd, readEnv));
    } catch (e: any) {
      sessionPrs.touch(row.url); // to the back of the line, so one broken PR cannot hold up the rest
      const k = `${row.url}:${day}:view`;
      if (!failAlerted.has(k)) {
        failAlerted.add(k);
        console.warn(`[automerge] gh pr view failed for ${row.url}: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
      }
      continue;
    }

    const state = String(v.state ?? "").toUpperCase();
    if (state === "MERGED" || state === "CLOSED") {
      sessionPrs.update(row.url, { state: state === "MERGED" ? "merged" : "closed" });
      continue;
    }
    if (state !== "OPEN") { sessionPrs.touch(row.url); continue; }

    const viewer = await viewerLogin(ws, cwd);
    if (!viewer) { sessionPrs.touch(row.url); continue; }
    if (v.author?.login !== viewer) {
      sessionPrs.update(row.url, { state: "skipped", skip_reason: `author ${v.author?.login ?? "?"} is not ${viewer}` });
      continue;
    }
    const s = sessions.get(row.session_id);
    const created = v.createdAt ? Date.parse(v.createdAt) : NaN;
    if (s && Number.isFinite(created) && created < Date.parse(s.created_at) - CREATED_SLACK_MS) {
      sessionPrs.update(row.url, { state: "skipped", skip_reason: "PR predates the terminal — quoted, not opened" });
      continue;
    }

    const ci = ciRollup(v.statusCheckRollup);
    const graceOver = Number.isFinite(created) && nowMs - created > NO_CI_GRACE_MS;
    // Every poll writes, so updated_at moves and the next pass starts with somebody else.
    sessionPrs.update(row.url, {
      ci_state: ci,
      title: v.title ? String(v.title).slice(0, 300) : row.title,
      review_decision: v.reviewDecision ? String(v.reviewDecision) : null,
      mergeable: v.mergeable ? String(v.mergeable) : null,
      draft: v.isDraft ? 1 : 0,
      no_ci: ci === null && graceOver ? 1 : 0,
    });
    if (!auto) continue; // tracked only: the ship loop decides what reaches the operator

    if (ci === null) {
      if (graceOver) sessionPrs.update(row.url, { state: "skipped", skip_reason: "repo has no CI — merge by hand" });
      continue;
    }
    if (ci !== "passing" || v.isDraft) continue;

    try {
      await gh(["pr", "merge", row.url, "--squash"], cwd, env);
      sessionPrs.update(row.url, { state: "merged", merge_error: null });
      merged.push(row.url);
      await notifyInfo(`✅ auto-merged ${row.url} (${ws.name}, CI green)`).catch(() => {});
    } catch (e: any) {
      const msg = String(e?.stderr ?? e?.message ?? e).trim();
      sessionPrs.update(row.url, { merge_error: msg.slice(0, 500) });
      const k = `${row.url}:${day}:merge`;
      if (!failAlerted.has(k)) {
        failAlerted.add(k);
        console.warn(`[automerge] gh pr merge failed for ${row.url}: ${msg}`);
      }
    }
  }
  return merged;
}
