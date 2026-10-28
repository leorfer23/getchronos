/**
 * The operator answers questions where he reads them: in the terminal. An open ask that is his
 * (escalated, or routed to him) closes the moment he submits a line into that terminal — by typing
 * in the xterm or from the Desk composer. Without this the ask stayed open after he had answered in
 * the pty, and term-status kept the card on "decide" forever.
 *
 * Only his keystrokes count: the websocket of an attached Desk pane, or /input with by "operator".
 * Robert's and a Lead's typing go through /input with their own `by` and never close an ask here.
 */
import { asks } from "./store.js";
import { answerAsk } from "./asks.js";
import { holderAsks } from "./robert-asks.js";

const buf = new Map<string, string>();
const CAP = 2000;

const isHis = (a: { route: string | null; escalated_at: string | null }) => a.route === "operator" || !!a.escalated_at;

/** Close his open asks on this terminal with what he submitted. Returns how many closed. */
export async function operatorAnswered(sessionId: string, text: string, answer = answerAsk): Promise<number> {
  const open = [...asks.openForSession(sessionId).filter(isHis), ...holderAsks(sessionId)];
  let n = 0;
  for (const a of open) {
    const r = await answer(a.id, text.trim() || "(answered in the terminal)", "operator", { typedIn: sessionId });
    if (r.ok) n++;
  }
  return n;
}

/** Raw xterm bytes from his pane. Buffers the line; Enter submits it. Escape sequences are ignored. */
export function operatorKeys(sessionId: string, data: string, answer = answerAsk): Promise<number> | null {
  if (data.startsWith("\x1b")) return data.includes("\r") ? operatorAnswered(sessionId, "", answer) : null;
  let line = buf.get(sessionId) ?? "";
  let submit = false;
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") { submit = true; break; }
    if (ch === "\x7f" || ch === "\b") line = line.slice(0, -1);
    else if (ch === "\x03" || ch === "\x15") line = "";
    else if (ch >= " ") line += ch;
  }
  if (!submit) {
    buf.set(sessionId, line.slice(-CAP));
    return null;
  }
  buf.delete(sessionId);
  return operatorAnswered(sessionId, line, answer);
}

export function forgetTerminal(sessionId: string): void {
  buf.delete(sessionId);
}
