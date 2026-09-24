/**
 * A host updating itself (HOSTS.md → Phase 6 → Update), and the first install from `npx`.
 *
 * The rule is the one the first two hosts taught: **the old version keeps running until the new one
 * has proven it can start.** Updating in place — `git pull` then `npm ci` in the running app dir —
 * deletes `node_modules` under a live process, and when `npm ci` then fails (node 26 could not
 * compile better-sqlite3 11) the LaunchAgent restarts into a tree with no tsx and the host is gone
 * until someone walks over to that Mac. So every update is:
 *
 *   1. build a candidate in `<app>.next` — git: a local clone of the app checked out at the brain's
 *      commit (fetched from the app's own origin; the brain never names a URL); npm: `getchronos@<v>`
 *      installed into a fresh dir;
 *   2. install its dependencies with THIS node's npm (`process.execPath`), so the modules match the
 *      node the LaunchAgent runs (#50);
 *   3. run the candidate's own preflight under this node — deps whole, natives load, git works;
 *   4. only then swap: `<app>` → `<app>.prev`, `<app>.next` → `<app>` (two renames, same volume);
 *   5. rewrite the LaunchAgent plist for the next login, and `launchctl kickstart -k` our own label.
 *
 * Any failure before 4 deletes the candidate and reports the error; nothing the running host uses
 * was touched. Terminals on this host die with the restart and the brain revives them `--resume` on
 * this same host (remote-terminals.ts), the path every host restart already takes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { REPO_ROOT } from "../repo-root.js";
import { HOST_LABEL, PACKAGE_NAME, installKind, type InstallKind } from "../../bin/host-core.mjs";
import type { UpdateStatus, UpdateTarget } from "../hostlink/wire.js";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code !== 0 && !stderr ? String(err.message) : "") });
    });
  });

export type Install = { kind: InstallKind; pkgRoot: string; appDir: string };

/** How this running copy is installed, and the directory an update swaps. */
export function detectInstall(pkgRoot = REPO_ROOT, hostHome = defaultHostHome()): Install {
  const kind = installKind(pkgRoot, hostHome);
  return { kind, pkgRoot, appDir: kind === "npm" ? path.join(hostHome, "app") : pkgRoot };
}

export function defaultHostHome(): string {
  return process.env.CHRONOS_HOST_HOME || path.join(os.homedir(), ".chronos-host");
}

/** The package root inside an app dir of `kind` — where its bin/ and package.json are. */
export const pkgRootIn = (appDir: string, kind: "git" | "npm") => (kind === "npm" ? path.join(appDir, "node_modules", PACKAGE_NAME) : appDir);

/**
 * npm, run by THIS node. `npm` on PATH may belong to another node (the SSH-reinstall trap: a login
 * shell picked Homebrew's node 26 while the operator's terminal used fnm's 24). npm-cli.js is plain
 * JS, so `process.execPath npm-cli.js` is npm under exactly the node the host runs.
 */
export function npmCliFor(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string | null {
  const cands = [
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : "",
    path.join(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const onPath = (env.PATH ?? "").split(":").map((d) => path.join(d, "npm")).find((f) => fs.existsSync(f));
  if (onPath) { try { cands.push(fs.realpathSync(onPath)); } catch {} }
  return cands.find((c) => c && /npm-cli\.js$/.test(c) && fs.existsSync(c)) ?? null;
}

/** PATH with this node's dir first, so install scripts and node-gyp use it too. */
export const envWithNode = (execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => ({
  ...env,
  PATH: [path.dirname(execPath), ...(env.PATH ?? "").split(":").filter((d) => d && d !== path.dirname(execPath))].join(":"),
});

export type UpdateDeps = {
  run: Runner;
  report: (s: Omit<UpdateStatus, "t" | "id">) => void;
  install: Install;
  execPath?: string;
  /** npm-cli.js to run under execPath; found next to it by default (npmCliFor). */
  npmCli?: string | null;
  /** Restart the LaunchAgent into the new code. Kills this process when it works. */
  restart: () => Promise<void>;
  /** Rewrite the plist on disk for the next login (best-effort; the loaded job is what kickstart restarts). */
  rewritePlist?: (appDir: string) => void;
  /**
   * Anything else that runs from the app dir and must follow it, after the swap and before the restart
   * (the menu bar item: menubar.ts refreshMenubar). Best-effort: logged, never fails the update.
   */
  afterSwap?: (appDir: string) => Promise<void>;
  /** This process's own commit/version, to answer "already current". */
  current: { version: string; commit: string | null };
  /** `getchronos@<version>` unless CHRONOS_HOST_PACKAGE_SPEC says otherwise (a mirror, a tarball in tests). */
  packageSpec?: (version: string) => string;
};

const SHA = /^[0-9a-f]{7,40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

let busy = false;

/**
 * Update this host to `target`. Resolves once it has reported `restarting`, `current` or `failed`;
 * a successful `restart()` never lets it resolve (this process is replaced).
 */
export async function runUpdate(target: UpdateTarget, d: UpdateDeps): Promise<"restarting" | "current" | "failed"> {
  if (busy) { d.report({ state: "failed", error: "an update is already running on this host" }); return "failed"; }
  busy = true;
  try {
    return await update(target, d);
  } finally {
    busy = false;
  }
}

async function update(target: UpdateTarget, d: UpdateDeps): Promise<"restarting" | "current" | "failed"> {
  const { kind, appDir } = d.install;
  const fail = (error: string) => { d.report({ state: "failed", error }); return "failed" as const; };
  if (kind !== "git" && kind !== "npm") {
    return fail(kind === "dev"
      ? `this host runs from a developer checkout (${appDir}) — update it by hand`
      : "this host runs from a temporary copy (npx cache) — re-run the join command");
  }
  if (kind === "git") {
    if (!target.commit || !SHA.test(target.commit)) return fail("the brain has no commit to update to (it is not running from a git checkout)");
    if (d.current.commit && d.current.commit.startsWith(target.commit)) { d.report({ state: "current" }); return "current"; }
  } else {
    if (!VERSION.test(target.version)) return fail(`not a version: ${JSON.stringify(target.version)}`);
    if (d.current.version === target.version) { d.report({ state: "current" }); return "current"; }
  }
  const execPath = d.execPath ?? process.execPath;
  const npm = d.npmCli !== undefined ? d.npmCli : npmCliFor(execPath);
  if (!npm) return fail(`no npm next to ${execPath} — install npm for this node, or reinstall node`);
  const env = envWithNode(execPath);
  const next = `${appDir}.next`;
  const step = async (label: string, cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) => {
    d.report({ state: "running", step: label });
    const r = await d.run(cmd, args, { env, ...opts });
    if (r.code !== 0) throw new Error(`${label} failed: ${lastLines(r.stderr || r.stdout)}`);
    return r.stdout;
  };
  fs.rmSync(next, { recursive: true, force: true });
  try {
    if (kind === "git") {
      const sha = target.commit!;
      const origin = (await step("read origin", "git", ["-C", appDir, "remote", "get-url", "origin"])).trim();
      await step(`fetch ${origin}`, "git", ["-C", appDir, "fetch", "--quiet", "origin"], { timeoutMs: 300_000 });
      if ((await d.run("git", ["-C", appDir, "cat-file", "-e", `${sha}^{commit}`], { env })).code !== 0) {
        // Not on a branch tip we fetched (the brain may run a commit no branch points at any more).
        const r = await d.run("git", ["-C", appDir, "fetch", "--quiet", "origin", sha], { env, timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(`commit ${sha.slice(0, 12)} is not on ${origin} — push it from the brain, then update again`);
      }
      await step("stage a copy", "git", ["clone", "--quiet", "--no-checkout", appDir, next], { timeoutMs: 300_000 });
      await step(`check out ${sha.slice(0, 12)}`, "git", ["-C", next, "checkout", "--quiet", "--detach", sha]);
      await step("point the copy at origin", "git", ["-C", next, "remote", "set-url", "origin", origin]);
      await step("npm ci", execPath, [npm, "ci", "--no-audit", "--no-fund"], { cwd: next, timeoutMs: 900_000 });
    } else {
      const spec = (d.packageSpec ?? defaultPackageSpec)(target.version);
      fs.mkdirSync(next, { recursive: true });
      fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ name: "chronos-host-app", private: true }, null, 2) + "\n");
      await step(`npm install ${spec}`, execPath, [npm, "install", "--no-audit", "--no-fund", "--save-exact", spec], { cwd: next, timeoutMs: 900_000 });
    }
    const candidate = pkgRootIn(next, kind);
    const bin = path.join(candidate, "bin", "getchronos.mjs");
    if (!fs.existsSync(bin)) throw new Error("the target version predates self-update (no bin/getchronos.mjs) — update this host by hand");
    await step("preflight the new version", execPath, [bin, "host", "preflight"], { cwd: next, timeoutMs: 60_000 });
  } catch (e: any) {
    fs.rmSync(next, { recursive: true, force: true });
    return fail(`${String(e?.message ?? e)} — still running the old version`);
  }
  d.report({ state: "running", step: "swap" });
  const prev = `${appDir}.prev`;
  try {
    fs.rmSync(prev, { recursive: true, force: true });
    const had = fs.existsSync(appDir); // a first install (npx join) has nothing to move aside
    if (had) fs.renameSync(appDir, prev);
    try {
      fs.renameSync(next, appDir);
    } catch (e) {
      if (had) fs.renameSync(prev, appDir); // put the old one back before saying anything
      throw e;
    }
  } catch (e: any) {
    fs.rmSync(next, { recursive: true, force: true });
    return fail(`could not swap the new version in: ${e?.message ?? e} — still running the old version`);
  }
  try { d.rewritePlist?.(appDir); } catch (e: any) { console.warn(`[host] update: could not rewrite the LaunchAgent plist: ${e?.message ?? e}`); }
  if (d.afterSwap) {
    d.report({ state: "running", step: "after the swap" });
    try { await d.afterSwap(appDir); } catch (e: any) { console.warn(`[host] update: ${e?.message ?? e}`); }
  }
  d.report({ state: "restarting" });
  try {
    await d.restart();
  } catch (e: any) {
    // The new code is in place; this process is the old one, still serving. Say exactly what to run.
    return fail(`the new version is installed but the restart failed (${e?.message ?? e}) — run: launchctl kickstart -k gui/$(id -u)/${HOST_LABEL}`);
  }
  return "restarting";
}

function lastLines(s: string, n = 3): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.slice(-n).join(" · ") || "no output").slice(0, 400);
}

export const defaultPackageSpec = (version: string) => {
  const o = (process.env.CHRONOS_HOST_PACKAGE_SPEC ?? "").trim();
  return o || `${PACKAGE_NAME}@${version}`;
};

/** The label's job in our gui domain, if launchd is running it: its pid, else null. */
export async function launchdPid(run: Runner = defaultRunner, uid = process.getuid?.() ?? 501): Promise<number | null> {
  const r = await run("/bin/launchctl", ["print", `gui/${uid}/${HOST_LABEL}`], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

export async function kickstart(run: Runner = defaultRunner, uid = process.getuid?.() ?? 501): Promise<void> {
  const r = await run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${HOST_LABEL}`], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(lastLines(r.stderr || r.stdout));
}

/** `git rev-parse HEAD` of a checkout, or null (an npm install has no commit). */
export async function commitOf(dir: string, run: Runner = defaultRunner): Promise<string | null> {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;
  const r = await run("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * `npx getchronos host join …` runs from npm's cache, which npm prunes when it likes; a LaunchAgent
 * pointing there would one day find nothing to run. Install the same version into
 * `<hostHome>/app` (the swap above, as a first update) and return the installed entry, which the
 * caller re-runs `join` from. Same version, same node, stable path.
 */
export async function installForJoin(version: string, o: { hostHome: string; run?: Runner; execPath?: string; npmCli?: string | null; log?: (s: string) => void }): Promise<string> {
  const appDir = path.join(o.hostHome, "app");
  fs.mkdirSync(o.hostHome, { recursive: true, mode: 0o700 });
  const errors: string[] = [];
  const res = await runUpdate({ version, commit: null }, {
    run: o.run ?? defaultRunner,
    execPath: o.execPath,
    npmCli: o.npmCli,
    install: { kind: "npm", pkgRoot: pkgRootIn(appDir, "npm"), appDir },
    current: { version: "", commit: null },
    report: (s) => { if (s.step) o.log?.(`  · ${s.step}`); if (s.error) errors.push(s.error); },
    // Nothing to restart yet: `join` installs and loads the LaunchAgent itself.
    restart: async () => {},
  });
  if (res === "failed") throw new Error((errors[0] ?? "install failed").replace(/ — still running the old version$/, ""));
  return path.join(pkgRootIn(appDir, "npm"), "bin", "getchronos.mjs");
}
