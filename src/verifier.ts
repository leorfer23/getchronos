import { spawn } from "node:child_process";
import readline from "node:readline";
import { CONFIG } from "./config.js";
import { sandboxWrap } from "./sandbox.js";
import { childEnv } from "./child-env.js";
import { getBackend } from "./backends/index.js";
import { isCloudBackend } from "./backends/types.js";
import { repos, workspaces } from "./store.js";
import { findHost } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { tokenizePaths } from "./hosts/proc-spec.js";
import { portableAllow, portableEnv, profileNameFor } from "./hosts/spawn-spec.js";
import { isRemoteDir, type WorkDir } from "./hosts/workdir.js";
import { worktreeRootFor } from "./worktree-core.js";
import os from "node:os";
import type { Job, Workspace } from "./types.js";

export interface Verdict {
  met: boolean;
  reason: string;
  // The judge never actually judged: it was unavailable or its output was unparseable. met is
  // false on these verdicts, but only `strict` mode treats that as blocking — see verdictBlocks.
  inconclusive?: boolean;
}

// Verifier policy (workspace verify_mode, else CONFIG.verifyMode):
//   shadow  — record the verdict, never flip the run. The rollout mode: watch what strict WOULD
//             have blocked before trusting it.
//   enforce — a parseable met:false fails the run; an inconclusive verifier does not (fail-open).
//   strict  — fail-closed: an inconclusive verifier also fails the run.
export type VerifyMode = "shadow" | "enforce" | "strict";

export function resolveVerifyMode(ws: Workspace | undefined): VerifyMode {
  const m = ws?.verify_mode ?? CONFIG.verifyMode;
  if (m === "shadow" || m === "strict" || m === "enforce") return m;
  // Loud, not silent: an unrecognized mode falling back to fail-open would be the exact failure
  // this policy exists to remove. (The API schema rejects bad values; this catches raw-SQL/env ones.)
  console.error(`[verify] unrecognized verify mode "${m}" — falling back to "enforce" (fail-open)`);
  return "enforce";
}

export function verdictBlocks(mode: VerifyMode, verdict: Verdict): boolean {
  if (mode === "shadow") return false;
  if (verdict.met) return false;
  return mode === "strict" || !verdict.inconclusive;
}

/**
 * The verifier is a separate local judge — it spawns its OWN process to read the goal + the run's
 * result, and does not need to be the same backend as the run itself. A cloud run's own backend
 * genuinely has no local process (`oneShot()` is required to throw — see CloudBackend in
 * backends/types.ts), so resolving a cloud job's verifier onto `job.backend` crashed the run at the
 * finish line the instant `job.verify` was on. When the run's backend is cloud, verify on the
 * workspace's `review_backend` instead (falling back to claude-code if that is unset, or itself
 * cloud) — a local backend picking the verdict, same as every other backend already does.
 */
export function verifierBackendName(ws: Workspace | undefined, job: Job): string {
  if (!isCloudBackend(getBackend(job.backend))) return ws?.review_backend || job.backend;
  if (ws?.review_backend && !isCloudBackend(getBackend(ws.review_backend))) return ws.review_backend;
  return "claude-code";
}

// Fold one stdout line of the judge into its answer text.
// claude/codex: single {type:"result"} line. grok: {type:"text",data} deltas. opencode: {type:"text",part:{text}}.
function absorb(text: string, line: string): string {
  const t = line.trim();
  if (!t) return text;
  try {
    const p = JSON.parse(t);
    if (p.type === "result" && typeof p.result === "string") return p.result;
    if (p.type === "text" && typeof p.data === "string") return text + p.data;
    if (p.type === "text" && typeof p.part?.text === "string") return text + p.part.text;
  } catch {}
  return text;
}

// LLM-as-judge: a second Claude inspects the goal + the run's result (and may read the
// working dir) and decides whether the goal was actually achieved. `wd` is where the run ran: on
// another computer (HOSTS.md phase 5) the judge runs THERE, next to the files it has to read.
export async function verify(job: Job, resultSummary: string, wd?: WorkDir): Promise<Verdict> {
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const backend = getBackend(verifierBackendName(ws, job));
  const model = ws?.review_model || CONFIG.defaultModel; // cheap/fast judge (sonnet), not the opus manager
  const profileDir = ws?.config_dir ?? CONFIG.profiles[job.profile] ?? CONFIG.profiles.claude;
  const denyDirs = job.workspace_id ? workspaces.isolationDenyDirs(job.workspace_id) : [];
  const cwd = wd?.cwd ?? job.cwd;
  const prompt =
    `You are a strict verifier. A job was run by an autonomous agent.\n\n` +
    `GOAL:\n${job.goal}\n\n` +
    `AGENT'S FINAL RESULT:\n${resultSummary || "(none)"}\n\n` +
    `You may use Read/Bash in the working directory (${cwd}) to check for produced files or ` +
    `side effects. Decide whether the goal was genuinely achieved. ` +
    `Reply with ONLY a JSON object on the last line: {"met": true|false, "reason": "<short>"}`;

  if (wd && isRemoteDir(wd)) {
    const h = findHost(wd.host_id);
    if (!(h instanceof RemoteHost)) return { met: false, reason: `verifier unavailable: host ${wd.host_id} is not connected`, inconclusive: true };
    const wsRepos = ws ? repos.list(ws.id) : [];
    const { env, rel } = portableEnv(childEnv(ws) as Record<string, string>, os.homedir(), [process.cwd(), profileDir]);
    try {
      const r = await h.oneshot({
        workspace: ws ? { id: ws.id, slug: ws.slug } : null,
        backend: backend.name,
        profile: profileNameFor(ws?.config_dir, CONFIG.profiles, CONFIG.defaultProfile),
        prompt: tokenizePaths(prompt, wsRepos, worktreeRootFor) ?? prompt,
        model,
        allowed_tools: "Read,Bash",
        max_budget_usd: 0.5,
        cwd,
        repos: wsRepos.filter((x) => x.git_remote).map((x) => ({ id: x.id, git_remote: x.git_remote! })),
        sandbox: { mode: job.sandbox, allow: portableAllow(parseAllow(ws?.sandbox_allow), os.homedir()) },
        env,
        env_home_relative: rel,
        timeout_ms: 120_000,
      });
      if (r.timed_out) return { met: false, reason: "verifier timed out", inconclusive: true };
      return parseVerdict(r.stdout.split("\n").reduce(absorb, ""));
    } catch (e: any) {
      return { met: false, reason: `verifier unavailable: ${e?.message ?? e}`, inconclusive: true };
    }
  }

  const spec = backend.oneShot({ prompt, model, configDir: profileDir, cwd: job.cwd, allowedTools: "Read,Bash", maxBudgetUsd: 0.5 });

  let addDirs: string[] = [];
  try {
    if (job.add_dirs) addDirs = JSON.parse(job.add_dirs);
  } catch {}
  const { cmd, cmdArgs } = sandboxWrap(job.sandbox, job.cwd, addDirs, profileDir, denyDirs, spec.cmd, spec.args);

  return new Promise<Verdict>((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: job.cwd,
      env: { ...childEnv(ws), ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    let text = "";
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => { text = absorb(text, line); });
    child.on("close", () => {
      clearTimeout(watchdog);
      resolve(timedOut ? { met: false, reason: "verifier timed out", inconclusive: true } : parseVerdict(text));
    });
    child.on("error", () => {
      clearTimeout(watchdog);
      resolve({ met: false, reason: "verifier unavailable", inconclusive: true });
    });
  });
}

export function parseVerdict(text: string): Verdict {
  // The prompt asks for the verdict on the LAST line, and the judge may echo the prompt's own
  // {"met": true|false, …} template in earlier prose — so take the last PARSEABLE candidate, not
  // the first match (which under strict mode would fail a genuinely passing run as unparseable).
  const candidates = [...text.matchAll(/\{[^{}]*"met"[^{}]*\}/gs)];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(candidates[i][0]);
      return { met: !!o.met, reason: String(o.reason ?? "").slice(0, 500) };
    } catch {}
  }
  return { met: false, reason: "verifier output unparseable", inconclusive: true };
}

function parseAllow(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
