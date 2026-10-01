/**
 * What this Mac can do for a brain: the CLIs it has, the profiles it is logged into, the repos it
 * has checked out, and what it refuses to run. Sent in `hello`, re-read by the `inventory` rpc, and
 * printed by `chronos host doctor`.
 *
 * Every probe is best-effort with a short timeout. A host that cannot answer "which claude?" still
 * connects; the Desk shows the gap in red instead of the host never appearing at all.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { refreshProfiles } from "../config.js";
import { detectOriginUrl } from "../repo-git.js";
import { machineLoad, readVitals, swapPctOf } from "../machine.js";
import { REPO_ROOT } from "../repo-root.js";
import { PROTOCOL_VERSION, type CheckoutInfo, type CliInfo, type GhAuthInfo, type Hello, type HostInstall, type HostVitals, type Inventory, type ProfileInfo } from "../hostlink/wire.js";
import { checkNode } from "../../bin/host-core.mjs";
import { commitOf, defaultRunner, detectInstall, type Runner } from "./update.js";

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
      const info: CliInfo = { name, path: p, version: p ? await firstLine(p, ["--version"]) : null };
      const auth = p ? await cliAuth(name, p) : undefined;
      return auth ? { ...info, auth } : info;
    }),
  );
}

/**
 * Is this CLI logged in here? Installed is not enough: the first real host had grok installed and never
 * logged in, and placement would have sent it grok terminals that die on a login screen. Only cheap,
 * local signals — never a model call:
 *  - grok: its own auth file exists (what `grok` login writes).
 *  - cursor-agent: CURSOR_API_KEY in this process's env, else `cursor-agent status`. Run from the host's
 *    LaunchAgent that reads the login keychain; from an SSH shell the keychain is locked and the answer
 *    is "unknown", never "no".
 * claude is left out on purpose: its login is per PROFILE, and profiles are reported separately.
 * opencode too: it runs on a gateway key the brain sends (AI_GATEWAY_API_KEY), with no local login.
 */
export async function cliAuth(name: string, bin: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<CliInfo["auth"]> {
  switch (name) {
    case "grok":
      return fs.existsSync(path.join(env.GROK_HOME || path.join(home, ".grok"), "auth.json")) ? "yes" : "no";
    case "cursor-agent": {
      if (env.CURSOR_API_KEY) return "yes";
      const out = await new Promise<string>((resolve) =>
        execFile(bin, ["status"], { encoding: "utf8", timeout: 15_000 }, (_e, o, e) => resolve(`${o ?? ""}\n${e ?? ""}`)),
      );
      return cursorAuthFrom(out);
    }
    default:
      return undefined;
  }
}

/** `cursor-agent status` → yes / no / unknown. A locked keychain or a timeout is not a "no". */
export function cursorAuthFrom(out: string): "yes" | "no" | "unknown" {
  const t = out.replace(/\x1b\[[0-9;]*m/g, "");
  if (/keychain is locked|unlock-keychain/i.test(t)) return "unknown";
  if (/not (logged|signed) in|log ?in required|please (log|sign) ?in/i.test(t)) return "no";
  if (/(logged|signed) in (as|with)|✓ ?logged in|authenticated/i.test(t)) return "yes";
  return "unknown";
}

/**
 * Profiles by NAME, from the same `~/.claude-*` discovery the daemon uses (`CONFIG.profiles`), run
 * against this Mac's home — and run AGAIN on every call (`refreshProfiles`), so a profile logged in
 * after this process started is reported on the next hello or inventory push without a restart.
 * `exists` is only "the directory is there"; `profilesWithAuth` adds whether it is logged in.
 */
export function profiles(): ProfileInfo[] {
  return Object.entries(refreshProfiles()).map(([name, dir]) => ({ name, dir, exists: fs.existsSync(dir) }));
}

/**
 * The keychain items claude may keep a profile's login in. A spawn always sets CLAUDE_CONFIG_DIR, and
 * claude then suffixes the service with the first 8 hex of sha256(dir); a login made in a plain shell
 * for `~/.claude` (no CLAUDE_CONFIG_DIR) lands in the unsuffixed item, so the default dir checks both.
 */
export function claudeKeychainServices(dir: string, home = os.homedir()): string[] {
  const hashed = `Claude Code-credentials-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return path.resolve(dir) === path.join(home, ".claude") ? [hashed, "Claude Code-credentials"] : [hashed];
}

/** `security` exit code for errSecItemNotFound. 0 = found; anything else (locked, no GUI session) is no answer. */
export const SEC_NOT_FOUND = 44;

/**
 * Is this profile logged in? Cheap and local: claude's plaintext credentials file in the dir (where it
 * keeps the login when there is no keychain), else the keychain item's EXISTENCE — `security
 * find-generic-password -s` without `-w`/`-g`, so the secret is never read. A keychain this process
 * cannot search (an SSH session, a launchd job outside the login session) answers "unknown", never
 * "no": `reachable` is checked first because a search list without the login keychain says "not
 * found" for everything.
 */
export async function profileAuth(dir: string, o: { run?: Runner; platform?: string; home?: string; reachable?: boolean } = {}): Promise<"yes" | "no" | "unknown"> {
  if (!fs.existsSync(dir)) return "no";
  if (fs.existsSync(path.join(dir, CLAUDE_CRED_FILE))) return "yes";
  if ((o.platform ?? process.platform) !== "darwin") return "unknown";
  const run = o.run ?? defaultRunner;
  if (!(o.reachable ?? (await keychainReachable(run)))) return "unknown";
  let missing = 0;
  const names = claudeKeychainServices(dir, o.home);
  for (const name of names) {
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", name], { timeoutMs: 5000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (r.code === 0) return "yes";
    if (r.code === SEC_NOT_FOUND) missing++;
  }
  return missing === names.length ? "no" : "unknown";
}
const CLAUDE_CRED_FILE = ".credentials.json";

/** Does this process's keychain search list include the login keychain? (`security list-keychains -d user`.) */
export async function keychainReachable(run: Runner = defaultRunner): Promise<boolean> {
  const r = await run("/usr/bin/security", ["list-keychains", "-d", "user"], { timeoutMs: 5000 }).catch(() => null);
  return !!r && r.code === 0 && /login\.keychain/.test(r.stdout);
}

/** Profiles with `auth` — what hello and every inventory push report. */
export async function profilesWithAuth(run: Runner = defaultRunner, platform: string = process.platform): Promise<ProfileInfo[]> {
  const list = profiles();
  const reachable = platform === "darwin" ? await keychainReachable(run) : false;
  return Promise.all(list.map(async (p) => ({ ...p, auth: await profileAuth(p.dir, { run, platform, reachable }) })));
}

/**
 * `gh auth status` → yes / no / unknown, plus the account. Wording differs across gh versions (and
 * between stdout and stderr), so this reads both; a timeout, a locked keyring or a network error is
 * "unknown". The token line is never kept (gh masks it anyway).
 */
export function ghAuthFrom(code: number, out: string): { auth: "yes" | "no" | "unknown"; account: string | null; detail: string | null } {
  const t = out.replace(/\x1b\[[0-9;]*m/g, "");
  const acct = /Logged in to \S+ (?:account|as) ([\w.-]+)/i.exec(t)?.[1] ?? null;
  if (code === 0 && acct) return { auth: "yes", account: acct, detail: null };
  if (/You are not logged into any|not logged in/i.test(t)) return { auth: "no", account: null, detail: "not logged in" };
  if (/token .*is invalid/i.test(t)) return { auth: "no", account: acct, detail: "token invalid" };
  if (/keyring|keychain|timeout|timed out|could not resolve|connection refused|network/i.test(t)) return { auth: "unknown", account: acct, detail: "gh could not check (keyring or network)" };
  return { auth: "unknown", account: acct, detail: null };
}

/** `gh auth status` for each dir (`~/…` or absolute; "default" = gh's own). Never blocks long: 10s each. */
export async function ghAuth(dirs: Array<{ dir: string; workspaces: string[] }>, run: Runner = defaultRunner, ghBin: string | null = which("gh")): Promise<GhAuthInfo[]> {
  if (!ghBin) return [];
  return Promise.all(dirs.map(async ({ dir, workspaces }) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (dir === "default") delete env.GH_CONFIG_DIR;
    else env.GH_CONFIG_DIR = expand(dir);
    const r = await run(ghBin, ["auth", "status"], { env, timeoutMs: 10_000 }).catch(() => null);
    const v = r ? ghAuthFrom(r.code, `${r.stdout}\n${r.stderr}`) : { auth: "unknown" as const, account: null, detail: "gh did not run" };
    return { dir, workspaces, ...v };
  }));
}

/** The default gh login plus every dir the brain named, de-duplicated by dir. */
export function ghDirsToProbe(fromBrain: Array<{ dir: string; workspaces: string[] }> | null | undefined): Array<{ dir: string; workspaces: string[] }> {
  const out = new Map<string, string[]>([["default", []]]);
  for (const d of fromBrain ?? []) {
    if (!d || typeof d.dir !== "string" || !d.dir.trim()) continue;
    const ws = Array.isArray(d.workspaces) ? d.workspaces.filter((w) => typeof w === "string") : [];
    out.set(d.dir, [...new Set([...(out.get(d.dir) ?? []), ...ws])]);
  }
  return [...out].map(([dir, workspaces]) => ({ dir, workspaces }));
}

/** Everything that can drift between hellos, freshly looked at (profiles re-discovered). */
export async function collectInventory(ghDirs?: Array<{ dir: string; workspaces: string[] }> | null): Promise<Inventory> {
  const [clis, profs, checkouts, gh] = await Promise.all([probeClis(), profilesWithAuth(), scanCheckouts(), ghAuth(ghDirsToProbe(ghDirs))]);
  return { clis, profiles: profs, checkouts, gh };
}

/**
 * Git checkouts under each root, with origin: the root itself, its children, and — for a child that
 * is not a checkout — that child's children. Two levels because people group repos by client
 * (`~/Documents/GitHub/<client>/<repo>`); the first real host was laid out exactly like that and
 * reported zero checkouts under a one-level scan. Never deeper: node_modules and vendored repos.
 */
export async function scanCheckouts(roots = hostRoots()): Promise<CheckoutInfo[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const consider = (p: string) => {
    let real: string;
    try {
      real = fs.realpathSync.native(p); // .native: the on-disk case (see canonicalCwd in claude-trust.ts)
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
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const child = path.join(root, e.name);
      if (fs.existsSync(path.join(child, ".git"))) { consider(child); continue; }
      let grand: fs.Dirent[] = [];
      try { grand = fs.readdirSync(child, { withFileTypes: true }); } catch { continue; }
      for (const g of grand) if (!g.name.startsWith(".") && g.name !== "node_modules") consider(path.join(child, g.name));
    }
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

/**
 * What this process runs, for hello (phase 6): the commit and how it was installed, so the brain can
 * say "update available" and knows whether the `update` frame is understood. Read once: the code
 * under a running process does not change until an update restarts it.
 */
let buildInfo: Promise<{ commit: string | null; install: HostInstall }> | null = null;
export function hostBuild(): Promise<{ commit: string | null; install: HostInstall }> {
  buildInfo ??= (async () => {
    const inst = detectInstall();
    // A temporary copy (npx cache) is not something the brain can update, same as a dev checkout.
    const install: HostInstall = inst.kind === "git" || inst.kind === "npm" ? inst.kind : "dev";
    return { commit: await commitOf(inst.pkgRoot).catch(() => null), install };
  })();
  return buildInfo;
}

export async function buildHello(hostId: string, name = os.hostname().replace(/\.local$/, "")): Promise<Hello> {
  const [clis, profs, checkouts, build] = await Promise.all([probeClis(), profilesWithAuth(), scanCheckouts(), hostBuild()]);
  return {
    t: "hello",
    proto: PROTOCOL_VERSION,
    version: chronosVersion(),
    host_id: hostId,
    name,
    platform: process.platform,
    arch: process.arch,
    capabilities: {
      clis, node: process.version, sandbox: fs.existsSync("/usr/bin/sandbox-exec"),
      // Placement (HOSTS.md phase 4) may only send a repo this Mac has not cloned when it said so.
      auto_clone: process.env.CHRONOS_HOST_AUTO_CLONE === "1",
      // Phase 5: this host runs headless jobs + the ship pipeline's exec, and egress proxies itself.
      procs: true,
      egress: true,
    },
    profiles: profs,
    checkouts,
    deny: hostDeny(),
    live: [], // PTYs (phase 3) and headless runs (phase 5) that survived a link drop — filled by index.ts.
    commit: build.commit,
    install: build.install,
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
    ncpu: load.ncpu,
    load1: Math.round(load.load1 * 100) / 100,
    swapUsedMb: load.swapUsedMb == null ? null : Math.round(load.swapUsedMb),
    swapTotalMb: load.swapTotalMb == null ? null : Math.round(load.swapTotalMb),
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
  /** `gh auth status` per GH_CONFIG_DIR (protocol 1.5). A ✗ here never blocks placement: gh is only some work's need. */
  gh?: GhAuthInfo[];
  roots: string[];
  secretsMode: number | null;
  joined: { id: string | null; brains: string[]; fp: string | null };
  plistInstalled: boolean;
}): Check[] {
  const out: Check[] = [];
  // The supported range and its fix live in bin/host-core.mjs, shared with the preflight.
  const n = checkNode(input.node, "");
  out.push({ ok: n.ok, label: n.label, detail: input.node, hint: n.fix });
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
    const ok = p.exists && p.auth !== "no";
    const state = !p.exists ? "" : p.auth === "yes" ? " (logged in)" : p.auth === "no" ? " (not logged in)" : p.auth === "unknown" ? " (login unknown — keychain not readable from here)" : "";
    out.push({ ok, label: `profile ${p.name}`, detail: `${p.dir}${state}`, hint: ok ? undefined : `log in: CLAUDE_CONFIG_DIR=${p.dir} claude` });
  }
  for (const g of input.gh ?? []) {
    const who = g.workspaces.length ? ` (${g.workspaces.join(", ")})` : "";
    const fix = g.dir === "default" ? "gh auth login" : `GH_CONFIG_DIR=${g.dir} gh auth login`;
    const detail = g.auth === "yes" ? `logged in${g.account ? ` as ${g.account}` : ""}` : g.auth === "no" ? g.detail ?? "not logged in" : `unknown${g.detail ? ` — ${g.detail}` : ""}`;
    out.push({ ok: g.auth !== "no", label: `gh ${g.dir}${who}`, detail, hint: fix });
  }
  for (const r of input.roots) {
    const n = input.checkouts.filter((c) => c.path.startsWith(r)).length;
    out.push({ ok: fs.existsSync(r), label: `root ${r}`, detail: fs.existsSync(r) ? `${n} checkout(s)` : "missing", hint: "set CHRONOS_HOST_ROOTS in ~/.chronos-host/.secrets" });
  }
  out.push({
    ok: !!input.joined.id && input.joined.brains.length > 0,
    label: "joined a brain",
    detail: input.joined.id ? `${input.joined.id} → ${input.joined.brains.join(", ")}` : "no",
    hint: "paste the command from Desk → Computers → + Add",
  });
  out.push({
    ok: input.secretsMode != null && (input.secretsMode & 0o077) === 0,
    label: "credential file is private",
    detail: input.secretsMode == null ? "missing" : `mode ${(input.secretsMode & 0o777).toString(8)}`,
    hint: 'chmod 600 "$HOME/.chronos-host/.secrets"',
  });
  out.push({ ok: input.plistInstalled, label: "LaunchAgent installed", detail: input.plistInstalled ? "sh.chronos.host" : "no", hint: "re-run join, or install launchd/sh.chronos.host.plist.template" });
  return out;
}

export function formatChecklist(checks: Check[]): string {
  return checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}${!c.ok && c.hint ? `\n    → ${c.hint}` : ""}`).join("\n");
}
