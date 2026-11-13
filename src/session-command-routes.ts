/**
 * GET /api/sessions/:id/commands — what `/` in a terminal's composer offers (static/slash-complete.js),
 * and what the composer's chip shows: the terminal's model and how its CLI switches it, its account,
 * enabled plugins, skills, commands and MCP servers. Read off disk by src/session-commands.ts behind the
 * session's own walls; the CLI's built-in commands come from src/cli-commands.ts.
 *
 * Who may ask: the operator, or a caller whose workspace owns the terminal (checkScope — another
 * workspace, and a Robert credential outside its own workspace, get the 404 an unknown id gets). No token: 401.
 * Names, descriptions and where each came from only: no file body, no config value, no path.
 */
import os from "node:os";
import path from "node:path";
import express from "express";
import { checkScope } from "./authz.js";
import { CONFIG } from "./config.js";
import { getBackend } from "./backends/index.js";
import { builtinFor, cliFor } from "./cli-commands.js";
import { profileNameFor } from "./hosts/spawn-spec.js";
import "./lean-prompt.js"; // desk.lean_tools / desk.mcp_deny are defined there
import { claudeGlobalConfig, codexHome } from "./parity-env.js";
import { scanForBackend, projectDirs, type Item } from "./session-commands.js";
import { sessionUsage } from "./session-usage.js";
import { setting } from "./settings.js";
import { repos, sessions, workspaces } from "./store.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import { liveHomes } from "./terminal.js";
import type { Session } from "./types.js";

export type SessionCommands = {
  session_id: string;
  /** The CLI, by its canonical backend name: claude-code · codex · cursor-agent · grok · opencode · … */
  backend: string;
  /** Where the built-in list was checked: the CLI's docs and the version it was read against. */
  cli: { label: string; version: string; docs: string } | null;
  /** The model the terminal is on now: the last one its transcript answered with (a `/model` switch shows), else the one it opened with. */
  model: string | null;
  /** Models to offer, and the line that switches to one (`/model {model}`) — typed by the operator, never applied here. */
  models: string[];
  switch_model: string | null;
  /** The account the terminal runs on, by profile name (never a path). */
  profile: string | null;
  items: Item[];
  plugins: string[];
  mcp: string[];
  notes: string[];
};

const TTL_MS = 30_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: Omit<SessionCommands, "session_id" | "model"> }>();

/** The alias the Desk offers for a claude model id: `claude-opus-5-5` → `opus`. */
const FAMILY = /\b(opus|sonnet|haiku|fable)\b/i;

/** The model a terminal is on now: for claude, the last model its transcript answered with — so a `/model` switch shows. */
export function modelNow(s: Pick<Session, "id" | "backend" | "model">, usageModels?: string[]): string | null {
  if (getBackend(s.backend).name === "claude-code") {
    const last = (usageModels ?? sessionUsage(s.id)?.models ?? []).at(-1);
    const fam = last ? FAMILY.exec(last)?.[1] : undefined;
    if (fam) return fam.toLowerCase();
  }
  return s.model ?? null;
}

/** The account label a backend runs this terminal on. */
function accountOf(backend: string, profileDir: string, cursorDir: string | undefined): string | null {
  if (backend === "claude-code") return profileNameFor(profileDir, CONFIG.profiles, CONFIG.defaultProfile);
  if (backend === "codex") return codexHome(profileDir) === path.resolve(profileDir) ? profileNameFor(profileDir, CONFIG.profiles, CONFIG.defaultProfile) : "codex";
  if (backend === "cursor-agent") return cursorDir ? path.basename(cursorDir).replace(/^\./, "") : "cursor";
  if (backend === "grok" || backend === "opencode") return backend;
  return null;
}

export function commandsFor(s: Session): SessionCommands {
  const backend = getBackend(s.backend).name;
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  const homes = liveHomes(s.id);
  const profileDir = homes?.configDir || ws?.config_dir || CONFIG.profiles[CONFIG.defaultProfile] || CONFIG.profiles.claude;
  const remote = !!s.host_id && s.host_id !== LOCAL_HOST_ID;
  const home = os.homedir();
  const cwd = remote ? null : s.cwd || null;
  const key = JSON.stringify([backend, profileDir, homes?.cursorConfigDir ?? null, cwd, ws?.id ?? null, remote]);
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at >= TTL_MS) {
    const notes: string[] = [];
    const builtin = builtinFor(backend, { leanTools: backend === "claude-code" && setting<boolean>("desk.lean_tools", ws?.id ?? null) === true });
    let scan = { items: [] as Item[], plugins: [] as string[], mcp: [] as string[] };
    if (remote) notes.push("This terminal runs on another computer — its skills, commands and plugins live there, so only the CLI's own commands are listed.");
    else {
      const project = projectDirs(cwd, home);
      const workspaceRoots = [
        ...(ws ? repos.accessible(ws.id).map((r) => r.path) : []),
        ...(ws?.default_dir ? [ws.default_dir] : []),
        ...(s.worktree_path ? [s.worktree_path] : []),
      ];
      const deny = [...(ws ? workspaces.isolationDenyDirs(ws.id) : []), ...CONFIG.sandbox.projectDirs];
      scan = scanForBackend(backend, {
        home,
        profileDir,
        project,
        workspaceRoots,
        deny,
        cwd,
        globalConfig: claudeGlobalConfig(profileDir),
        codexHome: codexHome(profileDir),
        cursorDir: homes?.cursorConfigDir || path.join(home, ".cursor"),
        grokHome: process.env.GROK_HOME || path.join(home, ".grok"),
        opencodeDir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
        extra: CONFIG.sandbox.claudeShared,
        mcpDeny: backend === "claude-code" ? setting<string[]>("desk.mcp_deny", ws?.id ?? null) ?? [] : [],
        reserved: cliFor(backend)?.reserved ?? [],
      });
    }
    const cli = cliFor(backend);
    // A skill or command of the same name replaces the built-in (Claude Code's rule): the menu shows the one that runs.
    const taken = new Set(scan.items.filter((i) => i.group === "skill" || i.group === "command").map((i) => i.name));
    const b = getBackend(backend);
    hit = {
      at: Date.now(),
      value: {
        backend,
        cli: cli ? { label: cli.label, version: cli.version, docs: cli.docs } : null,
        models: cli?.switchModel ? [...(b.models ?? [])] : [],
        switch_model: cli?.switchModel ?? null,
        profile: accountOf(backend, profileDir, homes?.cursorConfigDir),
        items: [...builtin.filter((b) => backend !== "claude-code" || !taken.has(b.name)), ...scan.items],
        plugins: scan.plugins,
        mcp: scan.mcp,
        notes,
      },
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, hit);
  }
  return { session_id: s.id, model: modelNow(s), ...hit.value };
}

/** Forget every cached answer (tests; a profile that just changed on disk shows within 30 s anyway). */
export function clearCommandsCache(): void {
  cache.clear();
}

export function sessionCommandRoutes(): express.Router {
  const r = express.Router();
  r.get("/sessions/:id/commands", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    try {
      res.json(commandsFor(s));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  return r;
}
