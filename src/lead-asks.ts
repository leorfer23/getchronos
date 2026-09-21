/**
 * `mc ask-lead` — a worker's question goes to its own Lead first, and only then to Robert.
 *
 * In v1 a worker's only question was `mc ask-robert`, which went over its Lead's head to the one
 * agent that does NOT know this goal: Robert had to reconstruct from a card what the Lead had in its
 * head. The Lead answers in seconds, from the brief it wrote itself.
 *
 * The rules that keep it from becoming a trap for the worker, which is BLOCKED the whole time:
 *  - **A Lead is never the last word.** An ask it has not answered inside `leadDrive.askFallbackMin`
 *    becomes Robert's by exactly the path `route: "robert"` takes on creation (triageAsk), and so
 *    does every open ask of a Lead that ends. Once: the re-route rewrites `route`, so the sweep that
 *    runs a minute later sees a Robert ask and leaves it alone.
 *  - **A Lead may answer ONLY its own workers' asks.** Its credential is not a workspace token: the
 *    ask's session must carry that Lead's `lead_id`, which the daemon stamped at spawn.
 */
import { asks, leadEvents, sessions, workspaces, type Ask } from "./store.js";
import { CONFIG } from "./config.js";
import type { Session } from "./types.js";
import { notifyLead, resolveLead } from "./robert-drive.js";

const id8 = (id: string) => id.slice(0, 8);

/** Does this terminal have a live Lead to ask? The one thing `route: "lead"` means. */
export function leadForSession(sessionId: string) {
  const s = sessions.get(sessionId);
  return resolveLead(s?.lead_id);
}

/**
 * May a question from this terminal go to its Lead at all? Decided by the DAEMON at creation, never
 * by the asking worker: `mc` reads a stale `MC_LEAD_ID` from its env long after that Lead ended, and
 * a lead-routed ask with no Lead is a blocked worker nobody is notified about until a sweep finds it.
 *
 * Two reasons it is refused, and they are different:
 *  - there is no live Lead to read it;
 *  - the workspace requires HUMAN answers (`ask_policy: "escalate"`), which outranks every agent —
 *    it already stops Robert deciding, and a Lead is an agent exactly like him. In that workspace
 *    the question goes down the path any other ask takes, i.e. to Robert to recommend and then to
 *    the operator.
 */
export function mayRouteToLead(sessionId: string): boolean {
  const lead = leadForSession(sessionId);
  if (!lead) return false;
  const ws = lead.workspace_id ? workspaces.get(lead.workspace_id) : undefined;
  return ws?.ask_policy !== "escalate";
}

/**
 * May this Lead answer that ask? Pure over the two rows, so the whole table is testable.
 *
 * Two independent conditions, and both matter:
 *  - **Whose worker asked it.** Another Lead's worker, another workspace's terminal and a terminal
 *    the operator opened himself are all no; a run's ask (no session at all) is no for the same
 *    reason — a Lead owns terminals, not jobs.
 *  - **Whether it is still the Lead's question.** An ask that has MOVED ON is not: the 10-minute
 *    fallback flipped it to `route: "robert"`, the worker went over its Lead's head with `--robert`,
 *    or Robert handed it to the operator (`escalated_at`). Without this a Lead could still answer by
 *    id something the operator is looking at on his phone — deciding what was taken away from it.
 */
export function leadMayAnswer(
  leadId: string,
  ask: Pick<Ask, "session_id" | "route" | "escalated_at">,
  target: Pick<Session, "lead_id"> | undefined,
): boolean {
  if (ask.route !== "lead" || ask.escalated_at) return false;
  return !!ask.session_id && !!target && target.lead_id === leadId;
}

/** The inbox row a Lead sees for a question (`● <id8> ASK — …`), plus the wake that delivers it. */
export function fileAskToLead(ask: Ask): void {
  if (!ask.session_id) return;
  const lead = leadForSession(ask.session_id);
  if (!lead) return;
  const s = sessions.get(ask.session_id);
  let options: string[] = [];
  try {
    options = ask.options ? (JSON.parse(ask.options) as string[]) : [];
  } catch {}
  leadEvents.add({
    lead_id: lead.id,
    session_id: ask.session_id,
    kind: "ask",
    // No stop behind it, so nothing to dedupe on — and a worker asking twice is two questions.
    key: null,
    payload: {
      id8: id8(ask.session_id),
      goal: (s?.goal ?? s?.spawn_goal ?? "").trim() || null,
      ask_id8: id8(ask.id),
      question: ask.question,
      options,
    },
  });
  notifyLead(lead.id);
}

/**
 * Test seam: handing the question to Robert spawns a manager turn, which no test may do (CLAUDE.md
 * gotcha 2). The default is the real path — the same `triageAsk` a `route: "robert"` ask gets on
 * creation, late-imported because ask-robert.ts reaches back into asks.ts, which reaches into here.
 */
type TriageProbe = (askId: string) => Promise<void>;
let triage: TriageProbe = async (askId) => {
  const { triageAsk } = await import("./ask-robert.js");
  await triageAsk(askId);
};
export function setLeadTriageProbe(fn: TriageProbe): void { triage = fn; }

/**
 * Hand one open `route: "lead"` ask to Robert, exactly as it would have gone on creation. Rewriting
 * `route` first is what makes it happen once: after this the row IS a Robert ask, so the sweep, a
 * second Lead-ended pass and a late timer all see nothing left to re-route.
 */
export async function fallbackAskToRobert(askId: string, why: string): Promise<boolean> {
  const cur = asks.get(askId);
  if (!cur || cur.status !== "open" || cur.route !== "lead") return false;
  // The write IS the "once": whoever loses this race sees route === "robert" and stops here, so the
  // question is triaged one time however many sweeps, timers and end-of-Lead passes reach it.
  if (!asks.setRoute(cur.id, "robert")) return false;
  console.log(`[lead-ask] ${id8(cur.id)} → Robert (${why})`);
  await triage(cur.id).catch((e) => console.error("[lead-ask] robert triage failed", e));
  return true;
}

/**
 * Safety net, on the same sweep as Robert's own triage deadline: a Lead that never answered, or one
 * that ended with its workers' questions still open. The worker is BLOCKED on this the whole time,
 * so a quiet Lead must never become an infinite wait — the same reason sweepTriageDeadline exists.
 */
export async function sweepLeadAsks(nowMs = Date.now()): Promise<void> {
  const deadlineMs = Math.max(0, CONFIG.leadDrive.askFallbackMin) * 60_000;
  for (const a of asks.openRoutedToLead()) {
    const lead = a.session_id ? leadForSession(a.session_id) : null;
    const age = nowMs - Date.parse(a.created_at);
    const why = !lead ? "its Lead ended" : Number.isFinite(age) && age >= deadlineMs ? `no answer in ${CONFIG.leadDrive.askFallbackMin}m` : null;
    if (!why) continue;
    await fallbackAskToRobert(a.id, why).catch((e) => console.error("[lead-ask] fallback failed", e));
  }
}
