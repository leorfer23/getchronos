/**
 * Whose PR is this? — the workspace wall, applied to pull requests.
 *
 * A terminal's Focus feed carries every PR URL it said, including ones it only quoted. session_prs
 * used to record them all under the terminal's workspace, with one guard: the PR's author must be
 * that workspace's gh account. Several workspaces share the operator's personal account, so a PR
 * from workspace B's repo quoted in a workspace A terminal would have been tracked as A's, offered
 * in A's Ship terminal under A's Standing orders, and listed in A's self-wake. Workspaces never mix
 * (the operator's first rule), so a PR now belongs to a workspace only when its repo does:
 *
 *  1. `owner/repo` is a repo registered to the workspace, or shared into it (repo_shares) → its.
 *  2. `owner/repo` is registered to another workspace and not shared here → never its.
 *  3. Otherwise the OWNER decides, and only when exactly one workspace has repos under it (an org
 *     like a client's own) → that workspace's. An owner several workspaces use (a personal account)
 *     proves nothing: the repo has to be registered.
 *
 * A registered repo with no git_remote recorded is read once from its checkout (`origin`), cached.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { db } from "./store.js";

export type Slug = string; // "owner/repo", lower-case

/** "https://github.com/Acme/App.git" | "git@github.com:acme/app" → "acme/app"; anything else → null. */
export function slugOfRemote(remote: string | null | undefined): Slug | null {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(remote ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function slugOfPr(url: string): Slug | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

type RemoteReader = (path: string) => string | null;
const realReader: RemoteReader = (p) => {
  try {
    if (!p || !fs.existsSync(p)) return null;
    return execFileSync("git", ["-C", p, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};
let readRemote: RemoteReader = realReader;
const remoteCache = new Map<string, string | null>();
/** Tests only. */
export function setRemoteReader(fn: RemoteReader | null): void {
  readRemote = fn ?? realReader;
  remoteCache.clear();
  memo = null;
}

type RepoRow = { id: string; workspace_id: string | null; path: string; git_remote: string | null };

function slugOfRepo(r: RepoRow): Slug | null {
  const direct = slugOfRemote(r.git_remote);
  if (direct) return direct;
  if (!remoteCache.has(r.id)) remoteCache.set(r.id, readRemote(r.path));
  return slugOfRemote(remoteCache.get(r.id));
}

type OwnerMap = { owners: Map<Slug, Set<string>>; shared: Map<Slug, Set<string>>; orgs: Map<string, Set<string>> };
let memo: { at: number; m: OwnerMap } | null = null;
const MEMO_MS = 10_000;

/** Every workspace's repos by slug, plus the shares — rebuilt at most every 10s (a harvest pass asks per URL). */
function map(nowMs = Date.now()): OwnerMap {
  if (memo && nowMs - memo.at < MEMO_MS) return memo.m;
  memo = { at: nowMs, m: build() };
  return memo.m;
}

function build(): OwnerMap {
  const rows = db.prepare("SELECT id, workspace_id, path, git_remote FROM repos").all() as RepoRow[];
  const owners = new Map<Slug, Set<string>>();
  const orgs = new Map<string, Set<string>>();
  const byId = new Map<string, Slug>();
  for (const r of rows) {
    const s = slugOfRepo(r);
    if (!s || !r.workspace_id) continue;
    byId.set(r.id, s);
    (owners.get(s) ?? owners.set(s, new Set()).get(s)!).add(r.workspace_id);
    const org = s.split("/")[0];
    (orgs.get(org) ?? orgs.set(org, new Set()).get(org)!).add(r.workspace_id);
  }
  const shared = new Map<Slug, Set<string>>();
  for (const sh of db.prepare("SELECT repo_id, workspace_id FROM repo_shares").all() as { repo_id: string; workspace_id: string }[]) {
    const s = byId.get(sh.repo_id);
    if (s) (shared.get(s) ?? shared.set(s, new Set()).get(s)!).add(sh.workspace_id);
  }
  return { owners, shared, orgs };
}

/** Does this PR belong to this workspace? `why` says why not (for the skip reason and the log). */
export function prBelongsTo(wsId: string, url: string): { ok: boolean; why: string } {
  const slug = slugOfPr(url);
  if (!slug) return { ok: false, why: "not a GitHub PR URL" };
  const { owners, shared, orgs } = map();
  const own = owners.get(slug);
  if (own?.has(wsId) || shared.get(slug)?.has(wsId)) return { ok: true, why: "registered repo" };
  if (own && own.size) return { ok: false, why: `${slug} belongs to another workspace` };
  const org = orgs.get(slug.split("/")[0]);
  if (org && org.size === 1 && org.has(wsId)) return { ok: true, why: "owner used only by this workspace" };
  return { ok: false, why: `${slug} is not a repo of this workspace` };
}

/** Tests only: forget cached remotes and the owner map. */
export function clearPrOwnershipCache(): void {
  remoteCache.clear();
  memo = null;
}
