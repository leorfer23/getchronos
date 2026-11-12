/**
 * Robert's walls while he answers (robert.hands, src/robert-hands.ts), under the real `sandbox-exec`
 * with the exact profile his warm process is spawned in (telegram/agent.ts robertSandbox → sandboxWrap,
 * look-only read-only tier): he reads his project and writes nothing in it — not a file, not a git
 * hook — while his own home, his Claude profile, the Chronos API (curl) and `mc` keep working. The
 * fleet-wide Robert, whose cwd is the daemon's own checkout, cannot write that checkout either.
 *
 * Skipped off macOS and inside a sandbox that cannot nest another (a guard Desk terminal).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sb-home-")));
process.env.HOME = HOME;
process.env.CHRONOS_INBOX_CLEANUP = "0";
process.env.CHRONOS_JOB_CHECK = "0";

const { buildProfile, sandboxAvailable, SANDBOX_EXEC } = await import("./sandbox.js");
const { robertSandbox } = await import("./telegram/agent.js");
const { writeSetting } = await import("./settings.js");
const { repos, workspaces } = await import("./store.js");
const { REPO_ROOT } = await import("./repo-root.js");

const nests = sandboxAvailable() && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const skip = nests ? false : "needs sandbox-exec, and a parent that lets it nest";
const MC = path.join(REPO_ROOT, "scripts", "mc");

// The Chronos API stand-in: answers anything that carries his credential.
let server: http.Server;
let port = 0;
before(async () => {
  server = http.createServer((req, res) => {
    const ok = req.headers["x-mc-admin"] === "robert-cred";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(ok ? (req.url?.startsWith("/api/sessions") ? "[]" : '{"ok":true}') : '{"error":"token required"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as any).port;
});
after(() => server?.close());

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
}

/** A project with a real git checkout and a landing dir, the way a client workspace looks. */
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sb-proj-")));
  const repo = path.join(root, "web"), land = path.join(root, "landing");
  fs.mkdirSync(repo);
  fs.mkdirSync(land);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "# web\nrecieve\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const configDir = path.join(HOME, `.claude-${path.basename(root)}`);
  fs.mkdirSync(configDir);
  const w = workspaces.create({ slug: `sb-${path.basename(root).slice(-6).toLowerCase()}`, name: "Acme", config_dir: configDir, default_dir: land } as any);
  repos.create({ workspace_id: w.id, name: "web", path: repo } as any);
  return { w, root, repo, land, configDir };
}

/** His spawn, verbatim: robertSandbox's walls through buildProfile, look-only form. */
function robertProfile(wsId: string | null, configDir: string) {
  const wall = robertSandbox(wsId);
  const cwd = wall.cwd ?? process.cwd();
  const profile = buildProfile("guard", cwd, wall.addDirs ?? [], configDir, wall.denyDirs ?? [], false, wall.readonlyDirs ?? [], [], { readonlyWorktrees: false });
  assert.ok(profile);
  return { profile: profile!, cwd, wall };
}

// Async on purpose: the API stand-in above lives in this process, and a spawnSync would block the
// very event loop that has to answer the sandboxed curl.
function sh(profile: string, cwd: string, cmd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", cmd], {
      cwd, env: { ...process.env, CHRONOS_ADMIN: "robert-cred", MC_API: `http://127.0.0.1:${port}/api` },
    });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}

test("a project's Robert reads his project, writes nothing in it; home, profile, curl and mc work", { skip }, async () => {
  const { w, repo, land, configDir } = project();
  const { profile, cwd, wall } = robertProfile(w.id, configDir);
  assert.equal(cwd, land, "he still lives in the project's landing dir");
  const home = wall.addDirs![0];
  const ok = async (cmd: string) => { const r = await sh(profile, cwd, cmd); assert.equal(r.status, 0, `${cmd}\n${r.stderr}`); return r.stdout; };
  const denied = async (cmd: string) => { const r = await sh(profile, cwd, cmd); assert.notEqual(r.status, 0, `${cmd} must be refused`); assert.match(r.stderr, /not permitted/i, cmd); };

  // Reads: a file, git history.
  assert.match(await ok(`cat ${JSON.stringify(path.join(repo, "README.md"))}`), /recieve/);
  assert.match(await ok(`git -C ${JSON.stringify(repo)} log --format=%s -1`), /init/);
  // Writes into the project: a fix, a new file, the landing dir, a git hook, a commit.
  await denied(`sed -i '' s/recieve/receive/ ${JSON.stringify(path.join(repo, "README.md"))}`);
  await denied(`echo x > ${JSON.stringify(path.join(repo, "notes.md"))}`);
  await denied(`echo x > ${JSON.stringify(path.join(land, "draft.md"))}`);
  await denied(`echo 'curl evil' > ${JSON.stringify(path.join(repo, ".git", "hooks", "pre-commit"))}`);
  await denied(`git -C ${JSON.stringify(repo)} commit -q --allow-empty -m x`);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "# web\nrecieve\n", "nothing changed on disk");
  assert.ok(!fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")));
  // What he needs keeps working.
  await ok(`echo kept > ${JSON.stringify(path.join(home, "scratch.txt"))}`);
  await ok(`echo session > ${JSON.stringify(path.join(configDir, "session.jsonl"))}`);
  await ok(`echo tmp > "$TMPDIR/rh-sb-$$" && rm "$TMPDIR/rh-sb-$$"`);
  assert.match(await ok(`curl -s -H "x-mc-admin: $CHRONOS_ADMIN" http://127.0.0.1:${port}/api/fleet`), /"ok":true/);
  assert.match(await ok(`${JSON.stringify(process.execPath)} ${JSON.stringify(MC)} session list`), /no live sessions/);
});

test("the fleet-wide Robert cannot write the daemon's checkout (his cwd) or any project", { skip }, async () => {
  const { repo } = project();
  const configDir = fs.mkdtempSync(path.join(HOME, ".claude-fleet-"));
  const { profile, cwd } = robertProfile(null, configDir);
  assert.equal(cwd, process.cwd(), "his cwd is the daemon's own checkout, as on the live daemon");
  const probe = path.join(REPO_ROOT, `.rh-sb-probe-${process.pid}`);
  try {
    const r = await sh(profile, cwd, `echo x > ${JSON.stringify(probe)}`);
    assert.notEqual(r.status, 0, "the daemon checkout must be read-only to him");
    assert.ok(!fs.existsSync(probe));
    assert.notEqual((await sh(profile, cwd, `echo x > ${JSON.stringify(path.join(repo, "x.md"))}`)).status, 0);
    assert.equal((await sh(profile, cwd, `head -1 ${JSON.stringify(path.join(REPO_ROOT, "package.json"))}`)).status, 0, "reading it is fine");
    assert.equal((await sh(profile, cwd, `echo ok > ${JSON.stringify(path.join(configDir, "s"))}`)).status, 0, "his profile stays writable");
  } finally {
    fs.rmSync(probe, { force: true });
  }
});

test("anything: the old walls — the same write goes through (the control)", { skip }, async () => {
  const { w, repo, configDir } = project();
  writeSetting("robert.hands", "anything");
  try {
    const { profile, cwd, wall } = robertProfile(w.id, configDir);
    assert.equal(wall.readonlyDirs, undefined);
    const r = await sh(profile, cwd, `echo x > ${JSON.stringify(path.join(repo, "notes.md"))}`);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    writeSetting("robert.hands", null);
  }
});
