import { CONFIG } from "./config.js";
import { runs } from "./store.js";
import { notify, notifyInfo, esc } from "./telegram/api.js";

/**
 * Global burn velocity brake.
 *
 * The per-job loop guard (dispatcher.ts) catches a cycle that keeps reusing one job NAME. It does
 * nothing for a fleet that is merely too fast — many names, each under its cap, adding up. On
 * 2026-07-30 the PER-80 cycle spread across `review:PER-80`, its `fallback:` clones and
 * `ideas:followups:PER-80` and pushed 101 runs in a single hour against a normal peak of ~37.
 *
 * Two signals, because neither is sufficient alone:
 *  - RUNS/hour is the one that would have caught that day: the loop's runs were rate-limited or on a
 *    fallback backend, so they reported $0.00 and a dollar alarm stayed silent through 225 runs.
 *  - USD/hour catches the opposite shape — a few very expensive runs that never trip a count.
 *
 * Trailing 60-minute window, sampled every `burnSampleMin`. Crossing the ALERT threshold pings once
 * per crossing; crossing HALT refuses every dispatch until the window drains. Self-healing: the
 * window is a query, not a counter, so a quiet hour clears it with nothing to reset.
 */
const WINDOW_MS = 3600_000;

export type BurnState = { runs: number; usd: number; level: "ok" | "alert" | "halt"; why: string };

export function burnState(): BurnState {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const n = runs.countStartedSince(since);
  const usd = runs.spentSince(since);
  const over = (limit: number, v: number) => limit > 0 && v >= limit;

  if (over(CONFIG.burnHaltRunsPerHour, n))
    return { runs: n, usd, level: "halt", why: `${n} runs in the last hour (halt at ${CONFIG.burnHaltRunsPerHour})` };
  if (over(CONFIG.burnHaltUsdPerHour, usd))
    return { runs: n, usd, level: "halt", why: `$${usd.toFixed(2)} in the last hour (halt at $${CONFIG.burnHaltUsdPerHour})` };
  if (over(CONFIG.burnAlertRunsPerHour, n))
    return { runs: n, usd, level: "alert", why: `${n} runs in the last hour (alert at ${CONFIG.burnAlertRunsPerHour})` };
  if (over(CONFIG.burnAlertUsdPerHour, usd))
    return { runs: n, usd, level: "alert", why: `$${usd.toFixed(2)} in the last hour (alert at $${CONFIG.burnAlertUsdPerHour})` };
  return { runs: n, usd, level: "ok", why: "" };
}

// Dispatch choke point: non-null reason means refuse. Read fresh (not from the sampler's cache) so a
// burst between two samples is still stopped at the door.
export function burnHalted(): string | null {
  const s = burnState();
  return s.level === "halt" ? `burn guard: ${s.why}` : null;
}

let lastLevel: BurnState["level"] = "ok";

function sample() {
  const s = burnState();
  if (s.level === lastLevel) return; // only speak on a transition — an alarm every 2 minutes is noise
  const prev = lastLevel;
  lastLevel = s.level;

  if (s.level === "halt") {
    console.error(`[burn-guard] HALT — ${s.why}`);
    void notify(
      `🚨 <b>EMERGENCY — burn halt</b>\n${esc(s.why)}\n` +
        `Last hour: <b>${s.runs} runs</b> · <b>$${s.usd.toFixed(2)}</b>\n` +
        `All dispatch is BLOCKED until the hour drains. Check <code>mc runs</code> for what is looping.`
    ).catch(() => {});
    return;
  }
  if (s.level === "alert") {
    console.warn(`[burn-guard] alert — ${s.why}`);
    void notify(
      `⚠️ <b>Burn rate</b> — ${esc(s.why)}\nLast hour: <b>${s.runs} runs</b> · <b>$${s.usd.toFixed(2)}</b>`
    ).catch(() => {});
    return;
  }
  if (prev !== "ok") {
    console.log(`[burn-guard] back to normal — ${s.runs} runs / $${s.usd.toFixed(2)} in the last hour`);
    void notifyInfo(`✅ <b>Burn rate normal</b> — ${s.runs} runs · $${s.usd.toFixed(2)} in the last hour.`).catch(() => {});
  }
}

export function startBurnGuard() {
  const min = CONFIG.burnSampleMin;
  if (min <= 0) { console.log("[burn-guard] off"); return; }
  setInterval(sample, min * 60_000);
  console.log(
    `[burn-guard] every ${min}m · alert ${CONFIG.burnAlertRunsPerHour} runs/h or $${CONFIG.burnAlertUsdPerHour}/h` +
      ` · halt ${CONFIG.burnHaltRunsPerHour} runs/h or $${CONFIG.burnHaltUsdPerHour}/h`
  );
}
