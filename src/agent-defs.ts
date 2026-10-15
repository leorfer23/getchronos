/**
 * Named-agent definitions — one directory per executive under `agents/`.
 *
 * The persona of an agent used to be a wall of template literals in `src/telegram/agent.ts`, and its
 * runtime knobs (model, tools, cwd, sandbox, env) a hand-written `new WarmManager({...})` block a few
 * hundred lines away. Nothing tied the two together, so the old Nostr identity registry
 * looked like it defined an agent while editing it changed nothing — the prompt lived elsewhere.
 *
 * Here the DIRECTORY is the agent. `agents/robert/AGENT.md` declares Robert: frontmatter for the knobs,
 * body for the prompt, and the directory name is the id — no `id:` field to keep in sync. Prose that
 * several agents share (the API catalog, the peer directory) lives once in `agents/_blocks/` and is
 * pulled in with a `{{> name}}` line, which is what keeps the catalogs from drifting apart.
 *
 * Layout:
 *   agents/_blocks/<name>.md   shared prose, included verbatim
 *   agents/<id>/AGENT.md       frontmatter + the "default" surface prompt
 *   agents/<id>/<surface>.md   an additional named surface (Robert: telegram / web)
 *
 * Files are read at call time and re-read when their mtime moves, so editing a persona takes effect
 * on the next manager recycle without a rebuild — `dist/` never contains a copy of the prompt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import type { SandboxMode } from "./sandbox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENTS_DIR = path.join(ROOT, "agents");
const blocksDir = (root: string) => path.join(root, "_blocks");

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  /**
   * Key of this agent's durable memory file (src/agent-memory.ts). Defaults to the id. It is allowed
   * to differ: renaming an agent whose memory was written under the old key would silently orphan
   * everything it has learned, so the key can stay put while the id moves.
   */
  memory: string;
  /**
   * Per-agent ceiling for the always-injected memory (src/memory-budget.ts), from frontmatter
   * `memory_budget`. null → CONFIG.memoryBudgetTokens.
   */
  memoryBudget: number | null;
  /** null → the caller's default (CONFIG.agent.voiceModel). */
  model: string | null;
  /** --allowed-tools string, or null for the WarmManager default. */
  tools: string | null;
  /**
   * The interpolated contents of `agents/_mcp/<name>.json` — passed verbatim to `--mcp-config`,
   * which takes a JSON string as happily as a path. A string, not a path, because the file names
   * the repo's own `node_modules` and every machine puts the checkout somewhere else: the committed
   * file says `{{repo}}` and the value handed to the CLI is already resolved.
   * null → the agent gets no MCP servers at all (`--strict-mcp-config` with nothing to load).
   */
  mcp: string | null;
  cwd: string | null;
  sandbox: SandboxMode | null;
  env: Record<string, string>;
  /** surface name → composed system prompt. "default" is AGENT.md's body. */
  surfaces: Record<string, string>;
}

// ───────────────────────────── interpolation ─────────────────────────────

/**
 * The only values a persona file may reach for. Deliberately a closed list: a prompt is data, and a
 * prompt that could name any env var would be a way to read the daemon's secrets into a model's
 * context. `{{admin_token}}` is here for frontmatter `env:` only — no persona body needs it.
 */
function vars(): Record<string, string> {
  return {
    port: String(CONFIG.port),
    year: String(new Date().getFullYear()),
    panel_min_difficulty: String(CONFIG.panelMinDifficulty),
    repo: ROOT,
    home: os.homedir(),
    admin_token: CONFIG.adminToken,
    "env.PATH": process.env.PATH ?? "",
  };
}

// Uppercase belongs in this class. The vars map above has an `env.PATH` key, and a lowercase-only
// name pattern simply did not match `{{env.PATH}}` — so the loud unknown-placeholder throw below
// never fired and the literal shipped: an executive spawned with PATH=~/.mc/bin:{{env.PATH}} and every one
// of her runs died with `sandbox-exec: execvp() of 'claude' failed: No such file or directory`.
// A guard cannot protect what the regex never sees. `{{> block}}` still doesn't match (`>` is out).
const VAR_RE = /\{\{([A-Za-z_][A-Za-z0-9_.]*)\}\}/g;

function interpolate(text: string, where: string): string {
  const v = vars();
  return text.replace(VAR_RE, (_m, name: string) => {
    const val = v[name];
    // Loud, not silent: a typo'd placeholder that fell through as literal "{{prot}}" would ship a
    // broken instruction to a live agent and read as a model failure, not a config one.
    if (val === undefined) throw new Error(`${where}: unknown placeholder {{${name}}}`);
    return val;
  });
}

// ───────────────────────────── parsing ─────────────────────────────

type Frontmatter = { scalars: Record<string, string>; env: Record<string, string> };

/**
 * The SKILL.md shape this repo already uses: `---` fences, `key: value` lines, plus one level of
 * indented pairs under `env:`. Not YAML — a real parser is a dependency and an attack surface we do
 * not need for four keys.
 */
function parseFrontmatter(raw: string, where: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${where}: missing --- frontmatter`);
  const fm: Frontmatter = { scalars: {}, env: {} };
  let inEnv = false;
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (indented) {
      if (!inEnv) throw new Error(`${where}: indented line outside env: — "${line.trim()}"`);
      const kv = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!kv) throw new Error(`${where}: bad env entry "${line.trim()}"`);
      fm.env[kv[1]] = unquote(kv[2]);
      continue;
    }
    inEnv = false;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new Error(`${where}: bad frontmatter line "${line}"`);
    if (kv[1] === "env") {
      if (kv[2].trim()) throw new Error(`${where}: env: takes indented entries, not a value`);
      inEnv = true;
      continue;
    }
    fm.scalars[kv[1]] = unquote(kv[2]);
  }
  return { fm, body: m[2] };
}

const unquote = (s: string) => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
};

/**
 * Replace `{{> block}}` lines with the block file, verbatim, consuming the include line's own
 * newline. Blocks carry their own trailing blank lines — the composed prompt is a concatenation, so
 * the spacing between sections lives in the block files rather than in the composer.
 */
function expandIncludes(body: string, root: string, where: string): string {
  return body.replace(/^\{\{> ([a-z0-9-]+)\}\}\n/gm, (_m, name: string) => {
    const file = path.join(blocksDir(root), `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`${where}: unknown block {{> ${name}}}`);
    return fs.readFileSync(file, "utf8");
  });
}

/**
 * HTML comments are notes to whoever edits the file, not instructions to the model — a paragraph
 * explaining why a rule is worded the way it is would otherwise be read as part of the rule.
 * Stripping them is also what lets an agent declare only surfaces (Robert) and still document itself
 * in AGENT.md: a body that is nothing but commentary is an empty body.
 */
const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->\n?/g, "");

const SANDBOX_MODES = new Set<string>(["off", "guard", "strict"]);

// A budget that silently read as NaN would disable the ceiling it was written to lower, so a
// malformed value throws at load time like every other bad frontmatter value here.
function memoryBudget(raw: string | undefined, where: string): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${where}: memory_budget must be a positive integer, got "${raw}"`);
  return n;
}

/** `mcp: playwright` → the interpolated JSON of `agents/_mcp/playwright.json`. */
function readMcpBundle(root: string, name: string, where: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`${where}: mcp must be a bundle name, got "${name}"`);
  const file = path.join(root, "_mcp", `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`${where}: no MCP bundle agents/_mcp/${name}.json`);
  const raw = interpolate(fs.readFileSync(file, "utf8"), `agents/_mcp/${name}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`agents/_mcp/${name}.json: invalid JSON — ${(e as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers;
  if (!servers || !Object.keys(servers).length)
    throw new Error(`agents/_mcp/${name}.json: no "mcpServers" entries`);
  return raw;
}

function loadOne(root: string, id: string): AgentDef {
  const dir = path.join(root, id);
  const agentMd = path.join(dir, "AGENT.md");
  if (!fs.existsSync(agentMd)) throw new Error(`agents/${id}: no AGENT.md`);
  const { fm, body } = parseFrontmatter(fs.readFileSync(agentMd, "utf8"), `agents/${id}/AGENT.md`);

  const req = (k: string) => {
    const v = fm.scalars[k];
    if (!v) throw new Error(`agents/${id}/AGENT.md: missing "${k}"`);
    return v;
  };
  const sandbox = fm.scalars.sandbox ?? null;
  if (sandbox !== null && !SANDBOX_MODES.has(sandbox)) {
    throw new Error(`agents/${id}/AGENT.md: sandbox must be off|guard|strict, got "${sandbox}"`);
  }

  // MCP servers are shared kit, not persona: several agents can want the same browser. So the
  // frontmatter names a bundle in `agents/_mcp/` rather than inlining a server block per agent.
  // Validated here (exists + parses) because the alternative is a live executive whose browser
  // tools silently never appear — the CLI treats a bad --mcp-config as "no servers" and says nothing.
  const mcp = fm.scalars.mcp
    ? readMcpBundle(root, fm.scalars.mcp, `agents/${id}/AGENT.md`)
    : null;

  const surfaces: Record<string, string> = {};
  const compose = (text: string, where: string) =>
    interpolate(expandIncludes(stripComments(text), root, where), where);
  const defaultBody = compose(body, `agents/${id}/AGENT.md`);
  if (defaultBody.trim()) surfaces.default = defaultBody;
  for (const f of fs.readdirSync(dir)) {
    if (f === "AGENT.md" || !f.endsWith(".md")) continue;
    const name = f.slice(0, -3);
    const where = `agents/${id}/${f}`;
    surfaces[name] = compose(fs.readFileSync(path.join(dir, f), "utf8"), where);
  }
  if (!Object.keys(surfaces).length) throw new Error(`agents/${id}: no prompt (empty AGENT.md body and no *.md)`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(fm.env)) env[k] = interpolate(v, `agents/${id}/AGENT.md env.${k}`);

  return {
    id,
    name: req("name"),
    description: req("description"),
    memory: fm.scalars.memory || id,
    memoryBudget: memoryBudget(fm.scalars.memory_budget, `agents/${id}/AGENT.md`),
    model: fm.scalars.model || null,
    tools: fm.scalars.tools || null,
    mcp,
    cwd: fm.scalars.cwd ? interpolate(fm.scalars.cwd, `agents/${id}/AGENT.md cwd`) : null,
    sandbox: (sandbox as SandboxMode | null) ?? null,
    env,
    surfaces,
  };
}

// ───────────────────────────── cache ─────────────────────────────

let cache: Map<string, AgentDef> | null = null;
let cacheSig = "";

/** mtime+size of every file under agents/ — changes when a persona is edited, added or removed. */
function signature(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        parts.push(`${p}:${st.mtimeMs}:${st.size}`);
      }
    }
  };
  walk(root);
  return parts.join("|");
}

/** Uncached load of an agents tree. Exported for tests, which point it at fixture directories. */
export function loadAgentsFrom(root: string): Map<string, AgentDef> {
  const out = new Map<string, AgentDef>();
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
    out.set(e.name, loadOne(root, e.name));
  }
  return out;
}

export function loadAgents(): Map<string, AgentDef> {
  const sig = signature(AGENTS_DIR);
  if (cache && sig === cacheSig) return cache;
  cache = loadAgentsFrom(AGENTS_DIR);
  cacheSig = sig;
  return cache;
}

export function agentDef(id: string): AgentDef {
  const def = loadAgents().get(id);
  if (!def) throw new Error(`no agent definition: agents/${id}/`);
  return def;
}

/** The composed system prompt for one surface ("default" unless the agent declares more). */
export function agentPrompt(id: string, surface = "default"): string {
  const def = agentDef(id);
  const p = def.surfaces[surface];
  if (p === undefined) {
    throw new Error(`agents/${id}: no surface "${surface}" (have: ${Object.keys(def.surfaces).join(", ")})`);
  }
  return p;
}

/**
 * One shared block on its own, for prose that belongs beside the personas but is injected into a
 * terminal that HAS no persona — a Lead's worker (terminal.ts), whose prompt is FOCUS_CONTRACT plus
 * workspace context and nothing else. Same directory, same comment-stripping and interpolation, and
 * the same re-read-on-edit as a `{{> block}}` include, so the wording is editable without a rebuild.
 *
 * `fill` is substituted FIRST, which is what lets a block carry per-terminal values (the Lead's id,
 * its goal) that `vars()`'s deliberately closed list cannot: anything left unfilled still hits the
 * unknown-placeholder throw below rather than shipping as a literal `{{...}}`.
 */
export function agentBlock(name: string, fill: Record<string, string> = {}): string {
  const where = `agents/_blocks/${name}.md`;
  const file = path.join(blocksDir(AGENTS_DIR), `${name}.md`);
  if (!fs.existsSync(file)) throw new Error(`no block ${where}`);
  let raw = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(fill)) raw = raw.split(`{{${k}}}`).join(v);
  return interpolate(stripComments(raw), where).trim();
}

/** Test seam: drop the mtime cache so a fixture written this tick is re-read. */
export function resetAgentDefs(): void {
  cache = null;
  cacheSig = "";
}
