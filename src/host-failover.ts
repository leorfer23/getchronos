/**
 * A computer goes away; its terminals carry on somewhere else (HOSTS.md → Reconnect and restarts).
 *
 * A host that loses its link keeps its PTYs running and the brain waits: a closed lid or a Wi-Fi
 * blip must never move work. But a host that is actually GONE (powered off, 2026-09-25: m2 with two
 * live terminals) left those cards `live` with `host_offline: true` until the operator noticed. This
 * module ends the wait: once a host has been offline for CHRONOS_HOST_FAILOVER_GRACE_MIN, each of its
 * live terminals is reopened on an online computer — the brain first, when it has the repo — and the
 * old one is ended with end_reason `host_failover`.
 *
 * What comes along is what the brain holds. The files do not: the old worktree is on the dead disk.
 *  - The repo: this Mac's checkout (repos.path), or another online host that reported one. The
 *    terminal's branch is checked out fresh from ORIGIN when it was pushed; otherwise it gets a new
 *    worktree off the default branch, and its seed says so.
 *  - The conversation: a claude terminal's transcript is mirrored here as it runs
 *    (hosts/transcript-mirror.ts). It is copied to where claude looks for `--resume <id>` — which is
 *    ONLY `<profile>/projects/<slug of the cwd>/<id>.jsonl` (checked against claude 2.1.282: a file
 *    filed under any other directory's slug is "No conversation found") — under the new terminal's
 *    id, and the new terminal resumes it. Every other backend, or a claude one whose cwd could not be
 *    resolved here, gets a brief instead: goal, what it was asked, its summary, a replay of its feed.
 *
 * One move per terminal: the old row is ended by the move, so it is never `live` on that host again,
 * and a sweep only looks at live rows. When the host comes back, its hello still lists the old
 * process; reconcile (remote-terminals.ts) kills any reported channel whose row ended here, so two
 * agents never work the same goal. A move that could not happen (no computer has the repo) is said
 * once in the Desk chat and left alone until the host returns or the daemon restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { hosts, leadEvents, leadSlices, repoCheckouts, repos, sessions, tickets, workspaces, LOCAL_HOST_ID } from "./store.js";
import { getBackend } from "./backends/index.js";
import { findHost, hostOnline } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { placementCandidates } from "./hosts/candidates.js";
import { mirrorFile } from "./hosts/transcript-mirror.js";
import { ensureOriginBranchWorktree, worktreeRootFor } from "./worktree-core.js";
import { ensureSessionWorktree } from "./worktrees.js";
import { checkCwd } from "./spawn-guard.js";
import { ticketBranch } from "./tickets.js";
import { renderLinesReplay } from "./replay.js";
import { originalBrief } from "./terminal-failover.js";
import { focusEvents, killSession, openSession, resolveCwd } from "./terminal.js";
import { postRobertToDesk } from "./robert-desk.js";
import { lastActivityState } from "./revive.js";
import type { Repo, Session } from "./types.js";

/** `sessions.end_reason` of a terminal that was moved off an offline computer. */
export const HOST_FAILOVER_END_REASON = "host_failover";

const id8 = (id: string) => id.slice(0, 8);

// ──────────────────────────── the daemon's hands (a test seam) ────────────────────────────

export interface HostFailoverOps {
  open(opts: Parameters<typeof openSession>[0]): Promise<Session>;
  /** End the old terminal for good: row ended with the reason, its brain-side channel dropped. */
  endOld(s: Session, reason: string): void;
  /** One line in the operator's Desk thread. */
  post(body: string): void;
  originWorktree(repoPath: string, branch: string): Promise<string | null>;
  freshWorktree(repo: Repo, sess: Parameters<typeof ensureSessionWorktree>[1]): Promise<{ path: string; branch: string } | null>;
  /** The old terminal's Focus feed, as `kind: text` lines (read from the transcript mirror). */
  feed(id: string): string[];
}

const defaultOps: HostFailoverOps = {
  open: openSession,
  endOld: (s, reason) => {
    const h = s.host_id ? findHost(s.host_id) : undefined;
    const held = h instanceof RemoteHost ? h.channelFor(s.id) : undefined;
    // Closes the row out (usage snapshot, digest) and ends it WITH the reason. The kill frame goes
    // nowhere — the host is offline — which is why reconcile kills it there when it reconnects.
    killSession(s.id, reason);
    if (h instanceof RemoteHost && held) h.lose(held); // the ordinary exit path: off the wall, session.ended
    else bus.publish({ topic: "session.ended", session_id: s.id });
  },
  post: (body) => postRobertToDesk({ body, ws: null }),
  originWorktree: ensureOriginBranchWorktree,
  freshWorktree: ensureSessionWorktree,
  feed: (id) => focusEvents(id).map((e) => `${e.kind}: ${e.text}`),
};

let ops: HostFailoverOps = defaultOps;
/** Test seam: replace any of the daemon's hands. */
export function setHostFailoverOps(o: Partial<HostFailoverOps>): void { ops = { ...defaultOps, ...o }; }

// ──────────────────────────── when ────────────────────────────

/** When this daemon started: a host is never "offline for 5 minutes" before the brain has been up that long. */
let bootAt = Date.now();
/** Sessions being moved right now (host.offline timer and the periodic sweep can overlap). */
const inFlight = new Set<string>();
/** Sessions a move was tried for and could not happen — said once, not every sweep. */
const gaveUp = new Set<string>();

export function resetHostFailover(o: { bootAt?: number } = {}): void {
  bootAt = o.bootAt ?? Date.now();
  inFlight.clear();
  gaveUp.clear();
}

/**
 * Since when this computer has been unreachable, or null when it is online (or is the brain, or was
 * disabled by the operator — a revoked host is his call, not a failure). The latest of: the link
 * dropping, the host row's last_seen_at, and this daemon's own boot — so a brain restart never moves
 * work that simply has not reconnected yet.
 */
export function hostOfflineSince(hostId: string | null | undefined): number | null {
  if (!hostId || hostId === LOCAL_HOST_ID) return null;
  if (hostOnline(hostId)) return null;
  const row = hosts.get(hostId);
  if (row?.status === "disabled") return null;
  const marks = [bootAt];
  const h = findHost(hostId);
  if (h instanceof RemoteHost && h.offlineSince) marks.push(h.offlineSince);
  const seen = Date.parse(row?.last_seen_at ?? "");
  if (Number.isFinite(seen)) marks.push(seen);
  return Math.max(...marks);
}

/** The operator's name for a computer (what the Desk shows). */
export function hostLabel(hostId: string): string {
  const h = findHost(hostId);
  return hosts.get(hostId)?.name || (h instanceof RemoteHost ? h.hello?.name : null) || hostId;
}

/** Offline hosts past the grace, with their still-live terminals. Pure over the DB and registry. */
export function dueHosts(now = Date.now(), graceMin = CONFIG.hostFailoverGraceMin): Array<{ host_id: string; since: number; rows: Session[] }> {
  const byHost = new Map<string, Session[]>();
  for (const s of sessions.list({ status: "live" })) {
    if (!s.host_id || s.host_id === LOCAL_HOST_ID) continue;
    const list = byHost.get(s.host_id) ?? [];
    list.push(s);
    byHost.set(s.host_id, list);
  }
  const out: Array<{ host_id: string; since: number; rows: Session[] }> = [];
  for (const [host_id, rows] of byHost) {
    const since = hostOfflineSince(host_id);
    if (since === null || now - since < graceMin * 60_000) continue;
    out.push({ host_id, since, rows: rows.reverse() }); // oldest first
  }
  return out;
}

// ──────────────────────────── where ────────────────────────────

/** The repo a terminal worked in: its own, its ticket's, or the host checkout its cwd sits under. */
export function repoOf(s: Session): Repo | null {
  const direct = s.repo_id ? repos.get(s.repo_id) : undefined;
  if (direct) return direct;
  const t = s.ticket_id ? tickets.get(s.ticket_id) : undefined;
  if (t?.repo_id) {
    const r = repos.get(t.repo_id);
    if (r) return r;
  }
  if (!s.host_id) return null;
  const dirs = [s.worktree_path, s.cwd].filter((d): d is string => !!d);
  for (const c of repoCheckouts.forHost(s.host_id)) {
    const roots = [c.path, worktreeRootFor(c.path)];
    if (dirs.some((d) => roots.some((r) => d === r || d.startsWith(r + path.sep)))) {
      const r = repos.get(c.repo_id);
      if (r && (!s.workspace_id || r.workspace_id === s.workspace_id)) return r;
    }
  }
  return null;
}

export type Target = { host_id: string } | { stuck: string };

/**
 * Where a terminal goes: the brain when it has the repo (or there is no repo to have), else an online
 * host — not the dead one, not draining or disabled — that reported a checkout of it.
 */
export function pickTarget(s: Session, repo: Repo | null): Target {
  if (!repo) return { host_id: LOCAL_HOST_ID };
  if (repo.path && fs.existsSync(repo.path)) return { host_id: LOCAL_HOST_ID };
  const other = placementCandidates().find(
    (c) => !c.is_brain && c.online && c.id !== s.host_id && c.status === "online" && c.checkouts.includes(repo.id),
  );
  if (other) return { host_id: other.id };
  return { stuck: `${repo.name} is not checked out on this Mac or on any online computer` };
}

// ──────────────────────────── the conversation ────────────────────────────

/**
 * Where claude files a conversation started in `cwd`: `<configDir>/projects/<cwd with every
 * non-alphanumeric as "-">`. Null past 200 characters, where claude shortens the name with a hash
 * this code does not reproduce — such a terminal gets a brief instead of a resume.
 */
export function claudeProjectDir(configDir: string, cwd: string): string | null {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length > 200) return null;
  return path.join(configDir, "projects", slug);
}

/**
 * Copy a mirrored claude transcript to where `claude --resume <newId>` started in `cwd` will find it,
 * re-stamped with the new session id and cwd. Returns the file written, or null (nothing usable).
 */
export function copyClaudeTranscript(src: string, configDir: string, cwd: string, newId: string): string | null {
  const dir = claudeProjectDir(configDir, cwd);
  if (!dir) return null;
  let text: string;
  try { text = fs.readFileSync(src, "utf8"); } catch { return null; }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // a half-streamed last line
    if (o && typeof o === "object") {
      if ("sessionId" in o) o.sessionId = newId;
      if (typeof o.cwd === "string") o.cwd = cwd;
    }
    out.push(JSON.stringify(o));
  }
  if (!out.length) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `${newId}.jsonl`);
  fs.writeFileSync(dest, out.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return dest;
}

function configDirFor(s: Session): string {
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  return ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
}

// ──────────────────────────── the seed ────────────────────────────

export function hostFailoverSeed(i: {
  mode: "resume" | "brief";
  from: string;
  mins: number;
  where: string;
  goal: string | null;
  brief?: string | null;
  summary?: string | null;
  lastState?: string | null;
  note?: string | null;
  replay?: string | null;
  why?: string | null;
}): string {
  const lost =
    `NOTHING from ${i.from}'s disk came with it: uncommitted changes, unpushed commits and files created there are NOT here.`;
  const check =
    "Before continuing, check the real state (git status, git log --oneline -5, git fetch and compare with origin), " +
    "redo whatever only existed on " + i.from + ", and push early and often from now on so a move never loses work again.";
  const finish = `Then continue the goal${i.goal ? `: ${i.goal}` : ""}. Do not open another terminal; run \`mc goal done\` when it is met.`;
  if (i.mode === "resume") {
    return [
      `You were moved: the computer this terminal ran on (${i.from}) has been offline for ${i.mins} min, so Chronos reopened you ${i.where}. ` +
        `Your conversation is restored, but ${lost}`,
      i.note || null,
      check,
      finish,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `You are taking over a Desk terminal that was running on ${i.from}, which has been offline for ${i.mins} min, so the work moves to you ${i.where}. ` +
      `Its conversation could not come along${i.why ? ` (${i.why})` : ""}, and ${lost}`,
    i.goal ? `Goal: ${i.goal}` : null,
    i.brief ? `What the previous terminal was asked:\n${i.brief}` : null,
    i.summary ? `Its last summary: ${i.summary}` : null,
    i.lastState ? `Its last state on the Desk: ${i.lastState}` : null,
    i.note || null,
    i.replay ?? "No transcript of its work could be recovered — read the repo (git status, git log, the branch on origin) to see how far it got.",
    "Do not start over. " + check,
    finish,
  ].filter(Boolean).join("\n\n");
}

// ──────────────────────────── the move ────────────────────────────

export type MoveResult =
  | { kind: "moved"; from: Session; to: Session; host_id: string; mode: "resume" | "brief" }
  | { kind: "stuck"; from: Session; why: string }
  | { kind: "skip" };

/** Move one terminal off its offline host. Never throws; a failure is a "stuck" with the reason. */
export async function failoverSession(s: Session, label: string, mins: number): Promise<MoveResult> {
  const cur = sessions.get(s.id);
  if (!cur || cur.status !== "live" || !cur.host_id || cur.host_id === LOCAL_HOST_ID || hostOnline(cur.host_id)) return { kind: "skip" };
  const backend = getBackend(cur.backend);
  if (backend.kind === "cloud") return { kind: "skip" };
  const repo = repoOf(cur);
  const target = pickTarget(cur, repo);
  if ("stuck" in target) return { kind: "stuck", from: cur, why: target.stuck };
  const local = target.host_id === LOCAL_HOST_ID;
  const where = local ? "on the brain (this Mac)" : `on ${hostLabel(target.host_id)}`;
  const newId = randomUUID();
  const want = cur.worktree_branch ?? (cur.ticket_id ? (() => { const t = tickets.get(cur.ticket_id!); return t ? ticketBranch(t.key) : null; })() : null);

  // The directory, on the target. A remote target resolves its own (it gets intent, not paths).
  let cwd: string | undefined;
  let branch: string | null = null;
  let note: string | null = null;
  try {
    if (local && repo) {
      if (want) {
        const p = await ops.originWorktree(repo.path, want);
        if (p) {
          cwd = p; branch = want;
          note = `Your branch \`${want}\` was checked out fresh from origin at ${p}: only what was PUSHED from ${label} is in it.`;
        } else {
          const w = await ops.freshWorktree(repo, { id: newId, workspace_id: cur.workspace_id, goal: cur.goal, spawn_goal: cur.spawn_goal, title: cur.title, worktree_branch: null });
          if (w) {
            cwd = w.path; branch = w.branch;
            note = `Your branch \`${want}\` is not on origin (it was never pushed), so none of its commits are here. ` +
              `You are in a NEW worktree at ${w.path} on branch \`${w.branch}\`, off ${repo.default_branch}.`;
          } else {
            cwd = repo.path;
            note = `Your branch \`${want}\` could not be checked out here, and a new worktree could not be created. You are in the shared checkout ` +
              `${repo.path}, which is read-only — claim a worktree with \`mc worktree ${repo.name}\` before editing.`;
          }
        }
      } else {
        cwd = repo.path;
        note = `On ${label} it worked in the shared checkout. You are in this Mac's checkout of ${repo.name} (${repo.path}), which is read-only — ` +
          `claim a worktree with \`mc worktree ${repo.name}\` before editing.`;
      }
    } else if (local) {
      cwd = resolveCwd({ workspace_id: cur.workspace_id });
    } else if (want && repo) {
      note = `Its branch was \`${want}\`. If it was pushed, claim a worktree (\`mc worktree ${repo.name}\`), then \`git fetch origin ${want}\` and continue from it; if not, start a fresh branch.`;
    }
  } catch (e: any) {
    return { kind: "stuck", from: cur, why: `could not prepare its repo: ${e?.message ?? e}` };
  }
  // The cwd must be one openSession will keep as-is (it drops a disallowed one and picks its own),
  // and — for a resume — exactly the directory the transcript is filed under.
  let cwdOk = false;
  if (cwd) {
    const c = checkCwd(cwd, cur.workspace_id);
    if (c.ok) { cwd = c.path; cwdOk = true; }
    else {
      if (note) note += ` (That directory was refused as a working directory here, so you start somewhere else: cd into it before working.)`;
      cwd = undefined;
      branch = null;
    }
  }

  // The conversation: resume a mirrored claude transcript, else a brief.
  let mode: "resume" | "brief" = "brief";
  let why: string | null = null;
  const mirror = mirrorFile(cur.id);
  const hasMirror = (() => { try { return fs.statSync(mirror).size > 0; } catch { return false; } })();
  if (backend.name === "claude-code" && backend.supportsResume && backend.pinsSession) {
    if (!local) why = "a resume needs the transcript on the computer that runs it, and only the brain holds it";
    else if (!hasMirror) why = "no transcript of it was mirrored to the brain";
    else if (!cwdOk || !cwd) why = "its directory could not be resolved on this Mac";
    else {
      try {
        if (copyClaudeTranscript(mirror, configDirFor(cur), cwd, newId)) mode = "resume";
        else why = "its transcript could not be copied into this Mac's claude profile";
      } catch (e: any) {
        why = `its transcript could not be copied: ${e?.message ?? e}`;
      }
    }
  } else {
    why = `${backend.name} cannot resume a conversation from another computer`;
  }

  let seed: string;
  if (mode === "resume") {
    seed = hostFailoverSeed({ mode, from: label, mins, where, goal: cur.goal ?? cur.spawn_goal ?? null, note });
  } else {
    let feed: string[] = [];
    try { feed = ops.feed(cur.id); } catch {}
    const replay = renderLinesReplay(feed, `A Desk terminal on ${label} (${cur.backend}${cur.model ? "/" + cur.model : ""}) stopped when its computer went offline`, "its Focus feed", 6000);
    seed = hostFailoverSeed({
      mode, from: label, mins, where, why, note, replay,
      goal: cur.goal ?? cur.spawn_goal ?? null,
      brief: originalBrief(cur.first_prompt),
      summary: cur.summary ?? null,
      lastState: lastActivityState(cur.id),
    });
  }

  let next: Session;
  try {
    next = await ops.open({
      workspace_id: cur.workspace_id,
      repo_id: repo?.id ?? cur.repo_id,
      ticket_id: cur.ticket_id,
      backend: cur.backend,
      model: cur.model,
      role: cur.role,
      goal: cur.goal,
      goal_kind: cur.goal_kind,
      lead_id: cur.lead_id,
      title: cur.title ?? undefined,
      created_by: "failover",
      host_id: target.host_id,
      // Empty = openSession resolves it (a remote host always does its own).
      cwd: local && cwd ? cwd : "",
      seed,
      movedFrom: cur.id,
      ...(mode === "resume" ? { agentSessionId: newId, resumeAgent: true } : {}),
    });
  } catch (e: any) {
    return { kind: "stuck", from: cur, why: `opening it ${where} failed: ${e?.message ?? e}` };
  }

  if (local && repo && branch && cwd) sessions.setWorktree(next.id, { path: cwd, branch, repo_id: repo.id });
  ops.endOld(cur, HOST_FAILOVER_END_REASON);
  // The unique live handle frees up only once the old row is ended.
  if (cur.agent_name) { try { sessions.setAgentName(next.id, cur.agent_name); } catch {} }
  // A Lead that moved keeps its workers, board and inbox (what `mc lead adopt` hands over).
  if (cur.role === "lead") {
    try {
      sessions.reassignLiveWorkers(cur.id, next.id);
      leadSlices.reassign(cur.id, next.id);
      leadEvents.reassign(cur.id, next.id);
    } catch (e: any) {
      console.warn(`[host-failover] ${id8(cur.id)}: handing its workers to ${id8(next.id)} failed: ${e?.message ?? e}`);
    }
  }
  sessions.setPlacement(next.id, `host failover — continues ${id8(cur.id)} from ${label} (offline ${mins}m)`);
  const reason = `${label} offline ${mins}m → continued ${where} in ${id8(next.id)} (${mode})`;
  bus.publish({
    topic: "session.host_failover", session_id: cur.id, workspace_id: cur.workspace_id,
    from_host: cur.host_id, to_host: target.host_id, to_session_id: next.id, mode, reason,
  });
  bus.publish({ topic: "session.updated", session_id: cur.id });
  bus.publish({ topic: "session.updated", session_id: next.id });
  console.warn(`[host-failover] ${id8(cur.id)} on ${label}: ${reason}${why && mode === "brief" ? ` — brief: ${why}` : ""}`);
  return { kind: "moved", from: cur, to: sessions.get(next.id) ?? next, host_id: target.host_id, mode };
}

const titleOf = (s: Session) => `"${(s.title || s.goal || s.spawn_goal || `terminal ${id8(s.id)}`).trim().slice(0, 60)}"`;

/** The one Desk line for a host: what moved where, and what could not. */
export function deskLine(label: string, mins: number, results: MoveResult[]): string | null {
  const moved = results.filter((r): r is Extract<MoveResult, { kind: "moved" }> => r.kind === "moved");
  const stuck = results.filter((r): r is Extract<MoveResult, { kind: "stuck" }> => r.kind === "stuck");
  if (!moved.length && !stuck.length) return null;
  const parts: string[] = [];
  const byHost = new Map<string, typeof moved>();
  for (const m of moved) byHost.set(m.host_id, [...(byHost.get(m.host_id) ?? []), m]);
  for (const [hid, ms] of byHost) {
    const n = ms.length;
    parts.push(`moved ${n} terminal${n === 1 ? "" : "s"} ${hid === LOCAL_HOST_ID ? "here" : `to ${hostLabel(hid)}`}: ${ms.map((m) => titleOf(m.to)).join(", ")}`);
  }
  for (const s of stuck) parts.push(`could not move ${titleOf(s.from)} — ${s.why}; it stays on ${label} until it comes back`);
  return `${label} offline ${mins}m → ${parts.join("; ")}`;
}

/** Move every live terminal off one offline host. */
export async function failoverHost(hostId: string, since: number, rows: Session[], now = Date.now()): Promise<MoveResult[]> {
  const label = hostLabel(hostId);
  const mins = Math.max(0, Math.round((now - since) / 60_000));
  const results: MoveResult[] = [];
  for (const s of rows) {
    if (inFlight.has(s.id) || gaveUp.has(s.id)) continue;
    inFlight.add(s.id);
    try {
      const r = await failoverSession(s, label, mins);
      if (r.kind === "stuck") gaveUp.add(s.id);
      results.push(r);
    } catch (e: any) {
      gaveUp.add(s.id);
      results.push({ kind: "stuck", from: s, why: String(e?.message ?? e) });
    } finally {
      inFlight.delete(s.id);
    }
  }
  const line = deskLine(label, mins, results);
  if (line) {
    for (const r of results) {
      if (r.kind !== "stuck") continue;
      bus.publish({
        topic: "session.host_failover", session_id: r.from.id, workspace_id: r.from.workspace_id,
        from_host: hostId, to_host: null, to_session_id: null, mode: "stuck", reason: r.why,
      });
    }
    try { ops.post(line); } catch (e: any) { console.warn(`[host-failover] Desk line failed: ${e?.message ?? e}`); }
  }
  return results;
}

let sweeping = false;

/** One pass over every host: the periodic timer, the host.offline timer and boot all land here. */
export async function sweepHostFailover(now = Date.now()): Promise<MoveResult[]> {
  if (!CONFIG.hostFailover || sweeping) return [];
  sweeping = true;
  try {
    const out: MoveResult[] = [];
    for (const d of dueHosts(now)) out.push(...(await failoverHost(d.host_id, d.since, d.rows, now)));
    return out;
  } finally {
    sweeping = false;
  }
}

/** Boot hook (index.ts). Not an agent heartbeat: a timer that only reads the DB unless a host is gone. */
export function startHostFailover(): void {
  resetHostFailover();
  const graceMs = CONFIG.hostFailoverGraceMin * 60_000;
  const run = () => void sweepHostFailover().catch((e) => console.error("[host-failover]", e));
  const later = (ms: number) => { const t = setTimeout(run, ms); t.unref?.(); };
  bus.on("event", (e: BusEvent) => {
    if (e.topic === "host.offline") later(graceMs + 1_000);
  });
  later(graceMs + 5_000); // after a brain restart: hosts that never came back
  const every = setInterval(run, 60_000);
  every.unref?.();
  console.log(
    CONFIG.hostFailover
      ? `[host-failover] a host offline ${CONFIG.hostFailoverGraceMin}m hands its live terminals to an online computer (brain first)`
      : "[host-failover] off (CHRONOS_HOST_FAILOVER=off) — terminals on an offline host wait for it",
  );
}
