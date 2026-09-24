/**
 * The part of `chronos host` that must work on a BROKEN install (HOSTS.md → Troubleshooting).
 *
 * Plain JavaScript with no dependencies, on purpose: every check here exists because a real host
 * could not start, and most of those failures happen before `node_modules` is whole — a `npm ci`
 * that died mid-way leaves no tsx, so anything written in TypeScript or importing a package never
 * gets to say what is wrong. This file only uses node's own modules, so it can always run and
 * always print one line the operator can paste.
 *
 * Every fix is written with `$HOME`, never `~`: a pasted `~` inside quotes is not expanded, and a
 * copied command that lost its `~` created `./.chronos-host` in whatever directory the operator was in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export const HOST_LABEL = "sh.chronos.host";
/** The menu bar item's LaunchAgent (src/hostd/menubar.ts). Uninstall removes it with the host. */
export const HOSTBAR_LABEL = "sh.chronos.hostbar";
export const PACKAGE_NAME = "getchronos";

/**
 * Node majors a host is supported on — what the test suite has run on. The native modules are N-API
 * (better-sqlite3 ≥ 13, node-pty ≥ 1) so a node upgrade inside the range no longer needs a rebuild;
 * outside it nothing has been tried.
 */
export const SUPPORTED_NODE = { min: 22, max: 26 };

/** The fix for a node outside the range. .zprofile last, because Homebrew's shellenv line re-prepends /opt/homebrew/bin. */
export const NODE_FIX = `brew install node@24 && echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> "$HOME/.zprofile" && exec zsh -l`;

export const nodeMajor = (v) => Number(/^v?(\d+)/.exec(String(v ?? ""))?.[1] ?? 0);

/** `/Users/a/.chronos-host/app` → `"$HOME/.chronos-host/app"` — always quoted, always $HOME. */
export function shellPath(p, home = os.homedir()) {
  const rel = home && (p === home || p.startsWith(home + "/")) ? "$HOME" + p.slice(home.length) : p;
  return `"${rel.replace(/(["\\`])/g, "\\$1")}"`;
}

/**
 * @typedef {{ id: string; ok: boolean; level: "error" | "warn"; label: string; detail: string; fix?: string }} Check
 */

/** @returns {Check} */
export function checkNode(version = process.version, execPath = process.execPath) {
  const m = nodeMajor(version);
  const ok = m >= SUPPORTED_NODE.min && m <= SUPPORTED_NODE.max;
  return {
    id: "node",
    ok,
    level: "error",
    label: `node ${SUPPORTED_NODE.min}–${SUPPORTED_NODE.max}`,
    detail: `${version} (${execPath})`,
    fix: ok ? undefined : NODE_FIX,
  };
}

/**
 * Is `node_modules` whole? `npm ci` that stopped mid-way (the node-26 compile failure) left a tree
 * without tsx and the host crashed with ERR_MODULE_NOT_FOUND tsx/dist/loader.mjs at every launchd
 * restart. The check resolves what the host actually loads, and loads the two native modules —
 * a missing or unloadable binary is the same "run npm ci again" fix.
 *
 * `pkgRoot` is the package itself (the checkout, or node_modules/getchronos); `appDir` is where npm
 * ran (the same dir for a checkout, `~/.chronos-host/app` for an npm install) and so where the fix runs.
 * @returns {Check[]}
 */
export function checkDeps(pkgRoot, { appDir = pkgRoot, home = os.homedir(), load = true } = {}) {
  const out = [];
  const fix = `cd ${shellPath(appDir, home)} && npm ${fs.existsSync(path.join(appDir, "package-lock.json")) && fs.existsSync(path.join(appDir, ".git")) ? "ci" : "install"}`;
  const req = createRequire(path.join(pkgRoot, "package.json"));
  const hasDist = fs.existsSync(path.join(pkgRoot, "dist", "hostd", "index.js"));
  const need = ["ws", "express", "zod", "node-pty", "better-sqlite3", ...(hasDist ? [] : ["tsx"])];
  const missing = need.filter((m) => { try { req.resolve(m === "tsx" ? "tsx/esm/api" : m); return false; } catch { return true; } });
  out.push({
    id: "deps",
    ok: missing.length === 0,
    level: "error",
    label: "dependencies installed",
    detail: missing.length ? `missing ${missing.join(", ")} — npm did not finish` : hasDist ? "complete (built)" : "complete (runs src through tsx)",
    fix: missing.length ? fix : undefined,
  });
  if (missing.length || !load) return out;
  for (const m of ["better-sqlite3", "node-pty"]) {
    try {
      const mod = req(m);
      if (m === "better-sqlite3") new mod(":memory:").close();
      out.push({ id: `native:${m}`, ok: true, level: "error", label: `${m} loads`, detail: "ok" });
    } catch (e) {
      out.push({ id: `native:${m}`, ok: false, level: "error", label: `${m} loads`, detail: String(e?.message ?? e).split("\n")[0].slice(0, 160), fix });
    }
  }
  // node-pty ships spawn-helper without its exec bit; our postinstall fixes it, but a copy installed
  // as a dependency (npm/npx) had the fixer looking in the wrong node_modules. posix_spawnp fails.
  try {
    const dir = path.join(path.dirname(req.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`);
    const helper = path.join(dir, "spawn-helper");
    if (fs.existsSync(helper)) {
      const x = (fs.statSync(helper).mode & 0o111) !== 0;
      out.push({ id: "spawn-helper", ok: x, level: "error", label: "node-pty spawn-helper executable", detail: x ? "ok" : "mode " + (fs.statSync(helper).mode & 0o777).toString(8), fix: x ? undefined : `chmod +x ${shellPath(helper, home)}` });
    }
  } catch {}
  return out;
}

/** First executable `name` on PATH — what a shell (and so every agent) would run. */
export function whichOnPath(name, pathVar = process.env.PATH ?? "") {
  for (const d of pathVar.split(":")) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/**
 * Is the git on PATH a working one? A broken `~/.local/bin/git` (built with exec-path
 * `//libexec/git-core`, so no `git-remote-https`) shadowed the real git on a host: `git pull` said
 * "remote-https is not a git command", and every agent's git over HTTPS would have failed the same way.
 * @returns {Check}
 */
export function checkGit({ pathVar = process.env.PATH ?? "", home = os.homedir(), run = defaultRun } = {}) {
  const git = whichOnPath("git", pathVar);
  const base = { id: "git", level: "error", label: "git works over https" };
  if (!git) return { ...base, ok: false, detail: "no git on PATH", fix: "xcode-select --install" };
  let execDir = "";
  try {
    execDir = run(git, ["--exec-path"]).trim();
  } catch (e) {
    return { ...base, ok: false, detail: `${git} does not run (${String(e?.message ?? e).split("\n")[0]})`, fix: brokenGitFix(git, home) };
  }
  const helper = path.join(execDir, "git-remote-https");
  if (!execDir || !fs.existsSync(execDir) || !fs.existsSync(helper)) {
    return { ...base, ok: false, detail: `${git} has exec-path ${execDir || "(none)"} with no git-remote-https`, fix: brokenGitFix(git, home) };
  }
  return { ...base, ok: true, detail: git };
}

function brokenGitFix(git, home) {
  // A git the operator put in their own bin dirs is the shadowing kind: move it aside and the
  // system/Homebrew git behind it takes over. Anything else: reinstall the command-line tools.
  if (git.startsWith(home + "/")) return `mv ${shellPath(git, home)} ${shellPath(git + ".broken", home)}`;
  if (git.startsWith("/opt/homebrew/") || git.startsWith("/usr/local/")) return "brew reinstall git";
  return "xcode-select --install";
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Everything that must hold before `join` or `run` is worth attempting.
 * @returns {Check[]}
 */
export function preflight({ pkgRoot, appDir = pkgRoot, version = process.version, execPath = process.execPath, pathVar = process.env.PATH ?? "", home = os.homedir(), run = defaultRun, load = true } = {}) {
  return [checkNode(version, execPath), ...checkDeps(pkgRoot, { appDir, home, load }), checkGit({ pathVar, home, run })];
}

export function formatChecks(checks, { onlyFailures = false } = {}) {
  return checks
    .filter((c) => !onlyFailures || !c.ok)
    .map((c) => `${c.ok ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.label} — ${c.detail}${!c.ok && c.fix ? `\n    fix: ${c.fix}` : ""}`)
    .join("\n");
}

// ───────────────────────────── where the host is installed ─────────────────────────────

/**
 * How this copy of Chronos got here, which decides where the LaunchAgent points and how it updates:
 *
 *  - `git`: the clone at `<hostHome>/app` (the join command's `git clone`). Updates by commit.
 *  - `npm`: `<hostHome>/app/node_modules/getchronos` (what `npx getchronos host join` installs).
 *    Updates by version.
 *  - `ephemeral`: anywhere else that is not a git checkout — above all the npx cache, which npm may
 *    prune whenever it likes. A LaunchAgent must never point there, so `join` first installs a copy
 *    into `<hostHome>/app` and hands over to it.
 *  - `dev`: some other git checkout (a developer running the host from their own clone). It runs,
 *    but is never updated by the brain: swapping a directory someone works in is not ours to do.
 */
export function installKind(pkgRoot, hostHome) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const root = real(pkgRoot);
  const app = real(path.join(hostHome, "app"));
  if (fs.existsSync(path.join(root, ".git"))) return root === app ? "git" : "dev";
  if (root === path.join(app, "node_modules", PACKAGE_NAME)) return "npm";
  return "ephemeral";
}

/**
 * The node the LaunchAgent should run: this one (#50 — the node that installed the modules), but by
 * a path that survives `brew upgrade`. `process.execPath` is Homebrew's Cellar path
 * (`/opt/homebrew/Cellar/node/24.8.0/bin/node`), which `brew cleanup` deletes on the next upgrade —
 * and launchd then cannot exec the agent at all, with nothing in any log. The formula's `opt` link
 * points at the same binary today and follows upgrades; it is used only when it resolves to exactly
 * this binary now.
 */
export function stableNodePath(execPath = process.execPath) {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  const opt = `${m[1]}/opt/${m[2]}/bin/node`;
  try {
    if (fs.realpathSync(opt) === fs.realpathSync(execPath)) return opt;
  } catch {}
  return execPath;
}

// ───────────────────────────── uninstall ─────────────────────────────

/**
 * Stop and remove the LaunchAgent; with `purge`, also `<hostHome>` (credential, logs, the app).
 * Returns what it did and what it deliberately left, so the operator knows where the rest is.
 */
export function uninstall({ home = os.homedir(), hostHome = path.join(home, ".chronos-host"), purge = false, uid = process.getuid?.() ?? 501, run = defaultRun, launchAgentsDir = path.join(home, "Library", "LaunchAgents") } = {}) {
  const done = [], left = [];
  try {
    run("/bin/launchctl", ["bootout", `gui/${uid}/${HOST_LABEL}`]);
    done.push(`stopped the ${HOST_LABEL} LaunchAgent (its terminals ended with it)`);
  } catch {
    done.push(`${HOST_LABEL} was not running`);
  }
  const plist = path.join(launchAgentsDir, `${HOST_LABEL}.plist`);
  if (fs.existsSync(plist)) { fs.rmSync(plist, { force: true }); done.push(`removed ${plist}`); }
  // The menu bar item would otherwise sit there saying "not running" forever.
  const barPlist = path.join(launchAgentsDir, `${HOSTBAR_LABEL}.plist`);
  if (fs.existsSync(barPlist)) {
    try { run("/bin/launchctl", ["bootout", `gui/${uid}/${HOSTBAR_LABEL}`]); } catch {}
    fs.rmSync(barPlist, { force: true });
    fs.rmSync(path.join(hostHome, "bin", "chronos-hostbar"), { force: true });
    done.push(`removed the menu bar item (${barPlist})`);
  }
  if (purge) {
    const looksOurs = path.resolve(hostHome) !== path.resolve(home) && path.resolve(hostHome) !== "/" &&
      ["app", ".secrets", "host.out.log"].some((f) => fs.existsSync(path.join(hostHome, f)));
    if (!fs.existsSync(hostHome)) done.push(`${hostHome} was already gone`);
    else if (!looksOurs) left.push(`${hostHome} — not removed: it does not look like a Chronos host directory`);
    else { fs.rmSync(hostHome, { recursive: true, force: true }); done.push(`removed ${hostHome} (credential, logs, app)`); }
  } else if (fs.existsSync(hostHome)) {
    left.push(`${hostHome} — the credential (.secrets), logs and app. Remove with: rm -rf ${shellPath(hostHome, home)}`);
  }
  if (fs.existsSync(path.join(home, ".mc"))) left.push(`${path.join(home, ".mc")} — the mc CLI and drops agents used; harmless without a host`);
  left.push("hooks/skill copies inside each agent profile (~/.claude*) — inert without the host");
  left.push("this computer on the brain: Desk → Computers → Remove this computer revokes its token");
  return { done, left };
}
