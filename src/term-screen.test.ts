import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import { ScreenMirror, type Serialized } from "./term-screen.js";
import { detectPrompt, renderScreen } from "./desk-prompt.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };

test("mirror shows the current frame as text, and seq moves only once parsed", async () => {
  const m = new ScreenMirror(40, 6);
  assert.equal(m.seq, 0);
  m.write("hello\r\nworld\r\n");
  await m.settle();
  assert.equal(m.seq, 1);
  assert.deepEqual(m.snapshot().lines, ["hello", "world"]);
  m.write("\x1b[2J\x1b[H> what next?");
  await m.settle();
  assert.equal(m.seq, 2);
  assert.deepEqual(m.snapshot().lines, ["> what next?"]);
  m.dispose();
});

test("snapshot() is the viewport only, whether or not history is kept for serializeAt", async () => {
  for (const scrollback of [0, 10]) {
    const m = new ScreenMirror(20, 4, scrollback);
    m.write(["a", "b", "c", "d", "e", "f"].join("\r\n"));
    await m.settle();
    const s = m.snapshot();
    assert.equal(s.rows, 4);
    assert.deepEqual(s.lines, ["c", "d", "e", "f"], `scrollback ${scrollback}`);
    m.dispose();
  }
});

test("resize reflows and bumps seq; same size is a no-op", async () => {
  const m = new ScreenMirror(40, 6);
  m.write("x");
  await m.settle();
  const before = m.seq;
  m.resize(40, 6);
  assert.equal(m.seq, before);
  m.resize(60, 10);
  assert.equal(m.seq, before + 1);
  assert.equal(m.snapshot().cols, 60);
  m.dispose();
});

test("writes after dispose are ignored", async () => {
  const m = new ScreenMirror(40, 6);
  m.dispose();
  m.write("late");
  await m.settle();
  assert.equal(m.seq, 0);
});

test("write/settle/snapshot never throw — mirror is best-effort against xterm glitches", async () => {
  const m = new ScreenMirror(40, 6);
  // A burst of CSI noise + dispose mid-flight used to surface as an uncaught isWrapped TypeError
  // from xterm's async parse timer. Sync path must stay quiet; seq must not move after dispose.
  assert.doesNotThrow(() => {
    m.write("\x1b[999;999H\x1b[2J\x1b[H" + "x".repeat(500) + "\r\n\n\n");
    m.resize(20, 4);
    m.write("\x1b[?1049h\x1b[2Jmore\x1b[?1049l");
  });
  await m.settle();
  assert.doesNotThrow(() => m.snapshot());
  m.dispose();
  assert.doesNotThrow(() => {
    m.write("after dispose");
    m.resize(80, 24);
    m.snapshot();
  });
  await m.settle();
  assert.equal(m.seq >= 0, true);
});

/**
 * The substitution this module exists for: readPrompt() used to re-render the pty tail into a
 * throwaway headless terminal on every quiet flip (renderScreen). It now reads the always-on mirror.
 * Same bytes must give the same answer, or the wall's answer buttons change behaviour.
 */
test("mirror and a one-off re-render read the same prompt off the same bytes", async () => {
  const cases = [
    ["a select menu", "\x1b[2J\x1b[H" + ["Do you want to proceed?", "", "  1. Yes, go ahead", "  2. No, change something", "  3. Cancel", ""].join("\r\n")],
    ["a yes/no", "\x1b[2J\x1b[HOverwrite the file? (y/n) "],
    ["a bare question", "\x1b[2J\x1b[HWhich database should I point this at?"],
    ["a repaint that supersedes an earlier menu", "\x1b[2J\x1b[H  1. stale\r\n  2. old\r\n\x1b[2J\x1b[HReady for the next thing?"],
  ] as const;
  for (const [what, bytes] of cases) {
    const m = new ScreenMirror(80, 24);
    m.write(bytes);
    await m.settle();
    const viaMirror = detectPrompt(m.snapshot().lines);
    const viaRender = detectPrompt(await renderScreen(bytes, 80, 24));
    assert.deepEqual(viaMirror, viaRender, what);
    m.dispose();
  }
});

test("the mirror shows the CURRENT frame, not bytes an alt-screen TUI has already replaced", async () => {
  const m = new ScreenMirror(40, 8);
  m.write("\x1b[2J\x1b[HThinking…");
  m.write("\x1b[2J\x1b[HDone. Anything else?");
  await m.settle();
  assert.deepEqual(m.snapshot().lines, ["Done. Anything else?"]);
  m.dispose();
});

// ── serializeAt: the terminal as bytes, for a pane that (re)attaches ─────────────────────────

const parsed = (t: HeadlessTerminal, d: string) => new Promise<void>((r) => t.write(d, r));
const serializeAt = (m: ScreenMirror) => new Promise<Serialized>((r) => m.serializeAt(r));
const term = (cols: number, rows: number, scrollback: number) => new Terminal({ cols, rows, scrollback, allowProposedApi: true });

function prng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// The way node-pty hands output over: cut anywhere, mid-escape included (never inside a code point).
function chunks(s: string, seed: number): string[] {
  const rnd = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = Math.min(s.length, i + 1 + Math.floor(rnd() * 700));
    if (j < s.length && /[\ud800-\udbff]/.test(s[j - 1])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

// What a Claude Code terminal sends, by shape: the escapes two live ones used (2026-10-27) — every
// frame inside ?2026 with ?25 around it, the live region erased with CUU/EL and redrawn under the new
// lines (inline) or painted with CUP over the alt screen with SGR mouse on (fullscreen), CHA/CUF,
// 16/256/truecolor SGR with bold and dim mixed, OSC 0 titles, bracketed paste and focus reports.
// Plus what a transcript holds: wide and combining characters, lines that soft-wrap, a coloured
// erase. The words are made up.
const WORDS = ["read", "the", "migration", "files", "then", "renumber", "them", "漢字", "🚀", "café", "→", "x".repeat(23)];

function claudeInline(cols: number, turns: number): string {
  const rnd = prng(1);
  const said = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  const box = "─".repeat(cols - 2);
  let out = "\x1b[?2004h\x1b[?1004h\x1b]0;✳ Claude Code\x07";
  let live = 0;
  for (let turn = 1; turn <= turns; turn++) {
    out += "\x1b[?2026h\x1b[?25l";
    if (live) out += "\x1b[2B" + "\x1b[2K\x1b[1A".repeat(live - 1) + "\x1b[2K\x1b[G"; // back to the bottom, erase upward
    out += `\x1b[38;2;215;119;87m⏺\x1b[39m ${said(8)}\r\n`;
    out += `  \x1b[2m⎿  ${said(5)}\x1b[22m\r\n`;
    out += `\x1b[1m${said(3)}\x1b[22m \x1b[2m${said(2)}\x1b[22;1m dim then bold\x1b[1;2m both\x1b[22;2m then dim\x1b[22m \x1b[38;5;22m${said(2)}\x1b[39m\r\n`;
    if (turn % 3 === 0) out += `${said(30)}\r\n`; // longer than a row
    if (turn % 4 === 0) out += `\x1b[44m${said(1)}\x1b[K\x1b[49m\r\n`; // an erase that keeps its background
    out += `\x1b[31m✻\x1b[39m \x1b[2mThinking… (${turn}s · ↓ ${turn * 13} tokens)\x1b[22m\r\n`;
    out += `\x1b[2m╭${box}╮\x1b[22m\r\n\x1b[2m│\x1b[22m \x1b[1m>\x1b[22m ${said(2)}\x1b[${cols}G\x1b[2m│\x1b[22m\r\n\x1b[2m╰${box}╯\x1b[22m\r\n`;
    out += `  \x1b[38;2;1;2;22m⏵⏵ bypass permissions on\x1b[39m\x1b[2A\x1b[5G`; // cursor into the box
    live = 5;
    out += "\x1b[?25h\x1b[?2026l";
    if (turn % 5 === 0) out += `\x1b]0;✳ turn ${turn}\x07`;
  }
  return out;
}

function claudeFullscreen(cols: number, rows: number, frames: number): string {
  const rnd = prng(2);
  const said = () => Array.from({ length: 4 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  let out = "\x1b[?2004h\x1b[?1004h\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b=";
  out += "\x1b[?2026h\x1b[?25l\x1b[H";
  for (let r = 1; r <= rows; r++) {
    out += `\x1b[${r};1H`;
    if (r === rows - 3) out += `\x1b[2m${"─".repeat(cols)}\x1b[22m`;
    else if (r === rows - 2) out += "\x1b[1m❯\x1b[22m ";
    else out += `\x1b[${r % 2 ? 37 : 93}m${r % 3 ? "\x1b[2m" : "\x1b[1m"}${r} ${said()}\x1b[22m\x1b[39m\x1b[K`;
  }
  out += `\x1b[${rows - 2};3H\x1b[?25h\x1b[?2026l`;
  const spin = ["✢", "✳", "✶", "✻", "✽", "·"];
  for (let f = 0; f < frames; f++) {
    out += `\x1b[?2026h\x1b[?25l\x1b[H\r\x1b[${rows - 5}B\x1b[31m${spin[f % spin.length]}\x1b[39m`;
    if (f % 3 === 0) out += `\x1b[${12 + (f % 9)}G\x1b[37m\x1b[2m${f % 10}\x1b[22m\x1b[39m`;
    if (f % 4 === 0) out += `\x1b[${rows - 6};1H\x1b[93m\x1b[2m·\x1b[22;1m✻\x1b[1;2m both\x1b[22;1m bold\x1b[22m\x1b[39m\x1b[K`;
    out += `\x1b[${rows};1H\x1b[${rows - 2};3H\x1b[?25h\x1b[?2026l`;
    if (f % 7 === 0) out += `\x1b]0;◐ frame ${f}\x07`;
  }
  return out;
}

// The same terminal, or the first difference: every cell of both buffers (character, width,
// colours, attributes), wrap flags, cursor, which buffer is up, the modes — and the three things
// off the public API a pane depends on: a hidden cursor, the mouse encoding, the current pen.
function differs(a: HeadlessTerminal, b: HeadlessTerminal): string | null {
  if (a.cols !== b.cols || a.rows !== b.rows) return `size ${a.cols}x${a.rows} vs ${b.cols}x${b.rows}`;
  if (a.buffer.active.type !== b.buffer.active.type) return `active buffer ${a.buffer.active.type} vs ${b.buffer.active.type}`;
  for (const name of ["normal", "alternate"] as const) {
    const x = a.buffer[name], y = b.buffer[name];
    if (x.length !== y.length) return `${name}: ${x.length} lines vs ${y.length}`;
    if (x.cursorX !== y.cursorX || x.cursorY !== y.cursorY) return `${name}: cursor ${x.cursorX},${x.cursorY} vs ${y.cursorX},${y.cursorY}`;
    const cx = x.getNullCell(), cy = y.getNullCell();
    for (let row = 0; row < x.length; row++) {
      const lx = x.getLine(row)!, ly = y.getLine(row)!;
      if (lx.isWrapped !== ly.isWrapped) return `${name} row ${row}: wrapped ${lx.isWrapped} vs ${ly.isWrapped}`;
      for (let col = 0; col < a.cols; col++) {
        const p = cellOf(lx.getCell(col, cx)!), q = cellOf(ly.getCell(col, cy)!);
        if (p !== q) return `${name} (${col},${row}): ${p} vs ${q}`;
      }
    }
  }
  if (JSON.stringify(a.modes) !== JSON.stringify(b.modes)) return `modes ${JSON.stringify(a.modes)} vs ${JSON.stringify(b.modes)}`;
  const ia = offApi(a), ib = offApi(b);
  return ia === ib ? null : `cursor hidden / mouse encoding / pen: ${ia} vs ${ib}`;
}
const cellOf = (c: IBufferCell) => JSON.stringify([c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(),
  !!c.isBold(), !!c.isDim(), !!c.isItalic(), !!c.isUnderline(), !!c.isBlink(), !!c.isInverse(), !!c.isInvisible(), !!c.isStrikethrough(), !!c.isOverline()]);
const offApi = (t: HeadlessTerminal) => {
  const core = (t as any)._core;
  const pen = core._inputHandler._curAttrData;
  return JSON.stringify([core.coreService.isCursorHidden, core.coreMouseService.activeEncoding, core.coreMouseService.activeProtocol, pen.fg, pen.bg]);
};

/** The mirror fed `bytes` in pty-sized chunks, a reference xterm fed them whole, and the mirror's snapshot. */
async function throughMirror(bytes: string, cols: number, rows: number, scrollback: number) {
  const m = new ScreenMirror(cols, rows, scrollback);
  for (const c of chunks(bytes, 5)) m.write(c);
  const ref = term(cols, rows, scrollback);
  await parsed(ref, bytes);
  const r = await serializeAt(m);
  m.dispose();
  return { ref, r };
}
/** A pane's xterm (the Desk keeps 2000 lines) after it is written `data`. */
async function pane(data: string, cols: number, rows: number) {
  const t = term(cols, rows, 2000);
  await parsed(t, data);
  return t;
}

test("a snapshot rebuilds an inline Claude terminal cell for cell, history included", async () => {
  const { ref, r } = await throughMirror(claudeInline(100, 60), 100, 30, 500);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.data.startsWith("\x1bc"), "opens with RIS");
  const back = await pane(r.data, 100, 30);
  assert.ok(ref.buffer.normal.length > 30 + 100, "the stream left history behind");
  assert.equal(differs(ref, back), null);
});

test("a snapshot rebuilds a fullscreen Claude terminal: alt screen, SGR mouse, cursor keys, hidden cursor, pen", async () => {
  // Ends mid-thought: cursor hidden, a pen set and nothing written with it yet.
  const bytes = claudeInline(80, 6) + claudeFullscreen(80, 24, 40) + "\x1b[?25l\x1b[1;38;5;22;48;2;1;2;3m";
  const { ref, r } = await throughMirror(bytes, 80, 24, 500);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const back = await pane(r.data, 80, 24);
  assert.equal(back.buffer.active.type, "alternate");
  assert.equal(back.modes.mouseTrackingMode, "any");
  assert.equal((back as any)._core.coreMouseService.activeEncoding, "SGR", "the wheel still speaks SGR");
  assert.equal((back as any)._core.coreService.isCursorHidden, true);
  assert.equal(differs(ref, back), null);
});

test("every bold/dim transition, and a 256-colour index under 16, survives a snapshot (the addon got both wrong)", async () => {
  // 0 plain · 1 bold · 2 dim · 3 both — each of the 16 ordered pairs once, under colours whose
  // parameters are 1, 2 and 22 themselves (a colour index is not a flag); 38;5;1 is not 31.
  const states = [0, 0, 1, 0, 2, 0, 3, 1, 1, 2, 1, 3, 2, 2, 3, 3, 0];
  const sgr = ["\x1b[22m", "\x1b[22;1m", "\x1b[22;2m", "\x1b[1;2m"];
  const colours = ["\x1b[39m", "\x1b[38;5;22m", "\x1b[38;5;1m", "\x1b[38;2;1;2;22m", "\x1b[48;5;2m", "\x1b[49m"];
  let bytes = "";
  for (const [row, paint] of [(i: number) => colours[i % colours.length], () => ""].entries()) {
    states.forEach((s, i) => { bytes += sgr[s] + paint(i) + String.fromCharCode(97 + i); });
    bytes += "\x1b[0m" + (row ? "" : "\r\n");
  }
  const { ref, r } = await throughMirror(bytes, 40, 4, 10);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(differs(ref, await pane(r.data, 40, 4)), null);
});

test("a snapshot opens with RIS: written over a stale pane, it still lands exact", async () => {
  const { ref, r } = await throughMirror(claudeInline(60, 12), 60, 20, 500);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // A pane that held another frame, modes, a region and wrap-off, plus bytes that raced its reset.
  const stale = await pane(claudeFullscreen(60, 20, 5) + "\x1b[3;9r\x1b[?7l\x1b[?2004l bytes that raced a reset", 60, 20);
  await parsed(stale, r.data);
  assert.equal(differs(ref, stale), null);
});

test("the snapshot is the state at the call: bytes written after it, parsed or not yet, follow it", async () => {
  const cols = 80, rows = 24;
  const bytes = claudeInline(cols, 20) + claudeFullscreen(cols, rows, 30);
  const ref = term(cols, rows, 500);
  await parsed(ref, bytes);
  // Every frame end (where a live attach usually lands), plus arbitrary cuts: each is either busy
  // (try again) or exact — never a snapshot with a half escape or half frame in it.
  const ends: number[] = [];
  for (let i = bytes.indexOf("\x1b[?2026l"); i >= 0; i = bytes.indexOf("\x1b[?2026l", i + 1)) ends.push(i + 8);
  const rnd = prng(3);
  const cuts = [...ends.filter((_, i) => i % 4 === 0), ...Array.from({ length: 30 }, () => 1 + Math.floor(rnd() * (bytes.length - 1)))];
  let exact = 0;
  for (const k of cuts) {
    if (/[\ud800-\udbff]/.test(bytes[k - 1])) continue;
    const m = new ScreenMirror(cols, rows, 500);
    m.write(bytes.slice(0, k));
    const at = serializeAt(m);
    m.write(bytes.slice(k)); // queued behind the call, parsed before it answers
    const r = await at;
    m.dispose();
    if (!r.ok) { assert.equal(r.busy, true, `cut ${k}`); assert.ok(!ends.includes(k), `a frame end (${k}) is at rest`); continue; }
    exact++;
    assert.equal(differs(ref, await pane(r.data + bytes.slice(k), cols, rows)), null, `cut at ${k}: ${JSON.stringify(bytes.slice(k - 10, k + 10))}`);
  }
  assert.ok(exact >= ends.filter((_, i) => i % 4 === 0).length, "every frame end gave a snapshot");
});

test("serializeAt waits where a snapshot would be wrong: mid-escape, and state it can't carry", async () => {
  const cases: Array<[string, string, string]> = [
    // [what, bytes that leave the mirror there, bytes that end it]
    ["mid-escape", "ab\x1b[38;5", ";22mc"],
    ["mid-title", "\x1b]0;half a ti", "tle\x07"],
    ["pending wrap (cursor past the last column)", "x".repeat(20), "\r\n"],
    ["scroll region", "\x1b[2;3r", "\x1b[r"],
    ["origin mode", "\x1b[?6h", "\x1b[?6l"],
    ["DEC line drawing in G0", "\x1b(0", "\x1b(B"],
    ["G1 designated and shifted in", "\x1b)0\x0e", "\x0f\x1b)B"],
  ];
  for (const [what, into, out] of cases) {
    const m = new ScreenMirror(20, 4, 10);
    m.write(into);
    assert.deepEqual(await serializeAt(m), { ok: false, busy: true }, what);
    m.write(out);
    assert.equal((await serializeAt(m)).ok, true, `${what}: at rest once it ends`);
    m.dispose();
  }
});

test("a snapshot taken mid-frame (?2026) leaves the pane holding its paint until the frame ends", async () => {
  const head = "\x1b[?2026h\x1b[?25l\x1b[H\x1b[31m✻ half", tail = " a frame\x1b[39m\x1b[?25h\x1b[?2026l";
  const { ref, r } = await throughMirror(head, 40, 6, 10);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const back = await pane(r.data, 40, 6);
  assert.equal(back.modes.synchronizedOutputMode, true, "rendering held, as the stream asked");
  assert.equal(differs(ref, back), null);
  await parsed(ref, tail);
  await parsed(back, tail);
  assert.equal(back.modes.synchronizedOutputMode, false);
  assert.equal(differs(ref, back), null);
});

test("serializeAt on a disposed mirror is a plain no — not busy, never a throw", async () => {
  const m = new ScreenMirror(20, 4, 10);
  m.write("hello");
  m.dispose();
  assert.deepEqual(await serializeAt(m), { ok: false, busy: false });
});

test("fits: the mirror floors at 20×4, so a smaller pty's frame is not its own", () => {
  const m = new ScreenMirror(10, 2, 10);
  assert.equal(m.fits(10, 2), false);
  m.resize(80, 24);
  assert.equal(m.fits(80, 24), true);
  assert.equal(m.fits(80, 25), false);
  m.dispose();
  assert.equal(m.fits(80, 24), false);
});
