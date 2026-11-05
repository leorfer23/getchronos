/**
 * The wall applied to PRs: a PR belongs to a workspace only when its repo does.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db, repos, workspaces } from "./store.js";
import { clearPrOwnershipCache, prBelongsTo, setRemoteReader, slugOfPr, slugOfRemote } from "./pr-ownership.js";

let remotes: Record<string, string> = {};
setRemoteReader((p) => remotes[p] ?? null);
after(() => setRemoteReader(null));

let n = 0;
const ws = () => workspaces.create({ slug: `own${++n}`, name: `Own ${n}`, config_dir: "/tmp/own" }).id;
const repo = (wsId: string, git_remote: string | null, path = `/tmp/r${++n}`) =>
  repos.create({ workspace_id: wsId, name: `r${n}`, path, git_remote } as any);

beforeEach(() => {
  db.exec("DELETE FROM repo_shares; DELETE FROM repos;");
  remotes = {};
  clearPrOwnershipCache();
});

test("slugs: https, ssh, .git and case all name the same repo", () => {
  assert.equal(slugOfRemote("https://github.com/Acme/App.git"), "acme/app");
  assert.equal(slugOfRemote("git@github.com:acme/app"), "acme/app");
  assert.equal(slugOfRemote("https://gitlab.com/acme/app"), null);
  assert.equal(slugOfPr("https://github.com/Acme/App/pull/12"), "acme/app");
});

test("a registered repo is its workspace's; another workspace's registered repo never is", () => {
  const a = ws(), b = ws();
  repo(a, "https://github.com/acme/app.git");
  repo(b, "git@github.com:initech/api.git");
  assert.equal(prBelongsTo(a, "https://github.com/acme/app/pull/1").ok, true);
  const x = prBelongsTo(a, "https://github.com/initech/api/pull/2");
  assert.equal(x.ok, false);
  assert.match(x.why, /belongs to another workspace/);
});

test("an owner only one workspace uses covers its unregistered repos; a shared owner proves nothing", () => {
  const a = ws(), b = ws(), c = ws();
  repo(a, "https://github.com/acmecorp/app.git");
  repo(b, "https://github.com/me/blog.git");
  repo(c, "https://github.com/me/notes.git");
  assert.equal(prBelongsTo(a, "https://github.com/acmecorp/other-repo/pull/3").ok, true, "the client's own org");
  assert.equal(prBelongsTo(b, "https://github.com/me/notes/pull/4").ok, false, "c's repo, same personal owner");
  assert.equal(prBelongsTo(b, "https://github.com/me/unregistered/pull/5").ok, false, "personal owner used by two workspaces");
  assert.equal(prBelongsTo(b, "https://github.com/me/blog/pull/6").ok, true);
});

test("a repo shared into a workspace counts there; a repo with no remote recorded is read from its checkout", () => {
  const a = ws(), b = ws();
  const r = repo(a, "https://github.com/acme/app.git");
  db.prepare("INSERT INTO repo_shares (repo_id, workspace_id, created_at) VALUES (?,?,?)").run(r.id, b, new Date().toISOString());
  clearPrOwnershipCache();
  assert.equal(prBelongsTo(b, "https://github.com/acme/app/pull/7").ok, true);
  remotes["/tmp/chk"] = "git@github.com:solo/daemon.git";
  repo(b, null, "/tmp/chk");
  clearPrOwnershipCache();
  assert.equal(prBelongsTo(b, "https://github.com/solo/daemon/pull/8").ok, true);
  assert.equal(prBelongsTo(a, "https://github.com/solo/daemon/pull/8").ok, false);
});
