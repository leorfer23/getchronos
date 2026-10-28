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
 *   shown     — images it put in front of him along the way (`mc show`): same bytes, same store, drawn
 *               in Talk under the reply they came with.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Outcome, Ship, Shown } from "./types.js";

export const SHIPS: readonly Ship[] = ["ask", "merge", "deploy"];
export const OUTCOME_ASKS: readonly Outcome["ask"][] = ["merge", "deploy", "merge+deploy", "review", "none"];

// Read per call, not at import: a test points CHRONOS_OUTCOMES at a tmp dir after this module loads.
export const outcomeRoot = () => process.env.CHRONOS_OUTCOMES ?? path.join(os.homedir(), ".mc", "outcomes");
export const MAX_SHOT_BYTES = 6 * 1024 * 1024;
const MAX_SHOTS = 8;
// A terminal's whole store of images: hand-off screenshots and everything it `mc show`ed.
const MAX_FILES = 120;
/** Images in one `mc show`, and how many shows a terminal keeps (the oldest fall off). */
export const MAX_SHOW_SHOTS = 12;
export const MAX_SHOWN = 30;
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

/**
 * Which finish-line checks are met, as stored: check text → when it was ticked. Keyed by the words, not
 * the position, so an agent that rewrites its list keeps the ticks of the checks it kept.
 */
export type DoneTicks = Record<string, string>;
export function decodeTicks(raw: unknown): DoneTicks {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as DoneTicks;
  if (typeof raw !== "string" || !raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
/** The ticks lined up with the checks: the time each one was met, or null. */
export const checkedOf = (doneWhen: string[], ticks: DoneTicks): (string | null)[] => doneWhen.map((c) => ticks[c] ?? null);
/** Only the ticks whose check is still on the list. */
export function pruneTicks(doneWhen: string[], ticks: DoneTicks): DoneTicks {
  const out: DoneTicks = {};
  for (const c of doneWhen) if (ticks[c]) out[c] = ticks[c];
  return out;
}
/** Tick (or untick) checks by their 1-based number; numbers off the list are ignored. */
export function tickChecks(doneWhen: string[], ticks: DoneTicks, ns: number[], done: boolean, now = new Date()): DoneTicks {
  const out = pruneTicks(doneWhen, ticks);
  for (const n of ns) {
    const c = doneWhen[n - 1];
    if (c === undefined) continue;
    if (done) out[c] ??= now.toISOString();
    else delete out[c];
  }
  return out;
}

export function decodeOutcome(raw: unknown): Outcome | null {
  if (raw && typeof raw === "object") return raw as Outcome;
  if (typeof raw !== "string" || !raw) return null;
  try { return JSON.parse(raw) as Outcome; } catch { return null; }
}
export function decodeOutcomes(raw: unknown): Outcome[] {
  if (Array.isArray(raw)) return raw as Outcome[];
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** How many earlier hand-offs a terminal keeps beside the one on top. */
export const MAX_EARLIER = 9;
/**
 * A terminal can hand off more than once — the operator asks for changes, or gives it a follow-up — and
 * Focus keeps every hand-off, newest on top (Leo 2026-10-28). Not every filing is a new one, though: an
 * agent re-files the same hand-off once it shipped it, or to fix a line. The rule, in order:
 *
 *   - no summary, only --shipped            → what it shipped goes on the hand-off on top
 *   - it now says it shipped, same PRs      → the same hand-off, shipped (lines it left out are kept)
 *   - the one on top was already shipped    → new work: a new hand-off
 *   - a PR the one on top did not have      → new work: a new hand-off
 *   - the operator typed to it since        → a follow-up: a new hand-off
 *   - otherwise                             → a correction: it replaces the one on top
 */
export function fileOutcome(
  latest: Outcome | null,
  earlier: Outcome[],
  next: Outcome,
  operatorSpokeAt: number | null,
): { latest: Outcome; earlier: Outcome[] } {
  if (!latest) return { latest: next, earlier };
  if (!next.summary) {
    const shipped = [...latest.shipped, ...next.shipped.filter((x) => !latest.shipped.includes(x))].slice(0, 4);
    return { latest: { ...latest, shipped, at: next.at }, earlier };
  }
  const newPr = latest.prs.length > 0 && next.prs.some((u) => !latest.prs.includes(u));
  if (next.shipped.length && !latest.shipped.length && !newPr) {
    const keep = <K extends "changes" | "proof" | "prs" | "shots">(k: K) => (next[k].length ? next[k] : latest[k]);
    return { latest: { ...next, changes: keep("changes"), proof: keep("proof"), prs: keep("prs"), shots: keep("shots") }, earlier };
  }
  const followUp =
    (latest.shipped.length > 0 && !next.shipped.length) || newPr ||
    (operatorSpokeAt != null && operatorSpokeAt > (Date.parse(latest.at) || 0));
  if (!followUp) return { latest: next, earlier };
  return { latest: next, earlier: [...earlier, latest].slice(-MAX_EARLIER) };
}

export function decodeShown(raw: unknown): Shown[] {
  if (Array.isArray(raw)) return raw as Shown[];
  if (typeof raw !== "string" || !raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Only names saveShot() wrote for THIS terminal, and only files still on disk.
const ownShots = (sessionId: string, v: unknown, max: number) =>
  (Array.isArray(v) ? v : [])
    .map((x: any) => ({ name: String(x?.name ?? ""), label: clip(x?.label || "screenshot", 40) }))
    .filter((x: { name: string }) => SHOT_NAME.test(x.name) && fs.existsSync(shotDir(sessionId) + "/" + x.name))
    .slice(0, max);

/**
 * One `mc show` as the agent sent it → the entry Focus draws under its reply, or null when not one
 * image in it is a file this terminal uploaded (nothing to show is not a show).
 */
export function normalizeShow(sessionId: string, body: any, now = new Date()): Shown | null {
  const shots = ownShots(sessionId, body?.shots, MAX_SHOW_SHOTS);
  return shots.length ? { caption: clip(body?.caption, 600), shots, at: now.toISOString() } : null;
}
/** The list with the new show on the end, oldest dropped past MAX_SHOWN. */
export const addShown = (list: Shown[], next: Shown): Shown[] => [...list, next].slice(-MAX_SHOWN);

/**
 * A hand-off as the agent sent it → the row we keep. Everything is clipped (the Desk renders it on
 * every look at this terminal), PRs must be real PR links, and a shot must name a file this terminal
 * uploaded — anything else is dropped rather than refused, so one bad line never loses the hand-off.
 */
export function normalizeOutcome(sessionId: string, body: any, now = new Date()): Outcome {
  const shots = ownShots(sessionId, body?.shots, MAX_SHOTS);
  const ask = OUTCOME_ASKS.includes(body?.ask) ? body.ask : "review";
  return {
    // Empty only for a `--shipped`-only re-file, which fileOutcome() folds into the hand-off on top.
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
  if (fs.readdirSync(dir).length >= MAX_FILES) return { error: `this terminal already has ${MAX_FILES} images` };
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

/**
 * The board going stale while the agent works: its progress bar and its checks are what the operator
 * reads, and an agent deep in a task forgets to move them (Leo 2026-10-28: "it is not regularly updating
 * the checklist"). A Claude terminal's PostToolUse hook asks for this (throttled in the shell, see
 * term-hooks.ts) and hands the text back to the agent as context — a fact about its board, not an order.
 */
export const NUDGE_STALE_MS = 10 * 60_000;
export function boardNudge(b: {
  phase: string | null;
  goal: string | null;
  done_when: string[];
  checked: (string | null)[];
  progress: { n: number; of: number; label?: string | null; at?: number } | null;
  since: number;
}, now = Date.now()): string | null {
  if (b.phase !== "working") return null;
  const tickAt = Math.max(0, ...b.checked.map((t) => (t ? Date.parse(t) || 0 : 0)));
  const last = Math.max(b.progress?.at ?? 0, tickAt, b.since);
  if (now - last < NUDGE_STALE_MS) return null;
  const min = (at: number) => Math.round((now - at) / 60_000) + " min ago";
  const checks = b.done_when.length
    ? b.done_when.map((c, i) => `${b.checked[i] ? "[x]" : "[ ]"} ${i + 1}. ${clip(c, 120)}`).join(" · ")
    : "none written";
  const prog = b.progress ? `${b.progress.n}/${b.progress.of}${b.progress.label ? ` "${clip(b.progress.label, 80)}"` : ""}` + (b.progress.at ? ` (${min(b.progress.at)})` : "") : "none reported";
  return [
    `Your Focus board (the operator reads only this, not your output) has not moved for ${min(last).replace(" ago", "")}.`,
    `Goal: ${b.goal ? clip(b.goal, 200) : "none written"}`,
    `Progress: ${prog}`,
    `Done when: ${checks}`,
    "Commands that update it: `mc progress <n>/<of> \"<step>\" --eta <time left>` · `mc goal check <n>` (a check is met) · `mc goal set \"<goal>\" --done-when \"<check>\"`.",
  ].join("\n");
}

/** The line typed into a terminal when the operator changes what it may do at the end. */
export function shipLine(ship: Ship): string {
  return ship === "deploy"
    ? "Permission update: when the work is green you may open the PR, merge it and deploy — no need to ask. Then file `mc outcome` saying what you shipped."
    : ship === "merge"
      ? "Permission update: when the work is green you may open the PR and merge it — no need to ask. Do NOT deploy; ask for that in `mc outcome`."
      : "Permission update: open the PR, then stop and ask — do not merge or deploy until I approve it from your `mc outcome`.";
}
