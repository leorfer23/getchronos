/**
 * Watches — "wake <owner> when <condition>", the cheap half of monitoring.
 *
 * Before this, an executive that wanted to keep an eye on something had exactly one tool: prose in
 * its persona memory, which rides EVERY heartbeat prompt. That is paid for on every tick whether or
 * not anything moved, it never expires, and nothing wakes anyone the moment the thing happens — the
 * exec just re-reads the note next time it thinks.
 *
 * A watch inverts the cost. The daemon evaluates the condition; a model turn is spent only when it
 * fires. Three modes:
 *
 *   bus  — match a bus topic plus optional field equality. Zero cost, fires instantly.
 *          { mode:"bus", on:"run.ended", where:{ ticket_key:"PER-35", status:"failed" } }
 *   poll — GET a path on our own API every `every_sec`, test a predicate against the JSON.
 *          { mode:"poll", check:"/api/tickets/PER-40", when:"status != 'pending'", every:"5m" }
 *   at   — a scheduled self-wake: a time, not a condition. { mode:"at", at:"+20m", say:"..." }.
 *          The agent registered the line, so delivery needs NO gate and no judgment — the
 *          decision to wake was made by the agent that scheduled it. This is how an executive
 *          slots itself a future heartbeat with a message attached.
 *
 * Firing posts to the board mentioning the owner, so the existing mention-wake path (src/board.ts,
 * depth-capped) does the waking and the operator sees the whole exchange in one public thread. No new
 * notification channel, and no watch can wake anyone twice over.
 *
 * Deliberately NOT here: judgment checks (a haiku gate on a snapshot) and shell checks. Everything
 * in this file is free to evaluate; keeping it that way is the property worth defending.
 */
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { watches, type Watch } from "./store/watches.js";
import { EXEC_HANDLES, postToBoard } from "./board.js";

// ── limits ───────────────────────────────────────────────────────────────────
export const WATCH_LIMITS = {
  perOwner: 10,        // a watch fleet nobody can hold in their head is a watch fleet nobody prunes
  minEverySec: 60,
  defaultEverySec: 300,
  maxDays: 30,
  defaultDays: 7,
  maxFires: 20,        // a repeating watch that fires this often is misconfigured, not informative
  tickMs: 30_000,
};

// Watching these is either a no-op or a firehose; both are worse than an error at creation time.
const UNWATCHABLE = new Set(["board.posted", "agent.delta", "agent.asked", "agent.turn.done", "run.event", "focus.event", "agent.push"]);

const isExec = (id: string) => Object.values(EXEC_HANDLES).includes(id);

/** "5m" · "90s" · "2h" · 300 → seconds. Null when it isn't a duration. */
export function parseEvery(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  const m = String(v ?? "").trim().match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === "h" ? n * 3600 : m[2]?.toLowerCase() === "s" ? n : n * 60;
}

/** "+48h" · "+7d" · an ISO date → ISO string. Null when it isn't a time. */
export function parseUntil(v: unknown, nowMs: number): string | null {
  const s = String(v ?? "").trim();
  const rel = s.match(/^\+(\d+)\s*(m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return new Date(nowMs + ms).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ── predicate ────────────────────────────────────────────────────────────────
// A deliberately tiny grammar, NOT an expression language: terms joined by && or ||, each one
// `<path> <op> <literal>`, plus the bare forms `exists <path>` / `missing <path>`. No eval, no
// Function, no property calls — a watch is created by an agent, and an agent-authored string must
// never become code. Anything the grammar can't say is a watch you don't get to create.
const OPS = ["!=", ">=", "<=", "==", "=", ">", "<", " contains ", " startswith "] as const;

/** Resolve `a.b[0].c`, `$` (the whole document) and a trailing `.length`. */
export function resolvePath(doc: unknown, path: string): unknown {
  const p = path.trim();
  if (p === "$" || p === "") return doc;
  let cur: any = doc;
  for (const raw of p.replace(/^\$\.?/, "").split(".")) {
    if (cur == null) return undefined;
    const m = raw.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!m) return undefined;
    const key = m[1];
    if (key) cur = key === "length" && (Array.isArray(cur) || typeof cur === "string") ? cur.length : cur[key];
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
      if (cur == null) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

function literal(raw: string): unknown {
  const s = raw.trim();
  if (/^'.*'$/.test(s) || /^".*"$/.test(s)) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : s;
}

function evalTerm(doc: unknown, term: string): boolean {
  const t = term.trim();
  const bare = t.match(/^(exists|missing)\s+(.+)$/i);
  if (bare) {
    const v = resolvePath(doc, bare[2]);
    const there = v !== undefined && v !== null;
    return bare[1].toLowerCase() === "exists" ? there : !there;
  }
  const lower = t.toLowerCase();
  let op = "", at = -1;
  for (const candidate of OPS) {
    const i = lower.indexOf(candidate);
    if (i > 0) { op = candidate; at = i; break; }
  }
  if (at < 0) return false;
  const left = resolvePath(doc, t.slice(0, at));
  const right = literal(t.slice(at + op.length));
  switch (op.trim()) {
    case "==": case "=": return left == right; // eslint-disable-line eqeqeq -- "5" == 5 is the useful reading here
    case "!=": return left != right;           // eslint-disable-line eqeqeq
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    case "contains": return String(left ?? "").toLowerCase().includes(String(right).toLowerCase());
    case "startswith": return String(left ?? "").toLowerCase().startsWith(String(right).toLowerCase());
    default: return false;
  }
}

/** Evaluate a predicate against a JSON document. A malformed predicate is false, never a throw. */
export function evalPredicate(doc: unknown, expr: string): boolean {
  const src = String(expr ?? "").trim();
  if (!src) return false;
  // || binds loosest, so split on it first and evaluate each && group.
  return src.split("||").some((group) =>
    group.split("&&").every((term) => {
      try { return evalTerm(doc, term); } catch { return false; }
    }));
}

/** Does this bus event satisfy the watch's topic + field match? */
export function busMatches(w: Watch, ev: BusEvent): boolean {
  if (!w.on_topic || (ev as any).topic !== w.on_topic) return false;
  if (!w.where_json) return true;
  let where: Record<string, unknown>;
  try { where = JSON.parse(w.where_json); } catch { return false; }
  return Object.entries(where).every(([k, v]) => {
    const actual = resolvePath(ev, k);
    return typeof v === "string" && /^(>|<|>=|<=|!=)/.test(v)
      ? evalTerm(ev, `${k} ${v}`)
      : actual == v; // eslint-disable-line eqeqeq
  });
}

// ── firing ───────────────────────────────────────────────────────────────────
const handleFor = (owner: string) =>
  Object.entries(EXEC_HANDLES).find(([, id]) => id === owner)?.[0] ?? owner;

/** One seam for tests: production posts to the board, tests capture. */
type Poster = typeof postToBoard;
let poster: Poster | null = null;
export function setWatchPoster(fn: Poster | null): void { poster = fn; }

/** One seam for tests: production GETs its own API over loopback. */
type Fetcher = (path: string) => Promise<unknown>;
let fetcher: Fetcher | null = null;
export function setWatchFetcher(fn: Fetcher | null): void { fetcher = fn; }

async function defaultFetcher(path: string): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${CONFIG.port}${path}`, {
    headers: CONFIG.adminToken ? { "x-mc-admin": CONFIG.adminToken } : {},
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

function fire(w: Watch, evidence: string, nowMs: number): void {
  const count = w.fire_count + 1;
  (poster ?? postToBoard)({
    author: "chronos",
    kind: w.mode === "at" ? "wakeup" : "watch",
    workspace_id: w.workspace_id,
    body:
      (w.mode === "at" ? `⏰ scheduled wake — ${w.what}\n` : `⏱ watch fired — ${w.what}\n`) +
      `@${handleFor(w.owner)} ${w.say ?? "you asked to be woken for this."}\n` +
      evidence,
  });
  const done = w.one_shot === 1 || count >= WATCH_LIMITS.maxFires;
  if (done) invalidateWatchCache();
  watches.patch(w.id, {
    fire_count: count,
    last_fired_at: new Date(nowMs).toISOString(),
    enabled: done ? 0 : 1,
    disabled_reason: !done ? null
      : w.one_shot === 1 ? "fired (one-shot)"
      : `fired ${count} times — auto-disabled, rewrite it narrower`,
  });
  console.log(`[watches] fired ${w.id} (${w.what}) → @${handleFor(w.owner)}${done ? " — closed" : ""}`);
}

/** Expired watches stop costing anything and stop lying about being live. */
function expire(w: Watch, nowMs: number): boolean {
  if (Date.parse(w.until) > nowMs) return false;
  watches.patch(w.id, { enabled: 0, disabled_reason: "expired" });
  invalidateWatchCache();
  return true;
}

// ── the two evaluators ───────────────────────────────────────────────────────
// This runs inside bus.emit for EVERY event, and the bus carries agent.delta — one event per
// streamed token. A SQL query per token is not acceptable, so keep an in-memory index of the topics
// anyone is actually watching and bail before touching the DB. Anything that changes a bus watch
// clears it; the poll tick clears it periodically as a backstop.
let topicIndex: Set<string> | null = null;
export function invalidateWatchCache(): void { topicIndex = null; }
function watchedTopics(): Set<string> {
  if (!topicIndex) topicIndex = new Set(watches.live("bus").map((w) => w.on_topic).filter((t): t is string => !!t));
  return topicIndex;
}

/** Bus mode: called for every event on the bus. Must stay cheap and must never throw. */
export function onBusEvent(ev: BusEvent, nowMs = Date.now()): void {
  if (!watchedTopics().has((ev as any).topic)) return;
  for (const w of watches.live("bus")) {
    try {
      if (expire(w, nowMs)) continue;
      if (!busMatches(w, ev)) continue;
      // A repeating watch shouldn't re-announce the same event shape over and over.
      const state = JSON.stringify(ev).slice(0, 500);
      if (w.one_shot === 0 && w.last_state === state) continue;
      watches.patch(w.id, { last_state: state });
      fire(w, "event: " + state, nowMs);
    } catch (e) {
      console.error(`[watches] bus watch ${w.id} failed:`, e);
    }
  }
}

/** Poll mode: one sweep over the watches whose interval is up. */
export async function tickPolls(nowMs = Date.now()): Promise<void> {
  for (const w of watches.live("poll")) {
    if (expire(w, nowMs)) continue;
    const due = !w.last_checked_at || Date.parse(w.last_checked_at) + (w.every_sec ?? WATCH_LIMITS.defaultEverySec) * 1000 <= nowMs;
    if (!due || !w.check_path || !w.when_expr) continue;
    try {
      const doc = await (fetcher ?? defaultFetcher)(w.check_path);
      watches.patch(w.id, { last_checked_at: new Date(nowMs).toISOString() });
      if (!evalPredicate(doc, w.when_expr)) continue;
      const state = JSON.stringify(doc).slice(0, 500);
      if (w.one_shot === 0 && w.last_state === state) continue;
      watches.patch(w.id, { last_state: state });
      fire({ ...w, last_state: state }, `${w.check_path} → ${state}`, nowMs);
    } catch (e) {
      // A check that can't run is noted, not retried in a hot loop — the interval still applies.
      watches.patch(w.id, { last_checked_at: new Date(nowMs).toISOString() });
      console.error(`[watches] poll ${w.id} (${w.check_path}) failed:`, e);
    }
  }
}

// ── creation guard (shared by the API and the tests) ─────────────────────────
export type WatchInput = {
  owner?: string; what?: string; on?: string; where?: Record<string, unknown>;
  check?: string; when?: string; every?: string | number; at?: string; say?: string;
  one_shot?: boolean; until?: string; workspace_id?: string | null; created_by?: string | null;
};

/** Validate + normalize an agent-supplied watch. Returns the row to create, or an error string. */
export function prepareWatch(input: WatchInput, nowMs = Date.now()): { error: string } | { row: Parameters<typeof watches.create>[0] } {
  const owner = String(input.owner ?? "").toLowerCase();
  const resolved = EXEC_HANDLES[owner] ?? owner;
  if (!isExec(resolved)) return { error: `owner must be an executive (${[...new Set(Object.values(EXEC_HANDLES))].join(", ")})` };
  const what = String(input.what ?? "").trim();
  if (!what) return { error: "what is required — it is the line the board post shows" };
  if (what.length > 200) return { error: "what must be under 200 chars" };

  const until = parseUntil(input.until ?? `+${WATCH_LIMITS.defaultDays}d`, nowMs);
  if (!until) return { error: "until must be an ISO date or a relative offset like +48h / +7d" };
  const maxUntil = nowMs + WATCH_LIMITS.maxDays * 86400000;
  if (Date.parse(until) > maxUntil) return { error: `until is capped at +${WATCH_LIMITS.maxDays}d` };
  if (Date.parse(until) <= nowMs) return { error: "until is already in the past" };

  if (watches.countActive(resolved) >= WATCH_LIMITS.perOwner)
    return { error: `${resolved} already has ${WATCH_LIMITS.perOwner} active watches — close one first` };

  const base = {
    owner: resolved,
    what,
    say: input.say ? String(input.say).slice(0, 500) : null,
    one_shot: input.one_shot === false ? 0 : 1,
    until,
    workspace_id: input.workspace_id ?? null,
    created_by: input.created_by ?? null,
  };

  if (input.on) {
    const topic = String(input.on);
    // board.posted is filtered out at runtime (a fire posts to the board — it must not re-enter),
    // and the streaming/internal topics fire hundreds of times a minute on nothing meaningful.
    if (UNWATCHABLE.has(topic)) return { error: `${topic} can't be watched — pick the event that means something (run.ended, review.created, ask.created, ticket.updated, ci.failed…)` };
    return { row: { ...base, mode: "bus" as const, on_topic: String(input.on),
      where_json: input.where ? JSON.stringify(input.where) : null } };
  }
  if (input.at) {
    const at = parseUntil(input.at, nowMs);
    if (!at) return { error: "at must be an ISO date or a relative offset like +5m / +2h" };
    if (Date.parse(at) <= nowMs) return { error: "at is already in the past" };
    if (Date.parse(at) > nowMs + WATCH_LIMITS.maxDays * 86400000) return { error: `at is capped at +${WATCH_LIMITS.maxDays}d` };
    // A self-wake is always one delivery, and it expires shortly after firing would have happened —
    // the caller's `until` is ignored on purpose (two clocks on one row invite contradictions).
    return { row: { ...base, mode: "at" as const, at, one_shot: 1, until: new Date(Date.parse(at) + 3600_000).toISOString() } };
  }
  if (input.check) {
    const check = String(input.check);
    // GET on our own API only. A watch is a persistent, unattended credentialed call — it does not
    // get to reach anything the daemon didn't publish.
    // `..` matters: fetch normalizes the URL, so "/api/../secret" would leave /api entirely and
    // arrive at an unrelated route with the admin token attached.
    if (!/^\/api\/[\w\-/.?=&%]*$/.test(check) || check.includes(".."))
      return { error: "check must be a GET path under /api/ (no ..)" };
    if (!input.when) return { error: "a poll watch needs `when` — the predicate that makes it fire" };
    const every = parseEvery(input.every ?? WATCH_LIMITS.defaultEverySec);
    if (every === null) return { error: "every must look like 60, '90s', '5m' or '2h'" };
    if (every < WATCH_LIMITS.minEverySec) return { error: `every must be at least ${WATCH_LIMITS.minEverySec}s` };
    return { row: { ...base, mode: "poll" as const, check_path: check, when_expr: String(input.when), every_sec: every } };
  }
  return { error: "a watch needs `on` (a bus topic), `check` + `when` (a polled predicate), or `at` (a scheduled self-wake)" };
}

/** At mode: deliver every self-wake that has come due. No gate — the scheduling WAS the decision. */
export function tickDue(nowMs = Date.now()): void {
  for (const w of watches.live("at")) {
    try {
      if (!w.at || Date.parse(w.at) > nowMs) continue;
      fire(w, `scheduled for ${w.at}`, nowMs);
      invalidateWatchCache();
    } catch (e) {
      console.error(`[watches] wakeup ${w.id} failed:`, e);
    }
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────
export function startWatches(): void {
  bus.on("event", (ev: BusEvent) => {
    // A watch firing posts to the board, which publishes board.posted — never let that re-enter.
    if ((ev as any).topic === "board.posted") return;
    try { onBusEvent(ev); } catch (e) { console.error("[watches] bus sweep failed:", e); }
  });
  setInterval(() => { invalidateWatchCache(); tickDue(); void tickPolls(); }, WATCH_LIMITS.tickMs);
  console.log(`[watches] live (bus + poll every ${WATCH_LIMITS.tickMs / 1000}s)`);
}
