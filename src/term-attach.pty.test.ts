/**
 * (Re)attaching to a terminal through a REAL pty: a fake `claude` paints Ink-style frames (?2026, the
 * live region erased with CUU/EL and redrawn under each new line, a burst now and then the pty cuts
 * into chunks), and four sockets come and go while it does — one from the start, one mid-stream, a
 * laggard cut off and resynced, and a pane that dropped frames while hidden and asked for a refresh.
 * Each must end holding exactly the terminal the first one holds, and the CLI must never be sent a
 * SIGWINCH: a local terminal's frame comes from the daemon's mirror, not from a forced repaint.
 * The mid-stream one attaches while the stream holds state a snapshot can't carry (G1 designated as
 * line drawing — invisible here), so its snapshot waits through retries while output keeps flowing.
 *
 * The CLI is a tiny node script in a tmp dir, pointed at through CHRONOS_CLAUDE_BIN, which config.ts
 * reads at import — so every module is imported dynamically AFTER the env is set (same as
 * terminal-failover.pty.test.ts). No token is spent and nothing reaches ~/.claude (tmp config_dir).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-attach-"));
const log = path.join(tmp, "claude.log");
const cwd = path.join(tmp, "repo");
fs.mkdirSync(cwd);
const TICKS = 150;

fs.writeFileSync(path.join(tmp, "claude"), `#!${process.execPath}
const fs = require("fs");
if (process.argv.includes("-p")) process.exit(0); // exit digest / title one-shots: answer nothing
process.on("SIGWINCH", () => fs.appendFileSync(${JSON.stringify(log)}, "winch\\n"));
process.stdin.setRawMode(true);
// ^B / ^E from the test: designate G1 as line drawing (a state the mirror won't snapshot) / undo it.
process.stdin.on("data", (d) => {
  if (d.includes(2)) { w("\\x1b)0"); fs.appendFileSync(${JSON.stringify(log)}, "g1\\n"); }
  if (d.includes(5)) w("\\x1b)B");
});
const w = (s) => process.stdout.write(s);
w("\\x1b[?2004h\\x1b[?1004h\\x1b]0;fake claude\\x07");
let n = 0, live = 0;
const tick = () => {
  n++;
  let f = "\\x1b[?2026h\\x1b[?25l";
  if (live) f += "\\x1b[2K\\x1b[1A".repeat(live - 1) + "\\x1b[2K\\x1b[G";
  f += "\\x1b[38;5;" + (n % 256) + "mtick " + n + "\\x1b[39m \\x1b[2m" + "·".repeat(n % 50) + "\\x1b[22;1m!\\x1b[22m\\r\\n";
  if (n % 15 === 0) f += ("\\x1b[33m" + "a burst the pty cuts up ".repeat(10) + "\\x1b[39m\\r\\n").repeat(6);
  f += "\\x1b[31m✻\\x1b[39m \\x1b[2mworking " + n + "\\x1b[22m\\r\\n> ";
  live = 2;
  f += "\\x1b[?25h\\x1b[?2026l";
  w(f);
  if (n < ${TICKS}) setTimeout(tick, 4);
  else fs.appendFileSync(${JSON.stringify(log)}, "done\\n");
};
setTimeout(tick, 400);
`, { mode: 0o755 });
process.env.CHRONOS_CLAUDE_BIN = path.join(tmp, "claude");

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
async function until(what: string, fn: () => boolean, ms = 25_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}\nclaude log:\n${read(log)}`);
}
const parsed = (t: HeadlessTerminal, d: string) => new Promise<void>((r) => t.write(d, r));

/** What attach() needs of a WebSocket, writing every frame into its own xterm — a pane. */
function pane() {
  const term = new Terminal({ cols: 100, rows: 30, scrollback: 2000, allowProposedApi: true });
  const s = {
    readyState: 1, bufferedAmount: 0, frames: [] as string[], term, hidden: false, firstAt: 0,
    send(d: string) { s.firstAt ||= Date.now(); s.frames.push(d); if (!s.hidden) term.write(d); },
    on() {},
  };
  return s;
}

// Cell for cell, both buffers, cursor, modes, and the three things off the public API (as in
// term-screen.test.ts, which covers the snapshot itself in depth).
function differs(a: HeadlessTerminal, b: HeadlessTerminal): string | null {
  if (a.buffer.active.type !== b.buffer.active.type) return `active buffer ${a.buffer.active.type} vs ${b.buffer.active.type}`;
  for (const name of ["normal", "alternate"] as const) {
    const x = a.buffer[name], y = b.buffer[name];
    if (x.length !== y.length) return `${name}: ${x.length} lines vs ${y.length}`;
    if (x.cursorX !== y.cursorX || x.cursorY !== y.cursorY) return `${name}: cursor ${x.cursorX},${x.cursorY} vs ${y.cursorX},${y.cursorY}`;
    const cx = x.getNullCell(), cy = y.getNullCell();
    for (let row = 0; row < x.length; row++) {
      const lx = x.getLine(row)!, ly = y.getLine(row)!;
      if (lx.isWrapped !== ly.isWrapped) return `${name} row ${row}: wrapped`;
      for (let col = 0; col < a.cols; col++) {
        const p = lx.getCell(col, cx)!, q = ly.getCell(col, cy)!;
        const sig = (c: typeof p) => [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), !!c.isBold(), !!c.isDim()].join("|");
        if (sig(p) !== sig(q)) return `${name} (${col},${row}): ${sig(p)} vs ${sig(q)}`;
      }
    }
  }
  if (JSON.stringify(a.modes) !== JSON.stringify(b.modes)) return `modes ${JSON.stringify(a.modes)} vs ${JSON.stringify(b.modes)}`;
  const hidden = (t: HeadlessTerminal) => (t as any)._core.coreService.isCursorHidden;
  return hidden(a) === hidden(b) ? null : "cursor visibility";
}

test("every way a pane (re)attaches ends on the exact terminal, and the CLI is never made to repaint", { timeout: 60_000 }, async () => {
  const { workspaces, sessions } = await import("./store.js");
  const { openSession, attach, refreshClient, sessionScreen, killSession, writeTo } = await import("./terminal.js");

  const ws = workspaces.create({ slug: "attach-pty", name: "Attach", config_dir: path.join(tmp, "profile"), sandbox_mode: "off" } as any);
  const s = await openSession({ workspace_id: ws.id, backend: "claude-code", model: "fable", cwd, goal: "paint frames", role: "human", cols: 100, rows: 30 });
  const tickNow = () => Math.max(0, ...(sessionScreen(s.id)?.lines ?? []).map((l) => Number(/tick (\d+)/.exec(l)?.[1] ?? 0)));

  const first = pane(), mid = pane(), laggard = pane(), hidden = pane();
  try {
    assert.equal(attach(s.id, first as any), true);
    await until("the first frames", () => tickNow() >= 5);
    attach(s.id, hidden as any);
    attach(s.id, laggard as any);
    laggard.bufferedAmount = 2_000_000; // its socket stops draining: cut off past LAG_HIGH
    await until("tick 30", () => tickNow() >= 30);
    hidden.hidden = true; // the Desk drops frames for a pane in a background tab
    writeTo(s.id, "\x02");
    await until("G1 designated", () => /g1/.test(read(log)));
    await new Promise((r) => setTimeout(r, 30)); // let it reach the mirror
    const midAt = Date.now();
    attach(s.id, mid as any);
    await new Promise((r) => setTimeout(r, 45)); // a retry or two, with flushes going out meanwhile
    assert.equal(mid.frames.length, 0, "held: nothing before its snapshot");
    writeTo(s.id, "\x05");
    await until("the held pane's snapshot", () => mid.frames.length > 0);
    assert.ok(mid.firstAt - midAt >= 45, "it waited for the stream to come back to rest");
    await until("tick 60", () => tickNow() >= 60);
    laggard.bufferedAmount = 0; // drained: resynced on the next flush
    await until("tick 90", () => tickNow() >= 90);
    hidden.hidden = false; // back in front: reset and ask for the terminal again
    hidden.term.reset();
    refreshClient(s.id, hidden as any);
    await until("the CLI to finish painting", () => /done/.test(read(log)));
    await new Promise((r) => setTimeout(r, 300)); // last flush out of the daemon
    for (const p of [first, mid, laggard, hidden]) await parsed(p.term, "");

    // Every catch-up was a snapshot (RIS first), never the raw tail.
    const catchUps = (p: ReturnType<typeof pane>) => p.frames.filter((f) => f.startsWith("\x1bc")).length;
    assert.equal(catchUps(first), 1);
    assert.equal(catchUps(mid), 1);
    assert.equal(catchUps(laggard), 2, "attach, then the resync once it drained");
    assert.equal(catchUps(hidden), 2, "attach, then the refresh");
    assert.equal(read(log).includes("winch"), false, "no SIGWINCH jiggle reached the CLI");

    // The first pane saw every byte; each line of the run is there once, in order.
    const text: string[] = [];
    for (let i = 0; i < first.term.buffer.normal.length; i++) text.push(first.term.buffer.normal.getLine(i)!.translateToString(true));
    const ticks = text.flatMap((l) => /^tick (\d+)/.exec(l)?.[1] ?? []).map(Number);
    assert.deepEqual(ticks, Array.from({ length: TICKS }, (_, i) => i + 1));
    for (const [name, p] of [["mid-stream", mid], ["laggard", laggard], ["refreshed", hidden]] as const) {
      assert.equal(differs(first.term, p.term), null, name);
    }
  } finally {
    // Close the panes first: a socket left "open" and lagging keeps its terminal's pace tick alive.
    for (const p of [first, mid, laggard, hidden]) p.readyState = 3;
    for (const row of sessions.list({ status: "live" })) killSession(row.id);
    await new Promise((r) => setTimeout(r, 2500)); // let focus tails and pty exits wind down
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
