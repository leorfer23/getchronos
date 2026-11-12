/**
 * The optional upgrades (src/setup-optional.ts) and what a plain Mac gets without them — asked of the
 * running API: the list is operator-only, and the mic on a Mac that never installed whisper answers
 * with the command that installs it, once in the log.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
// A plain Mac: an empty home (no whisper model, no launchd agents, no grok login), and every local
// voice engine on a port nothing listens on.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "setup-optional-home-"));
process.env.HOME = HOME;
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_WHISPER_PORT = String(await freePort());
process.env.CHRONOS_WHISPER_FINAL_PORT = String(await freePort());
process.env.CHRONOS_TTS_URL = `http://127.0.0.1:${await freePort()}`;
delete process.env.CHRONOS_TRANSCRIBE_URL;
delete process.env.CHRONOS_TRANSCRIBE_FINAL_URL;

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { workspaces } = await import("./store.js");
const { optionalUpgrades } = await import("./setup-optional.js");
const { resetNotSetUp } = await import("./transcribe.js");
const { HEARING_NOT_SET_UP, WHISPER_INSTALL } = await import("./voice-setup.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); fs.rmSync(HOME, { recursive: true, force: true }); });

type Facts = Parameters<typeof optionalUpgrades>[0];
const bare: Facts = {
  appleSilicon: true, voice: "missing", uv: false, hearing: "missing", hearingFinal: "missing", cloudKey: false, finalEngine: "accurate",
  telegram: false, desktopNotify: true, phone: false, calendars: 0, failoverChain: ["grok", "cursor"], failoverReady: [],
  gh: "missing", fff: false, rtk: false, browser: false, logDir: "/Users/operator/getchronos", phoneGuide: false,
};
const byId = (f: Facts) => Object.fromEntries(optionalUpgrades(f).map((i) => [i.id, i]));

test("a plain Mac: every item says what stands in for it and the one thing that turns it on — never a key", () => {
  const items = optionalUpgrades(bare);
  for (const i of items) {
    assert.ok(i.id && i.label && i.why && i.how, `${i.id} is complete`);
    assert.ok(["on", "off", "default"].includes(i.status), i.id);
    if (i.status === "default") assert.ok(i.default, `${i.id} names its free default`);
  }
  const m = byId(bare);
  assert.equal(m.voice.status, "default", "Robert speaks with say out of the box");
  assert.match(m.voice.default!, /macOS say/);
  assert.match(m.voice.how, /brew install uv.*install-tts\.sh/);
  assert.equal(m.hearing.status, "off");
  assert.match(m.hearing.how, /bash scripts\/install-whisper\.sh$/);
  assert.equal(m["hearing-accurate"].status, "off", "no fast engine either: nothing covers it");
  assert.equal(m["hearing-cloud"].status, "off");
  assert.match(m["hearing-cloud"].how, /ELEVENLABS_API_KEY=… in \.secrets/);
  assert.equal(m.telegram.status, "default");
  assert.equal(m.phone.status, "off");
  assert.match(m.phone.how, /CONFIGURATION\.md §4/);
  assert.equal(m.calendar.status, "off");
  assert.equal(m.failover.status, "off");
  assert.match(m.failover.how, /now: grok, cursor/);
  assert.equal(m.github.how, "brew install gh && gh auth login");
  assert.equal(JSON.stringify(items).includes("sk-"), false);
});

test("what is installed reads as on, and the free default steps in where it should", () => {
  const m = byId({
    ...bare, voice: "up", hearing: "up", hearingFinal: "missing", cloudKey: true, finalEngine: "accurate", telegram: true, phone: true,
    calendars: 2, failoverReady: ["codex"], failoverChain: ["grok", "codex"], gh: "logged-out", fff: true, rtk: true, browser: true, phoneGuide: true,
  });
  assert.equal(m.voice.status, "on");
  assert.equal(m.hearing.status, "on");
  assert.equal(m["hearing-accurate"].status, "default", "the small model hears whole sentences too");
  assert.equal(m["hearing-cloud"].status, "default", "key present, engine not switched: local whisper is in use");
  assert.match(m["hearing-cloud"].note!, /key is set/);
  assert.equal(m["hearing-cloud"].how, "⚙ Settings → Voice → Engine for what you said: cloud");
  assert.equal(m.telegram.status, "on");
  assert.equal(m.phone.status, "on");
  assert.match(m.phone.how, /docs\/guide\/phone\.md/);
  assert.equal(m.calendar.status, "on");
  assert.equal(m.failover.status, "on");
  assert.equal(m.failover.note, "ready: codex");
  assert.equal(m.github.status, "off");
  assert.equal(m.github.how, "gh auth login");
  assert.equal(byId({ ...bare, hearing: "down" }).hearing.note, "installed but not answering — see /Users/operator/getchronos/whisper.err.log");
  assert.match(byId({ ...bare, appleSilicon: false }).voice.how, /Apple Silicon/);
  assert.equal(byId({ ...bare, cloudKey: true, finalEngine: "cloud", hearing: "up" })["hearing-cloud"].status, "on");
});

test("GET /api/setup/optional is the operator's: a workspace token or none is refused; the answer is live for this Mac", async () => {
  const ws = workspaces.create({ slug: `so-${Date.now()}`, name: "Acme", config_dir: path.join(HOME, ".claude-acme") } as any);
  for (const h of [{ "x-mc-workspace-token": workspaces.get(ws.id)!.token! }, {}]) {
    const r = await fetch(`${base}/setup/optional`, { headers: h as Record<string, string> });
    assert.ok(r.status === 401 || r.status === 403, `refused: ${r.status}`);
  }
  const r = await fetch(`${base}/setup/optional`, { headers: { "x-mc-admin": CONFIG.adminToken } });
  assert.equal(r.status, 200);
  const j = await r.json();
  const m = Object.fromEntries(j.items.map((i: any) => [i.id, i]));
  assert.deepEqual(Object.keys(m).sort(), ["browser", "calendar", "failover", "fff", "github", "hearing", "hearing-accurate", "hearing-cloud", "phone", "rtk", "telegram", "voice"]);
  assert.equal(m.hearing.status, "off", "nothing listens on the whisper port and nothing is installed in this home");
  assert.equal(m.voice.status, "default");
  assert.equal(m.calendar.status, "off");
  assert.equal(m.failover.status, "off", "the test grok has no login here and cursor has no key");
  assert.equal(j.summary.total, 12);
});

test("the mic on a Mac without whisper: 501 with the command, the same for partials, one log line in all", async () => {
  resetNotSetUp();
  const n = 16 * 3000, wav = Buffer.alloc(44 + n * 2);
  wav.write("RIFF", 0, "latin1"); wav.writeUInt32LE(36 + n * 2, 4); wav.write("WAVEfmt ", 8, "latin1"); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36, "latin1"); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(i / 8) * 3000), 44 + i * 2);
  const lines: string[] = [];
  const warn = console.warn, error = console.error;
  console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    for (const q of ["lang=en", "lang=es", "partial=1&lang=en"]) {
      const r = await fetch(`${base}/transcribe?${q}`, { method: "POST", headers: { "x-mc-admin": CONFIG.adminToken, "content-type": "audio/wav" }, body: wav });
      assert.equal(r.status, 501, q);
      assert.deepEqual(await r.json(), { error: HEARING_NOT_SET_UP, setup: WHISPER_INSTALL });
    }
  } finally {
    console.warn = warn;
    console.error = error;
  }
  const said = lines.filter((l) => /transcribe/.test(l));
  assert.equal(said.length, 1, `one line, not one per press: ${JSON.stringify(said)}`);
  assert.match(said[0], /speech-to-text is not set up on this Mac .* bash scripts\/install-whisper\.sh/);
});
