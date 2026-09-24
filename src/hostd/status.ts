/**
 * What a host says about itself on `GET /__host/status` (the loopback forwarder) — read by
 * `host status` and by the menu bar item (desktop/hostbar.swift, HOSTS.md → Menu bar).
 *
 * The endpoint is unauthenticated: it listens on 127.0.0.1 only and anything on this Mac that can
 * reach it can already read the host's own logs. That is exactly why it is built from an allowlist
 * of fields here instead of serialising internal objects: no token, no env, no workspace, no title —
 * some hosts belong to one employer and the operator does not want other clients' names on them,
 * even in a menu. A repo FOLDER name is the most a work item says about what it is.
 *
 * The same module holds the port discovery the Swift item mirrors (mcPortCandidates, secretsPort),
 * so the one rule is tested in TypeScript and the Swift copy stays a few trivially-checked lines.
 */
import path from "node:path";
import type { LinkState } from "./link.js";

/**
 * Output within this window = the agent is working. Longer than the brain's QUIET_MS (6s, terminal.ts:
 * when the Desk paints a card orange) on purpose: a menu bar that flickers between 1 and 0 while a
 * model thinks between tool calls is noise, and a headless run can go 10–15s between stdout lines.
 */
export const ACTIVE_MS = 20_000;

/** One live PTY or headless run, before it is shaped for the outside. Internal: holds the full id and cwd. */
export type WorkSource = {
  kind: "terminal" | "run";
  id: string;
  cwd: string;
  backend: string;
  startedAt: number;
  lastOut: number;
};

export type WorkItem = {
  kind: "terminal" | "run";
  /** The session or run id, shortened: enough to match a Desk card, useless as a handle. */
  id: string;
  /** The checkout's folder name (a worktree reports its repo, not its branch); null outside any repo. */
  repo: string | null;
  backend: string;
  started_at: number;
  last_output_at: number;
  active: boolean;
};

export type LinkView = "online" | "reconnecting" | "offline";

export type HostStatus = {
  host_id: string;
  /** The operator's name for this computer (from the brain's welcome), else its hostname. */
  name: string;
  link: LinkView;
  /** Why the link is not online, one line; null while it is. */
  reason: string | null;
  since: number;
  version: string;
  commit: string | null;
  work: WorkItem[];
  active: number;
  at: number;
  // Kept for `host status` and older readers: the raw link state, the brain URL, the last error.
  state: LinkState;
  url: string | null;
  last_error: string | null;
};

/**
 * The link's five internal states, as three a person reads. `connecting` and `offline` (a retry is
 * scheduled) are both "reconnecting" — the host is still trying. `stopped` (the brain refused the
 * credential for good) and `idle` (never started) are "offline": nothing will change on its own.
 */
export function linkView(s: LinkState): LinkView {
  if (s === "online") return "online";
  if (s === "connecting" || s === "offline") return "reconnecting";
  return "offline";
}

/**
 * A URL or error text without credentials: userinfo and the query string go (a brain URL is never
 * supposed to carry either, but a pasted one could, and this text ends up in a tooltip).
 */
export function redact(s: string | null | undefined): string | null {
  if (!s) return null;
  return String(s)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#][^\s]*/gi, "$1")
    .slice(0, 300);
}

/**
 * The repo a cwd belongs to, as a folder name. A worktree lives at
 * `<parent>/.chronos-worktrees/<repo>/<branch…>` (worktree-core.ts worktreeRootFor), and its branch
 * name is a ticket key — which carries a workspace prefix — so the repo segment is used, never the leaf.
 */
export function repoFolder(cwd: string | null | undefined, home?: string): string | null {
  if (!cwd) return null;
  const norm = path.resolve(cwd);
  if (home && norm === path.resolve(home)) return null;
  const parts = norm.split(path.sep);
  const i = parts.lastIndexOf(".chronos-worktrees");
  if (i >= 0) return parts[i + 1] || null;
  return path.basename(norm) || null;
}

export function workItem(w: WorkSource, now = Date.now(), home?: string, activeMs = ACTIVE_MS): WorkItem {
  return {
    kind: w.kind,
    id: String(w.id).slice(0, 8),
    repo: repoFolder(w.cwd, home),
    backend: w.backend,
    started_at: w.startedAt,
    last_output_at: w.lastOut,
    active: now - w.lastOut < activeMs,
  };
}

export function buildStatus(src: {
  hostId: string;
  name: string;
  link: { state: LinkState; since: number; url: string | null; lastError: string | null };
  version: string;
  commit: string | null;
  work: WorkSource[];
  home?: string;
}, now = Date.now()): HostStatus {
  const link = linkView(src.link.state);
  const lastError = redact(src.link.lastError);
  // Active first (what the operator is looking for), then oldest first — a stable order, so rows do
  // not jump around between two opens of the menu.
  const work = src.work
    .map((w) => workItem(w, now, src.home))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.started_at - b.started_at);
  return {
    host_id: src.hostId,
    name: src.name,
    link,
    reason: link === "online" ? null : lastError ?? (src.link.state === "idle" ? "not connected yet" : src.link.state),
    since: src.link.since,
    version: src.version,
    commit: src.commit ? src.commit.slice(0, 12) : null,
    work,
    active: work.filter((w) => w.active).length,
    at: now,
    state: src.link.state,
    url: redact(src.link.url),
    last_error: lastError,
  };
}

// ───────────── port discovery (mirrored by desktop/hostbar.swift) ─────────────

export const DEFAULT_MC_PORT = 7777;
/** 7777 is taken on a Mac that also runs its own Chronos daemon (#48); the forwarder falls back here. */
export const FALLBACK_MC_PORTS = Array.from({ length: 10 }, (_, i) => 7787 + i);

const validPort = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;

/**
 * Ports the forwarder binds / a reader probes, in order. An explicit CHRONOS_HOST_MC_PORT is the only
 * one; otherwise 7777 then 7787–7796. Fixed, not random, so every reader can find the process again.
 */
export function mcPortCandidates(explicit: string | null | undefined): number[] {
  const n = Number(String(explicit ?? "").trim());
  if (String(explicit ?? "").trim() && validPort(n)) return [n];
  return [DEFAULT_MC_PORT, ...FALLBACK_MC_PORTS];
}

/** CHRONOS_HOST_MC_PORT from `.secrets` text — the one key the menu bar item reads from that file. */
export function secretsPort(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?CHRONOS_HOST_MC_PORT\s*=\s*["']?([0-9]+)["']?\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** A status reply counts only if it names a host: a Chronos daemon on 7777 answers too, with no host_id. */
export function isHostStatus(v: unknown): v is { host_id: string } {
  return !!v && typeof v === "object" && typeof (v as any).host_id === "string" && !!(v as any).host_id;
}
