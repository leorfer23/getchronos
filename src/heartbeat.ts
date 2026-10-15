import { execFile } from "node:child_process";
import { Cron } from "croner";
import { getBackend } from "./backends/index.js";
import { bus } from "./bus.js";
import { postToBoard } from "./board.js";
import { CONFIG } from "./config.js";
import { flowData } from "./flow.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { listStalls } from "./recovery.js";
import { resultText } from "./summarize.js";
import { asks, chat, ideas, kv, reviews, workspaces } from "./store.js";
import { askManagerWeb } from "./telegram/agent.js";
import { esc, notify } from "./telegram/api.js";

// Fleet heartbeat — OpenClaw pattern adapted for Chronos executives:
//   1) active hours gate (no LLM)
//   2) optional digest fingerprint skip (off by default — proactive mode)
//   3) haiku GATE — WAKE when there's a fresh proposal; NOOP only if nothing new
//   4) on WAKE → warm executive generates work for the operator to approve
//   5) silence tokens (NOOP / HEARTBEAT_OK) suppress delivery
//
// Morning/evening Robert briefs still force-wake (skip haiku) at the edges of the window.

// One live executive while Robert is the only executive. The union is kept (rather than collapsed to a bare string)
// so every Record<FleetAgent, …> below still has to be exhaustive if another one is ever added back.
export type FleetAgent = "robert";
export type Kind = "morning" | "hourly" | "evening" | "now" | "standup";

const AGENTS: FleetAgent[] = ["robert"];
const STAGGER_MS: Record<FleetAgent, number> = {
  robert: 0,
};

/**
 * One proposal agent per half-hour slot so the operator isn't flooded at once. With Ada, Nils and
 * Iris retired the rotation is a single entry, so every slot resolves to Robert — the modulo
 * below still holds and there are no empty slots: a one-element rotation never skips a tick, it
 * just always names the same executive. Morning/evening bookends are Robert-only too
 * (see agentsForTick), which is now the same thing.
 */
const ROTATION: FleetAgent[] = ["robert"];
export function proposalAgentFor(now = new Date()): FleetAgent {
  const slot = now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
  return ROTATION[((slot % ROTATION.length) + ROTATION.length) % ROTATION.length]!;
}

/** Who actually runs on this cron tick. */
export function agentsForTick(kind: Kind, now = new Date(), forceAll = false): FleetAgent[] {
  if (forceAll) return [...AGENTS];
  // Bookend briefs + the daily standup stay Robert-only (already proposal-heavy).
  if (kind === "morning" || kind === "evening" || kind === "standup") return ["robert"];
  return [proposalAgentFor(now)];
}

const CHECKLIST: Record<FleetAgent, string> = {
  robert:
    `YOU ARE A CHIEF OF STAFF WHO GENERATES WORK — not a status printer.\n` +
    `- Invent 1 high-leverage proposal the operator can approve: new ticket, idea-pool card, dispatch, or priority call\n` +
    `- Look at fleet + idea pools + stalled P0/P1 + gaps in the roadmap — then go beyond them (what is he NOT doing that he should?)\n` +
    `- File SPECCED idea cards (POST /api/workspaces/:id/ideas) when useful; never promote/build without his go\n` +
    `- Prefer ONE sharp proposal over a laundry list. NOOP only if you already proposed the same thing recently`,
};

// Recovery asks about a stall exactly ONCE (recovery.ts records "asked" before sending, so a failed
// notify can't re-ask forever). The cost of that safety is silence: an unanswered stall never comes
// back on its own. Every forced brief re-raises them by name — this line is the only thing between a
// dropped run and it being forgotten.
const RERAISE =
  `\nSTILL WAITING ON HIM — GET /api/recovery lists work that STOPPED and is awaiting his call. It was raised ` +
  `once and never answered, and nothing will raise it again unless you do. Name each item with its age and what ` +
  `approving would do, oldest first, in EVERY brief until he answers. Do not resume any of it yourself.`;

// Every forced brief is a STATUS BRIEF, so it takes the four sections; the wording, the empty
// states and the quiet-shop collapse live in agents/_blocks/brief.md and are not restated here.
const FOUR =
  `\nBrief in THE STATUS BRIEF's four sections — Needs you · Landed · Underway · Next — every section ` +
  `present with its empty state, a complete snapshot rather than a delta.`;

const FORCE_PROMPTS: Record<"morning" | "evening" | "now", string> = {
  morning:
    `${OP_PREFIX}9am proactive heartbeat (the operator did NOT message you). You are chief of staff generating the day's agenda.\n` +
    `Read GET /api/fleet, pending reviews, open asks (GET /api/asks?status=open — a worker waiting on an ` +
    `answer, lead with these), blocked + open P0/P1 across workspaces, and recent idea pools.\n` +
    `Brief him, then PROPOSE 2–3 NEW things worth doing today he hasn't already locked ` +
    `(title · workspace · why · approve?). Push him to pick. File idea cards for anything he might want later. ` +
    `Do not promote or dispatch without an explicit go.` + FOUR + RERAISE,
  evening:
    `${OP_PREFIX}end-of-day proactive heartbeat (the operator did NOT message you).\n` +
    `Read GET /api/fleet + GET /api/report (today) + open asks (GET /api/asks?status=open) — any worker still ` +
    `waiting on an answer is a Needs-you line, not a footnote.\n` +
    `Then GENERATE tomorrow: propose 2–4 NEW high-value tickets/ideas (title · workspace · why · approve?) — ` +
    `mix finishing open loops with fresh opportunities. File idea-pool cards for the ones that aren't tickets yet. ` +
    `Do NOT create/promote tickets without his go — propose and wait.` + FOUR + RERAISE,
  now:
    `${OP_PREFIX}the operator asked for a briefing RIGHT NOW. Read fleet + pending reviews + open asks ` +
    `(GET /api/asks?status=open) + blocked/P0/P1.\n` +
    `Give the readout, then name the ONE highest-value next action AND one fresh proposal ` +
    `he hasn't heard. Never reply NOOP.` + FOUR + RERAISE,
};

// ── Daily standup ────────────────────────────────────────────────────────────
// A briefing tells the operator what the fleet is doing; a standup is what HE says out loud to a client team
// at their daily. Different job: it is sourced from the client's own trail (PRs, tracker tickets,
// commits) rather than from Chronos state, and the output is a message he can paste, not advice.

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/** Working-day lookback: Monday reaches back to Friday, so the weekend never swallows Friday's work. */
export function standupSince(now = new Date()): string {
  const back = now.getDay() === 1 ? 3 : now.getDay() === 0 ? 2 : 1;
  return dayStr(new Date(now.getTime() - back * 86_400_000));
}

export function standupPrompt(target: WsTarget | undefined, now = new Date()): string {
  const slug = target?.slug ?? "the fleet";
  const wsId = target?.id ?? "";
  const ws = wsId ? workspaces.get(wsId) : undefined;
  const tracker =
    ws?.ticket_connector === "clickup"
      ? "ClickUp"
      : ws?.ticket_connector === "jira"
        ? "Jira"
        : "the ticket tracker";
  const since = standupSince(now);
  const today = dayStr(now);
  const wsPath = wsId ? `/api/workspaces/${wsId}` : "/api/workspaces";
  return (
    `${OP_PREFIX}10:00 DAILY STANDUP for the ${slug} workspace (the operator did NOT message you). ` +
    `This is the one message a day where a status report IS the deliverable: the operator reads it out loud ` +
    `at the ${slug} standup, so every line must be specific, true, and traceable to something you read.\n` +
    `TODAY IS ${today}. WINDOW: work touched since ${since} (on a Monday that covers the weekend).\n\n` +
    `RESEARCH FIRST — use Bash, in this order. A source that returns nothing gets OMITTED, never invented:\n` +
    `1. Repos — GET ${wsPath} → its repos[] give path + git_remote for this client.\n` +
    `2. Per repo, from its path: \`gh pr list --author @me --state all --limit 20 --json number,title,url,state,updatedAt,mergedAt\` ` +
    `(keep only updatedAt >= ${since}), \`gh pr list --search "review-requested:@me" --json number,title,url\`, and ` +
    `\`git -C <path> log --all --since=${since} --author="$(git -C <path> config user.email)" --oneline\`. ` +
    `Merged, opened, reviewed and still-open PRs are all standup material.\n` +
    `3. Client tracker (${tracker}) — POST ${wsPath}/sync first so the mirror is fresh, then ` +
    `GET /api/tickets?workspace=${wsId} for what moved, what is in progress, what is blocked. Quote the ` +
    `CLIENT ticket key when the ticket carries one.\n` +
    `4. Agent work — GET /api/fleet, GET /api/report?workspace=${wsId}&from=${since}, ` +
    `GET /api/reviews?state=pending, GET /api/activity?workspace=${wsId}&limit=40. Work an agent shipped ` +
    `for this client is the operator's work; a review waiting on them is a today item.\n` +
    `5. Open asks — GET /api/asks?status=open&workspace=${wsId}: a worker parked mid-ticket waiting on his ` +
    `answer is today's blocker, not yesterday's win.\n` +
    `6. Today's shape — GET /api/calendar for meetings, plus your own memory and this thread for what he ` +
    `said yesterday he would do.\n\n` +
    `OUTPUT — post-ready English, no preamble, no "here is your standup", no questions:\n` +
    `🗒️ **Standup · ${slug} · ${today}**\n` +
    `**Yesterday:** 3–6 lines, one per piece of work — what changed, its ticket key, its PR link and state ` +
    `(merged / in review / open).\n` +
    `**Today:** 3–5 lines in priority order — what he actually works on, drawn from what is in progress, ` +
    `in review, or next in the queue.\n` +
    `**Blockers:** what needs someone else (a review, access, an open ask waiting on his answer), or "none".\n\n` +
    `RULES: under 200 words. Past tense and concrete verbs for yesterday — no "worked on stuff". Ticket keys ` +
    `and PR numbers, not vague nouns. Only this workspace; another standup covers the other client. ` +
    `No PROPOSE line, no UI directives, and never NOOP — this one always posts.`
  );
}

const LABEL: Record<FleetAgent, string> = {
  robert: "Robert",
};

/**
 * Robert speaks in rooms, never 1:1.
 *
 * A workspace target pins one bookend brief (morning / end of day) to the workspace it is about.
 * Robert already runs one warm process per workspace, so the brief is written by the process that
 * has that workspace's thread — no cross-client bleed. Briefs land on the board (workspace-tagged)
 * and in the Flow thread; there is no per-room routing to configure anymore.
 */
export type WsTarget = { id: string | null; slug: string };

/** Every non-archived workspace, as bookend targets. */
export function workspaceTargets(list: { id: string; slug: string }[]): WsTarget[] {
  return list.map((w) => ({ id: w.id, slug: w.slug }));
}

function bookendTargets(): (WsTarget | undefined)[] {
  const targets = workspaceTargets(workspaces.list());
  return targets.length ? targets : [undefined];
}

/**
 * Standup targets — the projects the operator actually stands up for, which is rarely all of them.
 * A standup for your own tooling is a message nobody asked for. Unlike the bookends there is no
 * unscoped fallback: nothing configured → no standup.
 */
export function standupTargets(slugs = CONFIG.standup.workspaces): WsTarget[] {
  const want = new Set(slugs.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return workspaceTargets(workspaces.list()).filter((t) => want.has(t.slug.toLowerCase()));
}

// ── Active hours (OpenClaw-compatible HH:MM window) ──────────────────────────

const TIME_RE = /^([01]\d|2[0-3]|24):([0-5]\d)$/;

export function parseHm(raw: string, allow24 = false): number | null {
  if (!TIME_RE.test(raw)) return null;
  const [hStr, mStr] = raw.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (h === 24) return allow24 && m === 0 ? 24 * 60 : null;
  return h * 60 + m;
}

/** Inclusive start, exclusive end. Overnight windows (end < start) supported. */
export function isWithinActiveHours(
  now = new Date(),
  start = CONFIG.dayHeartbeat.activeStart,
  end = CONFIG.dayHeartbeat.activeEnd,
): boolean {
  const startMin = parseHm(start, false);
  const endMin = parseHm(end, true);
  if (startMin == null || endMin == null) return true;
  if (startMin === endMin) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (endMin > startMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

/** First half-hour slot of the active window → morning; last slot before end → evening; else hourly. */
export function heartbeatKind(hour: number, minute = 0): Kind {
  const startMin = parseHm(CONFIG.dayHeartbeat.activeStart) ?? 9 * 60;
  const endMin = parseHm(CONFIG.dayHeartbeat.activeEnd, true) ?? 20 * 60;
  const cur = hour * 60 + minute;
  const startH = Math.floor(startMin / 60);
  // Last 30m slot before exclusive end (end 20:00 → 19:30).
  const lastSlot = endMin > 30 ? endMin - 30 : 0;
  if (hour === startH && minute < 30) return "morning";
  if (cur >= lastSlot && cur < endMin) return "evening";
  return "hourly";
}

// ── Digests (context for the gate; optional skip when digestSkip=1) ───────────

/** One line of the brief. `id` is the identity the exactly-one-bucket rule is enforced on. */
export interface BriefItem {
  id: string;
  label: string;
}

/** The four sections of agents/_blocks/brief.md, in order. Empty array = that section's empty state. */
export interface BriefBuckets {
  needs_you: BriefItem[];
  landed: BriefItem[];
  underway: BriefItem[];
  next: BriefItem[];
}

/** Highest first: where an item lands when two rules would claim it. */
const BUCKET_ORDER: (keyof BriefBuckets)[] = ["needs_you", "landed", "underway", "next"];

/**
 * The brief's DATA, already bucketed.
 *
 * Robert's brief has four sections and one rule that decides them, so the daemon hands him the
 * buckets rather than a flat pile he has to sort in prose. Sorting in prose is exactly how a
 * working run ends up under "needs you": the model reads a ticket body, finds urgent-sounding
 * words, and promotes it. Here the bucket comes from STRUCTURED STATE only — an open ask, a
 * review waiting, the status column, whether the work stopped before finishing — and nothing
 * reads a body.
 *
 * An item belongs to exactly one bucket: `place` keeps the first (highest-precedence) claim and
 * drops later ones, so the same ticket can never be counted twice. A ticket that is genuinely both
 * running and waiting on a decision contributes TWO items with different ids — its own row under
 * Underway, its ask's row under Needs you — which is what brief.md asks for.
 */
export function briefBuckets(now = new Date()): BriefBuckets {
  const seen = new Map<string, keyof BriefBuckets>();
  const out: BriefBuckets = { needs_you: [], landed: [], underway: [], next: [] };
  const place = (bucket: keyof BriefBuckets, id: string, label: string) => {
    const held = seen.get(id);
    if (held && BUCKET_ORDER.indexOf(held) <= BUCKET_ORDER.indexOf(bucket)) return;
    if (held) out[held] = out[held].filter((i) => i.id !== id);
    seen.set(id, bucket);
    out[bucket].push({ id, label });
  };

  // A worker parked on a human decision — the strongest claim on his attention there is.
  for (const a of asks.list({ status: "open" }).slice(0, 12))
    place("needs_you", `ask:${a.id.slice(0, 8)}`, `ask ${a.asked_by ?? "worker"}`);

  // Work that stopped before finishing. Only the stable handle, never listStalls' rendered line:
  // that line carries an age, and an age turns this fingerprint over every hour on its own.
  for (const s of listStalls().slice(0, 8)) place("needs_you", `stopped:${s.id}`, `stopped ${s.id}`);

  const f = flowData(now);
  for (const t of f.shipped.slice(0, 20)) {
    const id = `ticket:${t.key || t.id}`;
    // review = built and waiting on a yes; done = it landed. Nothing else reaches flowShipped.
    if (t.status === "review") place("needs_you", id, `${t.key || t.id}:review`);
    else place("landed", id, `${t.key || t.id}:done`);
  }
  for (const t of f.queue.slice(0, 20)) {
    const id = `ticket:${t.key || t.id}`;
    const tag = `${t.key || t.id}:${t.status}:P${t.priority}`;
    if (t.status === "blocked" || t.status === "planned") place("needs_you", id, tag);
    else if (t.status === "in_progress") place("underway", id, tag);
    else place("next", id, tag);
  }
  if (f.state.live_sessions) place("underway", "terminals", `${f.state.live_sessions} live`);

  // Proposals are things he could pick up, not things anyone is waiting on — Next, never Needs you.
  for (const i of ideas.list({ status: "proposed" }).slice(0, 8))
    place("next", `idea:${i.id}`, `idea ${i.title.slice(0, 40)}`);

  return out;
}

/** The gate's snapshot + change fingerprint: the four buckets, flattened. Clock-free by construction. */
function robertDigest(): string {
  try {
    const b = briefBuckets();
    const section = (items: BriefItem[]) => items.map((i) => i.label).join(",");
    // All four empty is the quiet shop, and it has to fingerprint as one stable string — otherwise
    // "nothing is happening" and "nothing is happening" compare unequal and the gate wakes him.
    if (!BUCKET_ORDER.some((k) => b[k].length)) return "quiet";
    return (
      `need=${section(b.needs_you)}|land=${section(b.landed)}|` +
      `under=${section(b.underway)}|next=${section(b.next)}`
    );
  } catch {
    return "";
  }
}

export function agentDigest(agent: FleetAgent, _now = new Date()): string {
  switch (agent) {
    case "robert":
      return robertDigest();
  }
}

function digestKey(agent: FleetAgent): string {
  return `heartbeat.digest.${agent}`;
}

// ── Gate parse / silence (OpenClaw HEARTBEAT_OK contract) ─────────────────────

export function parseGateReply(raw: string | null | undefined): { wake: boolean; reason: string } {
  if (!raw) return { wake: false, reason: "" };
  const t = raw.trim().replace(/^[*`_]+|[*`_]+$/g, "");
  if (!t) return { wake: false, reason: "" };
  if (/^(NOOP|HEARTBEAT_OK)\b/i.test(t)) return { wake: false, reason: "" };
  const m = t.match(/^WAKE\b[\s:.—-]*(.*)$/is);
  if (m) return { wake: true, reason: (m[1] || "").trim().replace(/\s+/g, " ").slice(0, 400) };
  // Strict: anything else is treated as NOOP so a chatty haiku can't burn a sonnet turn.
  return { wake: false, reason: "" };
}

export function isSilenceReply(raw: string): boolean {
  const trimmed = (raw || "").trim();
  if (!trimmed) return true;
  // OpenClaw-style: strip light markup wrappers, keep internal chars (HEARTBEAT_OK underscore).
  const normalized = trimmed
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  // The token is the VERDICT wherever it lands. Models pad it both ways — "NOOP — chequeé el
  // fleet, nada se movió…" and "No new mail since last check. NOOP" — and any length cap or
  // leading-only match turns those non-reports into phone pings. If the agent said NOOP, the
  // surrounding prose is explanation, not a report: silence.
  if (/^(NOOP|HEARTBEAT_OK)\b/i.test(normalized)) return true;
  if (/(^|\s)[*`~_]*(NOOP|HEARTBEAT_OK)[*`~_.!]*$/i.test(normalized)) return true;
  return false;
}

// ── Haiku gate (no tools — snapshot is in the prompt) ────────────────────────

function gatePrompt(agent: FleetAgent, digest: string, kind: Kind): string {
  return (
    `You are the cheap HEARTBEAT GATE for ${LABEL[agent]} (Chronos executive). ` +
    `${LABEL[agent]} has the sole proposal slot this tick (the other executives are silent). ` +
    `Decide whether to wake them to PROPOSE one thing for the operator to approve. You have NO tools — only this snapshot.\n\n` +
    `KIND: ${kind}\n` +
    `MISSION:\n${CHECKLIST[agent]}\n\n` +
    `SNAPSHOT:\n${digest || "(empty)"}\n\n` +
    `Bias toward WAKE when there is a concrete NEW proposal angle. NOOP only if nothing fresh.\n\n` +
    `Reply with EXACTLY one of:\n` +
    `NOOP\n` +
    `WAKE <one short proposal hook>\n\n` +
    `No preamble.`
  );
}

export function runGateHaiku(prompt: string, timeoutMs = 45_000): Promise<string | null> {
  const model = CONFIG.dayHeartbeat.gateModel || "haiku";
  const configDir = CONFIG.profiles[CONFIG.agent.profile] ?? CONFIG.profiles.claude;
  const backend = getBackend("claude-code");
  const spec = backend.oneShot({
    prompt,
    system:
      "Heartbeat gate only. Reply with exactly NOOP or WAKE <reason>. No tools. No markdown fencing.",
    model,
    configDir,
    maxBudgetUsd: 0.05,
    allowedTools: "",
  });
  return new Promise((resolve) => {
    try {
      execFile(
        spec.cmd,
        spec.args,
        {
          timeout: timeoutMs,
          maxBuffer: 1 << 20,
          env: { ...process.env, ...spec.env },
        },
        (err, stdout) => resolve(err ? null : resultText(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}

// ── Execute (warm executive) ─────────────────────────────────────────────────

function executePrompt(
  agent: FleetAgent,
  reason: string,
  kind: Kind,
  target?: WsTarget,
  now = new Date()
): string {
  if (agent === "robert" && kind === "standup") return standupPrompt(target, now);
  if (agent === "robert" && (kind === "morning" || kind === "evening" || kind === "now")) {
    const scope = target
      ? `\nSCOPE — this brief is ONLY about the ${target.slug} workspace and posts in its channel. ` +
        `Ignore other workspaces; another brief covers each of them. Skip the preamble, no cross-client detail.`
      : "";
    return FORCE_PROMPTS[kind] + scope;
  }
  return (
    `${OP_PREFIX}proactive fleet heartbeat (${kind}). The operator did NOT message you. ` +
    `You are the only executive, so every proposal slot is yours. Generate work.\n` +
    `Gate hook: ${reason || "(unspecified)"}\n\n` +
    `YOUR MISSION:\n${CHECKLIST[agent]}\n\n` +
    `Do the extra mile:\n` +
    `1. Read your domain (fleet / reviews / open tickets / idea pools) via tools.\n` +
    `2. INVENT one concrete proposal the operator can approve or reject — not a status dump.\n` +
    `   Idea-pool card and/or ticket draft (title · workspace · why · approve?).\n` +
    `3. If you file lasting work, use idea cards — never promote, dispatch, or send external without his go.\n` +
    `4. Message him in your voice (1–8 sentences). Lead with the proposal. Ask clearly for approve/kill/later.\n` +
    `5. Reply NOOP only if you have zero fresh angle after checking.\n` +
    `Do not invent fake urgency. Do not ask empty "what can I do for you?". Propose.`
  );
}

async function askAgent(agent: FleetAgent, prompt: string, target?: WsTarget): Promise<string> {
  switch (agent) {
    case "robert":
      return (await askManagerWeb(prompt, undefined, target?.id ?? null)).reply || "";
  }
}

function recentTurnKey(_agent: FleetAgent, target?: WsTarget): string {
  // Robert's warm process is per workspace and stamps `web.lastTurnAt:<wsId>` — a chat in Acme
  // must not silence the Globex brief.
  return `web.lastTurnAt:${target?.id ?? "default"}`;
}

function recentlySpoke(agent: FleetAgent, target?: WsTarget): boolean {
  const min = CONFIG.dayHeartbeat.recentTurnSkipMin ?? 12;
  if (min <= 0) return false;
  const last = Number(kv.get(recentTurnKey(agent, target)) ?? 0);
  return Boolean(last && Date.now() - last < min * 60_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Morning/evening/standup/now — never silently drop; Telegram is the backup surface. */
function isBookendKind(kind: Kind): boolean {
  return kind === "morning" || kind === "evening" || kind === "standup" || kind === "now";
}

async function deliver(
  agent: FleetAgent,
  reply: string,
  kind: Kind,
  target?: WsTarget
): Promise<boolean> {
  const ROBERT_LABEL: Partial<Record<Kind, string>> = {
    morning: "☀️ Morning briefing",
    evening: "🌙 End of day",
    now: "☀️ Briefing",
    standup: "🗒️ Standup",
  };
  const base = agent === "robert" ? (ROBERT_LABEL[kind] ?? "⏱ Robert") : `⏱ ${LABEL[agent]}`;
  const label = target ? `${base} · ${target.slug}` : base;

  if (agent === "robert") {
    // Dashboard record (Flow thread + live push). Bookends also mirror to Telegram below so a
    // failed board write can never hide the day's briefing.
    const row = chat.add(label, reply, "heartbeat", target?.id ?? null);
    chat.prune(2000);
    bus.publish({
      topic: "agent.push",
      you: label,
      reply,
      at: row.created_at,
      source: "heartbeat",
      id: row.id,
      ws: target?.id ?? null,
    });
  }

  // Every heartbeat lands on the board as that executive's own post — the fleet-summary cards the
  // /app Board view renders. Local SQLite write: no relay, no retries, no per-agent DM routing.
  // The standup already opens with its own dated header and is meant to be copied out verbatim —
  // a second bold label on top would ride along into whatever the operator pastes it into.
  let boardOk = true;
  try {
    const content = target && kind !== "standup" ? `**${label}**\n\n${reply}` : reply;
    postToBoard({ author: agent, body: content, kind: "heartbeat", workspace_id: target?.id ?? null });
  } catch (e) {
    boardOk = false;
    console.error(`[heartbeat] board post ${agent} failed`, e);
  }

  // Telegram mirror for Robert — bookends always; hourly WAKE briefs when telegramMirror is on.
  // (Also fires on a board failure for any agent.)
  if (agent === "robert" && (isBookendKind(kind) || CONFIG.dayHeartbeat.telegramMirror)) {
    const body = esc(reply.replace(/\s+$/, "").slice(0, 3500));
    // This IS Robert speaking unprompted — the one message on this surface that is a person rather
    // than an event. It used to arrive looking like every other system line, which is why the
    // proactive briefs read as noise and the operator concluded Robert only answers when spoken to
    // (PER-26). Signing it makes his voice findable in the stream.
    const head = boardOk
      ? `👔 <b>Robert</b> · ${esc(label)}`
      : `👔 <b>Robert</b> · ${esc(label)} ⚠️ (board post failed — content below)`;
    await notify(`${head}\n\n${body}`, undefined, { board: false }).catch((e) =>
      console.error("[heartbeat] telegram mirror failed", e),
    );
  } else if (!boardOk) {
    await notify(
      `⚠️ <b>Heartbeat</b> ${esc(LABEL[agent])} failed to post to the board` +
        (target ? ` · ${esc(target.slug)}` : ""),
      undefined,
      { board: false },
    ).catch(() => {});
  }

  return boardOk;
}

// ── Per-agent tick ───────────────────────────────────────────────────────────

export type AgentTickOpts = {
  agent: FleetAgent;
  kind?: Kind;
  /** Workspace this tick is about — scopes the prompt, the warm process, and the channel. */
  target?: WsTarget;
  force?: boolean;
  /** Skip digest short-circuit (still may NOOP via gate). */
  skipDigest?: boolean;
  /** Test override: enable digest short-circuit even when config has it off. */
  useDigestSkip?: boolean;
  now?: Date;
  /** Injected for tests. */
  gateFn?: (prompt: string) => Promise<string | null>;
  askFn?: (agent: FleetAgent, prompt: string, target?: WsTarget) => Promise<string>;
  deliverFn?: (agent: FleetAgent, reply: string, kind: Kind, target?: WsTarget) => Promise<void>;
};

export async function runAgentHeartbeat(opts: AgentTickOpts): Promise<{
  agent: FleetAgent;
  skipped: string | null;
  woke: boolean;
  delivered: boolean;
}> {
  const agent = opts.agent;
  const target = opts.target;
  const now = opts.now ?? new Date();
  const kind = opts.kind ?? heartbeatKind(now.getHours(), now.getMinutes());
  const force = Boolean(opts.force);
  const gateFn = opts.gateFn ?? runGateHaiku;
  const askFn = opts.askFn ?? askAgent;
  const deliverFn = opts.deliverFn ?? deliver;

  // Bookends must fire even if the operator just chatted with Robert in that room — recent-turn is for
  // hourly nags only. A morning brief skipped because of a 9:02 DM is how whole days go dark.
  if (!force && kind === "hourly" && recentlySpoke(agent, target)) {
    return { agent, skipped: "recent-turn", woke: false, delivered: false };
  }

  const digest = agentDigest(agent, now);
  const dKey = digestKey(agent);
  const digestSkip = opts.useDigestSkip ?? CONFIG.dayHeartbeat.digestSkip;
  if (digestSkip && !force && !opts.skipDigest && kind === "hourly") {
    const prev = kv.get(dKey);
    // Empty digests still count — a quiet Ham queue should not re-gate every 30m.
    if (prev !== undefined && prev !== null && prev === digest) {
      return { agent, skipped: "digest-unchanged", woke: false, delivered: false };
    }
  }

  // Forced morning/evening for Robert: skip haiku, go straight to executive.
  // Hourly force (API) still uses the gate — only digest is skipped — so we don't burn a
  // sonnet turn when the board is quiet.
  const scripted = kind === "morning" || kind === "evening" || kind === "now" || kind === "standup";
  const forceExec = (force && scripted) || (agent === "robert" && scripted);

  let reason = force ? `forced:${kind}` : "";
  if (!forceExec) {
    const gateRaw = await gateFn(gatePrompt(agent, digest, kind));
    const gate = parseGateReply(gateRaw);
    kv.set(dKey, digest);
    if (!gate.wake) {
      console.log(`[heartbeat] ${agent}: gate NOOP`);
      return { agent, skipped: "gate-noop", woke: false, delivered: false };
    }
    reason = gate.reason || "gate wake";
    console.log(`[heartbeat] ${agent}: gate WAKE — ${reason.slice(0, 120)}`);
  } else {
    kv.set(dKey, digest);
  }

  // Bookends retry once on stall/login blips — a single SIGKILL used to eat an entire EOD.
  const execAttempts = forceExec ? 2 : 1;
  let reply = "";
  let lastExecErr: unknown;
  for (let i = 1; i <= execAttempts; i++) {
    try {
      reply = (
        await askFn(
          agent,
          executePrompt(agent, reason, forceExec ? kind : "hourly", target, now),
          target
        )
      ).trim();
      lastExecErr = null;
      break;
    } catch (e) {
      lastExecErr = e;
      console.error(`[heartbeat] ${agent} execute failed (attempt ${i}/${execAttempts})`, e);
      if (i < execAttempts) await sleep(2000 * i);
    }
  }
  if (lastExecErr) {
    if (forceExec) {
      await notify(
        `⚠️ <b>${esc(LABEL[agent])} ${esc(kind)}</b>` +
          (target ? ` · ${esc(target.slug)}` : "") +
          ` execute failed: ${esc(String((lastExecErr as any)?.message ?? lastExecErr).slice(0, 200))}`,
        undefined,
        { board: false },
      ).catch(() => {});
    }
    return { agent, skipped: "execute-error", woke: true, delivered: false };
  }

  if (isSilenceReply(reply)) {
    // Bookends must never NOOP-out of a scheduled brief — surface the silence instead of vanishing.
    if (forceExec && agent === "robert") {
      console.log(`[heartbeat] ${agent}: executive NOOP on ${kind} — escalating`);
      await notify(
        `⚠️ <b>${esc(LABEL[agent])} ${esc(kind)}</b>` +
          (target ? ` · ${esc(target.slug)}` : "") +
          ` returned NOOP (no brief generated)`,
        undefined,
        { board: false },
      ).catch(() => {});
      return { agent, skipped: "exec-noop", woke: true, delivered: false };
    }
    console.log(`[heartbeat] ${agent}: executive NOOP`);
    return { agent, skipped: "exec-noop", woke: true, delivered: false };
  }

  // Same words as last time = nothing actually new — silence, don't re-send. Hourly proposals
  // only: a bookend/standup repeating itself is still a scheduled brief that must land.
  const replyKey = `heartbeat.lastReply.${agent}${target?.id ? ":" + target.id : ""}`;
  const replyFp = reply.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!forceExec && kv.get(replyKey) === replyFp) {
    console.log(`[heartbeat] ${agent}: same reply as last delivery — silence`);
    return { agent, skipped: "duplicate-reply", woke: true, delivered: false };
  }
  kv.set(replyKey, replyFp);

  const deliverKind = forceExec ? kind : "hourly";
  await deliverFn(agent, reply, deliverKind, target);
  console.log(`[heartbeat] ${agent}: delivered${target ? ` → ${target.slug}` : ""}`);
  return { agent, skipped: null, woke: true, delivered: true };
}

/**
 * Legacy single-manager entry (API "brief me now" + tests). Bookends fan out one brief per
 * workspace room; an ad-hoc "now" stays one brief on the fleet channel.
 */
export async function runHeartbeat(kind: Kind, force = false): Promise<void> {
  const targets: (WsTarget | undefined)[] =
    kind === "standup"
      ? standupTargets()
      : kind === "morning" || kind === "evening"
        ? bookendTargets()
        : [undefined];
  for (const target of targets) {
    await runAgentHeartbeat({
      agent: "robert",
      kind,
      target,
      force: force || kind !== "hourly",
    }).catch((e) => console.error(`[heartbeat] robert ${target?.slug ?? ""}`, e));
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
// Two locks: an hourly proposal must not cancel morning/evening, and two bookends
// must not stack on top of each other. Previously one long hourly (or a stuck manager)
// made `previous tick still running — skip` eat the entire BOD/EOD.

let hourlyInFlight = false;
let bookendInFlight = false;

export async function runFleetHeartbeat(opts?: {
  force?: boolean;
  now?: Date;
  agents?: FleetAgent[];
}): Promise<void> {
  const now = opts?.now ?? new Date();
  const force = Boolean(opts?.force);
  if (!force && !isWithinActiveHours(now)) {
    console.log("[heartbeat] outside active hours — skip");
    return;
  }
  const kind = heartbeatKind(now.getHours(), now.getMinutes());
  const isBookend = kind === "morning" || kind === "evening";

  if (isBookend) {
    if (bookendInFlight) {
      console.log("[heartbeat] previous bookend still running — skip");
      return;
    }
    bookendInFlight = true;
  } else {
    // Hourly yields to a live bookend (don't compete for Claude) and to a prior hourly.
    if (bookendInFlight) {
      console.log("[heartbeat] bookend in flight — skip hourly");
      return;
    }
    if (hourlyInFlight) {
      console.log("[heartbeat] previous hourly still running — skip");
      return;
    }
    hourlyInFlight = true;
  }

  // Cron: one proposal agent per half-hour (morning/evening = Robert only).
  // Manual force with explicit agents list wins; bare force fleet still rotates unless kind=now.
  const agents =
    opts?.agents ??
    agentsForTick(kind, now, Boolean(force && kind === "now"));
  // Robert's bookends run once PER WORKSPACE ROOM — the Acme brief in chronos-acme, Globex's
  // in chronos-globex. Everything else is one tick on its own channel.
  const ticks: { agent: FleetAgent; target?: WsTarget }[] = agents.flatMap((agent) =>
    agent === "robert" && (kind === "morning" || kind === "evening")
      ? bookendTargets().map((target) => ({ agent, target }))
      : [{ agent }],
  );
  console.log(
    `[heartbeat] tick kind=${kind} proposal=${ticks
      .map((t) => (t.target ? `${t.agent}/${t.target.slug}` : t.agent))
      .join(",")} slot=${proposalAgentFor(now)}`,
  );
  try {
    // Stagger so four Robert briefs (or a forced fleet run) don't spawn warm CLIs all at once.
    await Promise.all(
      ticks.map(
        ({ agent, target }, i) =>
          new Promise<void>((resolve) => {
            const delay = ticks.length > 1 ? (target ? i * 8_000 : STAGGER_MS[agent]) : 0;
            setTimeout(() => {
              runAgentHeartbeat({
                agent,
                kind,
                target,
                // Bookends always force-exec (and ignore recent-turn); hourly force only when API asked.
                force: isBookend || (force && (agent === "robert" || kind === "now")),
                skipDigest: force || isBookend,
                now,
              })
                .catch((e) => console.error(`[heartbeat] ${agent}`, e))
                .finally(resolve);
            }, delay).unref?.();
          }),
      ),
    );
  } finally {
    if (isBookend) bookendInFlight = false;
    else hourlyInFlight = false;
  }
}

// ── Mail sweep (OFF — no owner) ──────────────────────────────────────────────
// Hourly-ish inbox triage, piggybacked on the fleet cron tick (self-throttled via kv so the */30
// cron yields one sweep per everyMin). A quiet inbox is a NOOP turn and delivers nothing anywhere.
//
// Ada ran this: it read Gmail through her MCP, spoke in her voice and posted as her. She was
// retired and Robert cannot inherit it — he holds no Gmail MCP. So the loop is OFF by
// default (CHRONOS_MAIL_SWEEP=0) and nothing on the fleet cron calls it any more.
//
// What is kept is the part that was never Ada-specific and is the expensive part to get right:
// the throttle with its 5-minute grace, the duplicate-alert silence, the NOOP contract and the
// active-hours window. A future owner gets it by passing askFn/deliverFn. There is deliberately no
// default asker: reaching one would mean the flag was switched back on without naming an owner, and
// that must fail loudly rather than quietly sweep the operator's inbox as nobody.

let mailSweepInFlight = false;

/** No default I/O since the retirement — an unnamed owner is a bug, not a fallback. */
const noMailOwner = (what: string) => async (): Promise<never> => {
  throw new Error(
    `mail sweep has no owner: ${what} was Ada's and she was retired. ` +
      `Pass askFn/deliverFn to runMailSweep, or leave CHRONOS_MAIL_SWEEP=0.`,
  );
};

export type MailSweepResult = { ran: boolean; alerted: boolean; skipped?: string };

export function mailSweepPrompt(windowMin: number, lastAlert: string | null): string {
  return (
    `${OP_PREFIX}hourly mail sweep (the operator did NOT message you; do not greet them, do not chat).\n` +
    `Search his Gmail for UNREAD mail from roughly the last ${windowMin} minutes ` +
    `(search \`is:unread newer_than:1d\`, then keep only what actually arrived in the window — check the timestamps). ` +
    `Judge importance like his EA: real people writing to HIM, money, deadlines, signatures, travel, health, ` +
    `anything time-sensitive. Newsletters, receipts, promos, bots and automated notifications are NOT important.\n` +
    (lastAlert ? `You already alerted him about the following — do NOT alert for these same mails again:\n"""${lastAlert.slice(0, 600)}"""\n` : "") +
    `If NOTHING important arrived: reply exactly NOOP — the single word, nothing else. Never write ` +
    `"no new mail" or any quiet-inbox summary: silence IS the deliverable, a non-report is noise on his phone.\n` +
    `If something matters: reply with 1–3 short lines (sender — what they want — how old), worst first, ` +
    `in your own voice but tight. This text goes to his phone as-is. Read-only sweep: open only what you ` +
    `need to judge, draft nothing, and never include more than the gist of any mail.`
  );
}

export async function runMailSweep(opts?: {
  now?: Date;
  force?: boolean;
  askFn?: (prompt: string) => Promise<string>;
  deliverFn?: (reply: string) => Promise<void>;
}): Promise<MailSweepResult> {
  const cfg = CONFIG.mailSweep;
  const now = opts?.now ?? new Date();
  if (!cfg.enabled) return { ran: false, alerted: false, skipped: "disabled" };
  if (!opts?.force && !isWithinActiveHours(now)) return { ran: false, alerted: false, skipped: "inactive-hours" };
  const last = Number(kv.get("mailsweep.lastRunAt") ?? 0);
  // 5-min grace so a cron tick landing at 59:58 doesn't push the sweep to the NEXT tick (90 min).
  if (!opts?.force && now.getTime() - last < (cfg.everyMin - 5) * 60_000)
    return { ran: false, alerted: false, skipped: "throttled" };
  if (mailSweepInFlight) return { ran: false, alerted: false, skipped: "in-flight" };
  mailSweepInFlight = true;

  try {
    // Stamp BEFORE the turn: a sweep that dies must not make the next tick double-fire into a
    // still-wedged manager; worst case one window goes unswept and the next one covers it.
    kv.set("mailsweep.lastRunAt", String(now.getTime()));
    const windowMin = last ? Math.min(Math.round((now.getTime() - last) / 60_000) + 15, 24 * 60) : cfg.everyMin + 15;
    const prompt = mailSweepPrompt(windowMin, kv.get("mailsweep.lastAlert") ?? null);
    const ask = opts?.askFn ?? noMailOwner("the sweep turn");
    const reply = (await ask(prompt)).trim();
    if (isSilenceReply(reply)) {
      console.log("[mailsweep] quiet inbox — NOOP");
      return { ran: true, alerted: false };
    }
    // Identical alert to the one already on his phone = the same mails re-judged, not news.
    if (reply.slice(0, 1000) === kv.get("mailsweep.lastAlert")) {
      console.log("[mailsweep] same alert as last time — silence");
      return { ran: true, alerted: false, skipped: "duplicate" };
    }
    kv.set("mailsweep.lastAlert", reply.slice(0, 1000));
    const deliver = opts?.deliverFn ?? noMailOwner("delivery");
    await deliver(reply);
    console.log("[mailsweep] alerted");
    return { ran: true, alerted: true };
  } catch (e) {
    console.error("[mailsweep]", e);
    return { ran: true, alerted: false, skipped: "error" };
  } finally {
    mailSweepInFlight = false;
  }
}

export function startDayHeartbeat(): void {
  const cfg = CONFIG.dayHeartbeat;
  if (!cfg.enabled) {
    console.log("[heartbeat] disabled (CHRONOS_DAY_HEARTBEAT=0)");
    return;
  }
  const opts: any = { name: "fleet-heartbeat" };
  if (cfg.tz) opts.timezone = cfg.tz;
  try {
    new Cron(cfg.cron, opts, () => {
      runFleetHeartbeat().catch((e) => console.error("[heartbeat]", e));
    });
  } catch (e) {
    console.error(`[heartbeat] bad cron "${cfg.cron}"`, e);
    return;
  }
  console.log(
    `[heartbeat] fleet active (${cfg.cron}; ${cfg.activeStart}–${cfg.activeEnd}` +
      `${cfg.tz ? " " + cfg.tz : " local"}; gate=${cfg.gateModel}` +
      `; single executive: Robert; digestSkip=${cfg.digestSkip ? "on" : "off"})`,
  );
}

// ── Personal heartbeat (REMOVED — no owner) ──────────────────────────────────
// A personal-assistant heartbeat lived here: window check → recent-turn check → a digest fingerprint
// over the operator's calendar and notes → cheap-model gate → one warm turn. It was removed with the
// agent that owned it rather than left switched off, because every step named that agent: the digest
// case, the notes it read, and the `runAgentHeartbeat({ agent })` call itself.
//
// `CONFIG.personalHeartbeat` is kept and defaults to off, so the cron/window knobs survive for
// whoever writes the next one. Reviving a loop like this means giving it an owner first — an
// `agents/<id>/` directory, and a `FleetAgent` entry to match.

let standupInFlight = false;

/**
 * One standup per client room, staggered like the bookends so two warm Roberts don't spawn at once.
 * Always forced: a standup the operator has to notice is missing is worse than a thin one.
 */
export async function runStandup(now = new Date()): Promise<void> {
  if (standupInFlight) {
    console.log("[standup] previous run still going — skip");
    return;
  }
  const targets = standupTargets();
  if (!targets.length) {
    console.log("[standup] no client rooms configured — skip");
    return;
  }
  standupInFlight = true;
  console.log(`[standup] ${targets.map((t) => t.slug).join(",")}`);
  try {
    for (const target of targets) {
      await runAgentHeartbeat({ agent: "robert", kind: "standup", target, force: true, now }).catch(
        (e) => console.error(`[standup] ${target.slug}`, e)
      );
    }
  } finally {
    standupInFlight = false;
  }
}

export function startStandup(): void {
  const cfg = CONFIG.standup;
  if (!cfg.enabled) {
    console.log("[standup] disabled (CHRONOS_STANDUP=0)");
    return;
  }
  // No rooms is the default, and arming a cron for it would fire a job that resolves nothing every
  // morning for the life of the daemon. Say what to set instead — this is the first thing a fresh
  // install sees about standups, and "rooms=" told it nothing.
  if (cfg.workspaces.length === 0) {
    console.log("[standup] no projects configured (set CHRONOS_STANDUP_WORKSPACES to a slug list)");
    return;
  }
  const opts: any = { name: "daily-standup" };
  if (cfg.tz) opts.timezone = cfg.tz;
  try {
    new Cron(cfg.cron, opts, () => {
      runStandup().catch((e) => console.error("[standup]", e));
    });
  } catch (e) {
    console.error(`[standup] bad cron "${cfg.cron}"`, e);
    return;
  }
  console.log(
    `[standup] daily standup active (${cfg.cron}${cfg.tz ? " " + cfg.tz : " local"}; ` +
      `rooms=${cfg.workspaces.join(",")})`
  );
}
