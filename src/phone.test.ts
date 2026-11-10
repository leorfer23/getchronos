/**
 * The phone surface (static/phone.html) is plain HTML with no build step, so the regressions this
 * guards are attributes and strings in the shipped file: the PWA hooks a phone needs to install it,
 * the conversation with Robert as the home screen (talk first, type as an option), the approval deck
 * behind one entry, everything else behind one ⋯, push-to-talk as the fallback, deep links that do
 * not navigate, and the stale-build check. The call engine and the deck have their own tests
 * (src/phone-voice.test.ts, src/phone-deck.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const html = read("static/phone.html");
const sw = read("static/sw.js");

test("installs as a PWA: manifest with an id and 192/512 icons (one maskable), standalone, keyboard-aware viewport", () => {
  assert.match(html, /<link rel="manifest" href="\/phone\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/phone-icon-512\.png">/);
  assert.match(html, /name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /viewport-fit=cover/);
  const manifest = JSON.parse(read("static/phone.webmanifest"));
  assert.equal(manifest.start_url, "/phone");
  assert.equal(manifest.id, "/phone");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((i: any) => i.sizes === "192x192"));
  assert.ok(manifest.icons.some((i: any) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of manifest.icons) assert.ok(fs.existsSync(path.join(process.cwd(), "static", i.src)), i.src);
});

test("home is the conversation: one dominant talk button, text one tap away, nothing else in front", () => {
  // The first view is Robert's thread; the composer is the text field + the talk button.
  assert.match(html, /<div id="v-home" class="view">[\s\S]*?<div class="chat" id="chat"><\/div>[\s\S]*?<button class="talk" id="talk"/);
  assert.match(html, /<textarea id="r-composer" rows="1" placeholder="Message Robert"/);
  // One ⋯ in the header, and what is waiting for him as ONE entry above the thread.
  assert.match(html, /<button class="ic" id="btn-more" aria-label="More">/);
  assert.match(html, /<button class="qentry" id="qentry" hidden>/);
  assert.match(html, /n === 1 \? "1 waiting for you" : n \+ " waiting for you"/);
  // The old front is gone from the front: no three lists on home, no New/Robert bar, no ? button,
  // no project picker in the composer.
  assert.doesNotMatch(html, /<div class="hbar">|id="btn-robert"|id="r-asks"|id="v-robert"/);
  assert.doesNotMatch(html, /tag-complete\.js|TagComplete\(/, "he never names a project");
  assert.doesNotMatch(html, /#atlas to pin a project|one chat · # to name a project/);
});

test("everything else is behind one ⋯: terminals (the old triage lists), new terminal, settings", () => {
  assert.match(html, /function moreMenu\(\)/);
  assert.match(html, /data-m="terms"[\s\S]*?data-m="new"[\s\S]*?data-m="settings"/);
  assert.match(html, /<div id="v-terms" class="view" hidden>/);
  for (const g of ["g-needs", "g-finished", "g-working"]) assert.match(html, new RegExp(`id="${g}"`));
  assert.match(html, /const PH_RANK = \{ blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6 \};/);
  assert.match(html, /data-ans="continue"/);
  assert.match(html, /data-ans="close" class="go"/);
  assert.match(html, /async function closeSession\(id\)/);
  assert.match(html, /toast\("closed", \{ label: "Undo", fn: \(\) => reopen\(id\) \}\)/);
  assert.match(html, /<div class="\$\{cls\}" role="button" tabindex="0" data-open/);
  // Settings carries what used to sit on the front: Robert's model, a new conversation, voice.
  assert.match(html, /<select id="r-model" aria-label="Robert model"><\/select>/);
  assert.match(html, /api\("\/agent\/model", \{ method: "POST", body: JSON\.stringify\(\{ model \}\) \}\)/);
  assert.match(html, /data-reset/);
  assert.match(html, /data-speed=/);
});

test("new terminal sheet still matches the Desk: CLI, model, where, kind, blank, lead", () => {
  assert.match(html, /function newTermSheet\(wsId\) \{[\s\S]*?const b = sheet\(/);
  for (const id of ["f-backend", "f-model", "f-cwd", "f-kind", "f-lead", "f-blank"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /store\.set\("desk-backend:"/);
  assert.match(html, /store\.set\("desk-model:"/);
  assert.match(html, /\.\.\.\(opts\.lead \? \{ role: "lead" \} : \{\}\)/);
});

test("the talk button: a tap opens the hands-free call inside the gesture, a hold is push-to-talk", () => {
  assert.match(html, /<script src="\/phone-voice\.js"><\/script>/);
  assert.match(html, /talk\.addEventListener\("click", \(\) => \{[\s\S]*?callStart\(\);/);
  assert.match(html, /function callStart\(\) \{[\s\S]*?PhoneVoice\.start\(\)/);
  assert.match(html, /holdT = setTimeout\(\(\) => \{ held = true; fx\.tick\(\); voiceStart\(talk, dictateInto\(rComposer, \(\) => askRobert\(\)\), true\); \}, 380\);/);
  // A turn said on the call is a voice turn (Robert answers short) and its sentences are spoken.
  assert.match(html, /if \(el\._voice\) body\.voice = true;/);
  assert.match(html, /if \(e\.topic === "agent\.delta" && PhoneVoice\.on && e\.client === CLIENT\) PhoneVoice\.delta\(e\);/);
  assert.match(html, /if \(PhoneVoice\.on && e\.reply && \(mine \|\| !e\.you\)\) PhoneVoice\.final\(e, mine\);/);
  // A card on screen gets the words first — with the call's clock (when the words started, whether
  // the page was playing) so a yes over its own audio is not a yes; "let's see" opens the deck.
  assert.match(html, /onHeard: \(text, meta\) => \{/);
  assert.match(html, /if \(PhoneDeck\.voiceAnswer\(text, meta\)\) return;/);
  // A held spoken approval stops on "stop", on any barge-in, and on hanging up.
  assert.match(html, /onStopTurn: \(\) => \{ PhoneDeck\.cancelHold\(\);/);
  assert.match(html, /onBarge: \(\) => PhoneDeck\.onBarge\(\),/);
  assert.match(html, /if \(!on\) \{ callSub = ""; R\.pick = null; PhoneDeck\.cancelHold\(true\); \}/);
  // Its on-screen Cancel can outlast a plain 5 s toast (the deck asks for the whole window).
  assert.match(html, /act\?\.ms \|\| \(act \? 5000 : 2400\)/);
  // What the call says to open the deck carries no yes-word (it could come back through the mic).
  assert.match(html, /Decí «veamos» para verla\./);
  assert.match(html, /const VIEW_RE = /);
});

test("stuck work reaches a live call through the ONE shared client (static/voice-alerts.js), no inlined copy", () => {
  assert.match(html, /<script src="\/voice-alerts\.js"><\/script>\s*<script src="\/phone-voice\.js"><\/script>/);
  assert.match(html, /const VA = VoiceAlerts\.create\(\{\s*client: CLIENT, surface: "phone", lang: \(\) => voiceLang\(\), lock: \(\) => null,/);
  assert.match(html, /function presence\(live\) \{ presT = live \? 1 : 0; VA\.presence\(!!live\); \}/);
  assert.match(html, /"alert\.raised"/);
  assert.match(html, /const a = VA\.take\(e, PhoneVoice\.on\);/);
  assert.match(html, /onStart: a\.started \}\)\.then\(\(played\) => \{\s*if \(played\) a\.done\(\);/);
  // The copy that used to live here is gone: the contract is in one file only.
  assert.doesNotMatch(html, /api\("\/alerts\/" \+ encodeURIComponent\(e\.alert_id\)/);
  assert.doesNotMatch(html, /presT = setInterval/);
});

test("he can keep talking while Robert works: his lines show at once and go as ONE follow-up when the turn ends", () => {
  // Spoken or typed while busy: drawn now as his bubble, queued (askRobert), never dropped.
  assert.match(html, /if \(R\.busy \|\| !navigator\.onLine\) \{ el\.classList\.add\("queued"\); R\.outbox\.push\(\{ text, el, quote \}\);/);
  // The engine's busy() only paints "thinking" — the page still hands every transcript over.
  assert.match(html, /4\. Everything else|5\. Everything else is a turn for Robert/);
  const src = html.slice(html.indexOf("function takeNext() {"));
  const body = src.slice(0, src.indexOf("\n}\n") + 3);
  const takeNext = new Function("R", body + "; return takeNext;");
  const el = () => ({ classList: { remove() {} }, _voice: true });
  const R: any = { outbox: [{ text: "y además", el: el(), quote: null }, { text: "lo del export", el: el(), quote: null }, { text: "otra cosa", el: el(), quote: { id: 1 } }] };
  const next = takeNext(R)();
  assert.equal(next.text, "y además\nlo del export", "consecutive lines join into one turn");
  assert.equal(R.outbox.length, 1, "a quoted reply stays its own turn");
  assert.match(html, /const next = navigator\.onLine \? takeNext\(\) : null;/);
});

test("a tap on the call screen stops him at once; the call trace goes up at hang-up and from ⋯", () => {
  assert.match(html, /qs\("#call"\)\.addEventListener\("click", \(e\) => \{/);
  assert.match(html, /if \(PhoneVoice\.tapStop\(\)\) fx\.tap\(\);/);
  assert.match(html, /onTrace: \(dump\) => \{ sendTrace\(dump\); \}/);
  assert.match(html, /api\("\/voice\/trace", \{ method: "POST"/);
  assert.match(html, /<button data-m="trace">/);
  // A failed turn of his is said, not left as a spinner.
  assert.match(html, /String\(e\.reply \|\| ""\)\.startsWith\("⚠️"\)\) \{ PhoneVoice\.waitDone\(\); PhoneVoice\.say\(/);
  assert.match(html, /PhoneVoice\.waiting\(r\.turn\)/);
});

test("voice goes to the Mac: push-to-talk posts raw audio to /api/transcribe with the admin token", () => {
  assert.match(html, /fetch\("\/api\/transcribe" \+ \(PREFS\.lang \? "\?lang=" \+ PREFS\.lang : ""\), \{ method: "POST"/);
  assert.match(html, /"x-mc-admin": TOKEN/);
  assert.match(html, /new MediaRecorder\(stream/);
  assert.match(html, /async function micReady\(\)/);
  assert.match(html, /audioBitsPerSecond: 32000/);
  assert.match(html, /if \(total > 1800\) toast/);
  assert.doesNotMatch(html, /webkitSpeechRecognition|SpeechRecognition\(/, "no cloud speech API");
});

test("push-to-talk: ✕ cancels, a failed transcribe keeps the audio, the screen stays awake", () => {
  assert.match(html, /function talkMic\(mic, onText, sends = \(\) => false\)/);
  assert.match(html, /finishing = V\.state === "rec" && V\.mic === mic;/);
  assert.doesNotMatch(html, /addEventListener\("pointerleave"/, "drifting off the button must not end a recording");
  assert.match(html, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(html, /id="rb-cancel"/);
  assert.match(html, /if \(!V\.keep\) \{ voiceReset\(\); return toast\("cancelled"\); \}/);
  assert.match(html, /if \(V\.state === "busy"\) return V\.ctl\?\.abort\(\);/);
  assert.match(html, /if \(V\.state === "failed"\) transcribe\(\);/);
  assert.match(html, /if \(PhoneVoice\.on\) PhoneVoice\.deaf\(true\);/, "on a call the ear is deaf while you dictate");
});

test("Robert: one routed thread, the answer comes off the bus, an outbox for lines typed mid-turn", () => {
  assert.match(html, /const body = \{ text, client: CLIENT, surface: "phone" \};/);
  assert.match(html, /api\("\/agent", \{ method: "POST", body: JSON\.stringify\(body\) \}\)/);
  assert.match(html, /api\("\/agent\/history\?limit=40&ws=all"\)/);
  assert.match(html, /DOMPurify\.sanitize\(marked\.parse/);
  assert.match(html, /if \(ws !== undefined\) \{ body\.ws = ws; body\.route = false; \}/);
  assert.match(html, /if \(r\?\.how === "ask"\) \{ dropMine\(\); setPending\(null\); robWork\(false\); askWhere\(r, text, quote, el\._voice\); return; \}/);
  assert.match(html, /const ourThread = \(ws\) => !String\(ws \|\| ""\)\.startsWith\("agent:"\);/);
  assert.match(html, /if \(!e\.text \|\| \(e\.kind && e\.kind !== "text"\) \|\| !\(mine \|\| ourThread\(e\.ws\)\)\) return;/);
  assert.match(html, /let b = R\.pend\.get\(key\);/);
  assert.match(html, /R\.pend\.set\(r\.turn, b\); R\.mine = null; R\.pend\.delete\("\?"\)/);
  assert.match(html, /robAwait\(r\.turn\); hold = true; return;/);
  assert.match(html, /R\.outbox\.push\(\{ text, el, quote, ws: picked \}\)/);
  assert.match(html, /if \(next\) deliverRobert\(next\.text, next\.el, next\.ws, next\.quote\);/);
  assert.match(html, /const streamed = R\.pend\.get\(e\.turn \|\| "\?"\);/);
  assert.match(html, /streamed\.className = "bub rob";/);
  assert.doesNotMatch(html, /qs\("#r-send"\)\.disabled = true/, "the send button is never disabled while he answers");
  assert.match(html, /\.bub\.you\.queued \{ opacity:\.55; \}/);
  assert.match(html, /function mdRob\(text\)/);
  assert.match(html, /a\[href\^="#sel="\]/);
  assert.doesNotMatch(html, /a\.op === "select"|a\.op === "focus_terminal"/, "nothing he says moves the operator's screen");
});

test("the thread survives a reload and a dropped link: cache first, a line in flight is kept, never resent on its own", () => {
  assert.match(html, /store\.set\("phone-thread", JSON\.stringify\(rows\.slice\(-40\)/);
  assert.match(html, /const cached = loadThread\(\);/);
  assert.match(html, /function setPending\(p\) \{ R\.pending = p; if \(p\) store\.set\("phone-pending"/);
  assert.match(html, /const row = rows\.find\(\(m\) => m\.id > \(p\.after \|\| 0\) && norm\(m\.you\) === want\);/);
  assert.match(html, /function unsentCheck\(el, text\)/);
  assert.match(html, /tr\("¿No le llegó\? Reenviar", "Didn't reach him\? Resend"\)/);
  // With the socket down but HTTP up, a turn's answer still arrives.
  assert.match(html, /if \(!S\.busOpen && navigator\.onLine && TOKEN && \(R\.awaitTurn \|\| R\.pending\)\) robertHistory\(\);/);
  // Offline: lines wait in the outbox and go when the link is back.
  assert.match(html, /if \(R\.busy \|\| !navigator\.onLine\) \{ el\.classList\.add\("queued"\); R\.outbox\.push\(\{ text, el, quote \}\);/);
  assert.match(html, /store\.set\("phone-draft", rComposer\.value\)/);
});

test("the approval deck is one module, opened from the entry, a deep link, or by voice", () => {
  assert.match(html, /<script src="\/phone-deck\.js"><\/script>/);
  assert.match(html, /<div id="v-deck" class="deck" hidden><\/div>/);
  assert.match(html, /PhoneDeck\.init\(\{/);
  assert.match(html, /qs\("#qentry"\)\.onclick = \(\) => \{ fx\.tap\(\); PhoneDeck\.open\(\); \};/);
  assert.match(html, /compose: composeSheet,/);
  // The Ask widget still embeds Robert's question cards in the thread.
  assert.match(html, /<script src="\/ask-card\.js"><\/script>/);
  assert.match(html, /AskCard\.init\(\{ api, toast, sessions: \(\) => S\.sessions, askOf, who: \(s\) => sTitle\(s\)\.slice\(0, 40\), log: chatEl \}\);/);
});

test("bus socket follows the page scheme; the token rides the same localStorage key as the Desk", () => {
  assert.match(html, /const WS_SCHEME = location\.protocol === "https:" \? "wss:" : "ws:"/);
  assert.match(html, /\$\{WS_SCHEME\}\/\/\$\{location\.host\}\/ws\?token=/);
  assert.match(html, /store\.get\("mc-token"\)/);
  assert.doesNotMatch(html, /\/term\?id=/);
  assert.doesNotMatch(html, /xterm\.css|new Terminal\(|disableStdin/);
});

test("api() rides out a tunnel blip: one retry on a failed GET, never on a write", () => {
  assert.match(html, /const method = \(opts\?\.method \|\| "GET"\)\.toUpperCase\(\);/);
  assert.match(html, /method === "GET" && err instanceof TypeError \? new Promise\(\(r\) => setTimeout\(r, 1200\)\)\.then\(send\) : Promise\.reject\(err\)/);
});

test("feedback is synthesized, gated behind a gesture, and mutable", () => {
  assert.match(html, /new \(window\.AudioContext \|\| window\.webkitAudioContext\)/);
  assert.doesNotMatch(html, /<audio|\.mp3|\.wav|\.ogg"/, "no audio files to fetch through the tunnel");
  assert.match(html, /document\.addEventListener\("pointerdown", unlock/);
  assert.match(html, /store\.set\("phone-fx"/);
  assert.match(html, /row\("fx", "Sounds & haptics"/);
});

test("every sheet can be dragged down to dismiss, and has an ✕", () => {
  assert.match(html, /<button class="x" data-x aria-label="Close">/);
  assert.match(html, /sh\.addEventListener\("touchmove"/);
  assert.match(html, /if \(dy > 110 \|\| flick\) \{ fx\.tap\(\); closeSheet\(true, sh, bg\); \}/);
});

test("no raw PTY on the phone: one terminal's story (Focus) behind ⋯ → Terminals", () => {
  assert.doesNotMatch(html, /id="v-term"/);
  assert.doesNotMatch(html, /vendor\/xterm/);
  assert.match(html, /function detach\(\) \{\}/);
  assert.match(html, /function openTerm\(id\) \{ if \(id\) openFocus\(id\); \}/);
  assert.match(html, /api\("\/sessions\/" \+ id \+ "\/focus"\)/);
  assert.match(html, /"focus\.event"\]\.join\(","\)/);
  assert.match(html, /const after = \(e\) => !!e && \(!lastUser \|\| e\.seq > lastUser\.seq\);/);
  assert.match(html, /lbl: "Previous result"/);
  assert.match(html, /const QUEUE = new Set\(\["blocked", "waiting", "done"\]\);/);
  assert.match(html, /input\(id, \{ text: v, enter: true \}\)/);
  assert.match(html, /advance\(s\.id, "closed", \{ label: "Undo", fn: \(\) => reopen\(s\.id\) \}\)/);
  assert.match(html, /const leadLive = \(id\) => !!id && S\.sessions\.some\(\(x\) => x\.id === id && x\.live\);/);
  assert.match(html, /const isWorker = \(s\) => leadLive\(s\.lead_id\);/);
  assert.match(html, /const live = S\.sessions\.filter\(\(s\) => s\.live && !isWorker\(s\)\)\.sort\(byRank\);/);
  // A hand-off waiting for his yes shows in the story with a way to the card.
  assert.match(html, /Waiting for your yes/);
  assert.match(html, /window\.addEventListener\("pageshow", \(e\) => \{ if \(e\.persisted\) resume\(\); \}\)/);
  assert.match(html, /window\.addEventListener\("online", /);
});

test("history only where it is safe: iOS home-screen apps lose the mic on navigation, so iOS gets none", () => {
  assert.match(html, /const USE_HISTORY = !IOS;/);
  assert.match(html, /if \(!USE_HISTORY\) return;/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /if \(USE_HISTORY && !history\.state\?\.sheet\) history\.pushState/);
});

test("deep links: read once at launch, then the worker POSTS the link to an open app instead of navigating", () => {
  assert.match(html, /if \(h\.startsWith\("a="\)\)/);
  assert.match(html, /if \(h\.startsWith\("s="\)\)/);
  assert.match(html, /const key = PhoneDeck\.forSession\(id\);/);
  assert.match(html, /navigator\.serviceWorker\?\.addEventListener\("message"/);
  assert.match(html, /e\.ports\?\.\[0\]\?\.postMessage\(\{ ok: true \}\)/);
  assert.match(sw, /c\.postMessage\(\{ type: "open", url \}, \[ch\.port2\]\)/);
  assert.match(sw, /if \(!heard\) \{ try \{ await c\.navigate\(url\); \} catch \{\} \}/);
});

test("push: registered at root scope, the token handed to the worker, and turning it on is one clear step every launch", () => {
  assert.match(html, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(html, /postMessage\(\{ type: "token", token: TOKEN \}\)/);
  assert.match(html, /applicationServerKey: b64\(publicKey\)/);
  assert.match(html, /api\("\/push\/subscribe", \{ method: "POST", body: JSON\.stringify\(\{ subscription: sub\.toJSON\(\) \}\)/);
  assert.match(html, /navigator\.setAppBadge\?\.\(n\)/);
  assert.match(html, /<div class="nrow" id="nrow" hidden>/);
  assert.match(html, /PUSH\.ready\(\)\.then\(checkPush\);/);
  assert.match(html, /checkBuild\(\);\n  checkPush\(\);/, "re-checked when the app comes back");
  assert.match(html, /"Add Robert to your Home Screen"/, "iPhone only pushes to home-screen apps");
});

test("the worker: shell for offline (every script the page loads), answers from the tray, alerts acked on tap", () => {
  for (const f of ["/phone-voice.js", "/phone-deck.js", "/ask-card.js", "/artifact-view.js", "/chat-reply.js", "/vendor/marked.min.js", "/vendor/purify.min.js"]) {
    assert.match(sw, new RegExp(`"${f.replace(/[./]/g, (c) => "\\" + c)}"`), f);
    if (!f.startsWith("/vendor")) assert.match(html, new RegExp(`<script src="${f.replace(/[./]/g, (c) => "\\" + c)}"></script>`), f);
  }
  assert.match(sw, /fetch\("\/api\/sessions\/" \+ d\.session_id \+ "\/input"/);
  assert.match(sw, /\(p\.actions \|\| \[\]\)\.slice\(0, 2\)/, "Android shows two buttons");
  assert.match(sw, /res\.ok && res\.status === 200 && res\.type === "basic" && !res\.redirected/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)/);
  assert.match(sw, /if \(e\.request\.headers\.has\("range"\)\) return;/, "the build check never hits the cache");
  assert.match(sw, /const VERSION = "v16"/);
  assert.match(sw, /if \(d\.alert_id\) \{/, "a stuck-work alert is acknowledged by the tap (src/stuck-alerts.ts)");
  assert.match(sw, /p\.url = "\/phone#a=" \+ encodeURIComponent\(p\.item\)/);
});

test("never on a stale build: the page reads the served stamp on resume and reloads when quiet", () => {
  assert.match(html, /<meta name="chronos-build" content="[0-9a-z-]+">/);
  assert.match(html, /fetch\("\/phone\.html", \{ cache: "no-store", headers: \{ Range: "bytes=0-2047" \} \}\)/);
  assert.match(html, /const quiet = \(\) => !PhoneVoice\.on && !V\.state && !rComposer\.value\.trim\(\)/);
  assert.match(html, /data-reload/);
  assert.match(html, /qs\("#upd"\)\.hidden = false;/);
});

test("the keyboard and the notch: the app follows the visual viewport; safe areas on every side", () => {
  assert.match(html, /const vv = window\.visualViewport/);
  assert.match(html, /app\.style\.height = Math\.round\(vv\.height\) \+ "px";/);
  assert.match(html, /body\.kb \{ --sab:0px; \}/);
  assert.match(html, /--sal:env\(safe-area-inset-left,0px\); --sar:env\(safe-area-inset-right,0px\);/);
});

test("plain words in front of him: no ids, no workspace machinery, no internal states on the conversation", () => {
  const front = html.slice(html.indexOf('<div id="v-home"'), html.indexOf('<div id="v-deck"'));
  assert.doesNotMatch(front, /workspace|session|stall|wake/i);
});

test("the Desk reasserts its pane sizes when the window comes back (the phone used to resize the shared pty)", () => {
  const desk = read("static/desk.html");
  assert.match(desk, /pane\.forceSize = \(\) => \{ sentCols = sentRows = 0; sendSize\(\); \}/);
  assert.match(desk, /window\.addEventListener\("focus", \(\) => \{ for \(const \[, p\] of S\.panes\)/);
  assert.match(desk, /const NOTIFY_MAX = 3;/);
});
