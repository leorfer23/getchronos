/**
 * Worker HITL questions (`mc ask`) — service layer shared by the API route and the Telegram callback,
 * same split as reviews.ts (approve/requestChanges/merge used by both api.ts and telegram.ts).
 *
 * Flow: a worker files an ask (POST /api/asks) → operator is notified (Telegram card) → the worker long-polls GET /asks/:id/wait in-process. If answered while the run is
 * still alive, the long-poll just returns it — no dispatch. If the run already ended (parked, or a
 * late answer after a crash), answerAsk re-dispatches the same job with the answer folded into the
 * trigger context, resuming the prior conversation when the backend supports it.
 */
import type { Job, Run, Ticket } from "./types.js";
import { asks, jobs, runs, sessions, tickets, workspaces, type Ask } from "./store.js";
import { bus } from "./bus.js";
import { dispatch } from "./dispatcher.js";
import { isReadOnlyRun } from "./runner.js";
import { reportAgentState } from "./agent-lifecycle.js";
import { notify, esc } from "./telegram/api.js";
import { kb, type Btn } from "./telegram/keyboards.js";
import { postRobertToDesk } from "./robert-desk.js";
import { askMarker, isRobertAsk } from "./robert-asks.js";

function parseOptions(ask: Ask): string[] {
  try {
    return ask.options ? (JSON.parse(ask.options) as string[]) : [];
  } catch {
    return [];
  }
}

/** Full id or id8 — same lookup shape as `runs.findByIdPrefix` callers use throughout the API. */
export function resolveAsk(idOrPrefix: string): Ask | undefined {
  return asks.get(idOrPrefix) ?? asks.findByIdPrefix(idOrPrefix);
}

/**
 * Is this `by` an AGENT deciding for the operator, rather than a person?
 *
 * The two that exist: Robert's own auto-answer (`robert`) and a Lead answering one of its workers
 * (`lead:<id8>`). `ask_policy: "escalate"` outranks both — the whole point of that policy is that no
 * agent decides here, and a Lead answering what Robert may not would have been a way around it.
 */
export const isAgentAnswer = (by: string): boolean => by === "robert" || by.startsWith("lead:");

/**
 * Side effects for a freshly created ask: bus event, blocked/question overlay (no TTL — an ask can
 * sit open for a long time; it's cleared explicitly on answer, or superseded by the paused-run state
 * once the run exits) and Telegram card. The asks row itself is what the ticket timeline renders.
 */
export async function notifyAskCreated(ask: Ask, job: Job | undefined, opts: { desk?: boolean } = {}): Promise<void> {
  const tk = ask.ticket_id ? tickets.get(ask.ticket_id) : undefined;
  bus.publish({
    topic: "ask.created",
    ask_id: ask.id,
    run_id: ask.run_id,
    job_id: ask.job_id,
    session_id: ask.session_id,
    route: ask.route,
    ticket_id: ask.ticket_id,
    ticket_key: tk?.key ?? null,
    workspace_id: ask.workspace_id,
    question: ask.question,
  });
  // Whichever it came from — a run or a terminal — the asker is now blocked, and its card/row says
  // what on. `mc ask-robert` from a terminal is the only reason a Desk card can read "blocked" with
  // a question on it rather than an unexplained silence.
  const askerId = ask.run_id ?? ask.session_id;
  if (askerId) {
    reportAgentState(askerId, {
      state: "blocked",
      blocked_reason: "question",
      state_label: ask.question.slice(0, 80),
      ttl_ms: null,
    });
    if (ask.session_id) sessions.countBlocked(ask.session_id);
  }

  // Routed to the asking terminal's own Lead (`mc ask-lead`): it becomes a row in that Lead's inbox
  // and nothing else happens — no Robert turn, no card on the phone. The Lead answers it with the
  // ordinary `mc answer`, and src/lead-asks.ts hands it to Robert if it does not (or ends first).
  if (ask.route === "lead") {
    void import("./lead-asks.js")
      .then((m) => m.fileAskToLead(ask))
      .catch((e) => console.error("[asks] lead inbox failed", e));
    return;
  }

  // Routed to Robert: he gets first refusal and the operator's phone stays quiet until there is either an
  // escalation or an answer to be told about. Late import — ask-robert.ts calls answerAsk back.
  if (ask.route === "robert") {
    void import("./ask-robert.js")
      .then((m) => m.triageAsk(ask.id))
      .catch((e) => console.error("[asks] robert triage failed", e));
    return;
  }

  // It is the operator's from the start, so it is a card in the Desk chat too — the live Ask widget,
  // not a sentence he has to scroll back for. Robert's own asks skip this: his reply already carries
  // the card, in the bubble where he asked.
  if (opts.desk !== false) postRobertToDesk({ body: askMarker(ask.id), ws: ask.workspace_id ?? null });

  const card = askCard(ask, job);
  await notify(card.text, card.keyboard, { board: false }).catch((e) =>
    console.error("[asks] telegram notify failed", e)
  );
}

/**
 * The operator's ask card, composed once. The resurface sweep (src/holds.ts) re-sends THIS card with
 * a lead line when a hold comes due, so "back from later" is the same question with the same buttons,
 * not a second, differently-shaped notice.
 */
export function askCard(ask: Ask, job: Job | undefined, lead?: string): { text: string; keyboard: ReturnType<typeof kb> } {
  const tk = ask.ticket_id ? tickets.get(ask.ticket_id) : undefined;
  const who = ask.asked_by ?? tk?.key ?? job?.name ?? "job";
  const id8 = ask.id.slice(0, 8);
  const options = parseOptions(ask);
  const lines = lead ? [esc(lead)] : [];
  lines.push(`❓ <b>${esc(who)}</b> asks:`, esc(ask.question));
  if (options.length) lines.push(`Options: ${options.map(esc).join(" / ")}`);
  lines.push(`Free-form: <code>mc answer ${id8} "..."</code>`);
  const rows: Btn[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2).map((opt, j) => ({ text: opt.slice(0, 32), data: `ak.${id8}.${i + j}` })));
  }
  // "Later" is an answer too: it dates the question out of the live list instead of leaving it live
  // or inviting a guess. Always offered — a free-form ask has no option buttons at all otherwise.
  rows.push([{ text: "⏰ Later", data: `hd.a.${id8}` }]);
  return { text: lines.join("\n"), keyboard: kb(rows) };
}

// Compose the answer's trigger context — folded onto the resume run's goal by the backend's
// buildArgs the same way any other trigger context is (claude: "--- Trigger context ---").
function answerContext(ask: Ask): string {
  return (
    `## Answer to your question\nQ: ${ask.question}\nA: ${ask.answer} (answered by ${ask.answered_by})\n` +
    `Continue the ticket from where you left off; your prior work is intact in the working tree.`
  );
}

// Only when the asking run already ended: a live run's own long-poll (GET /asks/:id/wait) delivers
// the answer in-process, so dispatching here too would run the ticket twice. Always threads the
// prior session id — execute() decides how to continue it: native --resume when the backend's
// headless args consume it, else the prior run's transcript replayed into context (replay.ts).
// Gating on backend capability HERE would starve the replay path (a non-resume backend would never
// see a resume_session and silently start fresh — the exact bug replay exists to fix).
function resumeAskingRun(job: Job, run: Run, ask: Ask): { run_id: string; status: string } | { error: string } {
  const context = answerContext(ask);
  // resume_session rides INTO dispatch (5th arg), never patched after it returns: pump() starts the
  // executor synchronously and execute() reads the column in its sync prologue, so a late patch
  // would silently drop the conversation resume (fresh session, prior context lost).
  return dispatch(job.id, `answer:${ask.id.slice(0, 8)}`, 0, context, run.session_id ?? null);
}

async function notifyAnswered(ask: Ask, tk: Ticket | undefined): Promise<void> {
  // A terminal ask has no job to name it — `asked_by` is the terminal, which is the better label anyway.
  const who = tk?.key ?? ask.asked_by ?? ask.job_id ?? "agent";
  await notify(
    `✅ <b>${esc(who)}</b> answered: ${esc(ask.answer ?? "")} <i>(by ${esc(ask.answered_by ?? "")})</i>`,
    undefined,
    { board: false },
  ).catch(() => {});
}

/**
 * Mark an ask answered and follow through: live run → clear the blocked overlay (long-poll picks it
 * up); ended run → re-dispatch/resume. Idempotent against a double-answer: `asks.answer` only
 * transitions an OPEN ask, so a race (Telegram tap vs. `mc answer`) can't double-fire the resume.
 */
export async function answerAsk(
  idOrPrefix: string,
  answerText: string,
  by: string
): Promise<{ ok: true; ask: Ask } | { ok: false; error: string; status?: number }> {
  const cur = resolveAsk(idOrPrefix);
  if (!cur) return { ok: false, error: "ask not found" };
  // Robert's own question is the operator's to answer — an agent answering it would be Robert
  // answering himself.
  if (isAgentAnswer(by) && isRobertAsk(cur)) {
    return { ok: false, error: "Robert asked this one — only the operator answers it", status: 403 };
  }
  // Hard gate: "robert" is the one distinctive `by` Robert's auto-answer path uses (see
  // agents/_blocks/coordinator.md — it literally passes by:"robert"), and `lead:<id8>` is a Lead
  // answering one of its own workers (LEADS.md). Both are AGENTS deciding for the operator, so a
  // workspace that requires human answers outranks both — a Lead is not a way around a policy that
  // stops Robert. Every other `by` (human, telegram, an operator's own name) is a human action and
  // always passes, policy or not. The ask stays OPEN, so the refusal parks it rather than losing it.
  if (isAgentAnswer(by)) {
    const ws = cur.workspace_id ? workspaces.get(cur.workspace_id) : undefined;
    if (ws?.ask_policy === "escalate") {
      return { ok: false, error: "workspace requires human answers", status: 403 };
    }
  }
  const updated = asks.answer(cur.id, answerText, by);
  if (!updated) return { ok: false, error: `ask already ${cur.status}` };

  // A terminal's ask has no run behind it — its `mc ask-robert` is sitting on the long-poll and the
  // bus event below is the whole delivery. Everything from here that touches a run is run-only.
  const run = updated.run_id ? runs.get(updated.run_id) : undefined;
  const job = run ? jobs.get(run.job_id) : undefined;
  const tk = updated.ticket_id ? tickets.get(updated.ticket_id) : undefined;
  // Capture before we clear `paused` below — resume still needs "was ended, not live".
  const askingRunEnded = !!run && run.status !== "running";

  bus.publish({
    topic: "ask.answered",
    ask_id: updated.id,
    run_id: updated.run_id,
    job_id: updated.job_id,
    ticket_id: updated.ticket_id,
    ticket_key: tk?.key ?? null,
    workspace_id: updated.workspace_id,
    answer: answerText,
    answered_by: by,
    // Verbatim `by`, not a telegram|human binary: Robert answers asks himself (by:"robert", per his
    // ask-wake prompt), and the activity ledger recorded that as "human" — a lie that undercounts
    // what the manager agent does on its own.
    actor: by,
  });

  if (run?.status === "running" && updated.run_id) {
    reportAgentState(updated.run_id, { state: "working", state_label: null, blocked_reason: null, ttl_ms: null });
  }
  // The terminal that asked is unblocked by the same token — its card goes green again on the wall.
  if (updated.session_id) {
    reportAgentState(updated.session_id, { state: "working", state_label: null, blocked_reason: null, ttl_ms: null });
  }

  // Robert asked it himself, in a turn that is long over: the answer reaches him as a queued wake.
  if (isRobertAsk(updated)) tellRobertAnswered(updated);

  // Parked run: the process already exited 0 and we only kept status=paused so the open ask
  // stayed visible on the fleet board. Once that ask is answered, the park is over — finalize to
  // success so activeByWorkspace / rollup drop it. The resume below is a NEW run; leaving the
  // predecessor paused forever was PER-17 (ghost blocked agents) / PER-15.
  if (run?.status === "paused") {
    runs.patch(run.id, { status: "success" });
    reportAgentState(run.id, { state: "done", state_label: null, blocked_reason: null, ttl_ms: null });
  }

  // The Telegram callback already confirms in-chat (edits/replies the tapped card) — a second
  // service-level notice for that same tap would say the same thing twice.
  if (by !== "telegram") void notifyAnswered(updated, tk).catch((e) => console.error("[asks] telegram confirm failed", e));

  // Read-only runs (plan:/review:/…) never park and their asks are advisory (a planner's
  // fire-and-forget question, a reviewer that already fell back to `changes`): re-dispatching on
  // answer would re-run a whole plan/review that already delivered its output. The answer still
  // lands where it matters — the asks table the ticket timeline renders — for the next human/agent.
  // Gate on pre-finalize status (askingRunEnded): we just patched paused→success above, but the
  // resume must still fire for that former park. Read-only runs never re-dispatch.
  if (run && job && askingRunEnded && !isReadOnlyRun(job.name)) {
    const resumed = resumeAskingRun(job, run, updated);
    if ("error" in resumed) {
      const msg = `⚠️ answered ${updated.id.slice(0, 8)} but could not resume — ${resumed.error}`;
      void notify(msg).catch(() => {});
    }
  }

  return { ok: true, ask: updated };
}

/**
 * The operator answered a question Robert raised. A wake, not a direct turn: it is durable across a
 * restart, and it queues behind whatever he is doing instead of racing it. Late import — the wake
 * queue imports the manager, which is a long way from the asks layer.
 */
function tellRobertAnswered(ask: Ask): void {
  const say =
    `The operator answered the question you asked him (ask \`${ask.id.slice(0, 8)}\`).\n` +
    `Q: ${ask.question}\nA: ${ask.answer}\n` +
    `Act on it now, the way you said you would when you asked.`;
  void import("./wake-queue.js")
    .then((m) => m.enqueueWake({ topic: "ask.answered", key: `robert-ask:${ask.id}`, workspace_id: ask.workspace_id, payload: { say } }))
    .catch((e) => console.error("[asks] robert wake failed", e));
}

/**
 * Event-driven long-poll: resolves as soon as `ask.answered` fires for this id, else after
 * `timeoutMs` with the ask's current (still-open) row. No sleep loop — one bus listener + one timer.
 */
export function waitForAskAnswer(id: string, timeoutMs: number): Promise<Ask> {
  const cur = asks.get(id);
  if (!cur || cur.status !== "open") return Promise.resolve(cur!);
  return new Promise((resolve) => {
    let settled = false;
    const onEvent = (e: { topic: string; ask_id?: string }) => {
      if (settled || e.topic !== "ask.answered" || e.ask_id !== id) return;
      settled = true;
      clearTimeout(timer);
      bus.off("event", onEvent);
      resolve(asks.get(id)!);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      bus.off("event", onEvent);
      resolve(asks.get(id) ?? cur);
    }, timeoutMs);
    timer.unref?.();
    bus.on("event", onEvent);
  });
}
