/* The phone's hands-free call with Robert — one tap opens it, then it is a conversation: listen, cut on
 * silence, transcribe on the Mac (/api/transcribe, local whisper), hand the words to the page (a turn
 * for Robert, or an answer to the card on screen), and speak what comes back sentence by sentence as it
 * streams (/api/speak, local Kokoro) — then listen again. Speak over him and he stops (barge-in); a
 * barge that turns out to be his own voice coming back through the speaker, or a cough, is dropped and
 * he carries on where he was (echo guard).
 *
 * Ported from the Desk's voice call (static/desk.html, "Voice call": VAD, vcFrame, vcWav, vcSend,
 * vcHeard, vcDelta, vcSentence, vcFinal, vcEnqueue, vcPlay, vcBargeIn, vcEcho). Duplicated on purpose:
 * desk.html is one page with its own state and its behaviour must not move; this file is the phone's
 * copy, hardened for what a phone does to a page:
 *   - sound is unlocked inside the tap (AudioContext created + resumed, the one <audio> element primed
 *     with a silent clip) — iOS refuses both afterwards;
 *   - the AudioContext gets suspended/"interrupted" (an incoming call, Siri, the app hidden): the call
 *     pauses, says so, and resumes when the context runs again or on the next tap;
 *   - the mic track ends or mutes (route change to AirPods/car, the OS taking the mic): it is opened
 *     again without ending the call;
 *   - the screen is kept awake (Wake Lock) and the lock is taken again whenever the page comes back;
 *   - capture runs in an AudioWorklet when there is one, so a busy main thread (a long reply being
 *     drawn) delays frames instead of dropping them; ScriptProcessor is the fallback.
 * The page owns everything else (what a transcript means, where a turn goes, what is drawn).
 *
 * ctx = { token(), lang(), speed(), label(id8) → name|null, onState(state, why), onHeard(text, meta),
 *         onLevel(0..1), onSubtitle(text), onError(msg), busy() → Robert is mid-turn, onStopTurn() }
 */
(function (root) {
  // Tuned for a phone held in a hand or lying on a table: the Desk's numbers, with barge-in asking
  // for a little more (a loudspeaker 10cm from the mic leaks more of him back than a Mac does).
  var VAD = { start: 0.025, hold: 0.012, speech: 0.04, endMs: 850, minSpeechMs: 220, maxMs: 45000, preMs: 350, barge: 0.075, bargeMs: 380 };
  // Whisper's stock phantoms on breath and room noise — never a command, never a turn.
  var HEARD_NOISE = /^(\[.*\]|\(.*\)|\*.*\*|thank you\.?|thanks for watching.*|you\.?|bye\.?|gracias( por ver.*)?\.?|subt[ií]tulos.*|amara\.org.*|[.…,!? ]+)$/i;
  var SENTENCE_CUT = /(?<=[.!?…:;])\s+|\n+/;

  function norm(t) {
    return " " + String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";
  }

  // What a sentence sounds like: no code, no links read letter by letter, no markdown, an 8-char
  // terminal id said as the terminal's name (label), no emoji.
  function speakable(text, lang, label) {
    var t = String(text == null ? "" : text).replace(/```[\s\S]*?```/g, " ");
    t = t.split("\n").filter(function (l) { return !/^\s*(UI\b|\{.*\}\s*$|::(?:ask|artifact) [0-9a-f-]{8,36}::\s*$)/.test(l); }).join("\n");
    t = t.replace(/\b([0-9a-f]{8})(?:-?[0-9a-f]{4}){0,3}(?:-?[0-9a-f]{12})?\b/g, function (m, id8) { var n = label && label(id8); return n || m; });
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, lang === "es" ? "un enlace" : "a link").replace(/`([^`]*)`/g, "$1");
    t = t.replace(/^\s*(?:[-•*]|\d+[.)])\s+/gm, "").replace(/\s+·\s+/g, ", ").replace(/[*_#>|~]+/g, " ").replace(/\p{Extended_Pictographic}️?/gu, "");
    return t.replace(/\s+/g, " ").trim();
  }

  // 16 kHz mono PCM WAV: what whisper wants, no codec, cut exactly where the silence was.
  function wav(frames, rate) {
    var ratio = rate / 16000;
    var total = 0; for (var k = 0; k < frames.length; k++) total += frames[k].length;
    var out = new Int16Array(Math.floor(total / ratio));
    var o = 0, acc = 0, cnt = 0, pos = 0;
    for (var fi = 0; fi < frames.length; fi++) {
      var f = frames[fi];
      for (var i = 0; i < f.length; i++, pos++) {
        acc += f[i]; cnt++;
        if (pos + 1 >= (o + 1) * ratio && o < out.length) { var v = Math.max(-1, Math.min(1, acc / cnt)); out[o++] = v < 0 ? v * 0x8000 : v * 0x7fff; acc = 0; cnt = 0; }
      }
    }
    var buf = new ArrayBuffer(44 + o * 2), dv = new DataView(buf);
    var str = function (at, s) { for (var j = 0; j < s.length; j++) dv.setUint8(at + j, s.charCodeAt(j)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + o * 2, true); str(8, "WAVE"); str(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, o * 2, true);
    new Int16Array(buf, 44, o).set(out.subarray(0, o));
    return new Blob([buf], { type: "audio/wav" });
  }

  // A barge whose words are nearly all words he just said is the room hearing him, not you.
  function isEcho(text, recent) {
    var words = norm(text).trim().split(" ").filter(function (w) { return w.length > 2; });
    if (words.length < 2) return false;
    var his = new Set(recent.join(" ").split(" "));
    return words.filter(function (w) { return his.has(w); }).length / words.length >= 0.8;
  }

  /**
   * The ear, as a pure state machine so it can be tested with synthetic frames. Every ~40ms of mic: a
   * level, idle keeps 350ms of pre-roll so the first syllable is not lost, a frame over the start level
   * opens a segment, ~850ms under the hold level closes it. A segment with less than ~220ms of real
   * speech (a cough, a door, a car indicator) is dropped. Over his voice only a sustained, louder sound
   * counts as you (barge). Returns the events this frame produced.
   */
  function makeEar() {
    var E = { seg: null, pre: [], preMs: 0, noise: 0.01, bargeMs: 0, deafUntil: 0 };
    E.frame = function (f, rate, now, speaking) {
      var ev = [];
      var sum = 0;
      for (var i = 0; i < f.length; i++) sum += f[i] * f[i];
      var rms = Math.sqrt(sum / f.length), ms = (f.length / rate) * 1000;
      E.level = speaking ? 0 : Math.min(1, rms * 8);
      if (now < E.deafUntil) { if (E.seg) { E.seg = null; ev.push({ type: "drop" }); } E.pre = []; E.preMs = 0; E.bargeMs = 0; return ev; }
      var frame = new Float32Array(f);
      if (!E.seg && speaking) {
        E.pre.push(frame); E.preMs += ms;
        while (E.preMs > VAD.preMs + VAD.bargeMs && E.pre.length > 1) E.preMs -= (E.pre.shift().length / rate) * 1000;
        E.bargeMs = rms > Math.max(VAD.barge, E.noise * 6) ? E.bargeMs + ms : Math.max(0, E.bargeMs - ms / 2);
        if (E.bargeMs < VAD.bargeMs) return ev;
        E.seg = { frames: E.pre, ms: E.preMs, loudMs: E.bargeMs, last: now, barge: true };
        E.pre = []; E.preMs = 0; E.bargeMs = 0;
        ev.push({ type: "barge" });
        return ev;
      }
      if (!E.seg) {
        E.pre.push(frame); E.preMs += ms;
        while (E.preMs > VAD.preMs && E.pre.length > 1) E.preMs -= (E.pre.shift().length / rate) * 1000;
        if (rms > Math.max(VAD.start, E.noise * 3)) {
          E.seg = { frames: E.pre, ms: E.preMs, loudMs: rms > VAD.speech ? ms : 0, last: now, barge: false };
          E.pre = []; E.preMs = 0;
          ev.push({ type: "open" });
        } else E.noise = Math.min(0.02, E.noise * 0.97 + rms * 0.03);
        return ev;
      }
      var s = E.seg;
      s.frames.push(frame); s.ms += ms;
      if (rms > Math.max(VAD.hold, E.noise * 2)) { s.last = now; if (rms > VAD.speech) s.loudMs += ms; }
      // You were already talking when he started: that is a barge too.
      if (!s.barge && speaking && s.loudMs >= VAD.bargeMs) { s.barge = true; ev.push({ type: "barge" }); }
      if (now - s.last > VAD.endMs || s.ms > VAD.maxMs) {
        E.seg = null;
        ev.push({ type: "close", frames: s.frames, ms: s.ms, loudMs: s.loudMs, barge: s.barge, keep: s.loudMs >= VAD.minSpeechMs });
      }
      return ev;
    };
    E.reset = function () { E.seg = null; E.pre = []; E.preMs = 0; E.bargeMs = 0; };
    return E;
  }

  // The capture node: an AudioWorklet that hands 2048-sample frames to the page (nothing is lost when
  // the page is busy — messages queue), or a ScriptProcessor where worklets are missing.
  var WORKLET = "class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}" +
    "process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b,[this.b.buffer]);this.b=new Float32Array(2048);this.n=0}}}return true}}" +
    "registerProcessor('chronos-ear',P)";

  var C = null;
  var V = {
    on: false, state: "off", why: "", ctx: null, stream: null, src: null, node: null, sink: null, rate: 48000, ear: makeEar(),
    audio: null, speakQ: [], playing: null, paused: null, turn: null, buf: "", spoken: new Set(), muted: null, recent: [],
    chain: Promise.resolve(), sending: 0, lock: null, deaf: false, mute: false, gen: 0, reacquiring: false, bargeItem: null,
    lastLevel: -1, trace: [],
  };
  // What the call did, last 60 moves — for the harness and for a bug report, never shown.
  function tr(what) { V.trace.push([Math.round(performance.now()), what]); if (V.trace.length > 60) V.trace.shift(); }

  // 0.1 s of silence: what primes the <audio> element inside the tap (iOS unlocks an element for
  // later plays only if it was played from a gesture). Made on the spot — nothing to fetch.
  function silent() { if (!V.silent) V.silent = URL.createObjectURL(wav([new Float32Array(1600)], 16000)); return V.silent; }
  function t(es, en) { return C && C.lang() === "es" ? es : en; }
  function auth() { var k = C && C.token(); return k ? { "x-mc-admin": k } : {}; }
  function speaking() { return !!V.playing || V.speakQ.length > 0; }

  function computeState() {
    if (!V.on) return "off";
    if (V.state === "connecting") return "connecting";
    if (V.paused) return "paused";
    if (speaking()) return "speaking";
    if (V.ear.seg) return "hearing";
    if (V.sending) return "transcribing";
    if (C.busy && C.busy()) return "thinking";
    return "listening";
  }
  function paint() {
    var st = computeState();
    var why = st === "paused" ? V.paused : "";
    if (st === V.state && why === V.why) return;
    V.state = st; V.why = why;
    try { C.onState(st, why); } catch (e) {}
  }

  async function wake(on) {
    try {
      if (on && !V.lock && navigator.wakeLock && document.visibilityState === "visible") {
        var l = await navigator.wakeLock.request("screen");
        if (!V.on) return l.release();
        V.lock = l; l.addEventListener("release", function () { if (V.lock === l) V.lock = null; });
      } else if (!on && V.lock) { var x = V.lock; V.lock = null; await x.release(); }
    } catch (e) { /* not supported, or refused (battery saver): the call still works, the screen may dim */ }
  }

  function earcon(kind) {
    var c = V.ctx;
    if (!c || c.state !== "running") return;
    var notes = { on: [523, 784], off: [660, 440], sent: [880], resume: [784] }[kind] || [];
    notes.forEach(function (hz, i) {
      var o = c.createOscillator(), g = c.createGain(), at = c.currentTime + i * 0.09;
      o.type = "sine"; o.frequency.value = hz;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.07, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g).connect(c.destination); o.start(at); o.stop(at + 0.18);
    });
    if (kind === "sent") V.ear.deafUntil = Math.max(V.ear.deafUntil, performance.now() + 220);
  }

  function onFrame(f) {
    if (!V.on || V.paused || V.mute || V.deaf) return;
    var evs = V.ear.frame(f, V.rate, performance.now(), speaking() && !V.bargeItem);
    var lvl = Math.round(V.ear.level * 10) / 10;
    if (lvl !== V.lastLevel) { V.lastLevel = lvl; try { C.onLevel(lvl); } catch (e) {} }
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e.type === "barge") bargeIn();
      else if (e.type === "close") {
        if (e.keep) send(e.frames, e.barge);
        else if (e.barge) bargeFalse(); // a cough over him: he carries on
      }
    }
    if (evs.length) paint();
  }

  // ── the mic ────────────────────────────────────────────────────────────────────────────────────
  async function openMic() {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (!V.on) { stream.getTracks().forEach(function (x) { x.stop(); }); return false; }
    unwire();
    V.stream = stream;
    var track = stream.getAudioTracks()[0];
    if (track) {
      // The OS took the mic, or the route went away (AirPods out of the ears, the car turned off).
      track.addEventListener("ended", function () { if (V.on && V.stream === stream) reacquire("mic lost"); });
      // iOS mutes the track for a phone call or Siri: pause until it comes back.
      track.addEventListener("mute", function () { if (V.on && V.stream === stream) pause("interrupted"); });
      track.addEventListener("unmute", function () { if (V.on && V.stream === stream && V.paused === "interrupted") unpause(); });
    }
    V.src = V.ctx.createMediaStreamSource(stream);
    V.sink = V.ctx.createGain(); V.sink.gain.value = 0;
    var gen = ++V.gen;
    var worklet = false;
    if (V.ctx.audioWorklet && root.AudioWorkletNode && root.Blob && root.URL) {
      try {
        if (!V.workletReady) {
          var url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
          V.workletReady = V.ctx.audioWorklet.addModule(url).finally(function () { URL.revokeObjectURL(url); });
        }
        await V.workletReady;
        if (gen !== V.gen || !V.on) return false;
        V.node = new AudioWorkletNode(V.ctx, "chronos-ear", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        V.node.port.onmessage = function (m) { onFrame(m.data); };
        worklet = true;
      } catch (e) { V.workletReady = null; worklet = false; }
    }
    if (!worklet) {
      V.node = V.ctx.createScriptProcessor(2048, 1, 1);
      V.node.onaudioprocess = function (ev) { onFrame(ev.inputBuffer.getChannelData(0)); };
    }
    V.src.connect(V.node); V.node.connect(V.sink); V.sink.connect(V.ctx.destination);
    V.engine = worklet ? "worklet" : "script";
    return true;
  }
  function unwire() {
    try { if (V.node) { if (V.node.port) V.node.port.onmessage = null; V.node.onaudioprocess = null; V.node.disconnect(); } } catch (e) {}
    try { if (V.src) V.src.disconnect(); } catch (e) {}
    try { if (V.sink) V.sink.disconnect(); } catch (e) {}
    V.node = V.src = V.sink = null;
    if (V.stream) { V.stream.getTracks().forEach(function (x) { x.stop(); }); V.stream = null; }
    V.ear.reset();
  }
  async function reacquire(why) {
    if (!V.on || V.reacquiring) return;
    V.reacquiring = true;
    try {
      for (var i = 0; i < 2 && V.on; i++) {
        try { if (await openMic()) { if (V.paused) unpause(); return; } } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 600); });
      }
      if (V.on) pause(why || "mic lost");
    } finally { V.reacquiring = false; }
  }

  // ── pause / resume ──────────────────────────────────────────────────────────────────────────────
  // Paused = the call is still on but nothing is listening or speaking: an interruption, the app in
  // the background, a mic that could not be reopened. It resumes by itself when the platform lets it
  // (context running again, track unmuted, page visible) — else on the next tap (resume()).
  function pause(why) {
    if (!V.on) return;
    tr("pause:" + why);
    V.paused = why;
    var a = V.audio; if (a && V.playing) { try { a.pause(); } catch (e) {} }
    V.ear.reset();
    paint();
  }
  function unpause() {
    if (!V.on || !V.paused) return;
    tr("resume");
    V.paused = null;
    V.ear.deafUntil = performance.now() + 300;
    if (V.playing && V.audio && V.audio.src) V.audio.play().catch(function () {});
    else play();
    earcon("resume");
    paint();
  }
  // From a tap: the one moment iOS lets a page restart its sound.
  async function resume() {
    if (!V.on) return;
    try { if (V.ctx && V.ctx.state !== "running") await V.ctx.resume(); } catch (e) {}
    if (V.audio && !V.playing) { try { V.audio.src = silent(); V.audio.play().catch(function () {}); } catch (e) {} }
    var live = V.stream && V.stream.getAudioTracks().some(function (x) { return x.readyState === "live" && !x.muted; });
    if (!live) await reacquire("mic lost"); else unpause();
    wake(true);
  }
  function onCtxState() {
    if (!V.on || !V.ctx) return;
    var s = V.ctx.state;
    if (s === "running") { if (V.paused === "interrupted" || V.paused === "background") unpause(); }
    else if (s === "interrupted" || s === "suspended") { if (!V.paused) pause(document.visibilityState === "hidden" ? "background" : "interrupted"); }
  }
  function onVisibility() {
    if (!V.on) return;
    if (document.visibilityState === "hidden") {
      // iOS freezes a hidden page: say "paused" now rather than pretend to listen. Android keeps a
      // capturing page running (it shows the mic indicator), so the call carries on there.
      if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) pause("background");
      return;
    }
    wake(true);
    var p = V.ctx && V.ctx.state !== "running" ? V.ctx.resume() : Promise.resolve();
    p.catch(function () {}).then(function () {
      var live = V.stream && V.stream.getAudioTracks().some(function (x) { return x.readyState === "live"; });
      if (!live) return reacquire("mic lost");
      if (V.ctx && V.ctx.state === "running" && V.paused && V.paused !== "mic lost") unpause();
    });
  }
  var devT = 0;
  function onDevices() {
    // A headset or the car came or went. iOS moves an open track to the new route by itself; elsewhere
    // the old track keeps the old mic (or ends), so the mic is reopened on whatever is default now.
    if (!V.on || /iP(hone|ad|od)/.test(navigator.userAgent)) return;
    clearTimeout(devT); devT = setTimeout(function () { if (V.on) reacquire("mic lost"); }, 500);
  }

  // ── start / stop ────────────────────────────────────────────────────────────────────────────────
  // MUST be called synchronously from a tap/click handler: the AudioContext and the <audio> element are
  // only unlocked inside the gesture on iOS. Everything after the first await is ordinary async.
  function start() {
    if (V.on) return Promise.resolve(true);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { err(t("Este navegador no da el micrófono", "No microphone in this browser")); return Promise.resolve(false); }
    V.on = true; V.paused = null; V.state = "off"; V.why = "";
    V.audio = V.audio || new Audio();
    try { V.audio.setAttribute("playsinline", ""); V.audio.src = silent(); var pp = V.audio.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) {}
    try {
      if (!V.ctx || V.ctx.state === "closed") { V.ctx = new (root.AudioContext || root.webkitAudioContext)(); V.workletReady = null; }
      V.ctx.onstatechange = onCtxState;
      var rp = V.ctx.resume(); if (rp && rp.catch) rp.catch(function () {});
    } catch (e) { V.on = false; err(t("No pude abrir el audio", "Could not open audio")); return Promise.resolve(false); }
    V.rate = V.ctx.sampleRate;
    V.state = "connecting"; try { C.onState("connecting", ""); } catch (e) {}
    document.addEventListener("visibilitychange", onVisibility);
    if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", onDevices);
    wake(true);
    return openMic().then(function (ok) {
      if (!ok) return false;
      V.ear.reset(); V.ear.noise = 0.01; V.ear.deafUntil = performance.now() + 250;
      V.state = "off"; paint();
      earcon("on");
      // A cold whisper model costs seconds on the first sentence; a blank clip loads it now.
      fetch("/api/transcribe?lang=" + C.lang(), { method: "POST", headers: Object.assign({ "content-type": "audio/wav" }, auth()), body: wav([new Float32Array(Math.round(V.rate * 0.4))], V.rate) }).catch(function () {});
      return true;
    }).catch(function (e) {
      var denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      stop(true);
      err(denied ? t("Sin permiso para el micrófono", "Microphone permission denied") : t("No pude abrir el micrófono", "Could not open the microphone") + (e && e.message ? ": " + e.message : ""));
      return false;
    });
  }
  function stop(silent) {
    if (!V.on) return;
    skip(true);
    if (!silent) earcon("off");
    V.on = false; V.paused = null; V.bargeItem = null; V.muted = null; V.turn = null; V.buf = "";
    unwire();
    document.removeEventListener("visibilitychange", onVisibility);
    if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener("devicechange", onDevices);
    wake(false);
    // The context is kept (closed contexts cannot be reopened without a new gesture, and a new one per
    // call leaks on iOS); suspend it so the phone's audio session is released.
    var c = V.ctx; if (c && c.state === "running") setTimeout(function () { if (!V.on) c.suspend().catch(function () {}); }, 400);
    V.state = "off"; V.why = "";
    try { C.onState("off", ""); } catch (e) {}
  }
  function err(msg) { try { C.onError(msg); } catch (e) {} }

  // ── the ear → words ─────────────────────────────────────────────────────────────────────────────
  function send(frames, barge) {
    var blob = wav(frames, V.rate);
    V.sending++; earcon("sent"); paint();
    var bargeItem = barge ? V.bargeItem : null;
    V.chain = V.chain.then(async function () {
      var text = "";
      try {
        var r = await fetch("/api/transcribe?lang=" + C.lang(), { method: "POST", headers: Object.assign({ "content-type": "audio/wav" }, auth()), body: blob });
        if (!r.ok) throw new Error((await r.text()).slice(0, 120) || "HTTP " + r.status);
        text = String((await r.json()).text || "").replace(/\s+/g, " ").trim();
      } catch (e) { if (V.on) err(t("No pude transcribir: ", "Transcribe failed: ") + String((e && e.message) || e).slice(0, 100)); }
      finally { V.sending--; }
      if (!V.on) return paint();
      var real = !!text && !HEARD_NOISE.test(text) && !(barge && isEcho(text, V.recent));
      if (!real) tr("dropped:" + (text ? text.slice(0, 30) : "silence"));
      if (bargeItem && bargeItem === V.bargeItem) { if (real) bargeTrue(); else bargeFalse(); }
      if (real) heard(text, barge);
      paint();
    });
  }
  function heard(text, barge) {
    tr("heard:" + text.slice(0, 40));
    var n = norm(text);
    if (/^ (hang up|end (the )?call|disconnect|colgar|colga|corta|cortar|chau robert|bye robert) $/.test(n)) return stop();
    if (/^ (stop|para|parar|pará|detente|basta|stop robert|para robert|silencio) $/.test(n)) { skip(); try { C.onStopTurn && C.onStopTurn(); } catch (e) {} return; }
    try { C.onHeard(text, { barge: !!barge }); } catch (e) { err(String((e && e.message) || e)); }
  }

  // You spoke over him. The audio PAUSES (not discarded): if what you said turns out to be words, the
  // rest of his turn is dropped; if it was his own voice coming back or a cough, he carries on.
  function bargeIn() {
    tr("barge");
    if (!V.playing) { V.muted = V.turn; skip(true); return; }
    V.bargeItem = V.playing;
    try { V.audio.pause(); } catch (e) {}
    paint();
  }
  function bargeTrue() {
    tr("barge:words");
    V.bargeItem = null;
    V.muted = V.turn;
    skip(true);
  }
  function bargeFalse() {
    tr("barge:echo-or-noise");
    var it = V.bargeItem; V.bargeItem = null;
    if (it && V.playing === it && V.on && !V.paused) V.audio.play().catch(function () {});
  }

  // ── the mouth ───────────────────────────────────────────────────────────────────────────────────
  // His streamed text is cut into sentences as it arrives; each one is rendered right away (the audio
  // is ready by the time the one before it ends) and played in order on the one <audio> element.
  function turn(id) {
    if (id && V.turn === id) return;
    V.turn = id || null; V.buf = ""; V.spoken = new Set();
  }
  function delta(e) {
    if (!V.on || (e.turn && e.turn === V.muted)) return;
    turn(e.turn);
    if (e.kind === "tool") return cut(true); // what he said before reaching for a tool is a whole thought
    if (e.kind && e.kind !== "text") return;
    V.buf += e.text || "";
    cut(false);
  }
  function cut(all) {
    var parts = V.buf.split(SENTENCE_CUT);
    V.buf = all ? "" : parts.pop() || "";
    for (var i = 0; i < parts.length; i++) sentence(parts[i]);
  }
  function sentence(p, opts) {
    var s = speakable(p, C.lang(), C.label);
    if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
    var k = norm(s);
    if (!(opts && opts.again) && V.spoken.has(k)) return null;
    V.spoken.add(k);
    return enqueue(s, opts);
  }
  // The authoritative reply: whatever the stream did not already say. Something he raised on his own
  // is cut to its first few sentences — the chat has the rest.
  function final(e, fromHere) {
    if (!V.on) return;
    if (fromHere && String(e.reply || "").startsWith("⚠️")) return;
    if (fromHere && e.turn && e.turn === V.muted) return;
    if (fromHere) { turn(e.turn); cut(true); } else turn("push:" + (e.at || Date.now()));
    var parts = String(e.reply || "").split(SENTENCE_CUT);
    var list = fromHere ? parts : parts.slice(0, 4);
    for (var i = 0; i < list.length; i++) sentence(list[i]);
  }
  /**
   * Say page text (a card read out, a confirmation, an alert). Resolves when it has been PLAYED to the
   * end — true — or dropped (skipped, barged over, call ended) — false. That is what lets the page know
   * a draft was read out in full before it accepts a yes, and an alert was really heard before it tells
   * the daemon so. opts: { tag, first (ahead of everything queued), lang }.
   */
  function say(text, opts) {
    if (!V.on) return Promise.resolve(false);
    var o = opts || {};
    var parts = String(text || "").split(SENTENCE_CUT).filter(function (x) { return x.trim(); });
    var items = [];
    for (var i = 0; i < parts.length; i++) {
      var s = speakable(parts[i], o.lang || C.lang(), C.label);
      if (!s || !/[\p{L}\p{N}]/u.test(s)) continue;
      items.push(enqueue(s, o, true));
    }
    if (!items.length) return Promise.resolve(true);
    if (o.onStart) items[0].onStart = o.onStart; // told when its audio actually begins (alerts: "started")
    // Ahead of the line, in their own order: right after the sentence playing now.
    if (o.first) V.speakQ = items.concat(V.speakQ.filter(function (x) { return items.indexOf(x) < 0; }));
    paint();
    play();
    return Promise.all(items.map(function (x) { return x.done; })).then(function (r) { return r.every(Boolean); });
  }
  function enqueue(text, opts, quiet) {
    var item = { text: text, tag: (opts && opts.tag) || null, done: null, resolve: null };
    item.done = new Promise(function (r) { item.resolve = r; });
    if (!V.on) { item.resolve(false); return item; }
    item.blob = fetch("/api/speak", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, auth()), body: JSON.stringify({ text: text, lang: (opts && opts.lang) || C.lang() }) })
      .then(function (r) { return r.ok ? r.blob() : null; }).catch(function () { return null; });
    V.speakQ.push(item);
    if (!quiet) { paint(); play(); }
    return item;
  }
  async function play() {
    if (V.playing || !V.speakQ.length || !V.on || V.paused) return;
    var item = V.speakQ.shift();
    V.playing = item;
    paint();
    var blob = await item.blob;
    if (V.playing !== item) return item.resolve(false); // skipped while it rendered
    // Paused (a call came in, the app went to the background) while it rendered: back to the front of
    // the line, played when the call resumes.
    if (V.paused) { V.playing = null; V.speakQ.unshift(item); return; }
    var ok = false;
    if (blob && V.on) {
      var url = URL.createObjectURL(blob), a = V.audio;
      try { C.onSubtitle(item.text); } catch (e) {}
      V.recent.push(norm(item.text)); if (V.recent.length > 8) V.recent.shift();
      a.preservesPitch = a.webkitPreservesPitch = true;
      ok = await new Promise(function (done) {
        a.onended = function () { done(true); };
        a.onerror = function () { done(false); };
        a.src = url; a.defaultPlaybackRate = a.playbackRate = C.speed();
        var p = a.play();
        if (p && p.then) p.then(function () { if (item.onStart && V.playing === item) { var f = item.onStart; item.onStart = null; try { f(); } catch (e) {} } }, function () { done(false); });
      });
      URL.revokeObjectURL(url);
      if (V.playing !== item) return item.resolve(false);
    }
    V.playing = null;
    item.resolve(ok);
    afterSpeech();
  }
  function afterSpeech(barged) {
    if (V.speakQ.length) return play();
    if (!barged) V.ear.deafUntil = performance.now() + 450; // the room's echo of his last word
    try { C.onSubtitle(""); } catch (e) {}
    paint();
  }
  // Stop speaking now. With a tag, only that tag's sentences are dropped (a card that moved on).
  function skip(barged, tag) {
    var a = V.audio, done = a && a.onended;
    if (tag) {
      V.speakQ = V.speakQ.filter(function (it) { if (it.tag === tag) { it.resolve(false); return false; } return true; });
      if (!V.playing || V.playing.tag !== tag) return;
    } else {
      V.speakQ.forEach(function (it) { it.resolve(false); });
      V.speakQ = [];
    }
    var cur = V.playing;
    V.playing = null; V.bargeItem = null;
    if (cur) cur.resolve(false);
    if (a) { try { a.pause(); } catch (e) {} a.onended = a.onerror = null; }
    // Unblock the play() that was waiting on this sentence's end; it sees the item was dropped.
    if (done && cur) done();
    afterSpeech(barged);
  }

  function init(ctx) {
    C = ctx;
    // Prime the queue when the call starts later; nothing to do until then.
  }

  root.PhoneVoice = {
    init: init, start: start, stop: stop, resume: resume,
    say: say, skip: skip, turn: turn, delta: delta, final: final,
    get on() { return V.on; },
    state: function () { return V.on ? computeState() : "off"; },
    speaking: function () { return V.on && speaking(); },
    setMute: function (m) { V.mute = !!m; V.ear.reset(); paint(); return V.mute; },
    get muted() { return V.mute; },
    deaf: function (d) { V.deaf = !!d; V.ear.reset(); },
    refresh: paint,
    engine: function () { return V.engine || null; },
    // Pure helpers, for the tests (src/phone-voice.test.ts).
    // `heard` delivers a transcript as if whisper had returned it — the harness drives the dialogue
    // with it once the audio path itself has been exercised with a fake microphone.
    _t: { norm: norm, speakable: speakable, wav: wav, isEcho: isEcho, makeEar: makeEar, VAD: VAD, HEARD_NOISE: HEARD_NOISE, SENTENCE_CUT: SENTENCE_CUT, heard: function (text) { if (V.on) heard(text, false); }, trace: function () { return V.trace.slice(); } },
  };
})(typeof window !== "undefined" ? window : globalThis);
