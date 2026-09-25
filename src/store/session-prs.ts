import { db } from "./db.js";
import { now } from "./util.js";

/** A PR a Desk terminal opened — see migration 139 and src/terminal-automerge.ts. */
export type SessionPr = {
  url: string;
  session_id: string;
  workspace_id: string;
  cwd: string;
  state: "open" | "merged" | "closed" | "skipped";
  ci_state: string | null;
  skip_reason: string | null;
  merge_error: string | null;
  created_at: string;
  updated_at: string;
};

export const sessionPrs = {
  /** First sighting wins: a PR belongs to the terminal that produced it, not to the next one that quotes it. */
  record(r: { url: string; session_id: string; workspace_id: string; cwd: string }): boolean {
    const res = db
      .prepare("INSERT OR IGNORE INTO session_prs (url,session_id,workspace_id,cwd,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(r.url, r.session_id, r.workspace_id, r.cwd, now(), now());
    return res.changes > 0;
  },
  get(url: string): SessionPr | undefined {
    return db.prepare("SELECT * FROM session_prs WHERE url = ?").get(url) as SessionPr | undefined;
  },
  open(limit = 20): SessionPr[] {
    return db.prepare("SELECT * FROM session_prs WHERE state = 'open' ORDER BY updated_at ASC LIMIT ?").all(limit) as SessionPr[];
  },
  hasOpen(): boolean {
    return !!db.prepare("SELECT 1 FROM session_prs WHERE state = 'open' LIMIT 1").get();
  },
  update(url: string, p: Partial<Pick<SessionPr, "state" | "ci_state" | "skip_reason" | "merge_error">>): void {
    const cur = sessionPrs.get(url);
    if (!cur) return;
    const n = { ...cur, ...p };
    db.prepare("UPDATE session_prs SET state=?, ci_state=?, skip_reason=?, merge_error=?, updated_at=? WHERE url=?")
      .run(n.state, n.ci_state, n.skip_reason, n.merge_error, now(), url);
  },
};
