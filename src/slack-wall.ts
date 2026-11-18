/**
 * Slack wall: a workspace's agents reach a Slack only when that Slack is the workspace's own.
 *
 * 2026-11-18: a terminal in one workspace left a Slack draft in a client's Slack. Its workspace runs on
 * the operator's own Claude profile, which several workspaces share, and that profile's `slack` MCP
 * server is logged in to whichever Slack he last connected it to — a client's. Per-workspace Slack (slack.ts) rests on the
 * profile boundary: one profile, one Slack login, one workspace. A shared profile has no such boundary,
 * so the Slack login there belongs to none of the workspaces on it.
 *
 * A workspace OWNS the Slack its profile carries when it turned Slack on in Chronos (slack_config.enabled)
 * and no other live workspace runs on the same profile. Anything else — Slack off, a shared profile, no
 * profile of its own — and every Slack tool is denied on the spawn's single `--disallowed-tools` flag,
 * under every name a profile mounts Slack, and a Robert's MCP bundle leaves it out. A deny beats every
 * allow, the send gate's opening for the operator's own DM included, so the wall fails closed.
 * A spawn with no workspace (the operator's own: fleet-wide Robert, an unscoped job) is not walled here.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { mergeDeny } from "./no-send.js";
import { workspaces } from "./store.js";
import type { Workspace } from "./types.js";

/** The names a profile mounts Slack's MCP server under: Chronos's own entry, Slack's plugin, the claude.ai connector. */
export const SLACK_SERVERS = ["slack", "plugin_slack_slack", "claude_ai_Slack"] as const;

/**
 * Every tool of those servers, plus any server whose tools are Slack's (`slack_*`) under another name.
 * Both forms checked live on claude 2026-11-18: with either rule no Slack tool is left in the session.
 */
export const slackWallRules = (): string[] => [...SLACK_SERVERS.map((s) => `mcp__${s}`), "mcp__*__slack_*"];

/** Is this MCP server entry (from a profile's `mcpServers`) a Slack, by its name or where it points? */
export function isSlackServer(name: string, spec: unknown): boolean {
  if (/slack/i.test(name)) return true;
  const s = (spec ?? {}) as { url?: unknown; command?: unknown; args?: unknown };
  return [s.url, s.command, ...(Array.isArray(s.args) ? s.args : [])].some((v) => typeof v === "string" && /slack/i.test(v));
}

type WsLite = Pick<Workspace, "id" | "config_dir" | "slack_config" | "archived">;

const real = (p: string) => {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
};

function slackOn(ws: WsLite): boolean {
  try {
    return !!JSON.parse(ws.slack_config ?? "").enabled;
  } catch {
    return false;
  }
}

/**
 * Pure: is the Slack on this workspace's profile its own? `all` is every workspace (archived ones are
 * skipped). A workspace with no config_dir runs on the default profile (`defaultDir`): it never owns a
 * Slack, and it counts as sharing that profile with anyone pinned to it.
 */
export function ownsSlack(ws: WsLite | null | undefined, all: WsLite[], defaultDir?: string | null): boolean {
  if (!ws || !ws.config_dir || ws.archived || !slackOn(ws)) return false;
  const me = real(ws.config_dir);
  return !all.some((w) => {
    if (w.id === ws.id || w.archived) return false;
    const dir = w.config_dir || defaultDir;
    return !!dir && real(dir) === me;
  });
}

/** Does a spawn in this workspace get the wall? No workspace: no (see the header). */
export function slackWalled(wsId: string | null | undefined, all: WsLite[] = workspaces.list()): boolean {
  if (!wsId) return false;
  const defaultDir = CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? null;
  return !ownsSlack(all.find((w) => w.id === wsId), all, defaultDir);
}

/** Wall a foreign Slack out of one claude spawn's argv, in place (merged into its one deny flag). True when it walled. */
export function wallForeignSlack(args: string[], wsId: string | null | undefined, all?: WsLite[]): boolean {
  if (!slackWalled(wsId, all)) return false;
  mergeDeny(args, slackWallRules().join(","));
  return true;
}
