import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { bus } from "./bus.js";

// "Focus view": a curated, plain-English feed of an agent session — Understanding → narration → Result —
// derived from each CLI's own on-disk transcript (not by parsing the raw TUI byte stream). Every backend
// works via a per-backend adapter (locate the session's transcript + parse it to FocusEvents). The agent
// is shaped by FOCUS_CONTRACT (terminal.ts) to lead with "Understanding:" and close with "Result:".
//
// The feed also carries what the agent itself never says: a tool call that FAILED ("error"), and the
// links its tool output printed (`gh pr create` writes the PR URL to stdout, and nothing in the
// narration is guaranteed to repeat it). Both come from the tool RESULT records, which this parser
// used to drop — see toolResultEvents.

export type FocusKind = "understanding" | "think" | "say" | "act" | "result" | "user" | "error";
export interface FocusEvent {
  seq: number; // deterministic (recordIndex*1000 + blockIdx) so REST backfill + live poll dedupe cleanly
  kind: FocusKind;
  text: string;
  ts?: number;
}

export interface FocusCtx {
  sessionId: string;
  backend: string;
  cwd: string;
  configDir: string;
  sinceMs: number; // spawn time — used to pick the newest transcript for CLIs that don't let us pin its name
  // The workspace's CURSOR_CONFIG_DIR, when its secrets_file sets one. A client's cursor-agent keeps its
  // chats there, not in the operator's personal ~/.cursor — reading ~/.cursor would show nothing for
  // that client and could surface the operator's own chats instead.
  cursorConfigDir?: string;
  // On-disk chat UUID when it differs from sessionId (legacy unpinned grok: Chronos row id ≠ grok's
  // minted UUID). Bus events stay keyed by sessionId; locate uses this for the transcript path.
  transcriptSessionId?: string;
}

const focusMetricsSince = new Date().toISOString();
const cursorMetrics = {
  reads: 0,
  incremental_reads: 0,
  full_reads: 0,
  rows_read: 0,
  historical_rows_skipped: 0,
  resets: 0,
  errors: 0,
};

/** Process-local proof that Cursor polling is reading deltas rather than replaying its whole DB. */
export function focusEfficiencySnapshot() {
  return {
    since: focusMetricsSince,
    cursor: { ...cursorMetrics },
  };
}

// ──────────────────────── shared block helpers ────────────────────────

// The agent works under a contract (FOCUS_CONTRACT): lead a turn with "Understanding:" and close with
// "Summary:" (older sessions: "Result:"). Tag those so the UI can pin them; everything else is plain narration.
function phaseOf(text: string): FocusKind {
  const head = text.slice(0, 24).toLowerCase();
  if (/^\*{0,2}understanding\*{0,2}\s*[:\-]/.test(head)) return "understanding";
  if (/^\*{0,2}(summary|result)\*{0,2}\s*[:\-]/.test(head)) return "result";
  return "say";
}

// The summary closes the reply, after the details and Next steps, so it usually shares a text block with
// them. Split the last "Summary:" paragraph off that block so it still pins as the result.
const CLOSER = /(^|\n)[ \t]*(#+[ \t]*)?\*{0,2}(summary|result)\*{0,2}[ \t]*[:\-—]/gi;
export function phased(text: string, seq: number, ts?: number): FocusEvent[] {
  const t = (text ?? "").trim();
  const kind = phaseOf(t);
  if (kind !== "say") return mkEvents(kind, t, seq, ts);
  let at = -1;
  for (const m of t.matchAll(CLOSER)) at = m.index! + m[1].length;
  if (at <= 0) return mkEvents("say", t, seq, ts);
  return [...mkEvents("say", t.slice(0, at), seq, ts), ...mkEvents("result", t.slice(at), seq + 500, ts)];
}

const one = (s: any, n = 90) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Collapse a tool call to one plain activity line — the "code diff shit" the user doesn't want to read.
export function describeTool(name: string, input: any): string {
  const inp = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Edit": case "Write": case "Read": case "NotebookEdit":
      return `${name} ${one(inp.file_path ?? inp.notebook_path ?? "", 100)}`;
    case "Bash": case "shell": case "exec": case "run_terminal_command": case "local_shell":
      return `run ${one(inp.command ?? (Array.isArray(inp) ? inp.join(" ") : ""))}`;
    case "Grep": return `search ${one(inp.pattern, 40)}`;
    case "Glob": return `find ${one(inp.pattern, 40)}`;
    case "Task": return `delegate: ${one(inp.description ?? "", 60)}`;
    case "apply_patch": case "update_plan": return name.replace("_", " ");
    default: return one(name, 40) + (inp.command ? `: ${one(inp.command)}` : "");
  }
}

// content can be a string, or an array of blocks with various text shapes across CLIs.
function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (typeof b === "string" ? b : b?.text ?? b?.content?.text ?? ""))
      .filter(Boolean)
      .join("");
  return "";
}

function mkEvents(kind: FocusKind, text: string, seq: number, ts?: number): FocusEvent[] {
  const t = (text ?? "").trim();
  return t ? [{ seq, kind, text: t, ts }] : [];
}

// ──────────────────────── per-backend adapters ────────────────────────

interface Adapter {
  locate(ctx: FocusCtx): string | null; // path to the transcript file/db, or null if not found yet
  parse(file: string): FocusEvent[];
  jsonlLine?: (obj: any, lineNo: number) => FocusEvent[]; // set for JSONL backends → enables incremental tail
  incremental?: (file: string, cursor: number) => { events: FocusEvent[]; cursor: number; reset: boolean };
}

// Newest file/dir under `roots` matching `pred`, created/modified at or after `sinceMs` (minus slack).
function newest(roots: string[], sinceMs: number, pred: (name: string, full: string) => string | null): string | null {
  const cutoff = sinceMs - 5000;
  let best: { path: string; mtime: number } | null = null;
  for (const root of roots) {
    let names: string[];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const hit = pred(name, path.join(root, name));
      if (!hit) continue;
      let m: number;
      try { m = fs.statSync(hit).mtimeMs; } catch { continue; }
      if (m < cutoff) continue;
      if (!best || m > best.mtime) best = { path: hit, mtime: m };
    }
  }
  return best?.path ?? null;
}

// Apply `line(obj, lineNo)` over JSONL text, starting at `lineOffset`. Blank/unparseable lines still advance
// lineNo so seq stays aligned between the REST snapshot and the live (incremental) poll.
function parseJsonlText(text: string, line: (obj: any, lineNo: number) => FocusEvent[], lineOffset = 0): FocusEvent[] {
  const out: FocusEvent[] = [];
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    let obj: any;
    try { obj = JSON.parse(l); } catch { return; }
    out.push(...line(obj, lineOffset + i));
  });
  return out;
}

// Read a whole JSONL file (REST snapshot / non-growing backends).
function parseJsonl(file: string, line: (obj: any, lineNo: number) => FocusEvent[]): FocusEvent[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  return parseJsonlText(raw, line);
}

// Split an appended chunk (prev partial `buf` + new `chunk`) into complete-line text + trailing remainder.
// `count` = lines consumed (matches `text.split("\n")` indexing) so the caller advances its line offset in lockstep.
function chunkLines(buf: string, chunk: string): { complete: string; rest: string; count: number } {
  const combined = buf + chunk;
  const nl = combined.lastIndexOf("\n");
  if (nl < 0) return { complete: "", rest: combined, count: 0 }; // no complete line yet
  const complete = combined.slice(0, nl);
  return { complete, rest: combined.slice(nl + 1), count: complete.split("\n").length };
}

// ──────────────────────── tool results: failures and links ────────────────────────
// A tool RESULT is a separate record from the call that produced it, and it carries no tool name —
// only the `tool_use_id` of the call. Remember the one-line description of each call so a failure can
// say WHAT failed ("run npm test failed (exit 1): …") instead of "a tool call failed". Bounded: a
// result lands within a few records of its call, so anything older than the cap is already reported.
const toolLabels = new Map<string, string>();
const MAX_TOOL_LABELS = 500;
function rememberTool(id: unknown, label: string) {
  if (typeof id !== "string" || !id || !label) return;
  toolLabels.set(id, label);
  if (toolLabels.size > MAX_TOOL_LABELS) {
    for (const k of toolLabels.keys()) {
      toolLabels.delete(k);
      if (toolLabels.size <= MAX_TOOL_LABELS) break;
    }
  }
}

// A CLI reports a failure as prose, not a status code: "Error: Exit code 1\n<stderr>", a
// <tool_use_error> wrapper, or a bare message. Keep the exit code when there is one and the first two
// non-empty lines of the reason — enough for the operator to know whether to look, short enough for a row.
const ERR_WRAP = /<\/?tool_use_error>/g;
const EXIT_RE = /(?:^|\n)\s*(?:Error:\s*)?Exit code (\d+)/;
export function failureText(label: string | null, raw: string): string {
  const t = String(raw ?? "").replace(ERR_WRAP, "").trim();
  const exit = EXIT_RE.exec(t);
  const body = t
    .replace(/^Error:\s*/, "")
    .replace(/^Exit code \d+\s*/, "")
    .split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" — ");
  return `${label || "a tool call"} failed${exit ? ` (exit ${exit[1]})` : ""}${body ? `: ${one(body, 200)}` : ""}`;
}

// The operator stopping the agent is not a failure, and an empty-file read is not news.
const NOT_FAILURE = /^(request interrupted|\[request interrupted|the user doesn't want to take this action|operation cancelled)/i;

// Links a tool PRINTED. `gh pr create` writes the PR URL to stdout and the agent may never repeat it,
// so without this the one artifact the operator actually needs exists nowhere but the scrollback.
// Only the shapes the artifact pins understand (session-artifacts.ts), deduped per result, capped.
const PRINTED_URL = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|(?:[\w.-]*\.)?(?:claude\.ai\/(?:artifact|public\/artifacts)|html-docs\.com|docs\.google\.com|notion\.so|notion\.site)\/\S+)/g;
const SCAN_MAX = 20_000; // a result can be a megabyte of log; the link is printed near the top or the end
const MAX_LINKS = 3;
export function printedLinks(text: string): string[] {
  const t = String(text ?? "");
  const head = t.length > SCAN_MAX ? t.slice(0, SCAN_MAX / 2) + "\n" + t.slice(-SCAN_MAX / 2) : t;
  const out: string[] = [];
  for (const m of head.matchAll(PRINTED_URL)) {
    const u = m[0].replace(/[.,;:)\]}'"]+$/, "");
    if (!out.includes(u)) out.push(u);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

/**
 * The events a tool-result record is worth: one "error" when the call failed, one "act" per link its
 * output printed. Everything else about a result stays out of the feed on purpose — the operator
 * reads what the agent did, not what a command printed.
 */
export function toolResultEvents(o: any, lineNo: number): FocusEvent[] {
  const blocks = Array.isArray(o?.message?.content) ? o.message.content : [];
  const out: FocusEvent[] = [];
  const ts = Date.parse(o?.timestamp) || undefined;
  blocks.forEach((b: any, i: number) => {
    if (b?.type !== "tool_result") return;
    const label = typeof b.tool_use_id === "string" ? toolLabels.get(b.tool_use_id) ?? null : null;
    const body = typeof b.content === "string" ? b.content : textOf(b.content);
    const detail = body || (typeof o.toolUseResult === "string" ? o.toolUseResult : "");
    const seq = lineNo * 1000 + i;
    if (b.is_error && !NOT_FAILURE.test(detail.trim())) out.push(...mkEvents("error", failureText(label, detail), seq, ts));
    for (const [j, url] of printedLinks(detail).entries()) out.push(...mkEvents("act", `printed ${url}`, seq + 100 + j, ts));
  });
  return out;
}

// claude: <configDir>/projects/<slug(cwd)>/<sessionId>.jsonl — pinned by --session-id, so located by name.
export const claudeLine = (o: any, lineNo: number): FocusEvent[] => {
  // human-typed input: user record whose content is a plain string (tool results are arrays carrying
  // toolUseResult; injected reminders/command output are flagged isMeta). Show it so Focus mirrors what
  // The operator sent — otherwise it only appears in Raw.
  if (o?.type === "user" && typeof o?.message?.content === "string" && o.toolUseResult === undefined && !o.isMeta && !o.isSidechain) {
    const ts = Date.parse(o.timestamp) || undefined;
    const text = o.message.content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (text.startsWith("<command-")) return []; // slash-command plumbing, not a typed message
    return mkEvents("user", text, lineNo * 1000, ts);
  }
  // a tool RESULT: not narration, but the only record of a failure or of a link a command printed.
  if (o?.type === "user" && Array.isArray(o?.message?.content) && !o.isSidechain) return toolResultEvents(o, lineNo);
  if (o?.type !== "assistant" || !Array.isArray(o?.message?.content)) return [];
  const ts = Date.parse(o.timestamp) || undefined;
  const out: FocusEvent[] = [];
  o.message.content.forEach((b: any, i: number) => {
    const seq = lineNo * 1000 + i;
    if (b?.type === "thinking") out.push(...mkEvents("think", b.thinking, seq, ts));
    else if (b?.type === "text") out.push(...phased(b.text, seq, ts));
    else if (b?.type === "tool_use") {
      const act = describeTool(b.name, b.input);
      rememberTool(b.id, act);
      out.push(...mkEvents("act", act, seq, ts));
    }
  });
  return out;
};
const claudeAdapter: Adapter = {
  locate(ctx) {
    const root = path.join(ctx.configDir, "projects");
    try {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, `${ctx.sessionId}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    } catch {}
    return null;
  },
  parse: (file) => parseJsonl(file, claudeLine),
  jsonlLine: claudeLine,
};

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl — codex owns the uuid, so pick the newest
// rollout created after spawn. Events: response_item{message/assistant, reasoning, function_call}.
const codexLine = (o: any, lineNo: number): FocusEvent[] => {
  if (o?.type !== "response_item") return [];
  const p = o.payload ?? {};
  const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) || undefined : undefined;
  if (p.type === "message" && p.role === "assistant") {
    const txt = textOf(p.content);
    return phased(txt, lineNo * 1000, ts);
  }
  if (p.type === "reasoning") return mkEvents("think", textOf(p.summary), lineNo * 1000, ts);
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    let args: any = {}; try { args = JSON.parse(p.arguments ?? "{}"); } catch {}
    const act = describeTool(p.name ?? "tool", args);
    rememberTool(p.call_id, act);
    return mkEvents("act", act, lineNo * 1000, ts);
  }
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    // codex hands the result back as JSON in `output`: { output, metadata: { exit_code } }.
    let body = typeof p.output === "string" ? p.output : "";
    let failed = false;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        body = typeof parsed.output === "string" ? parsed.output : body;
        failed = Number(parsed.metadata?.exit_code ?? 0) !== 0;
      }
    } catch {}
    const label = typeof p.call_id === "string" ? toolLabels.get(p.call_id) ?? null : null;
    const out: FocusEvent[] = [];
    if (failed && !NOT_FAILURE.test(body.trim())) out.push(...mkEvents("error", failureText(label, body), lineNo * 1000, ts));
    for (const [j, url] of printedLinks(body).entries()) out.push(...mkEvents("act", `printed ${url}`, lineNo * 1000 + 100 + j, ts));
    return out;
  }
  if (p.type === "web_search_call") return mkEvents("act", "web search", lineNo * 1000, ts);
  return [];
};
const codexAdapter: Adapter = {
  locate(ctx) {
    const base = path.join(os.homedir(), ".codex", "sessions");
    // day dirs are nested YYYY/MM/DD — flatten to the leaf dirs, then take the newest rollout in them.
    const dayDirs: string[] = [];
    const walk = (p: string, depth: number) => {
      if (depth === 3) { dayDirs.push(p); return; }
      let names: string[]; try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names) if (/^\d+$/.test(n)) walk(path.join(p, n), depth + 1);
    };
    walk(base, 0);
    return newest(dayDirs, ctx.sinceMs, (n, full) => (n.startsWith("rollout-") && n.endsWith(".jsonl") ? full : null));
  },
  parse: (file) => parseJsonl(file, codexLine),
  jsonlLine: codexLine,
};

// grok: ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/chat_history.jsonl — whole messages (the 159MB
// updates.jsonl is token-chunked; chat_history is the clean per-message feed).
// Desk spawns with --session-id / --resume <Chronos id>, so the chat dir IS the session id when pinned.
// Never fall back to "newest under cwd" for a pinned id: every grok terminal on the same cwd would
// then read whichever chat wrote last. Legacy unpinned rows still use newest-since-spawn.
const grokLine = (o: any, lineNo: number): FocusEvent[] => {
  if (o?.type !== "assistant") return []; // skip system/user/tool noise
  const txt = textOf(o.content);
  return phased(txt, lineNo * 1000);
};
const grokAdapter: Adapter = {
  locate(ctx) {
    const enc = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(ctx.cwd));
    const pinId = ctx.transcriptSessionId || ctx.sessionId;
    if (pinId) {
      const pinned = path.join(enc, pinId, "chat_history.jsonl");
      if (fs.existsSync(pinned)) return pinned;
    }
    const dir = newest([enc], ctx.sinceMs, (_n, full) => { try { return fs.statSync(full).isDirectory() ? full : null; } catch { return null; } });
    if (!dir) return null;
    const f = path.join(dir, "chat_history.jsonl");
    return fs.existsSync(f) ? f : null;
  },
  parse: (file) => parseJsonl(file, grokLine),
  jsonlLine: grokLine,
};

// cursor: ~/.cursor/chats/<md5(cwd)>/<chatId>/store.db — SQLite content-addressed blob store. Read blobs in
// rowid order (≈ insertion order), keep the JSON message blobs (binary DAG-pointer blobs are skipped).
// The Desk spawns cursor with --resume <session id>, so the chat dir IS the session id. Never fall back
// to "newest chat": every cursor terminal on the Desk would then read whichever chat wrote last.
export function cursorEventsSince(
  file: string,
  afterRowid: number,
): { events: FocusEvent[]; cursor: number; reset: boolean } {
  cursorMetrics.reads++;
  if (afterRowid > 0) cursorMetrics.incremental_reads++;
  else cursorMetrics.full_reads++;
  const out: FocusEvent[] = [];
  let db: Database.Database | null = null;
  let cursor = afterRowid;
  let reset = false;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const max = Number(
      (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM blobs").get() as { max_rowid: number }).max_rowid,
    );
    reset = max < afterRowid; // database was replaced/compacted under the same path
    if (reset) cursorMetrics.resets++;
    const start = reset ? 0 : afterRowid;
    const rows = db
      .prepare("SELECT rowid, data FROM blobs WHERE rowid > ? ORDER BY rowid")
      .all(start) as Array<{ rowid: number; data: Buffer | string }>;
    cursorMetrics.rows_read += rows.length;
    cursorMetrics.historical_rows_skipped += start;
    for (const r of rows) {
      let msg: any;
      try { msg = JSON.parse(r.data.toString("utf8")); } catch { continue; } // binary DAG pointer
      if (msg?.role !== "assistant") continue;
      out.push(...phased(textOf(msg.content), r.rowid * 1000));
    }
    // A writer may append between MAX(rowid) and the rows query (separate SQLite snapshots).
    // Advance through every row we actually observed so the next poll never rereads that race tail.
    cursor = rows.length ? Math.max(max, rows[rows.length - 1].rowid) : max;
  } catch {
    // db locked/absent — leave the cursor untouched so the next poll retries these rows
    cursorMetrics.errors++;
  } finally {
    try { db?.close(); } catch {}
  }
  return { events: out, cursor, reset };
}

const cursorAdapter: Adapter = {
  locate(ctx) {
    const base = path.join(ctx.cursorConfigDir || path.join(os.homedir(), ".cursor"), "chats");
    let hashes: string[]; try { hashes = fs.readdirSync(base); } catch { return null; }
    // Chats are per cwd: the same id resumed from another directory is a second, empty chat. Take
    // the one written last — that is the conversation the live terminal is in.
    let best: { f: string; m: number } | null = null;
    for (const h of hashes) {
      const f = path.join(base, h, ctx.sessionId, "store.db");
      try { const m = fs.statSync(f).mtimeMs; if (!best || m > best.m) best = { f, m }; } catch {}
    }
    return best?.f ?? null;
  },
  parse: (file) => cursorEventsSince(file, 0).events,
  incremental: cursorEventsSince,
};

function adapterFor(backend: string): Adapter {
  if (/^codex/.test(backend)) return codexAdapter;
  if (/^grok/.test(backend)) return grokAdapter;
  if (/^cursor/.test(backend)) return cursorAdapter;
  return claudeAdapter; // claude-code / claude / default
}

// ──────────────────────── public API ────────────────────────

/** Is there a CLI transcript on disk for this session? (A revive only restores what was written.) */
export function hasTranscript(ctx: FocusCtx): boolean {
  try { return !!adapterFor(ctx.backend).locate(ctx); } catch { return false; }
}

// Full snapshot for REST backfill on panel open.
export function snapshotFocus(ctx: FocusCtx): FocusEvent[] {
  const a = adapterFor(ctx.backend);
  const f = a.locate(ctx);
  return f ? a.parse(f) : [];
}

// ── live poll → bus ──
// Per tail: byte offset already consumed, matching line offset (seq alignment), and any partial trailing line
// awaiting its newline. seen-Set stays as a cheap dedupe safety net (covers the truncate→reset-to-0 path).
interface Tail {
  timer: NodeJS.Timeout;
  poll: () => void;
  events: FocusEvent[];
  seen: Set<number>;
  file: string | null;
  offset: number;
  recordCursor: number;
  lineOffset: number;
  buf: string;
  busy: boolean;
}
const tails = new Map<string, Tail>();
const POLL_MS = 700; // ponytail: incremental tail — stat + read only appended bytes; cost is O(new lines), not file size
const MAX_READ = 1 << 20; // 1 MiB per poll — huge single jumps (compacted rewrites) still progress over ticks
const MAX_SEEN = 50_000; // cap dedupe set so multi-hour sessions can't grow unbounded

export function startFocus(ctx: FocusCtx) {
  if (tails.has(ctx.sessionId)) return;
  const a = adapterFor(ctx.backend);
  const t: Tail = {
    timer: null as any,
    poll: () => {},
    events: [],
    seen: new Set(),
    file: null,
    offset: 0,
    recordCursor: 0,
    lineOffset: 0,
    buf: "",
    busy: false,
  };
  const emit = (evs: FocusEvent[]) => {
    for (const ev of evs) {
      if (t.seen.has(ev.seq)) continue;
      t.seen.add(ev.seq);
      // Only claude and codex stamp their records. For the others this poll IS the clock: the event
      // was written since the last tick, so "now" is right to within POLL_MS — and a Focus timeline
      // with no clock cannot say how long anything took, which is half of what it is for.
      if (!ev.ts) ev.ts = Date.now();
      t.events.push(ev);
      bus.publish({ topic: "focus.event", session_id: ctx.sessionId, event: ev });
    }
    // Incremental readers are driven by a durable offset/cursor, so this is only a safety net.
    if ((a.jsonlLine || a.incremental) && t.seen.size > MAX_SEEN) t.seen.clear();
  };
  const poll = () => {
    if (t.busy) return; // skip tick if previous poll still on the stack (slow SQLite / huge chunk)
    t.busy = true;
    try {
      let file: string | null;
      try { file = a.locate(ctx); } catch { return; }
      if (!file) return;
      if (file !== t.file) {
        t.file = file;
        t.offset = 0;
        t.recordCursor = 0;
        t.lineOffset = 0;
        t.buf = "";
        t.events = [];
        t.seen.clear();
      }
      if (a.incremental) {
        try {
          const batch = a.incremental(file, t.recordCursor);
          if (batch.reset) { t.events = []; t.seen.clear(); }
          t.recordCursor = batch.cursor;
          emit(batch.events);
        } catch {}
        return;
      }
      if (!a.jsonlLine) { try { emit(a.parse(file)); } catch {} return; }
      let size: number;
      try { size = fs.statSync(file).size; } catch { return; }
      if (size < t.offset) { t.offset = 0; t.lineOffset = 0; t.buf = ""; t.events = []; t.seen.clear(); } // truncate/restart → full re-read
      if (size <= t.offset) return; // no growth
      const toRead = Math.min(size - t.offset, MAX_READ);
      let chunk: string, read = 0;
      try {
        const fd = fs.openSync(file, "r");
        try {
          const b = Buffer.allocUnsafe(toRead);
          read = fs.readSync(fd, b, 0, b.length, t.offset);
          chunk = b.toString("utf8", 0, read);
        } finally { fs.closeSync(fd); }
      } catch { return; }
      t.offset += read;
      const { complete, rest, count } = chunkLines(t.buf, chunk);
      t.buf = rest;
      if (count) { try { emit(parseJsonlText(complete, a.jsonlLine, t.lineOffset)); } catch {} t.lineOffset += count; }
    } finally {
      t.busy = false;
    }
  };
  t.poll = poll;
  tails.set(ctx.sessionId, t);
  // Prime after the spawn stack unwinds. The first Focus request then reads this process-local cache
  // instead of synchronously reparsing a multi-megabyte transcript on the HTTP event loop.
  queueMicrotask(() => { if (tails.get(ctx.sessionId) === t) poll(); });
  t.timer = setInterval(poll, POLL_MS);
  t.timer.unref?.();
}

/** The accumulated events for a live tail, or null when this process is not tailing that session. */
export function liveFocusEvents(sessionId: string): FocusEvent[] | null {
  const t = tails.get(sessionId);
  return t ? [...t.events] : null;
}

/** Consume the final transcript delta before a live process is closed and summarized. */
export function refreshLiveFocus(sessionId: string): FocusEvent[] | null {
  const t = tails.get(sessionId);
  if (!t) return null;
  t.poll();
  return [...t.events];
}

export function stopFocus(sessionId: string) {
  const t = tails.get(sessionId);
  if (t) { clearInterval(t.timer); tails.delete(sessionId); }
}

// ── self-check: parsers are the load-bearing bit; assert each backend's block shapes survive ──
export function demo() {
  // claude block shapes
  const cl = parseShim(claudeAdapter, [
    { type: "user", message: { content: "please fix the login bug\n<system-reminder>ignore this</system-reminder>" } },
    { type: "user", message: { content: [{ type: "tool_result", content: "..." }] }, toolUseResult: { stdout: "" } },
    { type: "assistant", timestamp: "2026-07-13T00:00:00Z", message: { content: [
      { type: "text", text: "**Understanding:** fix login" },
      { type: "tool_use", name: "Edit", input: { file_path: "/a/auth.ts" } },
      { type: "text", text: "Result: done" },
    ] } },
  ]);
  console.assert(cl[0].kind === "user" && cl[0].text === "please fix the login bug", "claude user text (reminder stripped)");
  console.assert(cl[1].kind === "understanding" && cl[2].kind === "act" && cl[2].text.includes("auth.ts") && cl[3].kind === "result", "claude parse (a clean tool_result adds nothing)");
  console.assert(cl[1].seq === 2000 && cl[2].seq === 2001, "seq = lineNo*1000+blockIdx");
  // claude tool results: a failure names the call that failed, a printed link becomes an act
  const fail = parseShim(claudeAdapter, [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "Exit code 1\n3 tests failed" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "https://github.com/o/r/pull/12\n" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "Request interrupted by user" }] } },
  ]);
  console.assert(fail.length === 3 && fail[1].kind === "error" && fail[1].text === "run npm test failed (exit 1): 3 tests failed", "tool failure names the call, keeps the exit code");
  console.assert(fail[2].kind === "act" && fail[2].text === "printed https://github.com/o/r/pull/12", "a printed PR link becomes an act, so the artifact pins find it");
  // codex
  const cx = parseShim(codexAdapter, [
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Understanding: map the SDK" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":\"ls -la\"}" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ignore me" }] } },
  ]);
  console.assert(cx.length === 2 && cx[0].kind === "understanding" && cx[1].kind === "act" && cx[1].text.includes("ls -la"), "codex parse");
  // grok
  const gk = parseShim(grokAdapter, [
    { type: "system", content: "sys" },
    { type: "user", content: [{ type: "text", text: "hi" }] },
    { type: "assistant", content: [{ type: "text", text: "Result: shipped it" }] },
  ]);
  console.assert(gk.length === 1 && gk[0].kind === "result", "grok parse");
  const tail = phased("- PR open\n- tests green\n\n**Next steps**\n- rebase\n\n**Summary:** shipped it", 3000);
  console.assert(tail.length === 2 && tail[0].kind === "say" && tail[1].kind === "result" && tail[1].text === "**Summary:** shipped it" && tail[1].seq === 3500, "trailing Summary splits off as result");
  // incremental tail: seq stays aligned via lineOffset, partial trailing line re-buffers until its newline.
  const rec = '{"type":"assistant","message":{"content":[{"type":"text","text":"Result: a"}]}}';
  const inc = parseJsonlText(rec, claudeLine, 5);
  console.assert(inc[0].seq === 5000 && inc[0].kind === "result", "parseJsonlText lineOffset → seq=lineNo*1000");
  const c1 = chunkLines("", "x\ny\nzpart");
  console.assert(c1.complete === "x\ny" && c1.rest === "zpart" && c1.count === 2, "chunkLines holds partial trailing line");
  const c2 = chunkLines("zpart", "ial\n");
  console.assert(c2.complete === "zpartial" && c2.rest === "" && c2.count === 1, "chunkLines rejoins buffered remainder");
  console.log("focus.demo OK");
}

// test shim: run an adapter's jsonl parser over in-memory records by writing a temp file
function parseShim(a: Adapter, records: any[]): FocusEvent[] {
  const tmp = path.join(os.tmpdir(), `focus-demo-${records.length}-${a === codexAdapter ? "cx" : a === grokAdapter ? "gk" : "cl"}.jsonl`);
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n"));
  try { return a.parse(tmp); } finally { try { fs.unlinkSync(tmp); } catch {} }
}
