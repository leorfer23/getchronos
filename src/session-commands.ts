/**
 * What `/` can offer one terminal beyond its CLI's built-ins (cli-commands.ts): the skills, custom
 * commands, plugin commands and MCP servers that session would load — names, descriptions and where
 * each came from. Never a file's body past its frontmatter, never a config value.
 *
 * Read off disk where each CLI's docs say it reads them (checked against the versions in
 * cli-commands.ts), behind the walls the session's own sandbox keeps:
 *  - a link found while scanning is followed only into the profile itself, the session's project and
 *    workspace roots, the CLI's own documented homes, and the parts of the operator's ~/.claude a client
 *    profile may read (sandbox.ts CLAUDE_HOME_SHARED and the entries linked from them — the set PR #114
 *    allows); ~/.codex only from his own default profile;
 *  - never into another workspace's places (store/workspaces.ts isolationDenyDirs), even inside one of
 *    those — so a link a client's agent plants in its own profile cannot turn this list into a way to
 *    read another client's skill names;
 *  - a plugin is read only from an install inside the profile (or the workspace's own checkout), and
 *    nothing inside a plugin is followed out of it.
 * Every read is bounded (entries per dir, depth, the first few KB of a file).
 */
import fs from "node:fs";
import path from "node:path";
import { claudeSharedDirs } from "./sandbox.js";
import { isDefaultClaudeDir, readJsonFile } from "./parity-env.js";

export type Group = "builtin" | "skill" | "command" | "plugin";

export type Item = {
  group: Group;
  /** What the list shows after the slash: `compact`, `frontend:component`, `tools:lint`. */
  name: string;
  /** The exact text dropped into the composer: `/compact `, `/tools:lint `, `$pdf ` (codex skills). */
  insert: string;
  desc: string;
  /** Argument hint, when the source declares one: `[instructions]`, `<env>`. */
  hint?: string;
  /** Skills and commands: "user" (the profile / the person's home) or "project" (the checkout); plugin items: the plugin. */
  from?: string;
  /** A built-in whose result shows only in the raw terminal: a picker, a dialog, a grid. */
  opens?: "terminal";
};

export type Scan = { items: Item[]; plugins: string[]; mcp: string[] };

// ───────────────────────────── bounds ─────────────────────────────

/** Entries read from one directory; more than this in a skills dir is not a menu anyone scrolls. */
const MAX_ENTRIES = 400;
/** Bytes of a SKILL.md / command file read for its frontmatter. */
const HEAD_BYTES = 8 * 1024;
/** Bytes of a TOML config read for its server names. */
const CONFIG_BYTES = 256 * 1024;
/** Levels of subdirectories under a commands dir (`commands/a/b/c.md`). */
const MAX_DEPTH = 3;
/** Items one session may list in all. */
const MAX_ITEMS = 1500;

// ───────────────────────────── frontmatter ─────────────────────────────

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\n/g, " ");
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/**
 * The top-level scalars of a markdown file's `---` frontmatter, keys lowercased. Lenient on purpose:
 * these files are written by anyone (plugins, other people's skills), so a block scalar (`>`/`|`), an
 * indented continuation or a nested map must never throw — a nested map's own lines are skipped.
 * Not YAML; only the handful of keys a menu needs are ever looked at.
 */
export function frontmatter(text: string): Record<string, string> {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  const more = (j: number) => j < lines.length && (lines[j].trim() === "" || /^[ \t]+\S/.test(lines[j]));
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = (kv[2] ?? "").trim();
    if (/^[>|][+-]?\d*$/.test(val)) {
      const parts: string[] = [];
      while (more(i + 1)) parts.push(lines[++i].trim());
      val = parts.join(val.startsWith(">") ? " " : "\n").trim();
    } else if (val) {
      // A plain or quoted scalar may wrap onto indented lines.
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]) && !/^[ \t]+[\w-]+[ \t]*:(\s|$)/.test(lines[i + 1])) val += " " + lines[++i].trim();
      val = unquote(val);
    } else {
      // `key:` alone opens a map or a list: its indented lines belong to it, not to the next key.
      while (more(i + 1)) i++;
    }
    if (!(key in out)) out[key] = val;
  }
  return out;
}

/** One line, at most `n` characters — descriptions are shown, never trusted as markup. */
export const oneLine = (s: unknown, n = 240): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/** A name a person can type after a slash: no spaces, no control or markup characters. */
export const cleanName = (s: unknown): string | null => {
  const t = String(s ?? "").trim();
  return /^[\w][\w.:@+-]{0,99}$/.test(t) ? t : null;
};

/** Path segments as one name (`["frontend","component"]` → `frontend:component`), every segment clean, or null. */
export const joinName = (segs: string[], sep: string): string | null => {
  const parts = segs.map(cleanName);
  return parts.length && parts.every(Boolean) ? (parts as string[]).join(sep) : null;
};

// ───────────────────────────── walls ─────────────────────────────

export type Walls = { allow: string[]; deny: string[] };

const real = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
export const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Walls for one scan. `own` are the session's own places (its profile, its cwd): a deny entry that
 * holds one of them is dropped, as the sandbox re-grants them after its deny; one nested inside them
 * stays. An allow root that would open everything — `/`, $HOME or anything above it — is dropped too.
 */
export function makeWalls(o: { home: string; allow: string[]; deny: string[]; own?: string[] }): Walls {
  const home = real(o.home) ?? path.resolve(o.home);
  const allow = [...new Set(o.allow.map(real).filter((r): r is string => !!r && r !== path.parse(r).root && !within(home, r)))];
  const own = (o.own ?? []).map((p) => real(p) ?? path.resolve(p));
  const deny = [...new Set(o.deny.filter(Boolean).map((d) => real(d) ?? path.resolve(d)))].filter((d) => !own.some((x) => within(x, d)));
  return { allow, deny };
}

/** The real path of `p` when the walls let a scan read it, else null. */
export function admits(w: Walls, p: string): string | null {
  const r = real(p);
  if (!r) return null;
  if (!w.allow.some((a) => within(r, a))) return null;
  if (w.deny.some((d) => within(r, d))) return null;
  return r;
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * The operator-shared part of ~/.claude a client profile may read (PR #114, sandbox.ts claudeHomeWall):
 * the shared dirs themselves and, one level in, wherever their per-entry links point (a skill linked
 * in from ~/.agents/skills is read through ~/.claude/skills by every profile that links it).
 */
export function operatorShared(home: string, extra?: string[]): string[] {
  const dir = path.join(home, ".claude");
  const out: string[] = [];
  for (const s of claudeSharedDirs(dir, extra)) {
    const p = path.join(dir, s);
    const r = real(p);
    if (!r) continue;
    out.push(r);
    for (const e of listDir(p)) if (e.isSymbolicLink()) {
      const t = real(path.join(p, e.name));
      if (t) out.push(t);
    }
  }
  return out;
}

/** The first bytes of a file the walls admit (opened by its real path), or null. */
export function head(file: string, walls: Walls, max = HEAD_BYTES): string | null {
  const r = admits(walls, file);
  if (!r) return null;
  let fd: number | null = null;
  try {
    const st = fs.statSync(r);
    if (!st.isFile()) return null;
    fd = fs.openSync(r, "r");
    const buf = Buffer.alloc(Math.min(max, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

/** A JSON file the walls admit, or null. Callers only ever take named keys out of it. */
function json(file: string, walls: Walls): any {
  const r = admits(walls, file);
  return r ? readJsonFile(r) : null;
}

const keysOf = (v: unknown): string[] => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : []);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ───────────────────────────── generic scanners ─────────────────────────────

export type Found = { name: string; desc: string; hint?: string };
type SkillNamer = (fm: Record<string, string>, dirName: string) => string | null;

/** The name most CLIs give a skill: its frontmatter `name`, else its directory's. */
export const skillName: SkillNamer = (fm, dir) => cleanName(fm.name) ?? cleanName(dir);

/** `<dir>/<name>/SKILL.md` → one entry per skill a person may invoke (`user-invocable: false` is left out). */
export function scanSkills(dir: string, walls: Walls, named: SkillNamer = skillName): Found[] {
  const out: Found[] = [];
  if (!admits(walls, dir)) return out;
  for (const e of listDir(dir)) {
    if (e.name.startsWith(".")) continue;
    const md = head(path.join(dir, e.name, "SKILL.md"), walls);
    if (md === null) continue;
    const fm = frontmatter(md);
    if (/^(false|no)$/i.test(fm["user-invocable"] ?? "")) continue;
    const name = named(fm, e.name);
    if (!name) continue;
    out.push({ name, desc: oneLine(fm.description), ...(fm["argument-hint"] ? { hint: oneLine(fm["argument-hint"], 60) } : {}) });
  }
  return out;
}

/** What a command file says about itself: its frontmatter description, else the first line of its body. */
function commandFound(text: string, name: string): Found {
  const fm = frontmatter(text);
  const body = text.replace(/^\uFEFF?---[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
  const first = body.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return { name, desc: oneLine(fm.description || first.replace(/^#+\s*/, "")), ...(fm["argument-hint"] ? { hint: oneLine(fm["argument-hint"], 60) } : {}) };
}

/**
 * Markdown commands under `dir`, recursively up to `depth` levels of subdirectories (0 = flat).
 * `named(segments)` turns the path below `dir` (`["frontend", "component"]`) into the CLI's name for it.
 */
export function scanCommandFiles(dir: string, walls: Walls, named: (segs: string[]) => string | null, depth = MAX_DEPTH): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  const walk = (d: string, segs: string[]) => {
    const r = admits(walls, d);
    if (!r || seen.has(r)) return; // outside the walls, a link loop, or a dir reached twice
    seen.add(r);
    for (const e of listDir(d)) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        const t = admits(walls, p);
        if (!t) continue;
        try { isDir = fs.statSync(t).isDirectory(); } catch { continue; }
      }
      if (isDir) {
        if (segs.length < depth) walk(p, [...segs, e.name]);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const text = head(p, walls);
      const name = text === null ? null : named([...segs, e.name.slice(0, -3)]);
      if (name) out.push(commandFound(text!, name));
    }
  };
  walk(dir, []);
  return out;
}

/**
 * The project dirs a CLI reads `.claude/` (or `.agents/`, `.grok/`, …) from for a session in `cwd`:
 * `cwd`, then each parent up to the repository root — the first dir holding `.git` — and never $HOME
 * or above it. No repository in sight: `cwd` alone.
 */
export function projectDirs(cwd: string | null, home: string): string[] {
  if (!cwd) return [];
  const realHome = real(home) ?? path.resolve(home);
  const start = real(cwd) ?? path.resolve(cwd);
  const out: string[] = [];
  let d = start;
  for (let i = 0; i < 12; i++) {
    if (d === realHome || within(realHome, d)) break; // $HOME's own dotfiles are the user level, not a project
    out.push(d);
    if (fs.existsSync(path.join(d, ".git"))) return out;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out.length ? [out[0]] : [];
}

/** Items in, duplicates by group and name out — the first one wins, so callers pass sources in the CLI's precedence order. */
export function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const it of items) {
    const k = `${it.group === "builtin" ? "b" : "x"}:${it.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export const asItems = (found: Found[], group: Group, insert: (name: string) => string, from?: string): Item[] =>
  found.map((f) => ({ group, name: f.name, insert: insert(f.name), desc: f.desc, ...(f.hint ? { hint: f.hint } : {}), ...(from ? { from } : {}) }));

const slash = (n: string) => `/${n} `;
const dollar = (n: string) => `$${n} `;

// ───────────────────────────── claude ─────────────────────────────

export type ClaudeScope = {
  home: string;
  /** The profile dir the session runs on (CLAUDE_CONFIG_DIR, or ~/.claude on the person's own home). */
  profileDir: string;
  /** The session's project: its cwd up to the repository root (projectDirs). Empty for a remote terminal. */
  project: string[];
  /** The workspace's own places: its repos (owned and shared in), its landing dir, the session's worktree. */
  workspaceRoots: string[];
  /** Places this session may not read: other workspaces' (isolationDenyDirs) and the protected dirs. */
  deny: string[];
  /** The global config claude reads for this profile (parity-env.ts claudeGlobalConfig). */
  globalConfig: string;
  /** The session's cwd as the CLI was started in it: the key its project entry has in the global config. */
  cwd?: string | null;
  /** CHRONOS_CLAUDE_SHARED_EXTRA, as config.ts reads it. */
  extra?: string[];
  /** MCP servers this workspace keeps out of its terminals (lean-prompt.ts desk.mcp_deny): never loaded, never listed. */
  mcpDeny?: string[];
  /** Every name the CLI itself answers to — a synced claude.ai skill takes its bare name only when none of these has it. */
  reserved?: string[];
  /** Managed settings outside the profile (macOS: /Library/Application Support/ClaudeCode/managed-settings.json). */
  managedSettings?: string | null;
};

/**
 * Claude Code's skills and commands, in its precedence order so a name defined twice shows once:
 * personal skills over project skills, a skill over a command of the same name. A command in a
 * subdirectory is `/dir:name`; a skill turned "off" in settings (`skillOverrides`) is not on the menu.
 * code.claude.com/docs/en/skills, /commands, /plugins-reference.
 */
export function scanClaude(sc: ClaudeScope): Scan {
  const walls = makeWalls({
    home: sc.home,
    allow: [sc.profileDir, ...sc.project, ...sc.workspaceRoots, ...operatorShared(sc.home, sc.extra)],
    deny: sc.deny,
    own: [sc.profileDir, ...sc.project],
  });
  const settings = claudeSettings(sc);
  const commandName = (segs: string[]) => joinName(segs, ":");
  const skills = [...asItems(scanSkills(path.join(sc.profileDir, "skills"), walls), "skill", slash, "user")];
  for (const d of sc.project) skills.push(...asItems(scanSkills(path.join(d, ".claude", "skills"), walls), "skill", slash, "project"));
  const commands = [...asItems(scanCommandFiles(path.join(sc.profileDir, "commands"), walls, commandName), "command", slash, "user")];
  for (const d of sc.project) commands.push(...asItems(scanCommandFiles(path.join(d, ".claude", "commands"), walls, commandName), "command", slash, "project"));
  const shown = skills.filter((s) => settings.overrides.get(s.name) !== "off");
  const skillNames = new Set(shown.map((s) => s.name));
  const own = [...shown, ...commands.filter((c) => !skillNames.has(c.name) && settings.overrides.get(c.name) !== "off")];
  const synced = syncedSkills(sc, walls, new Set([...own.map((i) => i.name), ...(sc.reserved ?? [])])).filter((s) => settings.overrides.get(s.name) !== "off");
  const plugins = claudePlugins(sc, settings.enabled);
  const items = dedupe([...own, ...synced, ...plugins.items]);
  const deny = new Set(sc.mcpDeny ?? []);
  const mcp = [...new Set([...claudeMcp(sc, walls), ...plugins.mcp])].filter((n) => !deny.has(n)).sort();
  return { items, plugins: plugins.names, mcp };
}

/** Every settings file for this session, lowest precedence first: user, project (repository root → cwd), local, managed. */
function claudeSettingsFiles(sc: ClaudeScope): string[] {
  const out = [path.join(sc.profileDir, "settings.json")];
  for (const d of [...sc.project].reverse()) out.push(path.join(d, ".claude", "settings.json"));
  for (const d of [...sc.project].reverse()) out.push(path.join(d, ".claude", "settings.local.json"));
  out.push(path.join(sc.profileDir, "remote-settings.json")); // the organisation's, synced by claude: above the person's own
  if (sc.managedSettings) out.push(sc.managedSettings);
  return out;
}

/** `enabledPlugins` and `skillOverrides` merged across the settings files — the higher-precedence one wins per key. */
function claudeSettings(sc: ClaudeScope): { enabled: Map<string, boolean>; overrides: Map<string, string> } {
  const walls = makeWalls({ home: sc.home, allow: [sc.profileDir, ...sc.project, ...(sc.managedSettings ? [sc.managedSettings] : [])], deny: sc.deny, own: [sc.profileDir, ...sc.project] });
  const enabled = new Map<string, boolean>();
  const overrides = new Map<string, string>();
  for (const f of claudeSettingsFiles(sc)) {
    const j = json(f, walls);
    if (isMap(j?.enabledPlugins)) for (const [k, v] of Object.entries(j.enabledPlugins)) enabled.set(k, v === true);
    if (isMap(j?.skillOverrides)) for (const [k, v] of Object.entries(j.skillOverrides)) if (typeof v === "string") overrides.set(k, v);
  }
  return { enabled, overrides };
}

/**
 * The claude.ai skills synced into this profile (`skills/synced/<org>_<account>/<name>`): only the
 * bucket of the account the profile is signed in to now. Named `/<name>` when nothing else has that
 * name, `/anthropic-skills:<name>` when something does.
 */
function syncedSkills(sc: ClaudeScope, walls: Walls, taken: Set<string>): Item[] {
  const cfgWalls = makeWalls({ home: sc.home, allow: [sc.globalConfig, sc.profileDir], deny: sc.deny, own: [sc.profileDir] });
  const oa = json(sc.globalConfig, cfgWalls)?.oauthAccount;
  const account = typeof oa?.accountUuid === "string" ? oa.accountUuid : "";
  const org = typeof oa?.organizationUuid === "string" ? oa.organizationUuid : "";
  if (!/^[\w-]+$/.test(account) || !/^[\w-]+$/.test(org)) return [];
  const bucket = path.join(sc.profileDir, "skills", "synced", `${org}_${account}`);
  return asItems(scanSkills(bucket, walls, (fm, d) => {
    const n = skillName(fm, d);
    return !n ? null : taken.has(n) ? `anthropic-skills:${n}` : n;
  }), "skill", slash, "claude.ai");
}

type PluginEntry = { scope?: string; installPath?: string; projectPath?: string };

/**
 * Plugins and what they add. A plugin counts when a settings file enables it, or when it is installed
 * for this session's scope and no settings file mentions it (its manifest's `defaultEnabled`, true by
 * default). Read only from an install inside the profile or the workspace's own checkout; nothing inside
 * a plugin is followed out of its directory. Named under the manifest's `name`: `/<plugin>:<skill>`,
 * `/<plugin>:<command>` (`commands/db/migrate.md` → `/<plugin>:db:migrate`). A manifest `commands` entry
 * replaces the default `commands/` scan; a `skills` entry adds to `skills/`.
 */
export function claudePlugins(sc: ClaudeScope, enabled: Map<string, boolean>): { items: Item[]; names: string[]; mcp: string[] } {
  const out = { items: [] as Item[], names: [] as string[], mcp: [] as string[] };
  const profileWalls = makeWalls({ home: sc.home, allow: [sc.profileDir], deny: sc.deny, own: [sc.profileDir] });
  const raw = json(path.join(sc.profileDir, "plugins", "installed_plugins.json"), profileWalls)?.plugins;
  const installed: Record<string, unknown> = isMap(raw) ? raw : {};
  const installWalls = makeWalls({ home: sc.home, allow: [sc.profileDir, ...sc.workspaceRoots, ...sc.project], deny: sc.deny, own: [sc.profileDir, ...sc.project] });
  const projectReal = new Set(sc.project.map((d) => real(d) ?? d));
  const ids = [...new Set([...Object.keys(installed), ...enabled.keys()])].sort();
  for (const id of ids) {
    const said = enabled.get(id);
    if (said === false) continue;
    const r = installed[id];
    const entries = (Array.isArray(r) ? r : r ? [r] : []).filter((e: unknown): e is PluginEntry => isMap(e));
    const pick =
      entries.find((e) => e.projectPath && projectReal.has(real(e.projectPath) ?? e.projectPath)) ??
      entries.find((e) => !e.projectPath);
    if (!pick || typeof pick.installPath !== "string") continue;
    const dir = admits(installWalls, pick.installPath);
    if (!dir) continue;
    const inside = makeWalls({ home: sc.home, allow: [dir], deny: sc.deny });
    const manifest = json(path.join(dir, ".claude-plugin", "plugin.json"), inside) ?? {};
    if (said === undefined && manifest.defaultEnabled === false) continue;
    const name = cleanName(manifest.name) ?? cleanName(id.split("@")[0]);
    if (!name) continue;
    out.names.push(name);
    const ns = (n: string | null) => (n ? `${name}:${n}` : null);
    const add = (found: Found[]) => out.items.push(...asItems(found, "plugin", slash, name));
    const paths = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    // Skills: skills/ plus whatever the manifest adds; a path holding a SKILL.md is one skill.
    for (const p of [path.join(dir, "skills"), ...paths(manifest.skills).map((s) => path.resolve(dir, s))]) {
      const own = head(path.join(p, "SKILL.md"), inside);
      if (own !== null) {
        const fm = frontmatter(own);
        const n = ns(skillName(fm, p === dir ? name : path.basename(p)));
        if (n && !/^(false|no)$/i.test(fm["user-invocable"] ?? "")) add([{ name: n, desc: oneLine(fm.description) }]);
      } else add(scanSkills(p, inside, (fm, d) => ns(skillName(fm, d))));
    }
    // Commands: the manifest's own (paths, or a map of name → { description, argumentHint }), else commands/.
    const cm = manifest.commands;
    if (isMap(cm)) {
      for (const [k, v] of Object.entries(cm)) {
        const n = ns(cleanName(k));
        if (n) add([{ name: n, desc: oneLine(isMap(v) ? v.description : ""), ...(isMap(v) && typeof v.argumentHint === "string" ? { hint: oneLine(v.argumentHint, 60) } : {}) }]);
      }
    } else {
      for (const p of cm !== undefined ? paths(cm).map((c) => path.resolve(dir, c)) : [path.join(dir, "commands")]) {
        if (p.endsWith(".md")) {
          const text = head(p, inside);
          const n = text === null ? null : ns(cleanName(path.basename(p, ".md")));
          if (n) add([commandFound(text!, n)]);
        } else add(scanCommandFiles(p, inside, (segs) => ns(joinName(segs, ":"))));
      }
    }
    // Its MCP servers: `.mcp.json` at its root, or the manifest's own (inline, or a path to a file).
    out.mcp.push(...keysOf(json(path.join(dir, ".mcp.json"), inside)?.mcpServers));
    const m = manifest.mcpServers;
    if (typeof m === "string") out.mcp.push(...keysOf(json(path.resolve(dir, m), inside)?.mcpServers));
    else out.mcp.push(...keysOf(m));
  }
  return out;
}

/** MCP servers by name: user scope, local scope (this project in the global config) and the project's `.mcp.json`. */
function claudeMcp(sc: ClaudeScope, walls: Walls): string[] {
  const out: string[] = [];
  const cfgWalls = makeWalls({ home: sc.home, allow: [sc.globalConfig, sc.profileDir], deny: sc.deny, own: [sc.profileDir] });
  const cfg = json(sc.globalConfig, cfgWalls);
  out.push(...keysOf(cfg?.mcpServers));
  for (const d of sc.project) {
    const proj = isMap(cfg?.projects) ? cfg.projects[d] ?? (d === sc.project[0] && sc.cwd ? cfg.projects[sc.cwd] : undefined) : undefined;
    out.push(...keysOf(proj?.mcpServers));
    const off = new Set<string>(Array.isArray(proj?.disabledMcpjsonServers) ? proj.disabledMcpjsonServers : []);
    out.push(...keysOf(json(path.join(d, ".mcp.json"), walls)?.mcpServers).filter((n) => !off.has(n)));
  }
  return out;
}

// ───────────────────────────── the other CLIs ─────────────────────────────

export type SessionScope = Omit<ClaudeScope, "managedSettings"> & {
  /** Codex's home for this profile (parity-env.ts codexHome). */
  codexHome?: string;
  /** cursor-agent's config dir: the workspace's CURSOR_CONFIG_DIR, else ~/.cursor. */
  cursorDir?: string;
  /** grok's home: GROK_HOME, else ~/.grok (one account for every workspace). */
  grokHome?: string;
  /** opencode's config dir: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. */
  opencodeDir?: string;
};

/** One directory a CLI reads skills or commands from. */
type Src = { dir: string; kind: "skills" | "commands"; from: "user" | "project"; depth?: number; sep?: string };

/** Sources in the CLI's precedence order → items, a dir reached twice (by a link, or as cwd and root) read once. */
function scanSources(srcs: Src[], walls: Walls, insert: (n: string) => string): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const s of srcs) {
    const r = real(s.dir);
    if (!r || seen.has(s.kind + "\0" + r)) continue;
    seen.add(s.kind + "\0" + r);
    if (s.kind === "skills") out.push(...asItems(scanSkills(s.dir, walls), "skill", insert, s.from));
    else out.push(...asItems(scanCommandFiles(s.dir, walls, (segs) => joinName(segs, s.sep ?? ":"), s.depth ?? MAX_DEPTH), "command", insert, s.from));
  }
  return out;
}

/** A skill beats a command of the same name in every CLI that has both. */
function skillsFirst(items: Item[]): Item[] {
  const skills = new Set(items.filter((i) => i.group === "skill").map((i) => i.name));
  return dedupe(items.filter((i) => i.group !== "command" || !skills.has(i.name)));
}

/**
 * Walls for a non-claude CLI: `own` is its home (the session's own place), `reads` the other homes its docs
 * say it reads; plus the project, the workspace, the operator-shared ~/.claude — and never ~/.codex from a
 * client's profile (sandbox.ts claudeHomeWall), even where the CLI's docs list a dir inside it.
 */
function otherWalls(sc: SessionScope, own: string, reads: string[]): Walls {
  const mine = isDefaultClaudeDir(sc.profileDir, { home: sc.home });
  return makeWalls({
    home: sc.home,
    allow: [own, ...reads, ...sc.project, ...sc.workspaceRoots, ...operatorShared(sc.home, sc.extra)],
    deny: [...sc.deny, ...(mine ? [] : [path.join(sc.home, ".codex")])],
    own: [own, ...sc.project],
  });
}

const tomlServers = (text: string | null): string[] =>
  [...String(text ?? "").matchAll(/^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z0-9_-]+))[ \t]*[\].]/gm)].map((m) => m[1] ?? m[2] ?? m[3]);

/**
 * Codex 0.144.1: skills only, invoked as `$name` — `.agents/skills` from the cwd up to the repository root,
 * the project's `.codex/skills`, `~/.agents/skills`, `$CODEX_HOME/skills` (kept for older setups) and its
 * bundled `.system` ones, `/etc/codex/skills`. Custom prompts (`/prompts:name`) are gone from this version's
 * source. MCP servers from `$CODEX_HOME/config.toml`. learn.chatgpt.com/docs/build-skills.md.
 */
export function scanCodex(sc: SessionScope): Scan {
  const ch = sc.codexHome ?? path.join(sc.home, ".codex");
  const agents = path.join(sc.home, ".agents", "skills");
  const walls = otherWalls(sc, ch, [agents, "/etc/codex/skills"]);
  const srcs: Src[] = [
    ...sc.project.flatMap((d): Src[] => [{ dir: path.join(d, ".agents", "skills"), kind: "skills", from: "project" }, { dir: path.join(d, ".codex", "skills"), kind: "skills", from: "project" }]),
    { dir: agents, kind: "skills", from: "user" },
    { dir: path.join(ch, "skills"), kind: "skills", from: "user" },
    { dir: path.join(ch, "skills", ".system"), kind: "skills", from: "user" },
    { dir: "/etc/codex/skills", kind: "skills", from: "user" },
  ];
  return { items: dedupe(scanSources(srcs, walls, dollar)), plugins: [], mcp: [...new Set(tomlServers(head(path.join(ch, "config.toml"), walls, CONFIG_BYTES)))].sort() };
}

/**
 * cursor-agent: custom commands `.cursor/commands/*.md` (project) and `<config>/commands` (user) as
 * `/name`; skills from `.agents/skills`, `.cursor/skills` and the `.claude` / `.codex` ones it reads
 * for compatibility, project then user. MCP servers from `mcp.json`. cursor.com/docs/skills.md.
 */
export function scanCursor(sc: SessionScope): Scan {
  const cd = sc.cursorDir ?? path.join(sc.home, ".cursor");
  const h = sc.home;
  const walls = otherWalls(sc, cd, [path.join(h, ".agents", "skills"), path.join(h, ".codex", "skills")]);
  const srcs: Src[] = [
    ...sc.project.map((d): Src => ({ dir: path.join(d, ".cursor", "commands"), kind: "commands", from: "project", depth: 0 })),
    { dir: path.join(cd, "commands"), kind: "commands", from: "user", depth: 0 },
    ...sc.project.flatMap((d) => [".agents", ".cursor", ".claude", ".codex"].map((x): Src => ({ dir: path.join(d, x, "skills"), kind: "skills", from: "project" }))),
    ...[path.join(h, ".agents"), cd, path.join(h, ".claude"), path.join(h, ".codex")].map((x): Src => ({ dir: path.join(x, "skills"), kind: "skills", from: "user" })),
  ];
  const mcp = [path.join(cd, "mcp.json"), ...sc.project.map((d) => path.join(d, ".cursor", "mcp.json"))].flatMap((f) => keysOf(json(f, walls)?.mcpServers));
  return { items: skillsFirst(scanSources(srcs, walls, slash)), plugins: [], mcp: [...new Set(mcp)].sort() };
}

/**
 * grok (xAI's Grok Build) 1.0.x: skills and flat commands (filename = name) as `/name`, from `.grok/`
 * from the cwd up to the repository root, `~/.grok/`, the Claude Code dirs it also reads (the cwd's and
 * the person's), `.cursor/skills`, and `.agents/` at every tier. docs.x.ai/build/features/skills-plugins-marketplaces.md.
 */
export function scanGrok(sc: SessionScope): Scan {
  const gh = sc.grokHome ?? path.join(sc.home, ".grok");
  const h = sc.home;
  const walls = otherWalls(sc, gh, [path.join(h, ".agents"), path.join(h, ".cursor", "skills")]);
  const both = (d: string, from: Src["from"], cmds = true): Src[] => [
    { dir: path.join(d, "skills"), kind: "skills", from },
    ...(cmds ? [{ dir: path.join(d, "commands"), kind: "commands" as const, from, depth: 0 }] : []),
  ];
  const cwd = sc.project[0];
  const srcs: Src[] = [
    ...sc.project.flatMap((d) => both(path.join(d, ".grok"), "project")),
    ...both(gh, "user"),
    ...both(path.join(h, ".claude"), "user"),
    ...(cwd ? both(path.join(cwd, ".claude"), "project") : []),
    ...both(path.join(h, ".cursor"), "user", false),
    ...(cwd ? both(path.join(cwd, ".cursor"), "project", false) : []),
    ...sc.project.flatMap((d) => both(path.join(d, ".agents"), "project")),
    ...both(path.join(h, ".agents"), "user"),
  ];
  return { items: skillsFirst(scanSources(srcs, walls, slash)), plugins: [], mcp: [] };
}

/**
 * opencode 1.18 (V1): custom commands `{command,commands}/**\/*.md` in the config dir and `.opencode/`
 * (a subfolder is part of the name: `/frontend/component`), and skills — invoked as `/name` though its own
 * `/` list leaves them to `/skills` — from `.opencode/skills`, the config dir, `.claude/skills` and
 * `.agents/skills`. MCP servers from `opencode.json`. opencode.ai/v1/docs/commands, /skills.
 */
export function scanOpencode(sc: SessionScope): Scan {
  const od = sc.opencodeDir ?? path.join(sc.home, ".config", "opencode");
  const h = sc.home;
  const walls = otherWalls(sc, od, [path.join(h, ".agents", "skills")]);
  const cmds = (d: string, from: Src["from"]): Src[] => ["command", "commands"].map((x) => ({ dir: path.join(d, x), kind: "commands", from, sep: "/" }));
  const srcs: Src[] = [
    ...sc.project.flatMap((d) => cmds(path.join(d, ".opencode"), "project")),
    ...cmds(od, "user"),
    ...sc.project.flatMap((d) => [".opencode", ".claude", ".agents"].map((x): Src => ({ dir: path.join(d, x, "skills"), kind: "skills", from: "project" }))),
    ...[od, path.join(h, ".claude"), path.join(h, ".agents")].map((x): Src => ({ dir: path.join(x, "skills"), kind: "skills", from: "user" })),
  ];
  const mcp = [path.join(od, "opencode.json"), ...sc.project.map((d) => path.join(d, "opencode.json"))].flatMap((f) => keysOf(json(f, walls)?.mcp));
  // A command and a skill of the same name: the command is the one `/name` runs.
  const items = scanSources(srcs, walls, slash);
  const commands = new Set(items.filter((i) => i.group === "command").map((i) => i.name));
  return { items: dedupe(items.filter((i) => i.group !== "skill" || !commands.has(i.name))), plugins: [], mcp: [...new Set(mcp)].sort() };
}

const EMPTY: Scan = { items: [], plugins: [], mcp: [] };

/** Claude Code's managed settings — an administrator's, above every other settings file. */
const MANAGED_SETTINGS = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";

/** What one session's CLI would load, by its canonical backend name. A CLI with nothing on disk to read: nothing. */
export function scanForBackend(backend: string, sc: SessionScope): Scan {
  if (backend === "claude-code") return scanClaude({ ...sc, managedSettings: MANAGED_SETTINGS });
  if (backend === "codex") return scanCodex(sc);
  if (backend === "cursor-agent") return scanCursor(sc);
  if (backend === "grok") return scanGrok(sc);
  if (backend === "opencode") return scanOpencode(sc);
  return EMPTY;
}
