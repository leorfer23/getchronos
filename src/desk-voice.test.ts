/**
 * The Desk voice call lives in static/desk.html (no build step). Its two pure pieces — the WAV the
 * mic hands whisper, and what of a chat reply is read out — are lifted out of the page and run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

const fn = (name: string) => {
  const at = html.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  return html.slice(at, html.indexOf("\n}\n", at) + 2);
};

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

// ── hearing: the ear and the send path, lifted out of the page and run on synthetic frames ─────────

const konst = (name: string) => {
  const m = html.match(new RegExp(`^const ${name} = .*;$`, "m"));
  assert.ok(m, name);
  return m[0];
};
const RATE = 48000, N = 2048; // ~43 ms frames, as the ScriptProcessor hands them over
const msPer = (N / RATE) * 1000;
const frame = (amp: number, hz = 180) => { const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE); return f; };

/** The call's ear + send path with a scripted whisper, a clock the test moves, and the page around it stubbed. */
function call(lang = "es", langPicked = false) {
  const VC: any = { on: true, rate: RATE, seg: null, pre: [], preMs: 0, noise: 0.01, deafUntil: 0, holdUntil: 0, bargeMs: 0, sending: 0, chain: Promise.resolve(),
    flight: null, held: null, recent: [], partial: null, lang, langPicked, ctx: null };
  const osc = () => ({ type: "", frequency: { value: 0 }, connect: (x: any) => x, start() {}, stop() {} });
  const gain = () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: any) => x });
  VC.ctx = { currentTime: 0, destination: {}, createOscillator: osc, createGain: gain };
  const w: any = { now: 0, speaking: false, sent: [] as any[], pending: [] as any[], turns: [] as string[], did: [] as string[], barges: 0, beeps: [] as string[] };
  const env: Record<string, unknown> = {
    VC, OV: { busy: false }, performance: { now: () => w.now }, vOrb: { style: { setProperty() {} } },
    vcSpeaking: () => w.speaking, vcState() {}, vcPartial() {}, vcBargeIn: () => { w.barges++; }, toast() {},
    vcWav: (frames: Float32Array[]) => ({ ms: (frames.reduce((n, f) => n + f.length, 0) / RATE) * 1000 }),
    vcTranscribe: (wav: any, query: string) => new Promise((ok) => w.pending.push({ ms: wav.ms, query, answer: (text: string) => ok({ text }) })),
    vcStop: () => { w.did.push("hang-up"); }, vcSkip() {}, stopTurn: () => { w.did.push("stop"); }, vcPicked: () => false,
    queueAsk: (text: string) => { w.turns.push(text); },
  };
  const names = Object.keys(env);
  const body = [konst("VAD"), konst("JOIN"), konst("HANG_UP"), konst("STOP_TALKING"), konst("HEARD_NOISE"), konst("vcNorm"), konst("vcLangQ"),
    fn("earcon").replace("function earcon(kind) {", "function earcon(kind) { __beep(kind);"),
    fn("vcFrame"), fn("vcJoins"), fn("vcFlushHeld"), fn("vcSend"), fn("vcIsCommand"), fn("vcHeard"), fn("vcEcho"),
    "return { VAD, JOIN, vcFrame, vcSend, vcIsCommand, vcHeard, vcLangQ, earcon };"].join("\n");
  const page = new Function(...names, "__beep", body)(...names.map((k) => env[k]), (k: string) => w.beeps.push(k));
  const feed = (amp: number, ms: number) => { for (let n = 0; n < Math.ceil(ms / msPer); n++, w.now += msPer) page.vcFrame(frame(amp)); };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { VC, w, page, feed, tick };
}

test("a one-word answer said quietly reaches whisper, with no 'sent' beep; a knock does not; over Robert's voice the strict rule stays", async () => {
  // ~260 ms at RMS 0.035 (a 0.05 sine): above the level that opens a segment, under `speech` — before, loudMs 0 → dropped.
  const c = call();
  c.feed(0.002, 800); c.feed(0.05, 260); c.feed(0.002, 1200);
  await c.tick();
  assert.equal(c.w.pending.length, 1, "the word is sent to whisper");
  assert.deepEqual(c.w.beeps, [], "a sound kept only by the word rule plays no beep");
  c.w.pending[0].answer("Sí.");
  await c.tick();
  assert.deepEqual(c.w.turns, ["Sí."]);
  // A knock (~90 ms), loud or not, is still not speech.
  const k = call();
  k.feed(0.002, 800); k.feed(0.3, 90); k.feed(0.002, 1200);
  assert.equal(k.w.pending.length, 0);
  // A segment that ran over Robert's own voice never gets the lenient rule.
  const s = call();
  s.feed(0.002, 800); s.feed(0.05, 130); s.w.speaking = true; s.feed(0.05, 130); s.w.speaking = false; s.feed(0.002, 1200);
  await s.tick();
  assert.equal(s.w.pending.length, 0);
  // A sentence still beeps.
  const f = call();
  f.feed(0.002, 800); f.feed(0.2, 900); f.feed(0.002, 1200);
  assert.deepEqual(f.w.beeps, ["sent"]);
});

test("the 'sent' beep opens nothing but keeps the pre-roll: what you say right after a cut keeps its first syllable", async () => {
  const c = call();
  c.feed(0.002, 600); c.feed(0.2, 900); c.feed(0.002, 850); // a sentence, cut on silence → beep
  assert.deepEqual(c.w.beeps, ["sent"]);
  assert.ok(c.VC.holdUntil > c.w.now && c.VC.deafUntil <= c.w.now, "the beep holds the ear, it does not deafen it");
  c.feed(0.2, 150); // already talking inside the window
  assert.equal(c.VC.seg, null, "nothing opens inside the window");
  c.feed(0.2, 550);
  assert.ok(c.VC.seg, "it opens as soon as the window ends");
  // Everything said since the cut is in the open segment: the frames from inside the window ride as pre-roll.
  assert.ok(c.VC.seg.ms >= 700 - 2 * msPer, `the segment holds the whole utterance (${Math.round(c.VC.seg.ms)} ms)`);
});

test("a sentence cut by a breath is one turn: the second half joins a first half still being transcribed", async () => {
  const c = call();
  c.feed(0.002, 600); c.feed(0.2, 1500); c.feed(0.002, 850);
  await c.tick();
  assert.equal(c.w.pending.length, 1, "the first half went out at once — a complete sentence is never delayed");
  c.feed(0.002, 300); c.feed(0.2, 1000); // going on 300 ms after the cut
  c.w.pending[0].answer("revisame el deploy de");
  await c.tick();
  assert.deepEqual(c.w.turns, [], "the half is held: you are mid-sentence");
  c.feed(0.002, 850);
  await c.tick();
  assert.equal(c.w.pending.length, 2);
  assert.ok(c.w.pending[1].ms > c.w.pending[0].ms * 1.4, "the second request carries both halves as one clip");
  c.w.pending[1].answer("revisame el deploy de ayer porque se cuelga");
  await c.tick();
  assert.deepEqual(c.w.turns, ["revisame el deploy de ayer porque se cuelga"]);
});

test("…a first half still in flight is replaced by the joined clip; a held half whose second half never comes is the turn as it is", async () => {
  const c = call();
  c.page.vcSend([frame(0.2)], false, { t0: 0, t1: 2250, loudMs: 1400 });
  c.page.vcSend([frame(0.2), frame(0.2)], false, { t0: 2250 + 600, t1: 4600, loudMs: 900 });
  await c.tick();
  assert.equal(c.w.pending.length, 1, "the superseded first half is not transcribed at all");
  c.w.pending[0].answer("revisame el deploy de ayer");
  await c.tick();
  assert.deepEqual(c.w.turns, ["revisame el deploy de ayer"]);
  // Held, then only a noise the ear drops: delivered alone on the next frame.
  c.w.now = 10_000;
  c.page.vcSend([frame(0.2)], false, { t0: 7000, t1: 9900, loudMs: 1400 });
  await c.tick();
  c.VC.seg = { t0: 10_100, frames: [], ms: 0, loudMs: 0, voicedMs: 0, last: 10_100 };
  c.w.pending[1].answer("mergealo cuando termine el test");
  await c.tick();
  assert.equal(c.w.turns.length, 1);
  c.VC.seg = null;
  c.page.vcFrame(frame(0.0005));
  assert.deepEqual(c.w.turns.slice(1), ["mergealo cuando termine el test"]);
});

test("a short answer or a command is never held or swallowed by a join; past the window it is a new turn", async () => {
  const c = call();
  const talking = (t0: number) => { c.VC.seg = { t0, frames: [], ms: 0, loudMs: 0, voicedMs: 0, last: t0 }; };
  c.page.vcSend([frame(0.2)], false, { t0: 0, t1: 1150, loudMs: 300 });
  await c.tick();
  talking(1300);
  c.w.pending[0].answer("Pará.");
  await c.tick();
  assert.deepEqual(c.w.did, ["stop"], "a stop acts now, even while a sound has a segment open");
  c.page.vcSend([frame(0.2)], false, { t0: 3000, t1: 4250, loudMs: 400 });
  await c.tick();
  talking(4400);
  c.w.pending[1].answer("Sí, dale.");
  await c.tick();
  assert.deepEqual(c.w.turns, ["Sí, dale."]);
  c.VC.seg = null;
  // A short first clip still in flight is not folded into what follows: it may be a command.
  c.page.vcSend([frame(0.2)], false, { t0: 6000, t1: 7150, loudMs: 300 });
  c.page.vcSend([frame(0.2)], false, { t0: 7400, t1: 9650, loudMs: 1400 });
  await c.tick();
  c.w.pending[2].answer("No.");
  await c.tick();
  c.w.pending[3].answer("mejor mostrame el dashboard");
  await c.tick();
  assert.deepEqual(c.w.turns.slice(1), ["No.", "mejor mostrame el dashboard"]);
  // Past the join window: two turns. A barge never joins.
  c.page.vcSend([frame(0.2)], false, { t0: 20_000, t1: 22_250, loudMs: 1400 });
  c.page.vcSend([frame(0.2)], false, { t0: 22_250 + c.page.JOIN.ms + 100, t1: 26_000, loudMs: 1400 });
  c.page.vcSend([frame(0.2)], true, { t0: 26_300, t1: 28_000, loudMs: 1400 });
  for (const said of ["abrí una terminal nueva", "y después avisame", "no, esperá un momento"]) {
    await c.tick();
    c.w.pending[c.w.pending.length - 1].answer(said);
  }
  await c.tick();
  assert.equal(c.w.pending.length, 7, "all three were transcribed on their own");
  assert.deepEqual(c.w.turns.slice(3), ["abrí una terminal nueva", "y después avisame", "no, esperá un momento"]);
});

test("whisper's spellings of «colgá» hang up; a sentence that merely contains the word does not", () => {
  const c = call();
  for (const w of ["Colgá.", "¡Colgar!", "¡Colgada!", "Cortá", "colgalo", "Hang up."]) assert.equal(c.page.vcIsCommand(w), true, w);
  assert.equal(c.page.vcIsCommand("la app quedó colgada en el splash"), false);
  c.page.vcHeard("¡Colgada!", false);
  c.page.vcHeard("Basta.", false);
  c.page.vcHeard("la app quedó colgada en el splash", false);
  assert.deepEqual(c.w.did, ["hang-up", "stop"]);
  assert.deepEqual(c.w.turns, ["la app quedó colgada en el splash"]);
});

test("a language picked by hand rides every transcription as fixed=1; the default is not forced", async () => {
  const picked = call("es", true);
  picked.feed(0.002, 600); picked.feed(0.2, 900); picked.feed(0.002, 850);
  await picked.tick();
  assert.equal(picked.w.pending[0].query, "lang=es&fixed=1");
  const auto = call("en", false);
  auto.feed(0.002, 600); auto.feed(0.2, 900); auto.feed(0.002, 850);
  await auto.tick();
  assert.equal(auto.w.pending[0].query, "lang=en");
});
