/**
 * The phone surface (static/phone.html) is plain HTML with no build step, so the regressions this
 * guards are attributes and strings in the shipped file: the PWA hooks a phone needs to install it,
 * the scheme-aware sockets it needs behind the HTTPS tunnel, and the keys the composer must offer
 * because a phone keyboard has none of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "static/phone.html"), "utf8");

test("installs as a PWA: manifest, icon, standalone hints, keyboard-aware viewport", () => {
  assert.match(html, /<link rel="manifest" href="\/phone\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/phone-icon\.png">/);
  assert.match(html, /name="mobile-web-app-capable" content="yes"/);
  assert.match(html, /interactive-widget=resizes-content/);
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "static/phone.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "/phone");
  assert.equal(manifest.display, "standalone");
  assert.ok(fs.existsSync(path.join(process.cwd(), "static/phone-icon.png")));
});

test("sockets follow the page scheme and the token rides the same localStorage key as the Desk", () => {
  assert.match(html, /const WS_SCHEME = location\.protocol === "https:" \? "wss:" : "ws:"/);
  assert.match(html, /\$\{WS_SCHEME\}\/\/\$\{location\.host\}\/term\?id=/);
  assert.match(html, /\$\{WS_SCHEME\}\/\/\$\{location\.host\}\/ws\?token=/);
  assert.match(html, /localStorage\.getItem\("mc-token"\)/);
});

test("api() rides out a tunnel blip: one retry on a failed GET, never on a write", () => {
  assert.match(html, /const method = \(opts\?\.method \|\| "GET"\)\.toUpperCase\(\);/);
  assert.match(html, /method === "GET" && err instanceof TypeError \? new Promise\(\(r\) => setTimeout\(r, 1200\)\)\.then\(send\) : Promise\.reject\(err\)/);
});

test("the composer owns input: xterm stdin is off and the key bar covers what a phone keyboard lacks", () => {
  assert.match(html, /disableStdin: true/);
  for (const k of ['data-key="enter"', 'data-key="esc"', 'data-key="tab"', 'data-key="ctrl-c"', 'data-key="up"', 'data-key="down"']) {
    assert.ok(html.includes(k), `key bar has ${k}`);
  }
  assert.match(html, /id="qk-ctrl"/);
  // Typed text goes through POST /sessions/:id/input with enter:true — the daemon sends Enter on its
  // own tick. "text\r" in one socket burst never submits in a bracketed-paste TUI (Claude Code).
  assert.match(html, /input\(S\.current, \{ text: v, enter: true \}\)/);
  assert.doesNotMatch(html, /sendRaw\(v \+ "\\r"\)/);
});

test("voice goes to the Mac: the mic posts raw audio to /api/transcribe with the admin token", () => {
  assert.match(html, /fetch\("\/api\/transcribe" \+ \(PREFS\.lang \? "\?lang=" \+ PREFS\.lang : ""\), \{ method: "POST"/);
  assert.match(html, /"x-mc-admin": TOKEN/);
  assert.match(html, /new MediaRecorder\(stream/);
  assert.doesNotMatch(html, /webkitSpeechRecognition|SpeechRecognition\(/, "no cloud speech API");
});


test("Robert: the desk-wide manager is one tap from home, with the same thread as the Desk", () => {
  assert.match(html, /id="btn-robert"/);
  assert.match(html, /const body = \{ text, client: CLIENT \};/);
  assert.match(html, /api\("\/agent", \{ method: "POST", body: JSON\.stringify\(body\) \}\)/);
  assert.match(html, /api\("\/agent\/history\?limit=20&ws=" \+ encodeURIComponent\(R\.ws \|\| "all"\)\)/);
  assert.match(html, /talkMic\(qs\("#r-mic"\)/);
  // His replies are markdown from a model: sanitized before they touch the DOM.
  assert.match(html, /DOMPurify\.sanitize\(marked\.parse/);
});

test("the Desk reasserts its pane sizes when the window comes back (the phone resized the shared pty)", () => {
  const desk = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(desk, /pane\.forceSize = \(\) => \{ sentCols = sentRows = 0; sendSize\(\); \}/);
  assert.match(desk, /window\.addEventListener\("focus", \(\) => \{ for \(const \[, p\] of S\.panes\)/);
});

test("feedback is synthesized, gated behind a gesture, and mutable", () => {
  assert.match(html, /new \(window\.AudioContext \|\| window\.webkitAudioContext\)/);
  assert.doesNotMatch(html, /<audio|\.mp3|\.wav|\.ogg"/, "no audio files to fetch through the tunnel");
  assert.match(html, /document\.addEventListener\("pointerdown", unlock/);
  assert.match(html, /localStorage\.setItem\("phone-fx"/);
  assert.match(html, /row\("fx", "Sounds & haptics"/);
  // The one sound that fires without a touch: a terminal flipping to needs-you, once per flip.
  assert.match(html, /if \(was === "working" && s\.state === "waiting" && !s\.status\) fx\.needsYou\(\)/);
  assert.match(html, /if \(was !== e\.status\.phase && \["blocked", "decide", "your_turn"\]\.includes\(e\.status\.phase\)\) fx\.needsYou\(\);/);
});

test("every sheet can be dragged down to dismiss, and has an ✕", () => {
  assert.match(html, /<button class="x" data-x aria-label="Close">/);
  assert.match(html, /sh\.addEventListener\("touchmove"/);
  assert.match(html, /if \(dy > 110 \|\| flick\) \{ fx\.tap\(\); closeSheet\(true, sh, bg\); \}/);
  // The composer sheet used to be the one with no Cancel: same generic sheet() now, so it inherits both.
  assert.match(html, /function newTermSheet\(wsId\) \{[\s\S]*?const b = sheet\(/);
});

test("answer chips on the card go through the input door; a select's extra options open the terminal", () => {
  assert.match(html, /data-ans="yn:y"/);
  assert.match(html, /data-ans="continue"/);
  assert.match(html, /if \(a\.startsWith\("opt:"\)\) \{ const o = s\?\.prompt\?\.options\?\.\[Number\(a\.slice\(4\)\)\]; return o \? input\(id, optionBody\(o\)\) : openFocus\(id\); \}/);
  // Cards hold buttons now, so they can no longer be <button>s themselves.
  assert.doesNotMatch(html, /<button class="\$\{cls\}" data-open/);
  assert.match(html, /<div class="\$\{cls\}" role="button" tabindex="0" data-open/);
});




test("Robert on the phone is one routed chat: the strip only filters, and his answer comes off the bus", () => {
  // No conversation picker: a line carries a ws only when you tapped a project on his "which one?".
  assert.match(html, /if \(ws !== undefined\) \{ body\.ws = ws; body\.route = false; \}/);
  assert.match(html, /if \(r\?\.how === "ask"\) \{ dropMine\(\); askWhere\(r, text\); return; \}/);
  // The strip filters what you see; your own turns show through it.
  assert.match(html, /const ourThread = \(ws\) => !String\(ws \|\| ""\)\.startsWith\("agent:"\) && \(!R\.ws \|\| \(ws \|\| null\) === R\.ws\);/);
  assert.match(html, /if \(!e\.text \|\| \(e\.kind && e\.kind !== "text"\) \|\| !\(mine \|\| ourThread\(e\.ws\)\)\) return;/);
  // One bubble per turn: a second turn streaming at once never cuts or mixes into yours.
  assert.match(html, /let b = R\.pend\.get\(key\);/);
  // A request the tunnel dropped mid-turn waits for the push instead of failing.
  assert.match(html, /if \(err instanceof TypeError \|\| \[502, 503, 504, 520, 521, 522, 523, 524\]\.includes\(err\.status\)\) \{\s*R\.lost = true;/);
  assert.match(html, /if \(R\.lost\) \{ R\.lost = false; R\.loaded = false;/);
  assert.match(html, /TagComplete\(rComposer, \(\) => S\.workspaces\);/);
  assert.match(html, /id="rstrip"/);
});

test("push: the page registers the worker at root scope, hands it the token, and reads deep links", () => {
  assert.match(html, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(html, /postMessage\(\{ type: "token", token: TOKEN \}\)/);
  assert.match(html, /applicationServerKey: b64\(publicKey\)/);
  assert.match(html, /api\("\/push\/subscribe", \{ method: "POST", body: JSON\.stringify\(\{ subscription: sub\.toJSON\(\) \}\)/);
  assert.match(html, /if \(h\.startsWith\("s="\)\)/);
  assert.match(html, /navigator\.setAppBadge\?\.\(n\)/);
  const sw = fs.readFileSync(path.join(process.cwd(), "static/sw.js"), "utf8");
  // A notification button types through the same door as the page; the body tap opens the terminal.
  assert.match(sw, /fetch\("\/api\/sessions\/" \+ d\.session_id \+ "\/input"/);
  assert.match(sw, /\(p\.actions \|\| \[\]\)\.slice\(0, 2\)/, "Android shows two buttons");
  // Never cache anything that is not a clean 200 from our origin: an Access login redirect must not become the shell.
  assert.match(sw, /res\.ok && res\.type === "basic" && !res\.redirected/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)/);
});

test("Plan Tomorrow posts the Desk's own /nextday shape, defaults to the next workday, remembers the ticked clients", () => {
  assert.match(html, /id="btn-tomorrow"/);
  assert.match(html, /api\("\/nextday", \{ method: "POST", body: JSON\.stringify\(\{ workspaces, steering, date: qs\("#plan-date", b\)\.value \}\)/);
  assert.match(html, /if \(d\.getHours\(\) >= 4\) d\.setDate\(d\.getDate\(\) \+ 1\);/);
  assert.match(html, /localStorage\.setItem\("mc-plan-ws", JSON\.stringify\(workspaces\)\)/);
  // Steering can be spoken: one mic per client row.
  assert.match(html, /talkMic\(qs\("\.mic", row\), \(text\) =>/);
});

test("terminal touch: our own scroll + swipe in capture phase, xterm never sees a touch", () => {
  assert.match(html, /wrap\.addEventListener\("touchmove", \(e\) => \{\s*stop\(e\);/);
  assert.match(html, /term\.scrollLines\(-rows\)/);
});

test("the TUI's own input box is cropped unless it is showing a menu or y/n", () => {
  assert.match(html, /const BOX_ROWS = 4;/);
  assert.match(html, /function measureBox\(\)/);
  assert.match(html, /if \(!\(PREFS\.hideBox && s\?\.live && !dialog\)\) return \(lastCrop = 0\);/);
  // Follow the box as it grows (a wrapped draft) but a refit is a pty resize that drops the TUI's
  // scroll: only after the measurement held for a while, never around a touch, and a box that is
  // momentarily off screen (scrolled up, streaming) keeps the last crop instead of flipping to 0.
  assert.match(html, /if \(s1 < 0 \|\| prompt < 0\) return null;/);
  assert.match(html, /return \(lastCrop = settledCrop\);/);
  assert.match(html, /if \(!force && Date\.now\(\) - lastTouch < 2000\)/);
  assert.match(html, /Date\.now\(\) - cropSince < 1200 \|\| Date\.now\(\) - lastTouch < 2000/);
  assert.match(html, /host\.style\.bottom = -\(crop \* cell\) \+ "px";/);
  assert.match(html, /row\("hidebox", "Hide the terminal's input box"/);
});

test("back gesture: screens and sheets are history entries; back lands on home, not outside the app", () => {
  assert.match(html, /history\.pushState\(\{ view, depth: 1 \}, "", location\.pathname\)/);
  // The raw terminal stacks over the story (depth 2): back returns to the story, a second back to home.
  assert.match(html, /history\.pushState\(\{ view, depth: depth \+ 1 \}, "", location\.pathname\)/);
  assert.match(html, /if \(st\?\.view === "v-focus" && S\.current && qs\("#v-focus"\)\.hidden\)/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /history\.pushState\(\{ \.\.\.\(history\.state \|\| \{\}\), sheet: true \}/);
  assert.match(html, /if \(had && history\.state\?\.sheet\) history\.back\(\);/);
});

test("nothing inside the terminal can take focus (the soft keyboard must never open on a tap)", () => {
  assert.match(html, /ta\.disabled = true;/);
  assert.match(html, /\.term-host \.xterm \* \{ pointer-events:none; \}/);
  assert.match(html, /wrap\.addEventListener\("focusin"/);
  assert.match(html, /<meta name="chronos-build" content="[0-9a-z-]+">/);
  assert.match(html, /data-reload/);
});

test("a finger drag scrolls the TUI the way a mouse wheel would when it has mouse tracking on", () => {
  // Claude Code: alternate screen + SGR mouse tracking, so xterm has no scrollback to move — the
  // app scrolls itself from wheel reports. Row of travel → one report at the finger's cell.
  assert.match(html, /const mode = term\.modes\?\.mouseTrackingMode \|\| "none";/);
  assert.match(html, /if \(mode !== "none"\) return wheel\(rows > 0, Math\.min\(Math\.abs\(rows\), 12\)\);/);
  assert.match(html, /`\\x1b\[<\$\{btn\};\$\{col\};\$\{row\}M`/);
  assert.match(html, /const btn = up \? 64 : 65;/);
  // Alternate screen without tracking: pages of travel become PgUp/PgDn; normal screen: xterm's own scrollback.
  assert.match(html, /"\\x1b\[5~" : "\\x1b\[6~"/);
  assert.match(html, /term\.scrollLines\(-rows\);/);
});

test("a dead terminal socket reconnects on its own and resume paths reattach", () => {
  assert.match(html, /qs\("#term-off-msg"\)\.textContent = "Reconnecting…"/);
  assert.match(html, /reconnDelay = Math\.min\(reconnDelay \* 2, 10000\)/);
  assert.match(html, /window\.addEventListener\("pageshow", \(e\) => \{ if \(e\.persisted\) resume\(\); \}\)/);
  assert.match(html, /window\.addEventListener\("online", resume\)/);
  // No replay within 1.5s of opening → ask the pty for a frame rather than sit on a black pane.
  assert.match(html, /sock\.send\(JSON\.stringify\(\{ t: "refresh" \}\)\)/);
});

test("voice: one warm mic stream, 32 kbps opus, timings surfaced when slow", () => {
  assert.match(html, /async function micReady\(\)/);
  assert.match(html, /audioBitsPerSecond: 32000/);
  assert.match(html, /if \(total > 1800\) toast/);
  assert.doesNotMatch(html, /stream\?\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\); stream = null;/, "the shared stream is not torn down per hold");
});

test("voice: tap once and it keeps listening — screen awake, ✕ cancels, a failed transcribe keeps the audio", () => {
  // Latch, not hold: a tap starts it, a second tap or the bar's button finishes; a long press still finishes on release.
  assert.match(html, /function talkMic\(mic, onText, sends = \(\) => false\)/);
  assert.match(html, /finishing = V\.state === "rec" && V\.mic === mic;/);
  assert.match(html, /Date\.now\(\) - downAt >= HOLD_MS\) voiceFinish\(\)/);
  assert.doesNotMatch(html, /addEventListener\("pointerleave"/, "drifting off the button must not end a recording");
  // The phone must not lock mid-sentence, and the page hiding must not kill an open recording.
  assert.match(html, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(html, /if \(document\.hidden\) \{ if \(!V\.state\) micRelease\(\); \}/);
  // Cancel works while listening (discard) and while transcribing (abort the upload).
  assert.match(html, /id="rb-cancel"/);
  assert.match(html, /if \(!V\.keep\) \{ voiceReset\(\); return toast\("cancelled"\); \}/);
  assert.match(html, /if \(V\.state === "busy"\) return V\.ctl\?\.abort\(\);/);
  assert.match(html, /signal: V\.ctl\.signal/);
  // A failed transcribe keeps the blob and offers Retry instead of dropping what was said.
  assert.match(html, /if \(V\.state === "failed"\) transcribe\(\);/);
});

test("the Desk nags at most three times per terminal until you answer, open it, or focus the window", () => {
  const desk = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(desk, /const NOTIFY_MAX = 3;/);
  assert.match(desk, /if \(n >= NOTIFY_MAX\) return;/);
  assert.match(desk, /S\.answered\.set\(id, Date\.now\(\)\); S\.notifyCount\.delete\(id\);/);
  assert.match(desk, /function select\(id, opts = \{\}\) \{\n  S\.notifyCount\.delete\(id\);/);
  assert.match(desk, /S\.notified\.clear\(\); S\.notifyCount\.clear\(\);/);
});

test("focus screen: the story is the default way into a terminal, the transcript is one tap away", () => {
  // Tapping a card, a notification, a fresh spawn or a reopen all land on the story, never on xterm.
  assert.match(html, /if \(t\.dataset\.open\) \{ fx\.tap\(\); return openFocus\(t\.dataset\.open\); \}/);
  assert.match(html, /if \(byId\(id\)\) openFocus\(id\); else toast\("that terminal is gone"\)/);
  assert.match(html, /if \(id\) openFocus\(id\);/);
  assert.match(html, /qs\("#f-raw"\)\.onclick = \(\) => \{ fx\.tap\(\); openTerm\(F\.id\); \};/);
  // Built from what the daemon already has: the /desk row and the focus feed. No pty is attached.
  assert.match(html, /api\("\/sessions\/" \+ id \+ "\/focus"\)/);
  assert.match(html, /"focus\.event"\]\.join\(","\)/);
  assert.match(html, /function openFocus\(id, dir\) \{\n  const s = byId\(id\); if \(!s\) return toast\("not found"\);\n  const fromScreen = !!S\.current;\n  detach\(\);/);
  // The headline must be newer than your last message: a fresh Result, else the agent's latest
  // message since yours, else the old Result labelled as previous. Never a stale "Result".
  assert.match(html, /const after = \(e\) => !!e && \(!lastUser \|\| e\.seq > lastUser\.seq\);/);
  assert.match(html, /const freshRes = after\(res\) \? res : null;/);
  assert.match(html, /lbl: "Latest"/);
  assert.match(html, /lbl: "Previous result"/);
  assert.match(html, /lbl: "Summary", text: s\.summary/);
  assert.match(html, /if \(und && after\(und\) && !freshRes && !latest\)/);
  // The goal is the title everywhere; what you typed to start it is a subline.
  assert.match(html, /const goalTitle = \(s\) => s\.goal \|\| sTitle\(s\);/);
  assert.match(html, /started as: \$\{esc\(clip\(started, 200\)\)\}/);
  // One vocabulary on every screen; a finished turn's "question" is the status bar and never shows.
  assert.match(html, /return !p \|\| p\.kind === "turn" \? "Turn finished" : "Waiting for you";/);
  assert.match(html, /if \(!p \|\| p\.kind === "turn"\) return null;/);
  assert.match(html, /<span>\$\{s\.live \? `<span class="ph \$\{ph\}">\$\{esc\(stateWord\(s\)\)\}<\/span>/);
  // Story markdown is model output: sanitized the same way Robert's replies are; links open new tabs.
  assert.match(html, /md\(open \? text : headTail\(text\)\)/);
  assert.match(html, /a\.target = "_blank"; a\.rel = "noopener";/);
  // Your own lines lose the TUI chrome and the harness notifications; tool runs fold to a count.
  assert.match(html, /const cleanUser = \(t\) => t\.replace\(\/\[─═\]\{3,\}\\s\*❯\?\/g, " "\)/);
  assert.match(html, /const SYS_LINE = \/\^\\s\*<\(task-notification\|system-reminder\|command-\)\//);
  assert.match(html, /function foldActs\(acts\)/);
});

test("focus screen triage: queue = needs-you + finished, Close = goal done + kill with Undo, decisions advance", () => {
  assert.match(html, /const QUEUE = new Set\(\["blocked", "waiting", "done"\]\);/);
  assert.match(html, /const ORDER = \{ blocked: 0, waiting: 1, done: 2, working: 3, ended: 4 \};/);
  assert.match(html, /if \(a === "stop"\) \{ fx\.warn\(\); return input\(s\.id, \{ key: "esc" \}\); \}/);
  assert.match(html, /if \(a === "continue"\) \{ fx\.send\(\); input\(s\.id, \{ text: "continue", enter: true \}\); return advance\(s\.id, "continued"\); \}/);
  // Continue only on a finished turn: never on a question, a finished goal, or a blocked terminal.
  assert.match(html, /if \(s\.state === "done"\) bar\.push\(close\);/);
  assert.match(html, /else if \(s\.state === "blocked"\) bar\.push\(`<button class="fa primary" data-fa="raw">⌨ Open terminal<\/button>`, close\);/);
  assert.match(html, /else \{ if \(!menuPrompt\) bar\.push\(`<button class="fa primary" data-fa="continue">▶ Continue<\/button>`\); bar\.push\(close\); \}/);
  // Close: goal done + kill, Undo on the toast, a second tap to confirm while the agent is working.
  assert.match(html, /if \(s\.goal && !s\.goal_done_at\) await api\("\/sessions\/" \+ s\.id, \{ method: "PATCH", body: JSON\.stringify\(\{ goal_done: true \}\) \}\);\n      await api\("\/sessions\/" \+ s\.id \+ "\/kill", \{ method: "POST" \}\);/);
  assert.match(html, /advance\(s\.id, "closed", \{ label: "Undo", fn: \(\) => reopen\(s\.id\) \}\)/);
  assert.match(html, /if \(s\.state === "working" && Date\.now\(\) - F\.arm > 2500\)/);
  assert.match(html, /#toast \{ position:fixed; left:50%; bottom:calc\(var\(--sab\) \+ 150px\)/);
  assert.match(html, /advance\(s\.id, "answered"\)/);
  assert.match(html, /advance\(id, "sent"\)/);
  // Past the end of the queue you land on home with what is still running — no silent wrap.
  assert.match(html, /const next = order\[i\] \|\| null;/);
  assert.match(html, /"caught up" \+ \(working \? ` · \$\{working\} working` : ""\)/);
  assert.match(html, /row\("advance", "Next terminal after an action"/);
});

test("home is the triage list: needs you → finished → working, one bar, answers on the card", () => {
  assert.match(html, /const PH_RANK = \{ blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6 \};/);
  assert.match(html, /function rank\(s\) \{ return PH_RANK\[phaseOf\(s\)\] \?\? 9; \}/);
  for (const g of ["g-needs", "g-finished", "g-working", "g-recent"]) assert.match(html, new RegExp(`id="${g}"`));
  assert.doesNotMatch(html, /id="g-notes"|id="pills"|id="strip"|id="btn-note"|id="h-mic"/, "no notes, no client strip, no home mic — the phone is for triage");
  assert.match(html, /<div class="hbar">[\s\S]*id="btn-new"[\s\S]*id="btn-robert"/);
  // Finished cards close or continue from the list; Close = goal reached + kill, with Undo.
  assert.match(html, /data-ans="continue"/);
  assert.match(html, /data-ans="close" class="go"/);
  assert.match(html, /async function closeSession\(id\)/);
  assert.match(html, /toast\("closed", \{ label: "Undo", fn: \(\) => reopen\(id\) \}\)/);
  // Every card says whose it is, in the Desk's colours.
  assert.match(html, /const WS_COLORS = \["#56B693"/);
  assert.match(html, /style="--ws:\$\{wsColor\(s\.workspace_id\)\}"/);
});

test("new work is one sheet: client + a sentence; voice settings remain; Plan tomorrow moved to settings", () => {
  assert.match(html, /function newTermSheet\(wsId\) \{[\s\S]*?const b = sheet\(/);
  assert.match(html, /spawn\(\{ workspace_id: cur, backend: w\?\.default_backend \|\| undefined, goal: goal \|\| null \}\)/);
  assert.match(html, /row\("autosend", "Auto-send voice"/);
  assert.match(html, /if \(PREFS\.autoSend\) send\(\); else ta\.focus\(\);/);
  assert.match(html, /<button id="btn-tomorrow">/);
});

test("Robert on the phone: an 8-char id becomes a chip that opens the story; select puts one on screen", () => {
  assert.match(html, /function mdRob\(text\)/);
  assert.match(html, /a\[href\^="#sel="\]/);
  assert.match(html, /\(a\) => a\.op === "select" \|\| a\.op === "focus_terminal"/);
});

test("Robert on the phone: a message typed mid-turn parks in an outbox and goes out when the turn lands — never refused, never a dead button", () => {
  const html = fs.readFileSync(new URL("../static/phone.html", import.meta.url), "utf8");
  assert.match(html, /if \(R\.busy\) \{ el\.classList\.add\("queued"\); R\.outbox\.push\(\{ text, el \}\); return; \}/);
  assert.match(html, /const next = R\.outbox\.shift\(\);\s*if \(next\) deliverRobert\(next\.text, next\.el\);/);
  assert.doesNotMatch(html, /qs\("#r-send"\)\.disabled = true/, "the send button is never disabled while he answers");
  assert.match(html, /\.bub\.you\.queued \{ opacity:\.55; \}/);
});

test("the terminal's text can be copied: a held finger opens the screen as selectable text with Copy all", () => {
  const html = fs.readFileSync(new URL("../static/phone.html", import.meta.url), "utf8");
  assert.match(html, /lp = setTimeout\(\(\) => \{ lp = 0; lpFired = true; fx\.tap\(\); copySheet\(\); \}, 550\)/);
  assert.match(html, /if \(axis !== null\) lpClear\(\);/, "a finger that moves is a scroll or a swipe, not a long-press");
  assert.match(html, /if \(lpFired\) \{ lpFired = false; return; \}/, "the release after a long-press is not a tap");
  assert.match(html, /b\.getLine\(i\)[\s\S]*translateToString\(true\)/);
  assert.match(html, /\.copytext \{ user-select:text; -webkit-user-select:text; -webkit-touch-callout:default;/);
  assert.match(html, /navigator\.clipboard\.writeText\(text\)/);
});

test("the phone shows Leads, not their workers — a Lead's terminals are a count on its card", () => {
  // `lead_id` is set on a worker only while its Lead is live (/desk), and it is a raw column on an
  // ended row — so both are re-checked against the live list rather than trusted.
  assert.match(html, /const leadLive = \(id\) => !!id && S\.sessions\.some\(\(x\) => x\.id === id && x\.live\);/);
  assert.match(html, /const isWorker = \(s\) => leadLive\(s\.lead_id\);/);
  // Every list the home screen paints, and the app badge with them — a badge that counts a card the
  // list does not show is a phone that says "1" forever.
  assert.match(html, /const live = S\.sessions\.filter\(\(s\) => s\.live && !isWorker\(s\)\)\.sort\(byRank\);/);
  assert.match(html, /recent = S\.ended\.filter\(\(s\) => !isWorker\(s\)\)\.slice\(0, 20\);/);
  assert.match(html, /const needsCount = \(\) => S\.sessions\.filter\(\(x\) => x\.live && !isWorker\(x\) &&/);
  // What is lost by hiding them is given back as one chip: how many, and how many are asking.
  assert.match(html, /const kids = workersOf\(s\);/);
  assert.match(html, /const needy = kids\.filter\(\(w\) => rank\(w\) <= 1\)\.length;/);
  assert.match(html, /◆ \$\{kids\.length\}\$\{needy \? ` · \$\{needy\} asking` : ""\}/);
});
