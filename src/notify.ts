import { execFile } from "node:child_process";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";
import { jobs, runs, tickets } from "./store.js";

const ICON: Record<string, string> = {
  success: "✅", failed: "❌", timeout: "⏱️", killed: "🛑", blocked: "🚫",
  rate_limited: "⏸️", interrupted: "🔌",
};

export function desktop(title: string, message: string) {
  // macOS native notification via osascript. Best-effort.
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  execFile("osascript", [
    "-e",
    `display notification "${esc(message)}" with title "${esc(title)}"`,
  ], () => {});
}

// Fire a desktop notification on every terminal run outcome.
export function startNotify() {
  if (!CONFIG.desktopNotify) {
    console.log("[notify] desktop notifications disabled");
    return;
  }
  console.log("[notify] desktop notifications enabled");
  bus.on("event", (e: any) => {
    if (e.topic === "review.created") {
      const t = e.ticket_id ? tickets.get(e.ticket_id) : undefined;
      desktop(
        `🔍 Chronos: ${t?.key ?? e.ticket_key ?? "build"} needs review`,
        `${t?.title ?? "Build finished"} — Approve / Request changes in Mission Control`
      );
      return;
    }
    if (e.topic === "ci.failed") {
      const t = e.ticket_id ? tickets.get(e.ticket_id) : undefined;
      desktop(`🔴 Chronos: ${t?.key ?? "PR"} CI failing`, `${t?.title ?? "Open PR"} — checks failed on the PR`);
      return;
    }
    if (e.topic === "auth.needed") {
      desktop(`🔐 Chronos: ${e.backend} needs login`, `${e.job_name} failed on auth — login terminal open in Mission Control`);
      return;
    }
    if (e.topic !== "run.ended") return;
    const run = runs.get(e.run_id);
    if (!run) return;
    const job = jobs.get(run.job_id);
    const cost = run.cost_usd ? ` · $${run.cost_usd.toFixed(3)}` : "";
    // ponytail: osascript notifications can't carry a click action; the MC toast is the clickable one.
    // terminal-notifier (-open URL) is the upgrade path if click-to-open from macOS ever matters.
    desktop(
      `${ICON[e.status] ?? "•"} Chronos: ${e.ticket_key ? e.ticket_key + " · " : ""}${job?.name ?? "job"}`,
      `${e.status}${cost}${run.summary ? " · " + run.summary.slice(0, 80) : ""}`
    );
  });
}
