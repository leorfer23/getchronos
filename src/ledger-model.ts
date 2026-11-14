/**
 * The request ledger — the pure half (LEDGER.md). No store, no bus, no clock of its own: the words,
 * the work types and what each one owes as evidence, the state roll-up, the order the approval queue
 * is heard in, and the compact text a coordinator reads. Everything here is a function of its
 * arguments, so every rule is a unit test.
 *
 * One request = what the operator asked for, once. It goes to one or more terminals (links); each
 * terminal's hand-offs become the request's result and deliverables (a PR, a draft, a page, a deploy);
 * each deliverable that needs his word is a decision item bound to a target hash; a future verifier
 * fills the checks. The request's state is derived from all of that, never typed by a model.
 */
import { createHash } from "node:crypto";
import type { GoalKind } from "./types.js";

// ───────────────────────────── vocabulary ─────────────────────────────

/** Most urgent first. The list order and the roll-up's precedence are this order. */
export const REQUEST_STATES = ["needs_operator", "stuck", "working", "done", "closed"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const STATE_RANK: Record<RequestState, number> = { needs_operator: 0, stuck: 1, working: 2, done: 3, closed: 4 };
/** The states a request is still open in — anything a coordinator should be told about. */
export const OPEN_STATES: readonly RequestState[] = ["needs_operator", "stuck", "working"];

/**
 * How it arrived. `voice` / `typed`: the operator's own words to Robert (POST /agent). `hand`: a
 * terminal he opened himself (Desk, phone, his shell, a saved launch). `robert`: Robert opened it on
 * his own (a wake, a self-wake) — the words are Robert's, not the operator's. The rest are the
 * daemon's openers, named after `sessions.created_by`. `backfill`: adopted from a terminal that was
 * already live when the ledger started — what was said to open it is not known.
 */
export const VIAS = [
  "voice", "typed", "hand", "capture", "inbox", "robert", "job-check", "follow-up", "continuation", "ship",
  "lead", "agent", "daemon", "backfill",
] as const;
export type Via = (typeof VIAS)[number];

/**
 * How a terminal serves a request. `opened`: opened for it. `worker`: a Lead's worker, serving its
 * Lead's request. `standin`: took over a terminal that served it (failover, continuation, handoff).
 * `steer`: Robert typed the operator's words into it. `adopted`: an orphan given a request of its
 * own. `backfill`: adopted when the ledger started.
 */
export const LINK_ROLES = ["opened", "worker", "standin", "steer", "adopted", "backfill"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** What he can be asked to decide. none = no item at all. */
export const ACTIONS = ["merge", "deploy", "send", "review", "answer"] as const;
export type Action = (typeof ACTIONS)[number];
/** The ones that change something outside: they bind to a target hash and only the executor carries them out. */
export const EXECUTABLE: ReadonlySet<Action> = new Set<Action>(["merge", "deploy", "send"]);

/** His answer. `answered` is only ever written by the ask path (an `answer` item follows its ask). */
export const DECISIONS = ["yes", "no", "later", "change"] as const;
export type Decision = (typeof DECISIONS)[number] | "answered";
/** open = owed now · held = he said later · decided = answered · superseded = no longer the question. */
export const ITEM_STATUSES = ["open", "held", "decided", "superseded"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/**
 * What a request can produce. `answer` is a hand-off whose summary IS the deliverable (an analysis
 * answered in the terminal). `doc` and `dashboard` are links (a document, a BI dashboard).
 */
export const DELIVERABLE_KINDS = ["pr", "deploy", "slack_draft", "email_draft", "artifact", "dashboard", "doc", "answer"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];
export const DELIVERABLE_STATES = ["open", "merged", "deployed", "sent", "closed", "superseded"] as const;
export type DeliverableState = (typeof DELIVERABLE_STATES)[number];
/** Carried out (or ended): nothing left for anyone to do with it. */
export const FINAL_DELIVERABLE: ReadonlySet<DeliverableState> = new Set<DeliverableState>(["merged", "deployed", "sent", "closed", "superseded"]);

/** The checks a verifier may run. A row per check per request (per deliverable when it is about one). */
export const CHECK_NAMES = [
  "tests", "regression", "pr_ready", "matches_request", "shots", "walkthrough",
  "queries", "crosscheck", "assumptions", "exercised", "repro_steps",
  "repro_before", "fixed_after", "post_deploy", "goal_test", "draft_bound",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
/** `na` = the slot does not apply to this answer (an analysis that states no figures): never a pass, never missing. */
export const CHECK_STATUSES = ["pass", "fail", "skip", "na"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
/** One piece of evidence a check points at: a run, a file, a shot, a URL. `meta` = e.g. {screen, viewport, side}. */
export type Evidence = { ref: string; label?: string | null; meta?: Record<string, string | number | boolean> | null };

/** Something that must hold before the work can run at all — a VPN up, a login alive. */
export type Prereq = { kind: "vpn" | "login" | string; name?: string | null; why?: string | null; source: "workspace" | "set" };

// ───────────────────────────── work types ─────────────────────────────

/**
 * `required` = not ready without a result. `gate` = not ready without a PASS: a skip is not enough,
 * because without it there is nothing to say yes to (the PR is not known to be mergeable, nobody but
 * the author read it, the screens were not shown, the words he hears are not the words bound).
 * A required check that is not a gate may be skipped with its reason — the queue says what was not
 * checked, so a gap is spoken, never passed off as a pass.
 */
export type ExpectedCheck = { name: CheckName; required: boolean; what: string; gate?: boolean };
export type WorkType = {
  /** How it is said aloud ("a UI PR"). */
  label: string;
  /** The finish line, in his words — what "done" means for this type of work. */
  done: string;
  /** What it may produce. A request of this type with none of these when it hands off is suspect. */
  deliverables: DeliverableKind[];
  /** The decisions this type of work usually ends in. */
  actions: Action[];
  /** The evidence slots a verifier fills. `required` = not ready without it. */
  evidence: ExpectedCheck[];
};

const TESTS: ExpectedCheck = { name: "tests", required: true, what: "the repo's own check command re-run locally, output kept" };
const PR_READY: ExpectedCheck = { name: "pr_ready", required: true, gate: true, what: "the PR exists, is open, mergeable and up to date with its base" };
const MATCHES: ExpectedCheck = { name: "matches_request", required: true, gate: true, what: "a reader that did not write it says the change does what was asked" };
const DRAFT_BOUND: ExpectedCheck = { name: "draft_bound", required: true, gate: true, what: "the words, recipient and channel he hears are the ones a yes is bound to" };

/**
 * A request's work type IS a terminal's goal kind (types.ts GoalKind) — one vocabulary, set where it
 * already is (the spawn dialog, `mc goal set --kind`). What differs by type is what "done" means and
 * what proves it, so the verifier knows what to run and the queue knows what to ask.
 */
export const WORK: Record<GoalKind, WorkType> = {
  pr: {
    label: "a backend PR",
    done: "A PR open against the right branch, tests green, and proof that nothing else broke.",
    deliverables: ["pr"],
    actions: ["merge"],
    evidence: [
      TESTS,
      { name: "regression", required: true, what: "the wider suite and the paths around the change still pass" },
      { name: "goal_test", required: true, what: "a test tied to the goal changed in the diff (fails before, passes after)" },
      PR_READY,
      MATCHES,
    ],
  },
  ui: {
    label: "a UI PR",
    done: "A PR open with tests green, before/after shots of every screen it changes at several widths, and a walkthrough of the flow.",
    deliverables: ["pr"],
    actions: ["merge"],
    evidence: [
      TESTS,
      { name: "regression", required: true, what: "the screens around the change still render and behave" },
      { name: "shots", required: true, gate: true, what: "before/after per screen, per viewport (meta: screen, viewport, side)" },
      { name: "walkthrough", required: true, what: "the user flow it changes, a recording or a shot per step" },
      PR_READY,
      MATCHES,
    ],
  },
  investigation: {
    label: "an analysis",
    done: "An answer in the form he asked for — a draft, a page, a dashboard. When it states figures from data: the queries behind them, a cross-check and the assumptions stated.",
    deliverables: ["answer", "slack_draft", "email_draft", "artifact", "dashboard", "doc"],
    actions: ["send", "review"],
    // The last three are owed by figures derived from data; an answer with none (a cause, a yes/no, a
    // drafted request) has them as `na`, never as a pass (verify-model.ts judgeAspects).
    evidence: [
      { ...MATCHES, what: "a reader that did not do the work says the answer addresses the question, in the form asked" },
      { name: "queries", required: true, what: "every query or source behind each number, re-runnable (n/a when it states no figures from data)" },
      { name: "crosscheck", required: true, what: "the headline numbers reproduced another way (n/a when it states no figures from data)" },
      { name: "assumptions", required: true, what: "what was assumed or left out in getting the numbers, stated (n/a when it states no figures from data)" },
    ],
  },
  qa: {
    label: "a QA pass",
    done: "A verdict: what was exercised, what passed, what failed, and how to reproduce each failure.",
    deliverables: ["answer", "doc"],
    actions: ["review"],
    evidence: [
      { name: "exercised", required: true, what: "what was actually run, where" },
      { name: "repro_steps", required: true, what: "exact steps for every failure" },
    ],
  },
  product: {
    label: "a product change",
    done: "Live: merged, deployed and checked in production. A bug: reproduced before, shown fixed after. A customer reply waits as a draft.",
    deliverables: ["pr", "deploy", "slack_draft", "email_draft"],
    actions: ["merge", "deploy", "send"],
    evidence: [
      TESTS,
      PR_READY,
      { name: "repro_before", required: false, what: "a bug: the failure reproduced before the fix" },
      { name: "fixed_after", required: false, what: "a bug: the same steps passing after it" },
      { name: "post_deploy", required: true, what: "checked in production after the deploy" },
      MATCHES,
    ],
  },
  chat: { label: "a conversation", done: "Nothing to finish.", deliverables: [], actions: [], evidence: [] },
};

/** The evidence slots of a request, filled from the checks it has: missing until a verifier runs. */
export function expectedChecks(
  kind: GoalKind | null | undefined,
  checks: Array<{ name: string; status: string; ran_at: string; note?: string | null }>,
  slots: ExpectedCheck[] | null = null,
): SlotStatus[] {
  if (!kind && !slots) return [];
  return (slots ?? WORK[kind!].evidence).map((e) => {
    // The newest run of a check is the one that counts.
    const last = checks.filter((c) => c.name === e.name).sort((a, b) => b.ran_at.localeCompare(a.ran_at))[0];
    return { ...e, status: (last?.status as CheckStatus | undefined) ?? "missing", note: last?.note ?? null };
  });
}

/**
 * The evidence slots one decision item is judged by: its request's work type, narrowed to what its
 * deliverable can carry. A PR is judged by the code slots (a product's `post_deploy` belongs to the
 * deploy, after the yes); a draft by whether its words are bound and answer what was asked; an
 * answer, document or page by its work type's own slots. Nothing for a deploy before the executor
 * binds what would go out.
 */
export function slotsFor(kind: GoalKind | null | undefined, deliverable: DeliverableKind | null | undefined): ExpectedCheck[] {
  const k: GoalKind = kind ?? "pr";
  if (deliverable === "pr") {
    const code = k === "pr" || k === "ui" || k === "product" ? WORK[k].evidence : WORK.pr.evidence;
    return code.filter((e) => e.name !== "post_deploy" && e.name !== "repro_before" && e.name !== "fixed_after");
  }
  if (deliverable === "slack_draft" || deliverable === "email_draft") return [DRAFT_BOUND, MATCHES];
  if (deliverable === "deploy") return [];
  if (k === "investigation" || k === "qa") return WORK[k].evidence;
  return [MATCHES];
}

/** One slot as the newest current check left it (`expectedChecks` over the checks for this target). */
export type SlotStatus = ExpectedCheck & { status: CheckStatus | "missing"; note?: string | null };
export type Readiness = {
  /** Every required slot has a result, none failed, every gate passed: ready for his yes. */
  ready: boolean;
  /** ready · failing (a check failed) · unverified (missing results, or a gate only skipped) · none (no slots: nothing to judge). */
  status: "ready" | "failing" | "unverified" | "none";
  /** Slots that passed. */
  passed: number;
  failed: Array<{ name: CheckName; note: string | null }>;
  missing: CheckName[];
  /** Required slots skipped with a reason — said aloud with the yes, never passed off as passes. */
  gaps: Array<{ name: CheckName; note: string | null }>;
  /** Gates that were only skipped: why it is not ready even though nothing failed. */
  gate_unmet: Array<{ name: CheckName; note: string | null }>;
  /** Slots that do not apply to this answer, each with why: not missing, not a gap, and never counted as a pass. */
  na: Array<{ name: CheckName; note: string | null }>;
};

/**
 * Is this item ready for his yes? Judged only on checks for its CURRENT target (the caller filters out
 * checks run against an older PR head or older words — those are stale). Pure.
 */
export function readiness(slots: SlotStatus[]): Readiness {
  const req = slots.filter((s) => s.required);
  const failed = slots.filter((s) => s.status === "fail").map((s) => ({ name: s.name, note: s.note ?? null }));
  const missing = req.filter((s) => s.status === "missing").map((s) => s.name);
  const gaps = req.filter((s) => s.status === "skip" && !s.gate).map((s) => ({ name: s.name, note: s.note ?? null }));
  // A gate needs a pass: one only skipped, or said not to apply, is unmet.
  const gate_unmet = req.filter((s) => s.gate && (s.status === "skip" || s.status === "na")).map((s) => ({ name: s.name, note: s.note ?? null }));
  const na = slots.filter((s) => s.status === "na" && !s.gate).map((s) => ({ name: s.name, note: s.note ?? null }));
  const passed = slots.filter((s) => s.status === "pass").length;
  if (!slots.length) return { ready: false, status: "none", passed, failed, missing, gaps, gate_unmet, na };
  const ready = !failed.length && !missing.length && !gate_unmet.length && passed > 0;
  return { ready, status: ready ? "ready" : failed.length ? "failing" : "unverified", passed, failed, missing, gaps, gate_unmet, na };
}

/** What a workspace's setup says a request of this type needs first. Only the VPN is known today. */
export function derivePrereqs(kind: GoalKind | null | undefined, ws: { vpn_config?: string | null } | null | undefined): Prereq[] {
  if (!ws?.vpn_config) return [];
  // Analysis and QA read data that sits behind the workspace's network; code work usually does not.
  if (kind !== "investigation" && kind !== "qa") return [];
  return [{ kind: "vpn", why: "this workspace's data sits behind its VPN — `mc vpn up` first", source: "workspace" }];
}

// ───────────────────────────── where it came from ─────────────────────────────

/** `sessions.created_by` → how the request arrived, for a terminal that opened a request of its own. */
export function viaOf(createdBy: string | null | undefined): Via {
  const by = (createdBy ?? "").trim();
  if (!by || by === "operator" || by === "ticket") return "hand";
  if (by === "robert" || by === "proactive") return "robert";
  if (by === "capture" || by === "inbox" || by === "job-check" || by === "follow-up" || by === "continuation" || by === "ship") return by;
  if (by === "failover" || by === "handoff") return "daemon";
  if (by.startsWith("lead:")) return "lead";
  return "agent";
}

/** Openers whose terminal carries on someone else's request: linked by their own event, adopted only if that never comes. */
export const DEFERRED_OPENERS: ReadonlySet<string> = new Set(["failover", "handoff", "continuation", "ship"]);

const BRIEF = "Brief from your operator:\n";
/**
 * The brief he typed in the spawn dialog, read back out of the seed it became (terminal.ts deskSeed):
 * between "Brief from your operator:" and the paragraph the seed always puts after it.
 */
export function briefFromSeed(seed: string | null | undefined): string | null {
  if (!seed) return null;
  const i = seed.indexOf(BRIEF);
  if (i < 0) return null;
  const rest = seed.slice(i + BRIEF.length);
  const end = rest.search(/\n\n(When the work is green|You are one card on your operator's Desk|Start now\.)/);
  return (end < 0 ? rest : rest.slice(0, end)).trim() || null;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** What was said to open a terminal, as far as the row knows: the goal as typed, and his brief when it is his. */
export function wordsOfSession(
  s: { spawn_goal?: string | null; goal?: string | null; title?: string | null; first_prompt?: string | null },
  via: Via,
): string {
  const goal = (s.spawn_goal || s.goal || s.title || "").trim();
  // Only the operator's own dialog brief is his words. A capture's brief is the page he captured; an
  // opener's brief is the daemon's.
  const brief = via === "hand" ? briefFromSeed(s.first_prompt) : null;
  return [goal, brief].filter(Boolean).join("\n\n").slice(0, 4000) || "(no goal given)";
}

// ───────────────────────────── which of Robert's turns made a move ─────────────────────────────

/**
 * Each workspace runs more than one Robert at once — his conversation (the operator lane) and the
 * daemon's wakes (the wake lane) — on separate processes with the same credential, so a terminal they
 * open or type into says nothing about which turn did it. Every tool call a turn makes is announced
 * first (agent.step, read back by robert-steps.ts terminalMove), so the move is matched to the
 * announcement that describes it.
 */
export type TurnLane = "operator" | "wake";
/** One announced tool call. `done` = its result came back (known for the operator lane only); `used` = it already accounts for a terminal. */
export type LiveStepView = { at: number; move: "open" | "type" | null; goal: string | null; sid: string | null; text: string | null; done: boolean; used: boolean };
export type LiveTurnView = { turn: string; lane: TurnLane; lastAt: number; steps: LiveStepView[] };
/** What the daemon saw: a terminal opened with this goal, or this line typed into this terminal. */
export type TerminalAct = { kind: "open"; goal: string | null } | { kind: "type"; sessionId: string; text: string | null };
/**
 * exact = the announcement names this terminal (its goal, or the id typed into) · step = a turn
 * announced this kind of move without naming it · recent = no turn announced it; the turn still at
 * work · caller = the API said which turn (the seam a lane-tagged credential will use).
 */
export type AttributionHow = "caller" | "exact" | "step" | "recent";
export type TurnPick = { turn: string; lane: TurnLane; how: Exclude<AttributionHow, "caller">; ambiguous: boolean; step: LiveStepView | null };

/** An announced move older than this is not evidence for a terminal arriving now (a refused open leaves one behind). */
export const STEP_EVIDENCE_MS = 120_000;
/** Two announcements this close together cannot be told apart by time. */
export const TIE_MS = 1_000;

/** Does the goal a step announced (clipped, maybe ending in "…") name this terminal's goal? */
export function sameWords(said: string | null | undefined, actual: string | null | undefined): boolean {
  if (!said || !actual) return false;
  const n = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const a = n(said);
  const b = n(actual);
  if (a.endsWith("…")) {
    const head = a.slice(0, -1).trimEnd();
    return head.length > 0 && b.startsWith(head);
  }
  return a === b;
}

/**
 * The turn that made a move, best evidence first:
 *   0 exact  — an unused, in-flight announcement that names it: the goal; or the terminal typed into
 *              (its words matching, then words not said, then words that differ — a step can misquote)
 *   1 step   — an unused, in-flight announcement of that kind of move that names nothing (a raw POST)
 *   2 step   — (opens) an unused, in-flight open announced with ANOTHER goal (a goal the step could not quote faithfully)
 *   3 recent — no turn announced it: the turns with a call still in flight
 *   4 recent — nothing in flight anywhere: whoever moved last
 * A lone candidate at the best tier is the answer. Several at tiers 0–2: the oldest announcement — an
 * earlier call lands first, and once it is used the next move takes the next one; two within TIE_MS
 * are a tie, and a tie goes to the operator's turn. Several
 * at 3–4: the operator's turn — when nothing tells them apart, losing his words is the costlier error.
 * Ambiguous = the evidence could not separate the candidates (a tie at tier 0, any choice at 1–4).
 * Pure: the caller marks the returned step used.
 */
export function pickTurn(cands: LiveTurnView[], act: TerminalAct, nowMs: number): TurnPick | null {
  if (!cands.length) return null;
  const fresh = (s: LiveStepView) => !s.used && !s.done && nowMs - s.at <= STEP_EVIDENCE_MS;
  type Ev = { c: LiveTurnView; tier: number; step: LiveStepView | null; at: number };
  const ev: Ev[] = cands.map((c) => {
    const steps = [...c.steps].sort((a, b) => a.at - b.at);
    const pick = (tier: number, s: LiveStepView): Ev => ({ c, tier, step: s, at: s.at });
    if (act.kind === "open") {
      const opens = steps.filter((s) => s.move === "open" && fresh(s));
      const exact = opens.filter((s) => sameWords(s.goal, act.goal));
      if (exact.length) return pick(0, exact[0]);
      const blind = opens.filter((s) => !s.goal);
      if (blind.length) return pick(1, blind[0]);
      if (opens.length) return pick(2, opens[0]);
    } else {
      // A typing step that names ANOTHER terminal is not evidence for this one.
      const types = steps.filter((s) => s.move === "type" && fresh(s));
      const exact = types.filter((s) => !!s.sid && act.sessionId.startsWith(s.sid));
      const said = exact.filter((s) => sameWords(s.text, act.text));
      if (said.length) return pick(0, said[0]);
      const unsaid = exact.filter((s) => !s.text);
      if (unsaid.length) return pick(0.5, unsaid[0]);
      if (exact.length) return pick(0.75, exact[0]);
      const blind = types.filter((s) => !s.sid);
      if (blind.length) return pick(1, blind[0]);
    }
    const inflight = steps.filter((s) => !s.done);
    if (inflight.length) return { c, tier: 3, step: null, at: inflight[inflight.length - 1].at };
    return { c, tier: 4, step: null, at: c.lastAt };
  });
  const best = Math.min(...ev.map((e) => e.tier));
  const pool = ev.filter((e) => e.tier === best);
  const how: TurnPick["how"] = best < 1 ? "exact" : best <= 2 ? "step" : "recent";
  const out = (e: Ev, ambiguous: boolean): TurnPick => ({ turn: e.c.turn, lane: e.c.lane, how, ambiguous, step: e.step });
  if (pool.length === 1) return out(pool[0], false);
  if (best >= 3) {
    // Nothing announced this move. The operator's turn, flagged; failing that the latest at work.
    const op = pool.filter((e) => e.c.lane === "operator").sort((a, b) => b.at - a.at)[0];
    return out(op ?? pool.sort((a, b) => b.at - a.at)[0], true);
  }
  pool.sort((a, b) => a.at - b.at);
  const tied = pool.filter((e) => e.at - pool[0].at <= TIE_MS);
  if (tied.length > 1) return out(tied.find((e) => e.c.lane === "operator") ?? tied[0], true);
  // The oldest announcement lands first. With content (tier 0) that is the answer; without, a guess.
  return out(pool[0], best >= 1);
}

// ───────────────────────────── links a hand-off names ─────────────────────────────

const URL_RE = /https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?\]]/g;
const PR_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
/**
 * The links a hand-off delivers — a document, a dashboard, a page — read from what it says it did (its
 * summary and changes; its proof is evidence, not a deliverable). PRs are counted on their own.
 * `dashboard` when the link says it is one; anything else is a `doc`.
 */
export function deliveredLinks(o: { summary?: string | null; changes?: string[] | null }): Array<{ kind: "doc" | "dashboard"; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: "doc" | "dashboard"; url: string }> = [];
  for (const text of [o.summary ?? "", ...(o.changes ?? [])]) {
    for (const m of String(text).matchAll(URL_RE)) {
      const url = m[0];
      if (PR_LINK.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ kind: /dashboard/i.test(url) ? "dashboard" : "doc", url });
    }
  }
  return out.slice(0, 6);
}

// ───────────────────────────── target hashes ─────────────────────────────

/**
 * The target a `send` binds to: what would go out, to whom, on which channel — hashed, never stored.
 * The executor recomputes it from the draft it is about to send and refuses on a mismatch. Keep it in
 * step with `mc hook` (scripts/mc, the draft branch), which computes it where the text is.
 */
export function draftHash(d: { channel: string; to: string; subject?: string | null; text: string }): string {
  const canon = JSON.stringify([d.channel.trim().toLowerCase(), d.to.trim().toLowerCase(), (d.subject ?? "").trim(), d.text]);
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

// ───────────────────────────── state roll-up ─────────────────────────────

/** One terminal as the roll-up sees it, through one link. */
export type TerminalView = {
  session_id: string;
  /** This request owns what the terminal hands off (inside this link's window). */
  primary: boolean;
  /** The link is still open — not handed over to a later request or a stand-in. */
  current: boolean;
  live: boolean;
  /** term-status phase: blocked · decide · review · your_turn · waiting · working · stalled · ended (null = unknown). */
  phase: string | null;
  line: string | null;
  kind: GoalKind | null;
  /** Newest hand-off it filed inside this link's window, or null. */
  outcome_at: string | null;
  /** It ticked its goal off (`goal_done_at`) inside this link's window. */
  goal_reached: boolean;
};

export type ItemView = {
  action: Action;
  status: ItemStatus;
  label: string;
  decision: Decision | null;
  hold_until: string | null;
  /** The deliverable's state, for a yes that still has to be carried out. */
  deliverable_state: DeliverableState | null;
};

export type RollUpInput = {
  closed_at: string | null;
  closed_reason: string | null;
  asked_at: string;
  terminals: TerminalView[];
  items: ItemView[];
  /** A fleet-wide request's per-workspace children: it is as urgent as the most urgent of them. */
  children?: Array<{ state: RequestState; line: string | null }>;
  now: number;
};

/** A request that no terminal picked up is still "working" this long, then "stuck". */
export const PICKUP_GRACE_MS = 10 * 60_000;

const PHASE_WORD: Record<string, string> = {
  blocked: "blocked", decide: "asks you", review: "reached its goal", your_turn: "finished its turn",
  waiting: "waiting", working: "working", stalled: "stalled", ended: "ended",
};

/** `short` = a live terminal that stopped without handing anything off (the stuck that a deferred question explains). */
type Part = { state: RequestState; line: string; short?: boolean };

/** What one terminal says about the request through its link, or null when the link is history. */
export function terminalPart(t: TerminalView): Part | null {
  if (!t.current) return null;
  const said = (fallback: string) => clip(t.line, 140) || fallback;
  if (t.live) {
    if (t.phase === "decide" || t.phase === "blocked") return { state: "needs_operator", line: said(PHASE_WORD[t.phase]) };
    if (t.phase === "stalled") return { state: "stuck", line: said("stalled — no sign of life") };
    if (t.phase === "working" || t.phase === "waiting" || t.phase === null) return { state: "working", line: said("working") };
    // your_turn / review: it stopped. Finished if it handed off, reached its goal, or there was never
    // anything to hand off (a chat); otherwise it stopped short and someone has to look.
    if (t.outcome_at || t.goal_reached || t.kind === "chat" || t.phase === "review") return { state: "done", line: said("finished") };
    return { state: "stuck", line: "stopped without a hand-off" + (t.line ? ` — ${clip(t.line, 110)}` : ""), short: true };
  }
  if (t.outcome_at || t.goal_reached || t.kind === "chat") return { state: "closed", line: "finished" };
  return { state: "stuck", line: "its terminal ended without a hand-off" };
}

const ITEM_WORD: Record<Action, string> = { merge: "merge", deploy: "deploy", send: "send", review: "review", answer: "answer" };

/**
 * The one resolved state of a request, and the line that says why. Precedence is the urgency order:
 * one part that needs the operator makes the whole request need him, whatever the rest is doing.
 * A question he put off ("later") explains a terminal that stopped short: parked, not stuck.
 *
 *  closed          — he closed it; or nothing is live, nothing is owed and every yes was carried out.
 *  needs_operator  — a decision item is open, or a terminal serving it asks him / is blocked.
 *  stuck           — a terminal stalled, stopped or died without a hand-off; or nothing picked it up.
 *  working         — something is moving it and nothing is owed.
 *  done            — the work is finished; nothing is owed right now, but something is still open
 *                    (a terminal not closed yet, a "later", a yes waiting for the executor).
 */
export function rollUp(inp: RollUpInput): { state: RequestState; line: string } {
  if (inp.closed_at) return { state: "closed", line: clip(inp.closed_reason, 160) || "closed" };

  const open = inp.items.filter((i) => i.status === "open");
  if (open.length) {
    const first = open[0];
    const more = open.length > 1 ? ` (+${open.length - 1} more)` : "";
    return { state: "needs_operator", line: `${ITEM_WORD[first.action]}: ${clip(first.label, 120)}${more}` };
  }

  const held = inp.items.filter((i) => i.status === "held");
  const parts: Part[] = [];
  for (const t of inp.terminals) {
    const p = terminalPart(t);
    // A terminal that stopped short while he holds one of this request's questions is waiting on what
    // he put off — parked, not stuck.
    if (p) parts.push(p.short && held.length ? { state: "done", line: p.line } : p);
  }
  for (const c of inp.children ?? []) parts.push({ state: c.state, line: c.line ?? c.state });

  const pick = (s: RequestState) => {
    const hit = parts.filter((p) => p.state === s);
    return hit.length ? { state: s, line: hit[0].line + (hit.length > 1 ? ` (+${hit.length - 1} more)` : "") } : null;
  };
  const urgent = pick("needs_operator") ?? pick("stuck") ?? pick("working");
  if (urgent) return urgent;

  if (!inp.terminals.length && !(inp.children ?? []).length) {
    return inp.now - Date.parse(inp.asked_at) < PICKUP_GRACE_MS
      ? { state: "working", line: "waiting for a terminal to pick it up" }
      : { state: "stuck", line: "nothing picked it up" };
  }

  // Every link handed over before anything was handed off here: the work carried on elsewhere.
  if (inp.terminals.length && inp.terminals.every((t) => !t.current) && !inp.terminals.some((t) => t.primary && t.outcome_at)) {
    return { state: "closed", line: "continued in a later request" };
  }
  // A request that only ever steered someone else's terminal ends when that terminal hands off.
  if (inp.terminals.length && inp.terminals.every((t) => !t.primary) && inp.terminals.every((t) => !t.current || t.outcome_at || !t.live)) {
    return { state: "closed", line: "carried into its terminal's own request" };
  }

  if (held.length) return { state: "done", line: `${ITEM_WORD[held[0].action]} held for later: ${clip(held[0].label, 110)}` };
  const approved = inp.items.filter((i) => i.status === "decided" && i.decision === "yes" && EXECUTABLE.has(i.action) && !(i.deliverable_state && FINAL_DELIVERABLE.has(i.deliverable_state)));
  if (approved.length) return { state: "done", line: `approved — ${ITEM_WORD[approved[0].action]} waits to be carried out: ${clip(approved[0].label, 100)}` };
  const stillOpen = parts.filter((p) => p.state === "done");
  if (stillOpen.length) return { state: "done", line: stillOpen[0].line + " — its terminal is still open" };
  const childOpen = (inp.children ?? []).some((c) => c.state !== "closed");
  if (childOpen) return { state: "done", line: "finished in some projects" };
  return { state: "closed", line: "finished" };
}

// ───────────────────────────── the approval queue ─────────────────────────────

export type QueueCandidate = {
  item_id: string;
  action: Action;
  status: ItemStatus;
  target_hash: string | null;
  hold_until: string | null;
  created_at: string;
  /** Verifier results on what this item is about: none yet = unverified. `gate_unmet` = gates only skipped (readiness). */
  checks: { pass: number; fail: number; missing_required: number; gate_unmet?: number };
};

/**
 * The order he should hear them in, best first:
 *   0 answer          — a terminal is blocked on his word right now
 *   1 ready           — executable, bound to a target, every required check passed
 *   2 bound           — executable and bound, not verified yet
 *   3 review          — a look, nothing executes
 *   4 unbound         — executable but nothing to bind a yes to yet (he can still say later/no/change)
 *   5 failing         — a check failed: not ready; heard last
 * Ties: oldest first, so nothing starves behind newer work. Held items are not in the queue.
 */
export function queueRank(c: QueueCandidate): number {
  if (c.action === "answer") return 0;
  if (c.checks.fail > 0) return 5;
  if (c.action === "review") return 3;
  if (!c.target_hash) return 4;
  return c.checks.pass > 0 && c.checks.missing_required === 0 && !c.checks.gate_unmet ? 1 : 2;
}

export function queueOrder<T extends QueueCandidate>(items: T[]): Array<T & { rank: number }> {
  return items
    .filter((i) => i.status === "open")
    .map((i) => ({ ...i, rank: queueRank(i) }))
    .sort((a, b) => a.rank - b.rank || a.created_at.localeCompare(b.created_at) || a.item_id.localeCompare(b.item_id));
}

// ───────────────────────────── the compact text ─────────────────────────────

export type LineRow = {
  id: string;
  state: RequestState;
  /** The goal its terminal is working toward, else his words. */
  title: string;
  state_line: string | null;
  via: Via;
  workspace?: string | null;
  /** n/total from the terminal's own progress, when it reports one. */
  progress?: string | null;
  /** What he approved on its terminal's hand-off card (card-approval.ts approvalWhat), while it still stands. */
  approved?: string | null;
};

const STATE_WORD: Record<RequestState, string> = { needs_operator: "needs you", stuck: "stuck", working: "working", done: "done", closed: "closed" };

/**
 * The ledger for a prompt: one short plain-language line per open request, most urgent first, capped.
 * Ids only where he may have to act on the row (needs you); a workspace name only on the fleet view.
 * Replaces fleet-line.ts's one-line-per-terminal block for a coordinator that follows requests.
 */
export function ledgerLines(rows: LineRow[], opts: { max?: number; width?: number; withWorkspace?: boolean } = {}): string {
  const max = opts.max ?? 20;
  const width = Math.max(60, opts.width ?? 160);
  const open = rows.filter((r) => OPEN_STATES.includes(r.state)).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  if (!open.length) return "LEDGER: nothing open.";
  const needs = open.filter((r) => r.state === "needs_operator").length;
  const lines = open.slice(0, max).map((r) => {
    const who = r.via === "robert" ? "Robert's own · " : "";
    const where = opts.withWorkspace && r.workspace ? `${r.workspace} · ` : "";
    const ref = r.state === "needs_operator" ? ` [${r.id.slice(0, 8)}]` : "";
    const why = r.state_line ? ` — ${r.state_line}` : "";
    const prog = r.progress && r.state === "working" ? ` · ${r.progress}` : "";
    const ok = r.approved ? ` · ✓ he approved ${r.approved} on its card` : "";
    return clip(`- ${STATE_WORD[r.state]} · ${where}${who}${clip(r.title, 90)}${prog}${ok}${why}`, width - ref.length) + ref;
  });
  if (open.length > max) lines.push(`- … ${open.length - max} more (mc ledger)`);
  return `LEDGER (${open.length} open · ${needs} need you):\n${lines.join("\n")}`;
}
