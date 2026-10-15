import { status } from "./dispatcher.js";
import { sessions } from "./store.js";
import { startCaffeinate } from "./caffeinate.js";

export { onAcPower } from "./caffeinate.js";

// Keep the Mac from idle-sleeping while agents are working: hold a `caffeinate -i` assertion
// whenever there are active/queued runs or live terminal sessions AND the Mac is on AC power;
// release it when idle or on battery, so an unplugged laptop can still idle-sleep.
// (A host keeps itself awake on battery too — src/hostd/index.ts; the mechanism is caffeinate.ts.)
// Ceiling: caffeinate cannot survive a closed lid — clamshell needs external power + display or
// root `pmset`. For scheduled overnight work, arm a wake once (survives reboots):
//   sudo pmset repeat wakeorpoweron MTWRFSU 07:50:00
function busy(): boolean {
  const s = status();
  if (s.active > 0 || s.queued > 0) return true;
  return sessions.list({ status: "live" }).length > 0;
}

export function startAwake() {
  startCaffeinate({ tag: "[awake]", busy, policy: { onBattery: false, minBatteryPct: 100 } });
}
