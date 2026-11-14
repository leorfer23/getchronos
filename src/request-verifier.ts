/**
 * The verifier: "ready for his yes" is decided by code and evidence, never by the terminal's own claim
 * (LEDGER.md → Verifier). When a terminal hands off asking for a merge, a review or a deploy, or leaves
 * a draft, the daemon checks that request — in the workspace that owns it, with that workspace's own
 * credentials, sandbox and review engine — writes every check to `request_checks` with its evidence and
 * the target it ran against, and binds the PR's head commit onto the deliverable.
 *
 *   any PR      pr_ready         open, not a draft, no conflict, not behind its base, CI not red (gh, read-only)
 *               tests            the repo's own check command (repos.gate_cmds) re-run at the PR head, in the
 *                                terminal's worktree, through the workspace sandbox, under a heavy slot and nice —
 *                                skip (never pass) when none is configured; the output is kept on the check
 *               matches_request  a second reader (another model than the writer), given his words and the goal:
 *                                "does this do what was asked, what could it break?" — a `review:` run, read-only,
 *                                no Bash, so it can neither write, post, nor park on an ask (CLAUDE.md gotcha 3)
 *               code_review      an engine that did not write it reads the full diff once per head, with the repo's
 *                                review memory and the operator's corrections; its findings go back as a round, each
 *                                fixed or justified on the hand-off (src/code-review.ts, src/repo-memory.ts)
 *               data_diff        a PR that changes models, SQL or transforms in a data repo: before/after rows and key
 *                                aggregates, the commands, the model's tests run, big swings explained; `na`
 *                                anywhere else (src/data-diff.ts)
 *   pr (backend) goal_test        a test changed in the diff; skip when it cannot be judged
 *   ui           shots            before/after per screen at phone and desktop width — none is a fail
 *                walkthrough      the flow shown step by step (`mc show`)
 *   analysis/qa  queries · crosscheck · assumptions / exercised · repro_steps — the reader's judgement; the
 *                                analysis three only when the answer states figures from data (`na` otherwise:
 *                                decided from its text when it is all on file, else the reader's "n/a: why")
 *   drafts       draft_bound      the words on file re-hashed with ledger-model.ts draftHash (the same formula
 *                                `mc hook` uses) and bound, or matched against what the hook bound
 *
 * A fail the terminal can fix goes back to it, typed into its terminal (at most two rounds); after that
 * the request surfaces as not ready with the reason. A check run against an older PR head no longer
 * counts (ledger.ts queueView judges only checks on the item's current target): when the head moves the
 * sweep re-binds it, and the old passes go stale until the next pass.
 *
 * Never: a merge, a send, a deploy, a PR comment, a post. Every gh call here is a read.
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { childEnv, ghReadEnv } from "./child-env.js";
import { parseGates, runGates, withRuntimePath, type ShellRunner } from "./gates.js";
import { acquireSlot, beatSlot, niceWrap, releaseSlot } from "./machine.js";
import { prBelongsTo, slugOfPr, slugOfRemote } from "./pr-ownership.js";
import { sandboxWrap, workspaceSandboxAllow, type SandboxMode } from "./sandbox.js";
import { clampSandbox } from "./spawn-guard.js";
import { setting, settingOn } from "./settings.js";
import { jobs, kv, repos, runs, sessions, workspaces } from "./store.js";
import { codeReviews, type CodeReviewRow } from "./store/review-memory.js";
import { codeReviewPrompt, judgeCodeReview, mergeFindings, parseCodeReview, resolutionsIn, type Finding } from "./code-review.js";
import { dataRepoOf, judgeDataDiff } from "./data-diff.js";
import { operatorNotes, repoMemoryFor } from "./repo-memory.js";
import { requests, type DecisionItem, type Deliverable, type RequestRow, type VerificationRow } from "./store/requests.js";
import { FINAL_DELIVERABLE, draftHash, slotsFor, type CheckName, type Evidence } from "./ledger-model.js";
import { itemReadiness } from "./ledger.js";
import {
  MAX_ROUNDS, answerFigures, judgeAspects, judgeGoalTest, judgePr, judgeShots, judgeWalkthrough, parseReview, pickReviewer, reviewerPrompt, tellLine,
  type CheckResult, type PrView, type ReviewInput, type ReviewVerdict,
} from "./verify-model.js";
import type { GateResult, Outcome, Repo, Session, Workspace } from "./types.js";

const execFileAsync = promisify(execFile);
const iso = () => new Date().toISOString();
const one = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Who writes the checks (request_checks.ran_by). */
export const RAN_BY = "verifier";
const DIFF_CAP = 60_000;
/** The code reviewer reads the whole diff up to this; past it, the rest from the files in its worktree. */
const CODE_DIFF_CAP = 150_000;
const OUTPUT_CAP = 4_000;
/** Passes running at once, machine-wide. Each may hold a heavy slot and a reviewer run. */
const MAX_ACTIVE = 2;
/** A hand-off often raises several items in one event burst: wait this long, then judge them together. */
let DELAY_MS = 5_000;
const SWEEP_MS = 3 * 60_000;
const SINCE_KEY = "verifier.since";

// ───────────────────────────── what it reads the world through (injectable for tests) ─────────────────────────────

export type PrRead = PrView & { files: string[] | null; ci: "pending" | "passing" | "failing" | null; failing: string[]; passing?: string[] };
export type ReviewRun = { text: string | null; run_id: string | null; status: string; error?: string | null };
export type VerifierDeps = {
  /** gh pr view, read-only, with the daemon's read env for this workspace (child-env.ts ghReadEnv). */
  prRead(ws: Workspace, url: string): Promise<PrRead>;
  /** Commits on the base the head does not have; null = could not compare. */
  behindBy(ws: Workspace, url: string, base: string, head: string): Promise<number | null>;
  prDiff(ws: Workspace, url: string): Promise<string | null>;
  /** HEAD and whether the tree has uncommitted changes, in the terminal's worktree. */
  gitState(ws: Workspace, cwd: string): Promise<{ head: string | null; dirty: boolean }>;
  /** The repo's gates, run in `cwd` through the workspace's sandbox and nice. */
  runGates(ws: Workspace, cwd: string, gates: Array<{ name: string; cmd: string }>): Promise<GateResult[]>;
  /** Run `fn` holding one of this machine's heavy slots (`mc heavy`), so a suite never starves live terminals. */
  heavy<T>(ws: Workspace, label: string, fn: () => Promise<T>): Promise<T>;
  /** A reader: a read-only `review:` run in the workspace — the second reader (label verify) or the code reviewer (label code). */
  review(ws: Workspace, prompt: string, o: { cwd: string; backend: string; model: string; requestId: string; label?: "verify" | "code" }): Promise<ReviewRun>;
  /** Type one line into the terminal. null = done, else why not. */
  tell(sessionId: string, text: string): Promise<string | null>;
  /** The draft's words as its hook carried them (draft-notify.ts, memory only). */
  draftText(sessionId: string | null, kind: "slack" | "email", to: string): Promise<{ kind: "slack" | "email"; to: string | null; channel: string | null; subject: string | null; text: string | null } | null>;
};

const gh = async (ws: Workspace, args: string[], timeout = 20_000) =>
  (await execFileAsync("gh", args, { cwd: os.homedir(), env: ghReadEnv(ws), encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;

const realDeps: VerifierDeps = {
  async prRead(ws, url) {
    const v = JSON.parse(await gh(ws, ["pr", "view", url, "--json", "state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,files,statusCheckRollup"]));
    const { ciChecks, ciRollup } = await import("./delivery.js");
    const checks = ciChecks(v?.statusCheckRollup) ?? [];
    return {
      state: v?.state ?? null, isDraft: !!v?.isDraft, mergeable: v?.mergeable ?? null, mergeStateStatus: v?.mergeStateStatus ?? null,
      headRefOid: v?.headRefOid ?? null, baseRefName: v?.baseRefName ?? null,
      files: Array.isArray(v?.files) ? v.files.map((f: any) => String(f?.path ?? "")).filter(Boolean) : null,
      ci: ciRollup(v?.statusCheckRollup), failing: checks.filter((c) => c.state === "failing").map((c) => c.name),
      passing: checks.filter((c) => c.state === "passing").map((c) => c.name),
    };
  },
  async behindBy(ws, url, base, head) {
    const slug = slugOfPr(url);
    if (!slug || !/^[\w./-]+$/.test(base) || !/^[0-9a-f]{7,40}$/i.test(head)) return null;
    try {
      const out = await gh(ws, ["api", `repos/${slug}/compare/${encodeURIComponent(base)}...${head}`, "--jq", ".behind_by"]);
      const n = Number(out.trim());
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  },
  async prDiff(ws, url) {
    try { return await gh(ws, ["pr", "diff", url], 30_000); } catch { return null; }
  },
  async gitState(ws, cwd) {
    const env = childEnv(ws);
    const run = (args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: 15_000 }).then((r) => r.stdout.trim());
    const head = await run(["rev-parse", "HEAD"]).catch(() => null);
    const dirty = (await run(["status", "--porcelain", "--untracked-files=no"]).catch(() => "?")) !== "";
    return { head, dirty };
  },
  async runGates(ws, cwd, gates) {
    const env = childEnv(ws);
    const mode = clampSandbox(ws.sandbox_mode as SandboxMode, ws.id);
    // The terminal's own walls: its sandbox, its profile dir, every other workspace's dirs denied — then nice.
    const shell: ShellRunner = (line, o) => {
      const boxed = sandboxWrap(mode, cwd, [], ws.config_dir ?? os.homedir(), workspaces.isolationDenyDirs(ws.id), "bash", ["-lc", withRuntimePath(line, o.env)], false, [], workspaceSandboxAllow(ws.sandbox_allow));
      const niced = niceWrap(boxed.cmd, boxed.cmdArgs);
      return execFileAsync(niced.cmd, niced.cmdArgs, { cwd, env: o.env, encoding: "utf8", timeout: o.timeoutMs, maxBuffer: o.maxBuffer });
    };
    return runGates(gates, cwd, env, undefined, shell);
  },
  async heavy(ws, label, fn) {
    let ticket: string | undefined;
    const deadline = Date.now() + 45 * 60_000;
    let slot: string | null = null;
    while (!slot) {
      const g = await acquireSlot({ workspace_id: ws.id, label, ticket }, 55_000);
      if (g.granted) slot = g.slot_id;
      else {
        ticket = g.ticket;
        if (Date.now() > deadline) throw new Error("no heavy slot came free in 45 minutes");
      }
    }
    const beat = setInterval(() => beatSlot(slot!), 30_000);
    beat.unref?.();
    try { return await fn(); } finally { clearInterval(beat); releaseSlot(slot); }
  },
  async review(ws, prompt, o) {
    const { dispatch } = await import("./dispatcher.js");
    // `review:` = a read-only run (runner.ts isReadOnlyRun): it never parks on an ask and is never
    // re-dispatched when one is answered. No Bash, no writes, no web: it reads files and answers.
    const label = o.label ?? "verify";
    const job = jobs.create({
      name: `review:${label}-${o.requestId.slice(0, 8)}`,
      description: label === "code" ? "independent code review of a PR hand-off (request verifier)" : "second reader for a hand-off (request verifier)", goal: prompt,
      workspace_id: ws.id, backend: o.backend, model: o.model, cwd: o.cwd, sandbox: ws.sandbox_mode,
      disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit,Bash,BashOutput,KillShell,Task,WebFetch,WebSearch",
      trigger_type: "manual", retry_max: 0, timeout_sec: 900, max_budget_usd: 2, notify: "off",
    } as any);
    const d = dispatch(job.id, "verifier");
    if ("error" in d) return { text: null, run_id: null, status: "refused", error: d.error };
    const deadline = Date.now() + (job.timeout_sec + 180) * 1000;
    for (;;) {
      const r = runs.get(d.run_id);
      if (r && r.status !== "queued" && r.status !== "running") return { text: r.summary ?? null, run_id: r.id, status: r.status, error: r.error ?? null };
      if (Date.now() > deadline) return { text: null, run_id: d.run_id, status: "timeout", error: "the reader did not finish in time" };
      await new Promise((res) => setTimeout(res, 1_000).unref?.());
    }
  },
  async tell(sessionId, text) {
    const { sendInput } = await import("./terminal.js");
    return sendInput(sessionId, { text, enter: true }, RAN_BY);
  },
  async draftText(sessionId, kind, to) {
    const { recentDrafts } = await import("./draft-notify.js");
    const dest = to.trim().toLowerCase();
    const hit = recentDrafts().find((d) => d.session_id === sessionId && d.kind === kind && ((kind === "slack" ? d.channel : d.to) ?? "").trim().toLowerCase() === dest);
    return hit ? { kind: hit.kind, to: hit.to, channel: hit.channel, subject: hit.subject, text: hit.text } : null;
  },
};
let deps: VerifierDeps = realDeps;
/** The real edges — tests drive the reviewer's dispatch with the mock backend through this. */
export const defaultVerifierDeps: Readonly<VerifierDeps> = realDeps;
/** Tests: replace any of the world's edges. null restores them all. */
export function setVerifierDeps(d: Partial<VerifierDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}
/** Tests: no debounce. */
export function setVerifierDelay(ms: number): void {
  DELAY_MS = ms;
}

// ───────────────────────────── is it on ─────────────────────────────

export function verifierOn(workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  try { return settingOn("verifier.enabled", workspaceId); } catch { return true; }
}

// ───────────────────────────── one pass ─────────────────────────────

/** What a pass judges: the open questions on this request that something can be checked for. */
type Target = { item: DecisionItem; d: Deliverable };
function targetsOf(r: RequestRow): Target[] {
  const out: Target[] = [];
  for (const item of requests.items(r.id)) {
    if (item.status !== "open" && item.status !== "held") continue;
    if (item.action === "answer" || !item.deliverable_id) continue;
    const d = requests.deliverable(item.deliverable_id);
    if (!d || FINAL_DELIVERABLE.has(d.state)) continue;
    out.push({ item, d });
  }
  return out;
}
const keyOf = (ts: Target[]) => ts.map((t) => `${t.item.id}:${t.d.target_hash ?? ""}`).sort().join(",");

/** The terminal whose work a deliverable is: the one that filed it, else the request's current owner. */
function terminalFor(r: RequestRow, d?: Deliverable | null): Session | undefined {
  // The wall, again: the ledger only links a request to its own workspace's terminals; never trust that blindly here.
  const own = (s: Session | undefined) => (s && s.workspace_id === r.workspace_id ? s : undefined);
  if (d?.session_id) {
    const s = own(sessions.get(d.session_id));
    if (s) return s;
  }
  const links = requests.linksFor(r.id);
  const prim = [...links].reverse().find((l) => l.primary && !l.until) ?? [...links].reverse().find((l) => l.primary);
  return prim ? own(sessions.get(prim.session_id)) : undefined;
}
/** The hand-off a deliverable came from (its `source_at`), else the terminal's newest. */
function outcomeFor(s: Session | undefined, d: Deliverable | null): Outcome | null {
  if (!s) return null;
  const all = [...(s.outcome_prev ?? []), ...(s.outcome ? [s.outcome] : [])];
  return (d?.source_at ? all.find((o) => o.at === d.source_at) : null) ?? s.outcome ?? null;
}
const shotRef = (sid: string) => (name: string) => `/api/sessions/${sid}/outcome/shot/${encodeURIComponent(name)}`;

/** The repo a PR is in, among this workspace's own repos (by remote), else the terminal's. Never another workspace's. */
function repoFor(ws: Workspace, url: string, s: Session | undefined): Repo | undefined {
  const slug = slugOfPr(url);
  const mine = repos.list(ws.id);
  return mine.find((x) => slug && slugOfRemote(x.git_remote) === slug) ?? (s?.repo_id ? mine.find((x) => x.id === s.repo_id) : undefined);
}

async function testsAt(ws: Workspace, url: string, head: string | null, s: Session | undefined): Promise<CheckResult> {
  const repo = repoFor(ws, url, s);
  const gates = parseGates(repo ?? null);
  if (!gates.length) {
    return { name: "tests", status: "skip", note: `no check command is configured for ${repo ? `repo ${repo.name}` : "this PR's repo"} — set the repo's gates (gate_cmds) and it is re-run here at the PR head; not checked is not passed` };
  }
  if (!head) return { name: "tests", status: "skip", note: "the PR's head commit is not known — nothing to run the checks at" };
  if (!s) return { name: "tests", status: "skip", note: "no terminal's worktree to run the checks in" };
  if (s.host_id && s.host_id !== "local") return { name: "tests", status: "skip", note: `its terminal is on another computer (${s.host_id}) — the checks were not re-run here` };
  const cwd = s.worktree_path || s.cwd;
  if (!cwd || !fs.existsSync(cwd)) return { name: "tests", status: "skip", note: "its terminal's worktree is gone" };
  const at = await deps.gitState(ws, cwd);
  if (at.head !== head || at.dirty) {
    return { name: "tests", status: "skip", note: `the worktree ${at.dirty ? "has uncommitted changes" : `is at ${at.head?.slice(0, 7) ?? "?"}`}, not exactly the PR head ${head.slice(0, 7)} — re-run when it is (mc ledger verify)` };
  }
  const results = await deps.heavy(ws, `verify ${url.replace(/^https:\/\/github\.com\//, "")}`, () => deps.runGates(ws, cwd, gates));
  const after = await deps.gitState(ws, cwd);
  if (after.head !== head || after.dirty) return { name: "tests", status: "skip", note: "the worktree moved while the checks ran — the result is not evidence for this head" };
  const evidence: Evidence[] = results.map((g) => ({
    ref: `gate:${g.name}`, label: g.cmd, meta: { ok: g.ok, ms: g.ms, head, cwd, output: String(g.output ?? "").slice(-OUTPUT_CAP) },
  }));
  const bad = results.filter((g) => !g.ok);
  if (!results.length) return { name: "tests", status: "skip", note: "the check command ran nothing", evidence };
  if (bad.length) {
    const tail = one(String(bad[0].output ?? "").split("\n").slice(-6).join(" / "), 300);
    return { name: "tests", status: "fail", tellable: true, evidence, note: `the repo's checks fail at ${head.slice(0, 7)}: ${bad.map((g) => `${g.name} (\`${g.cmd}\`)`).join(", ")} — ${tail}` };
  }
  return { name: "tests", status: "pass", evidence, note: `${results.map((g) => g.name).join(", ")} green at ${head.slice(0, 7)} (${(results.reduce((a, g) => a + g.ms, 0) / 1000).toFixed(0)}s)` };
}

async function draftBound(d: Deliverable): Promise<CheckResult> {
  const [channel, ...rest] = d.ref.split(":");
  const to = rest.join(":");
  const kind = channel === "email" ? "email" : channel === "slack" ? "slack" : null;
  if (!kind || d.ref.startsWith("draft:")) {
    return { name: "draft_bound", status: "skip", note: "the draft names no recipient — there is nothing a send could be bound to" };
  }
  const words = await deps.draftText(d.session_id, kind, to);
  if (!words) {
    return {
      name: "draft_bound", status: "skip",
      note: d.target_hash ? `bound by its terminal's hook (${d.target_hash.slice(0, 19)}…), but the words are no longer on file to re-check` : "the draft's words are not on file — nothing to bind a send to",
    };
  }
  // The same formula `mc hook` hashed it with (scripts/mc ↔ ledger-model.ts draftHash, kept in step by ledger-mc.test.ts).
  const h = draftHash({ channel: kind, to: (kind === "slack" ? words.channel : words.to) ?? to, subject: kind === "email" ? words.subject ?? "" : "", text: words.text ?? "" });
  const ev: Evidence[] = [{ ref: `draft:${d.ref}`, label: d.label ?? d.ref, meta: { channel: kind, to, hash: h } }];
  if (!d.target_hash) {
    requests.bindTarget(d.id, h);
    return { name: "draft_bound", status: "pass", evidence: ev, note: `bound to the words on file (${h.slice(0, 19)}…)` };
  }
  if (d.target_hash === h) return { name: "draft_bound", status: "pass", evidence: ev, note: "the words he hears are the words a yes is bound to" };
  return { name: "draft_bound", status: "fail", evidence: ev, note: "the draft's words on file do not match what its hook bound — it changed after it was announced; it is not ready until it is announced again" };
}

/** One check row per result, on the deliverable's CURRENT target (re-read: binding may just have moved it). */
function write(r: RequestRow, d: Deliverable, results: CheckResult[], at: string): void {
  const now = requests.deliverable(d.id) ?? d;
  for (const c of results) {
    requests.addCheck({ request_id: r.id, deliverable_id: d.id, name: c.name, status: c.status, evidence: c.evidence ?? [], note: c.note, target_hash: now.target_hash, ran_by: RAN_BY, ran_at: at });
  }
}

export type PassResult = { status: VerificationRow["status"] | "busy"; ready: boolean | null; reason: string | null; told: boolean; verification_id: string | null };

/**
 * One pass over a request. Idempotent per target: a pass whose targets match the last finished one is
 * not repeated unless `force` (the operator's re-run). Never throws: a failure is recorded on the pass.
 */
export async function verifyRequest(id: string, o: { trigger?: string; by?: string | null; force?: boolean } = {}): Promise<PassResult> {
  const r = requests.resolve(id);
  const no = (reason: string): PassResult => ({ status: "skipped", ready: null, reason, told: false, verification_id: null });
  if (!r) return no("no such request");
  // No workspace = no sandbox, profile or review engine to run in. The operator's own rows are not checked.
  if (!r.workspace_id) return no("a request with no workspace is not verified");
  const ws = workspaces.get(r.workspace_id);
  if (!ws) return no("its workspace is gone");
  // The operator's own re-run is his call even where the automatic verifier is off.
  if (o.trigger !== "manual" && !verifierOn(ws.id)) return no("the verifier is off for this workspace");
  if (r.closed_at) return no("the request is closed");
  if (active.has(r.id)) { again.add(r.id); return { status: "busy", ready: null, reason: "a pass is already running — another follows it", told: false, verification_id: null }; }
  const targets = targetsOf(r);
  if (!targets.length) return no("nothing on it waits for a decision");
  const key = keyOf(targets);
  const last = requests.lastVerification(r.id);
  if (!o.force && last && last.status === "done" && last.target_key === key) return no("already verified for these targets");

  active.add(r.id);
  const ver = requests.startVerification({ request_id: r.id, workspace_id: ws.id, trigger: o.trigger ?? "outcome", target_key: key, by: o.by ?? null });
  try {
    const out = await runPass(r, ws, targets);
    const latest = requests.get(r.id) ?? r;
    // Ready = every open item ready on its current target.
    // An item with nothing to judge yet (a deploy before the executor binds what would go out) is not counted.
    const judged = targets.map((t) => ({ t, rd: itemReadiness(latest, requests.item(t.item.id) ?? t.item) })).filter((j) => j.rd.status !== "none");
    const ready = judged.length > 0 && judged.every((j) => j.rd.ready);
    const notReady = judged.filter((j) => !j.rd.ready).map((j) => {
      const why = [...j.rd.failed.map((f) => `${f.name}: ${f.note ?? "failed"}`), ...j.rd.gate_unmet.map((f) => `${f.name} not checked: ${f.note ?? "skipped"}`), ...j.rd.missing.map((m) => `${m} missing`)];
      return `${j.t.item.action} ${j.t.d.label ?? j.t.d.ref}: ${why.join("; ") || "unverified"}`;
    });
    let reason = ready ? null : one(notReady.join(" | "), 1500);
    let told = false;
    let round: number | null = null;
    let sid: string | null = null;
    if (out.tellable.length) {
      const spent = requests.roundsTold(r.id);
      const s = terminalFor(r, targets[0].d);
      sid = s?.id ?? null;
      if (spent >= MAX_ROUNDS) {
        reason = `not ready after ${MAX_ROUNDS} rounds: ${one(out.tellable.join(" · "), 1400)}`;
      } else if (!s || s.status !== "live") {
        reason = `not ready — its terminal is closed, so it was not told: ${one(out.tellable.join(" · "), 1300)}`;
      } else {
        round = spent + 1;
        const err = await deps.tell(s.id, tellLine(round, out.tellable)).catch((e: any) => String(e?.message ?? e));
        told = !err;
        if (err) reason = `not ready — telling its terminal failed (${err}): ${one(out.tellable.join(" · "), 1200)}`;
      }
    }
    requests.finishVerification(ver.id, { status: "done", ready, reason, told, round: told ? round : null, session_id: sid, target_key: keyOf(targetsOf(latest)) });
    bus.publish({ topic: "ledger.verified", request_id: r.id, workspace_id: ws.id, ready, told, reason });
    return { status: "done", ready, reason, told, verification_id: ver.id };
  } catch (e: any) {
    const reason = `the verifier itself failed: ${one(e?.message ?? e, 300)}`;
    requests.finishVerification(ver.id, { status: "error", ready: null, reason });
    console.warn("[verifier]", r.id.slice(0, 8), reason);
    return { status: "error", ready: null, reason, told: false, verification_id: ver.id };
  } finally {
    active.delete(r.id);
    if (again.delete(r.id)) schedule(r.id, "again");
  }
}

async function runPass(r: RequestRow, ws: Workspace, targets: Target[]): Promise<{ tellable: string[] }> {
  const at = iso();
  const tellable: string[] = [];
  const results = new Map<string, CheckResult[]>();
  const push = (d: Deliverable, c: CheckResult) => {
    results.set(d.id, [...(results.get(d.id) ?? []), c]);
    if (c.status === "fail" && c.tellable && !tellable.includes(`${c.name}: ${c.note}`)) tellable.push(`${c.name}: ${c.note}`);
  };
  const seen = new Set<string>();
  const unique = targets.filter((t) => (seen.has(t.d.id) ? false : (seen.add(t.d.id), true)));
  const kind = r.kind;
  const reviewPrs: ReviewInput["prs"] = [];
  const reviewDrafts: ReviewInput["drafts"] = [];
  // The code reviews run beside the second reader below; their checks are in before anything is written.
  const codeReviewing: Array<Promise<void>> = [];
  let cwd: string | null = null;

  for (const { d } of unique) {
    const s = terminalFor(r, d);
    if (!cwd && s) cwd = s.worktree_path || s.cwd || null;
    if (d.kind === "pr") {
      // The wall: only a PR of this workspace's own repos is read with this workspace's credentials.
      const own = prBelongsTo(ws.id, d.ref);
      if (!own.ok) {
        for (const n of ["pr_ready", "tests", "data_diff", "code_review", "matches_request"] as CheckName[]) push(d, { name: n, status: "skip", note: `not read: ${own.why}` });
        continue;
      }
      let pr: PrRead | null = null;
      try { pr = await deps.prRead(ws, d.ref); } catch (e: any) {
        push(d, { name: "pr_ready", status: "skip", note: `could not read the PR from GitHub: ${one(e?.stderr ?? e?.message ?? e, 200)}` });
      }
      if (pr?.headRefOid && pr.headRefOid !== d.target_hash) requests.bindTarget(d.id, pr.headRefOid);
      if (pr) {
        const behind = pr.baseRefName && pr.headRefOid ? await deps.behindBy(ws, d.ref, pr.baseRefName, pr.headRefOid) : null;
        push(d, judgePr(d.ref, pr, behind, pr.ci, pr.failing));
      }
      push(d, await testsAt(ws, d.ref, pr?.headRefOid ?? null, s));
      // Only the slots this PR is judged by (ledger-model.ts slotsFor): a product PR has no goal_test slot.
      const want = new Set(slotsFor(kind, "pr").map((x) => x.name));
      if (want.has("goal_test")) push(d, judgeGoalTest(pr?.files ?? null));
      if (want.has("regression")) push(d, { name: "regression", status: "skip", note: "not machine-checked: the repo's checks are the only suite re-run; callers of the changed code were not traced" });
      if (want.has("shots")) {
        const o = outcomeFor(s, d);
        push(d, judgeShots(o?.shots ?? [], shotRef(s?.id ?? "")));
        const since = requests.linksFor(r.id).find((l) => l.session_id === s?.id)?.linked_at ?? r.asked_at;
        push(d, judgeWalkthrough(s?.shown ?? [], since, shotRef(s?.id ?? "")));
      }
      const diff = await deps.prDiff(ws, d.ref);
      reviewPrs.push({ url: d.ref, files: pr?.files ?? null, diff: diff ? diff.slice(0, DIFF_CAP) : null, truncated: !!diff && diff.length > DIFF_CAP });
      if (want.has("data_diff")) {
        const swing = Number(setting("verifier.data_swing_pct", ws.id)) || 20;
        push(d, judgeDataDiff({ repo: dataRepoOf(repoFor(ws, d.ref, s), pr?.files ?? null), files: pr?.files ?? null, diff: outcomeFor(s, d)?.data_diff ?? null, swingLimit: swing, ciPassing: pr?.passing ?? [] }));
      }
      if (want.has("code_review")) {
        codeReviewing.push(codeReviewAt(r, ws, d, s, pr, diff).catch((e: any): CheckResult => ({ name: "code_review", status: "skip", note: `the code review itself failed: ${one(e?.message ?? e, 200)}` })).then((c) => push(d, c)));
      }
    } else if (d.kind === "slack_draft" || d.kind === "email_draft") {
      push(d, await draftBound(d));
      const [channel, ...rest] = d.ref.split(":");
      const w = channel === "slack" || channel === "email" ? await deps.draftText(d.session_id, channel, rest.join(":")) : null;
      reviewDrafts.push({ kind: d.kind === "email_draft" ? "email" : "slack", to: w ? (w.kind === "slack" ? w.channel : w.to) : rest.join(":") || null, subject: w?.subject ?? null, text: w?.text ?? null });
    }
  }

  // The second reader, once for the whole hand-off, on every deliverable that a reader can judge.
  const readable = unique.filter(({ d }) => d.kind !== "deploy" && results.get(d.id)?.every((c) => !c.note.startsWith("not read:")) !== false);
  if (readable.length) {
    const s = terminalFor(r, readable[0].d);
    const o = outcomeFor(s, readable.find((t) => t.d.kind === "answer" || t.d.kind === "pr")?.d ?? readable[0].d);
    const input: ReviewInput = {
      kind, words: r.words, goal: s?.goal ?? null, done_when: s?.done_when ?? [],
      outcome: o ? { summary: o.summary, changes: o.changes, proof: o.proof } : null, prs: reviewPrs, drafts: reviewDrafts,
    };
    const pick = pickReviewer(ws, { backend: s?.backend ?? null, model: s?.model ?? null }, { backend: "claude-code", model: CONFIG.mergeGateModel || CONFIG.defaultModel });
    const runCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    let verdict: ReviewVerdict | null = null;
    let run: ReviewRun | null = null;
    try {
      run = await deps.review(ws, reviewerPrompt(input), { cwd: runCwd, backend: pick.backend, model: pick.model, requestId: r.id });
      verdict = run.status === "success" ? parseReview(run.text) : null;
    } catch (e: any) {
      run = { text: null, run_id: null, status: "error", error: String(e?.message ?? e) };
    }
    const ev: Evidence[] = [{
      ref: run?.run_id ? `run:${run.run_id}` : "run:none", label: `${pick.backend} ${pick.model}`,
      meta: { backend: pick.backend, model: pick.model, independent: pick.independent, why: pick.why, ...(verdict?.risks.length ? { risks: verdict.risks.join(" · ").slice(0, 1500) } : {}) },
    }];
    // The analysis slots are owed by figures from data: none in an answer read whole = n/a, decided here.
    const figures = answerFigures(input);
    for (const { d } of readable) {
      if (!verdict) {
        push(d, { name: "matches_request", status: "skip", evidence: ev, note: `the second reader gave no verdict (${run?.status ?? "error"}${run?.error ? `: ${one(run.error, 160)}` : ""}) — nobody but its author has read it` });
        for (const c of judgeAspects(kind, figures, null)) push(d, c);
        continue;
      }
      const why = verdict.reasons.join(" · ");
      if (!pick.independent) {
        // Read by the very engine that wrote it: recorded, never counted as a second reading.
        push(d, { name: "matches_request", status: "skip", evidence: ev, note: `${pick.why}; it said ${verdict.pass ? "pass" : "fail"}${why ? `: ${one(why, 200)}` : ""}` });
      } else {
        push(d, verdict.pass
          ? { name: "matches_request", status: "pass", evidence: ev, note: one(why || "does what was asked", 600) }
          : { name: "matches_request", status: "fail", evidence: ev, tellable: true, note: one(why || "the reader says it does not do what was asked", 600) });
      }
      for (const c of judgeAspects(kind, figures, verdict)) push(d, c);
    }
  }

  await Promise.all(codeReviewing);
  for (const { d } of unique) write(r, d, results.get(d.id) ?? [], at);
  return { tellable };
}

/**
 * code_review for one PR (src/code-review.ts): read once per head by an engine that did not write it,
 * over the whole diff, with the repo's review memory and the operator's corrections. A head already
 * read is judged from that review and the hand-off; a new head with the diff of the last review (a
 * clean rebase) carries it over; any other new head is read again, with the findings still open and
 * what the hand-off says of each.
 */
async function codeReviewAt(r: RequestRow, ws: Workspace, d: Deliverable, s: Session | undefined, pr: PrRead | null, diff: string | null): Promise<CheckResult> {
  const skip = (note: string): CheckResult => ({ name: "code_review", status: "skip", note });
  if (!pr?.headRefOid || String(pr.state ?? "").toUpperCase() !== "OPEN") return skip("the PR is not open, or its head is not known — nothing to review");
  if (!diff?.trim()) return skip("the PR's diff could not be read — nobody but its author has read it");
  const head = pr.headRefOid;
  const o = outcomeFor(s, d);
  const handoff = o ? [o.summary, ...o.changes, ...o.proof] : [];
  const saidOn = (list: Finding[]) => resolutionsIn(handoff, list.filter((f) => f.status === "open").map((f) => f.id));
  const judge = (row: CodeReviewRow, fresh: boolean) =>
    judgeCodeReview({ findings: row.findings, fresh, said: saidOn(row.findings), engine: row.engine, rules: row.rules, carriedFrom: row.carried_from, runRef: row.run_id ? `run:${row.run_id}` : null });
  const cached = codeReviews.get(ws.id, d.ref, head);
  if (cached) return judge(cached, false);
  const prev = codeReviews.latest(ws.id, d.ref);
  const diffHash = "sha256:" + createHash("sha256").update(diff).digest("hex");
  if (prev && prev.diff_hash === diffHash) {
    return judge(codeReviews.put({ ...prev, head_sha: head, carried_from: prev.carried_from ?? prev.head_sha }), false);
  }
  // Never the engine that wrote it: the terminal's backend and model (its workspace's default model when it set none).
  const pick = pickReviewer(ws, { backend: s?.backend ?? null, model: s?.model || ws.default_model || null }, { backend: "claude-code", model: CONFIG.mergeGateModel || CONFIG.defaultModel });
  if (!pick.independent) return skip(`${pick.why} — no independent review`);
  const repo = repoFor(ws, d.ref, s);
  const slug = slugOfPr(d.ref);
  const memory = repo && slug ? await repoMemoryFor(ws, repo, slug) : undefined;
  const open = (prev?.findings ?? []).filter((f) => f.status === "open");
  const said = saidOn(open);
  const prompt = codeReviewPrompt({
    url: d.ref, words: r.words, goal: s?.goal ?? null, repo: repo?.name ?? slug, rules: memory?.rules ?? [], notes: operatorNotes(ws, repo, slug, pr.files),
    open: open.map((f) => ({ ...f, said: said[f.id] ?? null })), files: pr.files, diff: diff.slice(0, CODE_DIFF_CAP), truncated: diff.length > CODE_DIFF_CAP,
  });
  const wt = s?.worktree_path || s?.cwd || null;
  let run: ReviewRun;
  try {
    run = await deps.review(ws, prompt, { cwd: wt && fs.existsSync(wt) ? wt : os.homedir(), backend: pick.backend, model: pick.model, requestId: r.id, label: "code" });
  } catch (e: any) {
    run = { text: null, run_id: null, status: "error", error: String(e?.message ?? e) };
  }
  const out = run.status === "success" ? parseCodeReview(run.text) : null;
  if (!out) return skip(`the code reviewer gave no verdict (${run.status}${run.error ? `: ${one(run.error, 160)}` : ""}) — nobody but its author has read the diff`);
  const row = codeReviews.put({
    workspace_id: ws.id, repo_id: repo?.id ?? null, pr_url: d.ref, head_sha: head, diff_hash: diffHash, findings: mergeFindings(prev?.findings ?? [], out),
    engine: `${pick.backend} ${pick.model}`, run_id: run.run_id, rules: memory?.rules.length ?? 0, carried_from: null,
  });
  return judge(row, true);
}

// ───────────────────────────── when it runs ─────────────────────────────

const active = new Set<string>();
const again = new Set<string>();
const queued = new Map<string, { trigger: string; timer: NodeJS.Timeout | null }>();
const waiting: Array<{ id: string; trigger: string }> = [];
let running = 0;

function pump(): void {
  while (running < MAX_ACTIVE && waiting.length) {
    const next = waiting.shift()!;
    running++;
    void verifyRequest(next.id, { trigger: next.trigger }).finally(() => { running--; pump(); });
  }
}

/** Judge this request soon — coalesced: a burst of items from one hand-off is one pass. */
export function schedule(requestId: string, trigger: string): void {
  if (queued.has(requestId)) return;
  const fire = () => {
    queued.delete(requestId);
    if (!waiting.some((w) => w.id === requestId)) waiting.push({ id: requestId, trigger });
    pump();
  };
  if (DELAY_MS <= 0) { queued.set(requestId, { trigger, timer: null }); fire(); return; }
  const timer = setTimeout(fire, DELAY_MS);
  timer.unref?.();
  queued.set(requestId, { trigger, timer });
}

/** The bus: a new question on a request (ledger.ts raiseItem) is the trigger. */
export function onVerifierEvent(e: any): void {
  if (e?.topic !== "ledger.item_raised") return;
  if (!["merge", "review", "deploy", "send"].includes(e.action)) return;
  if (!verifierOn(e.workspace_id)) return;
  schedule(e.request_id, e.action === "send" ? "draft" : "outcome");
}

/**
 * What time alone moves: a PR head pushed after its pass (re-bound at once, so the old checks go stale
 * and the item is not ready until it is checked again), and items raised while the daemon was down.
 */
export async function sweepVerifier(): Promise<void> {
  const since = kv.get(SINCE_KEY) ?? iso();
  for (const d of requests.openOfKind("pr", 60)) {
    const r = requests.get(d.request_id);
    if (!r?.workspace_id || r.closed_at || !verifierOn(r.workspace_id)) continue;
    if (!requests.itemsForDeliverable(d.id).some((i) => i.status === "open" || i.status === "held")) continue;
    if (!d.target_hash) continue; // never checked yet: the trigger or the catch-up below takes it
    const ws = workspaces.get(r.workspace_id);
    if (!ws || !prBelongsTo(ws.id, d.ref).ok) continue;
    try {
      const pr = await deps.prRead(ws, d.ref);
      if (pr.headRefOid && pr.headRefOid !== d.target_hash) {
        requests.bindTarget(d.id, pr.headRefOid);
        schedule(r.id, "head_moved");
      }
    } catch { /* GitHub unreachable: the next sweep looks again */ }
  }
  // Items raised since the verifier started that no pass has judged yet (a missed event, a restart).
  for (const it of requests.pendingItems()) {
    if (it.status !== "open" || it.action === "answer" || it.created_at < since || !verifierOn(it.workspace_id)) continue;
    const r = requests.get(it.request_id);
    if (!r) continue;
    const last = requests.lastVerification(r.id);
    if (!last || (last.status !== "running" && last.target_key !== keyOf(targetsOf(r)))) schedule(r.id, "sweep");
  }
}

let started = false;
export function startVerifier(): void {
  if (started) return;
  started = true;
  if (!kv.get(SINCE_KEY)) kv.set(SINCE_KEY, iso());
  requests.abandonRunning();
  bus.on("event", (e: any) => {
    try { onVerifierEvent(e); } catch (err: any) { console.warn("[verifier]", err?.message ?? err); }
  });
  const t = setInterval(() => { void sweepVerifier().catch((err) => console.warn("[verifier] sweep", err?.message ?? err)); }, SWEEP_MS);
  t.unref?.();
}

/** Tests: forget the queue. */
export function resetVerifierMemory(): void {
  for (const q of queued.values()) if (q.timer) clearTimeout(q.timer);
  queued.clear();
  waiting.length = 0;
  active.clear();
  again.clear();
  running = 0;
}
