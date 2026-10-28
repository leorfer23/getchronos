/**
 * What a Desk claude terminal sends on every request before it has done anything.
 *
 * Read off the request shapes of 75 Desk terminals (2026-10-28): 78k tokens on average, re-read on
 * every turn of the session. The skills listing alone was 15.5k (every skill's description, for
 * skills that were invoked 46 times in 298 sessions), the claude.ai Artifact tool's schema 13.3k
 * (called in 42 of them, nearly all in two workspaces), and tools no Desk terminal called in 30 days
 * — workflows, /loop and cron — another few thousand.
 *
 * Lean and expandable, not cut: skills are listed by NAME (`skillOverrides` "name-only"), and
 * invoking one still loads all of it; the few a workspace's agents must recognise unprompted stay
 * listed in full (`desk.skills_full`). The Artifact tool is a per-workspace switch. Everything here
 * is applied at spawn, so a change reaches the next terminal opened, never one mid-conversation
 * (that would rewrite its whole cached prompt).
 */
import fs from "node:fs";
import path from "node:path";
import { defineSetting, setting } from "./settings.js";

defineSetting({
  key: "desk.lean_skills", group: "Limits", level: "both", type: "bool", env: "CHRONOS_DESK_LEAN_SKILLS",
  label: "List skills by name only",
  help: "A claude terminal sees each skill's name instead of its whole description; invoking a skill still loads all of it. Cuts most of the skills listing every request carries.",
  default: () => process.env.CHRONOS_DESK_LEAN_SKILLS !== "0",
});
defineSetting({
  key: "desk.skills_full", group: "Limits", level: "both", type: "list", env: "CHRONOS_DESK_SKILLS_FULL",
  label: "…except these, listed in full",
  help: "Skills an agent here must recognise on its own, without being told to use them.",
  default: () => (process.env.CHRONOS_DESK_SKILLS_FULL ?? "mission-control").split(",").map((s) => s.trim()).filter(Boolean),
});
defineSetting({
  key: "desk.mcp_deny", group: "Limits", level: "both", type: "list", env: "CHRONOS_DESK_MCP_DENY",
  label: "MCP servers kept out of terminals",
  help: "Server names a claude terminal here never loads — its own (`slack`) or a claude.ai connector by display name (`claude.ai Gmail`). Each loaded server's tool names ride on every request.",
  default: () => (process.env.CHRONOS_DESK_MCP_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});
defineSetting({
  key: "desk.claudeai_connectors", group: "Limits", level: "both", type: "bool", env: "CHRONOS_DESK_CLAUDEAI_CONNECTORS",
  label: "claude.ai connectors",
  help: "Off: claude terminals here load none of the account's claude.ai connectors (Gmail, Drive, …) — for a workspace that uses none of them. To drop only some, name them in MCP servers kept out.",
  default: () => process.env.CHRONOS_DESK_CLAUDEAI_CONNECTORS !== "0",
});
defineSetting({
  key: "desk.artifact_tool", group: "Limits", level: "both", type: "bool", env: "CHRONOS_DESK_ARTIFACT_TOOL",
  label: "claude.ai Artifact tool",
  help: "Off: claude terminals here have no Artifact tool (its description is ~13k tokens on every request) and publish pages with `mc artifact` only.",
  default: () => process.env.CHRONOS_DESK_ARTIFACT_TOOL !== "0",
});
defineSetting({
  key: "desk.lean_tools", group: "Limits", level: "both", type: "bool", env: "CHRONOS_DESK_LEAN_TOOLS",
  label: "Drop workflows and /loop",
  help: "Claude Code's Workflow tool and its session cron (/loop, ScheduleWakeup) are off in terminals: Chronos has `mc when` and Leads for that.",
  default: () => process.env.CHRONOS_DESK_LEAN_TOOLS !== "0",
});

/**
 * Skills Claude Code ships or syncs from claude.ai, which are not on disk in the profile. A name it
 * does not have is ignored, so the list may run ahead of or behind a CLI version harmlessly.
 */
export const SHIPPED_SKILLS = [
  "dataviz", "claude-api", "update-config", "keybindings-help", "simplify", "fewer-permission-prompts",
  "loop", "schedule", "run", "workflow-authoring", "plugin-authoring", "security-review", "init",
  "docs", "docx", "pptx", "xlsx", "pdf", "google-workspace", "computer-use", "built-in-browser",
  "chrome-browser", "anthropic-skills:deep-research", "skill-creator", "morning", "shareout", "import-memory",
];

/** Every skill and command a profile has on disk, plus the shipped ones. */
export function skillNames(configDir: string): string[] {
  const out = new Set<string>(SHIPPED_SKILLS);
  try {
    for (const d of fs.readdirSync(path.join(configDir, "skills")))
      if (fs.existsSync(path.join(configDir, "skills", d, "SKILL.md"))) out.add(d);
  } catch {}
  try {
    for (const f of fs.readdirSync(path.join(configDir, "commands"))) if (f.endsWith(".md")) out.add(f.slice(0, -3));
  } catch {}
  return [...out].sort();
}

/** `skillOverrides` for one profile: name-only for all but the listed ones. Plugin skills are not affected. */
export function skillOverrides(names: string[], full: string[]): Record<string, "name-only"> {
  const keep = new Set(full);
  return Object.fromEntries(names.filter((n) => !keep.has(n)).map((n) => [n, "name-only" as const]));
}

/** Extra argv for a claude Desk terminal: one `--settings` carrying the skill listing and the MCP denylist. */
export function leanClaudeArgs(configDir: string, workspaceId: string | null): string[] {
  const settings: Record<string, unknown> = {};
  if (setting<boolean>("desk.lean_skills", workspaceId)) {
    const o = skillOverrides(skillNames(configDir), setting<string[]>("desk.skills_full", workspaceId) ?? []);
    if (Object.keys(o).length) settings.skillOverrides = o;
  }
  // A denylist merges with any the profile has and nothing overrides a match (Claude Code's managed-mcp rules).
  const deny = setting<string[]>("desk.mcp_deny", workspaceId) ?? [];
  if (deny.length) settings.deniedMcpServers = deny.map((serverName) => ({ serverName }));
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
}

/** Extra env for a claude Desk terminal. CLAUDE_CODE_DISABLE_ARTIFACT wins over the backend's CLAUDE_CODE_ARTIFACT=1. */
export function leanClaudeEnv(workspaceId: string | null): Record<string, string> {
  return {
    ...(setting<boolean>("desk.artifact_tool", workspaceId) ? {} : { CLAUDE_CODE_DISABLE_ARTIFACT: "1" }),
    ...(setting<boolean>("desk.claudeai_connectors", workspaceId) ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
    ...(setting<boolean>("desk.lean_tools", workspaceId) ? { CLAUDE_CODE_DISABLE_WORKFLOWS: "1", CLAUDE_CODE_DISABLE_CRON: "1" } : {}),
  };
}
