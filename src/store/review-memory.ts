/**
 * The independent code review's rows (migration 163): one review per PR head, and each repo's review
 * memory. Both are keyed by workspace first — a workspace's reviews and memory are its own, even when
 * another workspace has a repo with the same name or the same GitHub remote.
 *
 *   code_reviews        one row per (workspace, PR, head SHA): what the reviewer found there, so a head
 *                       is read once (src/code-review.ts says how its findings are judged).
 *   repo_review_memory  one row per (workspace, repo): the rules learned from human review of that
 *                       repo's past PRs — capped, rewritten whole on refresh (src/repo-memory.ts).
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { Finding } from "../code-review.js";

export type CodeReviewRow = {
  id: string;
  workspace_id: string;
  repo_id: string | null;
  pr_url: string;
  head_sha: string;
  /** sha256 of the diff it read: a new head with the same diff (a clean rebase) carries the review over. */
  diff_hash: string | null;
  findings: Finding[];
  /** "<backend> <model>" that read it. */
  engine: string;
  run_id: string | null;
  /** Rules from the repo's review memory it was given. */
  rules: number;
  /** The head whose review this one carries over unread (same diff), else null. */
  carried_from: string | null;
  created_at: string;
};

export type RepoMemoryRow = {
  workspace_id: string;
  repo_id: string;
  /** owner/repo it was read from. */
  slug: string | null;
  rules: string[];
  /** Human review comments folded in, over its life. */
  comments_seen: number;
  /** The newest comment folded in: only comments after it are new. */
  seen_through: string | null;
  /** Last time GitHub was asked for new comments (refresh throttle), and last time the rules were rewritten. */
  checked_at: string | null;
  refreshed_at: string | null;
};

const json = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const reviewRow = (r: any): CodeReviewRow | undefined => (r ? { ...r, findings: json<Finding[]>(r.findings, []) } : undefined);
const memoryRow = (r: any): RepoMemoryRow | undefined => (r ? { ...r, rules: json<string[]>(r.rules, []) } : undefined);

export const codeReviews = {
  get(workspaceId: string, prUrl: string, head: string): CodeReviewRow | undefined {
    return reviewRow(db.prepare("SELECT * FROM code_reviews WHERE workspace_id = ? AND pr_url = ? AND head_sha = ?").get(workspaceId, prUrl, head));
  },
  /** The newest review of this PR in this workspace, whatever its head. */
  latest(workspaceId: string, prUrl: string): CodeReviewRow | undefined {
    return reviewRow(db.prepare("SELECT * FROM code_reviews WHERE workspace_id = ? AND pr_url = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(workspaceId, prUrl));
  },
  /** One review per head: a second write for the same head replaces it. */
  put(r: Omit<CodeReviewRow, "id" | "created_at">): CodeReviewRow {
    db.prepare(
      `INSERT INTO code_reviews (id,workspace_id,repo_id,pr_url,head_sha,diff_hash,findings,engine,run_id,rules,carried_from,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id,pr_url,head_sha) DO UPDATE SET
         diff_hash = excluded.diff_hash, findings = excluded.findings, engine = excluded.engine, run_id = excluded.run_id,
         rules = excluded.rules, carried_from = excluded.carried_from, created_at = excluded.created_at`,
    ).run(randomUUID(), r.workspace_id, r.repo_id, String(r.pr_url).slice(0, 400), r.head_sha, r.diff_hash, JSON.stringify(r.findings), String(r.engine).slice(0, 120), r.run_id, r.rules, r.carried_from, now());
    return codeReviews.get(r.workspace_id, r.pr_url, r.head_sha)!;
  },
};

export const repoMemory = {
  get(workspaceId: string, repoId: string): RepoMemoryRow | undefined {
    return memoryRow(db.prepare("SELECT * FROM repo_review_memory WHERE workspace_id = ? AND repo_id = ?").get(workspaceId, repoId));
  },
  /** GitHub was asked; nothing to rewrite (or the rewrite failed — the old rules stand). */
  checked(workspaceId: string, repoId: string, slug: string | null, at = now()): void {
    db.prepare(
      `INSERT INTO repo_review_memory (workspace_id,repo_id,slug,rules,comments_seen,checked_at) VALUES (?,?,?,'[]',0,?)
       ON CONFLICT(workspace_id,repo_id) DO UPDATE SET checked_at = excluded.checked_at, slug = COALESCE(excluded.slug, slug)`,
    ).run(workspaceId, repoId, slug, at);
  },
  /** Forget what it learned (its repo row now points at another GitHub repo): the next refresh starts from nothing. */
  reset(workspaceId: string, repoId: string, slug: string | null): void {
    db.prepare("UPDATE repo_review_memory SET slug = ?, rules = '[]', comments_seen = 0, seen_through = NULL, checked_at = NULL, refreshed_at = NULL WHERE workspace_id = ? AND repo_id = ?")
      .run(slug, workspaceId, repoId);
  },
  /** The rewritten rules, replacing the old list whole. */
  save(workspaceId: string, repoId: string, m: { slug: string | null; rules: string[]; comments_seen: number; seen_through: string | null }, at = now()): RepoMemoryRow {
    db.prepare(
      `INSERT INTO repo_review_memory (workspace_id,repo_id,slug,rules,comments_seen,seen_through,checked_at,refreshed_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id,repo_id) DO UPDATE SET slug = excluded.slug, rules = excluded.rules, comments_seen = excluded.comments_seen,
         seen_through = excluded.seen_through, checked_at = excluded.checked_at, refreshed_at = excluded.refreshed_at`,
    ).run(workspaceId, repoId, m.slug, JSON.stringify(m.rules), m.comments_seen, m.seen_through, at, at);
    return repoMemory.get(workspaceId, repoId)!;
  },
};
