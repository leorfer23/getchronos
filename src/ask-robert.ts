/**
 * `mc ask-robert` — a terminal agent's question goes to the overseer first, and only reaches the operator's
 * phone if the overseer can't settle it.
 *
 * Before this, an agent in a Desk terminal had no way to ask anything at all: `mc ask` requires
 * MC_RUN (a dispatched run), and a terminal has MC_SESSION. So a blocked agent either guessed, or
 * sat there painting a prompt at a screen nobody was looking at. Meanwhile every question that DID
 * get through went straight to the phone, including the ones whose answer is written in the ticket.
 *
 * The routing, in one line: Robert answers what is routine and derivable, and escalates everything
 * that touches scope, money, destruction, an external side effect, or is genuinely ambiguous.
 *
 * Three things keep this honest:
 *  - **He is never the last word by default.** Whatever he decides, the operator is told — an answer Robert
 *    gave is a notification, not a secret.
 *  - **A deadline, not a hope.** An ask he doesn't resolve inside TRIAGE_DEADLINE_MIN escalates by
 *    itself. The agent is BLOCKED on this; a quiet overseer must never become an infinite wait.
 *  - **`ask_policy: 'escalate'` outranks him**, exactly as it does in answerAsk. In those
 *    workspaces he may recommend, never decide.
 */
import { asks, sessions, workspaces, type Ask } from "./store.js";
import { getAgent } from "./agent-lifecycle.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { focusEvents } from "./terminal.js";
import { askManagerWeb } from "./telegram/agent.js";
import { postRobertToDesk } from "./robert-desk.js";
import type { RobertStep } from "./robert-steps.js";
import { esc, notify, notifyInfo } from "./telegram/api.js";
import { kb, type Btn } from "./telegram/keyboards.js";

/** How long an ask may sit with Robert before it becomes the operator's anyway. The agent is blocked. */
export const TRIAGE_DEADLINE_MIN = Number(process.env.CHRONOS_ASK_TRIAGE_MIN ?? 3);

const id8 = (id: string) => id.slice(0, 8);

/**
 * Robert's verdict, parsed from the first line of his reply.
 *
 * Deterministic parsing rather than "he'll curl the API himself": an agent is BLOCKED on this
 * answer, and a turn where he narrates his decision instead of executing it would hang a terminal
 * until the deadline. He may still call the API directly — `triage` re-checks the ask's status
 * before acting, so an ask he already answered is left alone.
 */
export function parseVerdict(reply: string): { kind: "answer" | "escalate"; text: string } | null {
  const body = (reply || "").trim();
  if (!body) return null;
  const m = /^\s*(ANSWER|ASK LEO|ESCALATE)\s*:\s*([\s\S]+)$/i.exec(body);
  if (!m) return null;
  const text = m[2].trim();
  if (!text) return null;
  return { kind: /^answer$/i.test(m[1]) ? "answer" : "escalate", text };
}

/** What the asking terminal is, in the words Robert needs to judge whether he can answer it. */
function askerContext(ask: Ask): string {
  if (!ask.session_id) return "";
  const s = sessions.get(ask.session_id);
  if (!s) return "";
  let feed: { kind: string; text: string }[] = [];
  try {
    feed = focusEvents(s.id).slice(-8).map((e) => ({ kind: e.kind, text: e.text.slice(0, 300) }));
  } catch {
    feed = [];
  }
  const understanding = [...feed].reverse().find((e) => e.kind === "understanding")?.text;
  return (
    `\nTHE TERMINAL THAT ASKED — \`${id8(s.id)}\` · ${s.workspace_id ? (workspaces.get(s.workspace_id)?.name ?? "?") : "unscoped"}\n` +
    `What it was opened to do: ${s.spawn_goal ?? s.goal ?? "(no goal set)"}\n` +
    (s.goal && s.goal !== s.spawn_goal ? `What it turned out to be: ${s.goal}\n` : "") +
    (s.goal_kind ? `Shape of work: ${s.goal_kind}\n` : "") +
    (s.cwd ? `Working in: ${s.cwd}\n` : "") +
    (understanding ? `Its own understanding: ${understanding}\n` : "") +
    (feed.length ? `Its last lines:\n${feed.map((e) => `[${e.kind}] ${e.text}`).join("\n")}\n` : "")
  );
}

export function triagePrompt(ask: Ask, escalateOnly: boolean): string {
  const who = ask.asked_by ?? "An agent";
  return (
    `${OP_PREFIX}${who} in one of the operator's terminals just ASKED YOU a question and is BLOCKED waiting on the ` +
    `answer. The operator did NOT message you, and he has NOT seen this yet — you are the first stop.\n\n` +
    `THE QUESTION: "${ask.question}"\n` +
    askerContext(ask) +
    `\nApply WHEN YOU DECIDE AND WHEN YOU ASK from your instructions — it owns that line and this prompt does not ` +
    `restate it. Put your decision on the FIRST LINE in one of these two exact shapes:\n` +
    (escalateOnly
      ? `  ASK LEO: <your recommended answer, in one line>\n` +
        `This workspace REQUIRES a human answer to every ask — you may recommend, you may not decide. ` +
        `Always use ASK LEO here, even when the answer is obvious.\n`
      : `  ANSWER: <the answer the agent should act on>\n` +
        `  ASK LEO: <why it needs him, and the answer you recommend>\n\n` +
        `When you are not sure which side of that line this falls on, that IS the signal — use ASK LEO.\n`) +
    `\nNo preamble, no markdown. First line is the verdict; add at most one short line after it if ` +
    `the agent needs a reason to act well. Write the answer TO the agent — it is the one reading it.`
  );
}

/** The card the operator gets when Robert hands the question up. */
export async function escalateAsk(ask: Ask, robertNote: string | null): Promise<void> {
  const cur = asks.get(ask.id);
  if (!cur || cur.status !== "open" || cur.escalated_at) return;
  asks.escalate(cur.id, robertNote);
  const short = id8(cur.id);
  const options: string[] = (() => {
    try {
      return cur.options ? (JSON.parse(cur.options) as string[]) : [];
    } catch {
      return [];
    }
  })();
  const lines = [`❓ <b>${esc(cur.asked_by ?? "An agent")}</b> asks:`, esc(cur.question)];
  if (robertNote) lines.push(`\n🤖 <i>Robert:</i> ${esc(robertNote)}`);
  if (options.length) lines.push(`Options: ${options.map(esc).join(" / ")}`);
  lines.push(`Free-form: <code>mc answer ${short} "..."</code>`);
  const rows: Btn[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2).map((opt, j) => ({ text: opt.slice(0, 32), data: `ak.${short}.${i + j}` })));
  }
  // An escalated ask is the operator's now — so it gets the same "later" exit as any other ask card:
  // a date, instead of a live-looking card nobody can clear without inventing an answer.
  rows.push([{ text: "⏰ Later", data: `hd.a.${short}` }]);
  await notify(lines.join("\n"), kb(rows), { board: false }).catch((e) =>
    console.error("[ask-robert] escalate notify failed", e),
  );
}

/**
 * Hand one ask to Robert. Answers it on his word, or escalates — and tells the operator either way.
 *
 * Fire-and-forget from the API route: the asking agent is on the long-poll, so it hears the answer
 * through `ask.answered` the moment this lands, and hears nothing extra when this escalates.
 */
export async function triageAsk(askId: string): Promise<void> {
  const ask = asks.get(askId);
  if (!ask || ask.status !== "open" || ask.route !== "robert") return;
  const ws = ask.workspace_id ? workspaces.get(ask.workspace_id) : undefined;
  const escalateOnly = ws?.ask_policy === "escalate";

  let reply = "";
  let steps: RobertStep[] = [];
  let turn: string | undefined;
  // Whatever he decides, it goes in the Desk thread with the steps he took to get there.
  const who = ask.asked_by ?? (ask.session_id ? `terminal ${id8(ask.session_id)}` : "an agent");
  const desk = (line: string) =>
    postRobertToDesk({ body: `${line}\n\n_${who} asked:_ ${ask.question}`, ws: ask.workspace_id ?? null, steps, turn });
  try {
    // Model is the Desk pick (getWebModel inside askManagerWeb) — same as a typed chat turn.
    const out = await askManagerWeb(triagePrompt(ask, escalateOnly), undefined, ask.workspace_id ?? null, {
      label: "ask",
    });
    reply = (out.reply || "").trim();
    steps = out.steps;
    turn = out.turn;
  } catch (e: any) {
    console.warn("[ask-robert] triage turn failed", e?.message ?? e);
  }

  // He may have answered it directly through the API mid-turn — that's a legitimate path, and
  // re-deciding on top of it would overwrite the first answer the agent already received.
  const after = asks.get(ask.id);
  if (!after || after.status !== "open") return;
  // His turn outran the deadline and the sweeper already handed this to the operator. Escalation is a
  // HANDOVER, not a race he can still win: answering now would put an answer on a question the operator is
  // looking at on his phone, and he would be deciding something already decided.
  if (after.escalated_at) return;

  const verdict = parseVerdict(reply);
  // No verdict at all (a failed turn, or prose where a decision belonged) → the operator's, with whatever he
  // did say attached. The failure mode of this whole path must be "the operator gets asked", never "the
  // terminal waits forever".
  if (!verdict) {
    desk("**Passed a question to you** — I couldn't settle it.");
    await escalateAsk(after, reply ? reply.slice(0, 300) : null);
    return;
  }
  if (verdict.kind === "escalate" || escalateOnly) {
    desk(`**Passed a question to you** — ${verdict.text.slice(0, 300)}`);
    await escalateAsk(after, verdict.text.slice(0, 300));
    return;
  }

  const { answerAsk } = await import("./asks.js"); // late: asks.ts routes back into this module
  const out = await answerAsk(after.id, verdict.text, "robert");
  if (!out.ok) {
    await escalateAsk(after, verdict.text.slice(0, 300));
    return;
  }
  asks.setTriage(after.id, verdict.text.slice(0, 300));
  desk(`**Answered for you:** ${verdict.text.slice(0, 400)}`);
  // He acted for the operator, so the operator hears about it. On the phone, not just the board: "Robert answered a
  // question on my behalf" is exactly the kind of thing you want to be able to catch within a minute
  // and correct with an `mc tell`, not discover at the end of the day.
  await notify(
    `🤖 <b>Robert answered for you</b>\n` +
      `<i>${esc(ask.asked_by ?? "an agent")} asked:</i> ${esc(ask.question)}\n` +
      `<i>He said:</i> ${esc(verdict.text)}\n` +
      (ask.session_id ? `<code>mc session focus ${id8(ask.session_id)}</code>` : ""),
  ).catch(() => {});
}

/**
 * Safety net: any ask Robert was given and never resolved becomes the operator's once the deadline passes.
 * Called from the desk-watch sweeper. Without it, a manager process that failed to spawn is an
 * agent blocked forever on a question nobody can see.
 */
export async function sweepTriageDeadline(nowMs = Date.now()): Promise<void> {
  for (const a of asks.openRoutedToRobert()) {
    const age = nowMs - Date.parse(a.created_at);
    if (!Number.isFinite(age) || age < TRIAGE_DEADLINE_MIN * 60_000) continue;
    await escalateAsk(a, `(no call from Robert within ${TRIAGE_DEADLINE_MIN}m — over to you)`).catch((e) =>
      console.error("[ask-robert] deadline escalate failed", e),
    );
  }
}

/** A terminal died with questions open: nothing is coming back for them. Say so once, quietly. */
export function cancelSessionAsks(sessionId: string): void {
  const open = asks.openForSession(sessionId);
  if (!open.length) return;
  for (const a of open) asks.cancel(a.id);
  void notifyInfo(
    `🚫 ${open.length} open question${open.length > 1 ? "s" : ""} dropped — the terminal that asked ` +
      `(<code>${id8(sessionId)}</code>) ended.`,
  ).catch(() => {});
}

/** Whether an agent may ask Robert at all. Off puts every terminal ask straight on the operator's phone. */
export const askRobertEnabled = () => process.env.CHRONOS_ASK_ROBERT !== "0";

/** Who a session's ask says it is from, on the card. */
export function askerLabel(sessionId: string): string {
  const s = sessions.get(sessionId);
  if (!s) return "An agent";
  const agent = getAgent(sessionId);
  const name = s.agent_name ?? agent?.name ?? null;
  const goal = (s.goal ?? s.spawn_goal ?? "").trim();
  if (name && goal) return `${name} · ${goal.slice(0, 48)}`;
  return name ?? (goal ? goal.slice(0, 60) : `terminal ${id8(sessionId)}`);
}
