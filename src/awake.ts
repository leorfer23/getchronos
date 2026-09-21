import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { status } from "./dispatcher.js";
import { sessions } from "./store.js";

// Keep the Mac from idle-sleeping while agents are working: hold a `caffeinate -i` assertion
// whenever there are active/queued runs or live terminal sessions AND the Mac is on AC power;
// release it when idle or on battery, so an unplugged laptop can still idle-sleep.
// Ceiling: caffeinate cannot survive a closed lid — clamshell needs external power + display or
// root `pmset`. For scheduled overnight work, arm a wake once (survives reboots):
//   sudo pmset repeat wakeorpoweron MTWRFSU 07:50:00
let proc: ChildProcess | null = null;

function busy(): boolean {
  const s = status();
  if (s.active > 0 || s.queued > 0) return true;
  return sessions.list({ status: "live" }).length > 0;
}

export function onAcPower(pmsetOutput: string): boolean {
  return !/'Battery Power'/.test(pmsetOutput);
}

function acPower(): boolean {
  try {
    return onAcPower(execFileSync("pmset", ["-g", "ps"], { encoding: "utf8", timeout: 5_000 }));
  } catch {
    return true;
  }
}

function tick() {
  const b = busy() && acPower();
  if (b && !proc) {
    proc = spawn("caffeinate", ["-i"], { stdio: "ignore" });
    proc.on("exit", () => { proc = null; });
    console.log("[awake] caffeinate on (agents working)");
  } else if (!b && proc) {
    proc.kill();
    proc = null;
    console.log("[awake] caffeinate off (idle or on battery)");
  }
}

export function startAwake() {
  setInterval(tick, 60_000);
  setTimeout(tick, 10_000);
  process.on("exit", () => proc?.kill());
}
