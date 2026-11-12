import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  carriesCredential,
  claudeGlobalConfig,
  claudeHomeVerdict,
  codexHome,
  defaultClaudeDir,
  isDefaultClaudeDir,
  needsSignIn,
  ownClaudeConfig,
  ownCodexHome,
  planMerge,
  readJsonFile,
  refLabel,
  sameDef,
  switchClaudeHome,
  userHome,
  withClaudeHome,
  type GlobalCfg,
  type HomeOpts,
  type ServerDef,
} from "./parity-env.js";

/**
 * "Same tools as your own Claude / ChatGPT": what the person's own Claude Code and Codex have, next to
 * what the agents Chronos starts will get, per profile — and the fixes that close the gap.
 *
 * Names only, never values: MCP definitions carry tokens in headers and env, so nothing here returns
 * a definition, a header, an env value, an email or an account id. Every number comes from reading the
 * files each CLI reads (parity-env.ts says which); nothing is spawned for the report, because
 * `claude mcp list` health-checks every server and takes seconds.
 *
 *  - Claude Code: user MCP servers + per-project servers (the global config), plugins (settings.json
 *    `enabledPlugins` + plugins synced from the claude.ai account), skills, CLAUDE.md, and the claude.ai
 *    connectors the account has connected (`claudeAiMcpEverConnected` — connectors come with the
 *    claude.ai sign-in, headless `-p` runs included, so they follow the login rather than any file).
 *  - Codex: `[mcp_servers.*]` in config.toml, AGENTS.md, skills, and whether the CLI is signed in; its
 *    ChatGPT apps come with a ChatGPT sign-in the same way.
 *  - Claude Desktop: the servers in claude_desktop_config.json, offered for import into Claude Code
 *    with the CLI's own non-interactive `claude mcp add-json --scope user` (`add-from-claude-desktop` is
 *    an interactive picker). Desktop extensions and Cowork plugins have no supported import; plugins and
 *    skills turned on for the claude.ai account already sync into Claude Code by themselves.
 *
 * Named profiles are separate on purpose (one client per account): reported, never synced; the only
 * thing offered is an explicit per-profile "bring over" the operator clicks, which leaves out any server
 * whose definition carries a credential of the operator's.
 */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>;

export type ParityDeps = HomeOpts & {
  /** Profile name → dir (CONFIG.profiles). */
  profiles?: Record<string, string>;
  claudeBin?: string;
  run?: Runner;
  /** claude_desktop_config.json; defaults to the macOS location. */
  desktopConfig?: string;
  platform?: string;
};

export type ClaudeSide = {
  /** The global config file and the home dir (settings, plugins, skills) this side reads. */
  config: string;
  home: string;
  mcp: string[];
  projectMcp: string[];
  plugins: string[];
  skills: number;
  instructions: boolean;
  connectors: string[];
  signedIn: boolean;
};

export type CodexSide = { home: string; mcp: string[]; skills: number; instructions: boolean; signedIn: boolean | null };

export type ProfileParity<S> = {
  profile: string;
  dir: string;
  default: boolean;
  /** own = the agents read exactly the files the person's terminal reads. */
  mode: "own" | "separate";
  yours: S;
  agents: S;
  /** The person's MCP servers the agents lack, and the reverse (servers only Chronos put there). */
  missing: string[];
  extra: string[];
  conflicts: string[];
  notes: string[];
};

export type DesktopParity = {
  config: string | null;
  servers: string[];
  importable: string[];
  alreadyThere: string[];
  conflicts: string[];
  invalid: string[];
  extensions: string[];
};

export type Fix = { id: string; label: string };

export type ParityReport = {
  /** The default profile's agents have everything the person's own Claude Code and Codex have. */
  ok: boolean;
  claude: { profiles: ProfileParity<ClaudeSide>[]; desktop: DesktopParity };
  codex: { profiles: ProfileParity<CodexSide>[] };
  fixes: Fix[];
  /** The same, as the few lines `npm run setup` and the Desk wizard print. */
  lines: string[];
};

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const nonEmpty = (p: string) => { try { return fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").trim().length > 0; } catch { return false; } };
const subdirs = (p: string) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch { return []; } };
const countSkills = (dir: string) => subdirs(dir).filter((n) => n !== "synced" && isFile(path.join(dir, n, "SKILL.md"))).length;
/** `claude mcp` accepts only these names (https://code.claude.com/docs/en/mcp — Claude Desktop import). */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

// ───────────────────────────── reading one setup ─────────────────────────────

export function claudeSide(config: string, home: string): ClaudeSide {
  const cfg: GlobalCfg = readJsonFile(config) ?? {};
  const projectMcp: string[] = [];
  for (const [p, v] of Object.entries(cfg.projects ?? {})) for (const n of Object.keys(v?.mcpServers ?? {})) projectMcp.push(`${n} (${path.basename(p)})`);
  const settings = readJsonFile(path.join(home, "settings.json")) ?? {};
  const enabled = Object.entries((settings.enabledPlugins ?? {}) as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id);
  const synced = subdirs(path.join(home, "plugins", "synced")).map((n) => `${n}@synced`);
  const ever = Array.isArray(cfg.claudeAiMcpEverConnected) ? (cfg.claudeAiMcpEverConnected as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    config,
    home,
    mcp: sorted(Object.keys(cfg.mcpServers ?? {})),
    projectMcp: sorted(projectMcp),
    plugins: sorted([...enabled, ...synced]),
    skills: countSkills(path.join(home, "skills")) + countSkills(path.join(home, "skills", "synced")),
    instructions: nonEmpty(path.join(home, "CLAUDE.md")),
    connectors: sorted(ever.map((c) => c.replace(/^claude\.ai\s+/, ""))),
    signedIn: !!cfg.oauthAccount,
  };
}

/** `[mcp_servers.<name>]` headers in a config.toml — the names only, so no TOML parser and no values. */
export function codexServerNames(toml: string): string[] {
  const out = new Set<string>();
  for (const m of toml.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[.\]]/gm)) out.add(m[1] ?? m[2] ?? m[3]);
  return sorted(out);
}

export function codexSide(home: string): CodexSide {
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch {}
  const keyring = /^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/m.test(toml);
  return {
    home,
    mcp: codexServerNames(toml),
    skills: countSkills(path.join(home, "skills")),
    instructions: nonEmpty(path.join(home, "AGENTS.override.md")) || nonEmpty(path.join(home, "AGENTS.md")),
    // auth.json is the file store; with the OS keyring a login leaves no file to see.
    signedIn: isFile(path.join(home, "auth.json")) ? true : keyring ? null : false,
  };
}

function diffServers(yours: Record<string, ServerDef>, agents: Record<string, ServerDef>) {
  const missing: string[] = [];
  const conflicts: string[] = [];
  for (const [n, def] of Object.entries(yours)) {
    if (!agents[n]) missing.push(n);
    else if (!sameDef(agents[n], def)) conflicts.push(n);
  }
  return { missing: sorted(missing), conflicts: sorted(conflicts), extra: sorted(Object.keys(agents).filter((n) => !yours[n])) };
}

const serversOf = (file: string): Record<string, ServerDef> => (readJsonFile(file) as GlobalCfg | null)?.mcpServers ?? {};

function profileEntries(d: ParityDeps): Array<[string, string]> {
  const profiles = d.profiles ?? { claude: defaultClaudeDir(d) };
  const entries = Object.entries(profiles).filter(([, dir]) => !!dir);
  if (!entries.some(([, dir]) => isDefaultClaudeDir(dir, d))) entries.unshift(["claude", defaultClaudeDir(d)]);
  // The default profile first, then the rest by name.
  return entries.sort(([an, ad], [bn, bd]) => Number(isDefaultClaudeDir(bd, d)) - Number(isDefaultClaudeDir(ad, d)) || an.localeCompare(bn));
}

// ───────────────────────────── the report ─────────────────────────────

export function claudeProfiles(d: ParityDeps = {}): ProfileParity<ClaudeSide>[] {
  const yours = claudeSide(ownClaudeConfig(d), defaultClaudeDir(d));
  const yourServers = serversOf(ownClaudeConfig(d));
  const out: ProfileParity<ClaudeSide>[] = [];
  for (const [profile, dir] of profileEntries(d)) {
    const isDefault = isDefaultClaudeDir(dir, d);
    if (!isDefault && !isDir(dir)) continue;
    const config = claudeGlobalConfig(dir, d);
    const agents = claudeSide(config, dir);
    const mode = config === ownClaudeConfig(d) ? "own" : "separate";
    const { missing, conflicts, extra } = diffServers(yourServers, serversOf(config));
    const notes: string[] = [];
    if (isDefault && mode === "separate") {
      const v = claudeHomeVerdict(d);
      if (v.account === "signed-out") notes.push("Your own Claude Code is not signed in — run `claude auth login` in a terminal, then give agents your setup.");
      else if (v.account === "different") notes.push("Your own Claude Code is signed in to a different claude.ai account than the agents' separate setup.");
      if (v.signIn.length) notes.push(`Switching costs one sign-in each for ${v.signIn.join(", ")} (\`claude mcp login <name>\` in a terminal) — the agents' sign-in for them is not carried over.`);
    }
    if (!isDefault) notes.push("A client profile: separate on purpose, never synced. Bring servers over only if this account should have them.");
    out.push({ profile, dir, default: isDefault, mode, yours, agents, missing, extra, conflicts, notes });
  }
  return out;
}

export function codexProfiles(d: ParityDeps = {}): ProfileParity<CodexSide>[] {
  const yours = codexSide(ownCodexHome(d));
  const out: ProfileParity<CodexSide>[] = [];
  for (const [profile, dir] of profileEntries(d)) {
    const isDefault = isDefaultClaudeDir(dir, d);
    const home = codexHome(dir, d);
    // A client profile shows up here only once Codex was set up in it.
    if (!isDefault && !isFile(path.join(home, "config.toml")) && !isFile(path.join(home, "auth.json"))) continue;
    const agents = codexSide(home);
    const mode = home === ownCodexHome(d) ? "own" : "separate";
    const missing = yours.mcp.filter((n) => !agents.mcp.includes(n));
    const notes: string[] = [];
    if (isDefault && mode === "separate") notes.push(`Codex is signed in only under ${home} (an older Chronos set CODEX_HOME there). Run \`codex login\` in a terminal and agents switch to your own ~/.codex.`);
    if (!isDefault) notes.push("A client profile: its own Codex home, never synced.");
    out.push({ profile, dir, default: isDefault, mode, yours, agents, missing, extra: agents.mcp.filter((n) => !yours.mcp.includes(n)), conflicts: [], notes });
  }
  return out;
}

export function desktopParity(d: ParityDeps = {}): DesktopParity {
  const platform = d.platform ?? process.platform;
  const file = d.desktopConfig ?? (platform === "darwin" ? path.join(userHome(d), "Library", "Application Support", "Claude", "claude_desktop_config.json") : null);
  const empty: DesktopParity = { config: null, servers: [], importable: [], alreadyThere: [], conflicts: [], invalid: [], extensions: [] };
  if (!file) return empty;
  const servers: Record<string, ServerDef> = readJsonFile(file)?.mcpServers ?? {};
  const target = serversOf(claudeGlobalConfig(defaultClaudeDir(d), d));
  const r: DesktopParity = { ...empty, config: isFile(file) ? file : null, servers: sorted(Object.keys(servers)) };
  for (const [n, def] of Object.entries(servers)) {
    if (!MCP_NAME_RE.test(n)) r.invalid.push(n);
    else if (!target[n]) r.importable.push(n);
    else if (sameDef(target[n], desktopDef(def))) r.alreadyThere.push(n);
    else r.conflicts.push(n);
  }
  // Extensions installed from Claude Desktop's settings (.mcpb): listed so the gap is visible — there is
  // no supported way to hand them to Claude Code.
  const extDir = path.join(path.dirname(file), "Claude Extensions");
  r.extensions = sorted(subdirs(extDir).map((id) => {
    const m = readJsonFile(path.join(extDir, id, "manifest.json"));
    return typeof m?.display_name === "string" ? m.display_name : typeof m?.name === "string" ? m.name : id;
  }));
  for (const k of ["importable", "alreadyThere", "conflicts", "invalid"] as const) r[k] = sorted(r[k]);
  return r;
}

/** A Claude Desktop entry as `claude mcp add-json` takes it: Desktop leaves the stdio type implicit. */
const desktopDef = (def: ServerDef): ServerDef => (def.type || def.url ? def : { type: "stdio", ...def });

export function parityReport(d: ParityDeps = {}): ParityReport {
  const claude = { profiles: claudeProfiles(d), desktop: desktopParity(d) };
  const codex = { profiles: codexProfiles(d) };
  const fixes: Fix[] = [];
  const def = claude.profiles.find((p) => p.default);
  if (def && def.mode === "separate") {
    const v = claudeHomeVerdict(d);
    if (v.account !== "signed-out") {
      const what = def.missing.length ? ` (${def.missing.length} MCP server${def.missing.length === 1 ? "" : "s"} they lack: ${def.missing.join(", ")})` : "";
      fixes.push({ id: "claude-own-home", label: `Give agents your own Claude Code setup${what}` });
    }
    if (def.missing.length) fixes.push({ id: "claude-bring-over:claude", label: `Copy your ${def.missing.length} MCP server${def.missing.length === 1 ? "" : "s"} into the agents' separate setup` });
  }
  for (const p of claude.profiles) {
    if (p.default || !p.missing.length) continue;
    fixes.push({ id: `claude-bring-over:${p.profile}`, label: `Copy your MCP servers into ${p.profile} (${p.missing.join(", ")})` });
  }
  if (claude.desktop.importable.length) {
    const n = claude.desktop.importable.length;
    // Lands where the default profile's agents read: the person's own Claude Code, or (still separate)
    // only the agents' copy of it — the label says which.
    const where = def?.mode === "separate" ? "the agents' Claude Code setup" : "Claude Code";
    fixes.push({ id: "claude-desktop-import", label: `Add ${n} Claude Desktop server${n === 1 ? "" : "s"} to ${where} (${claude.desktop.importable.join(", ")})` });
  }
  const codexDef = codex.profiles.find((p) => p.default);
  const ok = !!def && def.mode === "own" && (!codexDef || codexDef.mode === "own");
  const report: ParityReport = { ok, claude, codex, fixes, lines: [] };
  report.lines = parityLines(report);
  return report;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function claudeSummary(s: ClaudeSide): string {
  const bits = [plural(s.mcp.length, "MCP server"), plural(s.plugins.length, "plugin"), plural(s.skills, "skill")];
  if (s.instructions) bits.push("CLAUDE.md");
  if (s.connectors.length) bits.push(plural(s.connectors.length, "claude.ai connector"));
  return bits.join(", ");
}

/** The "Same tools as your own Claude / ChatGPT" section: a header and one line per CLI (+ Desktop). */
export function parityLines(r: ParityReport): string[] {
  const lines = ["Same tools as your own Claude / ChatGPT"];
  const fixLabel = (id: string) => r.fixes.find((f) => f.id === id)?.label;
  const def = r.claude.profiles.find((p) => p.default);
  if (def) {
    if (def.mode === "own") lines.push(`  ✓ Claude Code: agents use your own setup — ${claudeSummary(def.yours)}`);
    else {
      const gap = def.missing.length ? `lack ${plural(def.missing.length, "of your MCP server")} (${def.missing.join(", ")})` : "run on a separate copy of your setup";
      const fix = fixLabel("claude-own-home");
      lines.push(`  ! Claude Code: agents ${gap}${fix ? ` — fix in the Desk: ${fix}` : ""}`);
      for (const n of def.notes) lines.push(`    ${n}`);
    }
  }
  const cdef = r.codex.profiles.find((p) => p.default);
  if (cdef) {
    const s = cdef.agents;
    const bits = [plural(s.mcp.length, "MCP server")];
    if (s.instructions) bits.push("AGENTS.md");
    bits.push(s.signedIn === true ? "signed in" : s.signedIn === null ? "sign-in in the keychain" : "not signed in (`codex login`)");
    lines.push(cdef.mode === "own" ? `  ✓ Codex (ChatGPT): agents use your own ~/.codex — ${bits.join(", ")}` : `  ! Codex (ChatGPT): ${cdef.notes[0] ?? "agents use a separate Codex home"}`);
  }
  const dk = r.claude.desktop;
  if (dk.importable.length) lines.push(`  · Claude Desktop: ${plural(dk.importable.length, "server")} not in Claude Code yet (${dk.importable.join(", ")}) — fix in the Desk: ${fixLabel("claude-desktop-import")}`);
  else if (dk.servers.length) lines.push(`  ✓ Claude Desktop: its ${plural(dk.servers.length, "MCP server")} are in Claude Code too`);
  return lines;
}

// ───────────────────────────── fixes ─────────────────────────────

export type FixResult = { ok: boolean; id: string; done: string[]; skipped: string[]; signIn: string[]; message: string };

export const FIX_ID_RE = /^(claude-own-home|claude-desktop-import|claude-bring-over:[A-Za-z0-9._-]{1,64})$/;

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/** The env a `claude mcp …` call runs with: the bare minimum, then the profile's home on top. */
function cliEnv(dir: string, d: ParityDeps): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { HOME: userHome(d) };
  for (const k of ["PATH", "USER", "LOGNAME", "TMPDIR", "LANG"]) if (process.env[k] !== undefined) base[k] = process.env[k];
  base.LANG ??= "en_US.UTF-8";
  return withClaudeHome(base, dir, d);
}

/**
 * Add servers with the CLI's own `claude mcp add-json <name> <json> --scope user`, under the profile's
 * env so it lands in the file that profile's claude reads. Merge-only twice over: the plan never names a
 * server the target already has, and the CLI itself refuses one ("already exists"). Read back to confirm.
 */
async function addServers(dir: string, items: Array<{ name: string; def: ServerDef }>, d: ParityDeps): Promise<{ done: string[]; failed: string[] }> {
  const run = d.run ?? defaultRunner;
  const bin = d.claudeBin ?? "claude";
  const env = cliEnv(dir, d);
  const failed: string[] = [];
  for (const it of items) {
    const r = await run(bin, ["mcp", "add-json", it.name, JSON.stringify(it.def), "--scope", "user"], { cwd: userHome(d), env, timeoutMs: 30_000 });
    if (r.code !== 0) failed.push(it.name);
  }
  const back = serversOf(claudeGlobalConfig(dir, d));
  const done = items.filter((it) => back[it.name] && sameDef(back[it.name], it.def)).map((it) => it.name);
  return { done, failed: sorted([...failed, ...items.map((it) => it.name).filter((n) => !done.includes(n))]) };
}

export async function applyParityFix(id: string, d: ParityDeps = {}): Promise<FixResult> {
  const res = (ok: boolean, message: string, extra: Partial<FixResult> = {}): FixResult => ({ ok, id, done: [], skipped: [], signIn: [], message, ...extra });
  if (!FIX_ID_RE.test(id)) return res(false, "unknown fix");

  if (id === "claude-own-home") {
    const v = claudeHomeVerdict(d);
    if (v.mode === "own") return res(true, "Agents already use your own Claude Code setup.");
    if (v.account === "signed-out") return res(false, "Your own Claude Code is not signed in. Run `claude auth login` in a terminal, then try again.");
    const r = switchClaudeHome("fix", d);
    if (!r.ok) return res(false, r.error ?? "could not switch", { done: r.copied, skipped: r.conflicts, signIn: r.signIn });
    const login = r.signIn.length ? ` Sign in once to ${r.signIn.join(", ")}: \`claude mcp login <name>\` in a terminal.` : "";
    const kept = r.conflicts.length ? ` Kept your own definition of ${r.conflicts.join(", ")}.` : "";
    return res(true, `New agents now start with your own Claude Code setup.${r.copied.length ? ` Copied ${r.copied.join(", ")} into ${ownClaudeConfig(d)}.` : ""}${kept}${login}`, { done: r.copied, skipped: r.conflicts, signIn: r.signIn });
  }

  if (id === "claude-desktop-import") {
    const dk = desktopParity(d);
    if (!dk.config) return res(false, "No Claude Desktop configuration on this computer.");
    const servers: Record<string, ServerDef> = readJsonFile(dk.config)?.mcpServers ?? {};
    const items = dk.importable.map((name) => ({ name, def: desktopDef(servers[name]) }));
    if (!items.length) return res(true, "Every Claude Desktop server is already in Claude Code.", { skipped: [...dk.conflicts, ...dk.invalid] });
    const { done, failed } = await addServers(defaultClaudeDir(d), items, d);
    const skipped = sorted([...dk.conflicts, ...dk.invalid, ...failed]);
    const signIn = items.filter((it) => done.includes(it.name) && needsSignIn(it.def)).map((it) => it.name);
    return res(failed.length === 0, `Added ${done.length ? done.join(", ") : "nothing"} to Claude Code.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}`, { done, skipped, signIn });
  }

  // claude-bring-over:<profile> — the person's own user-scope servers into one profile's setup.
  const profile = id.slice("claude-bring-over:".length);
  const dir = (d.profiles ?? { claude: defaultClaudeDir(d) })[profile];
  if (!dir || !isDir(dir)) return res(false, `No profile named ${profile} on this computer.`);
  const target = claudeGlobalConfig(dir, d);
  if (target === ownClaudeConfig(d)) return res(true, "This profile already uses your own Claude Code setup.");
  const own: GlobalCfg = readJsonFile(ownClaudeConfig(d)) ?? {};
  const plan = planMerge({ mcpServers: own.mcpServers ?? {} }, readJsonFile(target));
  const client = !isDefaultClaudeDir(dir, d);
  // A client's profile never receives one of the operator's credentials by a click on a summary line.
  const withCred = client ? plan.copy.filter((c) => carriesCredential(c.def)) : [];
  const items = plan.copy.filter((c) => !withCred.includes(c));
  const { done, failed } = await addServers(dir, items, d);
  const skipped = sorted([...plan.conflicts.map(refLabel), ...withCred.map((c) => `${c.name} (carries a credential — add it by hand if this account should have it)`), ...failed]);
  const signIn = items.filter((it) => done.includes(it.name) && needsSignIn(it.def)).map((it) => it.name);
  const login = signIn.length ? ` Sign in once to ${signIn.join(", ")}: \`CLAUDE_CONFIG_DIR=${dir} claude mcp login <name>\`.` : "";
  return res(failed.length === 0, `Copied ${done.length ? done.join(", ") : "nothing"} into ${profile}.${skipped.length ? ` Skipped ${skipped.join("; ")}.` : ""}${login}`, { done, skipped, signIn });
}
