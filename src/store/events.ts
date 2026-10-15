import { db } from "./db.js";
import { now } from "./util.js";
import { searchIndex } from "./search.js";
import { describeTool } from "../focus.js";

const ACTIVITY_CAP = 80;

// Defensive: run_events.payload is whatever shape the backend emitted this message as — normalized
// per-backend in runner.ts (backend.parseLine), but never validated against a schema. Any assumption
// here (assistant/tool_use for claude, function_call for codex, etc.) is a guess, not a contract, so
// every read is try/catch'd and a miss just falls through to the next candidate shape.
function toolLineFrom(payload: unknown): string | null {
  try {
    const p = payload as any;
    // claude-code stream shape: {type:"assistant", message:{content:[{type:"tool_use", name, input}]}}
    const blocks = p?.message?.content;
    if (Array.isArray(blocks)) {
      const tool = [...blocks].reverse().find((b: any) => b?.type === "tool_use");
      if (tool?.name) return `· ${describeTool(tool.name, tool.input).slice(0, ACTIVITY_CAP)}`;
    }
    // codex-style: {type:"response_item", payload:{type:"function_call", name, arguments}}
    const fc = p?.payload;
    if (fc?.type === "function_call" || fc?.type === "custom_tool_call") {
      let args: any = {};
      try { args = JSON.parse(fc.arguments ?? "{}"); } catch {}
      return `· ${describeTool(fc.name ?? "tool", args).slice(0, ACTIVITY_CAP)}`;
    }
  } catch {
    return null;
  }
  return null;
}

// Assistant prose (claude stream shape) → one-line snippet. Same defensive posture as
// toolLineFrom: payload shapes are per-backend guesses, a miss returns null.
function textLineFrom(payload: unknown): string | null {
  try {
    const blocks = (payload as any)?.message?.content;
    if (!Array.isArray(blocks)) return null;
    const text = [...blocks].reverse().find((b: any) => b?.type === "text" && b?.text?.trim());
    if (!text) return null;
    return String(text.text).trim().replace(/\s+/g, " ").slice(0, 160);
  } catch {
    return null;
  }
}

export const events = {
  add(run_id: string, type: string, payload: unknown): void {
    db.prepare(
      "INSERT INTO run_events (run_id,ts,type,payload) VALUES (?,?,?,?)"
    ).run(run_id, now(), type, JSON.stringify(payload));
    searchIndex.indexEvent(run_id, type, payload);
  },
  list(run_id: string): Array<{ ts: string; type: string; payload: string }> {
    return db
      .prepare("SELECT ts,type,payload FROM run_events WHERE run_id = ? ORDER BY id ASC")
      .all(run_id) as any[];
  },
  // Stall detector's "has this run gone quiet" clock. Cheapest possible read — one indexed row.
  lastEventTs(run_id: string): string | null {
    const row = db.prepare("SELECT ts FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(run_id) as
      | { ts: string }
      | undefined;
    return row?.ts ?? null;
  },
  // Non-cooperative backstop for occupantFromRun: when a run has no declared steps, derive a
  // best-effort "what's it doing" line from its latest streamed tool call. Cheap by construction —
  // only the last ~15 events, only called for active runs (bounded by concurrency caps).
  lastActivity(run_id: string): string | null {
    const rows = db
      .prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 15")
      .all(run_id) as Array<{ payload: string }>;
    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(row.payload); } catch { continue; }
      const line = toolLineFrom(payload);
      if (line) return line;
    }
    return null;
  },
  // Fleet-card terminal tail: the last few HUMAN-READABLE lines of a run — tool calls via
  // describeTool, assistant text as a snippet. Raw payloads stay in /runs/:id/events for the full
  // transcript view; this is the cheap "proof of life" strip. Newest-last (render top→bottom).
  tailLines(run_id: string, limit = 8): string[] {
    const lim = Math.min(Math.max(limit, 1), 30);
    const rows = db
      .prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?")
      .all(run_id, lim * 4) as Array<{ payload: string }>;
    const out: string[] = [];
    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(row.payload); } catch { continue; }
      const line = toolLineFrom(payload) ?? textLineFrom(payload);
      if (line) out.push(line);
      if (out.length >= lim) break;
    }
    return out.reverse();
  },
  // Highest-volume table in the DB (one row per streamed message, every run) — pruned periodically
  // from the monitor sweep, never per-insert (a NOT IN...LIMIT scan on every streamed message would
  // be far too hot a query at this table's row count).
  prune(cap: number): void {
    try {
      db.prepare(`DELETE FROM run_events WHERE id NOT IN (SELECT id FROM run_events ORDER BY id DESC LIMIT ?)`).run(cap);
    } catch {}
  },
};
