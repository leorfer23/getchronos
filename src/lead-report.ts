/**
 * `mc report` — a worker hands its slice back to its Lead in a shape, instead of just stopping.
 *
 * Before this the worker side of a Lead was mute: the only way to "report" was to finish a turn and
 * let the daemon scrape 1200 characters off the transcript, so a Lead triaging six workers was
 * reading six differently-shaped walls of prose to find out whether anything had actually landed.
 * A report is an inbox row like a stop, but with the fields a Lead has to check anyway — what
 * shipped, what was RUN to prove it, what is still open.
 *
 * Two things follow from filing one, and both matter more than the row:
 *  - the worker's own card is declared (`done` → review, `blocked` → blocked), so the Desk says the
 *    same thing the Lead was told;
 *  - the stop that comes seconds later is SUPPRESSED (robert-drive.ts fireToLead) — a report and the
 *    scraped stop behind it are one event, and naming that worker twice in one digest is how a Lead
 *    ends up answering the same thing twice.
 */
import { leadEvents, leadSlices, sessions, type LeadEvent } from "./store.js";
import { declare } from "./term-status.js";
import { leadEventPayload, notifyLead, resolveLead } from "./robert-drive.js";

export type ReportState = "done" | "partial" | "blocked";

/** The body `mc report` sends, already validated (ReportSchema) — every field but `state` optional. */
export interface ReportBody {
  state: ReportState;
  summary: string;
  prs?: string[];
  tests?: string | null;
  verified?: string | null;
  question?: string | null;
  next?: string | null;
}

/** What a `report` inbox row carries. Shares `id8`/`goal` with a stop's payload so both render alike. */
export interface ReportPayload extends ReportBody {
  id8: string;
  goal: string | null;
  prs: string[];
}

/**
 * File one. Returns the row and the slice it moved, or the refusal — the route turns that into a
 * status code and never invents one of its own.
 */
export function fileReport(
  sessionId: string,
  body: ReportBody,
): { ok: true; event: LeadEvent; slice: number | null } | { ok: false; error: string; status: number } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: "not found", status: 404 };
  const lead = resolveLead(s.lead_id);
  // No Lead = nobody to read it. Said plainly, with the two things that DO work here, because this is
  // read by an agent that was told to report and must not silently conclude that reporting is broken.
  if (!lead)
    return {
      ok: false,
      status: 409,
      error: "this terminal has no live Lead — use mc state / mc ask-robert",
    };

  const payload: ReportPayload = {
    id8: s.id.slice(0, 8),
    goal: (s.goal ?? s.spawn_goal ?? "").trim() || null,
    state: body.state,
    summary: body.summary,
    prs: body.prs ?? [],
    tests: body.tests ?? null,
    verified: body.verified ?? null,
    question: body.question ?? null,
    next: body.next ?? null,
  };
  // `key: null` — a report has no stop behind it to dedupe against, and a worker reporting twice is
  // two reports. (SQLite lets NULLs repeat in a UNIQUE column; see migration 121.)
  const { row } = leadEvents.add({ lead_id: lead.id, session_id: s.id, kind: "report", key: null, payload });

  // The board, kept current without the Lead having to: a `done` from a worker linked to a slice
  // moves that slice to `review` and takes its PR. Never to `done` — that is the Lead's call, after
  // it has checked the evidence, and a worker marking its own work done is the whole thing a Lead
  // exists to not do.
  let slice: number | null = null;
  if (body.state === "done") {
    const linked = leadSlices.forSession(lead.id, s.id);
    if (linked && linked.status !== "done") {
      leadSlices.patch(lead.id, linked.n, {
        status: "review",
        ...(payload.prs[0] && !linked.pr_url ? { pr_url: payload.prs[0] } : {}),
      });
      slice = linked.n;
    }
  }

  // The card says what the Lead was just told. `partial` declares nothing: the worker is carrying on.
  if (body.state === "done") declare(s.id, { state: "done", label: body.summary });
  else if (body.state === "blocked")
    declare(s.id, { state: "blocked", label: body.question || body.summary, reason: "hitl" });

  notifyLead(lead.id);
  return { ok: true, event: row, slice };
}

// ─────────────────────────── rendering (pure) ───────────────────────────

/** The one word the inbox headline uses per kind. `turn` reads FINISHED because that is what the Lead sees. */
const HEAD: Record<string, string> = {
  review: "REVIEW", turn: "FINISHED", decide: "DECIDE", blocked: "BLOCKED", robert: "WAITING",
  ended: "ENDED", report: "REPORT", ask: "ASK",
};

const indent = (text: string, pad: string) => text.split("\n").map((l) => pad + l);

/**
 * What has become of the ask behind an `ask` row, for the one line that says whether it is still the
 * Lead's to settle. Resolved by the caller (api.ts) so the renderer stays pure.
 */
export type AskState = { status: string; route: string; escalated: boolean } | null;

/**
 * One inbox row as the Lead reads it (`mc lead inbox`, `mc lead wait`). Composed HERE rather than in
 * `mc` so there is exactly one rendering of an event and it can be asserted on without a daemon —
 * the CLI prints these lines verbatim.
 */
export function leadEventLines(
  ev: Pick<LeadEvent, "kind" | "session_id" | "payload">,
  ask: AskState = null,
): string[] {
  const p = leadEventPayload(ev) as Partial<ReportPayload> & {
    card_line?: string | null; last_result?: string | null; last_said?: string | null;
    ask_id8?: string; question?: string | null; options?: string[];
  };
  const id8 = p.id8 ?? ev.session_id.slice(0, 8);
  const head = HEAD[ev.kind] ?? ev.kind.toUpperCase();
  const goal = p.goal || "(no goal)";

  if (ev.kind === "report") {
    const out = [`● ${id8} ${head} ${p.state ?? "?"} — ${goal}`];
    if (p.summary) out.push(...indent(p.summary, "  "));
    for (const url of p.prs ?? []) out.push(`  PR: ${url}`);
    // Named fields, each on its own line: a Lead scanning six of these is looking for whether there
    // IS a tests line at all, which a paragraph hides and a label does not.
    if (p.tests) out.push(...indent(`tests: ${p.tests}`, "  "));
    if (p.verified) out.push(...indent(`verified: ${p.verified}`, "  "));
    if (p.question) out.push(...indent(`question: ${p.question}`, "  "));
    if (p.next) out.push(...indent(`next: ${p.next}`, "  "));
    return out;
  }
  if (ev.kind === "ask") {
    const out = [`● ${id8} ${head} — ${goal}`];
    if (p.question) out.push(...indent(p.question, "  "));
    if (p.options?.length) out.push(`  options: ${p.options.join(" / ")}`);
    // Only offer the command while the question is actually this Lead's. One it can no longer
    // answer — the fallback handed it to Robert, the worker went over its head, Robert escalated it
    // to the operator, or somebody already answered — must say so, or the Lead spends a turn on a
    // `mc answer` that 404s and reads as a broken inbox rather than a question that moved on.
    const mine = ask ? ask.status === "open" && ask.route === "lead" && !ask.escalated : true;
    if (!p.ask_id8) return out;
    if (mine) out.push(`  answer it: mc answer ${p.ask_id8} "..."`);
    else if (ask && ask.status !== "open") out.push(`  already ${ask.status} — nothing for you to do`);
    else out.push("  moved on to Robert — not yours to answer");
    return out;
  }
  // A stop, as #396 printed it: the headline, the worker's card line, then what it actually said —
  // with its newlines, which is the whole reason the inbox is read rather than typed into a pty.
  const out = [`● ${id8} ${head} — ${goal}`];
  if (p.card_line) out.push(`  ${p.card_line}`);
  const said = p.last_result || p.last_said;
  if (said) out.push(...indent(said, "    "));
  return out;
}
