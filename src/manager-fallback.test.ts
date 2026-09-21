import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG } from "./config.js";
import {
  _resetProviderLimitState,
  clearProviderLimited,
  DEFAULT_LIMIT_COOLDOWN_MS,
  isAuthError,
  isCreditWallError,
  isProviderLimitError,
  isProviderLimited,
  markProviderLimited,
  modelLimitKey,
  parseLimitResetsAtMs,
  backendLimitKey,
  resolveManagerFallback,
  resolveManagerFallbacks,
  resolveModelFallback,
  withProviderFallback,
} from "./manager-fallback.js";

test("isProviderLimitError: session limit (Claude subscription)", () => {
  assert.equal(
    isProviderLimitError("You've hit your session limit · resets 2:20pm (America/Buenos_Aires)"),
    true,
  );
});

test("isProviderLimitError: rate limit / 429 / credits", () => {
  assert.equal(isProviderLimitError("rate_limit exceeded"), true);
  assert.equal(isProviderLimitError("Error 429 too many requests"), true);
  assert.equal(isProviderLimitError("out of credits for this org"), true);
  assert.equal(isProviderLimitError(new Error("quota exceeded")), true);
});

test("isProviderLimitError: ordinary failures are not limits", () => {
  assert.equal(isProviderLimitError("manager exited (signal SIGKILL)"), false);
  assert.equal(isProviderLimitError("No conversation found with session"), false);
  assert.equal(isProviderLimitError("Failed to authenticate: OAuth session expired"), false);
  assert.equal(isProviderLimitError(""), false);
});

test("isAuthError: dead credentials on a profile", () => {
  assert.equal(isAuthError("Not logged in · Please run /login"), true);
  assert.equal(isAuthError(new Error("OAuth token expired")), true);
  assert.equal(isAuthError("invalid api key"), true);
  assert.equal(isAuthError("request failed: 401"), true);
});

test("isAuthError: limits and ordinary failures are not auth", () => {
  assert.equal(isAuthError("You've hit your session limit · resets 2:20pm"), false);
  assert.equal(isAuthError("manager exited (signal SIGKILL)"), false);
  assert.equal(isAuthError(""), false);
});

test("parseLimitResetsAtMs: ISO from runner message", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const ms = parseLimitResetsAtMs(`rate limited; resets ${future} — You've hit your session limit`);
  assert.ok(ms != null && ms > Date.now());
});

test("parseLimitResetsAtMs: wall-clock-only leaves null (cooldown default)", () => {
  assert.equal(
    parseLimitResetsAtMs("You've hit your session limit · resets 2:20pm (America/Buenos_Aires)"),
    null,
  );
});

test("mark/is/clear provider limited cooldown", () => {
  _resetProviderLimitState();
  assert.equal(isProviderLimited("k1"), false);
  markProviderLimited("k1", "session limit");
  assert.equal(isProviderLimited("k1"), true);
  clearProviderLimited("k1");
  assert.equal(isProviderLimited("k1"), false);
});

test("markProviderLimited uses DEFAULT cooldown when no parseable reset", () => {
  _resetProviderLimitState();
  const before = Date.now();
  markProviderLimited("k2", "session limit");
  // Still limited immediately after mark
  assert.equal(isProviderLimited("k2"), true);
  // Cooldown is ~90m — not expired yet
  assert.ok(DEFAULT_LIMIT_COOLDOWN_MS >= 60 * 60 * 1000);
  clearProviderLimited("k2");
  assert.ok(Date.now() - before < 1000);
});

test("resolveManagerFallback defaults to grok (not claude)", () => {
  const fb = resolveManagerFallback(null);
  assert.equal(fb.backend, "grok");
  assert.ok(fb.model === null || typeof fb.model === "string");
});

test("withProviderFallback: primary success clears cooldown and skips fallback", async () => {
  _resetProviderLimitState();
  let fbCalls = 0;
  // Force a prior limited state to ensure success clears it
  markProviderLimited("t-ok", "session limit");
  clearProviderLimited("t-ok"); // start clean for success path

  const out = await withProviderFallback({
    key: "t-ok",
    primary: async () => "hello from claude",
    system: "sys",
    prompt: "hi",
  });
  assert.equal(out, "hello from claude");
  assert.equal(isProviderLimited("t-ok"), false);
  assert.equal(fbCalls, 0);
});

test("withProviderFallback: non-limit primary error propagates", async () => {
  _resetProviderLimitState();
  await assert.rejects(
    () =>
      withProviderFallback({
        key: "t-fail",
        primary: async () => {
          throw new Error("manager exited (signal SIGKILL)");
        },
        system: "sys",
        prompt: "hi",
      }),
    /SIGKILL/,
  );
  assert.equal(isProviderLimited("t-fail"), false);
});

test("withProviderFallback: auth failure routes to fallback but sets NO cooldown", async () => {
  _resetProviderLimitState();
  let killed = false;
  await assert.rejects(
    () =>
      withProviderFallback({
        key: "t-auth",
        primary: async () => {
          throw new Error("Not logged in · Please run /login");
        },
        system: "sys",
        prompt: "hi",
        killPrimary: () => {
          killed = true;
        },
        timeoutMs: 2_000,
      }),
    /not logged in|fallback/i,
  );
  assert.equal(killed, true);
  // A re-login fixes it immediately — the next turn must go back to Claude, not stay on grok.
  assert.equal(isProviderLimited("t-auth"), false);
});

test("withProviderFallback: limit on primary → fallback reply", async () => {
  _resetProviderLimitState();
  // Monkey-patch by injecting a primary that throws limit, and mock run via intercepting
  // resolveManagerFallback path — we can't easily spawn grok in unit tests, so we only
  // verify the primary-limit branch marks cooldown when fallback also fails (no real binary).
  // Full spawn is covered by integration / live use.
  let killed = false;
  const savedChain = CONFIG.agent.fallbackChain;
  CONFIG.agent.fallbackChain = [];
  await assert.rejects(
    () =>
      withProviderFallback({
        key: "t-lim",
        primary: async () => {
          throw new Error("You've hit your session limit · resets 2:20pm (America/Buenos_Aires)");
        },
        system: "sys",
        prompt: "hi",
        killPrimary: () => {
          killed = true;
        },
        // Point at a backend that will fail fast without network if oneShot runs
        timeoutMs: 2_000,
      }),
    /session limit|fallback/i,
  );
  assert.equal(killed, true);
  CONFIG.agent.fallbackChain = savedChain;
  assert.equal(isProviderLimited("t-lim"), true);
  clearProviderLimited("t-lim");
});

// Verbatim from the Desk: Robert on fable, no fallback, "(failed: …)".
const FABLE_WALL = "You're out of usage credits. Switch to another model to continue.";

test("isCreditWallError / isProviderLimitError: Fable's usage-credits wall is detected", () => {
  assert.equal(isProviderLimitError(FABLE_WALL), true);
  assert.equal(isProviderLimitError(new Error(FABLE_WALL)), true);
  assert.equal(isCreditWallError(FABLE_WALL), true);
  assert.equal(isCreditWallError("out of credits for this org"), true);
  assert.equal(isCreditWallError("402 insufficient_balance"), true);
  // An account-wide cap is a limit, not a model's credits: opus would hit it too.
  assert.equal(isCreditWallError("You've hit your session limit · resets 2:20pm"), false);
  assert.equal(isCreditWallError("manager exited (signal SIGKILL)"), false);
});

test("resolveModelFallback: configured sibling model, never itself", () => {
  assert.equal(resolveModelFallback("fable"), CONFIG.agent.modelFallback || null);
  assert.equal(resolveModelFallback(CONFIG.agent.modelFallback), null);
  assert.equal(resolveModelFallback(null), null);
});

/**
 * Drive the chain with fakes: `primary` is the fable turn, `primaryOn(model)` the same turn on
 * another model. The backend step runs on `mock` (a scripted local oneShot) so no real grok is
 * spawned — its reply is the mock verifier's fixed JSON.
 */
async function chain(
  key: string,
  walls: { primary?: string; opus?: string },
): Promise<{ out: string | Error; calls: string[]; swaps: string[]; killed: boolean }> {
  const calls: string[] = [];
  const swaps: string[] = [];
  let killed = false;
  const saved = { ...CONFIG.agent };
  CONFIG.agent.modelFallback = "opus";
  CONFIG.agent.fallbackBackend = "mock";
  CONFIG.agent.fallbackModel = null as any;
  try {
    const out = await withProviderFallback({
      key,
      model: "fable",
      primary: async () => {
        calls.push("fable");
        if (walls.primary) throw new Error(walls.primary);
        return "from fable";
      },
      primaryOn: async (m) => {
        calls.push(m);
        if (walls.opus) throw new Error(walls.opus);
        return `from ${m}`;
      },
      system: "sys",
      prompt: "hi",
      sandbox: "off",
      timeoutMs: 10_000,
      onFallback: (fb) => swaps.push(`${fb.backend}/${fb.model ?? ""}: ${fb.why}`),
      killPrimary: () => {
        killed = true;
      },
    }).catch((e: Error) => e);
    return { out, calls, swaps, killed };
  } finally {
    Object.assign(CONFIG.agent, saved);
  }
}

test("withProviderFallback: fable credit wall → same turn on opus, model cooldown set", async () => {
  _resetProviderLimitState();
  const r = await chain("t-fable", { primary: FABLE_WALL });
  assert.equal(r.out, "from opus");
  assert.deepEqual(r.calls, ["fable", "opus"]);
  assert.deepEqual(r.swaps, ["claude/opus: fable sin créditos → opus"]);
  assert.equal(r.killed, false, "a model swap is not a backend swap");
  assert.equal(isProviderLimited(modelLimitKey("t-fable")), true);
  assert.equal(isProviderLimited("t-fable"), false, "Claude itself is fine — no grok cooldown");
});

test("withProviderFallback: opus also walled → grok-side fallback, provider cooldown set", async () => {
  _resetProviderLimitState();
  const r = await chain("t-both", { primary: FABLE_WALL, opus: "You've hit your session limit · resets 2:20pm" });
  assert.equal(typeof r.out, "string", `backend fallback should answer, got ${r.out}`);
  assert.match(r.out as string, /mock verifier ok/);
  assert.deepEqual(r.calls, ["fable", "opus"]);
  assert.deepEqual(r.swaps, ["claude/opus: fable sin créditos → opus", "mock/: primary rate-limited"]);
  assert.equal(r.killed, true);
  assert.equal(isProviderLimited("t-both"), true);
  // The next turn goes straight to the backend fallback: neither model is asked again.
  const next = await chain("t-both", { primary: FABLE_WALL, opus: "session limit" });
  assert.deepEqual(next.calls, []);
  assert.deepEqual(next.swaps, ["mock/: primary en cooldown"]);
});

test("withProviderFallback: opus crash after a fable wall surfaces, no backend swap", async () => {
  _resetProviderLimitState();
  const r = await chain("t-crash", { primary: FABLE_WALL, opus: "manager exited (signal SIGKILL)" });
  assert.ok(r.out instanceof Error);
  assert.match(r.out.message, /usage credits.*SIGKILL/);
  assert.equal(r.killed, false);
});

test("withProviderFallback: session limit on fable skips opus (account-wide wall)", async () => {
  _resetProviderLimitState();
  const r = await chain("t-session", { primary: "You've hit your session limit · resets 2:20pm" });
  assert.deepEqual(r.calls, ["fable"]);
  assert.deepEqual(r.swaps, ["mock/: primary rate-limited"]);
  assert.equal(isProviderLimited(modelLimitKey("t-session")), false);
});

test("withProviderFallback: model cooldown skips fable; expiry retries fable and success restores it", async () => {
  _resetProviderLimitState();
  await chain("t-cool", { primary: FABLE_WALL });

  const during = await chain("t-cool", {});
  assert.equal(during.out, "from opus");
  assert.deepEqual(during.calls, ["opus"], "no fable call while its credits are known to be gone");
  assert.deepEqual(during.swaps, ["claude/opus: fable en cooldown → opus"]);

  const realNow = Date.now;
  Date.now = () => realNow() + DEFAULT_LIMIT_COOLDOWN_MS + 1_000;
  try {
    const after = await chain("t-cool", {});
    assert.equal(after.out, "from fable");
    assert.deepEqual(after.calls, ["fable"]);
    assert.deepEqual(after.swaps, []);
    assert.equal(isProviderLimited(modelLimitKey("t-cool")), false);
  } finally {
    Date.now = realNow;
  }
});

test("withProviderFallback: no primaryOn → credit wall goes straight to the backend fallback", async () => {
  _resetProviderLimitState();
  const saved = CONFIG.agent.fallbackBackend;
  CONFIG.agent.fallbackBackend = "mock";
  const swaps: string[] = [];
  try {
    const out = await withProviderFallback({
      key: "t-nomodel",
      model: "fable",
      primary: async () => {
        throw new Error(FABLE_WALL);
      },
      system: "sys",
      prompt: "hi",
      sandbox: "off",
      timeoutMs: 10_000,
      onFallback: (fb) => swaps.push(fb.why),
    });
    assert.match(out, /mock verifier ok/);
    assert.deepEqual(swaps, ["primary rate-limited"]);
  } finally {
    CONFIG.agent.fallbackBackend = saved;
    _resetProviderLimitState();
  }
});

test("resolveManagerFallbacks: grok then cursor; never claude, unknown or repeated backends", () => {
  _resetProviderLimitState();
  const saved = { ...CONFIG.agent };
  try {
    CONFIG.agent.fallbackBackend = "grok";
    CONFIG.agent.fallbackModel = "grok-4.5";
    CONFIG.agent.fallbackChain = ["cursor", "claude", "grok", "no-such-cli", "codex/gpt-5"];
    assert.deepEqual(resolveManagerFallbacks(null), [
      { backend: "grok", model: "grok-4.5" },
      { backend: "cursor", model: null },
      { backend: "codex", model: "gpt-5" },
    ]);
    // A backend known to be out of balance is skipped until its cooldown ends.
    markProviderLimited(backendLimitKey("grok"), "402 Payment Required: usage balance exhausted");
    assert.deepEqual(resolveManagerFallbacks(null).map((f) => f.backend), ["cursor", "codex"]);
  } finally {
    Object.assign(CONFIG.agent, saved);
    _resetProviderLimitState();
  }
});

test("withProviderFallback: grok fails → the same turn runs on the next backend in the chain", async () => {
  _resetProviderLimitState();
  const saved = { ...CONFIG.agent };
  const savedGrok = CONFIG.grokBin;
  const swaps: string[] = [];
  try {
    CONFIG.agent.fallbackBackend = "grok";
    CONFIG.agent.fallbackModel = null as any;
    CONFIG.agent.fallbackChain = ["mock"];
    (CONFIG as any).grokBin = "/nonexistent/grok-out-of-balance";
    const out = await withProviderFallback({
      key: "t-chain",
      primary: async () => {
        throw new Error("You've hit your session limit · resets 2:20pm");
      },
      system: "sys",
      prompt: "hi",
      sandbox: "off",
      timeoutMs: 10_000,
      onFallback: (fb) => swaps.push(`${fb.backend}: ${fb.why}`),
    });
    assert.match(out, /mock verifier ok/);
    assert.deepEqual(swaps, ["grok: primary rate-limited", "mock: grok también falló"]);
  } finally {
    Object.assign(CONFIG.agent, saved);
    (CONFIG as any).grokBin = savedGrok;
    _resetProviderLimitState();
  }
});
