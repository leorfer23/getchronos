/**
 * The seed through a REAL pty into a CLI that is late to take input (2026-09-25: two of seven claude
 * workers a Lead opened at once kept only the tail of their brief). The fake sits silent in cooked
 * mode for a while, the way a claude on a loaded machine does mid-boot, then goes raw, turns
 * bracketed paste on and reads its prompt. Silence alone would type into the cooked tty, which keeps
 * 1024 bytes and loses them on the switch; the seed must wait for the input box and arrive whole.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pty from "node-pty";
import { ModeTracker } from "./term-modes.js";
import { typeSeed } from "./term-seed.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-seed-"));

function fakeCli(bootMs: number, log: string): string {
  const file = path.join(tmp, `cli-${bootMs}.js`);
  fs.writeFileSync(file, `
const fs = require("fs");
setTimeout(() => {
  process.stdin.setRawMode(true);
  process.stdout.write("\\x1b[?2004h> ");
  let got = "";
  process.stdin.on("data", (d) => {
    got += d;
    if (got.endsWith("\\r")) { fs.writeFileSync(${JSON.stringify(log)}, got); process.stdout.write("\\r\\nok\\r\\n"); setTimeout(() => process.exit(0), 50); }
  });
}, ${bootMs});
`);
  return file;
}

function run(backend: string, seed: string, bootMs: number): Promise<string> {
  const log = path.join(tmp, `${backend}-${bootMs}.log`);
  const term = pty.spawn(process.execPath, [fakeCli(bootMs, log)], { cols: 100, rows: 30, cwd: tmp, env: process.env as Record<string, string> });
  const modes = new ModeTracker();
  let lastOut = Date.now();
  let exited = false;
  term.onData((d) => { lastOut = Date.now(); modes.feed(d); });
  typeSeed({ write: (d) => term.write(d), lastOut: () => lastOut, modes, gone: () => exited }, seed, backend, { minMs: 100, quietMs: 150, maxMs: 8000, tickMs: 25 });
  return new Promise((resolve) => {
    const kill = setTimeout(() => term.kill(), 10_000);
    term.onExit(() => { exited = true; clearTimeout(kill); resolve(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""); });
  });
}

const seed = Array.from({ length: 40 }, (_, i) => `step ${i}: read the brief, then the real task.`).join("\n");

test("a seed waits for a late CLI's input box and arrives whole, as one paste then Enter", async () => {
  assert.ok(seed.length > 1500);
  const got = await run("claude-code", seed, 1200);
  assert.equal(got, `\x1b[200~${seed.replace(/\n/g, " ")}\x1b[201~\r`);
});

test("a CLI not known to announce its input is seeded on silence alone", async () => {
  const got = await run("cursor-agent", "short task", 0);
  assert.equal(got.replace(/\x1b\[20[01]~/g, ""), "short task\r");
});
