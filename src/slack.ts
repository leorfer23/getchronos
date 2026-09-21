import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";
import { workspaces, repos, jobs } from "./store.js";
import { childEnv } from "./child-env.js";
import { reloadSchedules } from "./scheduler.js";
import type { Workspace } from "./types.js";

// Per-workspace Slack = the OFFICIAL Slack MCP server (remote HTTP + OAuth) written into the
// workspace's CLAUDE_CONFIG_DIR. No custom Slack app, no bot token: each config dir authenticates
// via OAuth to ONE Slack workspace, and that token caches in the config dir. Isolation = the config
// dir boundary (agents in another workspace's dir never see this Slack). Admin must approve the
// Slack MCP integration in that Slack workspace first. Docs: https://docs.slack.dev/ai/slack-mcp-server
const MCP_NAME = "slack";
const SERVER_SPEC = {
  type: "http",
  url: "https://mcp.slack.com/mcp",
  oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 },
};

function configFile(configDir: string): string {
  return path.join(configDir, ".claude.json");
}
function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function writeJson(file: string, obj: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function slackEnabled(ws: Workspace): boolean {
  if (!ws.slack_config) return false;
  try { return !!JSON.parse(ws.slack_config).enabled; } catch { return false; }
}
function triageEnabled(ws: Workspace): boolean {
  if (!ws.slack_config) return false;
  try { return !!JSON.parse(ws.slack_config).triage; } catch { return false; }
}
function sharesConfigDir(ws: Workspace): Workspace[] {
  return workspaces.list().filter((w) => w.id !== ws.id && w.config_dir === ws.config_dir);
}

// Write or remove the Slack MCP entry for one workspace based on its slack_config.enabled.
export function installSlackMcp(ws: Workspace): void {
  authCache.delete(ws.config_dir); // enable/disable changes auth state — drop the stale verdict
  const file = configFile(ws.config_dir);
  const cfg = readJson(file);
  cfg.mcpServers = cfg.mcpServers || {};
  if (!slackEnabled(ws)) {
    if (cfg.mcpServers[MCP_NAME]) { delete cfg.mcpServers[MCP_NAME]; writeJson(file, cfg); }
    return;
  }
  const shared = sharesConfigDir(ws);
  if (shared.length) console.warn(`[slack] ${ws.slug} shares config_dir ${ws.config_dir} with ${shared.map((w) => w.slug).join(", ")} — one Slack OAuth identity is shared across them`);
  cfg.mcpServers[MCP_NAME] = { ...SERVER_SPEC };
  writeJson(file, cfg);
  console.log(`[slack] installed Slack MCP (official, OAuth) for ${ws.slug} → ${file}`);
}

export function installAllSlackMcp(): void {
  for (const ws of workspaces.list()) if (ws.slack_config) { installSlackMcp(ws); ensureTriageJob(ws); }
}

// ───────────────────────────── Slack triage (DM/@mention → ticket, read-only) ─────────────────────────────

function triageGoal(ws: Workspace): string {
  return (
    `SLACK TRIAGE for the ${ws.name} workspace (READ-ONLY — never post to Slack, never reply, never edit code, never take any action).\n\n` +
    `Using your Slack tools, find NEW items since the last run: (a) direct messages sent to me by other people, ` +
    `(b) messages that @mention me, and (c) notes I send to my OWN DM or where I @mention MYSELF — treat these ` +
    `self-captures as deliberate "make a ticket" requests (a personal capture inbox), NOT noise. Skip pure ` +
    `automated bot posts (standup prompts, calendar digests) unless they're directed at me.\n` +
    `Dedup: first run \`mc memo get slack-triage-state\` to read the last-processed cursor (message timestamps already handled). ` +
    `Only handle items newer than that. If that memo doesn't exist, treat roughly the last 24h as new and create it.\n\n` +
    `For each new DM or @mention:\n` +
    `  1. Create a ticket: \`mc ticket new --title "<concise summary of the ask>" --body "From <sender> in <channel/DM>: <message text> (<slack permalink if available>)"\`\n` +
    `  2. Do a READ-ONLY first pass: read the surrounding Slack thread and skim obviously-relevant files/docs in this repo to understand what's being asked and what a response would involve.\n` +
    `  3. Append your findings + a suggested response/approach to the ticket: \`mc note <KEY> "<context summary + proposed approach>"\`.\n` +
    `  DO NOT reply in Slack, message anyone, modify code, or take any action — only capture the ticket + your read-only analysis.\n\n` +
    `When done, update the cursor: \`mc memo edit slack-triage-state --body "<newest handled message timestamps>"\` (create with \`mc memo new --title "slack-triage-state"\` if missing).\n` +
    `If there are no new DMs/mentions, do nothing.`
  );
}

// Create/update/remove the recurring read-only triage job for a workspace based on slack_config.triage.

/** Whether this workspace has Slack tools an agent can actually call (config on + MCP installed). */
export function slackReady(ws: Workspace): boolean {
  return slackEnabled(ws);
}

export function ensureTriageJob(ws: Workspace): void {
  const name = `slack-triage:${ws.slug}`;
  const existing = jobs.list().find((j) => j.name === name);
  const want = slackEnabled(ws) && triageEnabled(ws);
  if (!want) {
    if (existing) { jobs.remove(existing.id); reloadSchedules(); }
    return;
  }
  const repo = repos.list(ws.id)[0];
  const cwd = repo?.path ?? os.homedir();
  const fields = {
    goal: triageGoal(ws),
    workspace_id: ws.id,
    backend: ws.default_backend,
    model: CONFIG.slackTriageModel, // cheap model — this is mostly empty polling

    cwd,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "cron" as const,
    cron_expr: CONFIG.slackTriageCron,
    timezone: CONFIG.slackTriageTz,
    description: "Triage Slack DMs/@mentions → tickets (read-only first pass)",
  };
  // Only set enabled on create; on update preserve the user's manual toggle so a daemon
  // restart / workspace re-sync doesn't re-enable a job the user turned off.
  if (existing) jobs.update(existing.id, fields);
  else jobs.create({ name, ...fields, enabled: true });
  reloadSchedules();
}

// Cache isAuthed by config dir (60s TTL) — status UI polls this and each miss spawns `claude mcp list` (~1-2s).
// Invalidated in installSlackMcp on enable/disable; the interactive OAuth completes out-of-process, so a fresh
// login is visible within one TTL. ponytail: Map+timestamp, per-dir LRU only if it ever grows unbounded.
const authCache = new Map<string, { at: number; authed: boolean }>();
const AUTH_TTL = 60_000;

// Whether the config dir already holds an authenticated Slack OAuth token (best-effort: ask the CLI).
function isAuthed(ws: Workspace): Promise<boolean> {
  const hit = authCache.get(ws.config_dir);
  if (hit && Date.now() - hit.at < AUTH_TTL) return Promise.resolve(hit.authed);
  return new Promise((resolve) => {
    // Genuinely Claude-CLI-specific (queries Claude's MCP inventory) — not a routable LLM call, so
    // it stays on the claude binary rather than going through a backend.oneShot().
    const child = spawn(CONFIG.claudeBin, ["mcp", "list"], {
      env: { ...childEnv(ws), CLAUDE_CONFIG_DIR: ws.config_dir },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const line = out.split("\n").find((l) => /(^|\s)slack:/i.test(l)) || "";
      const authed = /✔|connected/i.test(line) && !/needs authentication/i.test(line);
      authCache.set(ws.config_dir, { at: Date.now(), authed });
      resolve(authed);
    });
    child.on("error", () => resolve(false));
  });
}

export function slackStatus(ws: Workspace): Promise<{ enabled: boolean; authenticated: boolean; triage: boolean; shared: string[] }> {
  const enabled = slackEnabled(ws);
  const triage = triageEnabled(ws);
  const shared = sharesConfigDir(ws).map((w) => w.slug);
  if (!enabled) return Promise.resolve({ enabled: false, authenticated: false, triage, shared });
  return isAuthed(ws).then((authenticated) => ({ enabled, authenticated, triage, shared }));
}
