import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateUsd, pricedOrEstimate, priceRates } from "./pricing.js";
import { noteHelperCall, helperSpendSnapshot, _resetHelperSpendForTests } from "./helper-spend.js";

test("priceRates: known families + env override", () => {
  assert.deepEqual(priceRates("claude-opus-4"), [15, 75]);
  assert.deepEqual(priceRates("claude-sonnet-4"), [3, 15]);
  assert.deepEqual(priceRates("haiku"), [1, 5]);
  assert.deepEqual(priceRates("totally-unknown"), [3, 15]);
  process.env.CHRONOS_PRICE_CUSTOM_X = "9,18";
  assert.deepEqual(priceRates("custom-x"), [9, 18]);
  delete process.env.CHRONOS_PRICE_CUSTOM_X;
});

test("estimateUsd: null with no tokens; cache billed cheaper than input", () => {
  assert.equal(estimateUsd({}), null);
  const plain = estimateUsd({ model: "sonnet", tokens_in: 1_000_000, tokens_out: 0 })!;
  const cached = estimateUsd({ model: "sonnet", tokens_in: 0, cache_read: 1_000_000, tokens_out: 0 })!;
  assert.equal(plain, 3);
  assert.equal(Number(cached.toFixed(2)), 0.3);
});

test("pricedOrEstimate: vendor total wins; else labelled estimate", () => {
  assert.deepEqual(pricedOrEstimate(1.25, { tokens_in: 100 }), { cost_usd: 1.25, cost_estimated: false });
  const est = pricedOrEstimate(null, { model: "sonnet", tokens_in: 1_000_000, tokens_out: 0 });
  assert.equal(est.cost_estimated, true);
  assert.equal(est.cost_usd, 3);
  assert.deepEqual(pricedOrEstimate(null, {}), { cost_usd: null, cost_estimated: false });
});

test("helperSpendSnapshot counts calls by kind", () => {
  _resetHelperSpendForTests();
  noteHelperCall("digest", { model: "haiku", tokens_in: 1000, tokens_out: 100 });
  noteHelperCall("title", { model: "haiku" });
  noteHelperCall("digest", { model: "haiku", tokens_in: 500, tokens_out: 50 });
  const snap = helperSpendSnapshot();
  assert.equal(snap.calls, 3);
  assert.equal(snap.by_kind.digest.calls, 2);
  assert.equal(snap.by_kind.title.calls, 1);
  assert.equal(snap.by_kind.summary.calls, 0, "zero-call helpers stay visible for canary checks");
  assert.ok(snap.estimated_usd > 0);
  _resetHelperSpendForTests();
});
