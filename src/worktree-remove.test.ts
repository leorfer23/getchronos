/**
 * Deliberate worktree removal — Robert's hand. Every test here is about what he must NOT be able to
 * destroy on his own judgment.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db, repos, sessions, workspaces } from "./store.js";
import { branchInitials, deskBranchName, ensureSessionWorktree, removeWorktree, removeWorktreeAs, worktreeState } from "./worktrees.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let tmp: string;
let repoPath: string;
let wsId: string;
let repoId: string;

function makeRepo(): string {
  const p = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(p, ["init", "-q", "-b", "main"]);
  git(p, ["config", "user.email", "t@t.t"]);
  git(p, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(p, "README.md"), "hello\n");
  git(p, ["add", "-A"]);
  git(p, ["commit", "-qm", "init"]);
  return fs.realpathSync(p);
}

beforeEach(() => {
  for (const t of ["sessions", "repos", "workspaces"]) db.prepare(`DELETE FROM ${t}`).run();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  repoPath = makeRepo();
  wsId = workspaces.create({ slug: "wt-" + randomUUID().slice(0, 8), name: "T", config_dir: "/tmp/wt" } as any).id;
  repoId = repos.create({ workspace_id: wsId, name: "t-repo", path: repoPath, default_branch: "main" } as any).id;
});

const newSession = () =>
  sessions.create({ workspace_id: wsId, repo_id: repoId, cwd: repoPath, backend: "claude-code" });

describe("ensureSessionWorktree", () => {
  test("gives a terminal its own checkout on its own branch", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))?.path;
    assert.ok(wt, "expected a worktree path");
    assert.ok(fs.existsSync(wt!));
    assert.notEqual(wt, repoPath);
    assert.equal(git(wt!, ["rev-parse", "--abbrev-ref", "HEAD"]), deskBranchName(s));
  });

  test("is idempotent — a confused agent asking twice gets ONE checkout", async () => {
    const s = newSession();
    const a = await ensureSessionWorktree(repos.get(repoId)!, s);
    const b = await ensureSessionWorktree(repos.get(repoId)!, s);
    assert.deepEqual(a, b);
  });

  test("two terminals on one repo get different trees — the whole point", async () => {
    const a = (await ensureSessionWorktree(repos.get(repoId)!, newSession()))?.path;
    const b = (await ensureSessionWorktree(repos.get(repoId)!, newSession()))?.path;
    assert.notEqual(a, b);
  });
});

describe("desk branch names", () => {
  const sess = (over: Record<string, unknown> = {}) =>
    ({ id: "fbe4b604-aaaa", workspace_id: wsId, goal: null, spawn_goal: null, title: null, worktree_branch: null, ...over }) as any;

  test("initials from the workspace git author", () => {
    assert.equal(branchInitials("Leonel Fernández"), "lf");
    assert.equal(branchInitials(""), "mc");
  });

  test("<initials>/<type>/<topic> from the goal, type inferred", () => {
    db.prepare("UPDATE workspaces SET git_name = ? WHERE id = ?").run("Leonel Fernandez", wsId);
    assert.equal(deskBranchName(sess({ goal: "Arreglar el scroll del Desk en el teléfono" })), "lf/fix/arreglar-scroll-desk-telefono");
    assert.equal(deskBranchName(sess({ goal: "Add CSV export to the dashboard" })), "lf/feat/add-csv-export-dashboard");
    assert.equal(deskBranchName(sess()), "lf/feat/fbe4b604");
  });

  test("CHRONOS_BRANCH_INITIALS is used as-is, not re-abbreviated", () => {
    const prev = process.env.CHRONOS_BRANCH_INITIALS;
    process.env.CHRONOS_BRANCH_INITIALS = "lf";
    try {
      assert.equal(deskBranchName(sess({ goal: "Fix the desk scrollbar" })), "lf/fix/desk-scrollbar");
    } finally {
      if (prev === undefined) delete process.env.CHRONOS_BRANCH_INITIALS;
      else process.env.CHRONOS_BRANCH_INITIALS = prev;
    }
  });

  test("the agent's own name wins", () => {
    db.prepare("UPDATE workspaces SET git_name = ? WHERE id = ?").run("Leonel Fernandez", wsId);
    assert.equal(deskBranchName(sess({ goal: "whatever" }), "refactor/Worktree Naming"), "lf/refactor/worktree-naming");
    assert.equal(deskBranchName(sess({ goal: "whatever" }), "desk scrollbar bug"), "lf/fix/desk-scrollbar-bug");
  });

  test("a name another terminal already claimed gets a short-id suffix", async () => {
    const goal = "fix login redirect";
    const a = sessions.create({ workspace_id: wsId, repo_id: repoId, cwd: repoPath, backend: "claude-code" });
    db.prepare("UPDATE sessions SET goal = ? WHERE id = ?").run(goal, a.id);
    const wa = (await ensureSessionWorktree(repos.get(repoId)!, sessions.get(a.id)!))!;
    sessions.setWorktree(a.id, { path: wa.path, branch: wa.branch });
    const b = sessions.create({ workspace_id: wsId, repo_id: repoId, cwd: repoPath, backend: "claude-code" });
    db.prepare("UPDATE sessions SET goal = ? WHERE id = ?").run(goal, b.id);
    const wb = (await ensureSessionWorktree(repos.get(repoId)!, sessions.get(b.id)!))!;
    assert.match(wa.branch, /^[a-z]+\/fix\/login-redirect$/);
    assert.equal(wb.branch, `${wa.branch}-${b.id.slice(0, 4)}`);
    assert.notEqual(wa.path, wb.path);
  });
});

describe("removeWorktree refuses to destroy work", () => {
  test("removes a clean, pushed-equivalent tree", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    const out = await removeWorktree(repoPath, wt);
    assert.equal(out.ok, true);
    assert.equal(fs.existsSync(wt), false);
  });

  test("REFUSES a tree with uncommitted files, and says how many", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    fs.writeFileSync(path.join(wt, "wip.txt"), "an hour of work\n");
    const out = await removeWorktree(repoPath, wt);
    assert.equal(out.ok, false);
    assert.ok(/uncommitted/.test((out as any).error), (out as any).error);
    assert.equal(fs.existsSync(wt), true, "the tree must still be there");
    assert.equal(fs.readFileSync(path.join(wt, "wip.txt"), "utf8"), "an hour of work\n");
  });

  test("REFUSES a tree holding commits no remote has", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    fs.writeFileSync(path.join(wt, "f.txt"), "x\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-qm", "work"]);
    const out = await removeWorktree(repoPath, wt);
    assert.equal(out.ok, false);
    assert.ok(/not on any remote/.test((out as any).error), (out as any).error);
    assert.equal(fs.existsSync(wt), true);
  });

  test("REFUSES while a terminal is working in there — and force does NOT override that", async () => {
    // The one guard with no operator escape hatch: removing the tree an agent is standing in breaks
    // that agent, and no amount of "yes I'm sure" makes that the right move.
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    sessions.setWorktree(s.id, { path: wt, branch: deskBranchName(s) });
    const plain = await removeWorktree(repoPath, wt);
    assert.equal(plain.ok, false);
    assert.ok(/working in there/.test((plain as any).error));
    const forced = await removeWorktree(repoPath, wt, { force: true });
    assert.equal(forced.ok, false, "force must not override a busy tree");
    assert.equal(fs.existsSync(wt), true);
  });

  test("force DOES override uncommitted work — that is what the operator's yes buys", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    fs.writeFileSync(path.join(wt, "wip.txt"), "throwaway\n");
    const out = await removeWorktree(repoPath, wt, { force: true });
    assert.equal(out.ok, true);
    assert.equal(fs.existsSync(wt), false);
  });

  test("never touches the main checkout, or anything outside .chronos-worktrees", async () => {
    const main = await removeWorktree(repoPath, repoPath);
    assert.equal(main.ok, false);
    assert.ok(/main checkout/.test((main as any).error));
    assert.equal(fs.existsSync(repoPath), true);

    const outside = fs.mkdtempSync(path.join(tmp, "not-ours-"));
    const other = await removeWorktree(repoPath, outside);
    assert.equal(other.ok, false);
    assert.ok(/not a Chronos worktree/.test((other as any).error));
    assert.equal(fs.existsSync(outside), true);
  });
});

describe("removeWorktree — the owner removing its own tree", () => {
  const claim = async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    sessions.setWorktree(s.id, { path: wt, branch: deskBranchName(s) });
    return { s, wt };
  };

  test("removes its own clean tree while its session is live — busy only by itself is not busy", async () => {
    const { s, wt } = await claim();
    assert.equal((await removeWorktree(repoPath, wt)).ok, false, "without owner it reads as busy");
    const out = await removeWorktree(repoPath, wt, { owner: s.id });
    assert.equal(out.ok, true, (out as any).error);
    assert.equal(fs.existsSync(wt), false);
  });

  test("REFUSED when ANOTHER live terminal is in there — force too", async () => {
    const { s, wt } = await claim();
    sessions.create({ workspace_id: wsId, repo_id: repoId, cwd: wt, backend: "claude-code" });
    const plain = await removeWorktree(repoPath, wt, { owner: s.id });
    assert.equal(plain.ok, false);
    assert.ok(/another terminal is working in there/.test((plain as any).error), (plain as any).error);
    const forced = await removeWorktree(repoPath, wt, { owner: s.id, force: true });
    assert.equal(forced.ok, false, "force must not override another terminal");
    assert.equal(fs.existsSync(wt), true);
  });

  test("own dirty tree is refused without force, removed with it", async () => {
    const { s, wt } = await claim();
    fs.writeFileSync(path.join(wt, "wip.txt"), "mine\n");
    const plain = await removeWorktree(repoPath, wt, { owner: s.id });
    assert.equal(plain.ok, false);
    assert.ok(/uncommitted/.test((plain as any).error), (plain as any).error);
    assert.equal(fs.existsSync(wt), true);
    const forced = await removeWorktree(repoPath, wt, { owner: s.id, force: true });
    assert.equal(forced.ok, true, (forced as any).error);
    assert.equal(fs.existsSync(wt), false);
  });
});

describe("DELETE /worktrees authorization (removeWorktreeAs)", () => {
  const claim = async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    sessions.setWorktree(s.id, { path: wt, branch: deskBranchName(s), repo_id: repoId });
    return { s, wt };
  };
  const scoped = { ws: null as string | null };

  test("non-admin with its own session → 200, tree gone, session's claim cleared", async () => {
    const { s, wt } = await claim();
    const out = await removeWorktreeAs({ admin: false, scope: { ws: wsId }, session: s.id }, wt);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(fs.existsSync(wt), false);
    assert.equal(out.removed?.by, s.id);
    assert.equal(out.removed?.session_id, s.id);
    const after = sessions.get(s.id)!;
    assert.equal(after.worktree_path, null);
    assert.equal(after.worktree_branch, null);
  });

  test("non-admin may name its tree by its desk branch too", async () => {
    const { s, wt } = await claim();
    const out = await removeWorktreeAs({ admin: false, scope: scoped, session: s.id }, deskBranchName(s));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(fs.existsSync(wt), false);
  });

  test("non-admin on ANOTHER terminal's tree → 403, tree still there", async () => {
    const { wt } = await claim();
    const me = newSession();
    const out = await removeWorktreeAs({ admin: false, scope: { ws: wsId }, session: me.id }, wt, { force: true });
    assert.equal(out.status, 403);
    assert.ok(/another terminal/.test(out.body.error), out.body.error);
    assert.equal(fs.existsSync(wt), true);
  });

  test("non-admin without a session → 403, as before", async () => {
    const { s, wt } = await claim();
    sessions.clearWorktree(s.id); // not busy — so only the missing session can refuse it
    const out = await removeWorktreeAs({ admin: false, scope: scoped }, wt);
    assert.equal(out.status, 403);
    assert.equal(fs.existsSync(wt), true);
  });

  test("cross-workspace token → refused, tree still there", async () => {
    const { s, wt } = await claim();
    const other = workspaces.create({ slug: "wt-" + randomUUID().slice(0, 8), name: "O", config_dir: "/tmp/wt2" } as any).id;
    const out = await removeWorktreeAs({ admin: false, scope: { ws: other }, session: s.id }, wt);
    assert.equal(out.status, 404);
    assert.equal(fs.existsSync(wt), true);

    // …and a session in the other workspace can't reach this workspace's tree either.
    const theirs = sessions.create({ workspace_id: other, cwd: tmp, backend: "claude-code" });
    const out2 = await removeWorktreeAs({ admin: false, scope: { ws: other }, session: theirs.id }, wt);
    assert.equal(out2.status, 404);
    assert.equal(fs.existsSync(wt), true);
  });

  test("unknown session → 404; invalid token → 401", async () => {
    const { s, wt } = await claim();
    assert.equal((await removeWorktreeAs({ admin: false, scope: scoped, session: "nope" }, wt)).status, 404);
    assert.equal((await removeWorktreeAs({ admin: false, scope: null, session: s.id }, wt)).status, 401);
    assert.equal(fs.existsSync(wt), true);
  });

  test("admin is unchanged: removes an idle tree it does not own, busy still refused", async () => {
    const idle = newSession();
    const idleWt = (await ensureSessionWorktree(repos.get(repoId)!, idle))!.path;
    const ok = await removeWorktreeAs({ admin: true, scope: scoped, agent: "robert" }, idleWt);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.removed?.by, "robert");
    const { wt } = await claim();
    const busy = await removeWorktreeAs({ admin: true, scope: scoped }, wt, { force: true });
    assert.equal(busy.status, 409);
    assert.equal(fs.existsSync(wt), true);
  });
});

describe("worktreeState", () => {
  test("reports what a delete would cost, without changing anything", async () => {
    const s = newSession();
    const wt = (await ensureSessionWorktree(repos.get(repoId)!, s))!.path;
    fs.writeFileSync(path.join(wt, "a.txt"), "1\n");
    fs.writeFileSync(path.join(wt, "b.txt"), "2\n");
    const st = await worktreeState(repoPath, wt);
    assert.equal(st.dirty, true);
    assert.equal(st.dirty_files, 2);
    assert.equal(st.branch, deskBranchName(s));
    assert.equal(st.busy, false);
    assert.equal(fs.existsSync(path.join(wt, "a.txt")), true, "reading state must not clean the tree");
  });
});
