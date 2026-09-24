import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { detectPrompt, renderScreen, type DeskPrompt } from "./desk-prompt.js";
import { FLUSH_MS, clampRate, fanOut, type TermClient } from "./term-fanout.js";
import { ScreenMirror, type Screen } from "./term-screen.js";
import { ModeTracker } from "./term-modes.js";
import { sessions, sessionGoals, workspaces, repos, tickets, runs, jobs, notes as notesStore, kv } from "./store.js";
import { backendAllowed, getBackend, workspaceBackends } from "./backends/index.js";
import { ensureWsTicketsDir, sandboxWrap, workspaceSandboxAllow } from "./sandbox.js";
import { ensureDropDir } from "./drops.js";
import { ensureTrustedCwd } from "./claude-trust.js";
import { ensureGrokTrustedCwd, grokHome } from "./grok-trust.js";
import { isEarlyDeath, reportEarlyDeath } from "./desk-incidents.js";
import { lastActivityState, reviveSeedFor } from "./revive.js";
import { childEnv } from "./child-env.js";
import { sanitizeCwd } from "./spawn-guard.js";
import { ensureTicketWorktree, cleanupWorktree } from "./worktrees.js";
import { egressEnv, egressLocked } from "./egress.js";
import { niceWrap } from "./machine.js";
import { hostFor, LOCAL_HOST_ID, type PtyHandle } from "./hosts/index.js";
import { getBody, appendNote, updateTicket } from "./tickets.js";
import { bus } from "./bus.js";
import { captureLearnings } from "./notes.js";
import { agentContext } from "./skills.js";
import { markMemorySeen } from "./memory-tree.js";
import { relevanceBlock } from "./recall.js";
import { aiSessionDigest, quickTitle } from "./summarize.js";
import { indexSession } from "./session-search.js";
import { notify, notifyInfo } from "./telegram/api.js";
import { startFocus, stopFocus, snapshotFocus, liveFocusEvents, refreshLiveFocus, hasTranscript, type FocusEvent, type FocusCtx } from "./focus.js";
import { resolveGrokResumeId } from "./grok-resume.js";
import { snapshotUsage } from "./session-usage.js";
import { installClaudeHooks, installCursorHooks, installGrokHooks } from "./term-hooks.js";
import { agentBlock, agentPrompt } from "./agent-defs.js";
import { isClosedTicketStatus, type GoalKind, type NewSession, type Session, type SessionGoal, type Workspace } from "./types.js";
import { goalLines, setGoals, splitGoalText } from "./goals.js";

// Standing instruction folded into every session (via system prompt where the CLI supports it, else the
// seed): the operator watches a plain-English "Focus" feed (Understanding → narration → Summary), not the
// raw output. This shapes each CLI's transcript so focus.ts can render that story across all backends.
// Raw terminal stays one toggle away for detail.
//
// Keep this SHORT — it rides every turn. Card / worktree / heavy detail lives in the mission-control
// skill (Claude) and AGENTS.md (Cursor); duplicate prose here was a standing ~2–3k-token tax.
const FOCUS_CONTRACT = `## How to report your work to your operator
Your operator watches a Focus board, not your raw output: your status, how long you have been running, what you are doing right now, the links you produced, and a timeline of the lines you wrote. Commands are not on it. Shape every task as a story:
1. START with one short paragraph beginning "Understanding:" — restate the task, scope, and plan. Prose only.
2. AS YOU WORK, write one plain-English line per MILESTONE — what changed and what it means, not which command you ran ("tests green except the sandbox one", not "ran npm test"). Each line is a row on their timeline; a line that says nothing costs them a row.
3. SAY EVERY LINK on its own line, in full, the moment you have it — PR, doc, dashboard, artifact. That line is what pins it to their board.
4. END every finished turn: short detail bullets → "**Next steps**" (omit if none) → one paragraph beginning "**Summary:**" (its first sentence is your card's line).
Write for a human on a phone. No filler, no code dumps. Open the raw terminal for detail.

## Your card (mc)
Hooks report turns/subagents; say what only you know: \`mc state waiting "…" --on ci --eta 10m\` before waiting on non-operator work; \`mc ask-robert "…"\` for a decision; \`mc state blocked "…" --reason auth\` for a wall; \`mc state working "…"\` while grinding. On anything with more than two steps, call \`mc progress <n>/<total> "<the step>"\` as you cross each one — it is the only progress bar the operator has. Finish with Summary then \`mc goal done\`. That ticks off the goal you were GIVEN: if the operator then asks for more, name the new one (\`mc goal set "…"\`) before you start — their board shows the goal you are ON, not the one you finished.

## Checkout + load
Main checkouts are read-only — \`mc worktree <repo>\`, cd there, push before you finish. Full test/typecheck/build: \`mc heavy -- <cmd>\`. Prefer fff MCP tools for repo search when available; shell via RTK when installed (transparent).`;

/**
 * The block a WORKER of a live Lead is opened with (LEADS.md), or "" for every other terminal.
 *
 * It exists because the worker side of a Lead was invisible from inside the worker: the agent did
 * not know it had a Lead, its only way to report was to stop and let its scrollback be scraped, and
 * `mc ask-robert` went over its Lead's head. Prose in `agents/_blocks/lead-worker.md` so the wording
 * is editable without a rebuild, like every other block; the two per-terminal values are filled here.
 * Never throws into a spawn: a missing or malformed block is a terminal that opens without it, not a
 * terminal that fails to open.
 */
export function leadWorkerBlock(row: Pick<Session, "lead_id">): string {
  // Resolved here rather than through robert-drive's `resolveLead`: that module imports this one, and
  // a spawn must not depend on the import order of the wake path.
  const lead = row.lead_id ? sessions.get(row.lead_id) : undefined;
  if (!lead || lead.status !== "live" || lead.role !== "lead") return "";
  try {
    return agentBlock("lead-worker", {
      lead_id8: lead.id.slice(0, 8),
      lead_goal: (lead.goal ?? lead.spawn_goal ?? "").trim() || "(no goal set)",
    });
  } catch (e) {
    console.error("[terminal] lead-worker block", e);
    return "";
  }
}

/** The real main checkouts among these repo paths (realpath'd, since the sandbox matches resolved paths). */
export function mainCheckouts(paths: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.statSync(path.join(p, ".git")).isDirectory()) out.add(fs.realpathSync(p));
    } catch {}
  }
  return [...out];
}

// A Desk terminal is spawned with an intent, not with a transcript: the operator types a goal, picks
// what shape of work it is, and optionally writes a brief. That IS the first prompt — typing it in
// means the agent is already working by the time the card finishes fading in, instead of sitting at
// an empty cursor waiting for someone to paste the same sentence again.
//
// The seed also carries the card contract, because the seed is the one channel every backend reads:
// the goal on the card is a starting label the agent is expected to sharpen (`mc goal set`) once it
// knows what the work actually is, and to tick off (`mc goal done`) when it is met.
const KIND_CONTRACT: Record<GoalKind, string> = {
  pr: "Shape of work: PR. Done means a pull request is open against the right branch with its tests green — not a plan, not a local diff.",
  investigation: "Shape of work: INVESTIGATION. Done means an answer with the evidence behind it. Read, reproduce, measure; change code only if asked.",
  qa: "Shape of work: QA. Done means a verdict: what you exercised, what passed, what failed, and the exact steps to reproduce each failure.",
};

// A goal is optional (the Desk's Blank terminal has none). With one, the seed opens with it and the
// card contract explains that the title is a guess to sharpen; without one, the brief IS the task and
// the card has no title yet — so the same paragraph asks for the name instead of a correction.
export function deskSeed(
  goal: string,
  kind: GoalKind | null,
  description?: string | null,
  /** The rest of the queue, when this terminal was given more than one finish line (src/goals.ts).
   *  The agent is told all of them so it can plan the work, and told to tick them off ONE at a
   *  time — the card only ever shows the one it is on. */
  goals?: SessionGoal[] | null,
): string {
  const brief = (description ?? "").trim();
  const g = (goal ?? "").trim();
  const list = (goals ?? []).length > 1 ? goals! : null;
  return [
    g ? `Goal: ${g}` : null,
    kind ? KIND_CONTRACT[kind] : null,
    list
      ? `Your operator gave this terminal ${list.length} goals, in this order:\n` +
        goalLines(list).join("\n") +
        "\n\nWork them in order. `mc goal done` ticks off the ONE you are on and moves your card to the " +
        "next — it does not end the terminal until the last one is ticked. `mc goal list` shows where you " +
        "are. If one of them turns out to be wrong or already true, say so and run `mc goal done` rather " +
        "than inventing work to fill it."
      : null,
    brief ? (g ? `Brief from your operator:\n${brief}` : brief) : null,
    g
      ? "You are one card on your operator's Desk wall, and the goal above is the card's title — the label he " +
        "reads to decide which terminal needs him. It was typed before the work started, so treat it as a " +
        "starting label: as soon as you understand the real task, run `mc goal set \"<sharper goal>\"` to " +
        "retitle your own card (one short outcome, not a plan), and `mc goal done` when it is met. Run " +
        "`mc state blocked \"<what you need>\" --reason question` the moment you need a decision from him."
      : "You are one card on your operator's Desk wall and your card has no title yet — he opened this " +
        "terminal without one. As soon as you understand what the work is, run `mc goal set \"<goal>\"` to " +
        "name your own card (one short outcome, not a plan), and `mc goal done` when it is met. Run " +
        "`mc state blocked \"<what you need>\" --reason question` the moment you need a decision from him.",
    "Start now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// node-pty ships a `spawn-helper` binary in prebuilds/ that can lose its exec bit on extraction,
// which makes posix_spawnp fail. Re-grant +x at boot (idempotent) so the first spawn works.
export function ensurePtyHelper() {
  try {
    const p = path.join(
      process.cwd(),
      "node_modules/node-pty/prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper"
    );
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  } catch {}
}

// Env injected into every spawned agent so it can drive the backlog via the `mc` CLI (~/.mc/bin/mc):
// MC_* give it its context; PATH makes `mc` callable. ~/.mc/bin sits outside any workspace repo so
// the per-workspace sandbox still grants read+exec.
export function mcEnv(workspaceId?: string | null, repoId?: string | null, ticketId?: string | null): Record<string, string> {
  const ws = workspaceId ? workspaces.get(workspaceId) : undefined;
  const repo = repoId ? (repos.get?.(repoId) as any) : undefined;
  const tk = ticketId ? tickets.get(ticketId) : undefined;
  return {
    MC_API: `http://localhost:${CONFIG.port}/api`,
    MC_WORKSPACE: workspaceId ?? "",
    MC_WORKSPACE_NAME: ws?.name ?? "",
    // Scopes this session's `mc` calls to its own workspace (PER-24) — see checkScope in api.ts.
    MC_WORKSPACE_TOKEN: ws?.token ?? "",
    MC_REPO: repoId ?? "",
    MC_REPO_NAME: repo?.name ?? "",
    MC_TICKET: tk?.key ?? "",
    MC_TICKET_TITLE: tk?.title ?? "",
    PATH: `${os.homedir()}/.mc/bin:${process.env.PATH ?? ""}`,
  };
}

const BUF_CAP = 256 * 1024; // scrollback kept in memory for replay on (re)attach
// Silence that means "your turn". Long enough that a thinking pause or a slow tool call doesn't
// flip the card orange, short enough that a finished turn shows up before you look away.
const QUIET_MS = Math.max(1000, Number(process.env.CHRONOS_TERM_QUIET_MS ?? 6000));

interface Live {
  /** node-pty's IPty on this Mac; on another host (HOSTS.md phase 3) a proxy over the link. */
  pty: PtyHandle;
  buffer: string;
  /** Output waiting for the next coalesced send to attached clients (see flushOut). */
  pending: string;
  flushT?: NodeJS.Timeout;
  /** Re-arm for sockets that still owe a frame with no pty output to trigger one (paced, laggards). */
  paceT?: NodeJS.Timeout;
  clients: Set<TermClient>;
  /** The daemon's own parse of the current frame — text cards, prompt detection, agents (term-screen.ts). */
  screen: ScreenMirror;
  /** DEC private modes the stream has set (term-modes.ts) — replayed ahead of the tail on attach. */
  modes: ModeTracker;
  focusCtx: FocusCtx;
  // first-prompt capture (bare chats only) → instant deterministic title
  inbuf: string;
  titleDone: boolean;
  // Turn detection (Desk wall): a pty that has gone silent is not working — it is waiting on the
  // human, whether that's a permission prompt, a question, or a finished turn. Byte-level and
  // backend-agnostic, so it holds for claude/codex/cursor/grok alike. An agent that reports its own
  // state via `mc state` overrides this (agent-lifecycle overlays) — this is the backstop that is
  // always right about one thing: nothing is being produced right now.
  lastOut: number;
  lastIn: number;
  /** When the pty was spawned, and whether killSession (operator/Robert/close-done) ended it on purpose. */
  startedAt: number;
  killed?: boolean;
  /** Stopped only to come straight back under the same id (promoteToLead): the ticket keeps its worktree. */
  restarting?: boolean;
  /** Called once onExit has finished tearing this pty down — the id is free to reopen after it. */
  onExited?: () => void;
  quiet: boolean;          // true once the pty has been silent for QUIET_MS
  quietTimer?: NodeJS.Timeout;
  /** What the settled screen is asking (desk-prompt.ts). Set on the quiet flip, dropped on output. */
  prompt?: DeskPrompt | null;
  /** Ignore output before this ms — a fresh attach forces a repaint (see attach's SIGWINCH jiggle),
   *  and a repaint is the terminal answering US, not the agent doing work. Without this, opening the
   *  wall turns every card green for one QUIET_MS window. */
  muteUntil?: number;
}
const live = new Map<string, Live>();

// ── output path: pty → attached sockets ──────────────────────────────────────────────────────
// node-pty hands us output in many small chunks; sending each as its own WS frame made a chatty
// CLI cost one syscall + one client parse *per chunk*. Coalesce ~one frame's worth (16ms) into a
// single send, then fan out per socket (term-fanout.ts). The pty is NEVER paused: a stalled pty
// blocks the agent's writes, and a hidden terminal must not stall the work it is showing.
const replayTail = (e: Live) => e.modes.preamble() + (e.buffer.length > BUF_CAP ? e.buffer.slice(-BUF_CAP) : e.buffer);

// Full-screen TUIs only paint on their own events or on SIGWINCH — a raw byte replay doesn't
// reconstruct the current frame. Jiggle the pty ±1 row to force one; reads size at fire time so we
// restore the client's dims. muteUntil: the repaint is the terminal answering US, not the agent
// working, and must not flip the card green.
function jiggle(e: Live) {
  e.muteUntil = Date.now() + 900;
  setTimeout(() => {
    try {
      const c = e.pty.cols, r = e.pty.rows;
      e.pty.resize(c, Math.max(2, r - 1));
      e.pty.resize(c, r);
    } catch {}
  }, 150);
}

function resync(e: Live, ws: WebSocket) {
  if (e.buffer && ws.readyState === 1) ws.send(replayTail(e));
  jiggle(e);
}

// One coalesced flush → every socket at its own pace (term-fanout.ts). A paced socket or a laggard
// leaves work for later that no pty output will trigger, so the tick re-arms itself.
//
// Two timers on purpose: flushT is the 16ms fast path armed by pty output; paceT is the slow re-arm
// for sockets that still owe a frame. Sharing one slot let a 5s pace block the fast path — new pty
// output saw a timer already armed and waited behind the slowest socket on the terminal.
function flushOut(e: Live) {
  if (e.flushT) { clearTimeout(e.flushT); e.flushT = undefined; }
  if (e.paceT) { clearTimeout(e.paceT); e.paceT = undefined; }
  const out = e.pending;
  e.pending = "";
  const { again, resync: stale } = fanOut(e.clients, out, Date.now());
  for (const c of stale) resync(e, c);
  if (again) e.paceT = setTimeout(() => flushOut(e), again);
}

// Workspace a session belongs to (for per-workspace backend routing of AI title/summary helpers).
function wsOfSession(id: string) {
  const wsId = sessions.get(id)?.workspace_id;
  return wsId ? workspaces.get(wsId) : undefined;
}

function resolveCwd(s: { repo_id?: string | null; workspace_id?: string | null }): string {
  if (s.repo_id) {
    const r = repos.get?.(s.repo_id) as any;
    if (r?.path && fs.existsSync(r.path)) return r.path;
  }
  if (s.workspace_id) {
    // Workspace's chosen landing dir beats the first-repo accident: a multi-repo client wants
    // repo-less sessions to open in the parent folder holding all its checkouts (migration 105).
    const dd = workspaces.get(s.workspace_id)?.default_dir;
    if (dd && fs.existsSync(dd)) return dd;
    const r = repos.list(s.workspace_id)[0];
    if (r?.path && fs.existsSync(r.path)) return r.path;
  }
  return os.homedir();
}

// cwd for a fresh session: a ticket-bound session with a git repo gets an isolated worktree off
// fresh origin/main; everything else lands in the plain repo path. Worktree helper is null-safe, so
// any git problem transparently falls back to resolveCwd.
async function resolveSessionCwd(opts: { ticket_id?: string | null; repo_id?: string | null; workspace_id?: string | null }): Promise<string> {
  const t = opts.ticket_id ? tickets.get(opts.ticket_id) : undefined;
  const repo = opts.repo_id ? repos.get(opts.repo_id) : t?.repo_id ? repos.get(t.repo_id) : undefined;
  // Fall back through the TICKET's repo, not just the session's — a ticket terminal often carries
  // only ticket_id, and resolveCwd would otherwise drop it into the workspace's *first* repo, which
  // is how agents ended up running relative commands in an unrelated checkout.
  const base = resolveCwd({ repo_id: repo?.id ?? opts.repo_id, workspace_id: opts.workspace_id });
  // Isolation is independent of delivery mode: EVERY ticket-bound session gets its own worktree, so
  // two tickets in the same repo can never share one working tree. (Two agents on one checkout is a
  // silent data-loss race — a branch switch by one discards the other's uncommitted edits.)
  if (t && repo) {
    const wt = await ensureTicketWorktree(repo, t.key);
    if (wt) return wt;
  }
  return base;
}

// A repo's worktree root (`.chronos-worktrees/<repo>`) is granted to every terminal in the workspace
// (see the repoDirs comment below) so a later `mc worktree` claim never hits "Operation not
// permitted" — but nothing guarantees the root exists yet; it's created lazily by the first
// `mc worktree` in this repo. Best-effort create it now so the grant is real immediately; if that
// fails, return null rather than handing a backend a path that doesn't exist. cursor-agent's
// `--add-dir` exits at spawn on a missing dir (claude tolerates it), which is what killed a Personal
// terminal in ~1s when AgentsEmail had never had a worktree claimed (chronos.err.log:239982, 2026-09-19).
export function ensureWorktreeRoot(repoPath: string): string | null {
  const root = path.join(path.dirname(repoPath), ".chronos-worktrees", path.basename(repoPath));
  if (!fs.existsSync(root)) {
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {}
  }
  return fs.existsSync(root) ? root : null;
}

// Open an interactive PTY session running the chosen agent CLI, sandboxed to its workspace.
// - resumeId: revive an ended Chronos terminal (same row id, Claude --resume that id)
// - agentSessionId + resumeAgent: open a new Chronos terminal that --resumes a headless run's CLI session
export async function openSession(
  opts: NewSession & {
    seed?: string;
    /** Free-text brief from the spawn dialog — folded into the seed under the goal. */
    description?: string | null;
    cols?: number;
    rows?: number;
    resumeId?: string;
    /** CLI transcript id (e.g. headless run.session_id) to --resume */
    agentSessionId?: string | null;
    resumeAgent?: boolean;
    /** A live terminal this one is about to replace (failover) — not counted against the cap. */
    replaces?: string | null;
    /** More than one finish line, in the order they should be worked (src/goals.ts). The first one
     *  becomes the card's goal; `mc goal done` walks the rest. */
    goals?: Array<string | { text: string; kind?: GoalKind | null }> | null;
  },
): Promise<Session> {
  ensurePtyHelper();
  // A terminal opened with a list is still opened with a goal: the first one is what the card, the
  // day's log and `spawn_goal` carry. The rest are queued onto the row right after it is created.
  // A goal typed as several lines IS a list — see splitGoalText.
  if (!opts.goals?.length && splitGoalText(opts.goal).length > 1) {
    opts = { ...opts, goals: splitGoalText(opts.goal) };
  }
  if (opts.goals?.length) {
    const first = opts.goals[0];
    opts = { ...opts, goal: typeof first === "string" ? first : first.text };
  }
  // Machine governor (src/machine.ts): an AGENT may not open a terminal onto a Mac that is already
  // thrashing — another claude CLI on a load-38 box with full swap makes every existing terminal
  // slower and finishes nothing. Checked BEFORE the per-workspace seat count, because seats are
  // about one client's fair share and this is about whether the machine can run a process at all.
  // The operator is never refused: when he opens a terminal by hand, that IS the priority.
  // `created_by` is "operator" (or unset) for a Desk/API open and the agent's handle otherwise.
  // A stand-in for a walled terminal (`replaces`) is exempt for the same reason the seat cap exempts
  // it: it takes an existing terminal's place rather than adding a process, and refusing it would
  // strand the work on a dead CLI exactly when the machine is too busy to notice.
  // Every terminal opens on the brain until placement lands (HOSTS.md phase 4), so it is the brain's
  // own load that admits it.
  const openedBy = (opts.created_by ?? "operator").trim();
  if (openedBy && openedBy !== "operator" && !opts.replaces) {
    const verdict = hostFor({ host_id: LOCAL_HOST_ID }).vitals().admission;
    if (!verdict.ok) throw new Error(`machine saturated — ${verdict.reason}`);
  }
  // Guardrail: bound live sessions so a runaway agent can't fork unbounded terminals. Workers of a
  // Lead (`lead_id` set) count against THAT Lead's maxWorkers (CHRONOS_LEAD_MAX_WORKERS), not the
  // workspace seat cap — otherwise a Lead with >5 workers was impossible under the default of 6.
  // The Lead itself (and every terminal without a lead_id) still occupies a workspace seat.
  // Machine admission above still applies either way.
  if (opts.workspace_id) {
    // A stand-in for a walled terminal is opened BEFORE the walled one is closed — so the ticket's
    // worktree always has a live session on it — and must not be refused by the seat it is taking.
    const live = sessions
      .list({ workspace_id: opts.workspace_id, status: "live" })
      .filter((x) => x.id !== opts.replaces);
    if (opts.lead_id) {
      const n = live.filter((x) => x.lead_id === opts.lead_id).length;
      const cap = CONFIG.leadDrive.maxWorkers;
      if (n >= cap) {
        throw new Error(
          `lead worker cap reached (${n}/${cap}) — close a worker or raise CHRONOS_LEAD_MAX_WORKERS`,
        );
      }
    } else {
      const seats = live.filter((x) => !x.lead_id).length;
      const cap = CONFIG.maxSessionsPerWorkspace;
      if (seats >= cap) {
        throw new Error(
          `workspace session cap reached (${seats}/${cap}) — close a terminal or raise CHRONOS_MAX_WS_SESSIONS`,
        );
      }
    }
  }
  // Which CLIs this client may run. Enforced HERE rather than only in the Desk picker, because the
  // picker is one of several ways a terminal gets opened (`mc session new`, Robert, the API), and
  // the reason is a client boundary rather than a preference: cursor, grok and opencode have no
  // per-workspace config dir, so on a client workspace they would run that client's work through the
  // one shared login every other workspace uses.
  if (opts.workspace_id && opts.backend) {
    const ws0 = workspaces.get(opts.workspace_id);
    if (ws0 && !backendAllowed(ws0.backends, opts.backend)) {
      throw new Error(
        `${ws0.name} may not run \`${opts.backend}\` — allowed here: ${workspaceBackends(ws0.backends).join(", ")}`,
      );
    }
  }
  if (opts.agent_name) {
    const n = opts.agent_name.trim().toLowerCase();
    opts = { ...opts, agent_name: n };
    const taken = sessions.findByAgentName(n);
    if (taken) throw new Error(`agent_name \`${n}\` already in use by session ${taken.id.slice(0, 8)}`);
  }
  // resumeId → reopen an ended session in place (same id → transcript continues, Focus stays pinned).
  // agentSessionId (continue headless): pin Chronos session id to the CLI transcript id so Focus finds it.
  // Fresh sessions on a ticket get an isolated git worktree (resolveSessionCwd); resumes reuse the
  // worktree the row was created in (row.cwd) so the transcript and its files stay together.
  const wsEarly = opts.workspace_id ? workspaces.get(opts.workspace_id) : undefined;
  // Explicit request → workspace default → fleet default. Leaving model null used to mean
  // "whatever the CLI profile says", which made most Desk spend land as unknown model.
  if (!opts.model) {
    const fallback = wsEarly?.default_model ?? CONFIG.defaultModel ?? null;
    if (fallback) opts = { ...opts, model: fallback };
  }
  let row: Session;
  let cwd: string;
  if (opts.resumeId) {
    row = sessions.revive(opts.resumeId)!;
    cwd = row.cwd;
  } else if (opts.agentSessionId && opts.resumeAgent) {
    const existing = sessions.get(opts.agentSessionId);
    if (existing?.status === "live" && isLive(existing.id)) {
      return existing; // already open
    }
    if (existing) {
      row = sessions.revive(existing.id)!;
      cwd = row.cwd;
    } else {
      cwd = sanitizeCwd(opts.cwd, opts.workspace_id) ?? (await resolveSessionCwd(opts));
      row = sessions.create({ ...opts, cwd, id: opts.agentSessionId });
    }
  } else {
    cwd = opts.cwd || (await resolveSessionCwd(opts));
    row = sessions.create({ ...opts, cwd });
  }
  // Several finish lines, queued at spawn (src/goals.ts). The row keeps mirroring the FIRST one, so
  // everything downstream — the card, the title, the phase — sees a terminal with one goal; the list
  // only shows itself in the seed below and when the agent ticks one off.
  if (!opts.resumeId && opts.goals?.length) {
    setGoals(
      row.id,
      // The shape of work typed in the spawn dialog belongs to the FIRST goal — it is the one that
      // was on the card when the operator picked it. Without this the mirror would write a null kind
      // straight back over it and the card would lose its chip.
      opts.goals.map((g, i) =>
        typeof g === "string"
          ? { text: g, kind: i === 0 ? opts.goal_kind ?? null : null }
          : { ...g, kind: g.kind ?? (i === 0 ? opts.goal_kind ?? null : null) },
      ),
      "seed",
    );
    row = sessions.get(row.id)!;
  }
  const backend = getBackend(opts.backend);
  const ws = wsEarly;
  const configDir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
  installMcSkill(configDir); // claude agents: skill in the config dir
  installCardHooks(backend.name, configDir, childEnv(ws).CURSOR_CONFIG_DIR);
  // claude asks "trust this folder?" on its first visit to any cwd, and a seeded terminal has no one
  // to tap Yes — answer it here, in the profile, before the spawn (see claude-trust.ts).
  if (backend.name === "claude-code" && ensureTrustedCwd(configDir, cwd) === "added")
    console.log(`[terminal] pre-trusted ${cwd} in ${path.basename(configDir)}`);
  // grok asks the same question per folder (one account, ~/.grok, no per-workspace home) and types
  // the seed into the dialog when nobody answers — the pager quits on it (see grok-trust.ts).
  if (backend.name === "grok" && ensureGrokTrustedCwd(cwd) === "added")
    console.log(`[terminal] pre-trusted ${cwd} in ${grokHome()}`);
  await syncAgentsMd(cwd);   // cursor/other agents: AGENTS.md in the repo root (in sync with the skill)
  const denyDirs = opts.workspace_id ? workspaces.isolationDenyDirs(opts.workspace_id) : [];
  const mode = (ws?.sandbox_mode as any) ?? CONFIG.sandbox.defaultMode;
  // Repo-scoped ★ memos load only for their repos: use the session's repo, falling back to its
  // ticket's repo (a ticket terminal may carry only ticket_id) — same resolution as resolveSessionCwd.
  const ctxRepoId = row.repo_id ?? (row.ticket_id ? tickets.get(row.ticket_id)?.repo_id ?? null : null);
  const ctx = opts.workspace_id ? agentContext(opts.workspace_id, ctxRepoId) : "";
  // This spawn bakes today's memory into the prompt: only changes after now need a notice (memory-tree.ts).
  if (opts.workspace_id) markMemorySeen(row.id);
  // Ticket-bound Desk terminals get the same relevance pointers dispatched jobs get (tickets.ts):
  // FTS on the ticket's title surfaces the memos/skills worth reading in full before starting.
  const relTicket = row.ticket_id ? tickets.get(row.ticket_id) : undefined;
  const rel = ws && relTicket ? relevanceBlock(ws, relTicket.title, [], relTicket.key, { source: "spawn", session_id: row.id }) : "";
  // Every backend gets the Focus reporting contract; CLIs with a system-prompt channel carry it there,
  // the rest get it folded into the seed below. Claude and cursor let us pin the transcript id.
  const pinsSession = backend.pinsSession === true;
  // A worker of a live Lead is TOLD so (LEADS.md): without it the only thing it knew about its Lead
  // was that something typed into it occasionally, its only way to report was to stop and be scraped,
  // and its `mc ask-robert` went over its Lead's head to Robert.
  const leadBlock = leadWorkerBlock(row);
  // A Lead's persona goes first, ahead of the standing Focus/worktree contract (LEADS.md): it is
  // WHO the terminal is before it is told how to report. A worker's Lead block sits in the same slot
  // for the same reason — whose worker it is comes before how it reports.
  const sysArg = backend.appendsSystem
    ? ([row.role === "lead" ? agentPrompt("lead") : null, leadBlock, FOCUS_CONTRACT, ctx, rel].filter(Boolean).join("\n\n") || null)
    : null;
  // Workspace = the access boundary: let a ticket terminal read/write EVERY repo in its workspace
  // (cross-repo work), not just cwd, plus the workspace's ticket-files dir (~/chronos is another
  // workspace's denied root, so it must be re-granted explicitly). Repo is optional — a no-repo
  // session lands in the first repo or home and can still reach them all. Both walls get the dirs:
  // OS sandbox (addDirs) + claude (--add-dir).
  // Also every repo's WORKTREE ROOT, not just the repo: a Desk terminal claims its worktree
  // mid-session (`mc worktree`, once it knows which repo it needs), long after this profile is
  // baked into the pty and can no longer be widened. Under `guard` the write happens to be allowed
  // anyway — guard is `allow default` plus targeted denies — but `strict` is an allowlist, and
  // without this line a strict workspace's agent would `cd` into its worktree and get "Operation
  // not permitted" on every write, with nothing explaining why. Granting the ROOT (not a specific
  // worktree) is what makes it work for whichever repo the agent turns out to need.
  const repoDirs = opts.workspace_id
    ? [
        ...repos.list(opts.workspace_id).flatMap((r) =>
          r.path && fs.existsSync(r.path) ? [r.path, ensureWorktreeRoot(r.path)].filter((p): p is string => !!p) : [],
        ).filter((p) => p !== cwd),
        ...(ws ? [ensureWsTicketsDir(ws.slug)] : []),
      ]
    : [];
  // …and this terminal's own drop dir (src/drops.ts): where a file the operator drags from Finder
  // onto the stage is written. Both walls again — without the `--add-dir` claude asks permission to
  // Read a path outside its cwd, and the point of a drop is that the path just works. Added
  // unconditionally, like wsTicketsDir above, and created here so `--add-dir` (claude AND cursor)
  // never points at a path that does not exist yet.
  repoDirs.push(ensureDropDir(row.id));
  // CLI session id for transcript: prefer agentSessionId (headless continue), else Chronos row id.
  // Every workspace repo's MAIN checkout is read-only to the agent, whatever it was spawned in. Two
  // terminals pointed at one repo would otherwise share a working tree, and one's `git checkout`
  // swaps the files under the other mid-edit (inventory-docs, 2026-09-14). An agent that means to
  // change a repo claims its own worktree (`mc worktree`, created by the daemon, outside the sandbox)
  // and works there. Only real main checkouts: `.git` a directory, so a repo registered at a worktree
  // or a non-git folder (nowhere to claim a worktree from) stays writable.
  const sharedCheckouts = opts.workspace_id ? mainCheckouts(repos.list(opts.workspace_id).map((r) => r.path)) : [];
  const doResume = !!(opts.resumeId || opts.resumeAgent);
  // Pin / resume id for CLIs that store the transcript under a UUID we choose (claude, cursor, grok).
  // Bus/Focus stay keyed by this Chronos id. Grok before pinning minted its own UUID under cwd —
  // resolve that on-disk id for the spawn args only so Desk reopen continues the real chat
  // (grok-resume.ts) without retargeting focus.event session_id.
  const cliSessionId = pinsSession ? (opts.agentSessionId || row.id) : null;
  let spawnSessionId = cliSessionId;
  if (backend.name === "grok" && doResume && cliSessionId) {
    const siblings = sessions
      .list({ limit: 200 })
      .filter((s) => s.backend === "grok" && s.cwd === cwd && s.id !== row.id)
      .map((s) => ({ id: s.id, createdAt: s.created_at }));
    spawnSessionId = resolveGrokResumeId({
      cwd,
      sessionId: cliSessionId,
      createdAt: row.created_at,
      siblings,
    });
  }
  const iArgs = backend.interactiveArgs
    ? backend.interactiveArgs(opts.model ?? null, sysArg, repoDirs, spawnSessionId, doResume)
    : [];
  // Credential stores this client is trusted with (Globex ↔ ~/.config/gcloud, so `bq` can auth).
  // Empty for every workspace that hasn't been given one explicitly.
  const allowSecrets = workspaceSandboxAllow(ws?.sandbox_allow);
  const sandboxed = sandboxWrap(mode, cwd, repoDirs, configDir, denyDirs, backend.bin(), iArgs, egressLocked(opts.workspace_id), sharedCheckouts, allowSecrets);
  // …and `nice` OUTSIDE the sandbox wrapper: this CLI and everything it forks (vitest, tsc, its own
  // subagents) run below the Desk webview and the daemon. One wrap for every way a terminal is
  // opened — fresh, reopened, resumed, or a failover stand-in — since they all land here.
  const { cmd, cmdArgs } = niceWrap(sandboxed.cmd, sandboxed.cmdArgs);

  const env = {
    ...childEnv(ws),
    ...backend.env({} as any, configDir),
    ...mcEnv(opts.workspace_id, opts.repo_id, row.ticket_id),
    // Lets the agent talk about ITSELF: `mc state working|blocked|done`, `mc goal set "…"`.
    MC_SESSION: row.id,
    ...egressEnv(opts.workspace_id),
    // A Lead (LEADS.md): its own credential to type into other terminals of this workspace
    // (MC_LEAD_TOKEN → x-mc-lead), the handle `mc session new` signs its workers' created_by with
    // (MC_AGENT_NAME, overriding mcEnv's plain agent naming), and a flag a worker can check to
    // refuse ever opening a Lead of its own.
    ...(row.role === "lead"
      ? { MC_LEAD_TOKEN: sessions.leadToken(row.id) ?? "", MC_AGENT_NAME: `lead:${row.id.slice(0, 8)}`, MC_LEAD: "1" }
      : {}),
    // …and, on a WORKER, which Lead it belongs to. An id, not a credential: it grants nothing (the
    // daemon resolves the Lead from the worker's own row) and only lets `mc` say whose worker this is.
    ...(leadBlock && row.lead_id ? { MC_LEAD_ID: row.lead_id } : {}),
  } as Record<string, string>;
  // Through the row's host (HOSTS.md): today always the brain, which is node-pty's spawn exactly as
  // before. `pid` is a process id on THAT host, which is why the row carries host_id beside it.
  const term = await hostFor(row).spawnPty({
    id: row.id,
    cmd,
    args: cmdArgs,
    cwd,
    env,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
  });
  sessions.setPid(row.id, term.pid ?? null);

  // Ticket binding: mark the ticket as actively worked + record which session/backend is on it.
  // (A ticket can carry several live sessions — multiple agents/terminals — so we never "unclaim".)
  if (row.ticket_id) {
    bindTicket(row.ticket_id, row, backend.name, opts.role ?? "human", "opened");
  }

  // Ticket sessions already have a meaningful name (the ticket); seed it so titleDone is satisfied.
  // Bare chats get an instant title from the first submitted line. Their first Understanding can
  // refine the card without a separate helper-model call (desk-title.ts).
  const ticketTitle = row.ticket_id ? tickets.get(row.ticket_id)?.title ?? null : null;
  if (ticketTitle) sessions.setMeta(row.id, { title: ticketTitle });
  else if (opts.title) sessions.setMeta(row.id, { title: opts.title });
  // A Lead's card reads "Lead · <goal>" so it stands out on the wall from its own workers.
  else if (row.role === "lead" && (row.goal ?? "").trim()) sessions.setMeta(row.id, { title: `Lead · ${(row.goal ?? "").trim()}` });

  // Focus tails the CLI transcript by session id (must match --resume / --session-id). Bus events
  // always use the Chronos row id; legacy grok may need transcriptSessionId for the on-disk UUID.
  const focusSessionId = cliSessionId || row.id;
  const focusCtx: FocusCtx = {
    sessionId: focusSessionId,
    backend: backend.name,
    cwd,
    configDir,
    sinceMs: Date.now(),
    cursorConfigDir: env.CURSOR_CONFIG_DIR,
    ...(spawnSessionId && spawnSessionId !== focusSessionId ? { transcriptSessionId: spawnSessionId } : {}),
  };
  const entry: Live = {
    pty: term, buffer: "", pending: "", clients: new Set(), focusCtx,
    screen: new ScreenMirror(term.cols, term.rows), modes: new ModeTracker(),
    inbuf: "", titleDone: !!ticketTitle,
    lastOut: Date.now(), lastIn: Date.now(), startedAt: Date.now(), quiet: false,
  };
  live.set(row.id, entry);

  // Focus view: tail this session's transcript → plain-English feed on the bus (focus.ts, per-backend).
  startFocus(focusCtx);

  term.onData((d) => {
    entry.buffer += d;
    // Trim at 2× and cut back to 1×: slicing 256KB on *every* chunk of a chatty pty was constant
    // GC churn in the same process that serves the sockets. Replay always sends ≤ BUF_CAP (replayTail).
    if (entry.buffer.length > BUF_CAP * 2) entry.buffer = entry.buffer.slice(-BUF_CAP);
    entry.pending += d;
    entry.modes.feed(d);
    entry.screen.write(d);
    if (!entry.flushT) entry.flushT = setTimeout(() => flushOut(entry), FLUSH_MS);
    markBusy(row.id, entry); // working ↔ waiting for the Desk wall
  });
  term.onExit(() => {
    if (entry.quietTimer) clearTimeout(entry.quietTimer);
    if (entry.flushT || entry.paceT) flushOut(entry); // last bytes reach the wall
    // Keep tailing briefly so the agent's trailing "Summary:" lines get picked up before we stop.
    // …unless the same id is live again by then (promoteToLead reopens it at once): that tail is its.
    setTimeout(() => { if (!live.has(row.id)) stopFocus(row.id); }, 2000);
    const transcript = entry.buffer;
    // Consume the last appended transcript records before the process-local Focus cache feeds the
    // closing digest. This stays incremental; it never reparses the full transcript on the event loop.
    try { refreshLiveFocus(row.id); } catch {}
    // Freeze the ledger BEFORE the row goes cold: turns, tokens, dollars, lines, and the branch the
    // work landed on. The transcript is still on disk right now; in a month it may not be.
    try { snapshotUsage(row.id, { cwd }); } catch {}
    // A seeded terminal that dies in seconds with its goal unticked is a Chronos incident, not a
    // closed chat: the screen it died on is the evidence, and it is gone the moment we dispose it.
    try {
      const cur = sessions.get(row.id);
      const aliveMs = Date.now() - entry.startedAt;
      if (cur && isEarlyDeath({ aliveMs, seeded: !!cur.first_prompt, killed: !!entry.killed, goalDone: !!cur.goal_done_at }))
        reportEarlyDeath(cur, aliveMs, entry.screen.snapshot().lines);
    } catch {}
    sessions.end(row.id);
    live.delete(row.id);
    entry.screen.dispose();
    // Questions this terminal was blocked on can never be answered now — nothing is listening. Drop
    // them rather than leaving open asks on the fleet board pointing at a dead pty. (The watch, if
    // any, is left armed on purpose: the sweeper owes this terminal one closing report first.)
    // Late import — ask-robert.ts reads this module's focusEvents, and a static cycle here would
    // have terminal.ts half-initialised at its top level.
    void import("./ask-robert.js").then((m) => m.cancelSessionAsks(row.id)).catch(() => {});
    // One haiku boot for both: search summary+tags AND (auto-memory) durable learnings.
    runExitDigest(row.id, opts.workspace_id ?? null, configDir, digestText(row.id, transcript));
    // If no other live session is still on this ticket, log that the terminal closed and reclaim the
    // worktree — only if clean and no build is mid-run (cleanupWorktree no-ops on a dirty tree).
    if (row.ticket_id && !entry.restarting && !sessions.list({ ticket_id: row.ticket_id, status: "live" }).length) {
      try { appendNote(row.ticket_id, `terminal session closed (${backend.name})`, "system"); } catch {}
      const repo = row.repo_id ? repos.get(row.repo_id) : undefined;
      const latest = runs.latestForTicket(row.ticket_id);
      const buildRunning = latest?.status === "running" || latest?.status === "queued";
      if (repo?.path && !buildRunning) void cleanupWorktree(repo.path, cwd);
      bus.publish({ topic: "ticket.updated", ticket_id: row.ticket_id });
    }
    bus.publish({ topic: "session.ended", session_id: row.id });
    entry.onExited?.();
  });

  // Seed the conversation: the ticket context (or a passed seed) is typed in once the CLI has booted.
  // Precedence: an explicit seed, else a ticket's own brief, else the Desk intent (goal + kind +
  // description) — a terminal spawned with a goal starts working on it without a second paste.
  // A brief with no goal is still a first prompt: the Desk's goal field is optional, so "nothing to
  // type in" means neither one was filled — not that the goal box was left empty.
  let seed =
    opts.seed ??
    (row.ticket_id
      ? ticketSeed(row.ticket_id)
      : (row.goal || opts.description?.trim()) && !opts.resumeId
        ? (row.role === "lead"
            ? `You are the LEAD for this goal in ${ws?.name ?? "this workspace"}. Read your instructions above, then start.\n\n` +
              deskSeed(row.goal ?? "", row.goal_kind ?? null, opts.description, sessionGoals.list(row.id))
            : deskSeed(row.goal ?? "", row.goal_kind ?? null, opts.description, sessionGoals.list(row.id)))
        : null);
  // Backends without a system-prompt channel (cursor) get the standing notes + Focus contract folded
  // into the seed instead — but only when there's an actual task/context to run (never paste the
  // contract alone into a bare exploratory chat).
  // A resumed chat already carries them from its first prompt: pasting them again would be a new turn.
  if (!backend.appendsSystem && !opts.resumeId && (seed || ctx)) {
    const pre = [leadBlock, FOCUS_CONTRACT, ctx].filter(Boolean).join("\n\n");
    seed = pre + (seed ? `\n\n--- Your task ---\n${seed}` : "");
  }
  if (seed) {
    // A revive's continue-nudge is not the terminal's first prompt: keep the one it was opened with.
    if (!opts.resumeId) sessions.setMeta(row.id, { first_prompt: seed });
    typeSeed(entry, seed);
  }

  indexSession(row.id);
  bus.publish({ topic: "session.started", session_id: row.id });
  return sessions.get(row.id)!;
}

/**
 * Open an interactive terminal that continues a headless run's agent conversation
 * (Claude: --resume <run.session_id>). Operator can take over, refine, or push further work.
 */
export async function continueFromRun(
  runId: string,
  opts: { cols?: number; rows?: number; seed?: string } = {},
): Promise<Session> {
  const run = runs.get(runId);
  if (!run) throw new Error("run not found");
  const job = jobs.get(run.job_id);
  if (!job) throw new Error("job not found");

  // Headless process holds the CLI session — stop it so we can resume interactively. Signalled on
  // the run's own host: its pid means nothing anywhere else.
  if (run.status === "running" || run.status === "queued") {
    if (run.pid) {
      const host = hostFor(run);
      try {
        host.signal(run.pid, "SIGTERM");
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          host.signal(run.pid!, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, 3000);
    }
    runs.setStatus(runId, "killed");
  }

  const backend = getBackend(job.backend);
  const t = job.ticket_id ? tickets.get(job.ticket_id) : undefined;
  const title =
    (t ? `${t.key} · continue` : null) ||
    (job.name ? `${job.name} · continue` : "continue run");

  const canResume =
    !!run.session_id &&
    backend.supportsResume &&
    backend.name === "claude-code";

  const seed =
    opts.seed ||
    (canResume
      ? `Operator took over this session from headless run ${runId.slice(0, 8)} (${job.name}, status was ${run.status}). ` +
        `Transcript context is already loaded. Ready for follow-ups, improvements, or fixes.`
      : `Continue work from headless job "${job.name}" (run ${runId.slice(0, 8)}, ${run.status}). ` +
        (run.summary ? `Last summary: ${run.summary.slice(0, 500)}\n\n` : "") +
        (t ? `Ticket ${t.key}: ${t.title}. Read the ticket file for full context. ` : "") +
        `Operator is here in an interactive terminal — help them improve or finish the work.`);

  return openSession({
    workspace_id: job.workspace_id,
    repo_id: t?.repo_id ?? null,
    ticket_id: job.ticket_id,
    backend: job.backend,
    model: job.model,
    cwd: job.cwd,
    role: "human",
    title,
    seed,
    cols: opts.cols,
    rows: opts.rows,
    ...(canResume
      ? { agentSessionId: run.session_id, resumeAgent: true }
      : {}),
  });
}

// ──────────────────────── deterministic title (display + search) ────────────────────────

// Feed raw client keystrokes; once the first line is submitted on a bare chat, title it immediately.
function captureFirstPrompt(entry: Live, id: string, data: string) {
  if (entry.titleDone) return;
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      const p = entry.inbuf.trim();
      entry.inbuf = "";
      if (p.length >= 3) { entry.titleDone = true; onFirstPrompt(id, p); return; }
    } else if (ch === "\x7f" || ch === "\b") {
      entry.inbuf = entry.inbuf.slice(0, -1);
    } else if (ch === "\x1b") {
      break; // escape sequence (arrows etc.) — stop scanning this chunk
    } else if (ch >= " ") {
      entry.inbuf += ch;
      if (entry.inbuf.length > 500) entry.inbuf = entry.inbuf.slice(-500);
    }
  }
}

function onFirstPrompt(id: string, prompt: string) {
  // Focus Understanding refines this on the first agent turn. A separate model boot duplicated
  // reasoning the main agent was already about to do.
  sessions.setMeta(id, { first_prompt: prompt, title: quickTitle(prompt) });
  indexSession(id);
  bus.publish({ topic: "session.updated", session_id: id });
}

// Any pty byte means the agent is producing → working. Silence for QUIET_MS means the turn is over
// (or it's sitting on a prompt) → waiting on you. Only the flips publish, so a chatty terminal costs
// one bus event per turn, not one per chunk.
function markBusy(id: string, entry: Live) {
  const now = Date.now();
  entry.lastOut = now;
  if (now < (entry.muteUntil ?? 0)) return; // attach repaint, not work
  if (entry.quiet) {
    entry.quiet = false;
    entry.prompt = null;
    bus.publish({ topic: "session.activity", session_id: id, state: "working" });
  }
  if (entry.quietTimer) clearTimeout(entry.quietTimer);
  entry.quietTimer = setTimeout(() => {
    const e = live.get(id);
    if (!e || e.quiet) return;
    e.quiet = true;
    const at = e.lastOut;
    // What it is sitting on rides with the flip, so the wall can put the question in its strip
    // without a second fetch. The screen has settled (nothing written for QUIET_MS); render it
    // and read the prompt off the frame. If output resumed while rendering, the flip is stale.
    void readPrompt(e).then((p) => {
      const cur = live.get(id);
      if (!cur || cur.lastOut !== at || !cur.quiet) return;
      cur.prompt = p;
      bus.publish({ topic: "session.activity", session_id: id, state: "waiting", prompt: p });
    });
  }, QUIET_MS);
}

// Handing a booting CLI its first prompt is not a `write()` — it's a small negotiation, and getting it
// wrong is silent: the card comes up, the goal is on it, and the agent never starts.
//
// Two failures, both seen on the wall:
//   · Type too early and the keystrokes land on a splash screen that is still repainting, so half the
//     prompt is eaten and what survives can trip a slash command.
//   · Send the text and its Enter in one write and a TUI in bracketed-paste mode reads the trailing
//     \r as a newline INSIDE the paste — the prompt sits there, full and unsent, forever.
// So: wait for the boot chatter to stop (with a floor, and a ceiling for a CLI that never settles),
// type the prompt, then press Enter by itself.
const SEED_MIN_MS = 2500;    // never before this: no CLI is ready sooner
const SEED_QUIET_MS = 1200;  // "the splash screen stopped moving"
const SEED_MAX_MS = 20000;   // a CLI that keeps painting (spinner) still gets its prompt
const SEED_ENTER_MS = 250;   // Enter as its own keystroke, after the paste has landed

function typeSeed(entry: Live, seed: string) {
  const started = Date.now();
  const line = seed.replace(/\r?\n/g, " ");
  const tick = setInterval(() => {
    const waited = Date.now() - started;
    if (waited < SEED_MIN_MS) return;
    if (Date.now() - entry.lastOut < SEED_QUIET_MS && waited < SEED_MAX_MS) return;
    clearInterval(tick);
    try {
      entry.pty.write(line);
      setTimeout(() => { try { entry.pty.write("\r"); } catch {} }, SEED_ENTER_MS).unref?.();
    } catch {
      // pty died while we waited — the session already ended, nothing to seed
    }
  }, 250);
  tick.unref?.();
}

async function readPrompt(e: Live): Promise<DeskPrompt | null> {
  try { await e.screen.settle(); return detectPrompt(e.screen.snapshot().lines); }
  catch {
    try { return detectPrompt(await renderScreen(e.buffer, e.pty.cols, e.pty.rows)); }
    catch { try { return detectPrompt(e.buffer); } catch { return null; } }
  }
}

/** The current frame of a live terminal as text (null when not live). Cheap: it is already parsed. */
export function sessionScreen(id: string): Screen | null {
  const e = live.get(id);
  if (!e) return null;
  try { return e.screen.snapshot(); } catch { return null; }
}

/** A socket sets its own frame pace — the pane you are reading wants 16ms, one across the wall 250. */
export function setClientRate(id: string, ws: WebSocket, ms: unknown) {
  const e = live.get(id);
  if (!e || !e.clients.has(ws as TermClient)) return;
  const c = ws as TermClient;
  c._rate = clampRate(ms);
  // Dropping to a faster pace must not wait for the slow slot to come round.
  if (!c._rate && c._acc && !e.flushT) e.flushT = setTimeout(() => flushOut(e), 0);
}
/**
 * What a quiet terminal is asking (desk-prompt.ts), read off its screen at the quiet flip. Null
 * while it is working: a half-painted frame is not a prompt, and the wall would answer the wrong
 * thing.
 */
export function sessionPrompt(id: string): DeskPrompt | null {
  const e = live.get(id);
  if (!e || !e.quiet) return null;
  return e.prompt ?? null;
}

/** Turn state of a live pty. `quiet` = nothing written to the terminal for QUIET_MS. */
export function sessionActivity(id: string): { live: boolean; quiet: boolean; last_out: number | null; last_in: number | null; started_at: number | null } {
  const e = live.get(id);
  if (!e) return { live: false, quiet: true, last_out: null, last_in: null, started_at: null };
  return { live: true, quiet: e.quiet, last_out: e.lastOut, last_in: e.lastIn, started_at: e.startedAt };
}

// Exit path: ONE haiku call → both the search summary and the durable learnings (was two cold boots).
// Fire-and-forget; per-field fallback lives in aiSessionDigest, so a failed call is a silent no-op.
/**
 * What the digest should read: the session's STORY, not its screen.
 *
 * The digest used to get `entry.buffer` — the raw pty bytes, i.e. whatever the TUI happened to be
 * painting when the process died. That's a spinner, a box-drawing frame and half a diff, which is why
 * the day's log filled up with summaries like "session showing typecheck errors and MCP prompts".
 * The Focus feed is the same session parsed from the CLI's own transcript: Understanding → narration
 * → Summary. Fall back to the screen only when there's no transcript to read (a CLI we can't parse).
 */
export function digestText(id: string, fallback: string): string {
  let feed: FocusEvent[] = [];
  try { feed = focusEvents(id); } catch {}
  if (feed.length < 2) return fallback;
  const s = sessions.get(id);
  const head = [
    s?.spawn_goal ? `Asked for: ${s.spawn_goal}` : null,
    s?.goal && s.goal !== s.spawn_goal ? `Turned out to be: ${s.goal}` : null,
    s?.goal_kind ? `Shape of work: ${s.goal_kind}` : null,
  ].filter(Boolean).join("\n");
  // Keep the opening Understanding (what it thought it was doing) and the tail (what it ended up
  // doing) — the middle of a long session is tool narration the summary doesn't need.
  const understanding = feed.find((e) => e.kind === "understanding");
  const tail = feed.slice(-60).map((e) => `[${e.kind}] ${e.text}`).join("\n");
  return [head, understanding ? `[understanding] ${understanding.text}` : null, tail]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Close a terminal's row in the day's log: freeze what it spent, then write the summary of what it
 * did. Runs when the agent says it's finished (`mc goal done`) — while the transcript is warm and the
 * work is fresh — and again when the pty dies, because plenty of terminals never declare anything.
 * The digest LLM is claimed once per session: goal-done + exit must not fire two haiku boots.
 */
export function closeOutSession(id: string, opts: { cwd?: string; transcript?: string } = {}) {
  try { snapshotUsage(id, opts.cwd ? { cwd: opts.cwd } : {}); } catch {}
  const s = sessions.get(id);
  if (!s) return;
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  const configDir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
  runExitDigest(id, s.workspace_id ?? null, configDir, digestText(id, opts.transcript ?? ""));
}

// The vault's existing bullet facts, handed to Robert's digest pass so it never re-records them.
function knownFacts(workspaceId: string | null): string[] {
  if (!workspaceId) return [];
  const memo = notesStore.bySlug(workspaceId, "session-learnings");
  if (!memo) return [];
  return memo.body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

const digestKey = (id: string) => `session.digest:${id}`;

/** True once goal-done or pty exit has claimed the digest slot for this session. */
export function digestClaimed(id: string): boolean {
  return kv.get(digestKey(id)) !== undefined;
}

/**
 * Claim the one exit-digest LLM call for a session. Synchronous (better-sqlite3) so goal-done and
 * onExit racing cannot both pass. Returns false when another path already owns the slot.
 */
function claimExitDigest(id: string): boolean {
  if (digestClaimed(id)) return false;
  kv.set(digestKey(id), new Date().toISOString());
  return true;
}

function runExitDigest(id: string, workspaceId: string | null, configDir: string, transcript: string) {
  if (!claimExitDigest(id)) return;
  aiSessionDigest(transcript, configDir, wsOfSession(id), knownFacts(workspaceId))
    .then(({ summary, learnings }) => {
      if (summary && (summary.summary || summary.tags.length)) {
        sessions.setMeta(id, { summary: summary.summary, tags: summary.tags });
        indexSession(id);
        bus.publish({ topic: "session.updated", session_id: id });
      }
      if (CONFIG.autoMemory && workspaceId && learnings.length) captureSessionLearnings(id, workspaceId, learnings);
    })
    .catch(() => {});
}

// Auto-memory: append a finished session's durable learnings to the workspace memo + notify.
function captureSessionLearnings(id: string, workspaceId: string, facts: string[]) {
  const s = sessions.get(id);
  const label = s?.ticket_key || s?.title || "session";
  const memo = captureLearnings(workspaceId, facts, label);
  if (memo) {
    const ws = workspaces.get(workspaceId);
    notifyInfo(`🧠 <b>${ws ? ws.name : "memory"}</b> · ${facts.length} learning${facts.length > 1 ? "s" : ""} captured from “${label}”\n` +
      facts.slice(0, 3).map((f) => "• " + f).join("\n")).catch(() => {});
  }
}

// Opening a terminal on a ticket marks it actively worked and logs which agent/session is on it.
// Tickets group the backlog; the terminal is where work happens — this keeps both views in sync.
function bindTicket(ticketId: string, row: Session, backendName: string, role: string, phase: "opened") {
  try {
    const t = tickets.get(ticketId);
    if (!t) return;
    // Don't drag a ticket back out of review, or back onto the board after it closed, just because
    // someone opened a terminal on it.
    if (t.status !== "review" && !isClosedTicketStatus(t.status)) updateTicket(ticketId, { status: "in_progress" });
    appendNote(ticketId, `${role} terminal ${phase} (${backendName}${row.model ? "/" + row.model : ""}) · session ${row.id.slice(0, 8)}`, "system");
    bus.publish({ topic: "ticket.updated", ticket_id: ticketId });
  } catch {}
}

function ticketSeed(ticketId: string): string | null {
  const t = tickets.get(ticketId);
  if (!t) return null;
  const ws = workspaces.get(t.workspace_id);
  const repo = t.repo_id ? (repos.get?.(t.repo_id) as any) : undefined;
  const where = `workspace ${ws?.name ?? "?"}${repo?.name ? " · repo " + repo.name : ""}`;
  // No specific repo → tell the agent the workspace's repos so it knows it can work across any of them.
  const wsRepos = ws ? repos.list(ws.id).map((r) => r.name) : [];
  const repoNote = !repo && wsRepos.length ? ` You may work across any repo in this workspace: ${wsRepos.join(", ")} (cwd is ${wsRepos[0]}; cd into others as needed). ` : " ";
  const body = getBody(t).slice(0, 4000);
  return `You are in ${where}, working ticket ${t.key} "${t.title}". Read ${t.file_path} for full context.${repoNote}${body ? "Summary: " + body + " " : ""}Backlog tools (shell): \`mc note "<progress>"\` logs to this ticket, \`mc review\` moves it to review when done, \`mc ticket new --title "..."\` files a follow-up. Start now: first ask me any clarifying questions you need to do this well, then get to work.`;
}

export function attach(id: string, ws: WebSocket): boolean {
  const e = live.get(id);
  if (!e) return false;
  if (e.buffer && ws.readyState === 1) ws.send(replayTail(e)); // replay scrollback
  e.clients.add(ws);
  ws.on("close", () => e.clients.delete(ws));
  // A raw byte replay doesn't reconstruct a full-screen TUI's current frame — force a repaint after
  // the client's own onopen resize settles. Harmless for line-oriented CLIs; they just reflow.
  jiggle(e);
  return true;
}

/** A client whose pane was hidden dropped its stream — replay the scrollback and force a repaint. */
export function refreshClient(id: string, ws: WebSocket) {
  const e = live.get(id);
  if (e) resync(e, ws);
}

export function writeTo(id: string, data: string) {
  const e = live.get(id);
  if (!e) return;
  e.lastIn = Date.now();
  try { e.pty.write(data); } catch {}
  captureFirstPrompt(e, id, data);
}
/**
 * Type into a live terminal from outside its websocket — the verb the Desk's quick actions and an
 * overseeing agent both need, and the one thing Chronos could not do: `mc session attach` needs a
 * real TTY, so nothing headless could ever answer another agent's prompt.
 *
 * Two rules are baked in rather than left to callers:
 *   · Enter is its own write, 200ms after the text. In one write a TUI in bracketed-paste mode reads
 *     the trailing \r as part of the paste and never submits (same bug as the spawn seed).
 *   · A cap per terminal per minute. An overseer that answers a card, sees it go quiet, and answers
 *     again is a loop that costs real tokens on both ends; the cap turns that into an error it can
 *     see instead of a bill you find later.
 */
export type NamedKey = "enter" | "esc" | "tab" | "up" | "down" | "ctrl-c" | "ctrl-d";
const KEYS: Record<NamedKey, string> = {
  enter: "\r", esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", "ctrl-c": "\x03", "ctrl-d": "\x04",
};
export const INPUT_WINDOW_MS = 60_000;
export const KEY_GAP_MS = 120;
export const INPUT_MAX = Number(process.env.CHRONOS_TERM_INPUT_MAX ?? 12);
const inputLog = new Map<string, number[]>();

export function inputAllowed(id: string, at = Date.now()): boolean {
  const hits = (inputLog.get(id) ?? []).filter((t) => at - t < INPUT_WINDOW_MS);
  inputLog.set(id, hits);
  return hits.length < INPUT_MAX;
}
/** Record one injected input against the cap. Separate from the check so tests can drive the window. */
export function noteInput(id: string, at = Date.now()): void {
  const hits = inputLog.get(id) ?? [];
  hits.push(at);
  inputLog.set(id, hits);
}

/** Returns null on success, or a human-readable reason it did not happen. */
export function sendInput(
  id: string,
  req: { text?: string | null; key?: NamedKey | null; keys?: NamedKey[] | null; enter?: boolean },
  by = "operator",
): string | null {
  if (!live.has(id)) return "terminal is not live";
  if (!req.text && !req.key && !req.keys?.length) return "nothing to send — pass text, key or keys";
  const at = Date.now();
  if (!inputAllowed(id, at)) return `rate limit — ${INPUT_MAX} inputs per minute per terminal`;
  noteInput(id, at);

  if (req.key) writeTo(id, KEYS[req.key]);
  // A sequence is one answer ("down, down, enter" = the third option), spaced so a TUI reads
  // separate keystrokes rather than one paste — the same reason Enter is its own write below.
  if (req.keys?.length) {
    req.keys.forEach((k, i) => {
      if (i === 0) writeTo(id, KEYS[k]);
      else setTimeout(() => writeTo(id, KEYS[k]), KEY_GAP_MS * i).unref?.();
    });
  }
  if (req.text) {
    // One line: a pty is a stream, and a stray newline mid-text submits half a thought.
    writeTo(id, req.text.replace(/\r?\n/g, " "));
    if (req.enter !== false) setTimeout(() => writeTo(id, "\r"), 200).unref?.();
  }
  // Persisted by activity.ts like every other bus event — who typed what into whose terminal is
  // exactly the trail you want the day an agent says something you didn't.
  bus.publish({
    topic: "session.input",
    session_id: id,
    by,
    text: req.text ? req.text.slice(0, 200) : req.keys?.length ? req.keys.map((k) => `<${k}>`).join("") : `<${req.key}>`,
    workspace_id: sessions.get(id)?.workspace_id ?? null,
  });
  return null;
}

export function resize(id: string, cols: number, rows: number) {
  const e = live.get(id);
  if (!e) return;
  const c = Math.max(2, cols | 0), r = Math.max(2, rows | 0);
  // Same size = no-op. Every real resize is a SIGWINCH, and N panes refitting to the dims they
  // already have used to make N CLIs repaint their full screens at once.
  if (e.pty.cols === c && e.pty.rows === r) return;
  try { e.pty.resize(c, r); } catch {}
  e.screen.resize(c, r);
}
/**
 * Close a terminal from the outside — the wall's ✕, `mc session kill`, Robert's hand.
 *
 * This CLOSES THE ROW first, exactly as `mc goal done` does, instead of trusting the pty's `onExit`
 * to do it on the way out. Two ways that trust was misplaced, both of which end a terminal's row
 * with no ledger and no summary — it disappears from the day's log having apparently done nothing,
 * and the transcript it could have been rebuilt from is no longer the newest one on disk:
 *
 *  - **No live pty at all.** `live` is in-memory, so after a daemon restart every row still says
 *    `live` while its process is gone. Closing one of those hit `if (e)` → false, and the ONLY
 *    thing that ran was `sessions.end`. No snapshot, no digest, nothing.
 *  - **`onExit` never fires.** A pty already dead, a `kill()` that throws, a process that outlives
 *    the handler — `sessions.end` had already marked the row ended, so nothing downstream would
 *    ever revisit it.
 *
 * Close-out is idempotent by design (`snapshotUsage` re-reads the transcript, and the exit digest is
 * documented to run both on `mc goal done` and again on pty death), so doing it here as well is
 * belt-and-braces, not a double-write.
 */
export function killSession(id: string, reason?: string | null) {
  const e = live.get(id);
  // While the transcript is still warm and this row is still the newest for its session id.
  try { closeOutSession(id, { cwd: e?.focusCtx.cwd, transcript: e?.buffer }); } catch {}
  if (e) { e.killed = true; try { e.pty.kill(); } catch {} }
  sessions.end(id, reason);
}
/**
 * What reopening an ended row takes: its own backend/model/role, and the directory it ACTUALLY
 * worked in. A terminal that claimed a worktree mid-session has a `cwd` frozen at the shared checkout
 * it started in — resuming there would put the agent back outside the tree holding its own hour of
 * work, on the wrong branch. Cursor is the exception: its chat lives under the directory it started in.
 */
export function resumeOpts(old: Session) {
  return {
    resumeId: old.id,
    workspace_id: old.workspace_id, repo_id: old.repo_id, ticket_id: old.ticket_id,
    backend: old.backend, model: old.model, role: old.role,
    cwd: (old.worktree_path && fs.existsSync(old.worktree_path) && !getBackend(old.backend).transcriptPerCwd) ? old.worktree_path : old.cwd,
  };
}

/** Why this terminal may not become a Lead, or null. Same walls as `mc lead new` (LEADS.md). */
export function leadPromotionError(s: Pick<Session, "role" | "lead_id" | "workspace_id">): string | null {
  if (s.role === "lead") return "already a Lead";
  if (s.lead_id) return "a Lead's worker cannot become a Lead — no nesting";
  if (!s.workspace_id) return "a Lead is bound to a workspace, and this terminal has none";
  return null;
}

export function promotionSeed(goal: string | null | undefined, appendsSystem: boolean): string {
  const g = (goal ?? "").trim();
  return [
    appendsSystem ? null : agentPrompt("lead"),
    `The operator just promoted you to LEAD${g ? ` for this goal: ${g}` : " for the work in this conversation"}. ` +
      `Your Lead instructions are ${appendsSystem ? "in your system prompt" : "above"} and MC_LEAD_TOKEN is now set. ` +
      "Keep what you already know from this conversation; from here, split what is left into workers " +
      "(`mc lead board add`, `mc session new`) and steer them rather than doing it all yourself.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Right-click → Promote to Lead on the Desk. A Lead's persona (system prompt) and credential
 * (MC_LEAD_TOKEN) are baked in at spawn, so a live terminal cannot just be relabelled: it is stopped,
 * its row flips to role=lead, and it is reopened under the same id with `--resume` — conversation
 * intact, now a Lead. The old pty's onExit must finish first, or its `sessions.end`/`live.delete`
 * would land on the new one.
 */
export async function promoteToLead(id: string, size: { cols?: number; rows?: number } = {}): Promise<Session> {
  const s = sessions.get(id);
  if (!s) throw new Error("not found");
  const err = leadPromotionError(s);
  if (err) throw new Error(err);
  const e = live.get(id);
  if (e) {
    const exited = new Promise<void>((r) => { e.onExited = r; });
    e.restarting = true;
    e.killed = true;
    try { e.pty.kill(); } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (live.has(id)) throw new Error("the terminal did not stop — try again");
  } else if (s.status === "live") {
    sessions.end(id);
  }
  sessions.setRole(id, "lead");
  return openSession({ ...resumeOpts(sessions.get(id)!), ...size, seed: promotionSeed(s.goal, getBackend(s.backend).appendsSystem === true) });
}

export function isLive(id: string): boolean {
  return live.has(id);
}

// Where a workspace's cursor-agent keeps its chats: the CURSOR_CONFIG_DIR its secrets_file hands the CLI,
// or undefined for the operator's default ~/.cursor.
function workspaceCursorDir(ws: Workspace | null | undefined): string | undefined {
  return ws ? childEnv(ws).CURSOR_CONFIG_DIR || undefined : undefined;
}

// A live terminal is already being tailed incrementally, so opening it must only copy that cache.
// Dormant history is reconstructed from SQLite + its transcript solely when explicitly requested.
export function focusEvents(id: string): FocusEvent[] {
  const cached = liveFocusEvents(id);
  if (cached !== null) return cached;
  const s = sessions.get(id);
  if (!s) return [];
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  const configDir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? "";
  const backend = getBackend(s.backend).name;
  return snapshotFocus({ sessionId: id, backend, cwd: s.cwd ?? os.homedir(), configDir, sinceMs: 0, cursorConfigDir: workspaceCursorDir(ws) });
}
// Install the "mission-control" Claude skill into a config dir so every claude agent spawned with that
// CLAUDE_CONFIG_DIR auto-knows the `mc` workflow (tickets, jobs, notes, review). Idempotent.
// (Cursor doesn't read Claude skills — those sessions rely on the seed/goal prompt instead.)
function installMcSkill(configDir: string) {
  try {
    const src = path.join(process.cwd(), "skills", "mission-control", "SKILL.md");
    if (!fs.existsSync(src) || !configDir) return;
    const dir = path.join(configDir, "skills", "mission-control");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, "SKILL.md"));
  } catch (e: any) {
    console.warn("[terminal] mc skill install failed:", e?.message ?? e);
  }
}

// The card's lifecycle hooks (term-hooks.ts), for whichever CLI this terminal runs. Idempotent, and a
// failure only costs the card its hook signals — the pty fallback still paints it.
function installCardHooks(backend: string, configDir: string, cursorDir?: string) {
  if (process.env.CHRONOS_TEST) return; // tests spawn with real profile dirs; never rewrite the operator's configs
  try {
    if (backend === "claude-code") installClaudeHooks(configDir);
    else if (backend === "cursor-agent") {
      installCursorHooks(path.join(os.homedir(), ".cursor"));
      if (cursorDir) installCursorHooks(cursorDir);
    } else if (backend === "grok") installGrokHooks(grokHome());
  } catch (e: any) {
    console.warn(`[terminal] ${backend} card hooks install failed:`, e?.message ?? e);
  }
}

// Install the skill into every config dir we know about (workspaces + profile map + default).
function installAllMcSkills() {
  const dirs = new Set<string>();
  for (const w of workspaces.list()) if (w.config_dir) dirs.add(w.config_dir);
  for (const p of Object.values(CONFIG.profiles)) if (p) dirs.add(p);
  const def = CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
  if (def) dirs.add(def);
  for (const d of dirs) installMcSkill(d);
}

// Cursor (and other CLIs) read AGENTS.md from the repo root, not Claude skills. Mirror the
// mission-control skill body into each repo's AGENTS.md so cursor agents get the same MC workflow.
// Kept IN SYNC with skills/mission-control/SKILL.md: regenerated at boot + on every session open.
const AGENTS_BEGIN = "<!-- BEGIN mission-control (auto-generated by Chronos; in sync with the mission-control skill — do not edit) -->";
const AGENTS_END = "<!-- END mission-control -->";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Skill markdown minus its frontmatter — the shared source of truth for both the skill and AGENTS.md.
function mcSkillBody(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "skills", "mission-control", "SKILL.md"), "utf8");
    const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    return (m ? m[1] : raw).trim();
  } catch {
    return "";
  }
}

const execFileAsync = promisify(execFile);

// `git rev-parse --git-path info/exclude` resolves the real per-checkout exclude file whether
// `repoPath` is a normal checkout (returns a path relative to repoPath, e.g. ".git/info/exclude")
// or a worktree (.git is a FILE there — git returns an absolute path into the main repo's
// .git/worktrees/<name>/info/exclude instead). Exported for testing the resolution alone.
export async function gitExcludePath(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const p = stdout.trim();
  return path.isAbsolute(p) ? p : path.join(repoPath, p);
}

// Is this directory inside a git checkout at all? Asked once per sync so the artifact loop below
// doesn't spend a failing subprocess (and a scary log line) per artifact on a plain directory.
// Exported for testing the check alone.
export async function insideGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// Append a local-only ignore (never committed) so a generated AGENTS.md doesn't pollute the repo.
// Never throws: a failure here (not a git repo, git missing, timeout) must not block AGENTS.md sync.
async function gitExcludeLocal(repoPath: string, line: string): Promise<void> {
  try {
    const ex = await gitExcludePath(repoPath);
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
    if (!cur.split("\n").includes(line)) fs.writeFileSync(ex, cur.replace(/\n?$/, "\n") + line + "\n");
  } catch (e: any) {
    // A cwd that is not a checkout is ORDINARY, not a failure: the umbrella directory that holds
    // several repos (~/Documents/GitHub/acme) is a normal place to open a terminal, and there
    // is no exclude file to write there. It logged a two-line git fatal per artifact per session
    // open. Everything else — git missing, a timeout, a read-only .git — still gets said out loud.
    const msg = String(e?.stderr ?? e?.message ?? e);
    if (/not a git repository/i.test(msg)) return;
    console.warn("[terminal] AGENTS.md git-exclude failed:", msg);
  }
}

// Is `rel` tracked by git in this checkout? `--error-unmatch` exits non-zero for an untracked path,
// so every failure mode (untracked, not a repo, git missing, timeout) answers "not tracked" — the
// same permissive answer the pre-existing code gave, which keeps non-git repo dirs working.
//
// Deliberately SYNCHRONOUS, and it must stay that way. execute() (runner.ts) needs this answer to
// assemble append_system, and everything before its `liveSteer.set` registration has to stay
// await-free — dispatch() returns mid-prologue, so a steer arriving during any earlier await
// bounces to the mailbox instead of the queue. Making this a promise hung four steer/park tests.
export function gitTrackedSync(repoPath: string, rel: string): boolean {
  try {
    const out = execFileSync("git", ["-C", repoPath, "ls-files", "--error-unmatch", "--", rel], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// The mission-control workflow as standing system text, for callers that can't use the file mirror
// below (see syncAgentsMd's tracked-file bail-out). Empty string when the skill body is unreadable.
export function mcSystemText(): string {
  return mcSkillBody();
}

// Everything Chronos writes INSIDE a repo working tree. Chronos is a purely local tool: none of it
// may ever reach a repo's history, and `git add -A` (which Chronos itself runs three times on the
// way to a PR, and which humans run constantly) stages untracked files too. So every artifact gets
// a local-only ignore in every repo, refreshed on the same schedule as the AGENTS.md sync.
//
// `.mc/` holds ticket markdown, written under repo.path by resolveFilePath (tickets.ts). It had no
// ignore at all: six of them were committed into the presence repo before this landed.
const CHRONOS_ARTIFACTS = [".mc/"];

// Local-only ignores for Chronos's in-repo artifacts. An artifact that is ALREADY tracked can't be
// fixed from here — `info/exclude` is ignored for paths in the index — so that case is surfaced
// loudly instead of silently doing nothing; it needs a `git rm --cached` in the repo.
export async function excludeChronosArtifacts(repoPath: string): Promise<void> {
  if (!(await insideGitRepo(repoPath))) return; // nothing to exclude from — see gitExcludeLocal
  for (const art of CHRONOS_ARTIFACTS) {
    try {
      if (gitTrackedSync(repoPath, art.replace(/\/$/, ""))) {
        console.warn(
          `[terminal] ${repoPath}: ${art} is TRACKED by the repo — local exclude cannot help. ` +
            `Run: git -C ${repoPath} rm -r --cached ${art}`
        );
        continue;
      }
      await gitExcludeLocal(repoPath, art);
    } catch (e: any) {
      console.warn(`[terminal] ${repoPath}: exclude ${art} failed:`, e?.message ?? e);
    }
  }
}

// Write/refresh the mission-control managed block in <repo>/AGENTS.md, preserving any existing
// content. Called on PTY session open, daemon boot, and (via runner.ts) before every headless build
// spawn — headless runs execute in a git worktree, which never has the untracked AGENTS.md a normal
// checkout accumulates over time.
//
// NEVER touches an AGENTS.md the repo itself tracks. `info/exclude` has no effect on a path already
// in the index, so appending the block to a tracked file is a real modification, and Chronos runs
// `git add -A` in three places on the way to a PR (captureDiff, createForRun, shipPR in reviews.ts)
// — the block shipped into presence's history that way (60a891b) and was one dispatch away from a
// 346-line diff on a client repo's PR. It also left every such shared checkout permanently dirty,
// which is enough on its own to make landCommitDelivery refuse to land. Returns what it did so the
// caller can route the same content through a channel that touches no file (runner.ts).
export async function syncAgentsMd(repoPath: string): Promise<"written" | "skipped-tracked" | "noop"> {
  try {
    if (!repoPath || repoPath === os.homedir() || !fs.existsSync(repoPath)) return "noop";
    // Runs on every call, independent of the AGENTS.md outcome below: this is the one function all
    // three call sites (boot, PTY open, pre-spawn) already share, so it's where the repo-shielding
    // ignores belong. Keeping it above every early return is the point.
    await excludeChronosArtifacts(repoPath);
    const body = mcSkillBody();
    if (!body) return "noop";
    if (gitTrackedSync(repoPath, "AGENTS.md")) return "skipped-tracked";
    const block = `${AGENTS_BEGIN}\n${body}\n${AGENTS_END}`;
    const file = path.join(repoPath, "AGENTS.md");
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    let next: string;
    if (prev.includes(AGENTS_BEGIN) && prev.includes(AGENTS_END)) {
      next = prev.replace(new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}`), block);
    } else if (prev.trim()) {
      next = `${prev.trimEnd()}\n\n${block}\n`; // append; never clobber the repo's own AGENTS.md
    } else {
      next = `${block}\n`;
    }
    if (next !== prev) fs.writeFileSync(file, next);
    // Exclude on EVERY untracked write, not just the first-create it used to guard on: a
    // pre-existing untracked AGENTS.md (a human's scratch copy, or one this daemon wrote before the
    // exclude step existed) was never excluded, so the generated block still showed up in
    // `git status` — and `add -A` stages untracked files too.
    await gitExcludeLocal(repoPath, "AGENTS.md");
    return "written";
  } catch (e: any) {
    console.warn("[terminal] AGENTS.md sync failed:", e?.message ?? e);
    return "noop";
  }
}

async function syncAllAgentsMd() {
  for (const r of repos.list()) if ((r as any).path) await syncAgentsMd((r as any).path);
}

// Install the `mc` agent CLI to ~/.mc/bin (a neutral path the per-workspace sandbox allows). Source
// of truth is scripts/mc in the repo; copy it out so spawned agents can call `mc` via PATH.
function installMcCli() {
  try {
    const src = path.join(process.cwd(), "scripts", "mc");
    if (!fs.existsSync(src)) return;
    const dir = path.join(os.homedir(), ".mc", "bin");
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, "mc");
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  } catch (e: any) {
    console.warn("[terminal] mc CLI install failed:", e?.message ?? e);
  }
}

// Boot: any session row left 'live' is stale (its pty died with the previous daemon). Instead of
// just reaping, RE-SPAWN each one so terminals survive a daemon restart — the row, transcript and
// cwd all persisted, so openSession(resumeId) brings it back live (claude --resumes its transcript;
// bare shells restart in the same cwd). This set is bounded: reapAll runs every boot, so only the
// sessions open when the previous daemon died are ever 'live' here.
export async function startTerminals() {
  ensurePtyHelper();
  installMcCli();
  try {
    const { installRtkRewriteScript } = await import("./efficiency-tools.js");
    installRtkRewriteScript();
  } catch (e: any) {
    console.warn("[terminal] rtk-rewrite install failed:", e?.message ?? e);
  }
  installAllMcSkills();
  await syncAllAgentsMd();
  // Only this machine's: a terminal on another host did not die with this daemon (HOSTS.md,
  // "Reconnect and restarts") and is re-attached, never revived here. All of them, until hosts ship.
  const stale = sessions.list({ status: "live" }).filter((s) => s.host_id === LOCAL_HOST_ID);
  sessions.reapAll(); // clean baseline: everything local → ended; successful revives flip back to live
  let revived = 0, skipped = 0;
  for (const s of stale) {
    // Non-resumable backends can't restore their transcript — reviving just spawns a fresh CLI on the
    // main screen masquerading as the old live session. Leave it ended so the UI shows the truth.
    // Cursor/grok resume a chat pinned to this session id (or, for legacy unpinned grok, the on-disk
    // UUID resolveGrokResumeId finds); older cursor rows with no pin stay ended.
    const b = getBackend(s.backend);
    const resumable = b.supportsResume ||
      (b.pinsSession === true && hasTranscript({
        sessionId: s.id, backend: b.name, cwd: s.cwd, configDir: "", sinceMs: 0,
        cursorConfigDir: workspaceCursorDir(s.workspace_id ? workspaces.get(s.workspace_id) : undefined),
      }));
    if (!resumable) { skipped++; continue; }
    // A resume restores the transcript, not the turn: one that was mid-work comes back at its prompt
    // and stays there. Tell it to continue (revive.ts); one that was waiting or blocked is left alone.
    const seed = reviveSeedFor(lastActivityState(s.id));
    try {
      await openSession({
        resumeId: s.id,
        workspace_id: s.workspace_id, repo_id: s.repo_id, ticket_id: s.ticket_id,
        backend: s.backend, model: s.model, role: s.role, cwd: s.cwd,
        ...(seed ? { seed } : {}),
      });
      revived++;
      if (seed) console.log(`[terminal] revived ${s.id.slice(0, 8)} was working when the daemon died — nudged to continue`);
    } catch (e: any) {
      console.warn(`[terminal] revive ${s.id} failed (stays ended, resumable in UI):`, e?.message ?? e);
    }
  }
  console.log(`[terminal] PTY sessions ready · revived ${revived}/${stale.length} across restart (${skipped} non-resumable left ended) · mc CLI + skill + AGENTS.md installed`);
}
