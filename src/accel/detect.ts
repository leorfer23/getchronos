import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AcceleratorTool } from "../types.js";
import { tryResolveTrustedBin, parseToolVersion } from "./resolve-bin.js";
import { graphifyChildEnv } from "./graphify-env.js";

export interface ToolStatus {
  tool: AcceleratorTool;
  installed: boolean;
  version: string | null;
  detail?: string;
}

const VERSION_TIMEOUT_MS = 2000;

/**
 * Runs `<bin> --version` and reads back the first line, never installing or downloading anything —
 * a missing binary (ENOENT) or a non-zero exit is just "not installed", not an error to surface.
 * Exported so tests can probe the ENOENT/timeout paths against a real (if arbitrary) binary instead
 * of mocking child_process.
 *
 * `env`, when passed, is the child's entire environment (no inheritance). Omit it for generic
 * tools so ast-grep/repomix keep the daemon environment. Graphify probes must pass
 * `graphifyChildEnv()` — a version/help check must not see API or workspace secrets.
 */
export function versionOf(
  bin: string,
  args: string[] = ["--version"],
  env?: NodeJS.ProcessEnv,
): { installed: boolean; version: string | null } {
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync(bin, args, {
      timeout: VERSION_TIMEOUT_MS,
      encoding: "utf8",
      ...(env !== undefined ? { env } : {}),
    });
  } catch {
    return { installed: false, version: null };
  }
  if (r.error || r.status == null || r.status !== 0) return { installed: false, version: null };
  const out = (r.stdout || r.stderr || "").trim().split("\n")[0] || null;
  return { installed: true, version: out };
}

export function detectAstGrep(): ToolStatus {
  return { tool: "ast-grep", ...versionOf("ast-grep") };
}

export function detectRepomix(): ToolStatus {
  return { tool: "repomix", ...versionOf("repomix") };
}

/**
 * Graphify ships two real executables — `graphify` (the CLI) and `graphify-mcp` (the MCP server) —
 * so "installed" is decided the same way as ast-grep/repomix: `graphify --version` actually running.
 * The Claude Code skill file (SKILL.md under a workspace's config dir) is a THIRD, separate surface —
 * it can exist with no CLI on PATH, or vice versa — so it is reported only as supplemental `detail`,
 * never treated as proof the tool is installed.
 *
 * `graphify-mcp` has no `--version` (argparse exits 2 with usage on stderr). Probe `--help` instead —
 * exit 0 with usage text means the MCP binary is present; never treat a missing version flag as absent.
 */
export function detectGraphify(configDir: string | null | undefined): ToolStatus {
  // Same trusted resolution as execution (PATH + ~/.local/bin + Homebrew) so a launchd daemon with
  // a thin PATH still reports installed when builds would find the binary via fallback.
  const cliBin = tryResolveTrustedBin("graphify");
  const cli = cliBin ? versionOf(cliBin, ["--version"], graphifyChildEnv()) : { installed: false, version: null };
  const mcpBin = tryResolveTrustedBin("graphify-mcp");
  const mcp = mcpBin ? versionOf(mcpBin, ["--help"], graphifyChildEnv()) : { installed: false, version: null };
  const skillFile = configDir ? path.join(configDir, "skills", "graphify", "SKILL.md") : null;
  const hasSkill = !!skillFile && fs.existsSync(skillFile);
  const detail = [
    mcp.installed ? "graphify-mcp present" : "graphify-mcp not found",
    skillFile ? (hasSkill ? `skill file present (${skillFile})` : `skill file not found (${skillFile})`) : "workspace has no config_dir",
  ].join("; ");
  // Surface the canonical semver so status freshness matches manifests that store "0.9.64".
  const version = cli.installed ? (parseToolVersion(cli.version) ?? cli.version) : null;
  return { tool: "graphify", installed: cli.installed, version, detail };
}

export function detectTool(tool: AcceleratorTool, configDir: string | null | undefined): ToolStatus {
  if (tool === "graphify") return detectGraphify(configDir);
  if (tool === "ast-grep") return detectAstGrep();
  return detectRepomix();
}
