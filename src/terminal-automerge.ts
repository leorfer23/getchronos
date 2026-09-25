/**
 * Auto-merge for PRs a Desk terminal opened, per workspace (`workspaces.auto_merge_prs`).
 *
 * Tickets are retired, so delivery.ts's ticket poll never sees a Desk terminal's PR — the terminal
 * just runs `gh pr create`. This module is the replacement:
 *
 *   harvest — PR URLs a terminal produced (its Focus feed, or what the Desk read off its screen via
 *             /sessions/:id/artifacts) land in `session_prs`, first sighting wins.
 *   poll    — every open row: `gh pr view`; CI green → `gh pr merge --squash`; merged/closed → done.
 *
 * "Opened by this terminal" is enforced, not assumed: a feed also carries PRs the agent merely quoted,
 * so a row is only ever merged when the PR's author is the workspace's own gh account AND it was
 * created after the terminal started. Anything else is marked `skipped` with the reason.
 *
 * Never merges: drafts, red or pending CI, repos with no CI at all (null rollup = nobody checked it).
 * `gh` is injectable so tests never shell out (CLAUDE.md).
 */
import fs from "node:fs";
import os from "node:os";
import { execFileTimed } from "./exec.js";
import { childEnv } from "./child-env.js";
import { ciRollup, isPrUrl } from "./delivery.js";
import { artifactsFromFeed } from "./session-artifacts.js";
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

/** Record PR URLs a terminal produced. No-op unless its workspace has auto-merge on. */
export function recordSessionPrs(s: Session, urls: string[]): number {
  if (!s.workspace_id) return 0;
  const ws = workspaces.get(s.workspace_id);
  if (!ws?.auto_merge_prs) return 0;
  const cwd = sessionCwd(s);
  let n = 0;
  for (const url of urls) {
    if (isPrUrl(url) && sessionPrs.record({ url, session_id: s.id, workspace_id: ws.id, cwd })) n++;
  }
  return n;
}

const harvestedEnded = new Set<string>();

/** Sweep live (and just-ended) terminals of auto-merge workspaces for PR links in their feed. */
export function harvestSessionPrs(eventsOf: (id: string) => FocusEvent[], nowMs = Date.now()): number {
  let n = 0;
  for (const ws of workspaces.list()) {
    if (!ws.auto_merge_prs || ws.archived) continue;
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
};

const failAlerted = new Set<string>();

/** Poll every open row once; merge the green ones. Returns the URLs merged this pass. */
export async function pollSessionPrs(nowMs = Date.now()): Promise<string[]> {
  const merged: string[] = [];
  const day = new Date(nowMs).toISOString().slice(0, 10);
  for (const row of sessionPrs.open()) {
    const ws = workspaces.get(row.workspace_id);
    if (!ws?.auto_merge_prs) continue; // flag turned off: leave the row, merge nothing
    const cwd = fs.existsSync(row.cwd) ? row.cwd : os.homedir();
    const env = childEnv(ws);

    let v: PrView;
    try {
      v = JSON.parse(await gh(["pr", "view", row.url, "--json", "state,isDraft,author,createdAt,statusCheckRollup"], cwd, env));
    } catch (e: any) {
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
    if (state !== "OPEN") continue;

    const viewer = await viewerLogin(ws, cwd);
    if (!viewer) continue;
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
    if (ci !== row.ci_state) sessionPrs.update(row.url, { ci_state: ci });
    if (ci === null) {
      if (Number.isFinite(created) && nowMs - created > NO_CI_GRACE_MS) {
        sessionPrs.update(row.url, { state: "skipped", skip_reason: "repo has no CI — merge by hand" });
      }
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
