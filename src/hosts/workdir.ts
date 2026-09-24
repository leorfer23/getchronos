/**
 * The ship pipeline's directory, wherever it lives (HOSTS.md → "The ship pipeline on a host", phase 5).
 *
 * Gates, the review diff, the review commit, the mergeability check, `git push` and `gh pr create`
 * all work IN the build's worktree, and since phase 5 that worktree may be on another computer. A
 * `WorkDir` is that directory with its owner. `execIn` runs a command there: on the brain it is the
 * very execFile call these modules always made; on a host it is the `exec` rpc, which runs the same
 * command in the host's own path space with the host enforcing the timeout — so a dropped link cannot
 * leave a runaway gate, and gh runs with the host's own login for that workspace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileTimed } from "../exec.js";
import { hosts, repoCheckouts, workspaces } from "../store.js";
import type { ExecResult } from "../hostlink/wire.js";
import type { Job, Repo, Run } from "../types.js";
import type { CmdRunner, ShellRunner } from "../gates.js";
import { findHost, LOCAL_HOST_ID } from "./index.js";
import { RemoteHost } from "./remote.js";
import { portableEnv } from "./spawn-spec.js";

export type WorkDir = { host_id: string; cwd: string };

export const isRemoteDir = (wd: WorkDir): boolean => !!wd.host_id && wd.host_id !== LOCAL_HOST_ID;

/**
 * Where a job's work is: the run's own record when it ran on another computer (the host reported its
 * cwd), else a job pinned to a host (its cwd is a path there), else the brain and the job's cwd.
 */
export function workDirOf(job: Pick<Job, "cwd"> & { host_id?: string | null }, run?: Pick<Run, "host_id"> & { cwd?: string | null } | null): WorkDir {
  if (run?.host_id && run.host_id !== LOCAL_HOST_ID) return { host_id: run.host_id, cwd: run.cwd || job.cwd };
  if (job.host_id && job.host_id !== LOCAL_HOST_ID) return { host_id: job.host_id, cwd: job.cwd };
  return { host_id: LOCAL_HOST_ID, cwd: job.cwd };
}

/** A repo's main checkout on the computer a WorkDir is on (the brain's `repos.path`, or the host's row). */
export function checkoutOn(hostId: string, repo: Pick<Repo, "id" | "path">): string | null {
  if (!hostId || hostId === LOCAL_HOST_ID) return repo.path || null;
  return repoCheckouts.forHost(hostId).find((c) => c.repo_id === repo.id)?.path ?? null;
}

/** Is this WorkDir the repo's SHARED checkout (never `git add -A` there) rather than a worktree? */
export function isSharedCheckout(wd: WorkDir, repo: Pick<Repo, "id" | "path"> | undefined | null): boolean {
  if (!repo) return false;
  const main = checkoutOn(wd.host_id, repo);
  // Unknown on that host = assume shared: the safe answer for anything about to commit.
  if (!main) return true;
  return path.resolve(main) === path.resolve(wd.cwd);
}

export type ExecOpts = {
  env?: NodeJS.ProcessEnv | Record<string, string>;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Which end of long output to keep when it is capped (remote only; locally maxBuffer applies). */
  keep?: "head" | "tail";
  /** Whose work this is — a host checks it against its veto before running anything. */
  workspaceId?: string | null;
};

/** An execFile-shaped failure: `.code`, `.stdout`, `.stderr`, `.killed`, like Node's own. */
function execError(r: ExecResult, what: string): Error {
  const e: any = new Error(r.error ? `${what}: ${r.error}` : `${what} exited ${r.code ?? r.signal ?? "?"}${r.stderr ? `: ${r.stderr.trim().slice(-500)}` : ""}`);
  e.code = r.error?.startsWith("cwd_missing") ? "ENOENT" : r.code;
  e.signal = r.signal;
  e.stdout = r.stdout;
  e.stderr = r.stderr;
  e.killed = r.timed_out;
  return e;
}

function remoteOf(wd: WorkDir): RemoteHost {
  const h = findHost(wd.host_id);
  if (!(h instanceof RemoteHost)) throw new Error(`unknown host \`${wd.host_id}\` — not connected to this brain`);
  return h;
}

function hostSpec(wd: WorkDir, o: ExecOpts) {
  const ws = o.workspaceId ? workspaces.get(o.workspaceId) : undefined;
  // Secrets and workspace vars only: the host supplies its own PATH/HOME, and a brain path in a value
  // (a secrets file under the chronos checkout) is dropped rather than pointed at on another disk.
  const { env, rel } = portableEnv(Object.fromEntries(Object.entries(o.env ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>, os.homedir(), [process.cwd()]);
  return { workspace: ws ? { id: ws.id, slug: ws.slug } : null, cwd: wd.cwd, env, env_home_relative: rel };
}

/**
 * Run `cmd args` in a WorkDir. Resolves `{stdout, stderr}`; rejects like execFile on a non-zero exit,
 * a timeout (`killed`) or a missing directory (`code: "ENOENT"`).
 */
export async function execIn(wd: WorkDir, cmd: string, args: string[], o: ExecOpts = {}): Promise<{ stdout: string; stderr: string }> {
  if (!isRemoteDir(wd)) {
    return execFileTimed(cmd, args, {
      cwd: wd.cwd,
      ...(o.env ? { env: o.env as NodeJS.ProcessEnv } : {}),
      ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
      ...(o.maxBuffer ? { maxBuffer: o.maxBuffer } : {}),
    });
  }
  const r = await remoteOf(wd).exec({
    ...hostSpec(wd, o), cmd, args,
    timeout_ms: o.timeoutMs ?? 15_000,
    ...(o.maxBuffer ? { max_bytes: o.maxBuffer } : {}),
    keep: o.keep ?? "head",
  });
  if (r.error || r.code !== 0) throw execError(r, `${cmd} on ${hostName(wd.host_id)}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * The gate runners gates.ts takes (it stays store-free: a host imports it for withRuntimePath). Null on
 * the brain — gates.ts then runs exactly as it always did. On a host, the gate's shell line goes through
 * `exec {shell}`, which applies withRuntimePath to the HOST's env: the brain's PATH means nothing there.
 */
export function gateRunners(wd: WorkDir, workspaceId: string | null | undefined): { shell: ShellRunner; cmd: CmdRunner } | null {
  if (!isRemoteDir(wd)) return null;
  return {
    shell: async (line, o) => {
      const r = await remoteOf(wd).exec({
        ...hostSpec(wd, { env: o.env, workspaceId }), shell: line,
        timeout_ms: o.timeoutMs, max_bytes: o.maxBuffer, keep: "tail",
      });
      if (r.error || r.code !== 0) throw execError(r, `gate on ${hostName(wd.host_id)}`);
      return { stdout: r.stdout, stderr: r.stderr };
    },
    cmd: (cmd, args, o) => execIn(wd, cmd, args, { env: o.env, timeoutMs: o.timeoutMs, maxBuffer: o.maxBuffer, workspaceId }),
  };
}

/** Does the WorkDir still exist? A host is asked (a worktree pruned there reads as gone here too). */
export async function workDirExists(wd: WorkDir, workspaceId?: string | null): Promise<boolean> {
  if (!isRemoteDir(wd)) return fs.existsSync(wd.cwd);
  try {
    await execIn(wd, "git", ["rev-parse", "--git-dir"], { workspaceId, timeoutMs: 10_000 });
    return true;
  } catch (e: any) {
    // Only a directory the host says is gone counts as gone; a host that is offline is not a verdict.
    if (e?.code === "ENOENT") return false;
    if (/offline|unknown host/.test(String(e?.message))) throw e;
    return true;
  }
}

export const hostName = (id: string): string => hosts.get(id)?.name || id;
