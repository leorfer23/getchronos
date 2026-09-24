import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { estimateUsd } from "./pricing.js";
import { sessions, workspaces } from "./store.js";
import { LOCAL_HOST_ID } from "./store/hosts.js";
import { mirrorFile } from "./hosts/transcript-mirror.js";

// What a terminal has actually spent. The CLI already writes it — every claude transcript carries a
// running `cost-state` (totalCostUSD, lines added/removed) and per-message `usage` — so this is a
// read, not an estimate: no price table to drift, no token counting of our own to get wrong.
//
// Three numbers earn their place on a card:
//   · turns    — how many times you (or an overseer) actually prompted it. Tool results are not turns.
//   · context  — the last assistant message's input + cache tokens ≈ how full the window is right now.
//                This is the one that decides whether a terminal is about to compact and lose the thread.
//   · cost     — the CLI's own running total for the session.
//
// Read incrementally: a long session's transcript is megabytes, and the wall asks often. Each scan
// consumes only the bytes appended since the last one.

export interface SessionUsage {
  turns: number;
  /** Milliseconds the model was actually working — wall-clock minus your thinking time. */
  model_ms: number;
  cost_usd: number | null;
  /** True when cost_usd is our arithmetic, not the CLI's own total (it writes one periodically). */
  cost_estimated: boolean;
  context_tokens: number;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  models: string[];
  lines_added: number;
  lines_removed: number;
}

function estimate(a: Acc): number {
  return (
    estimateUsd({
      model: a.models[a.models.length - 1] ?? "",
      tokens_in: a.tokens_in,
      tokens_out: a.tokens_out,
      cache_read: a.cache_read,
      cache_write: a.cache_write,
    }) ?? 0
  );
}

interface Acc extends SessionUsage {
  file: string | null;
  offset: number;
  buf: string;
}

const state = new Map<string, Acc>();
const blank = (): Acc => ({
  file: null, offset: 0, buf: "",
  turns: 0, model_ms: 0, cost_usd: null, cost_estimated: false, context_tokens: 0, tokens_in: 0, tokens_out: 0,
  cache_read: 0, cache_write: 0, models: [], lines_added: 0, lines_removed: 0,
});

/** Where a session's own config profile keeps its transcripts. Ended sessions resolve off the row. */
function configDirFor(id: string): string | null {
  const s = sessions.get(id);
  if (!s) return null;
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  return ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? null;
}

/** claude pins the transcript filename to the session id; the project dir depends on cwd. */
function transcriptFor(id: string): string | null {
  // A terminal on another host: its transcript is the mirror the host streams into (hosts/transcript-mirror.ts).
  const row = sessions.get(id);
  if (row && row.host_id && row.host_id !== LOCAL_HOST_ID) {
    const m = mirrorFile(id);
    return fs.existsSync(m) ? m : null;
  }
  const configDir = configDirFor(id);
  if (!configDir) return null;
  const root = path.join(configDir, "projects");
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

function absorb(a: Acc, line: string) {
  if (!line.trim()) return;
  let d: any;
  try { d = JSON.parse(line); } catch { return; }
  // A Task subagent writes its own turns into the same file. They are the agent's work, not yours.
  if (d.isSidechain === true) return;
  if (d.type === "cost-state") {
    if (typeof d.totalCostUSD === "number") { a.cost_usd = d.totalCostUSD; a.cost_estimated = false; }
    // Wall-clock says a terminal was open 90 minutes; this says the model worked 12 of them. The gap
    // is you reading, deciding, and being somewhere else — worth telling apart in a day's log.
    if (typeof d.totalAPIDuration === "number") a.model_ms = d.totalAPIDuration;
    if (typeof d.totalLinesAdded === "number") a.lines_added = d.totalLinesAdded;
    if (typeof d.totalLinesRemoved === "number") a.lines_removed = d.totalLinesRemoved;
    return;
  }
  if (d.type === "user") {
    const c = d.message?.content;
    // A tool result is the conversation talking to itself — only a real prompt is a turn.
    const isToolResult = Array.isArray(c) && c.some((b: any) => b && typeof b === "object" && b.type === "tool_result");
    if (!isToolResult) a.turns++;
    return;
  }
  if (d.type === "assistant") {
    const u = d.message?.usage;
    const model = d.message?.model;
    if (model && model !== "<synthetic>" && !a.models.includes(model)) a.models.push(model);
    if (!u) return;
    a.tokens_in += u.input_tokens ?? 0;
    a.tokens_out += u.output_tokens ?? 0;
    a.cache_read += u.cache_read_input_tokens ?? 0;
    a.cache_write += u.cache_creation_input_tokens ?? 0;
    // Not a sum: what the model was handed on its LAST turn is what the window currently holds.
    a.context_tokens =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
}

/** Current usage for a session, reading only what the transcript has grown by since last time. */
export function sessionUsage(id: string): SessionUsage | null {
  let a = state.get(id);
  if (!a) { a = blank(); state.set(id, a); }
  const file = a.file ?? transcriptFor(id);
  if (!file) return null;
  if (file !== a.file) { Object.assign(a, blank(), { file }); }
  let size: number;
  try { size = fs.statSync(file).size; } catch { return snapshot(a); }
  // Rewritten (compaction) → start over rather than double-count.
  if (size < a.offset) Object.assign(a, blank(), { file });
  if (size > a.offset) {
    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const b = Buffer.allocUnsafe(size - a.offset);
        const read = fs.readSync(fd, b, 0, b.length, a.offset);
        chunk = b.toString("utf8", 0, read);
        a.offset += read;
      } finally { fs.closeSync(fd); }
    } catch { return snapshot(a); }
    const text = a.buf + chunk;
    const lines = text.split("\n");
    a.buf = lines.pop() ?? ""; // trailing partial line waits for its newline
    for (const l of lines) absorb(a, l);
  }
  return snapshot(a);
}

function snapshot(a: Acc): SessionUsage {
  const { file, offset, buf, ...u } = a;
  const priced = u.cost_usd != null && !u.cost_estimated;
  return {
    ...u,
    models: [...u.models],
    // The CLI's own total wins the moment it exists; until then, say what it's costing, marked.
    cost_usd: priced ? u.cost_usd : u.tokens_out || u.cache_read ? estimate(a) : null,
    cost_estimated: !priced,
  };
}

export function forgetUsage(id: string) {
  state.delete(id);
}

/**
 * Freeze what this terminal spent onto its row. Called on every ticker pass for a live terminal (so a
 * daemon crash doesn't lose the day) and once more when the pty dies — that snapshot is what the
 * day's log reads months later, when the transcript may be long gone.
 */
export function snapshotUsage(id: string, opts: { cwd?: string } = {}): SessionUsage | null {
  const u = sessionUsage(id);
  if (!u) return null;
  const prev = sessions.get(id);
  sessions.setLedger(id, {
    turns: u.turns,
    tokens_in: u.tokens_in,
    tokens_out: u.tokens_out,
    cache_read: u.cache_read,
    cache_write: u.cache_write,
    cost_usd: u.cost_usd ?? undefined,
    // Persist the flag with the number: an estimate must not read as a metered fact months later.
    cost_estimated: u.cost_usd != null ? u.cost_estimated : undefined,
    // Peak, not last: a terminal that filled its window and compacted still tells you it did.
    context_peak: Math.max(u.context_tokens, prev?.context_peak ?? 0),
    lines_added: u.lines_added,
    lines_removed: u.lines_removed,
    model_ms: u.model_ms,
    ...(opts.cwd ? { branch: gitBranch(opts.cwd) } : {}),
  });
  return u;
}

/** The branch the work actually landed on — the one thing the transcript doesn't know. */
function gitBranch(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null; // not a repo, or git is busy — a missing branch is not worth a log line
  }
}

const TICK_MS = 10_000;
const fingerprint = (u: SessionUsage) => `${u.turns}:${u.context_tokens}:${u.cost_usd ?? ""}`;
const lastSeen = new Map<string, string>();

/** Push usage to the wall as it moves — a card that has been running an hour should say what it cost. */
export function startUsageTicker(): void {
  const tick = () => {
    for (const s of sessions.list({ status: "live", limit: 60 })) {
      try {
        const u = sessionUsage(s.id);
        if (!u) continue;
        const fp = fingerprint(u);
        if (lastSeen.get(s.id) === fp) continue;
        lastSeen.set(s.id, fp);
        snapshotUsage(s.id);
        bus.publish({ topic: "session.usage", session_id: s.id, usage: u });
      } catch {
        // a cost line is never worth taking the daemon down for
      }
    }
  };
  setInterval(tick, TICK_MS).unref?.();
  console.log(`[usage] terminal cost/turns/context from each CLI transcript every ${TICK_MS / 1000}s`);
}
