import { execFileSync, spawn, type ChildProcess } from "node:child_process";

// The store-free half of awake.ts: hold a `caffeinate -i` assertion while a `busy()` says so. Split out
// so `chronos host` (src/hostd) can keep ITS Mac awake with the same code — awake.ts reads the brain's
// dispatcher and DB, and a host must never open a Chronos database of its own.
// Ceiling: caffeinate cannot survive a closed lid — clamshell needs external power + display or
// root `pmset`.

export function onAcPower(pmsetOutput: string): boolean {
  return !/'Battery Power'/.test(pmsetOutput);
}

/** The internal battery's charge from `pmset -g ps`, or null (a desktop Mac, an unreadable line). */
export function batteryPct(pmsetOutput: string): number | null {
  const m = /InternalBattery[^\n]*?\t(\d{1,3})%/.exec(pmsetOutput) ?? /\b(\d{1,3})%;/.exec(pmsetOutput);
  return m ? Math.min(100, Number(m[1])) : null;
}

export type Power = { ac: boolean; pct: number | null };

export function readPower(): Power {
  try {
    const out = execFileSync("pmset", ["-g", "ps"], { encoding: "utf8", timeout: 5_000 });
    return { ac: onAcPower(out), pct: batteryPct(out) };
  } catch {
    return { ac: true, pct: null };
  }
}

export type AwakePolicy = {
  /** Hold on battery too. The brain releases (an unplugged laptop may idle-sleep); a host with live work holds. */
  onBattery: boolean;
  /** …but never below this charge: macOS sleeps a flat battery anyway, better before it is flat. */
  minBatteryPct: number;
};

/** Should the assertion be held right now? Pure. */
export function shouldHold(busy: boolean, p: Power, policy: AwakePolicy): boolean {
  if (!busy) return false;
  if (p.ac) return true;
  if (!policy.onBattery) return false;
  return p.pct == null || p.pct >= policy.minBatteryPct;
}

export type Caffeinate = { tick(): void; stop(): void; held(): boolean };

/** A caffeinate holder ticking every minute. `tag` prefixes its log lines (`[awake]`, `[host]`). */
export function startCaffeinate(o: {
  tag: string;
  busy: () => boolean;
  policy: AwakePolicy;
  power?: () => Power;
  spawnCaffeinate?: () => ChildProcess;
  everyMs?: number;
}): Caffeinate {
  let proc: ChildProcess | null = null;
  const power = o.power ?? readPower;
  const tick = () => {
    let busy = false;
    try { busy = o.busy(); } catch {}
    const p = busy ? power() : { ac: true, pct: null };
    const hold = shouldHold(busy, p, o.policy);
    if (hold && !proc) {
      const c = (o.spawnCaffeinate ?? (() => spawn("caffeinate", ["-i"], { stdio: "ignore" })))();
      proc = c;
      c.on("exit", () => { if (proc === c) proc = null; });
      c.on("error", () => { if (proc === c) proc = null; });
      console.log(`${o.tag} caffeinate on (agents working${p.ac ? "" : `, on battery${p.pct == null ? "" : ` ${p.pct}%`}`})`);
    } else if (!hold && proc) {
      proc.kill();
      proc = null;
      console.log(`${o.tag} caffeinate off (${busy ? `on battery${p.pct == null ? "" : ` ${p.pct}%`}` : "idle"})`);
    }
  };
  const every = setInterval(tick, o.everyMs ?? 60_000);
  every.unref?.();
  const first = setTimeout(tick, 10_000);
  first.unref?.();
  const stop = () => { clearInterval(every); clearTimeout(first); proc?.kill(); proc = null; };
  process.on("exit", () => proc?.kill());
  return { tick, stop, held: () => !!proc };
}
