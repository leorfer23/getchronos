/**
 * The Desk voice call lives entirely in static/desk.html (no build step): mic → local whisper →
 * Robert → the Mac's Premium voice. These pin the wiring and run the two pure pieces for real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
const agent = fs.readFileSync(path.join(process.cwd(), "src/telegram/agent.ts"), "utf8");

const fn = (name: string) => {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return html.slice(at, html.indexOf("\n}\n", at) + 2);
};

test("a call is one button and ⌘⇧V, and hangs up the same way", () => {
  assert.match(html, /id="chat-voice"/);
  assert.match(html, /id="v-hang"/);
  assert.match(html, /e\.shiftKey && !e\.altKey && e\.key\.toLowerCase\(\) === "v"\) \{ e\.preventDefault\(\); return VC\.on \? vcStop\(\) : vcStart\(\); \}/);
});

test("what you say is an ordinary turn, flagged as voice", () => {
  assert.match(html, /queueAsk\(text, !!barge && OV\.busy, true\)/);
  assert.match(html, /if \(VC\.on\) body\.voice = true;/);
  assert.match(api, /\{ voice: !!req\.body\.voice, turn: turnId, focus: runWs \? null : ws \}/);
  assert.match(agent, /opts\?\.voice \? VOICE_TURN/);
});

test("only this page's turn is read out as it streams", () => {
  assert.match(api, /topic: "agent\.delta", text: t, kind, ws, client, turn: turnId/);
  assert.match(html, /e\.topic === "agent\.delta" && VC\.on && e\.client === CLIENT\) vcDelta\(e\)/);
  assert.match(html, /if \(VC\.on && e\.reply && \(fromHere \|\| !e\.you\)\) vcFinal\(e, fromHere\)/);
  assert.match(api, /api\.post\("\/speak", requireAdmin/);
});

test("speaking over him cuts him off: audio stops, the rest of his turn is not read, yours goes in now", () => {
  const frame = fn("vcFrame");
  assert.match(frame, /if \(!VC\.seg && vcSpeaking\(\)\)/);
  assert.match(frame, /VC\.bargeMs < VAD\.bargeMs\) return;/);
  assert.match(frame, /vcBargeIn\(\)/);
  assert.match(fn("vcBargeIn"), /VC\.muted = VC\.turn;\s+vcSkip\(true\);/);
  assert.match(fn("vcDelta"), /if \(e\.turn && e\.turn === VC\.muted\) return;/);
  assert.match(fn("vcHeard"), /queueAsk\(text, !!barge && OV\.busy, true\)/);
  assert.match(fn("vcAfterSpeech"), /if \(!barged\) VC\.deafUntil/);
});

test("a barge that is only his own words coming back is dropped", () => {
  const VC = { recent: [] as string[] };
  const vcNorm = (t: string) => " " + String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const vcEcho = new Function("VC", "vcNorm", fn("vcEcho") + "; return vcEcho;")(VC, vcNorm);
  VC.recent.push(vcNorm("I opened the loader fix terminal on atlas."));
  assert.equal(vcEcho("opened the loader fix terminal"), true);
  assert.equal(vcEcho("stop, open sports instead"), false);
  assert.equal(vcEcho("ok"), false);
});

test("his voice plays at the chosen speed with its pitch kept", () => {
  assert.match(fn("vcPlay"), /a\.defaultPlaybackRate = a\.playbackRate = VC\.speed/);
  assert.match(fn("vcPlay"), /a\.preservesPitch = a\.webkitPreservesPitch = true/);
  assert.match(html, /const SPEEDS = \[1, 1\.5, 2\];/);
  assert.match(html, /id="v-speed"/);
});

test("🎤 on a terminal types what you said into it with ⏎", () => {
  assert.match(html, /id="h-mic"/);
  assert.match(fn("dictStop"), /await answer\(id, \{ text, enter: true \}\)/);
  assert.match(fn("dictStop"), /vcWav\(r\.frames, r\.rate\)/);
  assert.match(fn("dictStart"), /if \(VC\.on\) VC\.deafUntil = Infinity;/);
  assert.match(html, /e\.key\.toLowerCase\(\) === "d"\) \{ e\.preventDefault\(\); return DICT\.rec \? dictStop\(\) :/);
});

test("vcWav writes 16kHz mono PCM whisper can read", async () => {
  const VC = { rate: 48000 };
  const vcWav = new Function("VC", fn("vcWav") + "; return vcWav;")(VC);
  const blob: Blob = vcWav([new Float32Array(48000).fill(0.5), new Float32Array(24000).fill(-0.5)]);
  const dict: Blob = vcWav([new Float32Array(44100).fill(0.5)], 44100);
  assert.equal(Buffer.from(await dict.arrayBuffer()).readUInt32LE(40), 16000 * 2);
  const b = Buffer.from(await blob.arrayBuffer());
  assert.equal(b.subarray(0, 4).toString(), "RIFF");
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.readUInt32LE(40), 24000 * 2);
  assert.ok(b.readInt16LE(44 + 100) > 16000 && b.readInt16LE(44 + 40000) < -16000);
});

test("speakable turns chat markdown into words", () => {
  const S = { sessions: [{ id: "abcd1234-0000-0000-0000-000000000000" }] };
  const VC = { lang: "en" };
  const speakable = new Function("S", "VC", "chipLabel", fn("speakable") + "; return speakable;")(S, VC, () => "the loader fix");
  assert.equal(speakable('**Done** — opened abcd1234.\nUI {"op":"select","id":"abcd1234"}'), "Done — opened the loader fix.");
  assert.equal(speakable("- atlas · 2 waiting\n- see https://x.y/z 🚀"), "atlas, 2 waiting see a link");
  assert.equal(speakable("```\ncode\n```ok"), "ok");
  assert.equal(speakable("Need your call.\n\n::ask 0123abcd-4567-89ab-cdef-0123456789ab::"), "Need your call.", "an Ask card is on screen, not read out");
});
