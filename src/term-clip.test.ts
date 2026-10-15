/**
 * Copying in a Desk terminal that runs on another computer reaches this Mac's clipboard. Claude Code on
 * m2 pbcopies onto m2 and emits OSC 52 for the terminal; the Desk must take the OSC 52.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessTerminal };
const ctx: any = { atob, TextDecoder, Uint8Array };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/term-clip.js"), "utf8"), ctx);
const TermClip = ctx.TermClip;

const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
const flush = () => new Promise((r) => setTimeout(r, 0));

async function pane(opts: Record<string, unknown>, bytes: string) {
  const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  const seen: { via: string | null; text: string }[] = [];
  TermClip.register(term, () => ({ ...opts, done: (via: string | null, text: string) => seen.push({ via, text }) }));
  await new Promise<void>((r) => term.write(bytes, r));
  await flush();
  return seen;
}

test("OSC 52 from claude lands on the browser clipboard, UTF-8 intact", async () => {
  const wrote: string[] = [];
  const seen = await pane({ clipboard: { writeText: async (t: string) => { wrote.push(t); } }, host: "localhost" }, osc52("│ ❯ ñandú"));
  assert.deepEqual(wrote, ["│ ❯ ñandú"]);
  assert.equal(seen[0].via, "browser");
});

test("WebKit refuses a gesture-less write → the brain's Desk goes through the daemon", async () => {
  const daemon: string[] = [];
  const opts = { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } }, host: "localhost", viaDaemon: async (t: string) => { daemon.push(t); } };
  const seen = await pane(opts, osc52("select * from t"));
  assert.deepEqual(daemon, ["select * from t"]);
  assert.equal(seen[0].via, "daemon");
});

test("a Desk opened from elsewhere (phone, tunnel) never writes the brain's clipboard", async () => {
  const daemon: string[] = [];
  const opts = { clipboard: { writeText: async () => { throw new Error("no"); } }, host: "desk.example.site", viaDaemon: async (t: string) => { daemon.push(t); } };
  const seen = await pane(opts, osc52("x"));
  assert.deepEqual(daemon, []);
  assert.equal(seen[0].via, null);
});

test("a clipboard READ query is refused and nothing is written", async () => {
  const wrote: string[] = [];
  const seen = await pane({ clipboard: { writeText: async (t: string) => { wrote.push(t); } }, host: "localhost" }, "\x1b]52;c;?\x07");
  assert.deepEqual(wrote, []);
  assert.deepEqual(seen, []);
});

test("desk.html loads term-clip.js and wires every pane through the daemon's /clipboard", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(html, /<script src="\/term-clip\.js"><\/script>/);
  assert.match(html, /TermClip\.register\(term,[\s\S]{0,300}api\("\/clipboard", \{ method: "POST"/);
});
