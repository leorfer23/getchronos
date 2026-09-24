import fs from "node:fs";
import path from "node:path";
import { ticketBranch } from "./tickets.js";
import { db, repos, runs, sessions, tickets, workspaces } from "./store.js";
import { isClosedTicketStatus, type Repo, type Session } from "./types.js";

import { baseRef, ensureBranchWorktree, existingWorktree, git, isGitRepo, listWorktrees, worktreeRootFor } from "./worktree-core.js";

// The plain-git helpers (git, isGitRepo, listWorktrees, existingWorktree, baseRef) live in
// worktree-core.ts so a `chronos host` can run them without the store; re-exported for callers here.
export { isGitRepo };

function worktreeRoot(repo: Repo): string {
  // Sibling of the repo (never inside its working tree). basename keeps repos with the same name in
  // different parents from colliding is not a concern — parent dir already disambiguates.
  return worktreeRootFor(repo.path);
}

// Ensure (creating if needed) a worktree for this ticket's branch and return its path, or null to tell
// the caller to fall back to the plain repo path. Idempotent: reuses an existing worktree for the
// branch; a build and a terminal on the same ticket land in the same dir.
export async function ensureTicketWorktree(repo: Repo, ticketKey: string): Promise<string | null> {
  if (!repo?.path) return null;
  return ensureBranchWorktree(repo.path, repo.default_branch, ticketBranch(ticketKey));
}

/** The pre-naming Desk branch (`desk/<id8>`). Still recognised so trees claimed before stay removable by their owner. */
export const legacyDeskBranch = (sessionId: string) => `desk/${sessionId.slice(0, 8)}`;

export const BRANCH_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "ci"] as const;

const TYPE_HINTS: [RegExp, (typeof BRANCH_TYPES)[number]][] = [
  [/\b(fix|bug|hotfix|broken|crash|error|arregl\w*|roto|falla\w*|corregi\w*)\b/, "fix"],
  [/\b(refactor\w*|cleanup|clean up|simplif\w*|limpi\w*)\b/, "refactor"],
  [/\b(perf|performance|slow|speed|lento|rendimiento)\b/, "perf"],
  [/\b(docs?|readme|document\w*)\b/, "docs"],
  [/\b(tests?|specs?|coverage)\b/, "test"],
  [/\b(ci|workflow|pipeline)\b/, "ci"],
  [/\b(chore|bump|upgrade|deps|dependenc\w*|actualiz\w*|rename|renombr\w*)\b/, "chore"],
];

const STOP = new Set(
  ("a an and the to of for in on at by with from into this that is are be it my our " +
    "please quick just some also then " +
    "un una unos unas el la los las de del al y o en con por para que se lo le mi mis su sus es " +
    "esto este esta rapido rapida porfa favor quiero hacer haz vamos como mas").split(" "),
);

const slugWords = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w));

/** "Leonel Fernandez" → "lf". The workspace's git author, so client workspaces carry the right person. */
export function branchInitials(name: string | null | undefined): string {
  const letters = slugWords(name || "").map((w) => w[0]).join("").slice(0, 3);
  return letters || "mc";
}

/**
 * The branch a Desk terminal works on: `<initials>/<type>/<topic>` (e.g. `lf/fix/desk-scrollbar`) —
 * what GitHub reviewers expect to read in a PR list. `as` is the agent's own name for the work
 * (`fix/desk-scrollbar` or free text); without it the topic comes from the terminal's goal.
 */
export function deskBranchName(sess: Pick<Session, "id" | "workspace_id" | "goal" | "spawn_goal" | "title">, as?: string | null): string {
  const ws = sess.workspace_id ? workspaces.get(sess.workspace_id) : undefined;
  const fixed = slugWords(process.env.CHRONOS_BRANCH_INITIALS || "").join("").slice(0, 6);
  const who = fixed || branchInitials(ws?.git_name || process.env.GIT_AUTHOR_NAME);
  let hint = (as || "").trim();
  let type = "";
  const slash = hint.match(/^([a-z]+)\/(.+)$/i);
  if (slash && (BRANCH_TYPES as readonly string[]).includes(slash[1].toLowerCase())) {
    type = slash[1].toLowerCase();
    hint = slash[2];
  }
  const source = hint || sess.goal || sess.spawn_goal || sess.title || "";
  if (!type) {
    const lower = source.toLowerCase();
    type = TYPE_HINTS.find(([re]) => re.test(lower))?.[1] ?? "feat";
  }
  let topic = "";
  for (const w of slugWords(source).filter((w) => w !== type)) {
    const next = topic ? `${topic}-${w}` : w;
    if (next.length > 40 || next.split("-").length > 5) break;
    topic = next;
  }
  return `${who}/${type}/${topic || sess.id.slice(0, 8)}`;
}

async function branchTaken(repoPath: string, branch: string): Promise<boolean> {
  try {
    const local = await git(repoPath, ["branch", "--list", branch]);
    const remote = await git(repoPath, ["branch", "-r", "--list", `origin/${branch}`]);
    return local !== "" || remote !== "";
  } catch {
    return false;
  }
}

/**
 * A worktree for a terminal that has just worked out which repo it needs.
 *
 * Separate from ensureTicketWorktree because the two learn their repo at opposite ends of a session.
 * A ticket names its repo before anything spawns. A Desk terminal does NOT: the spawn dialog's repo
 * is a guess made before anyone read the task, and the real one surfaces once the agent has read it
 * ("work on shop documents" opened in recipe-parser). So this is claimed mid-session, by
 * the agent, at the moment the answer is actually known.
 *
 * Idempotent: the same terminal asking twice gets the same path back, not a second checkout — the
 * branch it already claimed wins over a freshly derived name (its goal may have been sharpened since).
 * A derived name someone else already owns gets the session's short id appended, never reused.
 */
export async function ensureSessionWorktree(
  repo: Repo,
  sess: Pick<Session, "id" | "workspace_id" | "goal" | "spawn_goal" | "title" | "worktree_branch">,
  as?: string | null,
): Promise<{ path: string; branch: string } | null> {
  if (!repo?.path || !fs.existsSync(repo.path) || !(await isGitRepo(repo.path))) return null;

  for (const mine of [sess.worktree_branch, legacyDeskBranch(sess.id)]) {
    if (!mine) continue;
    const existing = await existingWorktree(repo.path, mine);
    if (existing && fs.existsSync(existing)) return { path: existing, branch: mine };
  }

  const wanted = deskBranchName(sess, as);
  const suffixed = `${wanted}-${sess.id.slice(0, 4)}`;
  const claimedByOther = (b: string) =>
    !!db.prepare("SELECT 1 FROM sessions WHERE worktree_branch = ? AND id <> ? LIMIT 1").get(b, sess.id);
  for (const b of [wanted, suffixed]) {
    const existing = await existingWorktree(repo.path, b);
    if (existing && fs.existsSync(existing) && !claimedByOther(b)) return { path: existing, branch: b };
  }
  const branch = (await branchTaken(repo.path, wanted)) ? suffixed : wanted;

  const wtPath = path.join(worktreeRoot(repo), branch.replace(/\//g, "-"));
  try {
    if (fs.existsSync(wtPath)) {
      try { await git(repo.path, ["worktree", "prune"]); } catch {}
      if (fs.existsSync(wtPath)) return { path: wtPath, branch };
    }
    fs.mkdirSync(worktreeRoot(repo), { recursive: true });
    const branchExists = (await git(repo.path, ["branch", "--list", branch])) !== "";
    const args = branchExists
      ? ["worktree", "add", wtPath, branch]
      : ["worktree", "add", "-b", branch, wtPath, await baseRef(repo.path, repo.default_branch)];
    await git(repo.path, args, 30_000);
    return fs.existsSync(wtPath) ? { path: fs.realpathSync(wtPath), branch } : null;
  } catch {
    return null;
  }
}

/**
 * The branch a terminal on ANOTHER host (HOSTS.md) should claim — the naming half of
 * ensureSessionWorktree, which the host cannot do (it has no store to see other terminals' claims).
 * The worktree itself is created there, under that host's own checkout.
 */
export async function remoteWorktreeBranch(
  sess: Pick<Session, "id" | "workspace_id" | "goal" | "spawn_goal" | "title" | "worktree_branch">,
  as?: string | null,
): Promise<string> {
  if (sess.worktree_branch) return sess.worktree_branch;
  const wanted = deskBranchName(sess, as);
  const claimedByOther = !!db.prepare("SELECT 1 FROM sessions WHERE worktree_branch = ? AND id <> ? LIMIT 1").get(wanted, sess.id);
  return claimedByOther ? `${wanted}-${sess.id.slice(0, 4)}` : wanted;
}

/** What a worktree is holding that removing it would destroy. */
export type WorktreeState = {
  path: string;
  branch: string | null;
  /** Uncommitted edits — the only thing git cannot get back. */
  dirty: boolean;
  dirty_files: number;
  /** Commits on this branch that no remote has. Survive removal (shared object store), but they
   *  become invisible: nothing but the branch name points at them afterwards. */
  unpushed: number;
  /** A terminal is working here right now. */
  busy: boolean;
};

/** Read what a worktree holds, without changing anything. The input to every delete decision. */
export async function worktreeState(
  repoPath: string,
  wtPath: string,
  opts: { ignoreSession?: string } = {},
): Promise<WorktreeState> {
  const out: WorktreeState = { path: wtPath, branch: null, dirty: false, dirty_files: 0, unpushed: 0, busy: false };
  try {
    const status = await git(wtPath, ["status", "--porcelain"]);
    out.dirty_files = status ? status.split("\n").filter(Boolean).length : 0;
    out.dirty = out.dirty_files > 0;
  } catch {
    // Unreadable tree — treat as dirty so nothing removes what it could not inspect.
    out.dirty = true;
  }
  try {
    out.branch = (await git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
  } catch {}
  try {
    // `@{u}` throws when there is no upstream at all — a branch never pushed. Count its commits
    // against the default base instead, so "never pushed" reads as unpushed rather than as zero.
    let range: string;
    try {
      await git(wtPath, ["rev-parse", "--abbrev-ref", "@{u}"]);
      range = "@{u}..HEAD";
    } catch {
      const repo = repos.list().find((r) => r.path === repoPath);
      range = `${await baseRef(repoPath, repo?.default_branch || "main")}..HEAD`;
    }
    const n = Number(await git(wtPath, ["rev-list", "--count", range])) || 0;
    out.unpushed = n && (await alreadyLanded(repoPath, wtPath)) ? 0 : n;
  } catch {}
  // `ignoreSession`: the owner removing its own tree is standing in it by definition — only OTHER
  // live terminals make it busy.
  out.busy = sessions
    .list({ status: "live" })
    .some((s) => s.id !== opts.ignoreSession && (s.cwd === wtPath || s.worktree_path === wtPath));
  return out;
}

/**
 * Commits that "look unpushed" but are not at risk: the normal end of a PR is a squash-merge that
 * deletes the remote branch, after which `@{u}` is gone and every commit on the branch counts against
 * the base — and the terminal that did everything right is refused its own cleanup. Two ways out:
 * the commits are reachable from SOME remote ref (pushed under another name), or the branch's whole
 * change already sits in the base as one patch (a synthetic squash of HEAD onto the merge-base that
 * `git cherry` finds upstream). Anything else — including a squash the base has since edited over —
 * stays unpushed, so a false "no" costs a `--force` decision and never a lost commit.
 */
async function alreadyLanded(repoPath: string, wtPath: string): Promise<boolean> {
  try {
    if (!(await git(wtPath, ["remote"]))) return false;
    if (Number(await git(wtPath, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) === 0) return true;
    const repo = repos.list().find((r) => r.path === repoPath);
    const base = await baseRef(repoPath, repo?.default_branch || "main");
    if (base === "HEAD") return false;
    const mb = await git(wtPath, ["merge-base", base, "HEAD"]);
    const tree = await git(wtPath, ["rev-parse", "HEAD^{tree}"]);
    const squash = await git(wtPath, ["-c", "user.name=chronos", "-c", "user.email=chronos@localhost", "commit-tree", tree, "-p", mb, "-m", "chronos: squash probe"]);
    return (await git(wtPath, ["cherry", base, squash])).startsWith("-");
  } catch {
    return false;
  }
}

/**
 * Remove a worktree deliberately — Robert's hand, or the terminal that claimed it. Never the reaper's.
 *
 * Refuses rather than asks: a busy tree, uncommitted edits, or unpushed commits all come back as a
 * `blocked` result naming exactly what would be lost, so the caller can put THAT in front of the operator
 * instead of a yes/no. `force` overrides the two content guards (never `busy` — removing the tree a
 * terminal is standing in breaks that terminal, and no operator intent makes that the right move).
 * `owner` is the session removing its OWN tree: it does not count as busy, every other terminal still does.
 */
export async function removeWorktree(
  repoPath: string,
  wtPath: string,
  opts: { force?: boolean; owner?: string } = {},
): Promise<{ ok: true; removed: string; state: WorktreeState } | { ok: false; error: string; state?: WorktreeState }> {
  if (!repoPath || !wtPath) return { ok: false, error: "need a repo and a worktree path" };
  if (wtPath === repoPath) return { ok: false, error: "that is the main checkout, not a worktree" };
  if (!wtPath.includes(".chronos-worktrees")) return { ok: false, error: "not a Chronos worktree — refusing" };
  if (!fs.existsSync(wtPath)) return { ok: false, error: "no such worktree (already gone?)" };
  if (!(await isGitRepo(repoPath))) return { ok: false, error: "not a git repo" };

  const state = await worktreeState(repoPath, wtPath, { ignoreSession: opts.owner });
  if (state.busy)
    return { ok: false, error: `${opts.owner ? "another" : "a"} terminal is working in there right now`, state };
  if (!opts.force) {
    if (state.dirty)
      return { ok: false, error: `${state.dirty_files} uncommitted file(s) — would be lost`, state };
    if (state.unpushed)
      return { ok: false, error: `${state.unpushed} commit(s) not on any remote`, state };
  }
  try {
    await git(repoPath, ["worktree", "remove", "--force", wtPath], 30_000);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), state };
  }
  if (fs.existsSync(wtPath)) return { ok: false, error: "git reported success but the path is still there", state };
  return { ok: true, removed: wtPath, state };
}

const samePath = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
};

/** Name what a force-remove would destroy — the sentence a Lead carries to the operator, never a yes it invents. */
function lossSentence(state: WorktreeState): string {
  if (state.busy) return "a terminal is working in there right now";
  if (state.dirty) return `${state.dirty_files} uncommitted file(s) — would be lost`;
  if (state.unpushed) return `${state.unpushed} commit(s) not on any remote`;
  return "the checkout";
}

/**
 * Does this session's recorded claim match that worktree (path or desk branch)?
 * Used for the owner path and for a Lead recognising a worker's (live or ended) tree.
 */
function sessionClaimsWorktree(
  sess: Pick<Session, "id" | "worktree_path" | "worktree_branch">,
  wt: { path: string; branch: string | null },
): boolean {
  return samePath(sess.worktree_path, wt.path)
    || (!!wt.branch && (wt.branch === sess.worktree_branch || wt.branch === legacyDeskBranch(sess.id)));
}

/**
 * `DELETE /worktrees`, minus HTTP. Robert (admin) may remove any tree; a terminal may remove only the
 * one it claimed — matched by the path recorded on its session or by its own desk branch — and is
 * refused on every other terminal's. A Lead (`caller.lead`) may also remove a tree claimed by one of
 * ITS workers (live or ended) inside its workspace — the same 409s Robert gets, but never `force`
 * (that is the operator's yes, via `mc ask-robert`). `scope` is callerScope(req): null = invalid
 * workspace token. `removed` is set on success so the route can publish; `session_id` is the owner
 * whose claim was cleared.
 */
export async function removeWorktreeAs(
  caller: {
    admin: boolean;
    scope: { ws: string | null } | null;
    session?: string | null;
    agent?: string | null;
    /** Live Lead credential (`leadScope`); grants remove over that Lead's own workers' trees only. */
    lead?: { ws: string; leadId: string } | null;
  },
  ref: string,
  opts: { force?: boolean } = {},
): Promise<{
  status: number;
  body: any;
  removed?: { path: string; branch: string | null; by: string; session_id: string | null };
}> {
  const lead = caller.lead ?? null;
  if (!caller.admin && !caller.session && !lead)
    return {
      status: 403,
      body: { error: "removing a worktree needs your session (MC_SESSION): a terminal may remove only the worktree it claimed — any other is Robert's (x-mc-admin) or that worker's Lead (x-mc-lead)" },
    };
  if (!caller.admin && !lead && caller.scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  const sess = caller.session ? sessions.get(caller.session) : undefined;
  if (!caller.admin && !lead) {
    if (!sess) return { status: 404, body: { error: "no such session" } };
    const ws = caller.scope?.ws ?? null;
    if (ws !== null && sess.workspace_id != null && sess.workspace_id !== ws)
      return { status: 404, body: { error: "not found" } };
  }
  const listWs = caller.admin ? undefined : (lead?.ws ?? sess!.workspace_id ?? undefined);
  const all = await listAllWorktrees(listWs);
  if (ref === "@mine") ref = sess?.worktree_path || sess?.worktree_branch || (sess ? legacyDeskBranch(sess.id) : ref);
  // A terminal naming its repo ("mc worktree rm inventory-docs") means the tree it claimed there.
  const wt = all.find((w) => samePath(w.path, ref) || w.branch === ref)
    ?? (sess ? all.find((w) => w.repo.toLowerCase() === ref.toLowerCase() && sessionClaimsWorktree(sess, w)) : undefined);
  if (!wt) return { status: 404, body: { error: `no Chronos worktree matching "${ref}"` } };
  const owns = !!sess && sessionClaimsWorktree(sess, wt);
  // A Lead may remove a tree its worker claimed — live or ended — inside its workspace. Never another
  // Lead's, never the operator's own, never an orphan outside its workersOf set.
  const workerOwner = lead
    ? sessions.workersOf(lead.leadId).find((w) => sessionClaimsWorktree(w, wt))
    : undefined;
  const leadOwns = !!lead && !!workerOwner && workerOwner.workspace_id === lead.ws;
  if (!caller.admin && !owns && !leadOwns)
    return {
      status: 403,
      body: { error: "that worktree belongs to another terminal — only the terminal that claimed it, that worker's Lead, or Robert can remove it" },
    };
  // Force on a worker's tree is the operator's yes. A Lead carries the refusal to `mc ask-robert`; it
  // never invents the override itself (LEADS.md Powers). Own-tree force via MC_SESSION still works.
  if (opts.force && leadOwns && !owns) {
    const state = await worktreeState(wt.repo_path, wt.path);
    return {
      status: 403,
      body: {
        error: `a lead may not force-remove a worker's worktree — ${lossSentence(state)}; ask the operator (mc ask-robert)`,
      },
    };
  }
  // Lead removing a worker's tree: do NOT pass owner — a live worker still in the tree must 409 busy.
  const out = await removeWorktree(wt.repo_path, wt.path, { force: !!opts.force, owner: owns ? sess!.id : undefined });
  if (!out.ok) return { status: 409, body: out };
  const clearId = owns ? sess!.id : leadOwns ? workerOwner!.id : null;
  const cleared = !!clearId && (
    owns
      ? (samePath(sess!.worktree_path, wt.path) || sess!.worktree_branch === wt.branch)
      : (samePath(workerOwner!.worktree_path, wt.path) || workerOwner!.worktree_branch === wt.branch)
  );
  if (cleared && clearId) sessions.clearWorktree(clearId);
  const by = leadOwns && !owns
    ? `lead:${lead!.leadId.slice(0, 8)}`
    : owns && !caller.admin
      ? sess!.id
      : String(caller.agent || "robert");
  return {
    status: 200,
    body: out,
    removed: {
      path: wt.path,
      branch: wt.branch,
      by,
      session_id: cleared ? clearId : null,
    },
  };
}

/**
 * Every Chronos worktree across every repo, with what each is holding. For `mc worktree list`.
 * Pass `workspaceId` to scope to one workspace's repos; omit (admin/unscoped callers only) to see
 * every workspace's worktrees.
 */
export async function listAllWorktrees(workspaceId?: string): Promise<
  Array<WorktreeState & { repo: string; repo_path: string; session_id: string | null }>
> {
  const live = sessions.list({ status: "live" });
  const out: Array<WorktreeState & { repo: string; repo_path: string; session_id: string | null }> = [];
  for (const repo of repos.list(workspaceId)) {
    if (!repo?.path || !fs.existsSync(repo.path) || !(await isGitRepo(repo.path))) continue;
    for (const wt of await listWorktrees(repo.path)) {
      if (!wt.path.includes(".chronos-worktrees")) continue;
      const st = await worktreeState(repo.path, wt.path);
      out.push({
        ...st,
        branch: st.branch ?? wt.branch,
        repo: repo.name,
        repo_path: repo.path,
        session_id: live.find((s) => s.cwd === wt.path || s.worktree_path === wt.path)?.id ?? null,
      });
    }
  }
  return out;
}

// Remove a worktree once its terminal ends — but ONLY if clean (no uncommitted changes). The branch
// and its commits live in the shared object store, so removing a clean checkout loses nothing; a
// dirty one is left untouched so no in-progress work is destroyed. No-op unless the path is one of
// this repo's worktrees.
export async function cleanupWorktree(repoPath: string, wtPath: string): Promise<void> {
  try {
    if (!repoPath || !wtPath || wtPath === repoPath || !(await isGitRepo(repoPath))) return;
    if (!wtPath.includes(".chronos-worktrees")) return; // only our own
    const dirty = (await git(wtPath, ["status", "--porcelain"])) !== "";
    if (dirty) return;
    await git(repoPath, ["worktree", "remove", "--force", wtPath]);
  } catch {}
}

// Reap worktrees whose ticket is finished. cleanupWorktree only fires when a TERMINAL closes
// (terminal.ts), so a ticket built headlessly leaves its checkout on disk forever: 27 stale worktrees
// holding 4.7GB had piled up in ~/.chronos-worktrees when this was written, all clean, all for done
// tickets. A done ticket's clean checkout is pure cache — the branch and its commits live in the
// shared object store — so removing it loses nothing and `ensureTicketWorktree` rebuilds on demand.
// Conservative on every axis: only branches we made (mc/<key>), only tickets that are `done` (a
// `shipping` ticket still has an open PR), never a dirty tree, never one with a live session or an
// active run in it. Returns how many it removed.
export async function reapDoneWorktrees(): Promise<number> {
  // Branch → keep, for every ticket still open (done and dismissed alike are finished). Unknown
  // branches are kept too, so a
  // hand-made mc/* worktree or another repo's live ticket is never touched.
  const keep = new Set(
    tickets
      .list()
      .filter((t) => !isClosedTicketStatus(t.status))
      .map((t) => ticketBranch(t.key))
  );
  const busyPaths = new Set(
    sessions
      .list({ status: "live" })
      .map((s) => s.cwd)
      .filter((c): c is string => !!c)
  );
  let removed = 0;
  for (const repo of repos.list()) {
    if (!repo?.path || !fs.existsSync(repo.path) || !(await isGitRepo(repo.path))) continue;
    try { await git(repo.path, ["worktree", "prune"]); } catch {}
    for (const wt of await listWorktrees(repo.path)) {
      if (!wt.branch.startsWith("mc/") || keep.has(wt.branch)) continue;
      if (!wt.path.includes(".chronos-worktrees")) continue;
      if (busyPaths.has(wt.path)) continue;
      if (runs.activeTicketRunsInCwd(wt.path).length) continue;
      const before = fs.existsSync(wt.path);
      await cleanupWorktree(repo.path, wt.path);
      if (before && !fs.existsSync(wt.path)) removed++;
    }
  }
  if (removed) console.log(`[worktrees] reaped ${removed} finished-ticket worktree(s)`);
  return removed;
}
