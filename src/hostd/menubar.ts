/**
 * `getchronos host menubar install|uninstall|status` — the host's menu bar item (HOSTS.md → Menu bar).
 *
 * The item is desktop/hostbar.swift, compiled ON the host with the Xcode command-line tools (which a
 * host already needs for git), into `<hostHome>/bin/chronos-hostbar`, and started by its own user
 * LaunchAgent `sh.chronos.hostbar`. Compiling locally instead of shipping a binary keeps the package
 * source-only (nothing to sign or notarize) and the item always matches the host's own status shape.
 *
 * Every command goes through an injected Runner, so tests sequence it without swiftc or launchctl.
 * A self-update calls `refreshMenubar` after the swap: rebuild from the new code and restart the item —
 * and it never fails the update (the host is what matters; the item is a convenience).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runner } from "./update.js";
import { HOSTBAR_LABEL } from "../../bin/host-core.mjs";

export { HOSTBAR_LABEL };
export const SWIFTC_FIX = "xcode-select --install";

export type MenubarDeps = {
  run: Runner;
  hostHome: string;
  /** The package whose desktop/hostbar.swift and launchd template are used. */
  pkgRoot: string;
  launchAgentsDir?: string;
  uid?: number;
  home?: string;
};

export function menubarPaths(d: Pick<MenubarDeps, "hostHome" | "pkgRoot" | "launchAgentsDir" | "home">) {
  const home = d.home ?? os.homedir();
  return {
    src: path.join(d.pkgRoot, "desktop", "hostbar.swift"),
    template: path.join(d.pkgRoot, "launchd", `${HOSTBAR_LABEL}.plist.template`),
    bin: path.join(d.hostHome, "bin", "chronos-hostbar"),
    plist: path.join(d.launchAgentsDir ?? path.join(home, "Library", "LaunchAgents"), `${HOSTBAR_LABEL}.plist`),
  };
}

const domain = (d: MenubarDeps) => `gui/${d.uid ?? process.getuid?.() ?? 501}`;
const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" · ").slice(0, 300) || "no output";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderHostbarPlist(template: string, v: { bin: string; hostHome: string; home: string }): string {
  const subs: Record<string, string> = { __BIN__: xml(v.bin), __HOST_HOME__: xml(v.hostHome), __HOME__: xml(v.home) };
  return template.replace(/__[A-Z_]+__/g, (t) => subs[t] ?? t);
}

/**
 * Are the command-line tools really there? `/usr/bin/swiftc` exists on every Mac as a shim that pops the
 * "install developer tools" dialog, so its presence proves nothing: `xcode-select -p` does (non-zero with
 * no tools), then `xcrun --find swiftc` confirms the compiler. The compile itself then goes through
 * `xcrun swiftc`, never the found path: run bare, the toolchain's swiftc has no SDKROOT and fails with
 * "unable to load standard library" (first try on an Xcode.app Mac).
 */
export async function hasSwiftc(run: Runner): Promise<boolean> {
  const sel = await run("/usr/bin/xcode-select", ["-p"], { timeoutMs: 10_000 });
  if (sel.code !== 0) return false;
  const f = await run("/usr/bin/xcrun", ["--find", "swiftc"], { timeoutMs: 30_000 });
  return f.code === 0 && !!f.stdout.trim();
}

/**
 * Compile to `<bin>.next`, then rename over `<bin>`: a running item keeps its old inode until it is
 * restarted, and a failed compile leaves the installed binary exactly as it was.
 */
export async function buildHostbar(d: MenubarDeps): Promise<{ ok: true; bin: string } | { ok: false; error: string; fix?: string }> {
  const p = menubarPaths(d);
  if (!fs.existsSync(p.src)) return { ok: false, error: `${p.src} is missing — this version of Chronos has no menu bar item` };
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

export async function installMenubar(d: MenubarDeps, log: (s: string) => void = () => {}): Promise<{ ok: boolean; error?: string; fix?: string }> {
  const p = menubarPaths(d);
  log(`  · compiling ${p.src}`);
  const b = await buildHostbar(d);
  if (!b.ok) return b;
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  const tmp = `${p.plist}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderHostbarPlist(fs.readFileSync(p.template, "utf8"), { bin: p.bin, hostHome: d.hostHome, home: d.home ?? os.homedir() }));
  fs.renameSync(tmp, p.plist);
  // A reinstall: take the old definition out first, or bootstrap refuses ("service already loaded").
  await d.run("/bin/launchctl", ["bootout", `${domain(d)}/${HOSTBAR_LABEL}`], { timeoutMs: 30_000 });
  const r = await d.run("/bin/launchctl", ["bootstrap", domain(d), p.plist], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, error: `launchctl bootstrap failed: ${lastLine(r.stderr || r.stdout)}`, fix: `launchctl bootstrap ${domain(d)} "${p.plist}"` };
  return { ok: true };
}

export async function uninstallMenubar(d: MenubarDeps): Promise<string[]> {
  const p = menubarPaths(d);
  const done: string[] = [];
  const r = await d.run("/bin/launchctl", ["bootout", `${domain(d)}/${HOSTBAR_LABEL}`], { timeoutMs: 30_000 });
  done.push(r.code === 0 ? `stopped ${HOSTBAR_LABEL}` : `${HOSTBAR_LABEL} was not running`);
  for (const f of [p.plist, p.bin]) if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); done.push(`removed ${f}`); }
  return done;
}

export type MenubarState = { installed: boolean; pid: number | null };

/** Installed = its plist is in LaunchAgents; running = launchd reports a pid for the label. */
export async function menubarState(d: MenubarDeps): Promise<MenubarState> {
  const p = menubarPaths(d);
  const installed = fs.existsSync(p.plist);
  if (!installed) return { installed, pid: null };
  const r = await d.run("/bin/launchctl", ["print", `${domain(d)}/${HOSTBAR_LABEL}`], { timeoutMs: 10_000 });
  const m = r.code === 0 ? /^\s*pid = (\d+)/m.exec(r.stdout) : null;
  return { installed, pid: m ? Number(m[1]) : null };
}

/**
 * After a self-update swapped the new code in: rebuild the item from it and restart it, IF the item is
 * installed. Never throws — the host's update must not fail over its menu bar — it returns what happened
 * for the log.
 */
export async function refreshMenubar(d: MenubarDeps): Promise<string> {
  try {
    if (!fs.existsSync(menubarPaths(d).plist)) return "not installed — skipped";
    const b = await buildHostbar(d);
    if (!b.ok) return `rebuild failed (${b.error}) — the old item keeps running`;
    const r = await d.run("/bin/launchctl", ["kickstart", "-k", `${domain(d)}/${HOSTBAR_LABEL}`], { timeoutMs: 30_000 });
    return r.code === 0 ? "rebuilt and restarted" : `rebuilt; restart failed (${lastLine(r.stderr || r.stdout)}) — it picks up the new build at next login`;
  } catch (e: any) {
    return `rebuild failed (${e?.message ?? e})`;
  }
}
