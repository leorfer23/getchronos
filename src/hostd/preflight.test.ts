/**
 * bin/host-core.mjs — the dependency-free preflight and install helpers. Each detector is driven by
 * the real failure it exists for (HOSTS.md → Troubleshooting): a node out of range, a `npm ci` that
 * died before tsx, a `~/.local/bin/git` with no git-remote-https, a Cellar node path that
 * `brew cleanup` deletes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkDeps, checkGit, checkNode, formatChecks, installKind, preflight, shellPath, stableNodePath, uninstall, whichOnPath, NODE_FIX, HOST_LABEL,
} from "../../bin/host-core.mjs";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-core-")));
const REPO = process.cwd();

function exe(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test("shellPath: $HOME, quoted — a pasted ~ inside quotes is not expanded", () => {
  assert.equal(shellPath("/Users/a/.chronos-host/app", "/Users/a"), '"$HOME/.chronos-host/app"');
  assert.equal(shellPath("/opt/x y", "/Users/a"), '"/opt/x y"');
  assert.equal(shellPath("/Users/ab/x", "/Users/a"), '"/Users/ab/x"', "a prefix is not a home");
});

test("node: 22–26 pass; older and newer fail with a one-line fix that survives .zprofile's brew shellenv", () => {
  for (const v of ["v22.3.0", "v24.8.0", "v26.10.0"]) assert.equal(checkNode(v, "/n").ok, true, v);
  for (const v of ["v20.11.1", "v27.0.0", "garbage"]) {
    const c = checkNode(v, "/n");
    assert.equal(c.ok, false, v);
    assert.equal(c.fix, NODE_FIX);
  }
  assert.match(NODE_FIX, /\$HOME\/\.zprofile/);
  assert.doesNotMatch(NODE_FIX, /~/);
});

test("deps: a tree npm ci never finished (no node_modules, or no tsx) says to run npm ci there", () => {
  const home = tmp();
  const app = path.join(home, ".chronos-host", "app");
  fs.mkdirSync(path.join(app, ".git"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  fs.writeFileSync(path.join(app, "package-lock.json"), "{}");
  const [c] = checkDeps(app, { home });
  assert.equal(c.ok, false);
  assert.match(c.detail, /missing .*tsx/);
  assert.equal(c.fix, 'cd "$HOME/.chronos-host/app" && npm ci');

  // Every runtime dep present except tsx — the exact state the node-26 compile failure left behind.
  for (const m of ["ws", "express", "zod", "node-pty", "better-sqlite3"]) {
    const d = path.join(app, "node_modules", m);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: m, main: "index.js" }));
    fs.writeFileSync(path.join(d, "index.js"), "");
  }
  const [c2] = checkDeps(app, { home, load: false });
  assert.equal(c2.ok, false);
  assert.equal(c2.detail, "missing tsx — npm did not finish");

  // A built tree (the npm package ships dist/) does not need tsx at all.
  fs.mkdirSync(path.join(app, "dist", "hostd"), { recursive: true });
  fs.writeFileSync(path.join(app, "dist", "hostd", "index.js"), "");
  assert.equal(checkDeps(app, { home, load: false })[0].ok, true);
});

test("deps: this checkout is whole — the natives load and spawn-helper is executable", () => {
  const checks = checkDeps(REPO);
  assert.deepEqual(checks.filter((c) => !c.ok), [], formatChecks(checks));
  assert.ok(checks.some((c) => c.id === "native:better-sqlite3"));
});

test("deps: an npm install (~/.chronos-host/app with no .git) is fixed with npm install, not npm ci", () => {
  const home = tmp();
  const app = path.join(home, ".chronos-host", "app");
  const pkg = path.join(app, "node_modules", "getchronos");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  const [c] = checkDeps(pkg, { appDir: app, home });
  assert.equal(c.fix, 'cd "$HOME/.chronos-host/app" && npm install');
});

test("git: a git whose exec-path has no git-remote-https (the ~/.local/bin shadow) fails with 'move it aside'", () => {
  const home = tmp();
  const bin = path.join(home, ".local", "bin");
  exe(path.join(bin, "git"), 'echo "//libexec/git-core"');
  const c = checkGit({ pathVar: `${bin}:/usr/bin`, home });
  assert.equal(c.ok, false);
  assert.match(c.detail, /exec-path \/\/libexec\/git-core with no git-remote-https/);
  assert.equal(c.fix, 'mv "$HOME/.local/bin/git" "$HOME/.local/bin/git.broken"');
});

test("git: a working git (exec-path with git-remote-https) passes; no git at all says xcode-select", () => {
  const home = tmp();
  const core = path.join(home, "libexec", "git-core");
  exe(path.join(core, "git-remote-https"), "exit 0");
  exe(path.join(home, "bin", "git"), `echo "${core}"`);
  assert.equal(checkGit({ pathVar: path.join(home, "bin"), home }).ok, true);
  const none = checkGit({ pathVar: path.join(home, "empty"), home });
  assert.equal(none.ok, false);
  assert.equal(none.fix, "xcode-select --install");
  // A git that cannot even run is the same kind of broken.
  exe(path.join(home, "b2", "git"), "exit 3");
  assert.equal(checkGit({ pathVar: path.join(home, "b2"), home }).ok, false);
});

test("git: the git on this machine's PATH is a working one (the test suite needs it anyway)", () => {
  const c = checkGit();
  assert.equal(c.ok, true, c.detail);
  assert.equal(whichOnPath("git"), c.detail);
});

test("preflight = node + deps + git, and formatChecks prints one 'fix:' line per failure", () => {
  const home = tmp();
  const checks = preflight({ pkgRoot: home, version: "v20.0.0", execPath: "/n", pathVar: path.join(home, "none"), home, load: false });
  assert.deepEqual(checks.map((c) => c.id), ["node", "deps", "git"]);
  const text = formatChecks(checks);
  assert.equal((text.match(/\n    fix: /g) ?? []).length, 3);
  assert.match(text, /^✗ node 22–26 — v20\.0\.0 \(\/n\)/);
});

test("installKind: the clone at <hostHome>/app is git, npm's copy there is npm, npx's cache is ephemeral, any other clone is dev", () => {
  const home = tmp();
  const hh = path.join(home, ".chronos-host");
  const app = path.join(hh, "app");
  fs.mkdirSync(path.join(app, ".git"), { recursive: true });
  assert.equal(installKind(app, hh), "git");
  const npmPkg = path.join(home, "h2", "app", "node_modules", "getchronos");
  fs.mkdirSync(npmPkg, { recursive: true });
  assert.equal(installKind(npmPkg, path.join(home, "h2")), "npm");
  const npx = path.join(home, ".npm", "_npx", "abc123", "node_modules", "getchronos");
  fs.mkdirSync(npx, { recursive: true });
  assert.equal(installKind(npx, hh), "ephemeral");
  const other = path.join(home, "src", "chronos");
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  assert.equal(installKind(other, hh), "dev", "someone's own checkout is never swapped by an update");
});

test("stableNodePath: a Cellar node becomes its formula's opt link — only when that link is this very binary", () => {
  const root = tmp();
  const cellar = path.join(root, "Cellar", "node", "24.8.0", "bin", "node");
  exe(cellar, "exit 0");
  const optDir = path.join(root, "opt");
  fs.mkdirSync(optDir, { recursive: true });
  fs.symlinkSync(path.join("..", "Cellar", "node", "24.8.0"), path.join(optDir, "node"));
  assert.equal(stableNodePath(cellar), path.join(root, "opt", "node", "bin", "node"));
  // The opt link points at another version (already upgraded): keep the exact binary.
  const other = path.join(root, "Cellar", "node", "26.1.0", "bin", "node");
  exe(other, "exit 0");
  assert.equal(stableNodePath(other), other);
  // Not Homebrew: untouched.
  assert.equal(stableNodePath("/Users/a/.fnm/node-versions/v24/installation/bin/node"), "/Users/a/.fnm/node-versions/v24/installation/bin/node");
});

test("uninstall: bootout + plist removed, ~/.chronos-host kept and named; --purge removes it, but never a dir that is not ours", () => {
  const home = tmp();
  const hh = path.join(home, ".chronos-host");
  const agents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(path.join(hh, "app"), { recursive: true });
  fs.writeFileSync(path.join(hh, ".secrets"), "CHRONOS_HOST_TOKEN=x\n", { mode: 0o600 });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${HOST_LABEL}.plist`), "<plist/>");
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; };

  const r = uninstall({ home, hostHome: hh, uid: 501, run, launchAgentsDir: agents });
  assert.deepEqual(calls, [["/bin/launchctl", "bootout", `gui/501/${HOST_LABEL}`]]);
  assert.equal(fs.existsSync(path.join(agents, `${HOST_LABEL}.plist`)), false);
  assert.equal(fs.existsSync(hh), true, "without --purge the credential stays");
  assert.ok(r.left.some((l) => l.startsWith(hh) && l.includes('rm -rf "$HOME/.chronos-host"')));
  assert.ok(r.left.some((l) => /Remove this computer/.test(l)), "says the brain still lists it");

  const r2 = uninstall({ home, hostHome: hh, purge: true, uid: 501, run: () => { throw new Error("not loaded"); }, launchAgentsDir: agents });
  assert.equal(fs.existsSync(hh), false);
  assert.ok(r2.done.some((d) => /was not running/.test(d)));

  // CHRONOS_HOST_HOME pointed at something that is not a host dir: refuse to delete it.
  const precious = path.join(home, "Documents");
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, "thesis.txt"), "x");
  const r3 = uninstall({ home, hostHome: precious, purge: true, uid: 501, run, launchAgentsDir: agents });
  assert.equal(fs.existsSync(path.join(precious, "thesis.txt")), true);
  assert.ok(r3.left.some((l) => /does not look like a Chronos host directory/.test(l)));
  const r4 = uninstall({ home, hostHome: home, purge: true, uid: 501, run, launchAgentsDir: agents });
  assert.equal(fs.existsSync(home), true, "never $HOME itself");
  assert.ok(r4.left.length > 0);
});

test("bin/getchronos.mjs: usage, --version, and preflight as a subprocess on this checkout", () => {
  const bin = path.join(REPO, "bin", "getchronos.mjs");
  const out = execFileSync(process.execPath, [bin, "host", "preflight", "--json"], { encoding: "utf8" });
  const checks = JSON.parse(out);
  assert.ok(checks.every((c: { ok: boolean }) => c.ok), out);
  assert.match(execFileSync(process.execPath, [bin], { encoding: "utf8" }), /getchronos host <command>/);
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version);
  // A command that needs deps, run from a tree with none: the preflight answers, not a stack trace.
  const bare = tmp();
  fs.mkdirSync(path.join(bare, "bin"));
  for (const f of ["getchronos.mjs", "host-core.mjs"]) fs.copyFileSync(path.join(REPO, "bin", f), path.join(bare, "bin", f));
  fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ version: "0.0.0" }));
  let err = "";
  try { execFileSync(process.execPath, [path.join(bare, "bin", "getchronos.mjs"), "host", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHRONOS_HOST_HOME: path.join(bare, "hh") } }); } catch (e: any) { err = String(e.stderr); }
  assert.match(err, /✗ dependencies installed — missing/);
  assert.match(err, /fix: cd .* && npm install/);
  assert.doesNotMatch(err, /ERR_MODULE_NOT_FOUND/);
});
