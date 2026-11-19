/**
 * Robert's outbox — the one door everything he says on his own goes through.
 *
 * Before this, an unprompted line went straight to postRobertToDesk, which drops it to a log line unless
 * `robert.desk_posts` is on (off by default: such posts piled up unread). On a real day he was awake for
 * hundreds of turns, nothing he concluded reached the operator, and nothing durable said what he had
 * said. His wake turns are stateless — a short recap is his only memory — so he could not know what he
 * had already raised either: he repeated himself, or could not say "still waiting on X since this
 * morning".
 *
 * The shape is the always-on agent's outbox: a turn ends by WRITING what it says (a row), a dispatcher
 * decides what is delivered and records the outcome on that row, and what was already told is read back
 * at the start of every wake turn (`withReported`). Delivery is what it was — the board post a wake
 * always made, then postRobertToDesk under its setting — but for one rule: the same words about the same
 * thing (workspace + episode) inside REPEAT_WINDOW_MS are recorded `suppressed` and not posted again.
 *
 * Workspaces never mix (CLAUDE.md gotcha 4): a row carries its workspace, the block a wake turn reads is
 * built from that workspace's rows alone (the default thread from NULL rows alone) and nothing else is
 * looked up to build it, and the route answers a workspace token with its own rows only.
 */
import { createHash } from "node:crypto";
import { robertOutbox, workspaces, OUTBOX_STATUSES, type OutboxRow, type OutboxStatus, type OutboxWake } from "./store.js";
import { postRobertToDesk, type DeskOutcome } from "./robert-desk.js";
import { OP_MARK, OP_PREFIX } from "./operational-prefix.js";
import type { RobertStep } from "./robert-steps.js";
import type { CallerScope } from "./authz.js";

/** The same words about the same episode inside this window are a repeat. */
export const REPEAT_WINDOW_MS = 6 * 3_600_000;
/** How far back the block of what he already told looks, and its hard size (header and rule included). */
export const REPORTED_WINDOW_MS = 24 * 3_600_000;
export const REPORTED_MAX_CHARS = 1_200;
const REPORTED_LINE_CHARS = 140;
/** What a row keeps of a long post; the repeat rule hashes all of it first. */
const BODY_MAX = 4_000;
const EPISODE_MAX = 300;

export interface Unprompted {
  /** Which path said it: wake · ask · triage · watch · board · failover · artifact. */
  source: string;
  body: string;
  ws: string | null;
  steps?: RobertStep[];
  turn?: string;
  engine?: string | null;
  /** The wakes a turn drained. The episode comes from them when none is given. */
  wakes?: OutboxWake[];
  /** What it is about (`session:<id>`, `ask:<id>` …): two lines about the same thing share one. */
  episode?: string | null;
  /** The wake path's board post, made once the row is written. It throws as it always did: the turn fails and its wakes stay queued. */
  board?: () => void;
}

/** Same words: case and spacing aside. Nothing fuzzier. */
export const normalizeBody = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const bodyKey = (s: string): string => createHash("sha256").update(normalizeBody(s)).digest("hex").slice(0, 32);

/**
 * What a turn's wakes were about: each one's subject, or its key when it has none (a sweep, a
 * self-wake). Sorted, so one terminal, PR or ask is one episode however its wakes were batched.
 */
export function episodeOf(wakes: Array<Pick<OutboxWake, "key" | "subject">>): string | null {
  const about = [...new Set(wakes.map((w) => w.subject || w.key).filter(Boolean))].sort();
  return about.length ? about.join(" + ").slice(0, EPISODE_MAX) : null;
}

const SETTLED: Record<DeskOutcome, { status: OutboxStatus; reason: string | null }> = {
  delivered: { status: "delivered", reason: null },
  held: { status: "held", reason: "desk posts off" },
  failed: { status: "failed", reason: "desk post failed" },
  empty: { status: "held", reason: "nothing to post" },
};

function settle(id: string, s: Parameters<typeof robertOutbox.settle>[1]): void {
  try {
    robertOutbox.settle(id, s);
  } catch (e: any) {
    console.warn(`[robert-outbox] could not settle ${id.slice(0, 8)} as ${s.status}:`, e?.message ?? e);
  }
}

const deskPost = (m: Unprompted) => ({ body: m.body, ws: m.ws, steps: m.steps, turn: m.turn, engine: m.engine });

/**
 * Say something nobody typed to him: write it down, then deliver it — unless it repeats, word for word,
 * what the operator was already told about the same thing in the last REPEAT_WINDOW_MS. Returns what the
 * record says. The record never costs the post: a row that cannot be written posts the old direct way.
 */
export function sayUnprompted(m: Unprompted, nowMs = Date.now()): OutboxStatus | "unrecorded" | "empty" {
  const body = (m.body || "").trim();
  if (!body && !m.steps?.length) return "empty";
  const key = bodyKey(body);
  const episode = m.episode !== undefined ? m.episode : episodeOf(m.wakes ?? []);
  let row: OutboxRow | null = null;
  try {
    row = robertOutbox.add({
      workspace_id: m.ws,
      source: m.source,
      body: body.slice(0, BODY_MAX),
      body_key: key,
      steps: m.steps?.length ?? 0,
      wakes: (m.wakes ?? []).map((w) => ({ key: w.key, topic: w.topic, subject: w.subject ?? null })),
      episode,
      turn: m.turn ?? null,
    }, nowMs);
  } catch (e: any) {
    console.warn(`[robert-outbox] could not record (${m.source}) — posting directly:`, e?.message ?? e);
  }
  if (!row) {
    m.board?.();
    postRobertToDesk(deskPost(m));
    return "unrecorded";
  }
  try {
    robertOutbox.prune(nowMs);
  } catch {}
  try {
    m.board?.();
  } catch (e) {
    settle(row.id, { status: "failed", reason: "board post failed" });
    throw e;
  }
  // A steps-only post has no words to repeat.
  let earlier: OutboxRow | undefined;
  if (body) {
    try {
      earlier = robertOutbox.repeatOf({ workspace_id: m.ws, episode, body_key: key, sinceMs: nowMs - REPEAT_WINDOW_MS, except: row.id });
    } catch (e: any) {
      console.warn("[robert-outbox] repeat check failed — posting:", e?.message ?? e);
    }
  }
  if (earlier) {
    settle(row.id, { status: "suppressed", reason: "repeat" });
    console.log(`[robert-outbox] repeat (${m.ws ?? "default"} · ${episode ?? "-"}), not posted: ${body.slice(0, 120).replace(/\s+/g, " ")}`);
    return "suppressed";
  }
  const out = SETTLED[postRobertToDesk(deskPost(m))];
  settle(row.id, out.status === "delivered" ? { status: "delivered", channel: "desk", delivered_at: new Date(nowMs).toISOString() } : out);
  return out.status;
}

// ── what he already told: read back at the start of every wake turn ──────────────────────────────────

const REPORTED_HEAD = "What you already told the operator here in the last 24h, newest first (your outbox):";
const REPORTED_RULE =
  "Do not repeat these: if one is still unresolved and matters, say what changed or how long it has waited, otherwise leave it out.";
const SAID: Partial<Record<OutboxStatus, string>> = { delivered: "shown", held: "not shown, desk posts off" };

function ago(at: string, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - Date.parse(at)) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min}m ago` : `${Math.floor(min / 60)}h ago`;
}

/** One past post in one line: card markers named, the operational mark dropped (withoutReported finds the wake by it). */
function gist(r: Pick<OutboxRow, "body" | "steps">): string {
  const t = r.body
    .split(OP_MARK).join("")
    .replace(/::ask ([0-9a-f-]{8,36})::/g, (_m, id: string) => `[question card ${id.slice(0, 8)}]`)
    .replace(/::artifact ([0-9a-f-]{8,36})::/g, (_m, id: string) => `[page ${id.slice(0, 8)}]`)
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return `(no words, ${r.steps} step${r.steps === 1 ? "" : "s"})`;
  return t.length > REPORTED_LINE_CHARS ? `${t.slice(0, REPORTED_LINE_CHARS - 1).trimEnd()}…` : t;
}

/**
 * What he told the operator in THIS scope (a workspace; null = the default thread) in the last 24h, one
 * line each, newest first, never longer than REPORTED_MAX_CHARS. Empty when there is nothing to say.
 */
export function reportedBlock(wsId: string | null, nowMs = Date.now()): string {
  const lines: string[] = [];
  let size = REPORTED_HEAD.length + 1 + REPORTED_RULE.length;
  for (const r of robertOutbox.told(wsId, nowMs - REPORTED_WINDOW_MS, 40)) {
    const line = `- ${ago(r.created_at, nowMs)} · ${SAID[r.status] ?? r.status} · ${gist(r)}`;
    if (size + line.length + 1 > REPORTED_MAX_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length ? [REPORTED_HEAD, ...lines, REPORTED_RULE].join("\n") : "";
}

/**
 * A wake turn's text with the block in front. In the turn, never in the system prompt, which must stay
 * byte-stable between spawns for the prompt cache. The text still opens with the operational mark, and
 * the wake keeps its own: that second mark is where withoutReported finds the wake again.
 */
export function withReported(prompt: string, wsId: string | null, nowMs = Date.now()): string {
  let told = "";
  try {
    told = reportedBlock(wsId, nowMs);
  } catch (e: any) {
    console.warn("[robert-outbox] could not read what was told:", e?.message ?? e);
  }
  if (!told) return prompt;
  return `${OP_PREFIX}${told}\n\n${prompt.startsWith(OP_PREFIX) ? prompt : OP_PREFIX + prompt}`;
}

/** The wake text alone. His own past words never pick the model (robert-wake.ts robertModelFor). */
export function withoutReported(prompt: string): string {
  if (!prompt.startsWith(OP_PREFIX + REPORTED_HEAD)) return prompt;
  const at = prompt.indexOf(OP_PREFIX, OP_PREFIX.length);
  return at < 0 ? "" : prompt.slice(at);
}

// ── GET /api/robert/outbox ───────────────────────────────────────────────────────────────────────────

function outboxView(r: OutboxRow) {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    workspace: r.workspace_id ? (workspaces.get(r.workspace_id)?.slug ?? null) : null,
    created_at: r.created_at,
    source: r.source,
    status: r.status,
    reason: r.reason,
    episode: r.episode,
    body: r.body,
    steps: r.steps,
    wakes: r.wakes,
    turn: r.turn,
    delivered_at: r.delivered_at,
    channel: r.channel,
  };
}

/**
 * The record, newest first (last 24h unless `sinceMs`). The operator — and the fleet-wide Robert, who
 * reads every workspace — sees every scope, or one with ?ws=<id|slug|default>. A workspace token, or a
 * project's Robert, sees its own workspace only; any other ?ws= is refused without being looked up, so
 * the answer says nothing about which workspaces exist.
 */
export function outboxRequest(
  scope: CallerScope,
  q: { ws?: unknown; sinceMs?: number; status?: unknown; limit?: unknown },
  nowMs = Date.now(),
): { status: number; body: unknown } {
  if (scope === null) return { status: 401, body: { error: "invalid workspace token" } };
  const ref = typeof q.ws === "string" ? q.ws.trim() : "";
  let workspace: string | null | undefined;
  if (scope.ws !== null) {
    if (ref && ref !== scope.ws && ref !== workspaces.get(scope.ws)?.slug) {
      return { status: 403, body: { error: "a workspace token reads its own workspace's outbox only" } };
    }
    workspace = scope.ws;
  } else if (ref === "default") {
    workspace = null;
  } else if (ref) {
    const w = workspaces.get(ref) ?? workspaces.getBySlug(ref);
    if (!w) return { status: 404, body: { error: `unknown workspace ${ref}` } };
    workspace = w.id;
  }
  const status = typeof q.status === "string" && q.status ? q.status : undefined;
  if (status && !OUTBOX_STATUSES.includes(status as OutboxStatus)) {
    return { status: 400, body: { error: `status is one of ${OUTBOX_STATUSES.join(", ")}` } };
  }
  const limit = Number(q.limit ?? 200);
  const rows = robertOutbox.list({
    workspace,
    sinceMs: q.sinceMs ?? nowMs - REPORTED_WINDOW_MS,
    status: status as OutboxStatus | undefined,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  return { status: 200, body: { rows: rows.map(outboxView) } };
}
