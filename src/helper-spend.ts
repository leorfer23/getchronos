/**
 * In-process counter for Chronos helper LLM calls (titles, digests, worklog, lessons).
 *
 * These never create a `runs` or `sessions` row — historically invisible on /stats. Process-local
 * on purpose: a daemon restart zeros the counter (the day log already froze session/run spend).
 * Exposed on /api/stats so the next efficiency pass can see helper churn alongside the ledger.
 */
import { estimateUsd } from "./pricing.js";

export type HelperKind =
  | "title"
  | "summary"
  | "digest"
  | "worklog"
  | "lesson"
  | "conflict"
  | "ticket-summary"
  | "route"
  | "other";

const HELPER_KINDS: HelperKind[] = [
  "title",
  "summary",
  "digest",
  "worklog",
  "lesson",
  "conflict",
  "ticket-summary",
  "route",
  "other",
];

type Bucket = {
  calls: number;
  estimated_usd: number;
  tokens_in: number;
  tokens_out: number;
};

const blank = (): Bucket => ({ calls: 0, estimated_usd: 0, tokens_in: 0, tokens_out: 0 });

const byKind = new Map<HelperKind, Bucket>();
let total = blank();
const startedAt = new Date().toISOString();

function bump(kind: HelperKind, delta: Bucket) {
  const b = byKind.get(kind) ?? blank();
  b.calls += delta.calls;
  b.estimated_usd += delta.estimated_usd;
  b.tokens_in += delta.tokens_in;
  b.tokens_out += delta.tokens_out;
  byKind.set(kind, b);
  total.calls += delta.calls;
  total.estimated_usd += delta.estimated_usd;
  total.tokens_in += delta.tokens_in;
  total.tokens_out += delta.tokens_out;
}

/**
 * Record one helper invocation. Pass token counts when known (stream-json one-shot); otherwise
 * only the call count moves — still enough to spot digest double-fires.
 */
export function noteHelperCall(
  kind: HelperKind,
  opts: {
    model?: string | null;
    tokens_in?: number | null;
    tokens_out?: number | null;
    cost_usd?: number | null;
  } = {},
): void {
  const tin = opts.tokens_in ?? 0;
  const tout = opts.tokens_out ?? 0;
  const usd =
    opts.cost_usd != null && Number.isFinite(opts.cost_usd)
      ? opts.cost_usd
      : estimateUsd({ model: opts.model, tokens_in: tin || null, tokens_out: tout || null }) ?? 0;
  bump(kind, {
    calls: 1,
    estimated_usd: usd,
    tokens_in: tin,
    tokens_out: tout,
  });
}

/** Snapshot since this daemon process started. */
export function helperSpendSnapshot(): {
  since: string;
  calls: number;
  estimated_usd: number;
  tokens_in: number;
  tokens_out: number;
  by_kind: Record<string, Bucket>;
} {
  const kinds: Record<string, Bucket> = {};
  for (const k of HELPER_KINDS) {
    const v = byKind.get(k) ?? blank();
    kinds[k] = {
      calls: v.calls,
      estimated_usd: Math.round(v.estimated_usd * 1e6) / 1e6,
      tokens_in: v.tokens_in,
      tokens_out: v.tokens_out,
    };
  }
  return {
    since: startedAt,
    calls: total.calls,
    estimated_usd: Math.round(total.estimated_usd * 1e6) / 1e6,
    tokens_in: total.tokens_in,
    tokens_out: total.tokens_out,
    by_kind: kinds,
  };
}

/** Test hook — clear counters between cases. */
export function _resetHelperSpendForTests(): void {
  byKind.clear();
  total = blank();
}
