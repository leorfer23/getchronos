/**
 * Salvage before kill (HOSTS.md → Reconnect and restarts → Salvage). A terminal moved off this host
 * while it was away (src/host-failover.ts) is stopped here when the host comes back — but its worktree
 * may hold what the stand-in on the other computer was told it lost: uncommitted changes, commits
 * never pushed. Before the stop, they go to origin as `wip/<session id8>`.
 *
 * Nothing in the worktree moves: the commit is built on a scratch index (`GIT_INDEX_FILE`) from the
 * working tree as it is, parented on HEAD, and pushed by sha. HEAD, the branch, the real index and the
 * files are exactly as the agent left them. Never a force push, never a push to anything but a new
 * `wip/` branch, never the shared checkout (only a linked worktree — the shared one holds other
 * terminals' work too). `--no-verify`: a repo's pre-push hook (a test suite) must not decide whether
 * the only copy of someone's work leaves a Mac.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { gitLine } from "../worktree-core.js";

export type SalvageResult = {
  /** saved: pushed to `branch`. clean: nothing only this disk had. skipped: nothing to look at. failed: see detail. */
  status: "saved" | "clean" | "skipped" | "failed";
  /** `wip/<id8>` — set when saved, and named when a push failed. */
  branch?: string;
  sha?: string;
  /** The worktree had uncommitted changes (they are in the wip commit). */
  dirty?: boolean;
  /** Commits on HEAD that no origin branch has. */
  ahead?: number;
  /** The branch the worktree was on, or null when detached. */
  from?: string | null;
  dir?: string;
  detail?: string;
};

export const wipBranch = (sessionId: string) => `wip/${String(sessionId).slice(0, 8)}`;

type Run = { code: number; stdout: string; stderr: string };

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? err?.message ?? "").trim() });
    });
  });
}

const firstLine = (s: string) => gitLine(s);

/** Save what only this worktree has to origin as `wip/<id8>`. Never throws. */
export async function salvageWorktree(dir: string, sessionId: string, o: { pushTimeoutMs?: number } = {}): Promise<SalvageResult> {
  const branch = wipBranch(sessionId);
  if (!dir || !fs.existsSync(dir)) return { status: "skipped", detail: "its directory is gone", dir };
  const top = await run(dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { status: "skipped", detail: "not a git checkout", dir };
  const root = top.stdout;
  const gitDir = await run(root, ["rev-parse", "--absolute-git-dir"]);
  const common = await run(root, ["rev-parse", "--git-common-dir"]);
  if (gitDir.code !== 0 || common.code !== 0) return { status: "failed", detail: firstLine(gitDir.stderr || common.stderr), dir: root };
  if (path.resolve(root, common.stdout) === path.resolve(gitDir.stdout)) {
    return { status: "skipped", detail: "it worked in the shared checkout, not a worktree of its own — left as it is", dir: root };
  }
  const head = await run(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) return { status: "skipped", detail: "no commits yet", dir: root };
  if ((await run(root, ["remote", "get-url", "origin"])).code !== 0) return { status: "skipped", detail: "no origin to push to", dir: root };
  const from = (await run(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout || null;
  const st = await run(root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (st.code !== 0) return { status: "failed", detail: `git status: ${firstLine(st.stderr)}`, dir: root, from };
  const dirty = st.stdout.length > 0;
  const aheadR = await run(root, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
  const ahead = aheadR.code === 0 ? Number(aheadR.stdout) || 0 : 0;
  if (!dirty && !ahead) return { status: "clean", dirty, ahead, from, dir: root };

  let sha = head.stdout;
  if (dirty) {
    // A scratch index seeded from the real one (so `add -A` only re-reads what changed), then thrown away.
    const tmpIndex = path.join(os.tmpdir(), `chronos-salvage-${process.pid}-${Date.now().toString(36)}.index`);
    try {
      const idx = await run(root, ["rev-parse", "--git-path", "index"]);
      const real = idx.code === 0 ? path.resolve(root, idx.stdout) : null;
      if (real && fs.existsSync(real)) fs.copyFileSync(real, tmpIndex);
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      // commit-tree needs an identity; a host that never set one still gets its work saved.
      if (!(await run(root, ["config", "user.email"])).stdout) Object.assign(env, { GIT_AUTHOR_NAME: "Chronos", GIT_AUTHOR_EMAIL: "chronos@localhost", GIT_COMMITTER_NAME: "Chronos", GIT_COMMITTER_EMAIL: "chronos@localhost" });
      const add = await run(root, ["add", "-A"], env, 120_000);
      if (add.code !== 0) return { status: "failed", detail: `git add: ${firstLine(add.stderr)}`, dirty, ahead, from, dir: root };
      const tree = await run(root, ["write-tree"], env);
      if (tree.code !== 0) return { status: "failed", detail: `git write-tree: ${firstLine(tree.stderr)}`, dirty, ahead, from, dir: root };
      const msg = `WIP: salvaged from Chronos session ${String(sessionId).slice(0, 8)} after it was moved to another computer`;
      const commit = await run(root, ["commit-tree", tree.stdout, "-p", head.stdout, "-m", msg], env);
      if (commit.code !== 0) return { status: "failed", detail: `git commit-tree: ${firstLine(commit.stderr)}`, dirty, ahead, from, dir: root };
      sha = commit.stdout;
    } finally {
      try { fs.rmSync(tmpIndex, { force: true }); } catch {}
    }
  }
  const push = await run(root, ["push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`], process.env, o.pushTimeoutMs ?? 90_000);
  if (push.code !== 0) return { status: "failed", branch, sha, dirty, ahead, from, dir: root, detail: `git push: ${firstLine(push.stderr)}` };
  return { status: "saved", branch, sha, dirty, ahead, from, dir: root };
}
