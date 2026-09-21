import { CONFIG } from "./config.js";
import { calEvents } from "./store.js";
import { desktop } from "./notify.js";
import { notify as tgNotify } from "./telegram.js";

// Fire a Mac + Telegram alert N minutes before each timed calendar event. Checks once a minute.
const alerted = new Set<string>();
const escTg = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function tick() {
  const lead = CONFIG.reminderLeadMin;
  const now = Date.now();
  const from = new Date(now).toISOString();
  const to = new Date(now + (lead + 1) * 60000).toISOString();
  let evs: any[] = [];
  try {
    evs = calEvents.agenda(from, to);
  } catch {
    return;
  }
  for (const e of evs) {
    if (e.all_day) continue;
    const t = new Date(e.start).getTime();
    const mins = (t - now) / 60000;
    if (mins <= 0 || mins > lead) continue;
    const key = `${e.id}|${e.start}`;
    if (alerted.has(key)) continue;
    alerted.add(key);
    const when = new Date(e.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const m = Math.max(1, Math.round(mins));
    const cal = (e.calendar || "").replace(/@.*/, "");
    console.log(`[reminders] alert: "${e.title}" in ${m} min (${when})`);
    desktop(`⏰ In ${m} min · ${e.title}`, `${when}${e.location ? " · " + e.location : ""}${cal ? " · " + cal : ""}`);
    tgNotify(
      `⏰ <b>In ${m} min</b> — ${escTg(e.title)} · ${when}${cal ? ` [${escTg(cal)}]` : ""}${e.location ? `\n📍 ${escTg(e.location)}` : ""}`
    ).catch(() => {});
  }
  if (alerted.size > 1000) alerted.clear();
}

export function startReminders() {
  if (!CONFIG.reminderLeadMin) {
    console.log("[reminders] disabled (CHRONOS_REMINDER_LEAD=0)");
    return;
  }
  console.log(`[reminders] event alerts ${CONFIG.reminderLeadMin} min before (Mac + Telegram)`);
  setInterval(tick, 60000).unref?.();
  tick();
}
