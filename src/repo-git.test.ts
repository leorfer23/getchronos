import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  RepoGitError,
  detectDefaultBranch,
  detectOriginUrl,
  resolveRepoGitFields,
} from "./repo-git.js";

function tmpGit(opts: {
  branch?: string;
  remote?: string;
  setOriginHead?: boolean;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-repo-git-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const branch = opts.branch ?? "main";
  const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-b", branch);
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
  g("add", "-A");
  g("commit", "-m", "init");
  if (opts.remote) {
    g("remote", "add", "origin", opts.remote);
    // Simulate a clone: origin/<branch> tracking + origin/HEAD so symbolic-ref works offline.
    g("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    if (opts.setOriginHead !== false) {
      g("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
    }
  }
  return repo;
}

test("detectOriginUrl / detectDefaultBranch read the checkout", async () => {
  const remote = "git@github.com:acme-solutions/warehouse-dbt-migrations.git";
  const repo = tmpGit({ branch: "master", remote });
  assert.equal(await detectOriginUrl(repo), remote);
  assert.equal(await detectDefaultBranch(repo), "master");
});

test("detectDefaultBranch falls back to current branch when origin/HEAD is unset", async () => {
  const repo = tmpGit({
    branch: "master",
    remote: "git@github.com:x/y.git",
    setOriginHead: false,
  });
  // Still finds master via refs/remotes/origin/master (we updated that ref).
  assert.equal(await detectDefaultBranch(repo), "master");
});

test("resolveRepoGitFields autodetects omitted fields (PER-19 CASO)", async () => {
  const remote = "git@github.com:acme-solutions/warehouse-dbt-migrations.git";
  const repo = tmpGit({ branch: "master", remote });
  const r = await resolveRepoGitFields({
    path: repo,
    delivery: "pr",
    explicit: { default_branch: false, git_remote: false },
  });
  assert.equal(r.default_branch, "master");
  assert.equal(r.git_remote, remote);
  assert.equal(r.delivery, "pr");
});

test("resolveRepoGitFields rejects wrong default_branch", async () => {
  const repo = tmpGit({ branch: "master", remote: "git@github.com:x/y.git" });
  await assert.rejects(
    () =>
      resolveRepoGitFields({
        path: repo,
        default_branch: "main",
        delivery: "pr",
        explicit: { default_branch: true, git_remote: false },
      }),
    (e: unknown) => {
      assert.ok(e instanceof RepoGitError);
      assert.match((e as Error).message, /default_branch 'main'.*detected 'master'/);
      return true;
    },
  );
});

test("resolveRepoGitFields rejects wrong git_remote", async () => {
  const repo = tmpGit({ branch: "main", remote: "git@github.com:real/repo.git" });
  await assert.rejects(
    () =>
      resolveRepoGitFields({
        path: repo,
        git_remote: "git@github.com:wrong/repo.git",
        delivery: "pr",
        explicit: { default_branch: false, git_remote: true },
      }),
    (e: unknown) => {
      assert.ok(e instanceof RepoGitError);
      assert.match((e as Error).message, /git_remote 'git@github.com:wrong\/repo.git'/);
      return true;
    },
  );
});

test("resolveRepoGitFields rejects delivery:pr with no origin", async () => {
  const repo = tmpGit({ branch: "main" }); // no remote
  await assert.rejects(
    () =>
      resolveRepoGitFields({
        path: repo,
        delivery: "pr",
        explicit: { default_branch: false, git_remote: false },
      }),
    (e: unknown) => {
      assert.ok(e instanceof RepoGitError);
      assert.match((e as Error).message, /delivery is 'pr'.*no origin remote/);
      return true;
    },
  );
});

test("resolveRepoGitFields allows delivery:commit with no remote", async () => {
  const repo = tmpGit({ branch: "develop" });
  const r = await resolveRepoGitFields({
    path: repo,
    delivery: "commit",
    explicit: { default_branch: false, git_remote: false },
  });
  assert.equal(r.default_branch, "develop");
  assert.equal(r.git_remote, null);
  assert.equal(r.delivery, "commit");
});

test("resolveRepoGitFields rejects path that exists but is not a git repo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-notgit-"));
  await assert.rejects(
    () =>
      resolveRepoGitFields({
        path: dir,
        delivery: "pr",
        explicit: { default_branch: false, git_remote: false },
      }),
    (e: unknown) => {
      assert.ok(e instanceof RepoGitError);
      assert.match((e as Error).message, /not a git repository/);
      return true;
    },
  );
});

test("resolveRepoGitFields skips verification when path does not exist", async () => {
  const missing = path.join(os.tmpdir(), "chronos-missing-" + Date.now());
  const r = await resolveRepoGitFields({
    path: missing,
    delivery: "pr",
    explicit: { default_branch: false, git_remote: false },
  });
  assert.equal(r.default_branch, "main");
  assert.equal(r.git_remote, null);
});

test("resolveRepoGitFields keeps matching explicit values", async () => {
  const remote = "git@github.com:org/repo.git";
  const repo = tmpGit({ branch: "main", remote });
  const r = await resolveRepoGitFields({
    path: repo,
    default_branch: "main",
    git_remote: remote,
    delivery: "pr",
    explicit: { default_branch: true, git_remote: true },
  });
  assert.equal(r.default_branch, "main");
  assert.equal(r.git_remote, remote);
});
