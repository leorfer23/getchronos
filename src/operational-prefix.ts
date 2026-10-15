/**
 * The mark that says "the daemon is talking, not the operator".
 *
 * Robert gets woken constantly — a review landed, a terminal went quiet, 9am came round, a peer
 * @mentioned him — and every one of those arrives on the same thread, in the same user turn shape,
 * as the operator's own messages. Nothing distinguished them but a `SYSTEM — ` lead-in that each
 * caller wrote by hand and any model could plausibly see in a real message. So "recap what happened
 * since I last spoke to you" had no boundary to find, and a heartbeat could read as the operator
 * asking for something.
 *
 * U+2063 INVISIBLE SEPARATOR has no keyboard key, survives UTF-8 transport through a pty and a
 * chat row, and renders as nothing. Followed by a stable ASCII label it is a marker the operator
 * cannot type by accident and the model cannot miss. The mark travels WITH the message text rather
 * than as harness metadata, because it has to survive every backend we spawn (claude, codex, …)
 * and none of them agree on what an injected turn looks like.
 *
 * Deliberately dependency-free: other modules import these three names and this file must never
 * become a reason to load the store, the config, or the bus.
 */

/**
 * U+2063 INVISIBLE SEPARATOR — the part the operator cannot type. Written as an escape on purpose:
 * the literal character is invisible in an editor, so a stray copy-paste could delete it and leave a
 * diff that looks like nothing changed.
 */
export const OP_MARK = "\u2063";

/** The human-readable half, so a leaked prefix reads as a bug rather than as mojibake. */
export const OP_LABEL = "CHRONOS_OP: ";

/** What every daemon-injected message starts with. */
export const OP_PREFIX = OP_MARK + OP_LABEL;

/**
 * True only when the prefix opens the WHOLE message. An operator who quotes a notification back
 * ("what did you mean by ⁣CHRONOS_OP: …") is still the operator speaking, so a match anywhere else
 * in the text does not count.
 */
export function isOperational(text: string): boolean {
  return typeof text === "string" && text.startsWith(OP_PREFIX);
}

/** The message without its marker. A non-operational message is returned untouched. */
export function stripOperational(text: string): string {
  return isOperational(text) ? text.slice(OP_PREFIX.length) : text;
}
