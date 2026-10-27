import { createRequire } from "node:module";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize";

// Both packages are CJS: a named ESM import typechecks but throws at runtime.
const cjs = createRequire(import.meta.url);
const { Terminal } = cjs("@xterm/headless") as { Terminal: typeof HeadlessTerminal };
const { SerializeAddon, HTMLSerializeHandler } = cjs("@xterm/addon-serialize") as { SerializeAddon: typeof Serializer; HTMLSerializeHandler: any };

// @xterm/addon-serialize (0.14, and its 0.15 betas) gets two things wrong in the SGR it writes when
// the style changes between cells. It ends bold with 22 and dim with 22 — but 22 ends BOTH, so a cell
// that keeps one while the other goes (bold+dim → dim) or swaps them (dim → bold, written "1;22")
// comes back plain; Claude's fullscreen view has such cells. And a 256-colour index under 16
// (38;5;1) comes back as the 16-colour code (31), a different colour mode to xterm. Its string
// handler isn't exported, so that one method is replaced on the handler's prototype the first time
// one serializes — with the addon's own diff, corrected. term-screen.test.ts round-trips every
// bold/dim transition and both colour forms, so it fails if this stops applying.
if (!fixStyleDiff()) console.warn("[term-screen] serialize addon changed shape — snapshots may lose bold/dim");

function fixStyleDiff(): boolean {
  const base = HTMLSerializeHandler && Object.getPrototypeOf(HTMLSerializeHandler)?.prototype;
  const serialize = base?.serialize;
  if (typeof serialize !== "function") return false;
  const done = new WeakSet<object>();
  base.serialize = function (this: object, ...args: unknown[]) {
    const proto = Object.getPrototypeOf(this);
    if (proto !== HTMLSerializeHandler.prototype && !done.has(proto) && typeof proto._diffStyle === "function") {
      done.add(proto);
      proto._diffStyle = diffStyle;
    }
    return serialize.apply(this, args);
  };
  return true;
}

const P256 = 0x2000000; // xterm's colour mode for 38;5;n / 48;5;n

/** SGR params that take the pen from `old`'s style to `cell`'s: the addon's _diffStyle, corrected.
 *  It runs for every cell, and for nearly every one there is nothing to say. */
function diffStyle(cell: IBufferCell, old: IBufferCell): number[] {
  const fg = cell.getFgColorMode() !== old.getFgColorMode() || cell.getFgColor() !== old.getFgColor();
  const bg = cell.getBgColorMode() !== old.getBgColorMode() || cell.getBgColor() !== old.getBgColor();
  const b = !!cell.isBold(), d = !!cell.isDim(), ob = !!old.isBold(), od = !!old.isDim();
  const flags = b !== ob || d !== od || !!cell.isInverse() !== !!old.isInverse() || !!cell.isUnderline() !== !!old.isUnderline()
    || !!cell.isOverline() !== !!old.isOverline() || !!cell.isBlink() !== !!old.isBlink() || !!cell.isInvisible() !== !!old.isInvisible()
    || !!cell.isItalic() !== !!old.isItalic() || !!cell.isStrikethrough() !== !!old.isStrikethrough();
  const seq: number[] = [];
  if (!fg && !bg && !flags) return seq;
  if (cell.isAttributeDefault()) {
    if (!old.isAttributeDefault()) seq.push(0);
    return seq;
  }
  if (fg) colour(seq, 38, 30, 90, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColorMode(), cell.getFgColor());
  if (bg) colour(seq, 48, 40, 100, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColorMode(), cell.getBgColor());
  if (flags) {
    if (!!cell.isInverse() !== !!old.isInverse()) seq.push(cell.isInverse() ? 7 : 27);
    if ((ob && !b) || (od && !d)) {
      seq.push(22); // ends bold AND dim: say again whichever this cell keeps
      if (b) seq.push(1);
      if (d) seq.push(2);
    } else {
      if (b && !ob) seq.push(1);
      if (d && !od) seq.push(2);
    }
    if (!!cell.isUnderline() !== !!old.isUnderline()) seq.push(cell.isUnderline() ? 4 : 24);
    if (!!cell.isOverline() !== !!old.isOverline()) seq.push(cell.isOverline() ? 53 : 55);
    if (!!cell.isBlink() !== !!old.isBlink()) seq.push(cell.isBlink() ? 5 : 25);
    if (!!cell.isInvisible() !== !!old.isInvisible()) seq.push(cell.isInvisible() ? 8 : 28);
    if (!!cell.isItalic() !== !!old.isItalic()) seq.push(cell.isItalic() ? 3 : 23);
    if (!!cell.isStrikethrough() !== !!old.isStrikethrough()) seq.push(cell.isStrikethrough() ? 9 : 29);
  }
  return seq;
}

function colour(seq: number[], ext: number, base: number, bright: number, rgb: boolean, palette: boolean, mode: number, c: number) {
  if (rgb) seq.push(ext, 2, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
  else if (palette && (c >= 16 || mode === P256)) seq.push(ext, 5, c); // 38;5;1 stays 38;5;1
  else if (palette) seq.push(c & 8 ? bright + (c & 7) : base + (c & 7));
  else seq.push(ext + 1); // 39 / 49: the default colour
}

export type Screen = { seq: number; cols: number; rows: number; lines: string[] };

/** What serializeAt hands back: the bytes, or why not (busy = try again in a moment). */
export type Serialized = { ok: true; data: string } | { ok: false; busy: boolean };

// History a local terminal's mirror keeps for a pane that (re)attaches — serializeAt sends it ahead
// of the frame, so you can scroll up past what is on screen. Memory, not CPU: the parse costs the
// same with or without it, but every line is cols × 12 bytes held for the terminal's life. Measured
// (2026-10-27, 30 terminals at 160×50, history full): +19 MB RSS at 200 lines, +55 MB at 500, +106 MB
// at 1000. A 256 KB raw tail of a Claude terminal rebuilt ~160 lines of history, so 500 is more than
// the Desk showed before for a fraction of the bytes on the wire.
export const SCROLLBACK = lines(process.env.CHRONOS_TERM_SCROLLBACK, 500);
/** A snapshot that has not come back by now is not coming: the caller replays raw instead. */
const SNAP_WAIT_MS = 250;

// The daemon's own copy of what each terminal is showing. A headless xterm fed every pty chunk as it
// arrives (cost: the new bytes, not the scrollback), so anyone can read the current frame as text —
// the wall's text cards, prompt detection, an agent asking "what is that terminal doing" — without a
// browser parsing the stream. `seq` moves only once a chunk is PARSED, so a reader that saw seq N
// and is told "still N" is holding the exact frame, not one write behind it.
export class ScreenMirror {
  private term: HeadlessTerminal;
  private serializer: Serializer | null = null;
  private readonly scrollback: number;
  private _seq = 0;
  private disposed = false;

  /** `scrollback`: lines of history kept for serializeAt (0 = the frame only — remote terminals). */
  constructor(cols: number, rows: number, scrollback = 0) {
    this.scrollback = Math.max(0, scrollback | 0);
    this.term = new Terminal({ cols: dim(cols, 20), rows: dim(rows, 4), scrollback: this.scrollback, allowProposedApi: true });
    try {
      const s = new SerializeAddon();
      this.term.loadAddon(s);
      this.serializer = s;
    } catch (err) {
      console.warn("[term-screen] serialize addon unavailable:", err instanceof Error ? err.message : err);
    }
  }

  get seq() { return this._seq; }

  write(data: string) {
    if (this.disposed || !data) return;
    // xterm headless has thrown TypeError: Cannot set properties of undefined (setting 'isWrapped')
    // from its async parse queue on malformed / mid-dispose writes. Keep the mirror best-effort:
    // never throw into the pty path, and never bump seq after dispose.
    try {
      this.term.write(data, () => { if (!this.disposed) this._seq++; });
    } catch (err) {
      console.warn("[term-screen] write failed:", err instanceof Error ? err.message : err);
    }
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    const c = dim(cols, 20), r = dim(rows, 4);
    if (c === this.term.cols && r === this.term.rows) return;
    try { this.term.resize(c, r); this._seq++; } catch {}
  }

  /** Is the mirror the pty's size? It floors at 20×4, so a smaller pty's frame is not this one. */
  fits(cols: number, rows: number): boolean {
    return !this.disposed && this.term.cols === cols && this.term.rows === rows;
  }

  /** Every write so far parsed. */
  settle(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 200);
      try {
        this.term.write("", () => { clearTimeout(t); resolve(); });
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** The visible frame as text (history is kept for serializeAt, never read here). */
  snapshot(): Screen {
    if (this.disposed) return { seq: this._seq, cols: 0, rows: 0, lines: [] };
    try {
      const b = this.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      return { seq: this._seq, cols: this.term.cols, rows: this.term.rows, lines };
    } catch {
      return { seq: this._seq, cols: this.term.cols, rows: this.term.rows, lines: [] };
    }
  }

  /**
   * This terminal at this point in the stream, as bytes: written into an xterm of the same size they
   * give the same frame — every cell's character, width and colours, the cursor, the alternate screen
   * — the modes the CLI set (bracketed paste, mouse tracking and its encoding, focus reports, cursor
   * keys, a hidden cursor), and the kept history ahead of it. It opens with RIS, so whatever the
   * receiving xterm held before (a stale frame, bytes that raced a reset) is gone first.
   *
   * "This point" is exact: `cb` gets the state once every chunk written before the call is parsed and
   * before any chunk written after it is, so this snapshot followed by the stream from the call on IS
   * the stream. Always async. busy: the stream is mid-escape here, or holds state the serializer can't
   * carry (atRest) — usually a moment later it isn't. Not ok and not busy: disposed, xterm threw, or
   * the parse queue didn't reach this point within SNAP_WAIT_MS.
   */
  serializeAt(cb: (r: Serialized) => void): void {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    // Never call back from inside xterm's parse loop: a throw there stops its write queue for good.
    const finish = (r: Serialized) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      queueMicrotask(() => cb(r));
    };
    const fail: Serialized = { ok: false, busy: false };
    if (this.disposed || !this.serializer) return finish(fail);
    timer = setTimeout(() => finish(fail), SNAP_WAIT_MS);
    try {
      this.term.write("", () => {
        if (this.disposed) return finish(fail);
        try { finish(this.atRest() ? { ok: true, data: this.serialize() } : { ok: false, busy: true }); }
        catch { finish(fail); }
      });
    } catch {
      finish(fail);
    }
  }

  // Where a snapshot would be wrong, wait instead. Mid-escape: the next chunk starts with the rest of a
  // sequence the snapshot can't hold the front of, and the pane would print it as text. A pending
  // wrap: the cursor sits past the last column and no sequence puts it there. And state the addon
  // doesn't serialize — a scroll region, origin mode, a designated charset. The first two pass within
  // a frame; the rest are rare and end in a raw replay.
  // Parser, regions and charsets live off xterm's public API (the serialize addon reads _core too):
  // term-screen.test.ts pins every field read here, and an unreadable one counts as busy.
  private atRest(): boolean {
    const t = this.term;
    const core = (t as any)._core;
    if (t.modes.originMode) return false;
    if (t.buffer.active.cursorX >= t.cols) return false;
    if (core?._inputHandler?._parser?.currentState !== 0) return false;
    for (const b of [core?.buffers?.normal, core?.buffers?.alt]) {
      if (b?.scrollTop !== 0 || b?.scrollBottom !== t.rows - 1) return false;
    }
    // G0–G3 as designated (undefined = ASCII, what `ESC ( B` sets) and which one is in use.
    const cs = core?._charsetService;
    if (!cs || cs.glevel !== 0 || cs.charset !== undefined) return false;
    return Array.isArray(cs._charsets) && cs._charsets.every((c: unknown) => c === undefined);
  }

  private serialize(): string {
    const core = (this.term as any)._core;
    // With the alt screen up, the addon writes the normal screen, ends that part by restoring the live
    // pen, then writes the alt screen as if the pen were plain — so its first cells took the pen's
    // colours. Plain it is, before the switch. (No cell holds an ESC: this is the addon's own switch.)
    const body = this.serializer!.serialize({ scrollback: this.scrollback }).replace("\x1b[?1049h\x1b[H", "\x1b[0m\x1b[?1049h\x1b[H");
    let out = "\x1bc" + body;
    // Modes the addon leaves out that these CLIs do set: a hidden cursor (a TUI drawing its own), and
    // the mouse report encoding — without ?1006 a fullscreen TUI that asked for SGR reports gets X10
    // ones and the wheel stops scrolling it.
    if (core?.coreService?.isCursorHidden) out += "\x1b[?25l";
    const enc = core?.coreMouseService?.activeEncoding;
    if (enc === "SGR") out += "\x1b[?1006h";
    else if (enc === "SGR_PIXELS") out += "\x1b[?1016h";
    // Taken halfway through a ?2026 frame: the pane holds its paint, exactly as the stream asked, until
    // the CLI's own end-of-frame arrives right behind — no half-drawn frame on screen in between.
    if (this.term.modes.synchronizedOutputMode) out += "\x1b[?2026h";
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.term.dispose(); } catch {}
  }
}

const dim = (n: number, min: number) => Math.max(min, n | 0);

function lines(raw: string | undefined, dflt: number): number {
  const n = raw?.trim() ? Number(raw) : dflt;
  return Number.isFinite(n) ? Math.min(5000, Math.max(0, Math.floor(n))) : dflt;
}
