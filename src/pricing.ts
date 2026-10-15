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
