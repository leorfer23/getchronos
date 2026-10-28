/**
 * The three things the operator reads on Focus (Leo 2026-10-28): the goal and how we will know it is
 * met, the decisions along the way, and the hand-off he approves from. This module owns the first and
 * the last as data:
 *
 *   done_when — the finish line, a short list of checks the agent writes (`mc goal set --done-when`).
 *   ship      — what the operator lets it do once the work is green: ask | merge | deploy. Only the
 *               operator writes it (api.ts refuses it from a workspace token), so an agent can never
 *               widen its own permission.
 *   outcome   — the agent's hand-off (`mc outcome`): a summary, what changed, the proof, before/after
 *               screenshots, its PRs, and what it asks him for. Screenshots are bytes on this disk under
 *               outcomeRoot(), never a path the agent names: a host's paths mean nothing here, and a
 *               path the page could ask for is a file read the agent chose.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Outcome, Ship } from "./types.js";

export const SHIPS: readonly Ship[] = ["ask", "merge", "deploy"];
export const OUTCOME_ASKS: readonly Outcome["ask"][] = ["merge", "deploy", "merge+deploy", "review", "none"];

// Read per call, not at import: a test points CHRONOS_OUTCOMES at a tmp dir after this module loads.
export const outcomeRoot = () => process.env.CHRONOS_OUTCOMES ?? path.join(os.homedir(), ".mc", "outcomes");
export const MAX_SHOT_BYTES = 6 * 1024 * 1024;
const MAX_SHOTS = 8;
const SHOT_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
// The only names a shot route will open: what saveShot() writes, nothing a caller could steer.
const SHOT_NAME = /^[a-z0-9-]{1,40}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/;

const clip = (t: unknown, n: number) => {
  const s = String(t ?? "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const list = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : []).map((x) => clip(x, len)).filter(Boolean).slice(0, max);

/** The finish line as stored: a JSON list of short checks, or null when it was cleared. */
export function encodeDoneWhen(v: string[] | null | undefined): string | null {
  const l = list(v, 8, 200);
  return l.length ? JSON.stringify(l) : null;
}
export function decodeDoneWhen(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export function decodeOutcome(raw: unknown): Outcome | null {
  if (raw && typeof raw === "object") return raw as Outcome;
  if (typeof raw !== "string" || !raw) return null;
  try { return JSON.parse(raw) as Outcome; } catch { return null; }
}

/**
 * A hand-off as the agent sent it → the row we keep. Everything is clipped (the Desk renders it on
 * every look at this terminal), PRs must be real PR links, and a shot must name a file this terminal
 * uploaded — anything else is dropped rather than refused, so one bad line never loses the hand-off.
 */
export function normalizeOutcome(sessionId: string, body: any, now = new Date()): Outcome {
  const shots = (Array.isArray(body?.shots) ? body.shots : [])
    .map((x: any) => ({ name: String(x?.name ?? ""), label: clip(x?.label || "screenshot", 40) }))
    .filter((x: { name: string }) => SHOT_NAME.test(x.name) && fs.existsSync(shotDir(sessionId) + "/" + x.name))
    .slice(0, MAX_SHOTS);
  const ask = OUTCOME_ASKS.includes(body?.ask) ? body.ask : "review";
  return {
    summary: clip(body?.summary, 600),
    changes: list(body?.changes, 10, 240),
    proof: list(body?.proof, 10, 240),
    prs: list(body?.prs, 6, 300).filter((u) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(u)),
    shots,
    ask,
    shipped: list(body?.shipped, 4, 160),
    at: now.toISOString(),
  };
}

export function shotDir(sessionId: string): string {
  return path.join(outcomeRoot(), String(sessionId).replace(/[^\w-]+/g, "_").slice(0, 80) || "session");
}

/** Store one screenshot's bytes; returns the name the hand-off refers to it by. */
export function saveShot(sessionId: string, label: string, ext: string, bytes: Buffer): { name: string } | { error: string } {
  const e = String(ext || "").toLowerCase().replace(/^\./, "");
  if (!SHOT_EXT[e]) return { error: "a screenshot is png, jpg, webp or gif" };
  if (!bytes.length) return { error: "empty image" };
  if (bytes.length > MAX_SHOT_BYTES) return { error: `image over ${MAX_SHOT_BYTES / 1048576} MB` };
  const dir = shotDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(dir).length >= 40) return { error: "this terminal already has 40 screenshots" };
  const slug = String(label || "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "shot";
  const name = `${slug}-${randomBytes(6).toString("hex")}.${e}`;
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
  return { name };
}

/** The file behind a shot name, or null — only names saveShot() could have written are ever opened. */
export function shotFile(sessionId: string, name: string): { path: string; mime: string } | null {
  if (!SHOT_NAME.test(name)) return null;
  const p = path.join(shotDir(sessionId), name);
  if (!fs.existsSync(p)) return null;
  return { path: p, mime: SHOT_EXT[name.split(".").pop()!.toLowerCase()] };
}

/** The line typed into a terminal when the operator changes what it may do at the end. */
export function shipLine(ship: Ship): string {
  return ship === "deploy"
    ? "Permission update: when the work is green you may open the PR, merge it and deploy — no need to ask. Then file `mc outcome` saying what you shipped."
    : ship === "merge"
      ? "Permission update: when the work is green you may open the PR and merge it — no need to ask. Do NOT deploy; ask for that in `mc outcome`."
      : "Permission update: open the PR, then stop and ask — do not merge or deploy until I approve it from your `mc outcome`.";
}
