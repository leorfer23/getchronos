import path from "node:path";
import { kv, repos, searchIndex, sessionPrs, sessions, sessionSearchHook } from "./store.js";
import type { Session } from "./types.js";

const BODY_CAP = 4000;
const REINDEX_KV = "search.session.enriched.v1";

/** Last path segment worth indexing (repo checkout / worktree leaf). */
function pathLeaf(p: string | null | undefined): string {
  if (!p) return "";
  const leaf = path.basename(p.replace(/[/\\]+$/, ""));
  return leaf && leaf !== "." && leaf !== "/" ? leaf : "";
}

function sessionTags(s: Session): string {
  if (!s.tags) return "";
  try {
    return (JSON.parse(s.tags) as string[]).join(" ");
  } catch {
    return "";
  }
}

/**
 * Build the FTS body for a session: narrative fields plus structured signals (branch, repo, PR)
 * that survive even when the goal was vague.
 */
export function sessionSearchBody(s: Session): string {
  const repo = s.repo_id ? repos.get(s.repo_id) : undefined;
  const prUrls = sessionPrs.forSession(s.id).map((p) => p.url);
  const parts = [
    s.goal,
    s.spawn_goal,
    s.first_prompt,
    s.summary,
    sessionTags(s),
    s.worktree_branch,
    s.branch,
    repo?.name,
    pathLeaf(repo?.path),
    pathLeaf(s.worktree_path),
    pathLeaf(s.cwd),
    ...prUrls,
  ];
  // Dedupe while preserving order — goal often equals spawn_goal; cwd leaf often equals repo name.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of parts) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  return unique.join(" · ").slice(0, BODY_CAP);
}

/** Upsert a session into full-text search after deterministic or AI metadata changes. */
export function indexSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  searchIndex.removeRef(id);
  searchIndex.add({
    kind: "session",
    ref_id: id,
    workspace: s.workspace_id ?? "",
    title: `${s.ticket_key ? `${s.ticket_key} ` : ""}${s.goal ?? s.title ?? "chat"}`,
    body: sessionSearchBody(s),
  });
}

/** Reindex every session row (idempotent upsert). Used once after enriching the body schema. */
export function reindexAllSessions(): number {
  const ids = sessions.list({ limit: 100_000 }).map((s) => s.id);
  for (const id of ids) indexSession(id);
  return ids.length;
}

/**
 * Wire store writes → FTS, and run a one-shot reindex of existing rows so past terminals pick up
 * branch/repo/PR text. Safe to call every boot: the reindex is gated on a kv flag.
 */
export function installSessionSearchHooks(): void {
  sessionSearchHook.set(indexSession);
  if (kv.get(REINDEX_KV)) return;
  const n = reindexAllSessions();
  kv.set(REINDEX_KV, new Date().toISOString());
  console.log(`[chronos] session search reindexed ${n} row(s) with enriched body`);
}
