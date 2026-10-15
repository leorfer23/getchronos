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
 * and a sweep only looks at live rows. Two agents never work the same goal:
 *  - the host fences itself first (hostd/fence.ts): every welcome tells it this grace, and a little
 *    before it passes without a word from the brain, the host freezes (SIGSTOP) its terminals;
 *  - when the host comes back, its hello still lists the old process; reconcile (remote-terminals.ts)
 *    salvages what only that disk had to `wip/<id8>` on origin (salvageMoved below), then kills it.
 *    A frozen terminal that was NOT moved is re-attached, which thaws it;
 *  - a host that comes back while a move is under way stops the move (checked again right before the
 *    stand-in opens and before the old row ends).
 * A move that could not happen (no computer has the repo, or none can run it) is said once in the
 * Desk chat and left alone until the host returns or the daemon restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { hosts, leadEvents, leadSlices, repoCheckouts, repos, sessions, tickets, workspaces, LOCAL_HOST_ID } from "./store.js";
import { getBackend } from "./backends/index.js";
import { findHost, hostOnline } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { placementCandidates, placeRequest } from "./hosts/candidates.js";
import { headroom, ineligible } from "./hosts/placement.js";
import { mirrorFile } from "./hosts/transcript-mirror.js";
import { ensureOriginBranchWorktree, worktreeRootFor } from "./worktree-core.js";
import { ensureSessionWorktree } from "./worktrees.js";
import { checkCwd } from "./spawn-guard.js";
import { ticketBranch } from "./tickets.js";
import { renderLinesReplay } from "./replay.js";
import { originalBrief } from "./terminal-failover.js";
import { focusEvents, killSession, openSession, resolveCwd, sendInput } from "./terminal.js";
import { postRobertToDesk } from "./robert-desk.js";
import { notifyLead } from "./robert-drive.js";
import { lastActivityState } from "./revive.js";
import type { Repo, Session } from "./types.js";
import type { LiveInfo } from "./hostlink/wire.js";

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
  /** Close a stand-in that is not needed after all (its old host came back mid-move). */
  discard(s: Session, reason: string): void;
  /** Type one line into a live terminal (the stand-in, when its predecessor's work was salvaged). */
  tell(id: string, text: string): string | null;
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
  discard: (s, reason) => {
    killSession(s.id, reason);
    bus.publish({ topic: "session.ended", session_id: s.id });
  },
  tell: (id, text) => sendInput(id, { text }, "failover"),
};

let ops: HostFailoverOps = defaultOps;
/** Test seam: replace any of the daemon's hands. */
export function setHostFailoverOps(o: Partial<HostFailoverOps>): void { ops = { ...defaultOps, ...o }; }

// ──────────────────────────── when ────────────────────────────

/**
 * Since when this brain has been continuously awake: its boot, or its last wake from sleep. A host is
 * never "offline for 5 minutes" before the brain has been awake that long. A closed lid on battery is
 * not one long sleep: the Mac dark-wakes for a few seconds every few seconds, and timers run in those
 * slivers (2026-09-30: the M3 lid shut at 12:01, a sweep ran in a dark wake at 12:07, m2 had not
 * finished a hello in any of them, and its four live terminals were moved here and killed on m2).
 */
let awakeSince = Date.now();
/** Sessions being moved right now (host.offline timer and the periodic sweep can overlap). */
const inFlight = new Set<string>();
/** Sessions a move was tried for and could not happen — said once, not every sweep. Session → its host. */
const gaveUp = new Map<string, string>();

export function resetHostFailover(o: { bootAt?: number; lastWake?: () => number | null } = {}): void {
  awakeSince = o.bootAt ?? Date.now();
  lastWake = o.lastWake ?? macLastWake;
  inFlight.clear();
  gaveUp.clear();
}

/**
 * When macOS last woke, dark wakes included (`kern.waketime`), or null elsewhere. Node's clocks are no
 * help here: its monotonic clock keeps counting through sleep (checked: hrtime 30.5h vs
 * CLOCK_UPTIME_RAW 17.6h on the same boot), so a sleep looks like a slow timer.
 */
function macLastWake(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const m = /sec = (\d+), usec = (\d+)/.exec(execFileSync("sysctl", ["-n", "kern.waketime"], { encoding: "utf8", timeout: 2_000 }));
    return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
  } catch {
    return null;
  }
}
let lastWake: () => number | null = macLastWake;

/**
 * A host is back: whatever could not be moved off it is its own again — and if it goes away again,
 * the next grace gets a fresh try (and a fresh Desk line) instead of a silence until the next restart.
 */
export function noteHostBack(hostId: string): void {
  for (const [sid, hid] of gaveUp) if (hid === hostId) gaveUp.delete(sid);
}

/** Move the awake mark up to the latest wake, so time the brain spent asleep is never a host's absence. */
export function noteBrainWake(): void {
  const w = lastWake();
  if (w === null || w <= awakeSince) return;
  if (w - awakeSince > 60_000) console.log(`[host-failover] brain woke at ${new Date(w).toISOString()} — offline hosts get a fresh grace`);
  awakeSince = w;
}

/**
 * Since when this computer has been unreachable, or null when it is online (or is the brain, or was
 * disabled by the operator — a revoked host is his call, not a failure). The latest of: the link
 * dropping, the host row's last_seen_at, and this brain's own boot or wake — so a brain restart or a
 * closed lid never moves work that simply has not reconnected yet.
 */
export function hostOfflineSince(hostId: string | null | undefined): number | null {
  if (!hostId || hostId === LOCAL_HOST_ID) return null;
  if (hostOnline(hostId)) return null;
  const row = hosts.get(hostId);
  if (row?.status === "disabled") return null;
  const marks = [awakeSince];
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
 * Where a terminal can go, best first: the brain alone when it has the repo (or there is no repo to
 * have), else every online host — not the dead one — that placement would let run it (policy and veto,
 * the CLI and its login, the profile, the checkout or auto-clone, the sandbox: `ineligible()`), most
 * headroom first. A move is admission-exempt, as for `place()`: it takes the dead terminal's place.
 */
export function pickTargets(s: Session, repo: Repo | null): Array<{ host_id: string }> | { stuck: string } {
  if (!repo) return [{ host_id: LOCAL_HOST_ID }];
  if (repo.path && fs.existsSync(repo.path)) return [{ host_id: LOCAL_HOST_ID }];
  const req = placeRequest({
    workspace_id: s.workspace_id, repo_id: repo.id, ticket_id: s.ticket_id, backend: s.backend, movedFrom: s.id,
  }, "failover");
  const why: string[] = [];
  const ok: Array<{ id: string; score: number; name: string }> = [];
  for (const c of placementCandidates()) {
    if (c.is_brain || c.id === s.host_id) continue;
    const no = ineligible(c, req);
    if (no) { if (c.online && (c.checkouts.includes(repo.id) || c.auto_clone)) why.push(`${c.name}: ${no.reason}`); continue; }
    ok.push({ id: c.id, score: headroom(c, CONFIG.machine), name: c.name });
  }
  if (ok.length) return ok.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((c) => ({ host_id: c.id }));
  return { stuck: `${repo.name} is not checked out on this Mac or on any online computer that can run it${why.length ? ` (${why.join("; ")})` : ""}` };
}

/** The first of pickTargets — where a terminal goes. */
export function pickTarget(s: Session, repo: Repo | null): Target {
  const t = pickTargets(s, repo);
  return Array.isArray(t) ? t[0] : t;
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
  /** `wip/<old id8>`: where the old terminal's unpushed work lands if its computer comes back. */
  wip?: string | null;
}): string {
  const lost =
    `NOTHING from ${i.from}'s disk came with it: uncommitted changes, unpushed commits and files created there are NOT here.` +
    (i.wip ? ` If ${i.from} comes back, Chronos pushes whatever only it had to the branch \`${i.wip}\` on origin and tells you here — merge or cherry-pick from it then.` : "");
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
  const targets = pickTargets(cur, repo);
  if (!Array.isArray(targets)) return { kind: "stuck", from: cur, why: targets.stuck };
  const newId = randomUUID();
  const want = cur.worktree_branch ?? (cur.ticket_id ? (() => { const t = tickets.get(cur.ticket_id!); return t ? ticketBranch(t.key) : null; })() : null);
  const wip = wipBranchFor(cur.id);

  // Brain first (alone when it has the repo), else each host placement allows, best first: one host
  // refusing the open is not the end of the move.
  const failed: string[] = [];
  for (const target of targets) {
    const local = target.host_id === LOCAL_HOST_ID;
    const where = local ? "on the brain (this Mac)" : `on ${hostLabel(target.host_id)}`;

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
      seed = hostFailoverSeed({ mode, from: label, mins, where, goal: cur.goal ?? cur.spawn_goal ?? null, note, wip });
    } else {
      let feed: string[] = [];
      try { feed = ops.feed(cur.id); } catch {}
      const replay = renderLinesReplay(feed, `A Desk terminal on ${label} (${cur.backend}${cur.model ? "/" + cur.model : ""}) stopped when its computer went offline`, "its Focus feed", 6000);
      seed = hostFailoverSeed({
        mode, from: label, mins, where, why, note, replay, wip,
        goal: cur.goal ?? cur.spawn_goal ?? null,
        brief: originalBrief(cur.first_prompt),
        summary: cur.summary ?? null,
        lastState: lastActivityState(cur.id),
      });
    }

    // The host may have come back while the directory and the transcript were being prepared: then
    // it is its own again (reconcile re-attached it), and a stand-in would be a second agent on it.
    if (hostOnline(cur.host_id)) return backAgain(cur, label, "before its stand-in opened");
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
      failed.push(`opening it ${where} failed: ${e?.message ?? e}`);
      continue;
    }
    // …and again once the stand-in is open, before the old row ends (nothing awaits between this
    // check and endOld): the stand-in goes, the original carries on.
    if (hostOnline(cur.host_id)) {
      try { ops.discard(next, `its predecessor's computer (${label}) came back`); } catch (e: any) { console.warn(`[host-failover] discarding ${id8(next.id)} failed: ${e?.message ?? e}`); }
      return backAgain(cur, label, `after its stand-in ${id8(next.id)} opened — closed it again`);
    }
    return finishMove(cur, next, { label, mins, where, mode, why, host_id: target.host_id, branch, cwd: local && repo && branch && cwd ? cwd : null, repo });
  }
  return { kind: "stuck", from: cur, why: failed.join("; ") || "no computer could open it" };
}

function backAgain(cur: Session, label: string, when: string): MoveResult {
  console.warn(`[host-failover] ${id8(cur.id)}: ${label} came back ${when} — not moved`);
  return { kind: "skip" };
}

/** The stand-in is open and the old host is still gone: end the old one and hand over what it held. */
function finishMove(
  cur: Session,
  next: Session,
  m: { label: string; mins: number; where: string; mode: "resume" | "brief"; why: string | null; host_id: string; branch: string | null; cwd: string | null; repo: Repo | null },
): MoveResult {
  if (m.cwd && m.branch && m.repo) sessions.setWorktree(next.id, { path: m.cwd, branch: m.branch, repo_id: m.repo.id });
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
  } else if (cur.lead_id) {
    relinkWorker(cur, next, m.where);
  }
  sessions.setPlacement(next.id, `host failover — continues ${id8(cur.id)} from ${m.label} (offline ${m.mins}m)`);
  const reason = `${m.label} offline ${m.mins}m → continued ${m.where} in ${id8(next.id)} (${m.mode})`;
  bus.publish({
    topic: "session.host_failover", session_id: cur.id, workspace_id: cur.workspace_id,
    from_host: cur.host_id, to_host: m.host_id, to_session_id: next.id, mode: m.mode, reason,
  });
  bus.publish({ topic: "session.updated", session_id: cur.id });
  bus.publish({ topic: "session.updated", session_id: next.id });
  console.warn(`[host-failover] ${id8(cur.id)} on ${m.label}: ${reason}${m.why && m.mode === "brief" ? ` — brief: ${m.why}` : ""}`);
  return { kind: "moved", from: cur, to: sessions.get(next.id) ?? next, host_id: m.host_id, mode: m.mode };
}

/**
 * A Lead's WORKER moved: its slice now names the stand-in (the board is how a Lead rebuilds its map
 * after a compaction), and its inbox says where it went — one `ended` row whose line is
 * `moved → <new id8>`, in place of the bare end robert-drive files (it skips host_failover ends).
 */
export function relinkWorker(cur: Session, next: Session, where: string): void {
  const leadId = cur.lead_id;
  if (!leadId) return;
  try {
    for (const sl of leadSlices.list(leadId)) if (sl.session_id === cur.id) leadSlices.patch(leadId, sl.n, { session_id: next.id });
    leadEvents.add({
      lead_id: leadId,
      session_id: cur.id,
      kind: "ended",
      key: null,
      payload: {
        id8: id8(cur.id), goal: cur.goal || cur.spawn_goal || null,
        card_line: `moved → ${id8(next.id)} ${where} (its computer went offline) — it is your worker now`,
        last_result: null, last_said: null, phase: "ended", progress: null,
      },
    });
    notifyLead(leadId);
  } catch (e: any) {
    console.warn(`[host-failover] ${id8(cur.id)}: telling its Lead ${id8(leadId)} it moved failed: ${e?.message ?? e}`);
  }
}

// ──────────────────────────── when the old host comes back ────────────────────────────

/** `wip/<id8>`: where a moved terminal's unpushed work goes (hostd/salvage.ts names it the same). */
export const wipBranchFor = (sessionId: string) => `wip/${id8(sessionId)}`;

/** What the host's `salvage` op answers (hostd/salvage.ts SalvageResult) — read defensively. */
export type SalvageReport = { status: string; branch?: string; sha?: string; dirty?: boolean; ahead?: number; from?: string | null; dir?: string; detail?: string };

/** The live stand-in that continues a moved terminal (its placement line names it), if any. */
export function standInFor(oldId: string): Session | null {
  const mark = `continues ${id8(oldId)} `;
  return sessions.list({ status: "live" }).find((x) => (x.placement ?? "").includes(mark)) ?? null;
}

/**
 * The words for one salvage, for the Desk and for the stand-in. Pure. Null when there is nothing to
 * say to anyone (its worktree held nothing only that disk had).
 */
export function salvageLines(r: SalvageReport, o: { label: string; title: string; standIn: string | null }): { desk: string; tell: string | null } | null {
  const what = [r.dirty ? "uncommitted changes" : null, r.ahead ? `${r.ahead} unpushed commit${r.ahead === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ") || "its work";
  if (r.status === "saved" && r.branch) {
    const to = o.standIn ? ` — told ${o.standIn}` : "";
    return {
      desk: `${o.label} is back: ${o.title} had ${what} there, now on origin as \`${r.branch}\`${to}; its old process was stopped`,
      tell: o.standIn
        ? `[Chronos] ${o.label} came back. What only it had of the work you took over (${what}) is now on origin as the branch \`${r.branch}\`` +
          ` (a WIP commit on top of ${r.from ? `\`${r.from}\`` : "its HEAD"}). Run \`git fetch origin ${r.branch}\` and merge or cherry-pick what you still need.`
        : null,
    };
  }
  if (r.status === "failed") {
    return {
      desk: `${o.label} is back: could not save ${o.title}'s unpushed work${r.branch ? ` to \`${r.branch}\`` : ""} — ${r.detail ?? "unknown error"}; ` +
        `its worktree is still on ${o.label}${r.dir ? ` at ${r.dir}` : ""}. Its old process was stopped`,
      tell: null,
    };
  }
  return null;
}

/**
 * A terminal this brain moved while its host was away is still running there (frozen by the fence, or
 * not, on an older host). Ask the host to push what only its disk has to `wip/<id8>` and stop it
 * (hostd/terminals.ts salvage), then say what happened — in the Desk chat and to the stand-in. An older
 * host that has no `salvage` gets the plain kill it always got. Never throws.
 */
export async function salvageMoved(
  h: { id: string; send(f: any): boolean; salvage(a: { ch: number; session_id: string; dir: string | null }): Promise<unknown> },
  l: Pick<LiveInfo, "ch" | "exit">,
  row: Session,
): Promise<SalvageReport | null> {
  let r: SalvageReport | null = null;
  try {
    r = (await h.salvage({ ch: l.ch, session_id: row.id, dir: row.worktree_path ?? null })) as SalvageReport;
  } catch (e: any) {
    console.warn(`[host-failover] salvage of ${id8(row.id)} on ${hostLabel(h.id)}: ${e?.message ?? e} — stopping it as before`);
  }
  // The host stops it itself after a salvage; the kill covers an older host (or a salvage that failed).
  if (!l.exit) h.send({ t: "kill", ch: l.ch });
  h.send({ t: "release", ch: l.ch });
  if (!r || typeof r !== "object") return null;
  const label = hostLabel(h.id);
  const next = standInFor(row.id);
  const words = salvageLines(r, { label, title: titleOf(row), standIn: next ? id8(next.id) : null });
  console.log(`[host-failover] salvage of ${id8(row.id)} on ${label}: ${r.status}${r.branch ? ` (${r.branch})` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
  if (words) {
    try { ops.post(words.desk); } catch (e: any) { console.warn(`[host-failover] Desk line failed: ${e?.message ?? e}`); }
    if (words.tell && next) {
      const err = ops.tell(next.id, words.tell);
      if (err) console.warn(`[host-failover] could not tell ${id8(next.id)} about ${r.branch}: ${err}`);
    }
  }
  return r;
}

// The goal reads as what the terminal is for; its title is often the first words of a pasted prompt.
// Prefixed with the project, since one line can carry terminals from several.
export const titleOf = (s: Session) => {
  const what = (s.goal || s.spawn_goal || s.title || `terminal ${id8(s.id)}`).replace(/\s+/g, " ").trim();
  const ws = s.workspace_id ? workspaces.get(s.workspace_id)?.name : null;
  return `${ws ? `${ws}: ` : ""}"${what.length > 70 ? what.slice(0, 69).trimEnd() + "…" : what}"`;
};

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
      if (r.kind === "stuck") gaveUp.set(s.id, hostId);
      results.push(r);
    } catch (e: any) {
      gaveUp.set(s.id, hostId);
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
  noteBrainWake(); // first: a sweep that runs in a dark wake must not count the sleep as a host's absence
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
    else if (e.topic === "host.online") noteHostBack(e.host_id);
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
