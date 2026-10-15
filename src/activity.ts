import { bus, type BusEvent } from "./bus.js";
import { activity, runs, jobs, tickets, reviews, triggers } from "./store.js";
import { CONFIG } from "./config.js";
import { baseJobName } from "./job-name.js";

const DETAIL_CAP = 2000;
// run.event is streamed per-message and already persisted in run_events — far too high-frequency
// for a decision trail (would churn the retention cap in minutes). Everything else is recorded.
const SKIP = new Set(["run.event", "agent.delta", "agent.asked", "agent.turn.done", "agent.state", "session.usage", "session.status"]);

// Derive who acted. Explicit e.actor wins (set by publishers that know — e.g. reviews). For run.*
// we read the run's job-name/trigger_src (cheap PK lookups); trigger.fired resolves the trigger
// name; otherwise → "system".
function actorFor(e: any): string {
  if (e.actor) return e.actor;
  if (e.topic === "session.input") return e.by || "operator"; // who typed into the terminal
  const topic: string = e.topic;
  if (topic === "run.started" || topic === "run.ended" || topic === "run.step" || topic === "ask.created") {
    const run = e.run_id ? runs.get(e.run_id) : undefined;
    const job = run ? jobs.get(run.job_id) : undefined;
    const name = baseJobName(job?.name);
    if (name.startsWith("plan:")) return "ai:planner";
    if (name.startsWith("ticket:")) return "ai:builder";
    if (name.startsWith("review:")) return "ai:reviewer";
    const src = run?.trigger_src ?? "";
    if (src === "cron") return "cron";
    if (src === "manual") return "human";
    if (src.startsWith("telegram:")) return "telegram";
    if (src.startsWith("trigger:")) return src; // "trigger:<name>"
    return "system"; // chain/retry/resume/internal
  }
  if (topic === "trigger.fired") {
    const t = e.trigger_id ? triggers.get(e.trigger_id) : undefined;
    return t ? `trigger:${t.name}` : "system";
  }
  return "system";
}

// Most specific id present on the event.
function entityFor(e: any): string | null {
  return e.ask_id ?? e.message_id ?? e.review_id ?? e.skill_id ?? e.trigger_id ?? e.note_id ?? e.session_id ?? e.ticket_id ?? e.run_id ?? e.job_id ?? null;
}

// Workspace from the event, else a cheap PK lookup off an id the event already carries (null is fine).
function workspaceFor(e: any): string | null {
  if (e.workspace_id) return e.workspace_id;
  if (e.ticket_id) return tickets.get(e.ticket_id)?.workspace_id ?? null;
  if (e.review_id) {
    const r = reviews.get(e.review_id);
    return r?.ticket_id ? tickets.get(r.ticket_id)?.workspace_id ?? null : null;
  }
  if (e.run_id) {
    const run = runs.get(e.run_id);
    const job = run ? jobs.get(run.job_id) : undefined;
    return job?.workspace_id ?? null;
  }
  return null;
}

function detailFor(e: any): string {
  const { topic, actor, ...rest } = e;
  let s: string;
  try { s = JSON.stringify(rest); } catch { s = "{}"; }
  return s.length > DETAIL_CAP ? s.slice(0, DETAIL_CAP) : s;
}

// One bus listener persists every event into the `activity` table. Registered at boot.
export function startActivity(): void {
  bus.on("event", (e: BusEvent) => {
    const topic = (e as any).topic;
    if (SKIP.has(topic)) return;
    try {
      activity.add({
        topic,
        actor: actorFor(e),
        workspace_id: workspaceFor(e),
        entity: entityFor(e),
        detail: detailFor(e),
      });
      activity.prune(CONFIG.activityRetain);
    } catch (err) {
      console.error("[activity]", err);
    }
  });
  console.log(`[activity] recording bus events → activity table (retain ${CONFIG.activityRetain})`);
}
