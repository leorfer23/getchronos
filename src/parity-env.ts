import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inRepo } from "./repo-root.js";

/**
 * Which home a CLI profile runs with — the ONE place that decides it, so the spawn env and every file
 * Chronos reads or writes for that profile agree by construction.
 *
 * The bug this exists for (Claude Code 2.1.322, checked in an isolated HOME): claude reads its global
 * config — user MCP servers, per-project servers and trust, the account — from `$CLAUDE_CONFIG_DIR/.claude.json`
 * when that variable is set, and from `~/.claude.json` when it is not. Chronos always set it, even for
 * the default `~/.claude`, so every agent on the default profile read `~/.claude/.claude.json` — a file
 * only Chronos ever wrote — and silently ran without the MCP servers the person has in their own
 * terminal. Settings, plugins, skills and CLAUDE.md live in `~/.claude/` either way; only the global
 * config moves. https://code.claude.com/docs/en/claude-directory ("If you set CLAUDE_CONFIG_DIR …
 * The same applies to .claude.json, which otherwise sits at ~/.claude.json").
 *
 * So the default profile runs WITHOUT `CLAUDE_CONFIG_DIR` ("own home"): the exact env a plain terminal
 * has, nothing to keep in sync. Named profiles (`~/.claude-<client>`) keep it — one client per account,
 * separate on purpose — and nothing here ever writes into one.
 *
 * Why the switch is not unconditional: on macOS claude also names its keychain item after the variable —
 * `Claude Code-credentials` without it, `Claude Code-credentials-<sha256(dir)[0:8]>` with it (read from the
 * 2.1.322 binary; hostd/inventory.ts knows the same) — and that item holds the claude.ai login AND every
 * MCP server's OAuth token. An install whose agents signed in to an OAuth server (the Slack MCP) under
 * the Chronos-only item would lose that sign-in on the switch, and copying keychain secrets is not
 * something Chronos does. `claudeHomeVerdict` therefore switches automatically only when nothing would be
 * lost; otherwise the default profile stays separate and the parity page offers the switch as a fix
 * that names the one-time sign-ins it costs. Once switched (automatically or by that click) the choice
 * is recorded in a daemon-only state file and never flips back on its own.
 *
 * Codex has the same shape without the keychain twist: it reads config.toml, AGENTS.md, skills and its
 * login from `$CODEX_HOME`, default `~/.codex` (https://learn.chatgpt.com/docs/config-file/config-advanced).
 * Chronos mapped CODEX_HOME to the workspace's CLAUDE profile dir, so default-profile codex agents read
 * `~/.claude/config.toml` and had no login at all. `codexHome` gives them `~/.codex` back.
 */

export type HomeOpts = {
  /** The user's home ($HOME). Tests and the isolated-HOME check pass a fixture. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the switch is recorded; defaults to `parityStateFile()`. */
  stateFile?: string;
};

export const userHome = (o: HomeOpts = {}): string => o.home ?? os.homedir();
export const defaultClaudeDir = (o: HomeOpts = {}): string => path.join(userHome(o), ".claude");
/** The global config a plain-terminal `claude` reads. */
export const ownClaudeConfig = (o: HomeOpts = {}): string => path.join(userHome(o), ".claude.json");
/** The Codex home a plain-terminal `codex` uses (CODEX_HOME unset). */
export const ownCodexHome = (o: HomeOpts = {}): string => path.join(userHome(o), ".codex");

export function isDefaultClaudeDir(dir: string | null | undefined, o: HomeOpts = {}): boolean {
  return !!dir && path.resolve(dir) === defaultClaudeDir(o);
}

/**
 * The daemon's record of the switch. Beside the code, like `.admin-token`, and in the sandbox deny list
 * (config.ts): an agent must not be able to flip which config the operator's agents run with. A test
 * run without CHRONOS_HOME gets a per-process temp file, so no test ever writes into the checkout.
 */
export function parityStateFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHRONOS_PARITY_STATE) return env.CHRONOS_PARITY_STATE;
  const underTest = env.CHRONOS_TEST === "1" || env.NODE_TEST_CONTEXT != null;
  if (underTest && !env.CHRONOS_HOME) return path.join(os.tmpdir(), `chronos-test-parity-${process.pid}.json`);
  return inRepo(".parity.json");
}

export type ParityState = {
  claude?: { mode: "own"; since: string; via: "auto" | "fix"; copied: string[]; conflicts: string[] };
};

// `o.env` carries the knobs only; where the state lives follows the process (a test run stays in tmp).
const stateFileOf = (o: HomeOpts) => o.stateFile ?? parityStateFile();

export function readParityState(o: HomeOpts = {}): ParityState {
  const s = readJsonFile(stateFileOf(o));
  return s && typeof s === "object" && !Array.isArray(s) ? (s as ParityState) : {};
}

function writeParityState(state: ParityState, o: HomeOpts): void {
  writeJsonAtomic(stateFileOf(o), state);
}

/**
 * Does this profile dir run with the person's own Claude Code home? Only ever the default dir, only once
 * the switch is recorded, and never when `CHRONOS_CLAUDE_OWN_HOME=0` (the way back, if one is needed).
 * Read on every call: it is a tiny file, and a fix applied from the Desk must reach the next spawn.
 */
export function claudeOwnHome(dir: string | null | undefined, o: HomeOpts = {}): boolean {
  if (!isDefaultClaudeDir(dir, o)) return false;
  if ((o.env ?? process.env).CHRONOS_CLAUDE_OWN_HOME === "0") return false;
  return readParityState(o).claude?.mode === "own";
}

/** The `.claude.json` claude reads for this profile — every Chronos reader and writer goes through here. */
export function claudeGlobalConfig(dir: string, o: HomeOpts = {}): string {
  return claudeOwnHome(dir, o) ? ownClaudeConfig(o) : path.join(dir, ".claude.json");
}

/** The env entry a claude spawn on this profile needs: nothing for the own home, CLAUDE_CONFIG_DIR otherwise. */
export function claudeHomeEnv(dir: string, o: HomeOpts = {}): Record<string, string> {
  return claudeOwnHome(dir, o) ? {} : { CLAUDE_CONFIG_DIR: dir };
}

/**
 * The same, applied to a whole env whose base may already carry a CLAUDE_CONFIG_DIR (a spawn built on
 * the daemon's own process.env): the own home must REMOVE an inherited one, not just not add it.
 */
export function withClaudeHome<T extends NodeJS.ProcessEnv>(base: T, dir: string, o: HomeOpts = {}): T {
  const env = { ...base };
  if (claudeOwnHome(dir, o)) delete env.CLAUDE_CONFIG_DIR;
  else (env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR = dir;
  return env;
}

/**
 * Codex's home for a profile. The default profile gets the person's own `~/.codex` — unless the only
 * Codex sign-in in sight is one an older Chronos made under `~/.claude` (CODEX_HOME=~/.claude), which the
 * switch would strand; `CHRONOS_CODEX_OWN_HOME=0` keeps the old mapping. A named profile keeps its dir.
 * Stateless on purpose: nothing Chronos writes depends on it, so there is nothing to keep consistent.
 */
export function codexHome(dir: string, o: HomeOpts = {}): string {
  if (!isDefaultClaudeDir(dir, o)) return dir;
  if ((o.env ?? process.env).CHRONOS_CODEX_OWN_HOME === "0") return dir;
  const strandedLogin = fs.existsSync(path.join(dir, "auth.json")) && !fs.existsSync(path.join(ownCodexHome(o), "auth.json"));
  return strandedLogin ? dir : ownCodexHome(o);
}

/** The env entry a codex spawn on this profile needs: nothing for `~/.codex`, CODEX_HOME otherwise. */
export function codexHomeEnv(dir: string, o: HomeOpts = {}): Record<string, string> {
  const h = codexHome(dir, o);
  return h === ownCodexHome(o) ? {} : { CODEX_HOME: h };
}

// ───────────────────────────── server definitions ─────────────────────────────

export type ServerDef = Record<string, unknown>;
type ProjectCfg = { mcpServers?: Record<string, ServerDef> } & Record<string, unknown>;
export type GlobalCfg = {
  mcpServers?: Record<string, ServerDef>;
  projects?: Record<string, ProjectCfg>;
  oauthAccount?: { accountUuid?: string } & Record<string, unknown>;
} & Record<string, unknown>;

/** Parsed JSON, or null when the file is missing or not JSON. Never throws. */
export function readJsonFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write-then-rename, mode 0600: claude rewrites these files itself, and a half-written one loses the login. */
export function writeJsonAtomic(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as any)[k])]))
      : v;

/**
 * A definition as claude would store it: `claude mcp add-json` fills in `args: []` and a missing type,
 * and an empty `env` means nothing — so `{command}` and `{type:"stdio",command,args:[]}` are one server.
 */
export function normDef(d: ServerDef): ServerDef {
  const out: ServerDef = { ...d };
  if (!out.type) out.type = out.url ? "http" : "stdio";
  if (out.type === "stdio" && out.args === undefined) out.args = [];
  for (const k of ["env", "headers"]) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) delete out[k];
  }
  return out;
}

export const sameDef = (a: ServerDef, b: ServerDef): boolean =>
  JSON.stringify(sortKeys(normDef(a))) === JSON.stringify(sortKeys(normDef(b)));

/**
 * A remote server with no credential written into its definition: claude signs in to it with OAuth and
 * keeps the token in the login's secure storage (the keychain item), not in `.claude.json` — so a copy of
 * the definition alone arrives signed out.
 */
export function needsSignIn(d: ServerDef): boolean {
  const t = String(normDef(d).type);
  if (t === "stdio" || t === "sdk") return false;
  const headers = d.headers as Record<string, unknown> | undefined;
  return !(headers && Object.keys(headers).length) && !d.headersHelper;
}

/** A definition that carries a credential of its own (header, header helper, env values). */
export function carriesCredential(d: ServerDef): boolean {
  const has = (v: unknown) => !!v && typeof v === "object" && Object.keys(v as object).length > 0;
  return has(d.headers) || !!d.headersHelper || has(d.env);
}

export type ServerRef = { name: string; project?: string };
export type MergeItem = ServerRef & { def: ServerDef };
export type MergePlan = { copy: MergeItem[]; same: ServerRef[]; conflicts: ServerRef[] };

export const refLabel = (r: ServerRef): string => (r.project ? `${r.name} (${r.project})` : r.name);

/**
 * What a merge-only copy of `from`'s servers into `to` would do — user scope and per-project (local)
 * scope. Missing → copy; identical → nothing; same name, different definition → conflict, never
 * overwritten.
 */
export function planMerge(from: GlobalCfg | null, to: GlobalCfg | null): MergePlan {
  const plan: MergePlan = { copy: [], same: [], conflicts: [] };
  const visit = (src: Record<string, ServerDef> | undefined, dst: Record<string, ServerDef> | undefined, project?: string) => {
    for (const [name, def] of Object.entries(src ?? {})) {
      if (!def || typeof def !== "object") continue;
      const cur = dst?.[name];
      const ref: ServerRef = project ? { name, project } : { name };
      if (!cur) plan.copy.push({ ...ref, def });
      else if (sameDef(cur, def)) plan.same.push(ref);
      else plan.conflicts.push(ref);
    }
  };
  visit(from?.mcpServers, to?.mcpServers);
  for (const [p, cfg] of Object.entries(from?.projects ?? {})) visit(cfg?.mcpServers, to?.projects?.[p]?.mcpServers, p);
  return plan;
}

/**
 * Apply a plan's copies to `file`, merge-only: other keys untouched, nothing deleted, a same-named entry
 * never replaced (re-checked against the file as it is NOW, not as planned). Verified by reading back.
 */
export function applyMerge(items: MergeItem[], file: string): { copied: string[]; failed: string[]; conflicts: string[] } {
  const out = { copied: [] as string[], failed: [] as string[], conflicts: [] as string[] };
  if (!items.length) return out;
  const cur = readJsonFile(file);
  // There but not a JSON object (half-written, hand-broken): never rewrite someone's config from nothing.
  const broken = cur === null ? fs.existsSync(file) : typeof cur !== "object" || Array.isArray(cur);
  if (broken) return { ...out, failed: items.map(refLabel) };
  const cfg: GlobalCfg = cur ?? {};
  const todo: MergeItem[] = [];
  for (const it of items) {
    const bucket = it.project ? cfg.projects?.[it.project]?.mcpServers : cfg.mcpServers;
    const prev = bucket?.[it.name];
    if (prev && !sameDef(prev, it.def)) out.conflicts.push(refLabel(it));
    else if (!prev) todo.push(it);
  }
  for (const it of todo) {
    if (it.project) {
      cfg.projects ??= {};
      const p = (cfg.projects[it.project] ??= { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] });
      (p.mcpServers ??= {})[it.name] = it.def;
    } else (cfg.mcpServers ??= {})[it.name] = it.def;
  }
  if (todo.length) {
    try {
      writeJsonAtomic(file, cfg);
    } catch {
      return { ...out, failed: todo.map(refLabel) };
    }
  }
  const back: GlobalCfg = readJsonFile(file) ?? {};
  for (const it of todo) {
    const got = it.project ? back.projects?.[it.project]?.mcpServers?.[it.name] : back.mcpServers?.[it.name];
    (got && sameDef(got, it.def) ? out.copied : out.failed).push(refLabel(it));
  }
  return out;
}

// ───────────────────────────── the default profile's switch ─────────────────────────────

export type AccountMatch = "same" | "none" | "different" | "signed-out";

export type ClaudeHomeVerdict = {
  mode: "own" | "separate";
  /** The Chronos-only global config (`~/.claude/.claude.json`) and the person's own (`~/.claude.json`). */
  legacyFile: string;
  ownFile: string;
  plan: MergePlan;
  /** Copies that need a one-time sign-in after the switch — the reason it is not automatic. */
  signIn: string[];
  /** The Chronos-only config's claude.ai account vs the one the person's own terminal is signed in to. */
  account: AccountMatch;
  /** Switching now loses nothing: no stranded sign-in, no other or missing account. */
  safe: boolean;
};

export function claudeHomeVerdict(o: HomeOpts = {}): ClaudeHomeVerdict {
  const legacyFile = path.join(defaultClaudeDir(o), ".claude.json");
  const ownFile = ownClaudeConfig(o);
  const legacy: GlobalCfg | null = readJsonFile(legacyFile);
  const own: GlobalCfg | null = readJsonFile(ownFile);
  const plan = planMerge(legacy, own);
  const signIn = plan.copy.filter((c) => needsSignIn(c.def)).map(refLabel);
  const lu = legacy?.oauthAccount?.accountUuid;
  const ou = own?.oauthAccount?.accountUuid;
  const account: AccountMatch = !lu ? "none" : !ou ? "signed-out" : lu === ou ? "same" : "different";
  return {
    mode: claudeOwnHome(defaultClaudeDir(o), o) ? "own" : "separate",
    legacyFile,
    ownFile,
    plan,
    signIn,
    account,
    safe: signIn.length === 0 && (account === "none" || account === "same"),
  };
}

export type SwitchResult = {
  ok: boolean;
  copied: string[];
  conflicts: string[];
  /** One-time sign-ins the switch costs: `claude mcp login <name>` in a terminal. */
  signIn: string[];
  error?: string;
};

/**
 * Run the default profile with the person's own Claude Code home from now on: copy the servers only the
 * Chronos-only config has (fff, slack, … — merge-only) into `~/.claude.json`, then record the switch.
 * Nothing is recorded unless every copy landed, so a failed copy never strands an agent without a server.
 */
export function switchClaudeHome(via: "auto" | "fix", o: HomeOpts = {}): SwitchResult {
  const v = claudeHomeVerdict(o);
  if (v.mode === "own") return { ok: true, copied: [], conflicts: [], signIn: [] };
  const r = applyMerge(v.plan.copy, v.ownFile);
  const conflicts = [...v.plan.conflicts.map(refLabel), ...r.conflicts];
  if (r.failed.length) return { ok: false, copied: r.copied, conflicts, signIn: v.signIn, error: `could not copy ${r.failed.join(", ")} into ${v.ownFile}` };
  writeParityState({ ...readParityState(o), claude: { mode: "own", since: new Date().toISOString(), via, copied: r.copied, conflicts } }, o);
  return { ok: true, copied: r.copied, conflicts, signIn: v.signIn };
}

export type PrepareResult =
  | { action: "own"; detail: string }
  | { action: "switched"; detail: string; result: SwitchResult }
  | { action: "separate"; detail: string; verdict: ClaudeHomeVerdict };

/**
 * Boot: switch the default profile to the person's own home when that loses nothing (a fresh install
 * always qualifies), else leave it as it was and say why. Synchronous file work only — no CLI is run —
 * so it is done before the first terminal is revived and no spawn ever sees a half-made switch.
 */
export function prepareClaudeHome(o: HomeOpts = {}): PrepareResult {
  if ((o.env ?? process.env).CHRONOS_CLAUDE_OWN_HOME === "0") {
    const verdict = claudeHomeVerdict(o);
    return { action: "separate", detail: "CHRONOS_CLAUDE_OWN_HOME=0 — the default profile keeps its separate config", verdict };
  }
  const v = claudeHomeVerdict(o);
  if (v.mode === "own") return { action: "own", detail: `default profile uses ${v.ownFile}` };
  if (!v.safe) {
    const why = v.signIn.length
      ? `${v.signIn.join(", ")} would need a new sign-in`
      : v.account === "signed-out"
        ? "your own Claude Code is not signed in"
        : "your own Claude Code is signed in to another account";
    return { action: "separate", detail: `default profile keeps ${v.legacyFile} (${why}) — see /api/setup/parity`, verdict: v };
  }
  const result = switchClaudeHome("auto", o);
  return result.ok
    ? { action: "switched", detail: `default profile now uses ${v.ownFile}${result.copied.length ? ` (copied ${result.copied.join(", ")})` : ""}`, result }
    : { action: "separate", detail: `default profile keeps ${v.legacyFile}: ${result.error}`, verdict: v };
}

/**
 * The daemon decides each spawn's config dir itself; one it inherited (started from a shell that exports
 * CLAUDE_CONFIG_DIR, or from inside an agent's terminal) must never leak into a spawn built on
 * process.env — with the own home, an inherited value would silently pick another account.
 */
export function dropInheritedClaudeHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const had = env.CLAUDE_CONFIG_DIR ?? null;
  delete env.CLAUDE_CONFIG_DIR;
  return had;
}
