/**
 * The Mac clipboard, as a capability an agent actually has.
 *
 * The operator copies a token, a URL, a stack trace, a block of SQL, and tells the terminal "use what I just
 * copied" — and the agent answers that it has no clipboard tool and there is nothing in the
 * conversation. It is right about its own environment and useless about his: the daemon runs
 * unsandboxed on his machine and `pbpaste` is right there.
 *
 * So the clipboard comes through the daemon rather than through the agent's own shell. That also
 * makes it work for a sandboxed agent, and — more to the point — it makes every read a recorded
 * event with a name on it.
 *
 * WHAT THIS IS: the clipboard is where secrets pass through. Any agent that can reach the API can
 * now read whatever the operator last copied, including the password they copied for something else entirely.
 * Three things hold that down, and none of them is "the agent will be careful":
 *  - every read publishes `clipboard.read` with the reader's name, so the activity trail answers
 *    "who took my clipboard, and when";
 *  - the CONTENT is never logged, never posted to the board, never put in an event payload — only
 *    its length and a shape guess;
 *  - `CHRONOS_CLIPBOARD=0` turns the whole thing off.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bus } from "./bus.js";
import { DEFAULT_LOCALE } from "./child-env.js";

const execFileAsync = promisify(execFile);

/**
 * pbcopy/pbpaste read the encoding off the locale, and under launchd there is no locale — so they
 * fall back to MacRoman and every non-ASCII character round-trips as mojibake ("│" copies as "‚îÇ",
 * "❯" as "‚ùØ"). Pinning UTF-8 on the call itself keeps the clipboard correct no matter how the
 * daemon was started, or whether its plist has been reinstalled since.
 */
const clipEnv = { ...process.env, LANG: process.env.LANG || DEFAULT_LOCALE, LC_ALL: process.env.LC_ALL || DEFAULT_LOCALE };

/** Guard against a runaway paste becoming a multi-megabyte prompt. */
export const CLIP_MAX_BYTES = Number(process.env.CHRONOS_CLIPBOARD_MAX ?? 100_000);

export const clipboardEnabled = () => process.env.CHRONOS_CLIPBOARD !== "0";

/**
 * A description of the content that is safe to log, so the trail can say "he read a 64-char token"
 * without the trail BECOMING the leak. Never returns any of the text itself.
 */
export function describeClip(text: string): string {
  const n = text.length;
  if (!n) return "empty";
  const t = text.trim();
  const oneLine = !t.includes("\n");
  if (oneLine && /^https?:\/\//i.test(t)) return `url (${n} chars)`;
  if (oneLine && /^[A-Za-z0-9_\-.=]{16,}$/.test(t)) return `token-ish (${n} chars)`;
  if (oneLine && t.length < 200) return `one line (${n} chars)`;
  return `${t.split("\n").length} lines (${n} chars)`;
}

/**
 * Read the clipboard. `by` is the reader's name — an agent handle, "robert", the operator — and it
 * is what lands in the trail, so callers must pass the truth rather than a default.
 */
export async function readClipboard(by: string): Promise<{ text: string; describe: string }> {
  if (!clipboardEnabled()) throw new Error("clipboard access is disabled (CHRONOS_CLIPBOARD=0)");
  const { stdout } = await execFileAsync("pbpaste", [], {
    maxBuffer: CLIP_MAX_BYTES + 1024,
    encoding: "utf8",
    env: clipEnv,
  });
  const text = stdout.length > CLIP_MAX_BYTES ? stdout.slice(0, CLIP_MAX_BYTES) : stdout;
  const describe = describeClip(text);
  // Shape only — never the content. See the header.
  bus.publish({ topic: "clipboard.read", by, describe, chars: text.length });
  return { text, describe };
}

/** Write the clipboard, so an agent can hand the operator something to paste elsewhere. */
export async function writeClipboard(text: string, by: string): Promise<{ describe: string }> {
  if (!clipboardEnabled()) throw new Error("clipboard access is disabled (CHRONOS_CLIPBOARD=0)");
  if (text.length > CLIP_MAX_BYTES) throw new Error(`too long (${text.length} > ${CLIP_MAX_BYTES} chars)`);
  await new Promise<void>((resolve, reject) => {
    const p = execFile("pbcopy", [], { env: clipEnv }, (err) => (err ? reject(err) : resolve()));
    p.stdin?.end(text);
  });
  const describe = describeClip(text);
  bus.publish({ topic: "clipboard.write", by, describe, chars: text.length });
  return { describe };
}
