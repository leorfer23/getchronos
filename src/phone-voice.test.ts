/**
 * The phone's hands-free call (static/phone-voice.js), run in a vm: the ear (VAD) on synthetic frames,
 * the 16 kHz WAV it sends to whisper, what a sentence sounds like, the echo guard, and the wiring the
 * page depends on. No build step, so the shipped file is what is tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const src = fs.readFileSync(path.join(process.cwd(), "static/phone-voice.js"), "utf8");
const ctx: any = { window: {}, Blob, performance, URL, setTimeout, clearTimeout, console };
vm.runInNewContext(src, ctx);
const PV = ctx.window.PhoneVoice;
const T = PV._t;

const RATE = 48000, N = 2048; // ~43 ms frames, as a ScriptProcessor/worklet hands them over
const frame = (amp: number, hz = 180) => { const f = new Float32Array(N); for (let i = 0; i < N; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE); return f; };
const msPer = (N / RATE) * 1000;
function feed(ear: any, amp: number, ms: number, t0: number, speaking = false) {
  const out: any[] = []; let t = t0;
  for (let n = 0; n < Math.ceil(ms / msPer); n++, t += msPer) out.push(...ear.frame(frame(amp), RATE, t, speaking));
  return { events: out, t };
}

test("the ear opens on speech, keeps the pre-roll, and closes after ~850 ms of quiet", () => {
  const ear = T.makeEar();
  let r = feed(ear, 0.002, 1000, 0);
  assert.deepEqual(r.events, [], "room noise opens nothing");
  r = feed(ear, 0.2, 700, r.t);
  assert.equal(r.events[0]?.type, "open");
  r = feed(ear, 0.002, 1200, r.t);
  const close = r.events.find((e) => e.type === "close");
  assert.ok(close, "a pause closes the segment");
  assert.equal(close.keep, true, "700 ms of real speech is kept");
  assert.equal(close.barge, false);
  assert.ok(close.ms > 700 + T.VAD.preMs - 50, "the pre-roll rides along so the first syllable is not lost");
});

test("a cough is dropped; a sound while he speaks has to be louder and longer to count (barge-in)", () => {
  const ear = T.makeEar();
  let r = feed(ear, 0.002, 600, 0);
  r = feed(ear, 0.3, 90, r.t);
  r = feed(ear, 0.002, 1200, r.t);
  const close = r.events.find((e) => e.type === "close");
  assert.equal(close?.keep, false, "90 ms is not speech");

  const ear2 = T.makeEar();
  let s = feed(ear2, 0.002, 600, 0, true);
  s = feed(ear2, 0.05, 800, s.t, true);
  assert.ok(!s.events.some((e) => e.type === "barge"), "his own voice leaking back at a normal level is not a barge");
  s = feed(ear2, 0.3, 600, s.t, true);
  assert.ok(s.events.some((e) => e.type === "barge"), "a sustained loud voice over him is");
});

test("nothing is heard while the ear is deaf (the echo of his last word)", () => {
  const ear = T.makeEar();
  ear.deafUntil = 10_000;
  const r = feed(ear, 0.4, 900, 0);
  assert.deepEqual(r.events.filter((e) => e.type !== "drop"), []);
});

test("the WAV is 16 kHz mono 16-bit PCM, downsampled from the context rate", async () => {
  const blob = T.wav([new Float32Array(48000)], 48000); // one second at 48 kHz
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(22), 1, "mono");
  assert.equal(buf.readUInt32LE(24), 16000, "16 kHz");
  assert.equal(buf.readUInt16LE(34), 16, "16-bit");
  assert.equal(buf.readUInt32LE(40), 32000, "one second of samples");
  assert.equal(blob.type, "audio/wav");
});

test("what is spoken: no markdown, no code, a link is 'a link', a terminal id is its name", () => {
  const label = (id8: string) => (id8 === "abcd1234" ? "the login fix" : null);
  assert.equal(T.speakable("**Done.** See https://github.com/o/r/pull/7 and `npm test`.", "en", label), "Done. See a link and npm test.");
  assert.equal(T.speakable("Mirá https://x.test/a", "es", label), "Mirá un enlace");
  assert.equal(T.speakable("Terminal abcd1234 is waiting", "en", label), "Terminal the login fix is waiting");
  assert.equal(T.speakable("```js\nconst a = 1\n```\nShipped 🚀", "en", label), "Shipped");
  assert.equal(T.speakable("- one\n- two", "en", label), "one two");
  assert.equal(T.speakable("::ask 0123abcd-4567-89ab-cdef-0123456789ab::", "en", label), "");
});

test("echo guard: words that are nearly all his own are the room hearing him", () => {
  const recent = [T.norm("La primera es una terminal de cedar que se frenó")];
  assert.equal(T.isEcho("una terminal de cedar que se frenó", recent), true);
  assert.equal(T.isEcho("esperá, mergealo después", recent), false);
  assert.equal(T.isEcho("sí", recent), false, "one short word is never judged an echo");
});

test("the conversation: what the page just said, heard back, is never his next turn", () => {
  const was = (k: string, end: number) => ({ k: T.norm(k), end });
  const said = [was("La primera es una terminal de cedar que se frenó.", 9_000), was("¿Querés que le avise?", 10_000)];
  // His sentence back right after it ended (a car's speakers, a room's reverb): dropped.
  assert.equal(T.echoVerdict("una terminal de cedar que se frenó", { t0: 10_300, afterPlay: 300 }, said), true);
  // A short echo over his audio — two words he was saying: dropped.
  assert.equal(T.echoVerdict("le avise", { t0: 9_800, overlap: true }, said), true);
  // A barge made of his own words: dropped, and his audio carries on (bargeFalse).
  assert.equal(T.echoVerdict("querés que le avise", { t0: 9_900, barge: true, overlap: true }, said), true);
  // Your answer is yours, even right after him or over him.
  assert.equal(T.echoVerdict("sí", { t0: 10_300, afterPlay: 300 }, said), false);
  assert.equal(T.echoVerdict("esperá, mergealo después", { t0: 9_900, barge: true, overlap: true }, said), false);
  // His last sentence, back late through a slow route: dropped.
  assert.equal(T.echoVerdict("te aviso cuando esté", { t0: 10_500, afterPlay: 500 }, [was("Te aviso cuando esté.", 10_000)]), true);
  // Long after he stopped, words that repeat his are yours.
  assert.equal(T.echoVerdict("una terminal de cedar que se frenó", { t0: 12_000, afterPlay: 2_000 }, said), false);
  // A short reply the page itself invited is his, even said the moment it stopped: "O decí después."
  // then "después"; the options read out, then one of them by name.
  const card = [was("¿Qué le digo? O decí después.", 20_000), was("Opciones: Keep both for a week, o Switch today.", 30_000)];
  assert.equal(T.echoVerdict("después", { t0: 20_500, afterPlay: 500 }, card), false);
  assert.equal(T.echoVerdict("Switch today", { t0: 30_500, afterPlay: 500 }, card), false);
  // …but the same words over the page's audio are its echo.
  assert.equal(T.echoVerdict("después", { t0: 19_800, overlap: true }, card), true);
  assert.equal(T.echoVerdict("switch today", { t0: 29_800, overlap: true }, card), true);
  // A sentence that ended more than 3 s before you started is not what is coming back.
  assert.equal(T.echoVerdict("la primera es una terminal", { t0: 13_500, afterPlay: 300 }, [was("La primera es una terminal de cedar.", 5_000), was("Algo más.", 13_200)]), false);
  assert.ok(T.ECHO_MS >= 1000, "the window covers a Bluetooth route's delay on top of the deaf window");
});

test("a stop is always his: the page saying «decí cancelar» never swallows his «cancelar»", () => {
  const hold = [{ k: T.norm("Mergeo el arreglo del login. Decí cancelar para frenar."), end: 10_000 }];
  for (const t of ["cancelar", "Cancelá.", "no", "no, no", "pará", "stop", "esperá", "cancel"]) {
    assert.equal(T.isStop(t), true, t);
    assert.equal(T.echoVerdict(t, { t0: 9_500, overlap: true }, hold), false, `${t} over the hold line`);
    assert.equal(T.echoVerdict(t, { t0: 10_200, afterPlay: 200 }, hold), false, `${t} right after it`);
  }
  // Anything longer that is all his words is still his echo.
  assert.equal(T.echoVerdict("decí cancelar para frenar", { t0: 10_200, afterPlay: 200 }, hold), true);
  assert.equal(T.isStop("no lo mandes todavía"), false);
});

test("the call's clock rides with every utterance — when it began, whether the page was playing — and an echo never reaches the page", () => {
  const ear = T.makeEar();
  let r = feed(ear, 0.002, 600, 0);
  const began = r.t;
  r = feed(ear, 0.2, 600, r.t);
  r = feed(ear, 0.002, 1200, r.t);
  const close = r.events.find((e) => e.type === "close");
  assert.equal(close.t0, began, "t0 = when the speech began");
  assert.ok(close.t1 > close.t0 + 600);
  assert.equal(close.overlap, false);
  // The page marks a segment that ran while it was playing, and drops what the echo guard flags —
  // before Robert or a card ever sees it.
  assert.match(src, /if \(V\.audible\) seg\.overlap = true;/);
  assert.match(src, /var echo = !!text && echoVerdict\(text, m, V\.recent\);/);
  assert.match(src, /var real = !!text && !HEARD_NOISE\.test\(text\) && !echo;/);
  assert.match(src, /if \(real\) heard\(text, m\);/);
  assert.match(src, /try \{ C\.onHeard\(text, meta \|\| \{\}\); \}/);
});

test("whisper's phantoms on silence are never a turn; real short answers are", () => {
  for (const t of ["Gracias.", "Thank you.", "[Music]", "(silence)", "...", "Subtítulos por la comunidad"]) assert.ok(T.HEARD_NOISE.test(t), t);
  for (const t of ["Sí.", "dale", "después", "no"]) assert.ok(!T.HEARD_NOISE.test(t), t);
});

test("streamed text is cut into sentences as it arrives", () => {
  assert.deepEqual(JSON.parse(JSON.stringify("Hola. Todo bien? Sí: listo".split(T.SENTENCE_CUT))), ["Hola.", "Todo bien?", "Sí:", "listo"]);
});

test("the call unlocks sound inside the tap and survives what a phone does to a page", () => {
  // Inside the gesture: the AudioContext and the one <audio> element (iOS refuses both afterwards).
  assert.match(src, /V\.audio = V\.audio \|\| new Audio\(\);/);
  assert.match(src, /V\.audio\.setAttribute\("playsinline", ""\); V\.audio\.src = silent\(\);/);
  assert.match(src, /V\.ctx = new \(root\.AudioContext \|\| root\.webkitAudioContext\)\(\)/);
  // Interruptions, background, a lost route.
  assert.match(src, /s === "interrupted" \|\| s === "suspended"/);
  assert.match(src, /track\.addEventListener\("ended"/);
  assert.match(src, /track\.addEventListener\("mute"/);
  assert.match(src, /addEventListener\("devicechange", onDevices\)/);
  assert.match(src, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(src, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  // A barge pauses, it does not throw away: an echo or a cough lets him carry on.
  assert.match(src, /function bargeFalse\(\)[\s\S]*?V\.audio\.play\(\)/);
  // Capture keeps every frame when the page is busy.
  assert.match(src, /registerProcessor\('chronos-ear',P\)/);
  assert.match(src, /createScriptProcessor\(2048, 1, 1\)/);
  // Same doors as the Desk's call.
  assert.match(src, /fetch\("\/api\/transcribe\?lang=" \+ C\.lang\(\)/);
  assert.match(src, /fetch\("\/api\/speak"/);
  assert.doesNotMatch(src, /SpeechRecognition|speechSynthesis/, "no cloud speech, no browser voices");
});

test("say() resolves only when the words were played to the end — first:true goes ahead of the line", () => {
  assert.match(src, /if \(o\.first\) V\.speakQ = items\.concat/);
  assert.match(src, /a\.onended = function \(\) \{ done\(true\); \};/);
  assert.match(src, /item\.resolve\(ok\);/);
  assert.equal(PV.state(), "off");
  assert.equal(PV.on, false);
});
