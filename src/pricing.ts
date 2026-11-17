/**
 * Shared USD estimate from token counts — one table for Desk transcripts, headless backends, and
 * helper one-shots. Labelled as estimate wherever it lands; never pretends to be a vendor total.
 *
 * USD per million tokens [input, output]; cache reads bill at a tenth of input, writes at 1.25×.
 * Override: CHRONOS_PRICE_<MODEL_KEY>="in,out" (same as session-usage historically).
 */

const PRICES: Array<[RegExp, number, number]> = [
  [/opus/i, 15, 75],
  [/sonnet/i, 3, 15],
  [/haiku/i, 1, 5],
  [/gpt-5|o3|o4|codex/i, 5, 15],
  [/gpt-4\.1|gpt-4o/i, 2.5, 10],
  [/grok/i, 3, 15],
];

/** [input_per_M, output_per_M] for a model id / alias. Unknown → sonnet workhorse rates. */
export function priceRates(model: string | null | undefined): [number, number] {
  const m = model ?? "";
  const key = m.replace(/[^a-z0-9]/gi, "_").toUpperCase();
  const env = process.env[`CHRONOS_PRICE_${key}`];
  if (env) {
    const [i, o] = env.split(",").map(Number);
    if (i > 0 && o > 0) return [i, o];
  }
  for (const [re, i, o] of PRICES) if (re.test(m)) return [i, o];
  return [3, 15];
}

export type TokenUsage = {
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
};

/** Null when there is nothing to price (no tokens at all). */
export function estimateUsd(u: TokenUsage): number | null {
  const tin = u.tokens_in ?? 0;
  const tout = u.tokens_out ?? 0;
  const cr = u.cache_read ?? 0;
  const cw = u.cache_write ?? 0;
  if (!tin && !tout && !cr && !cw) return null;
  const [inRate, outRate] = priceRates(u.model);
  const M = 1_000_000;
  return (
    (tin / M) * inRate +
    (cr / M) * inRate * 0.1 +
    (cw / M) * inRate * 1.25 +
    (tout / M) * outRate
  );
}

/**
 * Prefer a vendor-reported dollar when present; otherwise estimate from tokens and mark it.
 * Used by backends that stream usage but never a `cost` field (grok, cursor subscription, …).
 */
export function pricedOrEstimate(
  reported: number | null | undefined,
  usage: TokenUsage,
): { cost_usd: number | null; cost_estimated: boolean } {
  if (reported != null && Number.isFinite(reported)) {
    return { cost_usd: reported, cost_estimated: false };
  }
  const est = estimateUsd(usage);
  return { cost_usd: est, cost_estimated: est != null };
}

/**
 * Per-model LIST rates with the cache split, $/MTok — the one table the limit post-mortem
 * (src/limit-postmortem.ts) weighs a window's requests with. The vendor does not publish how its
 * subscription windows weigh tokens, so these are weights for SHARES ("$ list-equivalent"), never a
 * claim about how big a window is. Cache writes: 5-minute = 1.25 × input, 1-hour = 2 × input.
 * Order matters: the first pattern that matches the model id wins.
 */
export interface ListRates { in: number; out: number; cacheRead: number }
const LIST_RATES: Array<[RegExp, ListRates]> = [
  [/opus-5-5|opus-5\.5/i, { in: 4, out: 20, cacheRead: 0.2 }],
  [/sonnet-5/i, { in: 2, out: 10, cacheRead: 0.1 }],
  [/haiku-5/i, { in: 0.1, out: 0.5, cacheRead: 0.01 }],
  [/fable/i, { in: 8, out: 40, cacheRead: 0.2 }],
  [/opus/i, { in: 5, out: 25, cacheRead: 0.5 }],
  [/sonnet/i, { in: 3, out: 15, cacheRead: 0.3 }],
  [/haiku/i, { in: 1, out: 5, cacheRead: 0.1 }],
];
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
/** Unknown model ids weigh as the fleet's workhorse, Opus 5.5. */
export function listRates(model: string | null | undefined): ListRates {
  const m = model ?? "";
  for (const [re, r] of LIST_RATES) if (re.test(m)) return r;
  return LIST_RATES[0][1];
}
