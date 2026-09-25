/**
 * GET /desk/cockpit — the one thing the Robert panel (static/desk-cockpit.js) cannot derive from what
 * the Desk already holds: the terminals' open PRs with their CI, and today's spend.
 *
 * Everything else on the panel — open questions, blocked/idle terminals, today's follow-ups, the usage
 * meter — is already on the page (GET /desk, GET /asks, GET /usage) and live off the bus, so it is not
 * sent twice. Read-only: nothing here merges, pokes or writes a row.
 *
 * Where a PR comes from, deduplicated by URL:
 *   · a live terminal's pins — sessionArtifacts(): its ticket's PR, plus PRs its Focus feed names,
 *     looked up through the same 90s gh cache the companion rail uses (state, title and now CI);
 *   · session_prs (migration 139) — PRs an auto-merge workspace's terminals opened, which stay open
 *     after the terminal ends;
 *   · tickets with an open pr_url — the ones POST /tickets/:id/merge-pr can merge.
 * Only PRs known to be OPEN are listed: a merged, closed or unknown one is not something to act on.
 *
 * `merge` is set only where a merge door already exists (the ticket route) and CI is green; the
 * others open on GitHub. Auto-merge workspaces merge their own green PRs (terminal-automerge.ts), so
 * the row says so instead of offering a second button that races it.
 */
import type express from "express";
import { callerScope } from "./authz.js";
import { sessions, sessionPrs, tickets, workspaces } from "./store.js";
import { sessionArtifacts, type CiState } from "./session-artifacts.js";
import { spendToday } from "./spend.js";
import type { FocusEvent } from "./focus.js";

export interface CockpitPr {
  url: string;
  repo: string;
  num: number;
  title: string | null;
  ci: CiState;
  session_id: string | null;
  workspace_id: string | null;
  /** A merge door that already exists for this PR — only when CI is green. */
  merge: { ticket_id: string } | null;
  /** Its workspace squash-merges it on its own once CI is green (terminal-automerge.ts). */
  auto_merge: boolean;
  /** Why auto-merge passed on it, or its last merge error. */
  note: string | null;
}

export interface Cockpit {
  at: string;
  prs: CockpitPr[];
  spend: { today_usd: number; runs_usd: number; sessions_usd: number };
}

const MAX_SESSIONS = 30;
const MAX_PRS = 20;
const PR_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const CI_ORDER: Record<string, number> = { passing: 0, failing: 1, pending: 2 };

function parts(url: string): { repo: string; num: number } {
  const m = PR_RE.exec(url);
  return m ? { repo: `${m[1]}/${m[2]}`, num: Number(m[3]) } : { repo: "", num: 0 };
}

/** The cockpit for one caller scope (null = the operator: every workspace). */
export async function cockpitData(scopeWs: string | null, eventsOf: (id: string) => FocusEvent[]): Promise<Cockpit> {
  const byUrl = new Map<string, CockpitPr>();
  const autoMerge = (wsId: string | null) => !!(wsId && workspaces.get(wsId)?.auto_merge_prs);

  for (const t of tickets.list(scopeWs ? { workspace_id: scopeWs } : {})) {
    if (t.pr_state !== "open" || !t.pr_url || byUrl.has(t.pr_url)) continue;
    const ci = (t.ci_state as CiState) ?? null;
    byUrl.set(t.pr_url, {
      url: t.pr_url, ...parts(t.pr_url),
      title: t.key ? `${t.key} — ${t.title}` : t.title,
      ci, session_id: null, workspace_id: t.workspace_id,
      merge: ci === "passing" ? { ticket_id: t.id } : null,
      auto_merge: false, note: null,
    });
  }

  const live = sessions.list({ workspace_id: scopeWs ?? undefined, status: "live", limit: MAX_SESSIONS });
  for (const s of live) {
    let pins;
    try {
      pins = await sessionArtifacts(s, eventsOf(s.id));
    } catch {
      continue; // one terminal's feed is never the whole panel's failure
    }
    for (const p of pins.prs) {
      if (p.state !== "open") continue;
      const had = byUrl.get(p.url);
      if (had) { had.session_id ??= s.id; continue; }
      byUrl.set(p.url, {
        url: p.url, repo: p.repo, num: p.num, title: p.title, ci: p.ci ?? null,
        session_id: s.id, workspace_id: s.workspace_id ?? null,
        merge: null, auto_merge: false, note: null,
      });
    }
  }

  // session_prs knows which of these auto-merge is watching — and the ones whose terminal has ended.
  for (const r of sessionPrs.openIn(scopeWs)) {
    const had = byUrl.get(r.url);
    const note = r.merge_error ? "merge failed: " + r.merge_error.split("\n")[0] : r.skip_reason;
    if (had) {
      had.auto_merge = autoMerge(r.workspace_id);
      had.note ??= note;
      had.ci ??= (r.ci_state as CiState) ?? null;
      continue;
    }
    byUrl.set(r.url, {
      url: r.url, ...parts(r.url), title: null,
      ci: (r.ci_state as CiState) ?? null,
      session_id: r.session_id, workspace_id: r.workspace_id,
      merge: null, auto_merge: autoMerge(r.workspace_id), note,
    });
  }

  const prs = [...byUrl.values()]
    .sort((a, b) => (CI_ORDER[a.ci ?? ""] ?? 3) - (CI_ORDER[b.ci ?? ""] ?? 3))
    .slice(0, MAX_PRS);
  const sp = spendToday(scopeWs ?? undefined);
  return {
    at: new Date().toISOString(),
    prs,
    spend: { today_usd: sp.total_usd, runs_usd: sp.runs.usd, sessions_usd: sp.sessions.usd },
  };
}

/** GET /desk/cockpit — scoped like GET /desk: a workspace token sees only its own workspace. */
export function cockpitRoute(eventsOf: (id: string) => FocusEvent[]) {
  return async (req: express.Request, res: express.Response): Promise<void> => {
    const scope = callerScope(req);
    if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return; }
    try {
      res.json(await cockpitData(scope.ws, eventsOf));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  };
}
