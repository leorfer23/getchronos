/**
 * Where a workspace's OWN house style already lives (house-style.ts): a dataviz, dashboard, brand or
 * report-template skill in its Claude profile (`config_dir`: its skills, the claude.ai skills synced
 * into it, its plugins' skills), or a style guide in one of its repos. Found once, registered (kv),
 * re-scanned when stale — so `mc style` and the visual critic point at what that workspace's agents
 * already load instead of a generic default.
 *
 * Read with the walls the `/` menu uses (session-commands.ts): the profile, the workspace's own repos,
 * and the operator-shared parts of ~/.claude a profile may read (a skill linked in from there is one
 * its CLI loads). Never another workspace's places (store/workspaces.ts isolationDenyDirs) — a link a
 * client's agent plants in its own profile cannot turn this into a reader of another client's files —
 * and never a repo merely shared in (it is the other workspace's). Only names, one-line descriptions
 * and paths are kept; a body is read later, by and for the same workspace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kv, repos, workspaces } from "./store.js";
import { admits, frontmatter, head, makeWalls, oneLine, operatorShared, type Walls } from "./session-commands.js";
import { CONFIG } from "./config.js";
import type { Workspace } from "./types.js";

export type StyleSource = {
  /** skill = the profile's own · plugin = a skill a plugin in the profile ships · repo-skill / repo-doc = in one of its repos. */
  kind: "skill" | "plugin" | "repo-skill" | "repo-doc";
  name: string;
  desc: string;
  /** The SKILL.md or document, as its real path. */
  path: string;
  /** Where it was found, in words: "profile", "plugin <name>", "repo <name>". */
  where: string;
};

/** Entries read from one directory, and sources kept in all: enough for any real profile, bounded for a planted one. */
const MAX_ENTRIES = 300;
const MAX_SOURCES = 8;
/** Re-scan a registration older than this (a skill installed since shows up the same day). */
export const SOURCES_TTL_MS = 6 * 3600_000;
const KV = (wsId: string) => `style.sources.${wsId}`;

// ───────────────────────────── is it style guidance? ─────────────────────────────

/** Name words that alone say "how things should look". `design` only counts beside one of PAIRED. */
const STRONG = new Set([
  "dataviz", "viz", "visualization", "visualisation", "visualizations", "visualisations", "chart", "charts", "charting",
  "graphs", "plots", "brand", "branding", "styleguide", "dashboard", "dashboards", "storytelling", "infographic",
  "infographics", "palette", "typography",
]);
const WEAK = new Set(["design", "style", "styles", "report", "reports", "template", "templates", "guide", "guidelines", "format"]);
const PAIRED = new Set(["artifact", "artifacts", "visual", "ui", "brand", "report", "reports", "dashboard", "slide", "slides", "deck", "decks", "system", "page", "pages", "house", "guide", "guidelines", "template", "templates"]);
/** What a description says when it is about look and reading, one point each. */
const DESC_HITS = [
  /\bpalettes?\b|\bcolou?rs?\b/i,
  /\btypograph|\bfonts?\b/i,
  /design (guidance|system|fundamentals|principles|rules)|style ?guide|house style/i,
  /\bbrand(ing)?\b/i,
  /visuali[sz]ation|\bvisual(ly)?\b/i,
  /\bcharts?\b|\bgraphs?\b|\bplots?\b/i,
  /storytelling|narrative/i,
  /\blayout\b|\bspacing\b|\bwhitespace\b/i,
];
/** A tool that happens to mention dashboards (publish, host, upload…) is not a style guide. */
const TOOLISH = /\b(publish|deploy|upload|install|hosting|webhooks?|connectors?|schedules?|cron|cli|api)\b/i;

const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Does a skill's name say it is about look? A strong word, or `design`/`style`/`report`… beside a paired one. */
export function nameSaysStyle(name: string): boolean {
  const t = tokensOf(name);
  if (t.some((w) => STRONG.has(w))) return true;
  const weak = t.filter((w) => WEAK.has(w));
  if (!weak.length) return false;
  // `style-guide`, `report-template`, `artifact-design`, `design-system`: two words that together mean it.
  return t.some((w) => PAIRED.has(w) && !(weak.length === 1 && weak[0] === w));
}

/** How strongly a skill's name and description say "style guidance": ≥ 2 counts (styleScore tests). */
export function styleScore(name: string, desc: string): number {
  let s = nameSaysStyle(name) ? 2 : 0;
  s += Math.min(3, DESC_HITS.filter((re) => re.test(desc)).length);
  if (TOOLISH.test(desc)) s -= 1;
  return s;
}
export const isStyleSkill = (name: string, desc: string): boolean => styleScore(name, desc) >= 2;

const DOC_EXT = /\.(md|mdx|markdown|txt)$/i;
/** A repo document is style guidance by its name — and, for the ambiguous names, by what its first lines talk about. */
export function docSaysStyle(file: string, firstLines: string | null): boolean {
  if (!DOC_EXT.test(file)) return false;
  const t = tokensOf(path.basename(file).replace(DOC_EXT, ""));
  if (t.some((w) => STRONG.has(w))) return true;
  // `STYLE.md`, `design.md`, `report-template.md`: as often about code formatting as about charts.
  if (!t.some((w) => WEAK.has(w))) return false;
  const text = String(firstLines ?? "");
  return DESC_HITS.filter((re) => re.test(text)).length >= 2;
}

// ───────────────────────────── scanning ─────────────────────────────

function entries(dir: string, walls: Walls): fs.Dirent[] {
  if (!admits(walls, dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** `<dir>/<name>/SKILL.md` whose name and description say style guidance. */
function skillsIn(dir: string, walls: Walls, kind: StyleSource["kind"], where: string): StyleSource[] {
  const out: StyleSource[] = [];
  for (const e of entries(dir, walls)) {
    if (e.name.startsWith(".")) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    const md = head(file, walls);
    if (md === null) continue;
    const fm = frontmatter(md);
    const name = oneLine(fm.name || e.name, 80);
    const desc = oneLine(fm.description, 300);
    if (!isStyleSkill(name, desc)) continue;
    const real = admits(walls, file);
    if (real) out.push({ kind, name, desc, path: real, where });
  }
  return out;
}

const readJson = (file: string, walls: Walls): any => {
  const text = head(file, walls, 256 * 1024);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** Skills shipped by plugins installed in the profile itself (an install outside it is not this profile's). */
function pluginSkills(profileDir: string, home: string, deny: string[]): StyleSource[] {
  const pw = makeWalls({ home, allow: [profileDir], deny, own: [profileDir] });
  const installed = readJson(path.join(profileDir, "plugins", "installed_plugins.json"), pw)?.plugins;
  if (!installed || typeof installed !== "object") return [];
  const enabled = readJson(path.join(profileDir, "settings.json"), pw)?.enabledPlugins ?? {};
  const out: StyleSource[] = [];
  for (const [id, raw] of Object.entries(installed as Record<string, unknown>).slice(0, 100)) {
    if (enabled && typeof enabled === "object" && (enabled as Record<string, unknown>)[id] === false) continue;
    const list = (Array.isArray(raw) ? raw : [raw]) as Array<{ installPath?: unknown; projectPath?: unknown }>;
    const pick = list.find((e) => e && typeof e.installPath === "string" && !e.projectPath);
    if (!pick) continue;
    const dir = admits(pw, String(pick.installPath));
    if (!dir) continue;
    const inside = makeWalls({ home, allow: [dir], deny });
    // Named the way the Skill tool reaches it: `<plugin>:<skill>`.
    const plugin = id.split("@")[0];
    out.push(...skillsIn(path.join(dir, "skills"), inside, "plugin", `plugin ${plugin}`).map((x) => ({ ...x, name: `${plugin}:${x.name}` })));
  }
  return out;
}

/** Where in a repo a style guide lives, one level deep each. */
const DOC_DIRS = ["", "docs", "doc", "design", "brand", "guidelines", "style", ".github"];

function repoSources(repoPath: string, repoName: string, walls: Walls): StyleSource[] {
  const out: StyleSource[] = [];
  out.push(...skillsIn(path.join(repoPath, ".claude", "skills"), walls, "repo-skill", `repo ${repoName}`));
  for (const sub of DOC_DIRS) {
    const dir = path.join(repoPath, sub);
    for (const e of entries(dir, walls)) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (!DOC_EXT.test(e.name)) continue;
      const file = path.join(dir, e.name);
      const first = head(file, walls, 4096);
      if (first === null || !docSaysStyle(e.name, first)) continue;
      const real = admits(walls, file);
      const title = /^#\s+(.+)$/m.exec(first)?.[1];
      if (real) out.push({ kind: "repo-doc", name: path.join(sub, e.name), desc: oneLine(title ?? "", 200), path: real, where: `repo ${repoName}` });
    }
  }
  return out;
}

export type DiscoverDeps = { home?: string; deny?: string[]; repos?: Array<{ path: string; name: string }> };

type Scope = { home: string; profileDir: string; deny: string[]; own: Array<{ path: string; name: string }>; walls: Walls };

/** The places one workspace's style may be read from, and the walls around them. */
function scopeOf(ws: Pick<Workspace, "id" | "config_dir">, d: DiscoverDeps): Scope {
  const home = d.home ?? os.homedir();
  const profileDir = ws.config_dir || CONFIG.profiles[CONFIG.defaultProfile] || path.join(home, ".claude");
  const deny = d.deny ?? workspaces.isolationDenyDirs(ws.id);
  const own = (d.repos ?? repos.list(ws.id).map((r) => ({ path: r.path, name: r.name }))).filter((r) => r.path && fs.existsSync(r.path));
  const walls = makeWalls({ home, allow: [profileDir, ...own.map((r) => r.path), ...operatorShared(home)], deny, own: [profileDir, ...own.map((r) => r.path)] });
  return { home, profileDir, deny, own, walls };
}

/**
 * Every style source this workspace's own profile and repos hold, best first (its own skills, then
 * its plugins', then its repos'), deduplicated by real path, at most MAX_SOURCES.
 */
export function discoverStyleSources(ws: Pick<Workspace, "id" | "config_dir">, d: DiscoverDeps = {}): StyleSource[] {
  const { home, profileDir, deny, own, walls } = scopeOf(ws, d);
  const found: StyleSource[] = [
    ...skillsIn(path.join(profileDir, "skills"), walls, "skill", "profile"),
    // claude.ai skills synced into this profile: skills/synced/<org>_<account>/<name>/SKILL.md
    ...entries(path.join(profileDir, "skills", "synced"), walls).filter((e) => e.isDirectory()).flatMap((e) =>
      skillsIn(path.join(profileDir, "skills", "synced", e.name), walls, "skill", "profile (claude.ai)")),
    ...pluginSkills(profileDir, home, deny),
    ...own.flatMap((r) => repoSources(r.path, r.name, walls)),
  ];
  const seen = new Set<string>();
  return found.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true))).slice(0, MAX_SOURCES);
}

// ───────────────────────────── the registration ─────────────────────────────

export type Registered = { at: string; sources: StyleSource[] };

/** The workspace's registered style sources — scanned now when never scanned, stale, or `rescan`. */
export function registeredSources(ws: Pick<Workspace, "id" | "config_dir">, o: { rescan?: boolean; now?: number; deps?: DiscoverDeps } = {}): Registered {
  const now = o.now ?? Date.now();
  if (!o.rescan) {
    try {
      const hit = JSON.parse(kv.get(KV(ws.id)) ?? "null") as Registered | null;
      if (hit && Array.isArray(hit.sources) && now - Date.parse(hit.at) < SOURCES_TTL_MS) return hit;
    } catch { /* re-scan */ }
  }
  let sources: StyleSource[] = [];
  try { sources = discoverStyleSources(ws, o.deps); } catch (e: any) { console.warn(`[style] discovering ${ws.id.slice(0, 8)}'s style sources: ${e?.message ?? e}`); }
  const reg: Registered = { at: new Date(now).toISOString(), sources };
  kv.set(KV(ws.id), JSON.stringify(reg));
  return reg;
}

/**
 * The bodies of registered sources (after their frontmatter), bounded, for their own workspace only.
 * A registration is a few hours old at most, but the walls are today's: each path is admitted again
 * before it is opened (a repo moved to another workspace since, a link re-pointed), or left out.
 */
export function sourceExcerpts(ws: Pick<Workspace, "id" | "config_dir">, sources: StyleSource[], max = 2500, d: DiscoverDeps = {}): Map<string, string> {
  const out = new Map<string, string>();
  if (!sources.length) return out;
  const { walls } = scopeOf(ws, d);
  for (const src of sources) {
    const text = head(src.path, walls, 64 * 1024);
    if (text === null) continue;
    const body = text.replace(/^﻿?---[\s\S]*?\r?\n---[ \t]*\r?\n?/, "").trim();
    out.set(src.path, body.length > max ? body.slice(0, max).trimEnd() + "\n…" : body);
  }
  return out;
}
