/**
 * The assistant's name and the first-run welcome (static/desk-welcome.js).
 *
 *   GET  /assistant           any valid caller → { name }. Every page that shows or says his name
 *                             reads it here (static/assistant-name.js), the phone before it has
 *                             anything else to show.
 *   PUT  /assistant { name }  the operator's own credential only → { name }. A Robert credential is
 *                             refused: the name is the one the operator gave him, never one he picks
 *                             (the ⚙ Settings road is closed to him too — robert-scope.ts).
 *   GET  /onboarding          → { done }. The welcome shows while this is false AND there is no project.
 *   PUT  /onboarding { done } → { done }. Finished or skipped: the welcome never shows again.
 *   GET  /onboarding/folder?path=…   the operator only. What the welcome's "first project" step needs
 *                             to know about the folder he typed before it calls the ordinary project
 *                             routes (POST /workspaces, POST /workspaces/:id/repos): the absolute path
 *                             (`~/` expanded here — the page cannot know the home folder), whether it
 *                             exists, whether it is a git checkout (and has an origin, which decides PR
 *                             vs commit delivery), and the profile a new project is billed to. Facts
 *                             only: no listing, no contents.
 *
 * The name itself lives in the settings registry (settings.ts `assistant.name`), so ⚙ Settings shows
 * and edits the same value through the same check.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { CONFIG } from "./config.js";
import { kv } from "./store/kv.js";
import { checkToken, isOperator } from "./authz.js";
import { assistantName, cleanAssistantName, writeSetting } from "./settings.js";
import { detectDefaultBranch, detectOriginUrl } from "./repo-git.js";

const DONE_KEY = "onboarding.done";

/** Finished or skipped — kept as the moment it happened, for whoever reads kv later. */
export const onboardingDone = (): boolean => !!kv.get(DONE_KEY);

export type FolderFacts = {
  path: string;
  exists: boolean;
  dir: boolean;
  git: boolean;
  remote: boolean;
  branch: string | null;
  name: string;
  profile: string;
};

/** `~/x` → `$HOME/x`; anything not absolute after that is refused by the caller. */
export function expandFolder(raw: string, home = os.homedir()): string {
  const s = raw.trim();
  if (s === "~") return home;
  return path.resolve(s.startsWith("~/") ? path.join(home, s.slice(2)) : s);
}

/** Why this folder can't be a project, in the words the welcome shows — or null. */
export function folderRefusal(raw: unknown, home = os.homedir()): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "Type the folder your project lives in.";
  const s = raw.trim();
  if (s.length > 300) return "That path is too long.";
  if (!s.startsWith("/") && s !== "~" && !s.startsWith("~/")) return "Use the folder's full path — like ~/code/my-app.";
  const abs = expandFolder(s, home);
  if (abs === "/" || abs === path.resolve(home)) return "Pick the project's own folder, not your whole home folder.";
  return null;
}

export async function folderFacts(raw: string, home = os.homedir()): Promise<FolderFacts> {
  const abs = expandFolder(raw, home);
  const st = (() => { try { return fs.statSync(abs); } catch { return null; } })();
  const dir = !!st?.isDirectory();
  // A checkout's root (`.git` a directory, or the file a worktree has) — not a folder somewhere inside
  // one: registering a subfolder as a repo would point worktrees and PRs at the wrong place.
  const git = dir && fs.existsSync(path.join(abs, ".git"));
  return {
    path: abs,
    exists: !!st,
    dir,
    git,
    remote: git ? !!(await detectOriginUrl(abs)) : false,
    branch: git ? await detectDefaultBranch(abs) : null,
    name: path.basename(abs),
    profile: CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude,
  };
}

export function assistantRoutes(requireAdmin: express.RequestHandler): express.Router {
  const r = express.Router();

  r.get("/assistant", (req, res) => {
    if (!checkToken(req, res)) return;
    res.json({ name: assistantName() });
  });

  r.put("/assistant", (req, res) => {
    if (!isOperator(req)) return res.status(403).json({ error: "only the operator names the assistant (x-mc-admin)" });
    let name: string;
    try {
      name = cleanAssistantName(req.body?.name);
    } catch (e: any) {
      return res.status(400).json({ error: `Name: ${e?.message ?? e}` });
    }
    writeSetting("assistant.name", name);
    res.json({ name: assistantName() });
  });

  r.get("/onboarding", requireAdmin, (_req, res) => {
    res.json({ done: onboardingDone() });
  });

  r.put("/onboarding", requireAdmin, (req, res) => {
    const done = req.body?.done;
    if (typeof done !== "boolean") return res.status(400).json({ error: "done: true or false" });
    if (done) { if (!onboardingDone()) kv.set(DONE_KEY, new Date().toISOString()); }
    else kv.del(DONE_KEY);
    res.json({ done: onboardingDone() });
  });

  r.get("/onboarding/folder", async (req, res) => {
    if (!isOperator(req)) return res.status(403).json({ error: "operator only (x-mc-admin)" });
    const raw = req.query.path;
    const why = folderRefusal(raw);
    if (why) return res.status(400).json({ error: why });
    try {
      res.json(await folderFacts(String(raw)));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  return r;
}
