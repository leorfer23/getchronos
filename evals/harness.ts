/**
 * Eval harness — replay a real ticket through the real dispatch path and capture the goal.
 *
 * The goal an agent receives is composed from a dozen sources: the ticket body, the repo's
 * Definition of Done, its gate commands, every round of reviewer notes, ranked lessons, attachments,
 * ancestry, the worktree it will run in. Nothing asserted any of that, so a change to a template in
 * `src/tickets.ts` shipped and was discovered by watching an agent behave oddly.
 *
 * Rather than re-implement the composition (a copy that drifts proves nothing), this drives the real
 * `dispatch*` functions and intercepts the one choke point they all pass through: `jobs.create`.
 * Stubbing it to capture and throw means the goal is the genuine article — resolution logic
 * included — while nothing is ever spawned and no run row is written. Build/plan keep a non-git
 * temp dir (no worktree). ci-fix / merge-gate pass `git: true` so `ensureTicketWorktree` can
 * succeed; the temp parent (repo + sibling worktrees) is wiped in `goalFor`'s finally.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { jobs, repos, reviews as reviewStore, runs, workspaces } from "../src/store.js";
import { createTicket, updateTicket } from "../src/tickets.js";
import { requestChanges } from "../src/reviews.js";
import type { NewJob, Ticket } from "../src/types.js";

/** Extra state some dispatch kinds need before they will compose a goal. */
export interface SeedOpts {
  /** ci-fix / merge-gate refuse without a PR URL. */
  prUrl?: string;
  /**
   * Init a real git checkout so `ensureTicketWorktree` succeeds. Nested under the temp parent so
   * worktrees land as siblings and leave nothing under `/tmp/.chronos-worktrees`. Default stays a
   * non-git dir — build/plan evals must not pay for (or depend on) worktree creation.
   */
  git?: boolean;
}

export interface EvalCase {
  name: string;
  workspace: {
    name: string;
    default_backend?: string | null;
    default_model?: string | null;
    sandbox_mode?: string | null;
    route_config?: string | null;
  };
  repo?: {
    name: string;
    default_branch?: string | null;
    delivery?: string | null;
    human_gate?: string | null;
    done_criteria?: string | null;
    gate_cmds?: string | null;
  } | null;
  ticket: {
    title: string;
    priority?: string | null;
    complexity?: string | null;
    tags?: string | null;
    body: string;
  };
  reviews?: Array<{ state: string; notes: string | null }>;
}

export function loadCase(name: string): EvalCase {
  const file = path.join(import.meta.dirname, "cases", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as EvalCase;
}

export function listCases(): string[] {
  return fs
    .readdirSync(path.join(import.meta.dirname, "cases"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Seed one case into the in-memory DB. By default the repo path is a real temp directory that is
 * deliberately NOT a git repo: dispatchTicket only builds a worktree for a git checkout, and an
 * eval that shelled out to `git worktree add` would be a fixture with a filesystem side effect.
 * Worktree wording is covered by its own unit test in src/worktrees.test.ts. Pass `git: true` when
 * the dispatch under test (ci-fix / merge-gate) refuses to run without an isolated worktree.
 */
export function seed(kase: EvalCase, opts: SeedOpts = {}): { ticket: Ticket; repoPath: string | null } {
  const ws = workspaces.create({
    slug: "eval-" + randomUUID().slice(0, 8),
    name: kase.workspace.name,
    config_dir: `/tmp/mc-eval/${randomUUID()}`,
    default_backend: kase.workspace.default_backend ?? "claude-code",
    default_model: kase.workspace.default_model ?? null,
    sandbox_mode: kase.workspace.sandbox_mode ?? "guard",
    route_config: kase.workspace.route_config ?? null,
  } as any);

  let repoPath: string | null = null;
  let repoId: string | null = null;
  if (kase.repo) {
    // Nest the checkout under the temp parent so ensureTicketWorktree's sibling
    // `.chronos-worktrees/<basename>` stays inside the same tree we can wipe.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mc-eval-repo-"));
    repoPath = opts.git ? path.join(parent, "repo") : parent;
    if (opts.git) {
      fs.mkdirSync(repoPath);
      const g = (...a: string[]) => execFileSync("git", ["-C", repoPath!, ...a], { stdio: "ignore" });
      g("init", "-b", kase.repo.default_branch ?? "main");
      g("config", "user.email", "eval@chronos.test");
      g("config", "user.name", "eval");
      fs.writeFileSync(path.join(repoPath, "README.md"), "eval fixture\n");
      g("add", "-A");
      g("commit", "-m", "eval fixture");
    }
    repoId = repos.create({
      workspace_id: ws.id,
      name: kase.repo.name,
      path: repoPath,
      default_branch: kase.repo.default_branch ?? "main",
      delivery: kase.repo.delivery ?? "pr",
      human_gate: kase.repo.human_gate ?? null,
      done_criteria: kase.repo.done_criteria ?? null,
      gate_cmds: kase.repo.gate_cmds ?? null,
    } as any).id;
  }

  let ticket = createTicket({
    workspace_id: ws.id,
    repo_id: repoId,
    title: kase.ticket.title,
    priority: kase.ticket.priority ?? "P2",
    tags: kase.ticket.tags ?? undefined,
  } as any);
  if (kase.ticket.complexity) ticket = updateTicket(ticket.id, { complexity: kase.ticket.complexity } as any) ?? ticket;
  if (opts.prUrl) ticket = updateTicket(ticket.id, { pr_url: opts.prUrl } as any) ?? ticket;

  // The body is the file — getBody() reads from disk, and it is most of what the agent is told to
  // read. Write the real exported markdown over the freshly scaffolded one.
  fs.writeFileSync(ticket.file_path, kase.ticket.body);

  // Rework rounds, oldest first — the build goal must carry every one of them.
  for (const r of kase.reviews ?? []) {
    if (r.state !== "changes_requested") continue;
    // A review hangs off a run, which hangs off a job — that FK chain is real, so build it rather
    // than fake the ids. None of these rows ever execute: nothing dispatches them.
    const job = jobs.create({
      // NOT "ticket:…" — hasActiveJob() reads that prefix as a build in flight and the next
      // dispatch would refuse with "already has a build in progress".
      name: `eval-fixture:${ticket.key}`,
      goal: "(eval fixture — never dispatched)",
      workspace_id: ws.id,
      ticket_id: ticket.id,
      cwd: repoPath ?? os.tmpdir(),
      trigger_type: "manual",
    } as any);
    const run = runs.create(job.id, `eval-fixture:${ticket.key}`);
    const review = reviewStore.create({ run_id: run.id, ticket_id: ticket.id, diff_ref: null });
    requestChanges(review.id, r.notes, "ai:reviewer");
  }

  return { ticket: { ...ticket, complexity: kase.ticket.complexity ?? ticket.complexity }, repoPath };
}

const SENTINEL = "__eval_capture__";

/**
 * Run a dispatch and return the job spec it was about to create. Everything downstream of
 * `jobs.create` — the run row, the spawn, the status flip — never happens.
 */
export async function captureJob(dispatch: () => unknown | Promise<unknown>): Promise<NewJob> {
  const real = jobs.create;
  let captured: NewJob | null = null;
  jobs.create = ((spec: NewJob) => {
    captured = spec;
    throw new Error(SENTINEL);
  }) as typeof jobs.create;
  try {
    await dispatch();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== SENTINEL) throw e;
  } finally {
    jobs.create = real;
  }
  if (!captured) throw new Error("dispatch returned without reaching jobs.create — nothing captured");
  return captured;
}

/** Convenience: seed a case, dispatch it, hand back the goal plus what it was seeded from. */
export async function goalFor(
  kase: EvalCase,
  dispatch: (ticketId: string) => unknown | Promise<unknown>,
  opts: SeedOpts = {},
): Promise<{ goal: string; job: NewJob; ticket: Ticket }> {
  const { ticket, repoPath } = seed(kase, opts);
  try {
    const job = await captureJob(() => dispatch(ticket.id));
    return { goal: job.goal, job, ticket };
  } finally {
    // ensureTicketWorktree may have created a sibling checkout before jobs.create threw. Wipe the
    // whole temp parent (repo + `.chronos-worktrees/`) so evals leave no debris and a later seed
    // with the same ticket key does not collide on an existing mc/<key> branch checkout.
    if (opts.git && repoPath) {
      const parent = path.dirname(repoPath);
      if (parent.startsWith(os.tmpdir()) && parent.includes("mc-eval-repo-")) {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  }
}
