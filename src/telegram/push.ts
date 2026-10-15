import { bus } from "../bus.js";
import { jobs, runs, workspaces, tickets, reviews, skills } from "../store.js";
import { notify, esc } from "./api.js";
import { kb, reviewKb, STATUS_ICON } from "./keyboards.js";
import { hasTicker } from "./ticker.js";

// Statuses that count as a "failure" for the notify:"failures" policy.
const FAILURE_STATUSES = new Set(["failed", "timeout", "blocked", "rate_limited"]);

// Per-job notify policy for run.ended pushes: null/"all" → everything, "failures" → only the
// statuses above, "off" → never. Pure/exported so it's unit-testable without the bus.
export function shouldNotify(policy: string | null | undefined, status: string): boolean {
  if (policy === "off") return false;
  if (policy === "failures") return FAILURE_STATUSES.has(status);
  return true;
}

// Bus → Telegram push notifications: run outcomes, new reviews, skill approvals.
export function registerPush() {
  bus.on("event", async (e: any) => {
    if (e.topic === "run.ended") {
      const run = runs.get(e.run_id);
      if (!run) return;
      const job = jobs.get(run.job_id);
      const ws = job?.workspace_id ? workspaces.get(job.workspace_id) : undefined;
      // Slack triage files into the workspace inbox (src/inbox.ts), which pushes the urgent DMs and
      // mentions itself, one by one, as they are filed. The run's own outcome is never news.
      if (job?.name?.startsWith("slack-triage:")) return;
      // Respect the job's notify policy, and skip if a live ticker already rendered the final state.
      if (!shouldNotify(job?.notify, e.status) || hasTicker(e.run_id)) return;
      const tk = job?.ticket_id ? tickets.get(job.ticket_id) : undefined;
      await notify(
        `${STATUS_ICON[e.status] ?? "•"} ${ws ? "[" + esc(ws.name) + "] " : ""}<b>${esc(job?.name ?? "job")}</b> — ${e.status}` +
        `${tk ? `\n🎫 <code>${esc(tk.key)}</code> ${esc(tk.title.slice(0, 60))}` : ""}` +
        `${run.cost_usd ? "\n$" + run.cost_usd.toFixed(4) + " · " + (run.num_turns ?? 0) + " turns" : ""}` +
        `${run.summary ? "\n" + esc(run.summary.slice(0, 400)) : ""}`
      );
    } else if (e.topic === "auth.needed") {
      const ws = e.workspace_id ? workspaces.get(e.workspace_id) : undefined;
      await notify(
        `🔐 <b>${esc(e.backend)}</b>${ws ? " [" + esc(ws.name) + "]" : ""} needs login — ` +
        `run <b>${esc(e.job_name)}</b> failed on auth.\n` +
        `A login terminal is open in Mission Control → Terminals; complete login there, then re-dispatch.`
      );
    } else if (e.topic === "review.created") {
      const t = e.ticket_id ? tickets.get(e.ticket_id) : undefined;
      const r = reviews.get(e.review_id);
      await notify(`🟡 <b>Review queued</b>${t ? " — " + esc(t.key + " " + t.title) : ""}`, r ? reviewKb(r) : undefined);
    } else if (e.topic === "review.updated") {
      const r = reviews.get(e.review_id);
      const t = r?.ticket_id ? tickets.get(r.ticket_id) : undefined;
      const icon = e.state === "approved" ? "✅" : e.state === "changes_requested" ? "🔁" : e.state === "merged" ? "🔀" : "•";
      await notify(`${icon} <b>${esc(e.state.replace("_", " "))}</b>${t ? " — " + esc(t.key + " " + t.title) : ""}${r?.notes ? "\n" + esc(String(r.notes).slice(0, 300)) : ""}`);
    } else if (e.topic === "skill.created" || e.topic === "skill.updated") {
      // Only ping when something is actually awaiting approval (pending). Approve/archive stay quiet.
      if (e.status !== "pending") return;
      const s = skills.get(e.skill_id);
      if (!s) return;
      const ws = workspaces.get(e.workspace_id);
      const verb = e.topic === "skill.created" ? "New skill proposed" : `Skill updated → re-review (v${s.version})`;
      const idp = s.id.slice(0, 8);
      await notify(`🧩 <b>${verb}</b>${ws ? " — " + esc(ws.name) : ""}\n<b>${esc(s.slug)}</b>: ${esc(s.description.slice(0, 120))}`,
        kb([[{ text: "📖 View", data: `sk.v.${idp}` }, { text: "✅ Approve", data: `sk.ok.${idp}` }, { text: "✕ Reject", data: `sk.no.${idp}` }]]));
    }
  });
}
