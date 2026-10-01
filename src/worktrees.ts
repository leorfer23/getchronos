import fs from "node:fs";
import path from "node:path";
import { ticketBranch } from "./tickets.js";
import { db, repos, runs, sessions, tickets, workspaces, LOCAL_HOST_ID } from "./store.js";
import { isClosedTicketStatus, type Repo, type Session } from "./types.js";
import { findHost, hostOnline, remoteHosts, type Host } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { normalizeGitRemote } from "./hostlink/git-remote.js";
import type { HostWorktree } from "./hostd/worktrees.js";

import {
  baseRef, cleanupWorktree, ensureBranchWorktree, existingWorktree, git, isGitRepo, listWorktrees, removeWorktreeAt, worktreeRootFor,
  worktreeStateAt, type RemoveWorktreeResult, type WorktreeState,
} from "./worktree-core.js";

// The plain-git helpers (git, isGitRepo, listWorktrees, existingWorktree, baseRef) and the store-free
// state/remove/cleanup rules live in worktree-core.ts so a `chronos host` can run them without the
// store; re-exported for callers here.
export { isGitRepo, cleanupWorktree, type WorktreeState };

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

const defaultBranchOf = (repoPath: string) => repos.list().find((r) => r.path === repoPath)?.default_branch || "main";

/**
 * Is a terminal of THIS brain working in that tree? Only the brain's own (`local`) terminals: a path on
 * another computer can spell the same as one here (two Macs, one username), and that host answers for
 * its own trees (hostd/worktrees.ts). `ignoreSession`: the owner removing its own tree is standing in it
 * by definition — only OTHER live terminals make it busy.
 */
const localBusy = (wtPath: string, ignoreSession?: string) =>
  sessions
    .list({ status: "live" })
    .some((s) => s.id !== ignoreSession && (s.host_id || LOCAL_HOST_ID) === LOCAL_HOST_ID && (s.cwd === wtPath || s.worktree_path === wtPath));

/** Read what a worktree holds, without changing anything. The input to every delete decision. */
export async function worktreeState(
  repoPath: string,
  wtPath: string,
  opts: { ignoreSession?: string } = {},
): Promise<WorktreeState> {
  const st = await worktreeStateAt(repoPath, wtPath, defaultBranchOf(repoPath));
  return { ...st, busy: localBusy(wtPath, opts.ignoreSession) };
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
): Promise<RemoveWorktreeResult> {
  return removeWorktreeAt(repoPath, wtPath, {
    force: opts.force,
    owner: !!opts.owner,
    defaultBranch: defaultBranchOf(repoPath),
    busy: () => localBusy(wtPath, opts.owner),
  });
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
  sess: Pick<Session, "id" | "worktree_path" | "worktree_branch"> & { host_id?: string | null },
  wt: { path: string; branch: string | null; host_id?: string },
): boolean {
  // A claim is on the computer the terminal ran on: the same path or branch on another Mac is not it.
  if (wt.host_id && (sess.host_id || LOCAL_HOST_ID) !== wt.host_id) return false;
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
  // A terminal naming its repo ("mc worktree rm inventory-docs") means the tree it claimed there. The
  // same path or branch can exist on two computers: the caller's own computer is looked at first.
  const myHost = sess ? sess.host_id || LOCAL_HOST_ID : null;
  const pick = (hit: (w: ListedWorktree) => boolean) => all.find((w) => w.host_id === myHost && hit(w)) ?? all.find(hit);
  const wt = pick((w) => samePath(w.path, ref) || w.branch === ref)
    ?? (sess ? all.find((w) => w.repo.toLowerCase() === ref.toLowerCase() && sessionClaimsWorktree(sess, w)) : undefined);
  if (!wt) {
    // A terminal on another computer whose computer is not answering: its tree is there, just unlisted.
    if (sess && myHost !== LOCAL_HOST_ID && !hostOnline(myHost))
      return { status: 409, body: { error: `this terminal's computer (${hostName(findHost(myHost!), myHost!)}) is offline — its worktrees can be removed once it reconnects` } };
    return { status: 404, body: { error: `no Chronos worktree matching "${ref}"` } };
  }
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
    const state = wt.host_id === LOCAL_HOST_ID ? await worktreeState(wt.repo_path, wt.path) : wt;
    return {
      status: 403,
      body: {
        error: `a lead may not force-remove a worker's worktree — ${lossSentence(state)}; ask the operator (mc ask-robert)`,
      },
    };
  }
  // Lead removing a worker's tree: do NOT pass owner — a live worker still in the tree must 409 busy.
  const owner = owns ? sess!.id : undefined;
  const out = wt.host_id === LOCAL_HOST_ID
    ? await removeWorktree(wt.repo_path, wt.path, { force: !!opts.force, owner })
    : await removeRemoteWorktree(wt, { force: !!opts.force, owner });
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

/** One row of `mc worktree list`: where it is (`host_id`, `repo_path` on that host) and what it holds. */
export type ListedWorktree = WorktreeState & {
  repo: string;
  repo_id: string;
  repo_path: string;
  session_id: string | null;
  host_id: string;
};

/**
 * Every Chronos worktree across every repo, with what each is holding. For `mc worktree list`.
 * Pass `workspaceId` to scope to one workspace's repos; omit (admin/unscoped callers only) to see
 * every workspace's worktrees. Trees on other computers come from each online host (remoteWorktrees);
 * an offline host's trees are simply not listed until it reconnects.
 */
export async function listAllWorktrees(workspaceId?: string): Promise<ListedWorktree[]> {
  const live = sessions.list({ status: "live" }).filter((s) => (s.host_id || LOCAL_HOST_ID) === LOCAL_HOST_ID);
  const list = repos.list(workspaceId);
  const out: ListedWorktree[] = [];
  for (const repo of list) {
    if (!repo?.path || !fs.existsSync(repo.path) || !(await isGitRepo(repo.path))) continue;
    for (const wt of await listWorktrees(repo.path)) {
      if (!wt.path.includes(".chronos-worktrees")) continue;
      const st = await worktreeState(repo.path, wt.path);
      out.push({
        ...st,
        branch: st.branch ?? wt.branch,
        repo: repo.name,
        repo_id: repo.id,
        repo_path: repo.path,
        session_id: live.find((s) => s.cwd === wt.path || s.worktree_path === wt.path)?.id ?? null,
        host_id: LOCAL_HOST_ID,
      });
    }
  }
  return out.concat(await remoteWorktrees(list));
}

const onlineRemote = (only?: Host): RemoteHost[] =>
  (only ? [only] : remoteHosts()).filter((h): h is RemoteHost => h instanceof RemoteHost && h.online);

/** Live terminals of THIS brain that run on host `hostId` and sit in (or claimed) `p`. */
const liveOnHostIn = (hostId: string, p: string, ignoreSession?: string) =>
  sessions.list({ status: "live" }).filter((s) => s.host_id === hostId && s.id !== ignoreSession && (s.cwd === p || s.worktree_path === p));

const hostName = (h: Host | undefined, id: string) => (h as RemoteHost | undefined)?.hello?.name ?? id;

/**
 * The trees of `list`'s repos on every online host (hostd/worktrees.ts). A host is asked only about
 * repos by git remote, and its answer is copied field by field: nothing it adds reaches the API.
 */
async function remoteWorktrees(list: Repo[], only?: Host): Promise<ListedWorktree[]> {
  const asked = list.filter((r) => !!r.git_remote);
  const hosts = asked.length ? onlineRemote(only) : [];
  if (!hosts.length) return [];
  const byKey = new Map<string, Repo>();
  for (const r of asked) { const k = normalizeGitRemote(r.git_remote); if (k && !byKey.has(k)) byKey.set(k, r); }
  const args = { repos: [...byKey.values()].map((r) => ({ git_remote: r.git_remote!, default_branch: r.default_branch })) };
  const per = await Promise.all(hosts.map(async (h) => {
    let got: HostWorktree[];
    try {
      got = await h.listWorktrees(args);
    } catch (e: any) {
      // A host from before `worktree_list` has nothing to show here; anything else is worth a line.
      if (!/unknown op/.test(String(e?.message ?? e))) console.warn(`[worktrees] ${h.id}: list failed: ${e?.message ?? e}`);
      return [];
    }
    const rows: ListedWorktree[] = [];
    for (const w of got) {
      const repo = byKey.get(normalizeGitRemote(w?.git_remote) ?? "");
      if (!repo || typeof w.path !== "string") continue;
      const here = liveOnHostIn(h.id, w.path);
      rows.push({
        path: w.path,
        branch: typeof w.branch === "string" ? w.branch : null,
        dirty: !!w.dirty,
        dirty_files: Number(w.dirty_files) || 0,
        unpushed: Number(w.unpushed) || 0,
        busy: !!w.busy || here.length > 0,
        repo: repo.name,
        repo_id: repo.id,
        repo_path: String(w.repo_path ?? ""),
        session_id: here[0]?.id ?? null,
        host_id: h.id,
      });
    }
    return rows;
  }));
  return per.flat();
}

/**
 * removeWorktree for a tree on another computer: the brain's half of "busy" (a terminal of its own on
 * that host claimed or sits in it), then the host's own rules on its own disk (hostd/worktrees.ts).
 */
async function removeRemoteWorktree(wt: ListedWorktree, opts: { force: boolean; owner?: string }): Promise<RemoveWorktreeResult> {
  const h = findHost(wt.host_id);
  if (!(h instanceof RemoteHost) || !h.online) return { ok: false, error: `its computer (${hostName(h, wt.host_id)}) is offline — try again once it reconnects`, state: wt };
  if (liveOnHostIn(wt.host_id, wt.path, opts.owner).length)
    return { ok: false, error: `${opts.owner ? "another" : "a"} terminal is working in there right now`, state: { ...wt, busy: true } };
  const repo = repos.get(wt.repo_id);
  if (!repo?.git_remote) return { ok: false, error: "its repo has no git remote to find it by on that computer" };
  try {
    return await h.removeWorktree({ git_remote: repo.git_remote, default_branch: repo.default_branch, path: wt.path, force: opts.force, owner: opts.owner ?? null });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200), state: wt };
  }
}

/**
 * The end-of-terminal cleanup (terminal.ts) for a terminal that ran on another computer: the same
 * cleanupWorktree rule, run there — only a clean tree goes. A host that is offline (or predates the op)
 * keeps it; a finished ticket's tree is then reaped when the host is next seen (reapRemoteWorktrees).
 */
export async function cleanupRemoteWorktree(hostId: string, repo: Pick<Repo, "git_remote" | "default_branch">, wtPath: string): Promise<void> {
  if (!repo.git_remote || !wtPath || !wtPath.includes(".chronos-worktrees")) return;
  const h = findHost(hostId);
  if (!(h instanceof RemoteHost) || !h.online) {
    console.log(`[worktrees] ${hostId} is offline — leaving ${path.basename(wtPath)} there for the reaper`);
    return;
  }
  try {
    await h.removeWorktree({ git_remote: repo.git_remote, default_branch: repo.default_branch, path: wtPath, mode: "cleanup" });
  } catch (e: any) {
    if (!/unknown op/.test(String(e?.message ?? e))) console.warn(`[worktrees] ${hostId}: cleanup of ${path.basename(wtPath)} failed: ${e?.message ?? e}`);
  }
}

/** Branches of tickets still open: their trees stay (done and dismissed alike are finished). */
function openTicketBranches(): Set<string> {
  return new Set(
    tickets
      .list()
      .filter((t) => !isClosedTicketStatus(t.status))
      .map((t) => ticketBranch(t.key))
  );
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
  const keep = openTicketBranches();
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
  return removed + (await reapRemoteWorktrees(undefined, keep));
}

/**
 * reapDoneWorktrees for the trees on other computers — the same rule, nothing looser: an `mc/<key>`
 * branch whose ticket is finished, clean, no terminal or run in it (the host's own processes and this
 * brain's sessions on that host), no active run pinned there. Each host removes its own (`cleanup`
 * mode: a dirty tree is left). Runs with the monitor's sweep and when a host comes back online
 * (remote-terminals.ts), which is also where a terminal that ended while its host was away gets its
 * tree back. `only` = one host.
 */
export async function reapRemoteWorktrees(only?: Host, keep = openTicketBranches()): Promise<number> {
  const hosts = onlineRemote(only);
  if (!hosts.length) return 0;
  const all = repos.list();
  let removed = 0;
  for (const h of hosts) {
    for (const w of await remoteWorktrees(all, h)) {
      if (!w.branch?.startsWith("mc/") || keep.has(w.branch)) continue;
      if (w.busy || w.dirty) continue;
      if (runs.activeTicketRunsInCwd(w.path).length) continue;
      const repo = repos.get(w.repo_id);
      if (!repo?.git_remote) continue;
      try {
        const r = await h.removeWorktree({ git_remote: repo.git_remote, default_branch: repo.default_branch, path: w.path, mode: "cleanup" });
        if (r?.ok) removed++;
      } catch (e: any) {
        console.warn(`[worktrees] ${h.id}: reap of ${path.basename(w.path)} failed: ${e?.message ?? e}`);
        break; // the host went away mid-sweep: the next sweep or hello picks up the rest
      }
    }
  }
  if (removed) console.log(`[worktrees] reaped ${removed} finished-ticket worktree(s) on other computers`);
  return removed;
}
