/**
 * Which executive a Telegram chat is talking to.
 *
 * Robert is the only executive while Robert is the only executive, so in practice every chat talks to him: `/ada`,
 * `/ham`, `/iris` and `/vega` are gone from EXEC_HANDLES, which makes execCommand return null for
 * them and leaves them to be handled as unknown commands. Its own module because text
 * (telegram.ts), voice and media all need it, and routing it through telegram.ts would make those
 * imports circular.
 *
 * Same kv + write-through cache shape as the active workspace, so the choice survives a restart —
 * which is exactly why getActiveExec revalidates: chats that were pointed at Ada before the
 * retirement still have "ada" sitting in kv, and must fall back to Robert rather than route to an
 * executive that no longer has a process.
 */
import { kv } from "../store.js";
import { EXEC_HANDLES } from "../board.js";

export const EXEC_NAME: Record<string, string> = {
  robert: "Robert",
};

export const EXEC_LINE: Record<string, string> = {
  robert: "Chief of Everything — workforce, tickets, Mission Control",
};

/** The command that selects each executive (the short handle the operator actually types). */
export const EXEC_SLASH: Record<string, string> = {
  robert: "/robert",
};

const cache = new Map<number, string>();

export function getActiveExec(chatId: number): string {
  if (!cache.has(chatId)) {
    // A stored id is only honored while that executive still exists. Chats pinned to a retired one
    // (ada / nils / iris) land back on Robert instead of resolving to a dead process.
    const stored = kv.get(`tg.activeExec.${chatId}`) || "";
    cache.set(chatId, EXEC_HANDLES[stored] ? stored : "robert");
  }
  return cache.get(chatId)!;
}

export function setActiveExec(chatId: number, execId: string): void {
  cache.set(chatId, execId);
  kv.set(`tg.activeExec.${chatId}`, execId);
}

/** `/ada`, `/ham`, `/robert`… → the exec id it selects, or null if it isn't one. */
export function execCommand(text: string): string | null {
  const m = (text ?? "").trim().match(/^\/([a-z]+)(\s|$)/i);
  return m ? (EXEC_HANDLES[m[1].toLowerCase()] ?? null) : null;
}
