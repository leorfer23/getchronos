import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

export type AccelOp = "build" | "query";

export interface AccelTelemetryRow {
  id: string;
  workspace_id: string;
  repo_id: string;
  session_id: string | null;
  tool: string;
  op: AccelOp;
  ok: number;
  duration_ms: number;
  budget: number | null;
  input_bytes: number;
  output_bytes: number;
  estimated_output_tokens: number;
  artifact_bytes: number | null;
  head: string | null;
  tool_version: string | null;
  /** Short error code/class only — never a sanitized message body. */
  error: string | null;
  created_at: string;
}

export interface AccelTelemetryInput {
  workspace_id: string;
  repo_id: string;
  session_id: string | null;
  tool: string;
  op: AccelOp;
  ok: boolean;
  duration_ms: number;
  budget: number | null;
  input_bytes: number;
  output_bytes: number;
  estimated_output_tokens: number;
  artifact_bytes: number | null;
  head: string | null;
  tool_version: string | null;
  /** Short code/class (e.g. timeout, output-cap). Never a free-text message. */
  error: string | null;
}

export interface AccelAggregate {
  tool: string;
  op: string;
  calls: number;
  ok: number;
  fail: number;
  duration_ms_p50: number | null;
  duration_ms_p95: number | null;
  input_bytes_sum: number;
  output_bytes_sum: number;
  estimated_output_tokens_sum: number;
  artifact_bytes_sum: number;
  sessions_distinct: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Refuse free-text error bodies — telemetry stores codes only (≤64 chars, no spaces/paths). */
function normalizeErrorCode(error: string | null): string | null {
  if (error == null) return null;
  const code = String(error).trim();
  if (!code) return null;
  if (code.length > 64 || /\s|\//.test(code)) {
    return "error";
  }
  return code;
}

export const accelTelemetry = {
  record(row: AccelTelemetryInput): AccelTelemetryRow {
    const id = randomUUID();
    const created_at = now();
    db.prepare(
      `INSERT INTO accel_telemetry (
        id, workspace_id, repo_id, session_id, tool, op, ok, duration_ms, budget,
        input_bytes, output_bytes, estimated_output_tokens, artifact_bytes,
        head, tool_version, error, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      row.workspace_id,
      row.repo_id,
      row.session_id,
      row.tool,
      row.op,
      row.ok ? 1 : 0,
      row.duration_ms,
      row.budget,
      row.input_bytes,
      row.output_bytes,
      row.estimated_output_tokens,
      row.artifact_bytes,
      row.head,
      row.tool_version,
      normalizeErrorCode(row.error),
      created_at,
    );
    return accelTelemetry.get(id)!;
  },

  get(id: string): AccelTelemetryRow | undefined {
    return db.prepare("SELECT * FROM accel_telemetry WHERE id=?").get(id) as AccelTelemetryRow | undefined;
  },

  /** Content-free 7-day aggregate for /stats efficiency.accelerators. */
  aggregateSince(isoSince: string): AccelAggregate[] {
    const rows = db.prepare(
      `SELECT tool, op, ok, duration_ms, input_bytes, output_bytes, estimated_output_tokens,
              artifact_bytes, session_id
       FROM accel_telemetry WHERE created_at >= ?`,
    ).all(isoSince) as Array<{
      tool: string; op: string; ok: number; duration_ms: number;
      input_bytes: number; output_bytes: number; estimated_output_tokens: number;
      artifact_bytes: number | null; session_id: string | null;
    }>;

    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.tool}\0${r.op}`;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }

    const out: AccelAggregate[] = [];
    for (const g of groups.values()) {
      const durations = g.map((r) => r.duration_ms).sort((a, b) => a - b);
      const sessions = new Set(g.map((r) => r.session_id).filter((s): s is string => !!s));
      out.push({
        tool: g[0].tool,
        op: g[0].op,
        calls: g.length,
        ok: g.filter((r) => r.ok).length,
        fail: g.filter((r) => !r.ok).length,
        duration_ms_p50: percentile(durations, 50),
        duration_ms_p95: percentile(durations, 95),
        input_bytes_sum: g.reduce((s, r) => s + (r.input_bytes || 0), 0),
        output_bytes_sum: g.reduce((s, r) => s + (r.output_bytes || 0), 0),
        estimated_output_tokens_sum: g.reduce((s, r) => s + (r.estimated_output_tokens || 0), 0),
        artifact_bytes_sum: g.reduce((s, r) => s + (r.artifact_bytes || 0), 0),
        sessions_distinct: sessions.size,
      });
    }
    return out.sort((a, b) => a.tool.localeCompare(b.tool) || a.op.localeCompare(b.op));
  },
};
