/**
 * Efficiency tool wiring — RTK (shell output compression) and fff (fast repo search MCP).
 *
 * Both are default-on when the binary is on PATH; CHRONOS_RTK=0 / CHRONOS_FFF=0 disable install.
 * Missing binaries are soft no-ops so a fresh machine still boots — install with brew/curl, then
 * restart the daemon (or open a Desk terminal) to pick them up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { childEnv } from "./child-env.js";
import { CONFIG } from "./config.js";
import { workspaces } from "./store.js";

const FFF_NAME = "fff";

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 2000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Absolute path to fff-mcp if installed (PATH, Homebrew, or ~/.local/bin). */
export function resolveFffMcp(): string | null {
  return (
    which("fff-mcp") ||
    ["/opt/homebrew/bin/fff-mcp", "/usr/local/bin/fff-mcp", path.join(os.homedir(), ".local", "bin", "fff-mcp")].find(
      (p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
          return false;
        }
      },
    ) ||
    null
  );
}

export function rtkAvailable(): boolean {
  return !!which("rtk");
}

function configFile(configDir: string): string {
  return path.join(configDir, ".claude.json");
}
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeJson(file: string, obj: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

/**
 * Register (or remove) the fff MCP server in a Claude profile's `.claude.json`.
 * Mirrors Slack's installer: one entry per config_dir, inherited by Desk + headless Claude.
 */
export function installFffMcp(configDir: string): "written" | "noop" | "removed" | "skipped" {
  if (!CONFIG.fffEnabled) return "skipped";
  if (!configDir) return "skipped";
  const file = configFile(configDir);
  const cfg = readJson(file);
  cfg.mcpServers = cfg.mcpServers || {};
  const bin = resolveFffMcp();
  if (!bin) {
    if (cfg.mcpServers[FFF_NAME]) {
      delete cfg.mcpServers[FFF_NAME];
      writeJson(file, cfg);
      return "removed";
    }
    return "skipped";
  }
  const next = { type: "stdio", command: bin, args: [] as string[] };
  const prev = cfg.mcpServers[FFF_NAME];
  if (prev && prev.command === next.command && JSON.stringify(prev.args ?? []) === "[]") return "noop";
  cfg.mcpServers[FFF_NAME] = next;
  writeJson(file, cfg);
  return "written";
}

/**
 * Cursor CLI reads the same `mcp.json` as the editor: `~/.cursor/mcp.json`, or
 * `CURSOR_CONFIG_DIR/mcp.json` when a workspace isolates its cursor home.
 * Merge `fff` beside whatever else is already there.
 */
export function installCursorFffMcp(
  dir: string,
  bin: string | null = resolveFffMcp(),
): "written" | "noop" | "removed" | "skipped" {
  if (!CONFIG.fffEnabled) return "skipped";
  if (!dir) return "skipped";
  const file = path.join(dir, "mcp.json");
  if (!fs.existsSync(dir)) {
    if (!bin) return "skipped";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "skipped";
    } catch {
      return "skipped";
    }
  }
  const cfg = readJson(file);
  if (cfg && typeof cfg !== "object") return "skipped";
  const body = cfg && !Array.isArray(cfg) ? cfg : {};
  body.mcpServers = body.mcpServers || {};
  if (!bin) {
    if (body.mcpServers[FFF_NAME]) {
      delete body.mcpServers[FFF_NAME];
      writeJson(file, body);
      return "removed";
    }
    return "skipped";
  }
  const next = { command: bin, args: [] as string[] };
  const prev = body.mcpServers[FFF_NAME];
  if (prev && prev.command === next.command && JSON.stringify(prev.args ?? []) === "[]") return "noop";
  body.mcpServers[FFF_NAME] = next;
  writeJson(file, body);
  return "written";
}

const GROK_FFF_BEGIN = "# BEGIN chronos fff mcp (managed by Chronos — do not edit)";
const GROK_FFF_END = "# END chronos fff mcp";

/** TOML block Grok loads as `[mcp_servers.fff]`. Absolute path: grok's PATH may not see Homebrew. */
export function grokFffToml(bin: string): string {
  return [
    GROK_FFF_BEGIN,
    "[mcp_servers.fff]",
    `command = ${JSON.stringify(bin)}`,
    "args = []",
    "enabled = true",
    GROK_FFF_END,
  ].join("\n");
}

/**
 * Grok reads MCP from `$GROK_HOME/config.toml` (`~/.grok` by default). Own one marked block so a
 * reinstall replaces it and the hooks block (term-hooks.ts) stays intact. If the operator already
 * declared `[mcp_servers.fff]` themselves, leave that file alone.
 */
export function installGrokFffMcp(
  home = process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
  bin: string | null = resolveFffMcp(),
): "written" | "noop" | "removed" | "skipped" {
  if (!CONFIG.fffEnabled) return "skipped";
  if (!home) return "skipped";
  const file = path.join(home, "config.toml");
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(
    `\\n?${GROK_FFF_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${GROK_FFF_END}\\n?`,
  );
  const bare = prev.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
  if (!bin) {
    if (bare === prev) return "skipped";
    if (!fs.existsSync(home)) return "skipped";
    fs.writeFileSync(file, bare.trimEnd() + (bare.trim() ? "\n" : ""));
    return "removed";
  }
  if (/^\s*\[mcp_servers\.fff\]/m.test(bare)) return "skipped";
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const next = `${bare.trimEnd()}${bare.trim() ? "\n\n" : ""}${grokFffToml(bin)}\n`;
  if (prev === next) return "noop";
  fs.writeFileSync(file, next);
  return "written";
}

function cursorConfigDirs(): string[] {
  const dirs = new Set<string>([path.join(os.homedir(), ".cursor")]);
  for (const ws of workspaces.list()) {
    try {
      const d = childEnv(ws).CURSOR_CONFIG_DIR;
      if (d) dirs.add(d);
    } catch {
      // a bad secrets file must not block fff install for everyone else
    }
  }
  return [...dirs];
}

/** Install fff into Claude profiles, Cursor mcp.json, and Grok config.toml. */
export function installAllFffMcp(): void {
  if (!CONFIG.fffEnabled) {
    console.log("[efficiency] fff MCP disabled (CHRONOS_FFF=0)");
    return;
  }
  const dirs = new Set<string>();
  for (const ws of workspaces.list()) if (ws.config_dir) dirs.add(ws.config_dir);
  for (const d of Object.values(CONFIG.profiles)) if (d) dirs.add(d);
  let written = 0;
  for (const dir of dirs) {
    const r = installFffMcp(dir);
    if (r === "written") written++;
  }
  let cursor = 0;
  for (const dir of cursorConfigDirs()) {
    const r = installCursorFffMcp(dir);
    if (r === "written") cursor++;
  }
  const grok = installGrokFffMcp();
  const bin = resolveFffMcp();
  if (!bin) console.log("[efficiency] fff-mcp not on PATH — skip MCP install (brew install dmtrKovalenko/fff/fff-mcp)");
  else {
    console.log(
      `[efficiency] fff MCP → ${bin} (claude ${written} written, cursor ${cursor} written, grok ${grok})`,
    );
  }
}

/** Copy scripts/rtk-rewrite.sh → ~/.mc/bin so hooks can call it from any sandbox. */
export function installRtkRewriteScript(): "written" | "noop" | "skipped" {
  if (!CONFIG.rtkEnabled) return "skipped";
  try {
    const src = path.join(process.cwd(), "scripts", "rtk-rewrite.sh");
    if (!fs.existsSync(src)) return "skipped";
    const dir = path.join(os.homedir(), ".mc", "bin");
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, "rtk-rewrite.sh");
    const body = fs.readFileSync(src);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(body)) return "noop";
    fs.writeFileSync(dst, body, { mode: 0o755 });
    fs.chmodSync(dst, 0o755);
    return "written";
  } catch (e: any) {
    console.warn("[efficiency] rtk-rewrite install failed:", e?.message ?? e);
    return "skipped";
  }
}

/** Snapshot for /api/stats — are the binaries present and is install enabled? */
export function efficiencyToolsStatus(): {
  rtk: { enabled: boolean; available: boolean };
  fff: { enabled: boolean; binary: string | null };
} {
  return {
    rtk: { enabled: CONFIG.rtkEnabled, available: rtkAvailable() },
    fff: { enabled: CONFIG.fffEnabled, binary: resolveFffMcp() },
  };
}
