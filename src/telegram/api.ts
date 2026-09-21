import { CONFIG } from "../config.js";
import { kv } from "../store.js";

// Raw Bot API transport + shared HTML helpers. Everything that touches the wire lives here.
export const TOKEN = CONFIG.telegram.token;
const API = `https://api.telegram.org/bot${TOKEN}`;

// Onboarding (/claim) claims the chat that proves it knows the admin token, so this is mutable
// module state. Env var wins if set; otherwise fall back to whatever was persisted last time.
let allowedChat = CONFIG.telegram.chatId || kv.get("tg.chat") || "";
export const getAllowedChat = () => allowedChat;
export const setAllowedChat = (v: string) => { allowedChat = v; kv.set("tg.chat", v); };

// Repeated identical errors (e.g. a sustained network outage) collapse into one throttled line
// instead of a full stack trace per call — the poll loop calls this every few seconds when down.
let lastApiErrMsg = "";
let lastApiErrLoggedAt = 0;
let lastApiErrCount = 0;
function logApiError(e: unknown) {
  const msg = errCode(e);
  const now = Date.now();
  const repeat = msg === lastApiErrMsg;
  lastApiErrCount = repeat ? lastApiErrCount + 1 : 1;
  lastApiErrMsg = msg;
  if (repeat && now - lastApiErrLoggedAt < 60_000) return;
  lastApiErrLoggedAt = now;
  console.error(`[telegram] api error${lastApiErrCount > 1 ? ` (x${lastApiErrCount} since last line)` : ""}`, e);
  lastApiErrCount = 0; // the window closes when we log; otherwise the count reads as cumulative-forever
}

// `fetch failed` is the same useless string for every transport fault — the cause carries the code
// that actually distinguishes a dropped socket from DNS being down.
function errCode(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause;
  const base = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return cause?.code ? `${base} (${cause.code})` : base;
}

// A dropped connection on a 30s long-poll is routine — the peer or a pooled socket closes between
// polls and the next dispatch loses the race. It says nothing about the bot's health, so it must not
// log as an error or stall the loop; only a SUSTAINED run of failures is worth either.
const BENIGN = new Set(["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EPIPE", "ECONNABORTED"]);
let consecutiveFails = 0;
export const transportFailStreak = () => consecutiveFails;

// Long-polls hold for ~30s server-side; anything past 45s is a wedged socket, not a slow answer.
const REQ_TIMEOUT_MS = 45_000;

export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const j = await r.json();
    consecutiveFails = 0;
    return j;
  } catch (e) {
    consecutiveFails++;
    // Stay quiet through the first few benign drops; speak up once it looks like a real outage.
    const code = (e as { cause?: { code?: string } })?.cause?.code ?? "";
    if (!BENIGN.has(code) || consecutiveFails >= 3) logApiError(e);
    return null;
  }
}

export function send(chatId: string | number, text: string, markup?: object, replyTo?: number) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(markup ? { reply_markup: markup } : {}),
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
  });
}

/**
 * Telegram HTML → board markdown. Only the tags Chronos actually emits (`<b>`, `<i>`, `<code>`,
 * `<pre>`, `<a href>`) plus the three escapes; anything else is dropped rather than shown raw.
 */
export function tgHtmlToMarkdown(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<\/?(?:b|strong)>/gi, "**")
    .replace(/<\/?(?:i|em)>/gi, "_")
    .replace(/<\/?(?:code|pre)>/gi, "`")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Operator notice. Telegram is the phone surface; every notice also lands on the board (author
 * "chronos") so /app keeps the durable record — `info`-level notices live ONLY there.
 *
 * `board: false` is for callers that already write their own, richer durable record (heartbeat's
 * board post, recovery's per-workspace post) — without it they'd say the same thing twice.
 */
/**
 * Who a notice is FOR (PER-26).
 *
 * `action` — the operator has to decide or act: an ask is blocking a worker, a gate held a PR, CI
 * is red, the budget is gone, a backup failed.
 * `info` — the shop narrating itself: a PR merged, hygiene ran, a plan dispatched, a build started.
 * Real, worth recording, nothing to do about it.
 *
 * Both still land on the board, so the history is unchanged — `info` only declines to interrupt.
 * ~50 alert types shared one chat with Robert's own voice, which is why his messages read as
 * machine noise: the signal was always there, buried in narration.
 *
 * Default is `action` deliberately. A call site nobody classified keeps today's behavior, so the
 * failure mode of forgetting is a noisier phone — never a missed blocker.
 */
export type NotifyLevel = "action" | "info";

/** Escape hatch: CHRONOS_NOTIFY_ALL=1 puts the narration back on the phone. */
const NOTIFY_ALL = process.env.CHRONOS_NOTIFY_ALL === "1";

export async function notify(
  text: string,
  markup?: object,
  opts?: { board?: boolean; level?: NotifyLevel },
) {
  if (opts?.board !== false) {
    // Late import: board.ts pulls the store in, and this module is imported from very early in the
    // boot graph — the lazy import keeps notify() usable before the DB is open in tests.
    void import("../board.js")
      .then((m) => m.postToBoard({ author: "chronos", body: tgHtmlToMarkdown(text) }))
      .catch(() => {});
  }
  if (opts?.level === "info" && !NOTIFY_ALL) return; // on the board, not on his phone
  if (!TOKEN || !allowedChat) return;
  await tg("sendMessage", { chat_id: allowedChat, text, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
}

/** Sugar for the narration tier — clearer at a call site than a trailing options object. */
export const notifyInfo = (text: string, markup?: object, opts?: { board?: boolean }) =>
  notify(text, markup, { ...opts, level: "info" });

// Edit an existing message in place (ticker updates). Telegram 400s on identical text — callers guard that.
export function editMessageText(chatId: string | number, messageId: number, text: string, markup?: object) {
  return tg("editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
    ...(markup ? { reply_markup: markup } : {}),
  });
}

export const sendChatAction = (chatId: string | number, action = "typing") =>
  tg("sendChatAction", { chat_id: chatId, action });

export function esc(s: string) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/** Longest title we put on a phone before it starts wrapping past the useful line. */
const TREF_TITLE_MAX = 52;

/**
 * How a ticket is named in any operator-facing message (PER-25).
 *
 * A key is an index into a system the operator does not hold in their head — "🎉 PER-14 PR merged"
 * tells him a number shipped, not what shipped. His words: "PER-88 not relevant to me, need to
 * understand what the ticket is about in a short words." So the title leads and the key trails,
 * small, for when he needs it to act.
 *
 * Falls back to the bare key when there is genuinely no title, rather than emitting a dangling dash.
 */
export function tref(t: { key: string; title?: string | null } | null | undefined): string {
  if (!t?.key) return "";
  const title = (t.title ?? "").trim();
  if (!title) return `<b>${esc(t.key)}</b>`;
  const short = title.length > TREF_TITLE_MAX ? title.slice(0, TREF_TITLE_MAX - 1).trimEnd() + "…" : title;
  return `<b>${esc(short)}</b> <code>${esc(t.key)}</code>`;
}
