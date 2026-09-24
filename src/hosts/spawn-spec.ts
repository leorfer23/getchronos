import path from "node:path";
import type { SandboxMode } from "../sandbox.js";

// HOSTS.md → "SpawnSpec: intent, not paths". What the brain sends a remote host to open a terminal.
//
// The rule it exists to enforce: the brain never sends a host an absolute path it made up. Homes
// differ between Macs (`/Users/alice` vs `/Users/a.smith`), checkouts live in different folders, and
// a profile is `~/.claude-medialab` on one and absent on another. So the spec names things — a repo
// by its git remote, a profile by its NAME, a worktree by its branch — and the host works out where
// each one is on its own disk (src/hostd/terminals.ts).
//
// Pure: no store, no fs. Built on the brain by terminal.ts, read on the host. Both sides import it.

export type CwdHint = "repo" | "worktree" | "home" | "landing";

export interface SpawnSpec {
  kind: "intent";
  session_id: string;
  workspace: { id: string; slug: string } | null;
  /** Canonical backend name (`claude-code`, `cursor-agent`, `grok`, …). The host has its own registry. */
  backend: string;
  model: string | null;
  role: string;
  /** The id the CLI files its transcript under (claude/cursor/grok pin it), or null. */
  cli_session: string | null;
  /** Reopen `cli_session`'s transcript (`--resume`) instead of starting it fresh. */
  resume: boolean;
  /** The repo this terminal is for, by remote. The host finds its own clone (or refuses). */
  repo: { id: string; git_remote: string } | null;
  /** Every repo of the workspace: add-dirs (+ their worktree roots) and read-only main checkouts. */
  repos: Array<{ id: string; git_remote: string }>;
  /** A ticket terminal's isolated worktree, created under the host's own `.chronos-worktrees`. */
  worktree: { branch: string; base: string } | null;
  /**
   * Only on resume: the directory this row ran in, which the HOST reported when it first spawned it
   * (claude files transcripts per cwd, so a resume must start there). Never a brain path.
   */
  resume_cwd: string | null;
  cwd_hint: CwdHint;
  /** Profile NAME (`claude`, `claude-medialab`); the host maps it to its own directory. */
  profile: string;
  sandbox: { mode: SandboxMode; allow: string[]; egress_locked: boolean };
  /** Standing system text for CLIs with a system-prompt channel (content, not paths). */
  system: string | null;
  /**
   * Secrets + workspace vars + `mc` identity ONLY. The host supplies HOME/USER/PATH/TMPDIR/SHELL/
   * LANG, the profile env (CLAUDE_CONFIG_DIR…), and MC_API pointing at its own forwarder.
   */
  env: Record<string, string>;
  /** Keys of `env` whose values are `~/…` (colon lists allowed): the host expands `~` to ITS home. */
  env_home_relative: string[];
  nice: number;
  cols: number;
  rows: number;
  /** Type-then-Enter runs host-side, next to the pty, so link jitter cannot split text from Enter. */
  seed: { text: string; enter_after_ms: number } | null;
}

/** Env keys the HOST supplies. A brain value for any of these is a brain path or brain identity. */
export const HOST_BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ", "COLORTERM", "MC_API"] as const;

const isUnder = (p: string, dir: string) => !!dir && (p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/"));

/**
 * A brain-side value made portable: every `:`-separated segment under the brain's home becomes
 * `~/…`. `changed` says whether the host must expand it. Other absolute paths (`/opt/homebrew/bin`)
 * are machine-wide and pass as they are.
 */
export function homeRelative(value: string, brainHome: string): { value: string; changed: boolean } {
  let changed = false;
  const out: string[] = [];
  for (const seg of value.split(":")) {
    if (isUnder(seg, brainHome)) {
      out.push(seg === brainHome ? "~" : "~/" + seg.slice(brainHome.replace(/\/$/, "").length + 1));
      changed = true;
    } else out.push(seg);
  }
  return { value: out.join(":"), changed };
}

/** Host side: expand `~` / `~/…` segments of the listed keys to this machine's home. */
export function expandHomeRelative(env: Record<string, string>, keys: readonly string[], home: string): Record<string, string> {
  const out = { ...env };
  for (const k of keys) {
    const v = out[k];
    if (typeof v !== "string") continue;
    out[k] = v.split(":").map((s) => (s === "~" ? home : s.startsWith("~/") ? path.join(home, s.slice(2)) : s)).join(":");
  }
  return out;
}

/**
 * The profile NAME for a workspace's config dir: the entry in the brain's profile map whose dir it is,
 * else the conventional name of a `~/.claude-<x>` dir (`claude-x`), else the default. Hosts discover
 * profiles by the same convention (config.ts discoverProfiles), so the name is what both sides share.
 */
export function profileNameFor(configDir: string | null | undefined, profiles: Record<string, string>, fallback: string): string {
  if (!configDir) return fallback;
  const norm = (p: string) => p.replace(/\/+$/, "");
  for (const [name, dir] of Object.entries(profiles)) if (dir && norm(dir) === norm(configDir)) return name;
  const base = path.basename(norm(configDir));
  if (base === ".claude") return "claude";
  if (base.startsWith(".claude-")) return base.slice(1);
  return fallback;
}

export type RemoteSpecInput = {
  sessionId: string;
  workspace: { id: string; slug: string } | null;
  backend: string;
  model: string | null;
  role: string;
  cliSession: string | null;
  resume: boolean;
  repo: { id: string; git_remote: string | null } | null;
  wsRepos: Array<{ id: string; git_remote: string | null }>;
  worktree: { branch: string; base: string } | null;
  resumeCwd: string | null;
  profile: string;
  sandbox: { mode: SandboxMode; allowRaw: string[]; egressLocked: boolean };
  system: string | null;
  /** Everything the brain computed for a LOCAL spawn's env; filtered here. */
  env: Record<string, string>;
  nice: number;
  cols: number;
  rows: number;
  seed: string | null;
  seedEnterMs: number;
  /** The brain's own home — every value under it becomes `~/…`. */
  brainHome: string;
  /** Brain paths OUTSIDE its home that must never reach a host (the chronos checkout, a data dir). */
  brainPaths?: string[];
};

/**
 * Build a SpawnSpec from what the brain already knows. Drops anything the host must supply and every
 * value that is a brain path it cannot translate; returns the dropped KEYS (never values) so the
 * caller can log what a remote terminal will not get.
 */
export function buildRemoteSpawnSpec(i: RemoteSpecInput): { spec: SpawnSpec; dropped: string[] } {
  const env: Record<string, string> = {};
  const rel: string[] = [];
  const dropped: string[] = [];
  const base = new Set<string>(HOST_BASE_ENV);
  for (const [k, v] of Object.entries(i.env)) {
    if (base.has(k) || typeof v !== "string") continue;
    const r = homeRelative(v, i.brainHome);
    // Still names a brain-only path (under the checkout, say): meaningless on a host — dropped.
    if ((i.brainPaths ?? []).some((p) => p && !isUnder(p, i.brainHome) && r.value.includes(p))) { dropped.push(k); continue; }
    env[k] = r.value;
    if (r.changed) rel.push(k);
  }
  // sandbox_allow is only ever honoured inside $HOME (sandbox.ts workspaceSandboxAllow), so every
  // entry can travel as `~/…` and be re-resolved against the host's home. Anything else is dropped.
  const allow = i.sandbox.allowRaw
    .map((a) => (a.startsWith("~") ? a : homeRelative(a, i.brainHome).changed ? homeRelative(a, i.brainHome).value : null))
    .filter((a): a is string => !!a);
  const withRemote = (r: { id: string; git_remote: string | null }) => (r.git_remote ? { id: r.id, git_remote: r.git_remote } : null);
  const repo = i.repo ? withRemote(i.repo) : null;
  const spec: SpawnSpec = {
    kind: "intent",
    session_id: i.sessionId,
    workspace: i.workspace,
    backend: i.backend,
    model: i.model,
    role: i.role,
    cli_session: i.cliSession,
    resume: i.resume,
    repo,
    repos: i.wsRepos.map(withRemote).filter((r): r is { id: string; git_remote: string } => !!r),
    worktree: repo ? i.worktree : null,
    resume_cwd: i.resume ? i.resumeCwd : null,
    // Where to land when there is no (usable) resume_cwd. The host reads the fields themselves; the
    // hint is what the Desk and logs show.
    cwd_hint: repo && i.worktree ? "worktree" : repo ? "repo" : "landing",
    profile: i.profile,
    sandbox: { mode: i.sandbox.mode, allow, egress_locked: i.sandbox.egressLocked },
    system: i.system,
    env,
    env_home_relative: rel,
    nice: i.nice,
    cols: i.cols,
    rows: i.rows,
    seed: i.seed ? { text: i.seed, enter_after_ms: i.seedEnterMs } : null,
  };
  return { spec, dropped };
}

/**
 * Every string in `spec` that contains one of the brain's own paths. The guard behind HOSTS.md's rule,
 * run before every remote spawn (and asserted in tests): a non-empty answer means a brain path leaked.
 * `system`/`seed` are prose the agent reads, not paths the host acts on, so they are not scanned.
 */
export function brainPathsIn(spec: SpawnSpec, brainPaths: string[]): string[] {
  const needles = brainPaths.filter((p) => p && p !== "/" && path.isAbsolute(p));
  const hits: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      for (const n of needles) if (v.includes(n)) hits.push(`${at}: ${n}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  // resume_cwd is the one path allowed: the host reported it (it is the host's, even when two Macs
  // share a username and so a home path).
  const { system: _s, seed: _d, resume_cwd: _r, ...rest } = spec;
  walk(rest, "");
  return hits;
}

export function isSpawnSpec(v: unknown): v is SpawnSpec {
  return !!v && typeof v === "object" && (v as any).kind === "intent" && typeof (v as any).session_id === "string";
}
