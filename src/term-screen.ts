import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };

export type Screen = { seq: number; cols: number; rows: number; lines: string[] };

// The daemon's own copy of what each terminal is showing. A headless xterm fed every pty chunk as it
// arrives (cost: the new bytes, not the scrollback), so anyone can read the current frame as text —
// the wall's text cards, prompt detection, an agent asking "what is that terminal doing" — without a
// browser parsing the stream. `seq` moves only once a chunk is PARSED, so a reader that saw seq N
// and is told "still N" is holding the exact frame, not one write behind it.
export class ScreenMirror {
  private term: HeadlessTerminal;
  private _seq = 0;
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols: dim(cols, 20), rows: dim(rows, 4), scrollback: 0, allowProposedApi: true });
  }

  get seq() { return this._seq; }

  write(data: string) {
    if (this.disposed || !data) return;
    this.term.write(data, () => { this._seq++; });
  }

  resize(cols: number, rows: number) {
    if (this.disposed) return;
    const c = dim(cols, 20), r = dim(rows, 4);
    if (c === this.term.cols && r === this.term.rows) return;
    try { this.term.resize(c, r); this._seq++; } catch {}
  }

  /** Every write so far parsed. */
  settle(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 200);
      this.term.write("", () => { clearTimeout(t); resolve(); });
    });
  }

  snapshot(): Screen {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return { seq: this._seq, cols: this.term.cols, rows: this.term.rows, lines };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { this.term.dispose(); } catch {}
  }
}

const dim = (n: number, min: number) => Math.max(min, n | 0);
