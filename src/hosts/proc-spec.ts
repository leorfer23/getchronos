import path from "node:path";
import type { SandboxMode } from "../sandbox.js";
import type { EgressPolicy } from "../egress-core.js";
import { portableAllow, portableEnv } from "./spawn-spec.js";

// HOSTS.md phase 5: a headless run on another computer. The ProcSpec is to `spawn_proc` what the
// SpawnSpec is to `spawn_pty` — intent, not paths — with one difference the task allows: the run's
// goal, system text and trigger context are PROSE the brain composes (tickets.ts, reviews.ts…), and
// that prose names brain paths ("read the ticket at /Users/leo/…/repo/.mc/tickets/PER-7.md", "you are
// in a worktree at …"). Those are rewritten here into tokens the host expands against its OWN paths:
//
//   {{chronos:repo:<repo id>}}    → the host's checkout of that repo
//   {{chronos:wtroot:<repo id>}}  → that checkout's `.chronos-worktrees` root
//
// Anything path-shaped the task prose (goal, trigger context) still names afterwards is a file only the
// brain has, and a run that needs one stays on the brain (brainOnlyPathsIn → placement). The host builds the CLI's argv itself
// from the pseudo-job below with its own backend registry, so no --add-dir, profile dir or binary path
// the brain resolved ever crosses the link.
//
// Pure: no store, no fs. Built on the brain by runner.ts, read by the host (hostd/procs.ts).

export const TOKEN_RE = /\{\{chronos:(repo|wtroot):([A-Za-z0-9-]{1,64})\}\}/g;

export interface ProcSpec {
  kind: "proc";
  run_id: string;
  workspace: { id: string; slug: string } | null;
  /** Canonical backend name; the host resolves its own binary. */
  backend: string;
  /** Profile NAME; the host maps it to its own directory. */
  profile: string;
  /** What the backend's buildArgs/steerArgs read off a Job — prose (tokenized), never a path. */
  job: {
    name: string;
    goal: string;
    append_system: string | null;
    model: string | null;
    allowed_tools: string | null;
    disallowed_tools: string | null;
    max_budget_usd: number | null;
  };
  /** Trigger context (tokenized prose). */
  context: string | null;
  /** The fresh CLI session id (--session-id). */
  session_id: string;
  /** Reopen this CLI session's transcript (--resume) — only one that ran on THIS host. */
  resume: string | null;
  /** Steer mode: goal over stdin, stdin kept open for operator messages. */
  steer: boolean;
  /** The run's repo, by remote; the host finds its own clone. */
  repo: { id: string; git_remote: string } | null;
  /** Every workspace repo (add-dirs, token expansion). */
  repos: Array<{ id: string; git_remote: string }>;
  /**
   * A directory the HOST reported (a ticket worktree it created with `worktree_ensure`), when the job
   * is pinned to it; null = the checkout root of `repo`. Never a brain path.
   */
  cwd: string | null;
  sandbox: { mode: SandboxMode; allow: string[]; egress_locked: boolean };
  egress: EgressPolicy | null;
  env: Record<string, string>;
  env_home_relative: string[];
  nice: number;
  /** The run's own timeout; the host enforces it (plus a grace) even with no link to the brain. */
  timeout_ms: number;
  /**
   * Brain-only files the run reads, delivered: today the ticket markdown, which lives in the brain's
   * checkout under `.mc/tickets/` (gitignored). Written under the host's checkout of `repo_id`.
   */
  files: Array<{ repo_id: string; rel: string; content: string }>;
}

export function isProcSpec(v: unknown): v is ProcSpec {
  return !!v && typeof v === "object" && (v as any).kind === "proc" && typeof (v as any).run_id === "string";
}

const BOUNDARY = "(?=$|[\\s/'\"`),:;\\]}>.])";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Brain paths → tokens, longest first so a worktree root never loses to the checkout it sits beside. */
export function tokenizePaths(text: string | null, repos: Array<{ id: string; path: string | null | undefined }>, wtRootFor: (p: string) => string): string | null {
  if (!text) return text;
  const pairs: Array<[string, string]> = [];
  for (const r of repos) {
    if (!r.path || !path.isAbsolute(r.path)) continue;
    pairs.push([wtRootFor(r.path), `{{chronos:wtroot:${r.id}}}`]);
    pairs.push([r.path.replace(/\/+$/, ""), `{{chronos:repo:${r.id}}}`]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [p, tok] of pairs) out = out.replace(new RegExp(escapeRe(p) + BOUNDARY, "g"), tok);
  return out;
}

/** Host side: tokens → this Mac's paths. A repo this Mac does not have reads as such, not as a path. */
export function expandPathTokens(text: string | null, repos: Map<string, string>, wtRootFor: (p: string) => string): string | null {
  if (!text) return text;
  return text.replace(TOKEN_RE, (_m, kind: string, id: string) => {
    const p = repos.get(id);
    if (!p) return `(a repo that is not checked out on this computer)`;
    return kind === "wtroot" ? wtRootFor(p) : p;
  });
}

/**
 * Absolute paths under any of `roots` still named in `text` — after tokenizing, the files only the
 * brain has. Unique, each cut at the first character that cannot be part of a path.
 */
export function brainOnlyPathsIn(text: string | null | undefined, roots: string[]): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const root of roots) {
    const r = root.replace(/\/+$/, "");
    if (!r || r === "/" || !path.isAbsolute(r)) continue;
    const re = new RegExp(escapeRe(r) + "(?:/[^\\s'\"`),;\\]}>]*)?" + BOUNDARY, "g");
    for (const m of text.matchAll(re)) hits.add(m[0].replace(/[.:]+$/, ""));
  }
  return [...hits];
}

export type ProcSpecInput = {
  runId: string;
  workspace: { id: string; slug: string } | null;
  backend: string;
  profile: string;
  job: ProcSpec["job"];
  context: string | null;
  sessionId: string;
  resume: string | null;
  steer: boolean;
  repo: { id: string; git_remote: string | null } | null;
  /** Workspace repos WITH their brain paths — the paths are only used to tokenize, never sent. */
  wsRepos: Array<{ id: string; git_remote: string | null; path: string | null }>;
  hostCwd: string | null;
  sandbox: { mode: SandboxMode; allowRaw: string[]; egressLocked: boolean };
  egress: EgressPolicy | null;
  env: Record<string, string>;
  nice: number;
  timeoutMs: number;
  files: ProcSpec["files"];
  brainHome: string;
  /** Brain paths outside its home that must never reach a host (the chronos checkout, a data dir). */
  brainPaths?: string[];
  wtRootFor: (p: string) => string;
};

/**
 * Build a ProcSpec. Returns the env KEYS it dropped (brain-only values; never the values) and the
 * brain paths the prose still names after tokenizing — the caller refuses to send a run with those.
 */
export function buildRemoteProcSpec(i: ProcSpecInput): { spec: ProcSpec; dropped: string[]; brainOnly: string[] } {
  const { env, rel, dropped } = portableEnv(i.env, i.brainHome, i.brainPaths ?? []);
  const tok = (t: string | null) => tokenizePaths(t, i.wsRepos, i.wtRootFor);
  const withRemote = (r: { id: string; git_remote: string | null }) => (r.git_remote ? { id: r.id, git_remote: r.git_remote } : null);
  const job = { ...i.job, goal: tok(i.job.goal) ?? "", append_system: tok(i.job.append_system) };
  const context = tok(i.context);
  const roots = [i.brainHome, ...(i.brainPaths ?? [])];
  // The TASK prose only: the goal and its trigger context are what the run must act on. Standing system
  // text (memos, the skill index) mentions paths in passing — a remembered fact naming a brain folder
  // must not pin every run of a workspace to the brain.
  const prose = [job.goal, context].filter(Boolean).join("\n");
  // A host-reported cwd may legitimately look like a brain path (two Macs, one username): not a leak.
  const brainOnly = brainOnlyPathsIn(i.hostCwd ? prose.split(i.hostCwd).join("") : prose, roots);
  const spec: ProcSpec = {
    kind: "proc",
    run_id: i.runId,
    workspace: i.workspace,
    backend: i.backend,
    profile: i.profile,
    job,
    context,
    session_id: i.sessionId,
    resume: i.resume,
    steer: i.steer,
    repo: i.repo ? withRemote(i.repo) : null,
    repos: i.wsRepos.map(withRemote).filter((r): r is { id: string; git_remote: string } => !!r),
    cwd: i.hostCwd,
    sandbox: { mode: i.sandbox.mode, allow: portableAllow(i.sandbox.allowRaw, i.brainHome), egress_locked: i.sandbox.egressLocked },
    egress: i.egress,
    env,
    env_home_relative: rel,
    nice: i.nice,
    timeout_ms: i.timeoutMs,
    files: i.files,
  };
  return { spec, dropped, brainOnly };
}

/**
 * Every string in the NON-prose part of a ProcSpec that contains one of the brain's paths — the
 * HOSTS.md rule, checked before every remote run the way brainPathsIn checks a terminal. Prose was
 * tokenized (brainOnly covers what is left), `cwd` is the host's own, file bodies are content.
 */
export function brainPathsInProc(spec: ProcSpec, brainPaths: string[]): string[] {
  const needles = brainPaths.filter((p) => p && p !== "/" && path.isAbsolute(p));
  const hits: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      for (const n of needles) if (v.includes(n)) hits.push(`${at}: ${n}`);
    } else if (Array.isArray(v)) v.forEach((x, k) => walk(x, `${at}[${k}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
  };
  const { job: _j, context: _c, cwd: _d, files, ...rest } = spec;
  walk(rest, "");
  walk(files.map((f) => ({ repo_id: f.repo_id, rel: f.rel })), "files");
  return hits;
}

/**
 * `oneshot` rpc: a single non-interactive prompt run by the host with its own binary and profile —
 * the verifier judging a run that happened in a worktree on that host. Its prompt quotes the goal,
 * so it is tokenized like one and expanded against `repos` there.
 */
export interface OneshotSpec {
  workspace: { id: string; slug: string } | null;
  backend: string;
  profile: string;
  prompt: string;
  model: string | null;
  allowed_tools: string | null;
  max_budget_usd: number | null;
  /** A directory the host reported (the run's cwd). */
  cwd: string;
  repos: Array<{ id: string; git_remote: string }>;
  sandbox: { mode: SandboxMode; allow: string[] };
  env: Record<string, string>;
  env_home_relative: string[];
  timeout_ms: number;
}

export type OneshotResult = { stdout: string; code: number | null; timed_out: boolean };

/** `worktree_ensure` rpc: create (or reuse) a ticket worktree under the host's own checkout. */
export type WorktreeEnsureArgs = { workspace: { id: string; slug: string } | null; git_remote: string; branch: string; base: string };
