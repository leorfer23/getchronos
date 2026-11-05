import { db } from "./db.js";
import { now } from "./util.js";
import { sessionSearchHook } from "./session-search-hook.js";

/** A PR a Desk terminal opened — see migrations 139 + 153, src/terminal-automerge.ts and src/ship-loop.ts. */
export type SessionPr = {
  url: string;
  session_id: string;
  workspace_id: string;
  cwd: string;
  state: "open" | "merged" | "closed" | "skipped";
  ci_state: string | null;
  skip_reason: string | null;
  merge_error: string | null;
  /** What the last `gh pr view` said (null until the first poll). */
  title: string | null;
  review_decision: string | null;
  mergeable: string | null;
  draft: number;
  /** 1 = no checks registered after the grace: the repo has no CI. */
  no_ci: number;
  /** When the ship loop put it in front of the operator, and in which Ship terminal. Null = not yet. */
  ship_offered_at: string | null;
  ship_session_id: string | null;
  created_at: string;
  updated_at: string;
};

type Patch = Partial<Pick<SessionPr, "state" | "ci_state" | "skip_reason" | "merge_error" | "title" | "review_decision" | "mergeable" | "draft" | "no_ci">>;

export const sessionPrs = {
  /** First sighting wins: a PR belongs to the terminal that produced it, not to the next one that quotes it. */
  record(r: { url: string; session_id: string; workspace_id: string; cwd: string }): boolean {
    const res = db
      .prepare("INSERT OR IGNORE INTO session_prs (url,session_id,workspace_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(r.url, r.session_id, r.workspace_id, r.cwd, now(), now());
    if (res.changes > 0) sessionSearchHook.bump(r.session_id);
    return res.changes > 0;
  },
  /** Every PR this terminal was first to open — feeds session FTS. */
  forSession(session_id: string): SessionPr[] {
    return db
      .prepare("SELECT * FROM session_prs WHERE session_id = ? ORDER BY created_at ASC")
      .all(session_id) as SessionPr[];
  },
  get(url: string): SessionPr | undefined {
    return db.prepare("SELECT * FROM session_prs WHERE url = ?").get(url) as SessionPr | undefined;
  },
  /** The poll's batch: least recently polled first (every poll touches updated_at, so it rotates). */
  open(limit = 20): SessionPr[] {
    return db.prepare("SELECT * FROM session_prs WHERE state = 'open' ORDER BY updated_at ASC LIMIT ?").all(limit) as SessionPr[];
  },
  /** Open rows for one workspace (or every one, for the operator), newest first — the Desk cockpit. */
  openIn(workspace_id: string | null, limit = 50): SessionPr[] {
    return (workspace_id
      ? db.prepare("SELECT * FROM session_prs WHERE state = 'open' AND workspace_id = ? ORDER BY created_at DESC LIMIT ?").all(workspace_id, limit)
      : db.prepare("SELECT * FROM session_prs WHERE state = 'open' ORDER BY created_at DESC LIMIT ?").all(limit)) as SessionPr[];
  },
  /** Open rows the ship loop has not offered yet, created since `sinceIso`, oldest first. */
  unoffered(sinceIso: string, limit = 200): SessionPr[] {
    return db
      .prepare("SELECT * FROM session_prs WHERE state = 'open' AND ship_offered_at IS NULL AND created_at >= ? ORDER BY created_at ASC LIMIT ?")
      .all(sinceIso, limit) as SessionPr[];
  },
  hasOpen(): boolean {
    return !!db.prepare("SELECT 1 FROM session_prs WHERE state = 'open' LIMIT 1").get();
  },
  update(url: string, p: Patch): void {
    const cur = sessionPrs.get(url);
    if (!cur) return;
    const n = { ...cur, ...p };
    db.prepare(
      "UPDATE session_prs SET state=?, ci_state=?, skip_reason=?, merge_error=?, title=?, review_decision=?, mergeable=?, draft=?, no_ci=?, updated_at=? WHERE url=?",
    ).run(n.state, n.ci_state, n.skip_reason, n.merge_error, n.title, n.review_decision, n.mergeable, n.draft, n.no_ci, now(), url);
  },
  /** Polled, nothing changed: move it to the back of the rotation. */
  touch(url: string): void {
    db.prepare("UPDATE session_prs SET updated_at=? WHERE url=?").run(now(), url);
  },
  /** Offered in a Ship terminal — never offered again. */
  markOffered(urls: string[], ship_session_id: string, at = now()): void {
    const st = db.prepare("UPDATE session_prs SET ship_offered_at=?, ship_session_id=? WHERE url=? AND ship_offered_at IS NULL");
    db.transaction(() => { for (const u of urls) st.run(at, ship_session_id, u); })();
  },
};
