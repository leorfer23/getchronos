/**
 * "Do the agent CLIs actually work here?" — the checks behind `npm run setup`, the Desk's welcome
 * (GET /api/setup/status) and its install / sign-in / try-it buttons (src/setup-routes.ts).
 *
 * Every probe runs the CLI the way Chronos will run it, never the way the operator's own terminal
 * does: the binary a spawn resolves (CONFIG.*Bin, then ~/.mc/bin and the daemon's PATH), the
 * environment an agent gets (childEnv — an allowlist, so an API key in the daemon's env does not count
 * unless it reaches agents), and the per-account directory a spawn sets (CLAUDE_CONFIG_DIR for claude,
 * CODEX_HOME for codex — both the workspace's config dir, which defaults to ~/.claude). Checked from a
 * plain terminal, both said "signed in" on a Mac where every codex agent was not: the ChatGPT login was
 * in ~/.codex and Chronos points CODEX_HOME at the profile dir.
 *
 * Nothing here returns or logs an email, an org id or a key. The CLIs print them; only booleans and a
 * plan name are kept, and anything quoted back (a test prompt's reply or error, an installer's last
 * lines) has emails scrubbed first.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { childEnv } from "./child-env.js";
import { workspaces } from "./store.js";
import { getBackend } from "./backends/index.js";
import { claudeAuthStatus } from "./backends/claude.js";
import { grokAuthFrom } from "./backends/grok.js";
import type { AgentBackend } from "./backends/types.js";
import { resultText } from "./summarize.js";
import { shellPath } from "../bin/host-core.mjs";

export const CLI_IDS = ["claude", "codex", "cursor-agent", "grok", "opencode"] as const;
export type CliId = (typeof CLI_IDS)[number];
export const isCliId = (s: string): s is CliId => (CLI_IDS as readonly string[]).includes(s);

/** One line of GET /api/setup/status `clis`. `loggedIn: null` = can't tell (or, for opencode, nothing to sign in to). */
export type CliStatus = {
  id: CliId;
  label: string;
  backend: string;
  installed: boolean;
  version: string | null;
  /** Where the binary was found, `~`-relative — what a spawn will run. */
  path: string | null;
  loggedIn: boolean | null;
  authDetail: string | null;
  /** The vendor's own installer, as a person would paste it. */
  install: string;
  /** The browser sign-in, with the account dir Chronos's agents read when that is not the CLI's default. */
  login: string;
  /** A one-line real prompt to paste when the test prompt fails — shows the CLI's whole error. */
  try: string;
  /** The vendor's desktop app is on this Mac (Claude, ChatGPT, Cursor…): offer the CLI that rides the same subscription. */
  app: boolean;
  can_install: boolean;
  /** claude only: the other config dirs (`~/.claude-<name>`) and whether each is signed in. */
  profiles?: Array<{ name: string; loggedIn: boolean | null }>;
};

export type SetupStatus = {
  daemon: { ok: true; version: string; port: number };
  projects: number;
  clis: CliStatus[];
};

export type ExecResult = { code: number | null; stdout: string; stderr: string; error: string | null };
export type Exec = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

export const SMOKE_PROMPT = "Reply with exactly: OK";
const MAX_OUT = 1 << 20;

/** Spawn with stdin closed (a CLI that waits on a piped stdin would hang until the timeout), kill the whole group on timeout. */
export const defaultExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (r: ExecResult) => { if (!done) { done = true; resolve(r); } };
    let out = "", err = "", timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      // detached: its own process group, so a timeout kills what it forked too, and no controlling
      // terminal — an installer cannot stop to ask a question nobody will see.
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e: any) {
      return finish({ code: null, stdout: "", stderr: "", error: String(e?.message ?? e) });
    }
    child.stdout?.on("data", (d) => { if (out.length < MAX_OUT) out += d; });
    child.stderr?.on("data", (d) => { if (err.length < MAX_OUT) err += d; });
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid); }, o.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); finish({ code: null, stdout: out, stderr: err, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: timedOut ? null : code, stdout: out, stderr: err, error: timedOut ? `timed out after ${Math.round(o.timeoutMs / 1000)} s` : null });
    });
  });

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

type Probe = { loggedIn: boolean | null; detail: string | null };
type ProbeCtx = { bin: string; env: NodeJS.ProcessEnv; exec: Exec; dir: string; fresh: boolean };

type Def = {
  id: CliId;
  label: string;
  backend: string;
  bin: () => string;
  apps: string[];
  install: string;
  /** Switches that keep the installer from stopping on a question when Chronos runs it. */
  installEnv?: Record<string, string>;
  /** Where the installer puts the binary — for "installed, but this Chronos can't see it". */
  installDir: (home: string) => string | null;
  /** npm-based installers need npm; curl-based ones curl and bash. */
  installNeeds: string[];
  loginArgs: string[];
  /** The account dir a spawn sets (backends/claude.ts, backends/codex.ts env()). */
  dirEnv?: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  tryArgs: string;
  smokeModel?: string;
  auth: (c: ProbeCtx) => Promise<Probe>;
};

// Install commands: each vendor's own installer, verified 2026-11-11 against its docs and by reading
// the script it serves — claude: code.claude.com/docs/en/setup (native installer, puts the launcher
// in ~/.local/bin) · codex: learn.chatgpt.com/docs/codex/cli + github.com/openai/codex (→ ~/.local/bin;
// CODEX_NON_INTERACTIVE=1 is the script's own switch for "never prompt") · cursor:
// cursor.com/docs/cli/installation (→ ~/.local/bin/cursor-agent) · grok: x.ai/cli/install.sh, xAI's
// script (→ ~/.grok/bin, CONFIG.grokBin's default; no docs page found) · opencode: the opencode-ai npm
// package, the 1.x line backends/opencode.ts was verified against (its docs now show a 2.x installer).
// npm -g lands in node's own bin dir, which launchd puts first on the daemon's PATH.
// Sign-in commands: each CLI's own --help on a Mac with all five installed.
const DEFS: Record<CliId, Def> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    backend: "claude-code",
    bin: () => CONFIG.claudeBin,
    apps: ["Claude.app"],
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    installDir: (h) => path.join(h, ".local", "bin"),
    installNeeds: ["curl", "bash"],
    loginArgs: ["auth", "login"],
    dirEnv: "CLAUDE_CONFIG_DIR",
    tryArgs: `-p "${SMOKE_PROMPT}"`,
    smokeModel: "haiku",
    auth: async (c) => claudeAuthStatus(c.dir, { bin: c.bin, env: c.env, fresh: c.fresh }),
  },
  codex: {
    id: "codex",
    label: "Codex (ChatGPT)",
    backend: "codex",
    bin: () => CONFIG.codexBin,
    apps: ["ChatGPT.app", "Codex.app"],
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    installEnv: { CODEX_NON_INTERACTIVE: "1" },
    installDir: (h) => path.join(h, ".local", "bin"),
    installNeeds: ["curl", "sh"],
    loginArgs: ["login"],
    dirEnv: "CODEX_HOME",
    tryArgs: `exec "${SMOKE_PROMPT}"`,
    auth: async (c) => {
      if (c.env.OPENAI_API_KEY) return { loggedIn: true, detail: "OpenAI API key" };
      const r = await c.exec(c.bin, ["login", "status"], { env: c.env, timeoutMs: 10_000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (r.code === 0) return { loggedIn: true, detail: /chatgpt/i.test(text) ? "ChatGPT account" : /api key/i.test(text) ? "OpenAI API key" : null };
      if (r.code !== null && /not logged in|not signed in/i.test(text)) return { loggedIn: false, detail: null };
      return { loggedIn: r.code === null ? null : false, detail: null };
    },
  },
  "cursor-agent": {
    id: "cursor-agent",
    label: "Cursor",
    backend: "cursor-agent",
    bin: () => CONFIG.cursorBin,
    apps: ["Cursor.app"],
    install: "curl https://cursor.com/install -fsS | bash",
    installDir: (h) => path.join(h, ".local", "bin"),
    installNeeds: ["curl", "bash"],
    loginArgs: ["login"],
    tryArgs: `-p "${SMOKE_PROMPT}" --model auto`,
    smokeModel: "auto",
    auth: async (c) => {
      // --format json: { isAuthenticated, userInfo: {email…} } — only the boolean is read.
      const r = await c.exec(c.bin, ["status", "--format", "json"], { env: c.env, timeoutMs: 15_000 });
      try {
        const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1));
        if (typeof j?.isAuthenticated === "boolean") return { loggedIn: j.isAuthenticated, detail: j.isAuthenticated ? "Cursor account" : null };
      } catch {}
      // A locked keychain (an SSH session) or a timeout is "can't tell", never "no".
      return { loggedIn: /not logged in/i.test(`${r.stdout}${r.stderr}`) ? false : null, detail: null };
    },
  },
  grok: {
    id: "grok",
    label: "Grok",
    backend: "grok",
    bin: () => CONFIG.grokBin,
    apps: ["Grok.app"],
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
    installDir: (h) => path.join(h, ".grok", "bin"),
    installNeeds: ["curl", "bash"],
    loginArgs: ["login"],
    tryArgs: `-p "${SMOKE_PROMPT}"`,
    auth: async (c) => {
      const r = await c.exec(c.bin, ["models"], { env: c.env, timeoutMs: 15_000 });
      const v = r.code === null ? null : grokAuthFrom(`${r.stdout}\n${r.stderr}`);
      return { loggedIn: v, detail: v ? "grok.com account" : null };
    },
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    backend: "opencode",
    bin: () => CONFIG.opencodeBin,
    apps: [],
    install: "npm install -g opencode-ai",
    installDir: () => null,
    installNeeds: ["npm"],
    loginArgs: ["auth", "login"],
    tryArgs: `run "${SMOKE_PROMPT}" --model opencode/big-pickle`,
    smokeModel: "opencode/big-pickle",
    auth: async (c) => {
      // opencode needs no sign-in: its own free models run keyless. A provider login or the shared
      // AI Gateway key (passed to every agent, child-env.ts) is a plus, not a requirement.
      if (c.env.AI_GATEWAY_API_KEY) return { loggedIn: true, detail: "AI Gateway key" };
      const r = await c.exec(c.bin, ["auth", "list"], { env: c.env, timeoutMs: 10_000 });
      const n = Number(/(\d+)\s+credentials?/i.exec(r.stdout.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? NaN);
      if (n > 0) return { loggedIn: true, detail: n === 1 ? "1 provider signed in" : `${n} providers signed in` };
      return { loggedIn: null, detail: "free models, no sign-in needed" };
    },
  },
};

export const cliLabel = (id: CliId): string => DEFS[id].label;

// ───────────────────────────── where things are ─────────────────────────────

const runnable = (p: string): boolean => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
};

/**
 * The binary a spawn would run for this setting: an absolute path as is, a bare name on ~/.mc/bin and
 * the daemon's PATH — the PATH agents inherit (terminal.ts mcEnv), and the same lookup the failover
 * chain trusts (backends/index.ts backendInstalled). A CLI found only somewhere else is not installed
 * as far as any agent is concerned.
 */
export function resolveBin(bin: string, o: { pathVar?: string; home?: string } = {}): string | null {
  if (!bin) return null;
  if (bin.includes("/")) return runnable(bin) ? bin : null;
  const home = o.home ?? os.homedir();
  const dirs = [path.join(home, ".mc", "bin"), ...(o.pathVar ?? process.env.PATH ?? "").split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, bin);
    if (runnable(f)) return f;
  }
  return null;
}

/** The account dir an agent with no project of its own runs with: the default profile (runner.ts / terminal.ts fallback). */
export function defaultAgentDir(): string {
  return CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? path.join(os.homedir(), ".claude");
}

/** The env an agent of this CLI gets: childEnv's allowlist, ~/.mc/bin first on PATH, and the account dir its backend sets. */
function agentEnv(def: Def, dir: string, home = os.homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv(null), PATH: `${path.join(home, ".mc", "bin")}:${process.env.PATH ?? ""}` };
  if (def.dirEnv) env[def.dirEnv] = dir;
  return env;
}

const tilde = (p: string, home = os.homedir()): string => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

/** `claude --version` → "2.1.322"; cursor's date-style "2026.11.05-86047df" kept whole. */
export function versionFrom(out: string): string | null {
  const m = /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/.exec(out);
  return m ? m[0].slice(0, 40) : null;
}

/** Emails out, escapes out, one line, bounded — for anything a CLI printed that is quoted back. */
export function scrub(s: string, max = 300): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function appPresent(apps: string[], dirs: string[]): boolean {
  return apps.some((a) => dirs.some((d) => fs.existsSync(path.join(d, a))));
}

function hasTool(name: string, pathVar = process.env.PATH ?? ""): boolean {
  return pathVar.split(path.delimiter).some((d) => !!d && runnable(path.join(d, name)));
}

function shownBin(setting: string, home: string): string {
  return setting.includes("/") ? shellPath(setting, home) : setting;
}

// ───────────────────────────── status ─────────────────────────────

export type StatusDeps = {
  exec?: Exec;
  home?: string;
  pathVar?: string;
  appDirs?: string[];
  platform?: string;
  /** claude profile dirs to list besides the default (name → dir). Defaults to CONFIG.profiles. */
  profiles?: Record<string, string>;
  fresh?: boolean;
};

async function cliStatus(def: Def, d: Required<Omit<StatusDeps, "fresh">> & { fresh: boolean }): Promise<CliStatus> {
  const setting = def.bin();
  const bin = resolveBin(setting, { pathVar: d.pathVar, home: d.home });
  const dir = defaultAgentDir();
  const env = agentEnv(def, dir, d.home);
  const envPrefix = def.dirEnv ? `${def.dirEnv}=${shellPath(dir, d.home)} ` : "";
  const shown = shownBin(setting, d.home);
  const row: CliStatus = {
    id: def.id,
    label: def.label,
    backend: def.backend,
    installed: !!bin,
    version: null,
    path: bin ? tilde(bin, d.home) : null,
    loggedIn: null,
    authDetail: null,
    install: def.install,
    login: `${envPrefix}${shown} ${def.loginArgs.join(" ")}`,
    try: `${envPrefix}${shown} ${def.tryArgs}`,
    app: appPresent(def.apps, d.appDirs),
    can_install: !bin && (d.platform === "darwin" || d.platform === "linux") && def.installNeeds.every((t) => hasTool(t, d.pathVar)),
  };
  if (!bin) return row;
  const [ver, auth] = await Promise.all([
    d.exec(bin, ["--version"], { env, timeoutMs: 5_000 }),
    def.auth({ bin, env, exec: d.exec, dir, fresh: d.fresh }).catch((): Probe => ({ loggedIn: null, detail: null })),
  ]);
  row.version = versionFrom(`${ver.stdout}\n${ver.stderr}`);
  row.loggedIn = auth.loggedIn;
  row.authDetail = auth.detail;
  if (def.id === "claude") {
    const others = Object.entries(d.profiles).filter(([, p]) => path.resolve(p) !== path.resolve(dir)).slice(0, 8);
    row.profiles = await Promise.all(
      others.map(async ([name, p]) => ({ name, loggedIn: (await claudeAuthStatus(p, { bin, env: { ...env, CLAUDE_CONFIG_DIR: p }, fresh: d.fresh })).loggedIn })),
    );
  }
  return row;
}

const PKG_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

let cached: { at: number; value: Promise<SetupStatus> } | null = null;
const STATUS_TTL_MS = 30_000;

/** Forget the cached answer — after an install or a sign-in, the next look must be a real one. */
export function invalidateSetupStatus(): void {
  cached = null;
}

/**
 * The whole picture, cached 30 s: the Desk polls this while its welcome is open, and one answer is
 * five CLIs × two processes. `fresh` (setup re-checking after a sign-in) skips the cache and refills it.
 * Injected deps (tests) never touch the cache.
 */
export function setupStatus(o: StatusDeps = {}): Promise<SetupStatus> {
  const injected = o.exec || o.home || o.pathVar || o.appDirs || o.platform || o.profiles;
  if (!injected && !o.fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const home = o.home ?? os.homedir();
  const d = {
    exec: o.exec ?? defaultExec,
    home,
    pathVar: o.pathVar ?? process.env.PATH ?? "",
    appDirs: o.appDirs ?? ["/Applications", path.join(home, "Applications")],
    platform: o.platform ?? process.platform,
    profiles: o.profiles ?? CONFIG.profiles,
    fresh: !!o.fresh,
  };
  const value = (async (): Promise<SetupStatus> => ({
    daemon: { ok: true, version: PKG_VERSION, port: CONFIG.port },
    projects: workspaces.list().length,
    clis: await Promise.all(CLI_IDS.map((id) => cliStatus(DEFS[id], d))),
  }))();
  if (!injected) {
    cached = { at: Date.now(), value };
    value.catch(() => { if (cached?.value === value) cached = null; });
  }
  return value;
}

// ───────────────────────────── a real prompt ─────────────────────────────

export type SmokeResult = { ok: boolean; ms: number; reply?: string; error?: string };

/** A scratch git repo to run the test prompt in: no project's files in context, and codex refuses a non-repo dir. */
function smokeDir(): string {
  const dir = path.join(os.tmpdir(), "chronos-setup-smoke");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    try { execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", timeout: 10_000 }); } catch {}
  }
  return dir;
}

/** The answer in a one-shot transcript, whichever way this backend streams it (a result line, text deltas, an item). */
function answerOf(b: AgentBackend, stdout: string): { text: string | null; error: string | null } {
  let final: string | null = null, deltas = "", error: string | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const ev = b.parseLine(line);
    const r = b.extractResult(ev);
    if (r?.is_error) error = r.result_text ?? r.summary ?? "error";
    else if (r?.result_text) final = r.result_text;
    const d = b.textDelta?.(ev);
    if (d) deltas += d;
  }
  return { text: (final ?? deltas).trim() || resultText(stdout), error };
}

const smokeInflight = new Map<CliId, Promise<SmokeResult>>();

/**
 * One tiny real prompt ("Reply with exactly: OK") through the same argv and env a Chronos helper run
 * uses (backend.oneShot + the account dir), on the cheapest model where the CLI lets us pick one —
 * haiku for claude, auto for cursor, opencode's free model; codex and grok keep their own default
 * (naming a model the account lacks would fail a CLI that works). 60 s, then it is a failure.
 */
export function smokeCli(id: CliId, o: { exec?: Exec; timeoutMs?: number; home?: string; pathVar?: string } = {}): Promise<SmokeResult> {
  const running = !o.exec && smokeInflight.get(id);
  if (running) return running;
  const p = (async (): Promise<SmokeResult> => {
    const def = DEFS[id];
    const home = o.home ?? os.homedir();
    const bin = resolveBin(def.bin(), { pathVar: o.pathVar, home });
    if (!bin) return { ok: false, ms: 0, error: `${def.label} isn't installed` };
    const backend = getBackend(def.backend);
    const dir = defaultAgentDir();
    const timeoutMs = o.timeoutMs ?? 60_000;
    const spec = backend.oneShot({ prompt: SMOKE_PROMPT, model: def.smokeModel, configDir: dir, timeoutMs });
    const t0 = Date.now();
    const r = await (o.exec ?? defaultExec)(bin, spec.args, { env: { ...agentEnv(def, dir, home), ...spec.env }, timeoutMs, cwd: smokeDir() });
    const ms = Date.now() - t0;
    const { text, error } = answerOf(backend, r.stdout);
    if (r.code === 0 && text && !error) return { ok: true, ms, reply: scrub(text, 80) };
    const why = error || r.error || r.stderr.trim().split("\n").filter(Boolean).pop() || (r.code !== 0 ? `exited with code ${r.code}` : "no answer");
    return { ok: false, ms, error: scrub(why, 200) };
  })();
  if (!o.exec) {
    smokeInflight.set(id, p);
    void p.finally(() => smokeInflight.delete(id));
  }
  return p;
}

// ───────────────────────────── install + sign in ─────────────────────────────

const installInflight = new Map<CliId, Promise<{ ok: boolean; log_tail: string }>>();

function tail(s: string, lines = 30, max = 3000): string {
  const t = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  return t.split("\n").filter((l) => l.trim()).slice(-lines).join("\n").slice(-max);
}

/**
 * Run the vendor's installer for a CLI that is missing (POST /api/setup/install/:id, `npm run setup`).
 * The env is the daemon's own minus the account-dir variables: codex's installer puts its packages
 * under $CODEX_HOME, which in Chronos means a claude profile dir. Four minutes, then it is a failure.
 */
export function installCli(id: CliId, o: { exec?: Exec; command?: string; home?: string; pathVar?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; log_tail: string }> {
  const running = !o.exec && installInflight.get(id);
  if (running) return running;
  const p = (async () => {
    const def = DEFS[id];
    const home = o.home ?? os.homedir();
    const lookup = { pathVar: o.pathVar, home };
    if (resolveBin(def.bin(), lookup)) return { ok: true, log_tail: `${def.label} is already installed.` };
    const env: NodeJS.ProcessEnv = { ...process.env, ...def.installEnv };
    delete env.CODEX_HOME;
    delete env.CLAUDE_CONFIG_DIR;
    const r = await (o.exec ?? defaultExec)("/bin/bash", ["-c", o.command ?? def.install], { env, timeoutMs: o.timeoutMs ?? 240_000, cwd: home });
    invalidateSetupStatus();
    const log = tail(`${r.stdout}\n${r.stderr}${r.error ? `\n${r.error}` : ""}`);
    if (resolveBin(def.bin(), lookup)) return { ok: true, log_tail: log };
    const dir = def.installDir(home);
    const name = path.basename(def.bin());
    if (r.code === 0 && dir && runnable(path.join(dir, name))) {
      return { ok: false, log_tail: `${log}\n${def.label} is installed in ${tilde(dir, home)}, which this Chronos can't see — start Chronos again from a new terminal.`.trim() };
    }
    return { ok: false, log_tail: log || `the installer exited with code ${r.code}` };
  })();
  if (!o.exec) {
    installInflight.set(id, p);
    void p.finally(() => installInflight.delete(id));
  }
  return p;
}

const loginInflight = new Map<CliId, Promise<{ ok: boolean; message?: string }>>();

/**
 * The browser sign-in, started from the Desk (POST /api/setup/login/:id): the CLI's own login command
 * in the env its agents run with — CLAUDE_CONFIG_DIR / CODEX_HOME set, so the login lands where they
 * look — then a poll of the same status check until it flips, at most 3 minutes. `npm run setup` runs
 * the same command in the terminal instead, where a CLI that wants a pasted code can get one.
 */
export function loginCli(id: CliId, o: { pollMs?: number; timeoutMs?: number; home?: string; pathVar?: string } = {}): Promise<{ ok: boolean; message?: string }> {
  const running = loginInflight.get(id);
  if (running) return running;
  const p = (async () => {
    const def = DEFS[id];
    const home = o.home ?? os.homedir();
    const bin = resolveBin(def.bin(), { pathVar: o.pathVar, home });
    if (!bin) return { ok: false, message: `${def.label} isn't installed yet` };
    const dir = defaultAgentDir();
    const env = agentEnv(def, dir, home);
    const probe = async () => (await def.auth({ bin, env, exec: defaultExec, dir, fresh: true }).catch(() => ({ loggedIn: null, detail: null }))).loggedIn;
    if ((await probe()) === true) return { ok: true, message: "already signed in" };
    const command = `${def.dirEnv ? `${def.dirEnv}=${shellPath(dir, home)} ` : ""}${shownBin(def.bin(), home)} ${def.loginArgs.join(" ")}`;
    let exited = false, exitCode: number | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, def.loginArgs, { env, stdio: "ignore", detached: true });
    } catch (e: any) {
      return { ok: false, message: scrub(String(e?.message ?? e), 200) };
    }
    child.on("error", () => { exited = true; });
    child.on("exit", (code) => { exited = true; exitCode = code; });
    const deadline = Date.now() + (o.timeoutMs ?? 180_000);
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, o.pollMs ?? 2_000));
        if ((await probe()) === true) { invalidateSetupStatus(); return { ok: true }; }
        if (exited) {
          // claude exits by itself once the browser comes back; one last look before calling it failed.
          if ((await probe()) === true) { invalidateSetupStatus(); return { ok: true }; }
          return { ok: false, message: `the sign-in ended without finishing${exitCode ? ` (code ${exitCode})` : ""} — try again, or run in a terminal: ${command}` };
        }
      }
      return { ok: false, message: `the sign-in timed out — finish it in the browser, or run in a terminal: ${command}` };
    } finally {
      if (!exited) killGroup(child.pid);
    }
  })();
  loginInflight.set(id, p);
  void p.finally(() => loginInflight.delete(id));
  return p;
}
