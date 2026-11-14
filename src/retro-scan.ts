/**
 * Reading one workspace's week into counts — the deterministic half of the weekly self-retro
 * (src/retro-pass.ts). Everything here is code: what a model later sees is what this module chose
 * to show it, and what may leave the workspace (findings) is built only from the enums below.
 *
 *   scanTranscript   one claude transcript → its typed turns (still unclassified), tool errors and API
 *                    errors by class. Streams the file; skips a headless (`sdk-cli`) run entirely.
 *   clauses/cluster  the operator's own words → short clauses → groups of the same ask said again.
 *   duplicates       terminals opened on a job another live terminal already had (dup-goal.ts's test).
 */
import fs from "node:fs";
import readline from "node:readline";
import { similarity } from "./text-similarity.js";
import { DUP_GOAL_MIN } from "./dup-goal.js";
import type { Session } from "./types.js";

// ───────────────────────────── the enums that may leave a workspace ─────────────────────────────

export const TOOL_ERROR_CLASSES = [
  "user-rejected", "harness-denied", "hook-blocked", "sandbox-denied", "mc-cli-invalid-flag", "mc-cli-error", "gh-error",
  "git-error", "test-failure", "command-not-found", "timeout", "permission-denied", "bash-nonzero", "edit-no-match",
  "file-not-read", "file-missing", "mcp-error", "web-error", "other",
] as const;
export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number];

export const API_ERROR_CLASSES = ["network", "overloaded", "rate_limit", "auth", "other"] as const;
export type ApiErrorClass = (typeof API_ERROR_CLASSES)[number];

/** The first program a shell line runs, past `cd … &&`, env assignments and nice/time wrappers. */
export function commandHead(cmd: string | null | undefined): string {
  let c = String(cmd ?? "").trim();
  for (let i = 0; i < 8; i++) {
    const before = c;
    c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, "")
      .replace(/^(nice(\s+-n\s*-?\d+)?|time|caffeinate(\s+-\w+)*|lockf(\s+-\w+)*\s+\S+)\s+/, "");
    if (c === before) break;
  }
  const first = c.split(/\s+/)[0] ?? "";
  return first.split("/").pop() ?? "";
}

/** A failed tool call → one class. The text never leaves this function. */
export function toolErrorClass(tool: string | null, cmd: string | null, text: string): ToolErrorClass {
  const t = String(text ?? "").slice(0, 4000);
  if (/doesn'?t want to proceed|rejected by the user|user (rejected|denied|declined)|has chosen not to/i.test(t)) return "user-rejected";
  if (/permission for this action was denied|auto mode classifier|permission to use \S+ (has been|was) denied/i.test(t)) return "harness-denied";
  if (/hook error|blocked by /i.test(t)) return "hook-blocked";
  if (/operation not permitted|sandbox_apply|sandbox-exec/i.test(t)) return "sandbox-denied";
  if (tool && tool.startsWith("mcp__")) return "mcp-error";
  if (tool === "WebFetch" || tool === "WebSearch") return "web-error";
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    if (/string to replace not found|old_string|not unique|found \d+ matches/i.test(t)) return "edit-no-match";
  }
  if (/has not been read yet|read it first/i.test(t)) return "file-not-read";
  if (tool === "Bash" || tool === "BashOutput") {
    const head = commandHead(cmd);
    if (/command not found/i.test(t)) return "command-not-found";
    if (head === "mc") {
      if (/unknown (option|flag|subcommand|command|argument)|unrecognized (option|argument)|invalid (option|flag|argument)|usage:|needs (a |an |--)|missing (required )?(argument|option)/i.test(t)) return "mc-cli-invalid-flag";
      return "mc-cli-error";
    }
    if (head === "gh") return "gh-error";
    if (head === "git") return "git-error";
    if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|node\s+--test\b|\b(go|cargo)\s+test\b/.test(String(cmd ?? ""))) return "test-failure";
    if (/timed out|timeout after/i.test(t) && !/exit code [1-9]/i.test(t)) return "timeout";
    if (/permission denied|EACCES/i.test(t)) return "permission-denied";
    return "bash-nonzero";
  }
  if (/does not exist|no such file|ENOENT/i.test(t)) return "file-missing";
  if (/permission denied|EACCES/i.test(t)) return "permission-denied";
  return "other";
}

/** An API error line (claude: `isApiErrorMessage`, with an `error` code) → one class. */
export function apiErrorClass(code: string | null | undefined, text: string): ApiErrorClass {
  const c = String(code ?? "").toLowerCase();
  const t = String(text ?? "");
  if (c === "authentication_failed" || /failed to authenticate|login (expired|reached its time limit)|run \/login|oauth|invalid api key|\b401\b/i.test(t)) return "auth";
  if (c === "rate_limit" || /rate.?limit|\b429\b|usage limit|session limit|too many requests/i.test(t)) return "rate_limit";
  if (/overloaded|\b529\b/i.test(t)) return "overloaded";
  if (/can'?t reach|unable to connect|connection (dropped|lost|refused|error)|went to sleep|ENOTFOUND|ECONN\w+|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|request timed out/i.test(t)) return "network";
  return "other";
}

// ───────────────────────────── one transcript ─────────────────────────────

export interface RawTurn { at: number; text: string; first: boolean }
export interface RawScan {
  /** An `sdk-cli` transcript: a headless run, not a terminal — nothing in it counts. */
  headless: boolean;
  /** Typed turns inside the window, in order, not yet told apart (turn-source.ts does that). */
  turns: RawTurn[];
  toolErrors: Partial<Record<ToolErrorClass, number>>;
  apiErrors: Partial<Record<ApiErrorClass, number>>;
}

const TURN_CAP = 2000;
/** Lines a CLI writes as a user turn that nobody typed: slash-command plumbing, interrupt notices. */
const PLUMBING = /^(<command-|<local-command|<bash-|<user-memory-input>|caveat:|\[request interrupted)/i;
const textOfBlocks = (c: unknown): string =>
  Array.isArray(c) ? c.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n") : typeof c === "string" ? c : "";

/**
 * A typed turn: a user line whose content is the operator's prompt — not a tool result, not a hook's
 * meta line, not a subagent's (sidechain), not a peer hand-back or a task notification (claude marks
 * those in `origin`), not a system/SDK prompt.
 */
function typedTurn(o: any): string | null {
  if (o?.type !== "user" || o.isMeta || o.isSidechain || o.toolUseResult !== undefined) return null;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return null;
  const kind = o.origin?.kind;
  if (kind && kind !== "human") return null;
  if (o.promptSource === "system" || o.promptSource === "sdk") return null;
  const text = textOfBlocks(c).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || PLUMBING.test(text)) return null;
  return text;
}

export async function scanTranscript(file: string, win: { since: number; until: number }): Promise<RawScan> {
  const out: RawScan = { headless: false, turns: [], toolErrors: {}, apiErrors: {} };
  const tools = new Map<string, { name: string; cmd: string | null }>();
  let sawTyped = false;
  const inWin = (ts: unknown) => {
    const t = Date.parse(String(ts ?? ""));
    return Number.isFinite(t) && t >= win.since && t < win.until ? t : null;
  };
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line.length > 5_000_000) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o?.entrypoint === "sdk-cli") { out.headless = true; break; }
      if (o?.isSidechain) continue;
      const c = o?.message?.content;
      if (o?.type === "assistant") {
        if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_use" && b.id) tools.set(b.id, { name: String(b.name ?? ""), cmd: typeof b.input?.command === "string" ? b.input.command.slice(0, 300) : null });
        if (o.isApiErrorMessage) {
          const t = inWin(o.timestamp);
          if (t !== null) { const k = apiErrorClass(o.error, textOfBlocks(c)); out.apiErrors[k] = (out.apiErrors[k] ?? 0) + 1; }
        }
        continue;
      }
      if (o?.type !== "user") continue;
      if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) {
        const t = inWin(o.timestamp);
        if (t === null) continue;
        for (const b of c) {
          if (b?.type !== "tool_result" || b.is_error !== true) continue;
          const tool = tools.get(b.tool_use_id);
          const k = toolErrorClass(tool?.name ?? null, tool?.cmd ?? null, textOfBlocks(b.content));
          out.toolErrors[k] = (out.toolErrors[k] ?? 0) + 1;
        }
        continue;
      }
      const text = typedTurn(o);
      if (text === null) continue;
      const first = !sawTyped;
      sawTyped = true;
      const t = inWin(o.timestamp);
      if (t !== null) out.turns.push({ at: t, text: text.slice(0, TURN_CAP), first });
    }
  } finally {
    rl.close();
    input.destroy();
  }
  if (out.headless) return { headless: true, turns: [], toolErrors: {}, apiErrors: {} };
  return out;
}

// ───────────────────────────── the operator's words → asks said again ─────────────────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "be", "it", "its", "this", "that",
  "me", "my", "i", "you", "your", "we", "our", "pls", "please", "just", "also", "so", "then", "now", "ok", "okay", "thanks",
  "el", "la", "los", "las", "de", "del", "que", "y", "o", "en", "un", "una", "mi", "por", "para", "con", "lo", "le", "se", "es",
]);
export function clauseTokens(s: string): string[] {
  return String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length >= 2 && !STOP.has(w));
}
export function clauseSimilarity(a: string, b: string): number {
  const ta = new Set(clauseTokens(a)), tb = new Set(clauseTokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Short pieces of what he typed, the unit an ask repeats in: "…and DM me when done" is the same ask
 * at the end of a dozen different goals. A long turn (a brief, a paste) contributes its head and tail
 * only; a clause that is mostly symbols (code, a log line) is not words to learn from.
 */
export function clauses(text: string): string[] {
  const t = String(text ?? "");
  const body = t.length > 1200 ? `${t.slice(0, 500)}\n${t.slice(-500)}` : t;
  return body
    .split(/[\n.!?;]+|,\s+|\s+(?:and then|then|and|y luego|luego|y)\s+/i)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter((c) => {
      const n = clauseTokens(c).length;
      if (n < 2 || n > 14) return false;
      const letters = (c.match(/[\p{L}\s]/gu) ?? []).length;
      return letters / c.length >= 0.7;
    });
}

/** He is correcting how the work is done — a candidate rule even said once. */
const CORRECTION_RE = new RegExp(
  [
    "^(?:no|nope|not|never|nunca|don'?t|do not|stop|quit|avoid|no more|no hagas|deja de|dej[aá] de)\\b",
    "\\b(?:always|siempre|never|nunca|from now on|de ahora en m[aá]s|next time|la pr[oó]xima|i told you|te dije|again|otra vez|instead|en vez de|rather than|should have|remember to|acordate|make sure|asegurate|asegur[aá]te)\\b",
    "\\b(?:too (?:long|verbose|much|wordy)|less (?:text|words|detail)|more (?:concise|brief)|shorter|concise|m[aá]s corto|menos texto|m[aá]s conciso)\\b",
    "\\b(?:yourself|vos mismo|por tu cuenta)\\b",
  ].join("|"),
  "i",
);
/** A standing request ("put it in Downloads", "DM me when done") — a candidate once it repeats. */
const REQUEST_RE = /\b(?:put (?:it|them|the \w+) in|save (?:it|them) (?:in|to)|ponelo en|guardalo en|dejalo en|dm me|ping me|tell me when|let me know when|avisame|av[ií]same|mandame)\b/i;
export const isCorrection = (clause: string): boolean => CORRECTION_RE.test(clause);
export const isRequest = (clause: string): boolean => REQUEST_RE.test(clause);

/** One clause he said; `line` is the whole turn it came from, for an example a model can read in context. */
export interface Said { text: string; session_id: string; at: number; line?: string }
export interface Cluster { text: string; count: number; sessions: number; correction: boolean; request: boolean; first: number; last: number; examples: Said[] }

/**
 * The same ask said again, grouped. Greedy, in time order: a clause joins the first group whose
 * representative it reads like (≥ min), else starts one. The representative is the shortest clause
 * in the group — the most general way he said it. A group counts the TURNS it was said in, not its
 * clauses: one pasted log that repeats a line is one turn, not a repeat ask.
 */
export function clusterSaid(said: Said[], min = 0.6): Cluster[] {
  const groups: { rep: string; items: Said[] }[] = [];
  for (const s of [...said].sort((a, b) => a.at - b.at)) {
    const g = groups.find((x) => clauseSimilarity(x.rep, s.text) >= min);
    if (g) {
      g.items.push(s);
      if (s.text.length < g.rep.length) g.rep = s.text;
    } else groups.push({ rep: s.text, items: [s] });
  }
  return groups.map((g) => ({
    text: g.rep,
    count: new Set(g.items.map((i) => `${i.session_id}@${i.at}`)).size,
    sessions: new Set(g.items.map((i) => i.session_id)).size,
    correction: g.items.some((i) => isCorrection(i.text)),
    request: g.items.some((i) => isRequest(i.text)),
    first: g.items[0].at,
    last: g.items[g.items.length - 1].at,
    examples: g.items.slice(-2),
  }));
}

/** Said again = more than once, in more than one terminal (repeating yourself inside one chat is a conversation). */
export const repeated = (c: Cluster): boolean => c.count >= 2 && c.sessions >= 2;

// ───────────────────────────── duplicates ─────────────────────────────

type DupRow = Pick<Session, "id" | "workspace_id" | "goal" | "spawn_goal" | "lead_id" | "created_at" | "ended_at">;
const goalOf = (s: DupRow) => (s.goal ?? s.spawn_goal ?? "").trim();

/**
 * Terminals opened in [since, until) while another live terminal of the same workspace had a goal
 * that reads the same (dup-goal.ts's Jaccard and threshold). A Lead and its own worker are never a pair.
 */
export function duplicateTerminals(rows: DupRow[], since: string, until: string, min = DUP_GOAL_MIN): number {
  let n = 0;
  for (const s of rows) {
    if (s.created_at < since || s.created_at >= until || !goalOf(s)) continue;
    const dup = rows.some((o) =>
      o.id !== s.id && o.workspace_id === s.workspace_id && o.created_at < s.created_at && (!o.ended_at || o.ended_at > s.created_at)
      && o.id !== s.lead_id && s.id !== o.lead_id && !!goalOf(o) && similarity(goalOf(s), goalOf(o)) >= min);
    if (dup) n++;
  }
  return n;
}
