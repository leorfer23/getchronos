/**
 * What this Mac can do for a brain: the CLIs it has, the profiles it is logged into, the repos it
 * has checked out, and what it refuses to run. Sent in `hello`, re-read by the `inventory` rpc, and
 * printed by `chronos host doctor`.
 *
 * Every probe is best-effort with a short timeout. A host that cannot answer "which claude?" still
 * connects; the Desk shows the gap in red instead of the host never appearing at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { CONFIG } from "../config.js";
import { detectOriginUrl } from "../repo-git.js";
import { machineLoad, readVitals, swapPctOf } from "../machine.js";
import { REPO_ROOT } from "../repo-root.js";
import { PROTOCOL_VERSION, type CheckoutInfo, type CliInfo, type Hello, type HostVitals, type ProfileInfo } from "../hostlink/wire.js";

/** The CLIs a host may be asked to run, plus the two every ship pipeline needs. */
export const CLI_NAMES = ["claude", "cursor-agent", "grok", "opencode", "gh", "git"] as const;

const home = os.homedir();
const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

/** Comma- or colon-separated, `~` expanded. `CHRONOS_HOST_ROOTS=~/Documents/GitHub,~/work`. */
export function hostRoots(spec = process.env.CHRONOS_HOST_ROOTS ?? "~/Documents/GitHub"): string[] {
  return spec.split(/[,:]/).map((s) => s.trim()).filter(Boolean).map(expand);
}

/** The local veto: workspace slugs (or ids) this host refuses, whatever the brain says. */
export function hostDeny(spec = process.env.CHRONOS_HOST_DENY ?? ""): string[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * First executable named `name` on PATH, plus the places the CLIs install themselves that a launchd
 * PATH tends to miss (`~/.grok/bin`, `~/.local/bin`, Homebrew).
 */
export function which(name: string, pathVar = process.env.PATH ?? ""): string | null {
  const dirs = [...pathVar.split(":"), path.join(home, ".local", "bin"), path.join(home, ".grok", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

function firstLine(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs }, (err, out, errOut) => {
      if (err && !out) return resolve(null);
      const line = (out || errOut || "").split("\n").map((s) => s.trim()).find(Boolean);
      resolve(line ? line.slice(0, 120) : null);
    });
  });
}

export async function probeClis(names: readonly string[] = CLI_NAMES): Promise<CliInfo[]> {
  return Promise.all(
    names.map(async (name) => {
      const p = which(name);
      return { name, path: p, version: p ? await firstLine(p, ["--version"]) : null };
    }),
  );
}

/**
 * Profiles by NAME, from the same `~/.claude-*` discovery the daemon uses (`CONFIG.profiles`), run
 * against this Mac's home. The brain sends a profile name in a spawn; the host maps it to its own dir.
 * `exists` is only "the directory is there" — whether it is logged in lives in the keychain and is
 * checked when a CLI first runs (Phase 3), not guessed here.
 */
export function profiles(): ProfileInfo[] {
  return Object.entries(CONFIG.profiles).map(([name, dir]) => ({ name, dir, exists: fs.existsSync(dir) }));
}

/** Direct children of each root that are git checkouts (plus a root that is one itself), with origin. */
export async function scanCheckouts(roots = hostRoots()): Promise<CheckoutInfo[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const consider = (p: string) => {
    let real: string;
    try {
      real = fs.realpathSync(p);
      if (!fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, ".git"))) return;
    } catch {
      return;
    }
    if (!seen.has(real)) { seen.add(real); found.push(real); }
  };
  for (const root of roots) {
    consider(root);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (!e.name.startsWith(".")) consider(path.join(root, e.name));
  }
  return Promise.all(found.map(async (p) => ({ path: p, remote_url: await detectOriginUrl(p) })));
}

export function chronosVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export async function buildHello(hostId: string, name = os.hostname().replace(/\.local$/, "")): Promise<Hello> {
  const [clis, checkouts] = await Promise.all([probeClis(), scanCheckouts()]);
  return {
    t: "hello",
    proto: PROTOCOL_VERSION,
    version: chronosVersion(),
    host_id: hostId,
    name,
    platform: process.platform,
    arch: process.arch,
    capabilities: { clis, node: process.version, sandbox: fs.existsSync("/usr/bin/sandbox-exec") },
    profiles: profiles(),
    checkouts,
    deny: hostDeny(),
    live: [], // Phase 3: PTYs and headless runs that survived a link drop, for re-attach.
  };
}

/** One vitals frame: the Desk header's CPU/RAM/GPU plus the governor's load and memory signals. */
export async function sampleHostVitals(): Promise<HostVitals> {
  const [{ vitals }, load] = [await readVitals(), machineLoad()];
  const swap = swapPctOf(load);
  return {
    at: vitals.at,
    cpu: vitals.cpu,
    ram: vitals.ram,
    gpu: vitals.gpu,
    loadPerCore: load.loadPerCore,
    pressure: load.pressureLevel,
    swapPct: swap == null ? null : Math.round(swap * 10) / 10,
  };
}

// ───────────────────────────── doctor ─────────────────────────────

export type Check = { ok: boolean; label: string; detail: string; hint?: string };

/**
 * The setup checklist (HOSTS.md → Setup step 3), computed locally. Pure over its inputs so the
 * formatting is testable; `runDoctor` in index.ts gathers them.
 */
export function checklist(input: {
  node: string;
  clis: CliInfo[];
  profiles: ProfileInfo[];
  checkouts: CheckoutInfo[];
  roots: string[];
  secretsMode: number | null;
  joined: { id: string | null; brains: string[]; fp: string | null };
  plistInstalled: boolean;
}): Check[] {
  const out: Check[] = [];
  const major = Number(/^v(\d+)/.exec(input.node)?.[1] ?? 0);
  out.push({ ok: major >= 22, label: "node ≥ 22", detail: input.node, hint: "brew install node@22" });
  const cli = (n: string) => input.clis.find((c) => c.name === n);
  for (const n of ["git", "gh"]) {
    const c = cli(n);
    out.push({ ok: !!c?.path, label: n, detail: c?.path ? `${c.version ?? "?"} (${c.path})` : "not found", hint: n === "gh" ? "brew install gh && gh auth login" : "xcode-select --install" });
  }
  const agents = input.clis.filter((c) => !["git", "gh"].includes(c.name));
  const anyAgent = agents.some((c) => c.path);
  for (const c of agents) {
    out.push({ ok: !!c.path || anyAgent, label: `${c.name}${c.path ? "" : " (optional)"}`, detail: c.path ? `${c.version ?? "?"} (${c.path})` : "not installed" });
  }
  for (const p of input.profiles) {
    out.push({ ok: p.exists, label: `profile ${p.name}`, detail: p.dir, hint: p.exists ? undefined : `log in: CLAUDE_CONFIG_DIR=${p.dir} claude` });
  }
  for (const r of input.roots) {
    const n = input.checkouts.filter((c) => c.path.startsWith(r)).length;
    out.push({ ok: fs.existsSync(r), label: `root ${r}`, detail: fs.existsSync(r) ? `${n} checkout(s)` : "missing", hint: "set CHRONOS_HOST_ROOTS in ~/.chronos-host/.secrets" });
  }
  out.push({
    ok: !!input.joined.id && input.joined.brains.length > 0,
    label: "joined a brain",
    detail: input.joined.id ? `${input.joined.id} → ${input.joined.brains.join(", ")}` : "no",
    hint: "npm run host -- join <brain-url> <code>",
  });
  out.push({
    ok: input.secretsMode != null && (input.secretsMode & 0o077) === 0,
    label: "credential file is private",
    detail: input.secretsMode == null ? "missing" : `mode ${(input.secretsMode & 0o777).toString(8)}`,
    hint: "chmod 600 ~/.chronos-host/.secrets",
  });
  out.push({ ok: input.plistInstalled, label: "LaunchAgent installed", detail: input.plistInstalled ? "sh.chronos.host" : "no", hint: "re-run join, or install launchd/sh.chronos.host.plist.template" });
  return out;
}

export function formatChecklist(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}${!c.ok && c.hint ? `\n    → ${c.hint}` : ""}`).join("\n");
}
