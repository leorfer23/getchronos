/**
 * Shared repos (repo_shares, migration 146): a repo one workspace owns, shared into another so its
 * sandboxed agents can work in it. Every test here is about one rule — a share widens access for the
 * workspace it names and for no one else, and the owner's main checkout stays read-only to a borrower.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db, repos, sessions, workspaces } from "./store.js";
import { buildProfile, sandboxAvailable, SANDBOX_EXEC } from "./sandbox.js";
import { mainCheckouts } from "./terminal.js";
import { checkCwd } from "./spawn-guard.js";
import { checkRepoScope } from "./authz.js";
import { ensureSessionWorktree, findClaimRepo, listAllWorktrees, removeWorktreeAs } from "./worktrees.js";
import { sharedInReadonly, sharedReposBlock, sharedRepoViews } from "./shared-repos.js";
import { worktreeRootFor } from "./worktree-core.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let tmp: string;
const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: path.join(tmp, `cfg-${slug}`) } as any);

function makeRepo(name: string): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(p);
  git(p, ["init", "-q", "-b", "main"]);
  git(p, ["config", "user.email", "t@t.t"]);
  git(p, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(p, "README.md"), "hello\n");
  git(p, ["add", "-A"]);
  git(p, ["commit", "-qm", "init"]);
  return fs.realpathSync(p);
}

let owner: ReturnType<typeof mkWs>, borrower: ReturnType<typeof mkWs>, stranger: ReturnType<typeof mkWs>;
let sharedPath: string, ownPath: string, strangerPath: string;
let sharedId: string, ownId: string, strangerId: string;

beforeEach(() => {
  for (const t of ["repo_shares", "sessions", "repos", "workspaces"]) db.prepare(`DELETE FROM ${t}`).run();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-shares-")));
  owner = mkWs("shareout");
  borrower = mkWs("gfm");
  stranger = mkWs("acme");
  sharedPath = makeRepo("shareout");
  ownPath = makeRepo("gfm-app");
  strangerPath = makeRepo("acme-app");
  sharedId = repos.create({ workspace_id: owner.id, name: "shareout", path: sharedPath } as any).id;
  ownId = repos.create({ workspace_id: borrower.id, name: "gfm-app", path: ownPath } as any).id;
  strangerId = repos.create({ workspace_id: stranger.id, name: "acme-app", path: strangerPath } as any).id;
});

describe("store", () => {
  test("share / sharesOf / sharedWith / accessible / unshare", () => {
    assert.deepEqual(repos.sharesOf(sharedId), []);
    repos.share(sharedId, borrower.id);
    repos.share(sharedId, borrower.id); // idempotent
    assert.deepEqual(repos.sharesOf(sharedId), [borrower.id]);
    assert.deepEqual(repos.sharedWith(borrower.id).map((r) => r.id), [sharedId]);
    assert.deepEqual(repos.accessible(borrower.id).map((r) => r.id).sort(), [ownId, sharedId].sort());
    // list() keeps meaning OWNED only — every planning/ownership path reads it.
    assert.deepEqual(repos.list(borrower.id).map((r) => r.id), [ownId]);
    assert.deepEqual(repos.list(owner.id).map((r) => r.id), [sharedId]);
    // Nobody else gained anything.
    assert.deepEqual(repos.sharedWith(stranger.id), []);
    assert.deepEqual(repos.accessible(stranger.id).map((r) => r.id), [strangerId]);
    assert.deepEqual(repos.accessible(owner.id).map((r) => r.id), [sharedId]);
    assert.equal(repos.canAccess(repos.get(sharedId)!, borrower.id), true);
    assert.equal(repos.canAccess(repos.get(sharedId)!, owner.id), true);
    assert.equal(repos.canAccess(repos.get(sharedId)!, stranger.id), false);

    assert.equal(repos.unshare(sharedId, borrower.id), true);
    assert.equal(repos.unshare(sharedId, borrower.id), false);
    assert.deepEqual(repos.accessible(borrower.id).map((r) => r.id), [ownId]);
  });

  test("refuses sharing with the owner and an unknown repo", () => {
    assert.throws(() => repos.share(sharedId, owner.id), /owns it/);
    assert.throws(() => repos.share("nope", borrower.id), /not found/);
    assert.deepEqual(repos.sharesOf(sharedId), []);
  });

  test("a share dies with its repo or with the borrowing workspace", () => {
    repos.share(sharedId, borrower.id);
    repos.share(sharedId, stranger.id);
    workspaces.remove(stranger.id);
    assert.deepEqual(repos.sharesOf(sharedId), [borrower.id]);
    repos.remove(sharedId);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM repo_shares").get() as any).n, 0);
    assert.deepEqual(repos.sharedWith(borrower.id), []);
  });

  test("sharedRepoViews names the owner", () => {
    repos.share(sharedId, borrower.id);
    assert.deepEqual(sharedRepoViews(borrower.id), [
      { id: sharedId, name: "shareout", path: sharedPath, git_remote: null, owner_id: owner.id, owner_slug: owner.slug, owner_name: "shareout" },
    ]);
    assert.deepEqual(sharedRepoViews(stranger.id), []);
  });
});

describe("isolationDenyDirs", () => {
  test("drops a repo shared INTO the workspace; every other workspace still denies it", () => {
    assert.ok(workspaces.isolationDenyDirs(borrower.id).includes(sharedPath), "denied before the share");
    repos.share(sharedId, borrower.id);
    const b = workspaces.isolationDenyDirs(borrower.id);
    assert.ok(!b.includes(sharedPath), "the borrower may reach it now");
    assert.ok(b.includes(strangerPath), "the stranger's repo is still denied to the borrower");
    assert.ok(workspaces.isolationDenyDirs(stranger.id).includes(sharedPath), "a share widens nothing for a third workspace");
    assert.ok(workspaces.isolationDenyDirs(stranger.id).includes(ownPath));
    // The owner's own view is unchanged: it never denied its own repo, still denies the others.
    const o = workspaces.isolationDenyDirs(owner.id);
    assert.ok(!o.includes(sharedPath));
    assert.ok(o.includes(ownPath) && o.includes(strangerPath));
    // ...and sharing never lets the owner into the borrower's repos.
    repos.unshare(sharedId, borrower.id);
    assert.ok(workspaces.isolationDenyDirs(borrower.id).includes(sharedPath), "unshare puts the wall back");
  });

  test("sharedInReadonly is the shared repos' main checkouts, for the borrower only", () => {
    repos.share(sharedId, borrower.id);
    assert.deepEqual(sharedInReadonly(borrower.id), [sharedPath]);
    assert.deepEqual(sharedInReadonly(stranger.id), []);
    assert.deepEqual(sharedInReadonly(owner.id), []);
    assert.deepEqual(sharedInReadonly(null), []);
  });
});

// The profile a borrowing workspace's Desk terminal gets, built from the same inputs terminal.ts uses.
function borrowerProfile(wsId: string) {
  const reachable = repos.accessible(wsId);
  const wtRoot = worktreeRootFor(sharedPath);
  fs.mkdirSync(wtRoot, { recursive: true });
  const addDirs = reachable.flatMap((r) => [r.path, worktreeRootFor(r.path)]).filter((p) => p !== ownPath);
  return {
    wtRoot,
    profile: buildProfile("guard", ownPath, addDirs, path.join(tmp, "cfg"), workspaces.isolationDenyDirs(wsId), false, mainCheckouts(reachable.map((r) => r.path)))!,
  };
}

const noSandbox = sandboxAvailable() ? false : "sandbox-exec is macOS-only — no profile to read";

describe("buildProfile for a borrowing workspace", () => {
  test("shared repo readable, its main checkout write-denied, its worktree root writable", { skip: noSandbox }, () => {
    repos.share(sharedId, borrower.id);
    const { profile, wtRoot } = borrowerProfile(borrower.id);
    const lines = profile.split("\n");
    const denyRead = lines.find((l) => l.startsWith("(deny file-read*") && l.includes(strangerPath));
    assert.ok(denyRead, "the stranger's repo is still read-denied");
    assert.ok(!denyRead!.includes(`"${sharedPath}"`), "the shared repo is not read-denied");
    const roDeny = lines.findIndex((l) => l.startsWith("(deny file-write*") && l.includes(`(subpath "${sharedPath}")`) && !l.includes(strangerPath));
    const ownGrant = lines.findIndex((l) => l.startsWith("(allow file-write*") && l.includes(`(subpath "${wtRoot}")`));
    assert.ok(roDeny >= 0, "the shared main checkout is write-denied");
    assert.ok(ownGrant >= 0 && ownGrant < roDeny, "the worktree root is granted, and the read-only deny comes after the grants");
    // The worktree root is not inside the main checkout, so the read-only deny never touches it.
    assert.ok(!lines[roDeny].includes(`"${wtRoot}"`));
  });

  test("for real: borrower reads the shared repo, cannot write it, works in its worktree; a stranger cannot read it", { skip: noSandbox }, () => {
    repos.share(sharedId, borrower.id);
    const { profile, wtRoot } = borrowerProfile(borrower.id);
    const run = (p: string, cmd: string) => spawnSync(SANDBOX_EXEC, ["-p", p, "/bin/sh", "-c", cmd], { cwd: ownPath, encoding: "utf8" });
    const probe = run("(version 1)(allow default)", "true");
    if (probe.status !== 0 && /sandbox_apply/.test(probe.stderr)) return; // nested sandbox (a guard Desk terminal): nothing to prove here
    const read = run(profile, `cat ${JSON.stringify(path.join(sharedPath, "README.md"))}`);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stdout, "hello\n");
    const write = run(profile, `echo x >> ${JSON.stringify(path.join(sharedPath, "README.md"))}`);
    assert.notEqual(write.status, 0, "the owner's main checkout must stay read-only");
    assert.equal(fs.readFileSync(path.join(sharedPath, "README.md"), "utf8"), "hello\n");
    const wt = run(profile, `echo ok > ${JSON.stringify(path.join(wtRoot, "probe.txt"))}`);
    assert.equal(wt.status, 0, wt.stderr);

    const strangerProfile = buildProfile("guard", strangerPath, [], path.join(tmp, "cfg"), workspaces.isolationDenyDirs(stranger.id), false, [])!;
    const peek = spawnSync(SANDBOX_EXEC, ["-p", strangerProfile, "/bin/sh", "-c", `cat ${JSON.stringify(path.join(sharedPath, "README.md"))}`], { cwd: strangerPath, encoding: "utf8" });
    assert.notEqual(peek.status, 0, "a workspace the repo was NOT shared with is still walled off");
  });
});

describe("spawn-guard", () => {
  test("a borrower may open a terminal/job in the shared repo or its worktrees; a stranger may not", () => {
    const wt = path.join(worktreeRootFor(sharedPath), "desk-x");
    fs.mkdirSync(wt, { recursive: true });
    assert.equal(checkCwd(sharedPath, borrower.id).ok, false, "not before the share");
    repos.share(sharedId, borrower.id);
    assert.equal(checkCwd(sharedPath, borrower.id).ok, true);
    assert.equal(checkCwd(wt, borrower.id).ok, true);
    assert.equal(checkCwd(sharedPath, stranger.id).ok, false);
    assert.equal(checkCwd(wt, stranger.id).ok, false);
    assert.equal(checkCwd(sharedPath, owner.id).ok, true);
    assert.equal(checkCwd(ownPath, owner.id).ok, false, "the owner gains nothing from the borrower");
  });
});

describe("mc worktree in a shared repo", () => {
  test("findClaimRepo: borrower finds it, stranger does not, owner unaffected, own repo wins a name tie", () => {
    assert.equal(findClaimRepo(borrower.id, "shareout").repo, undefined);
    repos.share(sharedId, borrower.id);
    assert.equal(findClaimRepo(borrower.id, "shareout").repo?.id, sharedId);
    assert.equal(findClaimRepo(borrower.id, sharedId).repo?.id, sharedId);
    assert.equal(findClaimRepo(stranger.id, "shareout").repo, undefined);
    assert.equal(findClaimRepo(stranger.id, sharedId).repo, undefined);
    assert.equal(findClaimRepo(owner.id, "shareout").repo?.id, sharedId);
    // A borrower's own repo named like the shared one wins.
    const dup = makeRepo("dup");
    const mine = repos.create({ workspace_id: borrower.id, name: "shareout", path: dup } as any).id;
    assert.equal(findClaimRepo(borrower.id, "shareout").repo?.id, mine);
  });

  test("a borrower lists and removes the tree IT claimed in a shared repo — never the owner's", async () => {
    repos.share(sharedId, borrower.id);
    const mine = sessions.create({ workspace_id: borrower.id, cwd: ownPath, backend: "claude-code" } as any);
    const theirs = sessions.create({ workspace_id: owner.id, repo_id: sharedId, cwd: sharedPath, backend: "claude-code" } as any);
    const myTree = (await ensureSessionWorktree(repos.get(sharedId)!, mine, "borrow"))!;
    sessions.setWorktree(mine.id, { path: myTree.path, branch: myTree.branch, repo_id: sharedId });
    const ownerTree = (await ensureSessionWorktree(repos.get(sharedId)!, theirs, "owner"))!;
    sessions.setWorktree(theirs.id, { path: ownerTree.path, branch: ownerTree.branch, repo_id: sharedId });

    const listed = (await listAllWorktrees(borrower.id)).map((w) => w.path);
    assert.ok(listed.includes(myTree.path));
    assert.deepEqual((await listAllWorktrees(stranger.id)).map((w) => w.path), [], "a stranger sees no tree of the shared repo");

    const scope = { ws: borrower.id };
    const refused = await removeWorktreeAs({ admin: false, scope, session: mine.id }, ownerTree.path);
    assert.equal(refused.status, 403, "the owner's tree is not the borrower's to remove");
    assert.ok(fs.existsSync(ownerTree.path));
    const ok = await removeWorktreeAs({ admin: false, scope, session: mine.id }, myTree.path);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(!fs.existsSync(myTree.path));
  });
});

describe("checkRepoScope", () => {
  const req = (h: Record<string, string> = {}): any => ({ get: (k: string) => h[k.toLowerCase()] });
  const res = (): any => {
    const r: any = { statusCode: 200 };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: unknown) => { r.body = b; return r; };
    return r;
  };
  test("owner and borrower pass; a stranger gets the same 404; a bad token 401s", () => {
    const repo = repos.get(sharedId)!;
    const tok = (w: { token?: string | null }) => ({ "x-mc-workspace-token": String(w.token) });
    const strangerRes = res();
    assert.equal(checkRepoScope(req(tok(borrower)), strangerRes, repo), false, "not before the share");
    assert.equal(strangerRes.statusCode, 404);
    repos.share(sharedId, borrower.id);
    assert.equal(checkRepoScope(req(tok(borrower)), res(), repo), true);
    assert.equal(checkRepoScope(req(tok(owner)), res(), repo), true);
    const r3 = res();
    assert.equal(checkRepoScope(req(tok(stranger)), r3, repo), false);
    assert.equal(r3.statusCode, 404);
    const r4 = res();
    assert.equal(checkRepoScope(req({ "x-mc-workspace-token": "forged" }), r4, repo), false);
    assert.equal(r4.statusCode, 401);
    assert.equal(checkRepoScope(req(), res(), repo), true, "the operator (no token) is unrestricted, as everywhere");
  });
});

describe("agent awareness", () => {
  test("a borrower is told about the shared repo; a stranger is told nothing", () => {
    assert.equal(sharedReposBlock(borrower.id), "");
    repos.share(sharedId, borrower.id);
    const b = sharedReposBlock(borrower.id);
    assert.match(b, /shareout \(shared from shareout\): /);
    assert.ok(b.includes(sharedPath));
    assert.match(b, /mc worktree/);
    assert.ok(!sharedReposBlock(borrower.id, { paths: false }).includes(sharedPath), "a terminal on another computer gets no brain path");
    assert.equal(sharedReposBlock(stranger.id), "");
  });
});

describe("API surface (source contract)", () => {
  const api = fs.readFileSync(path.join(import.meta.dirname, "api.ts"), "utf8");
  test("every share route is admin-gated", () => {
    for (const route of ['api.get("/repos/:id/shares", requireAdmin', 'api.post("/repos/:id/shares", requireAdmin, validate(ShareRepoSchema)', 'api.delete("/repos/:id/shares/:workspaceId", requireAdmin'])
      assert.ok(api.includes(route), route);
  });
  test("sharing with the owner is a 400, an unknown repo/workspace a 404", () => {
    const at = api.indexOf('api.post("/repos/:id/shares"');
    const body = api.slice(at, api.indexOf('api.delete("/repos/:id/shares/', at));
    assert.match(body, /status\(404\)\.json\(\{ error: "repo not found" \}\)/);
    assert.match(body, /status\(404\)\.json\(\{ error: "workspace not found" \}\)/);
    assert.match(body, /ws\.id === repo\.workspace_id\) return res\.status\(400\)/);
    assert.match(body, /workspace\.changed/);
  });
  test("the worktree claim resolves through findClaimRepo (owned ∪ shared), not repos.list", () => {
    const at = api.indexOf('api.post("/sessions/:id/worktree"');
    const body = api.slice(at, api.indexOf("api.get(\"/worktrees\"", at));
    assert.match(body, /checkScope\(req, res, sess\.workspace_id\)/);
    assert.match(body, /findClaimRepo\(sess\.workspace_id, ref\)/);
  });
});
