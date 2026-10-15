#!/usr/bin/env node
// The BRAIN's menu bar item (HOSTS.md → Menu bar): install | uninstall | status | refresh [--dry-run].
//
// The same desktop/hostbar.swift a host compiles, run with `--brain`: it polls the daemon's
// GET /api/hosts/bar and shows the whole fleet. Compiled HERE with the Xcode command-line tools into
// ~/.mc/bin/chronos-hostbar (beside the Desk's mc-app), started by its own LaunchAgent
// sh.chronos.brainbar — never by install-launchd.mjs, so a brain that did not ask for it never gets it.
//
// A bare binary, not a .app: the item needs no Dock icon (it sets the .accessory activation policy
// itself) and no Info.plist, and a host's item already proved the bare binary works as a LaunchAgent.
//
// Plain .mjs on purpose: it runs on a brain before `npm run build`, and from `npm run deploy` after it,
// with nothing but node. Every command goes through an injected runner so tests sequence it without
// swiftc or launchctl (src/brainbar-install.test.ts). Mirrors src/hostd/menubar.ts for the host side.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BRAINBAR_LABEL = "sh.chronos.brainbar";
export const SWIFTC_FIX = "xcode-select --install";
const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{ code: number, stdout: string, stderr: string }} RunResult */
/** @typedef {(cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>} Runner */

/** @type {Runner} */
export const defaultRunner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code !== 0 ? String(err.message) : "") });
    });
  });

/**
 * Everything the install touches, from one place. `home`/`launchAgentsDir`/`uid` are injectable so tests
 * never go near the real ~/Library/LaunchAgents.
 */
export function brainbarDeps(o = {}) {
  const home = o.home ?? os.homedir();
  return {
    run: o.run ?? defaultRunner,
    home,
    repoDir: o.repoDir ?? REPO_DIR,
    mcHome: o.mcHome ?? path.join(home, ".mc"),
    logDir: o.logDir ?? process.env.CHRONOS_LOG_DIR ?? path.join(home, "chronos"),
    port: String(o.port ?? process.env.CHRONOS_PORT ?? "7777"),
    launchAgentsDir: o.launchAgentsDir ?? path.join(home, "Library", "LaunchAgents"),
    uid: o.uid ?? process.getuid?.() ?? 501,
  };
}

export function brainbarPaths(d) {
  return {
    src: path.join(d.repoDir, "desktop", "hostbar.swift"),
    template: path.join(d.repoDir, "launchd", `${BRAINBAR_LABEL}.plist.template`),
    bin: path.join(d.mcHome, "bin", "chronos-hostbar"),
    plist: path.join(d.launchAgentsDir, `${BRAINBAR_LABEL}.plist`),
  };
}

const domain = (d) => `gui/${d.uid}`;
const lastLine = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" · ").slice(0, 300) || "no output";
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderBrainbarPlist(template, d) {
  const p = brainbarPaths(d);
  const subs = { __BIN__: p.bin, __HOME__: d.home, __MC_HOME__: d.mcHome, __REPO_DIR__: d.repoDir, __LOG_DIR__: d.logDir, __PORT__: d.port };
  const out = template.replace(/__[A-Z_]+__/g, (t) => (t in subs ? xml(subs[t]) : t));
  const missing = [...new Set(out.match(/__[A-Z_]+__/g) ?? [])];
  if (missing.length) throw new Error(`${BRAINBAR_LABEL}: unresolved placeholder(s) ${missing.join(", ")}`);
  return out;
}

/**
 * Are the command-line tools really there? `/usr/bin/swiftc` is a shim on every Mac that pops the
 * "install developer tools" dialog; `xcode-select -p` proves the tools, `xcrun --find` the compiler.
 * Compiled through `xcrun swiftc` — run bare, the toolchain's swiftc has no SDKROOT (menubar.ts).
 */
export async function hasSwiftc(run) {
  const sel = await run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 10_000 });
  if (sel.code !== 0) return false;
  const f = await run("/usr/bin/xcrun", ["--find", "swiftc"], { timeoutMs: 30_000 });
  return f.code === 0 && !!f.stdout.trim();
}

/** Compile to `<bin>.next`, then rename: a failed compile leaves the installed binary as it was. */
export async function buildBrainbar(d) {
  const p = brainbarPaths(d);
  if (!fs.existsSync(p.src)) return { ok: false, error: `${p.src} is missing` };
  if (!(await hasSwiftc(d.run))) return { ok: false, error: "swiftc not found — the Xcode command-line tools are not installed", fix: SWIFTC_FIX };
  fs.mkdirSync(path.dirname(p.bin), { recursive: true, mode: 0o700 });
  const next = `${p.bin}.next`;
  const r = await d.run("/usr/bin/xcrun", ["swiftc", "-O", p.src, "-o", next], { timeoutMs: 600_000 });
  if (r.code !== 0 || !fs.existsSync(next)) {
    fs.rmSync(next, { force: true });
    return { ok: false, error: `swiftc failed: ${lastLine(r.stderr || r.stdout)}`, fix: /xcrun|developer|license/i.test(r.stderr) ? SWIFTC_FIX : undefined };
  }
  fs.renameSync(next, p.bin);
  return { ok: true, bin: p.bin };
}

/** What install would do, as lines — `--dry-run` prints this and writes nothing. */
export function installPlan(d) {
  const p = brainbarPaths(d);
  return [
    `/usr/bin/xcrun swiftc -O ${p.src} -o ${p.bin}.next && mv ${p.bin}.next ${p.bin}`,
    `write ${p.plist} (from ${p.template})`,
    `/usr/bin/plutil -lint ${p.plist}`,
    `/bin/launchctl bootout ${domain(d)}/${BRAINBAR_LABEL}   (a reinstall; not loaded is fine)`,
    `/bin/launchctl bootstrap ${domain(d)} ${p.plist}`,
  ];
}

export async function installBrainbar(d, log = () => {}) {
  const p = brainbarPaths(d);
  log(`· compiling ${p.src}`);
  const b = await buildBrainbar(d);
  if (!b.ok) return b;
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  const tmp = `${p.plist}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderBrainbarPlist(fs.readFileSync(p.template, "utf8"), d));
  fs.renameSync(tmp, p.plist);
  const lint = await d.run("/usr/bin/plutil", ["-lint", p.plist], { timeoutMs: 10_000 });
  if (lint.code !== 0) return { ok: false, error: `plutil: ${lastLine(lint.stderr || lint.stdout)}` };
  // bootout first: bootstrap refuses a label that is already loaded ("service already loaded").
  await d.run("/bin/launchctl", ["bootout", `${domain(d)}/${BRAINBAR_LABEL}`], { timeoutMs: 30_000 });
  const r = await d.run("/bin/launchctl", ["bootstrap", domain(d), p.plist], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, error: `launchctl bootstrap failed: ${lastLine(r.stderr || r.stdout)}`, fix: `launchctl bootstrap ${domain(d)} "${p.plist}"` };
  return { ok: true };
}

export async function uninstallBrainbar(d) {
  const p = brainbarPaths(d);
  const done = [];
  const r = await d.run("/bin/launchctl", ["bootout", `${domain(d)}/${BRAINBAR_LABEL}`], { timeoutMs: 30_000 });
  done.push(r.code === 0 ? `stopped ${BRAINBAR_LABEL}` : `${BRAINBAR_LABEL} was not running`);
  for (const f of [p.plist, p.bin]) if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); done.push(`removed ${f}`); }
  return done;
}

/** Installed = its plist is in LaunchAgents; running = launchd reports a pid for the label. */
export async function brainbarState(d) {
  const p = brainbarPaths(d);
  const installed = fs.existsSync(p.plist);
  if (!installed) return { installed, pid: null };
  const r = await d.run("/bin/launchctl", ["print", `${domain(d)}/${BRAINBAR_LABEL}`], { timeoutMs: 10_000 });
  const m = r.code === 0 ? /^\s*pid = (\d+)/m.exec(r.stdout) : null;
  return { installed, pid: m ? Number(m[1]) : null };
}

/**
 * After `npm run deploy`: rebuild + restart the item IF it is installed AND hostbar.swift changed since
 * the last build (mtime) — a deploy that did not touch the Swift costs one stat. Never throws and never
 * fails the deploy: the daemon is what matters, the item is a convenience.
 */
export async function refreshBrainbar(d) {
  try {
    const p = brainbarPaths(d);
    if (!fs.existsSync(p.plist)) return "not installed — skipped";
    const built = fs.existsSync(p.bin) ? fs.statSync(p.bin).mtimeMs : 0;
    if (built && fs.statSync(p.src).mtimeMs <= built) return "up to date — skipped";
    const b = await buildBrainbar(d);
    if (!b.ok) return `rebuild failed (${b.error}) — the old item keeps running`;
    const r = await d.run("/bin/launchctl", ["kickstart", "-k", `${domain(d)}/${BRAINBAR_LABEL}`], { timeoutMs: 30_000 });
    return r.code === 0 ? "rebuilt and restarted" : `rebuilt; restart failed (${lastLine(r.stderr || r.stdout)}) — it picks up the new build at next login`;
  } catch (e) {
    return `rebuild failed (${e?.message ?? e})`;
  }
}

async function main(argv) {
  const cmd = argv[0] ?? "status";
  const dry = argv.includes("--dry-run");
  const d = brainbarDeps();
  if (cmd === "install") {
    if (dry) {
      console.log("[brainbar] --dry-run: would run");
      for (const l of installPlan(d)) console.log(`  ${l}`);
      console.log(`\n${renderBrainbarPlist(fs.readFileSync(brainbarPaths(d).template, "utf8"), d)}`);
      return 0;
    }
    const r = await installBrainbar(d, (s) => console.log(`[brainbar] ${s}`));
    if (!r.ok) {
      console.error(`[brainbar] ${r.error}${r.fix ? `\n[brainbar] fix: ${r.fix}` : ""}`);
      return 1;
    }
    console.log(`[brainbar] installed ${BRAINBAR_LABEL} → ${brainbarPaths(d).plist}`);
    return 0;
  }
  if (cmd === "uninstall") {
    if (dry) { console.log(`[brainbar] --dry-run: would run /bin/launchctl bootout ${domain(d)}/${BRAINBAR_LABEL} and remove ${brainbarPaths(d).plist}, ${brainbarPaths(d).bin}`); return 0; }
    for (const l of await uninstallBrainbar(d)) console.log(`[brainbar] ${l}`);
    return 0;
  }
  if (cmd === "refresh") {
    if (dry) { console.log("[brainbar] --dry-run: refresh rebuilds + kickstarts only when installed and hostbar.swift is newer than the binary"); return 0; }
    console.log(`[brainbar] ${await refreshBrainbar(d)}`);
    return 0;
  }
  if (cmd === "status") {
    const s = await brainbarState(d);
    console.log(`[brainbar] ${!s.installed ? "not installed (scripts/build-brainbar.sh)" : s.pid ? `running (pid ${s.pid})` : "installed, not running (quit — back at next login, or reinstall)"}`);
    return 0;
  }
  console.error("usage: node scripts/brainbar.mjs install|uninstall|status|refresh [--dry-run]");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
