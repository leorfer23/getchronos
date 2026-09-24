/**
 * Follow-ups: a parked note that asks for an agent to come back to it.
 *
 * Agents park a lot of rows that are really "check on this later" — a PR waiting on review, a
 * backfill that should have landed, a decision someone owes. Parking them kept the thought; nothing
 * kept the promise. A follow-up is that promise with a time on it: at `follow_up_at` the daemon
 * opens an ordinary Desk terminal on the note, seeded with the note, the question it is waiting on,
 * and what earlier follow-ups found. That terminal writes what it learned back onto the note and
 * closes the loop one of three ways: resolve it, schedule the next look, or ask the operator.
 *
 * This is operator- or agent-requested, per note — not a heartbeat. Nothing fires unless a note
 * carries a time, and a note never carries one it was not given.
 *
 * Timing is one armed timer to the soonest due note (re-armed on every jot write), so a follow-up
 * lands within seconds of its time rather than on a sweep cadence. A follow-up the daemon slept
 * through still fires on wake: the question is still open, and late beats never.
 */
import { bus } from "./bus.js";
import { desktop } from "./notify.js";
import { jots, sessions, workspaces } from "./store.js";
import { openSession } from "./terminal.js";
import type { Jot } from "./store/jots.js";
import type { Session } from "./types.js";

/** After this many fired follow-ups, only the operator can schedule another: an agent that keeps
 *  saying "check again in two days" forever is a loop, and the operator should see it. */
export const MAX_AGENT_FOLLOW_UPS = 8;
/** Agents may not schedule sooner than this — a terminal re-arming itself every minute is a loop. */
export const MIN_AGENT_LEAD_MS = 30 * 60_000;
/** A fire refused for a full seat cap / busy machine tries again this much later. */
export const RETRY_MS = 15 * 60_000;
/** At most this many follow-ups open per sweep, so a wake after a long sleep does not open ten
 *  terminals at once; the rest go out on the next pass a minute later. */
export const FIRE_PER_SWEEP = 3;
const MAX_SLEEP_MS = 60 * 60_000;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

/**
 * When is "then"? Everything an operator or agent is likely to type, resolved in the daemon's own
 * zone (the operator's): `+30m` `+2h` `+3d` `+1w`, `tomorrow` / `mañana` [HH:MM], a weekday
 * (`monday 9`, `jueves 14:30` — the next one, never today), `YYYY-MM-DD [HH:MM]`, or any full ISO
 * stamp. A day with no time means 09:00. Returns ISO, or null when it cannot tell.
 */
export function parseFollowUpAt(input: unknown, nowMs = Date.now()): string | null {
  const s = String(input ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!s) return null;
  const rel = s.match(/^\+?(\d+)\s*(m|min|h|d|w)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as "m"];
    return new Date(nowMs + n * unit).toISOString();
  }
  const clock = (rest: string | undefined): [number, number] | null => {
    if (!rest) return [9, 0];
    const m = rest.trim().match(/^(?:at\s+|a las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|hs|h)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    return h < 24 && min < 60 ? [h, min] : null;
  };
  const at = (d: Date, hm: [number, number]) => { d.setHours(hm[0], hm[1], 0, 0); return d.toISOString(); };

  const day = s.match(/^(today|hoy|tomorrow|manana)(?:\s+(.*))?$/);
  if (day) {
    const hm = clock(day[2]);
    if (!hm) return null;
    const d = new Date(nowMs);
    if (day[1] === "tomorrow" || day[1] === "manana") d.setDate(d.getDate() + 1);
    return at(d, hm);
  }
  const wd = s.match(/^(?:next\s+|el\s+|proximo\s+)?([a-z]+)(?:\s+(.*))?$/);
  if (wd) {
    let idx = WEEKDAYS.indexOf(wd[1]);
    if (idx < 0) idx = WEEKDAYS_ES.indexOf(wd[1]);
    if (idx >= 0) {
      const hm = clock(wd[2]);
      if (!hm) return null;
      const d = new Date(nowMs);
      const ahead = ((idx - d.getDay() + 7) % 7) || 7;
      d.setDate(d.getDate() + ahead);
      return at(d, hm);
    }
  }
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}:\d{2}.*))?$/);
  if (ymd && !/z|[+-]\d{2}:?\d{2}$/.test(s)) {
    const hm = clock(ymd[4]);
    if (!hm) return null;
    return at(new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])), hm);
  }
  const t = Date.parse(String(input).trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Who may schedule or resolve a follow-up on this note. The operator, always. A terminal only on its
 * own client (the route has already scope-checked that), and only on a note an agent filed or the
 * note whose follow-up opened it — never the operator's own thoughts, which it may add to but not
 * rewrite. Agents also get the anti-loop limits: no sooner than 30 minutes, and not past the cap.
 */
export function followUpPolicy(
  caller: { admin: boolean; scopedWs: string | null | undefined; session: string | null | undefined },
  jot: Pick<Jot, "workspace_id" | "source" | "follow_up_session" | "follow_up_count">,
  want: { at?: string | null; nowMs?: number } = {},
): { ok: true } | { ok: false; status: number; error: string } {
  if (caller.admin) return { ok: true };
  if (!caller.scopedWs || caller.scopedWs !== jot.workspace_id) return { ok: false, status: 403, error: "not your client's note" };
  const ownsIt = jot.source !== "operator" || (!!caller.session && caller.session === jot.follow_up_session);
  if (!ownsIt) return { ok: false, status: 403, error: "this is the operator's own note — append to it, or `mc ask` them to reschedule" };
  if (want.at) {
    const lead = Date.parse(want.at) - (want.nowMs ?? Date.now());
    if (lead < MIN_AGENT_LEAD_MS) return { ok: false, status: 400, error: "agents schedule follow-ups at least 30 minutes out" };
    if (jot.follow_up_count >= MAX_AGENT_FOLLOW_UPS) {
      return { ok: false, status: 409, error: `this note has been followed up ${jot.follow_up_count} times — ask the operator whether it is still worth chasing` };
    }
  }
  return { ok: true };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** The first prompt of a follow-up terminal. Pure, so the tests can read exactly what an agent is told. */
export function followUpBrief(j: Jot, wsName: string): string {
  const id = j.id.slice(0, 8);
  const round = j.follow_up_count;
  const check = j.follow_up_check?.trim() || "Is this still open? What changed since it was written, and what is the next concrete step?";
  return [
    `This is a scheduled follow-up (#${round}) on a note parked on ${wsName}'s pad — note \`${id}\`, filed ${when(j.created_at)}${j.source === "agent" ? " by an agent" : j.source === "operator" ? " by the operator" : ""}.`,
    "",
    "## The note",
    `**${j.title}**`,
    "",
    j.body?.trim() || "(no detail was written)",
    "",
    "## What to check this time",
    check,
    "",
    "## How to do it",
    "1. Find out the real current state: repos, PRs, CI, trackers, data, Slack threads — whatever the note points at. Read before you act.",
    "2. Move it forward as far as you safely can. Anything outward-facing (messaging people, merging, deploying, touching production data, spending money) → `mc ask` first.",
    `3. Write what you found onto the note, dated, with links: \`mc pad append ${id} "### Follow-up ${new Date().toISOString().slice(0, 10)} — <one line>\\n<details>"\``,
    "4. Close the loop with exactly ONE of these before you finish:",
    `   - done / no longer relevant → \`mc pad resolve ${id} "<why>"\``,
    `   - needs another look later → \`mc pad follow ${id} <when> --check "<what to look at next time>"\` (when: +2d, tomorrow 9:00, monday 10, 2026-10-01 14:00)`,
    `   - needs the operator's decision → \`mc ask\` with your recommendation; leave the note open.`,
    "",
    "Keep it short and factual. The note is the record — your terminal will be closed; what you appended is what the operator reads.",
  ].join("\n");
}

/**
 * Open the follow-up terminal for one due note. Claims the row first so no second sweep can take
 * it; if the terminal cannot open (seat cap, busy machine), puts the time back a bit later instead
 * of losing the follow-up.
 */
export async function fireFollowUp(id: string, nowMs = Date.now(), opener: typeof openSession = openSession): Promise<Session | null> {
  const nowIso = new Date(nowMs).toISOString();
  if (!jots.claimFollowUp(id, nowIso)) return null;
  const j = jots.get(id)!;
  const ws = workspaces.get(j.workspace_id);
  try {
    const session = await opener({
      workspace_id: j.workspace_id,
      goal: `Follow up: ${j.title}`.slice(0, 400),
      goal_kind: "investigation",
      goal_source: "human",
      description: followUpBrief(j, ws?.name ?? "this client"),
      backend: ws?.default_backend ?? undefined,
      model: null,
      created_by: "follow-up",
      role: "human",
    } as any);
    jots.followedUpBy(id, session.id);
    bus.publish({ topic: "jot.updated", jot_id: id, workspace_id: j.workspace_id });
    bus.publish({ topic: "jot.followup", jot_id: id, workspace_id: j.workspace_id, session_id: session.id });
    try { desktop(`⏰ Follow-up · ${ws?.name ?? ""}`, j.title); } catch { /* notification is a courtesy */ }
    console.log(`[followup] ${j.id.slice(0, 8)} "${j.title.slice(0, 60)}" → terminal ${session.id.slice(0, 8)}`);
    return session;
  } catch (e: any) {
    const retry = new Date(nowMs + RETRY_MS).toISOString();
    jots.unclaimFollowUp(id, retry);
    console.warn(`[followup] ${j.id.slice(0, 8)} could not open (${e?.message ?? e}) — retrying ${retry}`);
    bus.publish({ topic: "jot.updated", jot_id: id, workspace_id: j.workspace_id });
    return null;
  }
}

/** Fire what is due — a few per pass, one per client, so a wake-up does not flood the wall. */
export async function sweepFollowUps(nowMs = Date.now(), opener: typeof openSession = openSession): Promise<number> {
  const due = jots.dueFollowUps(new Date(nowMs).toISOString());
  const seen = new Set<string>();
  let fired = 0;
  for (const j of due) {
    if (fired >= FIRE_PER_SWEEP) break;
    if (seen.has(j.workspace_id)) continue;
    // A note whose last follow-up terminal is still working waits for it rather than doubling up.
    if (j.follow_up_session && sessions.get(j.follow_up_session)?.status === "live") continue;
    seen.add(j.workspace_id);
    if (await fireFollowUp(j.id, nowMs, opener)) fired++;
  }
  return fired;
}

let timer: NodeJS.Timeout | null = null;
let sweeping = false;
let lastSweep = 0;

/**
 * Sleep until the soonest follow-up — at most an hour, so a clock change cannot strand one, and at
 * least a minute after the last pass, so a due note the sweep had to skip (per-pass cap, its last
 * terminal still live, a full seat cap) is retried on a minute's cadence rather than spun on.
 */
export function armFollowUps(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const next = jots.nextFollowUpAt();
  if (!next) return;
  const now = Date.now();
  const wait = Math.min(Math.max(Date.parse(next), lastSweep + 60_000, now + 1_000) - now, MAX_SLEEP_MS);
  timer = setTimeout(runSweep, wait);
  timer.unref?.();
}

async function runSweep(): Promise<void> {
  timer = null;
  if (sweeping) return; // the running pass re-arms when it finishes
  sweeping = true;
  lastSweep = Date.now();
  try {
    await sweepFollowUps();
  } catch (e: any) {
    console.warn("[followup] sweep", e?.message ?? e);
  } finally {
    sweeping = false;
    armFollowUps();
  }
}

export function startFollowUps(): void {
  bus.on("event", (e: any) => {
    if (e?.topic === "jot.updated" || e?.topic === "jot.ran") armFollowUps();
  });
  armFollowUps();
  const n = jots.dueFollowUps(new Date().toISOString()).length;
  console.log(`[followup] armed${n ? ` · ${n} overdue, firing now` : ""}`);
}
