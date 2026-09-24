/**
 * `GET /api/hosts/bar`: the whole fleet as the brain's menu bar item reads it (HOSTS.md → Menu bar,
 * desktop/hostbar.swift `--brain`). Polled every 3 s, so it is two narrow SELECTs and an in-memory
 * walk — never `hostsView()` (vitals history, checklists, `git rev-parse`), which is built for a panel
 * a person opens, not a timer.
 *
 * "Working" is the brain's OWN notion, the one the Desk paints orange/green by: a terminal is working
 * while its pty is producing bytes (terminal.ts `sessionActivity().quiet === false`). That holds for a
 * terminal on another host too — its pty bytes stream to the brain over the link and go through the same
 * `markBusy()` — so the brain answers for every computer without asking any of them. A headless run is
 * working while its row says `running`.
 *
 * Admin only, like `/api/hosts`: it names every computer and what each is doing. It is built from an
 * allowlist of fields — no token, env, prompt or path beyond the repo FOLDER — and unlike a host's own
 * `/__host/status` it MAY carry a `title` (the Desk card's title): this is the operator's own Mac asking
 * with the operator's admin token, the same person who reads those titles on the Desk all day.
 */
import express from "express";
import { db, hosts, LOCAL_HOST_ID } from "../store.js";
import { repoFolder } from "../hostd/status.js";
import type { BrainLink } from "./brain-link.js";

export type BarItem = {
  kind: "terminal" | "run";
  /** Shortened id: enough to match a Desk card, useless as a handle. */
  id8: string;
  repo: string | null;
  /** The Desk card's title (goal, else derived title) for a terminal; the job name for a run. */
  title: string | null;
  backend: string;
  active: boolean;
  started_at: number;
  last_output_at: number;
};

export type BarComputer = {
  id: string;
  name: string;
  is_brain: boolean;
  connected: boolean;
  /** online | offline for a remote host (its live link); the brain is always online to itself. */
  link_state: "online" | "offline";
  /** ms: when the link came up (connected) or was last heard from (offline); null = never. */
  since: number | null;
  working: number;
  total: number;
  items: BarItem[];
};

export type Bar = {
  brain: { name: string };
  computers: BarComputer[];
  totals: { working: number; total: number };
};

/** What the bar needs from terminal.ts — injected, so this module (and its tests) never load node-pty. */
export type ActivityFn = (id: string) => { live: boolean; quiet: boolean; last_out: number | null };

type SessionRow = { id: string; host_id: string; title: string | null; goal: string | null; backend: string; cwd: string; worktree_path: string | null; created_at: string };
type RunRow = { id: string; host_id: string; started_at: string | null; cwd: string | null; job_cwd: string | null; backend: string | null; name: string | null; last_ts: string | null };

const ms = (iso: string | null | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * A home directory is not a repo. The brain does not know a remote host's $HOME, so the two shapes a
 * home takes on a Mac or Linux box are recognised by path instead of by comparison.
 */
const HOME_RE = /^\/(Users|home)\/[^/]+\/?$/;
const repoOf = (cwd: string | null | undefined): string | null => (!cwd || HOME_RE.test(cwd) ? null : repoFolder(cwd));

const clip = (s: string | null | undefined, n = 80): string | null => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function fleetBar(link: Pick<BrainLink, "list">, activity: ActivityFn, now = Date.now()): Bar {
  const links = new Map(link.list().map((l) => [l.host_id, l]));
  // Same set as the Desk's Computers panel: the brain, and every host that still holds a credential.
  const rows = hosts.list().filter((h) => h.id === LOCAL_HOST_ID || !!h.token_hash);
  const byHost = new Map<string, BarItem[]>(rows.map((h) => [h.id, []]));

  // Cloud sessions (cloud_agent_id) run in a provider's VM, on no computer of this fleet: left out.
  const sess = db.prepare(
    "SELECT id, host_id, title, goal, backend, cwd, worktree_path, created_at FROM sessions WHERE status = 'live' AND cloud_agent_id IS NULL",
  ).all() as SessionRow[];
  for (const s of sess) {
    const list = byHost.get(s.host_id);
    if (!list) continue; // a revoked host's leftover rows: not a computer any more
    const a = activity(s.id);
    const started = ms(s.created_at);
    list.push({
      kind: "terminal",
      id8: s.id.slice(0, 8),
      repo: repoOf(s.worktree_path || s.cwd),
      title: clip(s.goal) ?? clip(s.title),
      backend: s.backend,
      // Not in the brain's pty registry (a host whose link is down) = the brain cannot see it produce.
      active: a.live && !a.quiet,
      started_at: started,
      last_output_at: a.last_out ?? started,
    });
  }

  const runs = db.prepare(
    `SELECT r.id, r.host_id, r.started_at, r.cwd, j.cwd AS job_cwd, j.backend, j.name,
            (SELECT e.ts FROM run_events e WHERE e.run_id = r.id ORDER BY e.id DESC LIMIT 1) AS last_ts
       FROM runs r LEFT JOIN jobs j ON j.id = r.job_id
      WHERE r.status = 'running' AND r.cloud_agent_id IS NULL`,
  ).all() as RunRow[];
  for (const r of runs) {
    const list = byHost.get(r.host_id);
    if (!list) continue;
    const started = ms(r.started_at);
    list.push({
      kind: "run",
      id8: r.id.slice(0, 8),
      repo: repoOf(r.cwd || r.job_cwd),
      title: clip(r.name),
      backend: r.backend || "claude-code",
      active: true,
      started_at: started,
      last_output_at: Math.max(started, ms(r.last_ts)),
    });
  }

  const computers = rows
    .map((h): BarComputer => {
      const items = (byHost.get(h.id) ?? [])
        // Active first (what the operator is looking for), then oldest first: rows keep their place
        // between two opens of the menu.
        .sort((a, b) => Number(b.active) - Number(a.active) || a.started_at - b.started_at);
      const brain = h.id === LOCAL_HOST_ID;
      const l = links.get(h.id);
      const connected = brain || !!l;
      return {
        id: h.id,
        name: h.name,
        is_brain: brain,
        connected,
        link_state: connected ? "online" : "offline",
        since: brain ? null : l ? l.connected_at : h.last_seen_at ? ms(h.last_seen_at) || null : null,
        working: items.filter((i) => i.active).length,
        total: items.length,
        items,
      };
    })
    .sort((a, b) => Number(b.is_brain) - Number(a.is_brain) || a.name.localeCompare(b.name));

  const brainRow = computers.find((c) => c.is_brain);
  return {
    brain: { name: brainRow?.name ?? "brain" },
    computers,
    totals: {
      working: computers.reduce((n, c) => n + c.working, 0),
      total: computers.reduce((n, c) => n + c.total, 0),
    },
  };
}

/** Mounted on the `/api` router by api.ts, beside hostRoutes, behind the same admin gate. */
export function barRoutes(requireAdmin: express.RequestHandler, deps: { link: () => Pick<BrainLink, "list">; activity: ActivityFn }): express.Router {
  const r = express.Router();
  r.get("/hosts/bar", requireAdmin, (_req, res) => {
    res.set("cache-control", "no-store");
    res.json(fleetBar(deps.link(), deps.activity));
  });
  return r;
}
