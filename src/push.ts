import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";
import { bus, type BusEvent } from "./bus.js";
import { CONFIG } from "./config.js";
import { sessions, workspaces } from "./store.js";
import type { DeskPrompt } from "./desk-prompt.js";
import { REPO_ROOT } from "./repo-root.js";

// Web Push for the phone (static/phone.html + static/sw.js): a terminal flipping to needs-you, an
// agent reporting itself blocked, or Robert answering, reaches the phone as a notification with the
// answer riding in its buttons. No cloud in the middle beyond the browser vendor's push relay, which
// only ever sees an encrypted blob — the VAPID key pair lives next to the admin token, the
// subscriptions in a file beside it, both 0600.
//
// What gets pushed is deliberately narrow: the two things the Desk's own attention() would notify
// for (your turn / blocked) and a reply from the manager. Not run outcomes, not CI — those already
// reach Telegram, and a phone that buzzes for everything is one you mute.

const HOME = REPO_ROOT;
const VAPID_FILE = process.env.CHRONOS_VAPID_FILE ?? path.join(HOME, ".vapid.json");
const SUBS_FILE = process.env.CHRONOS_PUSH_SUBS_FILE ?? path.join(HOME, ".push-subscriptions.json");
// VAPID "subject": who to contact about this sender. A URL is valid; the push services only use it to reach an abusive sender.
const SUBJECT = process.env.CHRONOS_PUSH_SUBJECT ?? "mailto:chronos@localhost";
/** One notification per terminal per this window: a TUI flickers waiting→working→waiting on a slow repaint. */
export const COOLDOWN_MS = 45_000;
/** …and at most this many per terminal until the operator types into it (or it ends). A terminal at rest flickers all afternoon. */
export const MAX_PER_TERMINAL = 3;

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string }; added_at: string; ua?: string | null };
/** A button on the notification: what the SW types when it is tapped (same body as POST /sessions/:id/input). */
export type PushAction = { action: string; title: string; input: Record<string, unknown> };
export type PushPayload = {
  kind: "needs" | "blocked" | "robert";
  title: string;
  body: string;
  /** Collapses repeats for the same terminal / thread in the tray. */
  tag: string;
  /** Where a tap on the body lands: a phone-page hash the page understands. */
  url: string;
  session_id?: string;
  actions?: PushAction[];
  /** Live terminals waiting on the operator right now — the app-icon badge. */
  needs: number;
  at: string;
};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

let vapid: { publicKey: string; privateKey: string } | null = null;
export function vapidKeys(): { publicKey: string; privateKey: string } {
  if (vapid) return vapid;
  const existing = readJson<{ publicKey?: string; privateKey?: string }>(VAPID_FILE, {});
  if (existing.publicKey && existing.privateKey) vapid = { publicKey: existing.publicKey, privateKey: existing.privateKey };
  else { vapid = webpush.generateVAPIDKeys(); writeJson(VAPID_FILE, vapid); }
  return vapid;
}

export const pushSubs = {
  list(): PushSubscription[] { return readJson<PushSubscription[]>(SUBS_FILE, []); },
  add(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, ua?: string | null): PushSubscription {
    const all = this.list().filter((s) => s.endpoint !== sub.endpoint);
    const row: PushSubscription = { endpoint: sub.endpoint, keys: sub.keys, added_at: new Date().toISOString(), ua: ua ?? null };
    writeJson(SUBS_FILE, [...all, row]);
    return row;
  },
  remove(endpoint: string): boolean {
    const all = this.list();
    const kept = all.filter((s) => s.endpoint !== endpoint);
    if (kept.length !== all.length) writeJson(SUBS_FILE, kept);
    return kept.length !== all.length;
  },
};

/**
 * A terminal a live Lead opened. Its stops wake the Lead, not the operator (LEADS.md), and the phone
 * does not list it — so pushing it would ring for something the home screen cannot even show.
 */
export function underLiveLead(id: string): boolean {
  const s = sessions.get(id);
  return !!s?.lead_id && sessions.get(s.lead_id)?.status === "live";
}

/** How many live terminals want the operator — the badge number. Counted from the sessions the phone lists. */
function needsCount(activity: (id: string) => { live: boolean; quiet: boolean }, blocked: Set<string>): number {
  return sessions.list({ status: "live", limit: 200 }).filter((s) => {
    const a = activity(s.id);
    return a.live && (a.quiet || blocked.has(s.id)) && !underLiveLead(s.id);
  }).length;
}

/** The buttons: at most two — that is what Android shows — and each one is a complete /input body. */
export function actionsFor(prompt: DeskPrompt | null | undefined): PushAction[] {
  if (prompt?.kind === "select" && prompt.options?.length) {
    return prompt.options.slice(0, 2).map((o, i) => ({
      action: "opt" + i,
      title: o.label.slice(0, 24),
      input: { keys: [...Array(Math.abs(o.offset)).fill(o.offset > 0 ? "down" : "up"), "enter"] },
    }));
  }
  if (prompt?.kind === "yn") return [{ action: "y", title: "Yes", input: { text: "y", enter: true } }, { action: "n", title: "No", input: { text: "n", enter: true } }];
  return [{ action: "enter", title: "Enter ⏎", input: { key: "enter" } }, { action: "open", title: "Open", input: {} }];
}

export type Sender = (sub: PushSubscription, payload: PushPayload) => Promise<void>;
let vapidSet = false;
const realSender: Sender = async (sub, payload) => {
  if (!vapidSet) { const k = vapidKeys(); webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey); vapidSet = true; }
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 600, urgency: "high" });
};

/** Deliver to every subscription; a 404/410 means the browser dropped it, so drop it too. */
export async function broadcast(payload: PushPayload, send: Sender = realSender): Promise<{ sent: number; dropped: number }> {
  const subs = pushSubs.list();
  let sent = 0, dropped = 0;
  await Promise.all(subs.map(async (sub) => {
    try { await send(sub, payload); sent++; }
    catch (err: any) {
      const code = Number(err?.statusCode ?? err?.status ?? 0);
      if (code === 404 || code === 410) { pushSubs.remove(sub.endpoint); dropped++; }
      else console.error("[push] send failed:", code || err?.message || err);
    }
  }));
  return { sent, dropped };
}

type Deps = {
  send?: Sender;
  activity: (id: string) => { live: boolean; quiet: boolean };
  prompt: (id: string) => DeskPrompt | null;
  /** The resolved phase (term-status.ts). A terminal waiting on its own subagents went quiet, but it is not your turn. */
  phase?: (id: string) => string | null;
  now?: () => number;
  /** Tests force it on; the daemon reads CONFIG.push (off under CHRONOS_TEST). */
  enabled?: boolean;
};

/**
 * Watch the bus and push. Pure over its deps so the test drives it with a fake sender and clock.
 * Returns a stop() for tests; in the daemon it runs for the process lifetime.
 */
export function startPush(deps: Deps): () => void {
  if (!(deps.enabled ?? CONFIG.push)) { console.log("[push] disabled"); return () => {}; }
  const send = deps.send ?? realSender;
  const now = deps.now ?? Date.now;
  const lastState = new Map<string, "working" | "waiting">();
  const lastPushed = new Map<string, number>();
  const pushed = new Map<string, number>(); // per terminal, since the operator last answered it
  const blocked = new Set<string>();

  const cooled = (key: string) => {
    const t = lastPushed.get(key) ?? 0;
    if (now() - t < COOLDOWN_MS) return false;
    lastPushed.set(key, now());
    return true;
  };
  const allowed = (sid: string) => {
    const n = pushed.get(sid) ?? 0;
    if (n >= MAX_PER_TERMINAL) return false;
    pushed.set(sid, n + 1);
    return true;
  };
  const wsName = (id: string | null | undefined) => (id && workspaces.get(id)?.name) || null;

  const onEvent = async (e: BusEvent) => {
    if (e.topic === "session.activity") {
      const prev = lastState.get(e.session_id);
      lastState.set(e.session_id, e.state);
      if (e.state !== "waiting" || prev !== "working") return; // only the flip, not the steady state
      if (blocked.has(e.session_id)) return; // the blocked push already went out
      const ph = deps.phase?.(e.session_id);
      if (ph === "waiting" || ph === "working") return;
      const s = sessions.get(e.session_id);
      if (!s || underLiveLead(s.id) || !cooled("s:" + s.id) || !allowed(s.id)) return;
      const p = e.prompt ?? deps.prompt(s.id);
      const isTurn = !p || p.kind === "turn";
      await broadcast({
        kind: "needs",
        title: (wsName(s.workspace_id) ? wsName(s.workspace_id) + " · " : "") + (isTurn ? "turn finished" : "your turn"),
        body: (s.goal || s.title || "terminal") + (p?.question ? " — " + p.question : ""),
        tag: "session:" + s.id, url: "/phone#s=" + s.id, session_id: s.id,
        actions: actionsFor(p),
        needs: needsCount(deps.activity, blocked), at: new Date(now()).toISOString(),
      }, send);
      return;
    }
    if (e.topic === "agent.state" && e.kind === "session") {
      const was = blocked.has(e.id);
      if (e.state === "blocked") blocked.add(e.id); else blocked.delete(e.id);
      if (e.state !== "blocked" || was) return;
      const s = sessions.get(e.id);
      if (!s || underLiveLead(s.id) || !cooled("b:" + s.id) || !allowed(s.id)) return;
      await broadcast({
        kind: "blocked",
        title: (wsName(s.workspace_id) ? wsName(s.workspace_id) + " · " : "") + "blocked",
        body: (s.goal || s.title || "terminal") + (e.state_label ? " — " + e.state_label : e.blocked_reason ? " — " + e.blocked_reason : ""),
        tag: "session:" + s.id, url: "/phone#s=" + s.id, session_id: s.id,
        actions: [{ action: "open", title: "Open", input: {} }],
        needs: needsCount(deps.activity, blocked), at: new Date(now()).toISOString(),
      }, send);
      return;
    }
    // The operator answered (from the phone, the Desk, or a notification button): the terminal has
    // been looked at, so its count starts over. An ended terminal takes its count with it.
    if (e.topic === "session.input") { if (e.by !== "agent") pushed.delete(e.session_id); return; }
    if (e.topic === "session.ended") { pushed.delete(e.session_id); lastState.delete(e.session_id); return; }
    if (e.topic === "agent.push") {
      if (e.source === "divider" || !e.reply) return;
      const scope = e.ws ? wsName(e.ws) : null;
      await broadcast({
        kind: "robert",
        title: "Robert" + (scope ? " · " + scope : ""),
        body: e.reply.replace(/\s+/g, " ").slice(0, 180),
        tag: "robert:" + (e.ws || "all"), url: "/phone#robert" + (e.ws ? "=" + e.ws : ""),
        needs: needsCount(deps.activity, blocked), at: new Date(now()).toISOString(),
      }, send);
    }
  };
  bus.on("event", onEvent);
  console.log(`[push] on — ${pushSubs.list().length} subscription(s)`);
  return () => { bus.off("event", onEvent); };
}
