import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile, childEnv, DEFAULT_LOCALE } from "./child-env.js";
import { db, workspaces, workspaceVars } from "./store.js";
import type { Workspace } from "./types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-childenv-"));
function secretsFile(body: string): string {
  const f = path.join(tmp, `s-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(f, body);
  return f;
}

const ws = (over: Partial<Workspace>): Workspace => ({ secrets_file: null, git_name: null, git_email: null, ...over } as Workspace);

test("parseEnvFile handles quotes, export prefix, and comments", () => {
  const f = secretsFile(
    ["# a comment", "", "export FOO=bar", 'DQ="double val"', "SQ='single val'", "PLAIN=baz", "not a match line"].join("\n")
  );
  assert.deepEqual(parseEnvFile(f), { FOO: "bar", DQ: "double val", SQ: "single val", PLAIN: "baz" });
});

test("childEnv drops ambient daemon secrets for legacy (null) workspace too", () => {
  process.env.CHRONOS_TEST_LEAK = "leak-me";
  const env = childEnv(null);
  assert.equal(env.CHRONOS_TEST_LEAK, undefined);
  assert.equal(env.PATH, process.env.PATH); // allowlisted vars still present
  delete process.env.CHRONOS_TEST_LEAK;
});

test("childEnv drops ambient daemon secrets for a scoped workspace", () => {
  process.env.CHRONOS_TEST_LEAK = "leak-me";
  const env = childEnv(ws({ secrets_file: null }));
  assert.equal(env.CHRONOS_TEST_LEAK, undefined);
  assert.equal(env.PATH, process.env.PATH); // allowlisted vars still present
  delete process.env.CHRONOS_TEST_LEAK;
});

test("childEnv does not pass the host ssh-agent socket to a scoped workspace", () => {
  process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
  const env = childEnv(ws({ secrets_file: null }));
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  delete process.env.SSH_AUTH_SOCK;
});

test("childEnv merges the workspace secrets_file", () => {
  const f = secretsFile("MY_TOKEN=abc123\n");
  const env = childEnv(ws({ secrets_file: f }));
  assert.equal(env.MY_TOKEN, "abc123");
});

test("childEnv maps git identity to author + committer vars", () => {
  const env = childEnv(ws({ git_name: "Jane Doe", git_email: "jane@example.com" }));
  assert.equal(env.GIT_AUTHOR_NAME, "Jane Doe");
  assert.equal(env.GIT_COMMITTER_NAME, "Jane Doe");
  assert.equal(env.GIT_AUTHOR_EMAIL, "jane@example.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, "jane@example.com");
});

// Under launchd there is no locale, and pbcopy then treats UTF-8 bytes as MacRoman — "│" copies
// as "‚îÇ". Every child gets a UTF-8 locale whether or not the daemon was started with one.
test("childEnv always hands a child a UTF-8 locale", () => {
  const lang = process.env.LANG, lcAll = process.env.LC_ALL;
  try {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    assert.equal(childEnv(null).LANG, DEFAULT_LOCALE, "no locale in the daemon → default one");
    assert.equal(childEnv(ws({ secrets_file: null })).LANG, DEFAULT_LOCALE);

    process.env.LANG = "es_AR.UTF-8";
    assert.equal(childEnv(null).LANG, "es_AR.UTF-8", "an explicit locale is passed through untouched");
  } finally {
    if (lang === undefined) delete process.env.LANG; else process.env.LANG = lang;
    if (lcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = lcAll;
  }
});

// Shared vars (migration 106): what the operator handed this workspace from the Desk lands in the
// env of the next child it spawns — that is the whole delivery mechanism, so it is worth a test.
test("childEnv merges the workspace's live shared vars, and only that workspace's", () => {
  db.exec("DELETE FROM workspace_vars; DELETE FROM workspaces;");
  const acme = workspaces.create({ slug: "cv-acme", name: "Acme", config_dir: "/tmp/cv-acme" });
  const other = workspaces.create({ slug: "cv-other", name: "Other", config_dir: "/tmp/cv-other" });
  workspaceVars.set(acme.id, "X_TOKEN", "s3cret", null);
  workspaceVars.set(acme.id, "STALE", "old", new Date(Date.now() - 1000).toISOString());
  workspaceVars.set(other.id, "THEIRS", "nope", null);

  const env = childEnv(acme);
  assert.equal(env.X_TOKEN, "s3cret");
  assert.equal(env.STALE, undefined, "an expired var must not reach a child");
  assert.equal(env.THEIRS, undefined, "another client's var must never cross over");
  assert.equal(childEnv(other).X_TOKEN, undefined);
});

test("a shared var wins over the same name in the workspace secrets_file", () => {
  db.exec("DELETE FROM workspace_vars; DELETE FROM workspaces;");
  const w = workspaces.create({
    slug: "cv-win", name: "Win", config_dir: "/tmp/cv-win",
    secrets_file: secretsFile("X_TOKEN=from-file"),
  });
  assert.equal(childEnv(w).X_TOKEN, "from-file");
  workspaceVars.set(w.id, "X_TOKEN", "from-desk", null);
  // The dated, deliberate thing beats the static file — otherwise "I just added you one" is a lie.
  assert.equal(childEnv(w).X_TOKEN, "from-desk");
});
