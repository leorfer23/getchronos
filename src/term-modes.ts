// A reattaching pane replays only the last BUF_CAP bytes of the pty. The DEC private modes a TUI
// sets once at boot — mouse tracking, SGR mouse encoding, alt screen, bracketed paste — scroll out
// of that tail on a long session, so a fresh xterm replays the frame but never hears "send me the
// wheel": scrolling is dead until the agent happens to re-emit them (it does on some redraws, which
// is why sending a message "fixed" it). Track the last state of each such mode from the live stream
// and lead every replay with it.

const TRACKED = new Set([1, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004]);
const CARRY_MAX = 32;
const CSI_DONE = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/;

export class ModeTracker {
  /** mode → set?, in order of last change: mouse modes override each other, so order matters. */
  private modes = new Map<number, boolean>();
  private carry = "";

  feed(chunk: string): void {
    const s = this.carry + chunk;
    this.carry = "";
    if (!s.includes("\x1b")) return;
    for (const m of s.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
      for (const n of m[1].split(";").map(Number)) {
        if (!TRACKED.has(n)) continue;
        this.modes.delete(n);
        this.modes.set(n, m[2] === "h");
      }
    }
    const esc = s.lastIndexOf("\x1b");
    const tail = s.slice(esc);
    if (tail.length < CARRY_MAX && !CSI_DONE.test(tail) && (tail.length === 1 || tail[1] === "[")) this.carry = tail;
  }

  /** Has the stream turned this mode on (and not back off)? 2004 = the TUI takes bracketed paste. */
  isOn(n: number): boolean {
    return this.modes.get(n) === true;
  }

  /** Escape sequences that put a fresh terminal into the stream's current modes. */
  preamble(): string {
    let out = "";
    for (const [n, on] of this.modes) out += `\x1b[?${n}${on ? "h" : "l"}`;
    return out;
  }
}
