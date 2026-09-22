import { spawn } from "node:child_process";
import readline from "node:readline";
import { CONFIG } from "./config.js";
import { sandboxWrap } from "./sandbox.js";
import { childEnv } from "./child-env.js";
import { getBackend } from "./backends/index.js";
import { isCloudBackend } from "./backends/types.js";
import { workspaces } from "./store.js";
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

// LLM-as-judge: a second Claude inspects the goal + the run's result (and may read the
// working dir) and decides whether the goal was actually achieved.
export async function verify(job: Job, resultSummary: string): Promise<Verdict> {
  const ws = job.workspace_id ? workspaces.get(job.workspace_id) : undefined;
  const backend = getBackend(verifierBackendName(ws, job));
  const model = ws?.review_model || CONFIG.defaultModel; // cheap/fast judge (sonnet), not the opus manager
  const profileDir = ws?.config_dir ?? CONFIG.profiles[job.profile] ?? CONFIG.profiles.claude;
  const denyDirs = job.workspace_id ? workspaces.isolationDenyDirs(job.workspace_id) : [];
  const prompt =
    `You are a strict verifier. A job was run by an autonomous agent.\n\n` +
    `GOAL:\n${job.goal}\n\n` +
    `AGENT'S FINAL RESULT:\n${resultSummary || "(none)"}\n\n` +
    `You may use Read/Bash in the working directory (${job.cwd}) to check for produced files or ` +
    `side effects. Decide whether the goal was genuinely achieved. ` +
    `Reply with ONLY a JSON object on the last line: {"met": true|false, "reason": "<short>"}`;

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
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const p = JSON.parse(t);
        // claude/codex: single {type:"result"} line. grok: {type:"text",data} deltas. opencode: {type:"text",part:{text}}.
        if (p.type === "result" && typeof p.result === "string") text = p.result;
        else if (p.type === "text" && typeof p.data === "string") text += p.data;
        else if (p.type === "text" && typeof p.part?.text === "string") text += p.part.text;
      } catch {}
    });
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
