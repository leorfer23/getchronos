/**
 * The phone surface (static/phone.html) is plain HTML with no build step, so the regressions this
 * guards are attributes and strings in the shipped file: the PWA hooks a phone needs to install it,
 * Focus (no raw PTY), Robert (model picker + warm), and the new-terminal sheet matching the Desk.
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

test("bus socket follows the page scheme and the token rides the same localStorage key as the Desk", () => {
  assert.match(html, /const WS_SCHEME = location\.protocol === "https:" \? "wss:" : "ws:"/);
  assert.match(html, /\$\{WS_SCHEME\}\/\/\$\{location\.host\}\/ws\?token=/);
  assert.match(html, /localStorage\.getItem\("mc-token"\)/);
  // No raw PTY on the phone — no /term websocket.
  assert.doesNotMatch(html, /\/term\?id=/);
  assert.doesNotMatch(html, /xterm\.css|new Terminal\(|disableStdin/);
});

test("api() rides out a tunnel blip: one retry on a failed GET, never on a write", () => {
  assert.match(html, /const method = \(opts\?\.method \|\| "GET"\)\.toUpperCase\(\);/);
  assert.match(html, /method === "GET" && err instanceof TypeError \? new Promise\(\(r\) => setTimeout\(r, 1200\)\)\.then\(send\) : Promise\.reject\(err\)/);
});

test("Focus composer posts through /sessions/:id/input with enter:true", () => {
  assert.match(html, /input\(id, \{ text: v, enter: true \}\)/);
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
  assert.match(html, /const body = \{ text, client: CLIENT, surface: "phone" \};/);
  assert.match(html, /api\("\/agent", \{ method: "POST", body: JSON\.stringify\(body\) \}\)/);
  assert.match(html, /api\("\/agent\/history\?limit=40&ws=all"\)/);
  assert.match(html, /talkMic\(qs\("#r-mic"\)/);
  assert.match(html, /DOMPurify\.sanitize\(marked\.parse/);
});

test("Robert has a model picker wired to GET/POST /agent/model", () => {
  assert.match(html, /id="r-model"/);
  assert.match(html, /async function loadRobertModel\(\)/);
  assert.match(html, /api\("\/agent\/model"\)/);
  assert.match(html, /api\("\/agent\/model", \{ method: "POST", body: JSON\.stringify\(\{ model \}\) \}\)/);
  assert.match(html, /qs\("#r-model"\)\.onchange/);
});

test("Robert warms aggressively on app open, resume, and opening his chat", () => {
  assert.match(html, /function warmRobert\(force = false\)/);
  assert.match(html, /api\("\/agent\/warm", \{ method: "POST", body: JSON\.stringify\(\{ ws: null \}\) \}\)/);
  assert.match(html, /warmRobert\(true\);/);
  assert.match(html, /robertHistory\(\); \/\/ cache his thread so opening Robert is instant/);
  assert.match(html, /function resume\(\) \{[\s\S]*?warmRobert\(\);/);
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
  assert.match(html, /if \(was === "working" && s\.state === "waiting" && !s\.status\) fx\.needsYou\(\)/);
  assert.match(html, /if \(was !== e\.status\.phase && \["blocked", "decide", "your_turn"\]\.includes\(e\.status\.phase\)\) fx\.needsYou\(\);/);
});

test("every sheet can be dragged down to dismiss, and has an ✕", () => {
  assert.match(html, /<button class="x" data-x aria-label="Close">/);
  assert.match(html, /sh\.addEventListener\("touchmove"/);
  assert.match(html, /if \(dy > 110 \|\| flick\) \{ fx\.tap\(\); closeSheet\(true, sh, bg\); \}/);
  assert.match(html, /function newTermSheet\(wsId\) \{[\s\S]*?const b = sheet\(/);
});

test("answer chips on the card go through the input door; a select's extra options open Focus", () => {
  assert.match(html, /data-ans="yn:y"/);
  assert.match(html, /data-ans="continue"/);
  assert.match(html, /if \(a\.startsWith\("opt:"\)\) \{ const o = s\?\.prompt\?\.options\?\.\[Number\(a\.slice\(4\)\)\]; return o \? input\(id, optionBody\(o\)\) : openFocus\(id\); \}/);
  assert.doesNotMatch(html, /<button class="\$\{cls\}" data-open/);
  assert.match(html, /<div class="\$\{cls\}" role="button" tabindex="0" data-open/);
});

test("Robert on the phone is one routed chat: no strip filter, answer comes off the bus", () => {
  assert.match(html, /if \(ws !== undefined\) \{ body\.ws = ws; body\.route = false; \}/);
  assert.match(html, /if \(r\?\.how === "ask"\) \{ dropMine\(\); robWork\(false\); askWhere\(r, text, quote\); return; \}/);
  assert.match(html, /const ourThread = \(ws\) => !String\(ws \|\| ""\)\.startsWith\("agent:"\);/);
  assert.match(html, /if \(!e\.text \|\| \(e\.kind && e\.kind !== "text"\) \|\| !\(mine \|\| ourThread\(e\.ws\)\)\) return;/);
  assert.doesNotMatch(html, /id="rstrip"/);
  assert.doesNotMatch(html, /phone-robert-ws/);
  assert.match(html, /let b = R\.pend\.get\(key\);/);
  assert.match(html, /R\.pend\.set\(r\.turn, b\); R\.mine = null; R\.pend\.delete\("\?"\)/);
  assert.match(html, /robAwait\(r\.turn\); hold = true; return;/);
  assert.match(html, /if \(R\.awaitTurn && \(R\.awaitTurn === e\.turn \|\| R\.awaitTurn === "lost"\)\) robRelease/);
  assert.match(html, /robertHistory\(\)\.finally\(\(\) => \{ if \(waiting\) robRelease\(null\); \}\)/);
  assert.match(html, /TagComplete\(rComposer, \(\) => S\.workspaces\);/);
  assert.match(html, /R\.outbox\.push\(\{ text, el, quote, ws: picked \}\)/);
  assert.match(html, /if \(next\) deliverRobert\(next\.text, next\.el, next\.ws, next\.quote\);/);
  assert.match(html, /const streamed = R\.pend\.get\(e\.turn \|\| "\?"\);/);
  assert.match(html, /streamed\.className = "bub rob";/);
});

test("push: the page registers the worker at root scope, hands it the token, and reads deep links", () => {
  assert.match(html, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(html, /postMessage\(\{ type: "token", token: TOKEN \}\)/);
  assert.match(html, /applicationServerKey: b64\(publicKey\)/);
  assert.match(html, /api\("\/push\/subscribe", \{ method: "POST", body: JSON\.stringify\(\{ subscription: sub\.toJSON\(\) \}\)/);
  assert.match(html, /if \(h\.startsWith\("s="\)\)/);
  assert.match(html, /navigator\.setAppBadge\?\.\(n\)/);
  const sw = fs.readFileSync(path.join(process.cwd(), "static/sw.js"), "utf8");
  assert.match(sw, /fetch\("\/api\/sessions\/" \+ d\.session_id \+ "\/input"/);
  assert.match(sw, /\(p\.actions \|\| \[\]\)\.slice\(0, 2\)/, "Android shows two buttons");
  assert.match(sw, /res\.ok && res\.type === "basic" && !res\.redirected/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api"\)/);
  assert.match(sw, /const VERSION = "v14"/);
});

test("Plan tomorrow lives on the Desk — not on the phone", () => {
  assert.doesNotMatch(html, /btn-tomorrow|tomorrowSheet|nextWorkday|\/nextday/);
  assert.doesNotMatch(html, /plan-row|mc-plan-ws/);
});

test("no raw PTY on the phone: Focus only, stubs for the old terminal path", () => {
  assert.doesNotMatch(html, /id="v-term"/);
  assert.doesNotMatch(html, /vendor\/xterm/);
  assert.match(html, /function detach\(\) \{\}/);
  assert.match(html, /function openTerm\(id\) \{ if \(id\) openFocus\(id\); \}/);
  assert.match(html, /window\.addEventListener\("pageshow", \(e\) => \{ if \(e\.persisted\) resume\(\); \}\)/);
  assert.match(html, /window\.addEventListener\("online", resume\)/);
});

test("back gesture: screens and sheets are history entries; back lands on home, not outside the app", () => {
  assert.match(html, /history\.pushState\(\{ view, depth: 1 \}, "", location\.pathname\)/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /history\.pushState\(\{ \.\.\.\(history\.state \|\| \{\}\), sheet: true \}/);
  assert.match(html, /if \(had && history\.state\?\.sheet\) history\.back\(\);/);
  assert.match(html, /<meta name="chronos-build" content="[0-9a-z-]+">/);
  assert.match(html, /data-reload/);
});

test("voice: one warm mic stream, 32 kbps opus, timings surfaced when slow", () => {
  assert.match(html, /async function micReady\(\)/);
  assert.match(html, /audioBitsPerSecond: 32000/);
  assert.match(html, /if \(total > 1800\) toast/);
  assert.doesNotMatch(html, /stream\?\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\); stream = null;/, "the shared stream is not torn down per hold");
});

test("voice: tap once and it keeps listening — screen awake, ✕ cancels, a failed transcribe keeps the audio", () => {
  assert.match(html, /function talkMic\(mic, onText, sends = \(\) => false\)/);
  assert.match(html, /finishing = V\.state === "rec" && V\.mic === mic;/);
  assert.match(html, /Date\.now\(\) - downAt >= HOLD_MS\) voiceFinish\(\)/);
  assert.doesNotMatch(html, /addEventListener\("pointerleave"/, "drifting off the button must not end a recording");
  assert.match(html, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(html, /if \(document\.hidden\) \{ if \(!V\.state\) micRelease\(\); \}/);
  assert.match(html, /id="rb-cancel"/);
  assert.match(html, /if \(!V\.keep\) \{ voiceReset\(\); return toast\("cancelled"\); \}/);
  assert.match(html, /if \(V\.state === "busy"\) return V\.ctl\?\.abort\(\);/);
  assert.match(html, /signal: V\.ctl\.signal/);
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

test("focus screen: the story is the only way into a terminal on the phone", () => {
  assert.match(html, /if \(t\.dataset\.open\) \{ fx\.tap\(\); return openFocus\(t\.dataset\.open\); \}/);
  assert.match(html, /if \(byId\(id\)\) openFocus\(id\); else toast\("that terminal is gone"\)/);
  assert.match(html, /if \(id\) openFocus\(id\);/);
  assert.doesNotMatch(html, /id="f-raw"/);
  assert.match(html, /api\("\/sessions\/" \+ id \+ "\/focus"\)/);
  assert.match(html, /"focus\.event"\]\.join\(","\)/);
  assert.match(html, /function openFocus\(id, dir\) \{\n  const s = byId\(id\); if \(!s\) return toast\("not found"\);\n  const fromScreen = !!S\.current;\n  detach\(\);/);
  assert.match(html, /const after = \(e\) => !!e && \(!lastUser \|\| e\.seq > lastUser\.seq\);/);
  assert.match(html, /const freshRes = after\(res\) \? res : null;/);
  assert.match(html, /lbl: "Latest"/);
  assert.match(html, /lbl: "Previous result"/);
  assert.match(html, /lbl: "Summary", text: s\.summary/);
  assert.match(html, /: res \? \{ key: "res", cls: "prev", lbl: "Previous result"/);
  assert.match(html, /const goalTitle = \(s\) => s\.goal \|\| sTitle\(s\);/);
  assert.match(html, /started as: \$\{esc\(clip\(started, 160\)\)\}/);
  assert.match(html, /return !p \|\| p\.kind === "turn" \? "Turn finished" : "Waiting for you";/);
  assert.match(html, /if \(!p \|\| p\.kind === "turn"\) return null;/);
  assert.match(html, /md\(open \? text : headTail\(text\)\)/);
  assert.match(html, /a\.target = "_blank"; a\.rel = "noopener";/);
  assert.match(html, /const cleanUser = \(t\) => t\.replace\(\/\[─═\]\{3,\}\\s\*❯\?\/g, " "\)/);
  assert.match(html, /const SYS_LINE = \/\^\\s\*<\(task-notification\|system-reminder\|command-\)\//);
  assert.match(html, /function foldActs\(acts\)/);
  assert.match(html, /id="f-goal"/);
  assert.match(html, /Activity · newest first/);
});

test("focus screen triage: queue = needs-you + finished, Close = goal done + kill with Undo, decisions advance", () => {
  assert.match(html, /const QUEUE = new Set\(\["blocked", "waiting", "done"\]\);/);
  assert.match(html, /const ORDER = \{ blocked: 0, waiting: 1, done: 2, working: 3, ended: 4 \};/);
  assert.match(html, /if \(a === "stop"\) \{ fx\.warn\(\); return input\(s\.id, \{ key: "esc" \}\); \}/);
  assert.match(html, /if \(a === "continue"\) \{ fx\.send\(\); input\(s\.id, \{ text: "continue", enter: true \}\); return advance\(s\.id, "continued"\); \}/);
  assert.match(html, /if \(s\.state === "done"\) bar\.push\(close\);/);
  assert.match(html, /else if \(s\.state === "blocked"\) bar\.push\(`<button class="fa primary" data-fa="reply">Reply<\/button>`, close\);/);
  assert.match(html, /else \{ if \(!menuPrompt\) bar\.push\(`<button class="fa primary" data-fa="continue">▶ Continue<\/button>`\); bar\.push\(close\); \}/);
  assert.match(html, /if \(s\.goal && !s\.goal_done_at\) await api\("\/sessions\/" \+ s\.id, \{ method: "PATCH", body: JSON\.stringify\(\{ goal_done: true \}\) \}\);\n      await api\("\/sessions\/" \+ s\.id \+ "\/kill", \{ method: "POST" \}\);/);
  assert.match(html, /advance\(s\.id, "closed", \{ label: "Undo", fn: \(\) => reopen\(s\.id\) \}\)/);
  assert.match(html, /if \(s\.state === "working" && Date\.now\(\) - F\.arm > 2500\)/);
  assert.match(html, /#toast \{ position:fixed; left:50%; bottom:calc\(var\(--sab\) \+ 150px\)/);
  assert.match(html, /advance\(s\.id, "answered"\)/);
  assert.match(html, /advance\(id, "sent"\)/);
  assert.match(html, /const next = order\[i\] \|\| null;/);
  assert.match(html, /"caught up" \+ \(working \? ` · \$\{working\} working` : ""\)/);
  assert.match(html, /row\("advance", "Next terminal after an action"/);
});

test("home is the triage list: needs you → finished → working, one bar, answers on the card", () => {
  assert.match(html, /const PH_RANK = \{ blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6 \};/);
  assert.match(html, /function rank\(s\) \{ return PH_RANK\[phaseOf\(s\)\] \?\? 9; \}/);
  for (const g of ["g-needs", "g-finished", "g-working"]) assert.match(html, new RegExp(`id="${g}"`));
  assert.doesNotMatch(html, /id="g-recent"|toggle-ended|S\.ended|showEnded/, "no Recent / ended list — live triage only");
  assert.doesNotMatch(html, /id="g-notes"|id="pills"|id="strip"|id="btn-note"|id="h-mic"/, "no notes, no client strip, no home mic — the phone is for triage");
  assert.doesNotMatch(html, /data-fclient|clientSheet|phone-ws|S\.filter/, "no client filter on Focus");
  assert.match(html, /<div class="hbar">[\s\S]*id="btn-new"[\s\S]*id="btn-robert"/);
  assert.match(html, /data-ans="continue"/);
  assert.match(html, /data-ans="close" class="go"/);
  assert.match(html, /async function closeSession\(id\)/);
  assert.match(html, /toast\("closed", \{ label: "Undo", fn: \(\) => reopen\(id\) \}\)/);
  assert.match(html, /const WS_COLORS = \["#56B693"/);
  assert.match(html, /style="--ws:\$\{wsColor\(s\.workspace_id\)\}"/);
});

test("new terminal sheet matches Desk options: CLI, model, where, kind, blank, lead", () => {
  assert.match(html, /function newTermSheet\(wsId\) \{[\s\S]*?const b = sheet\(/);
  assert.match(html, /id="f-backend"/);
  assert.match(html, /id="f-model"/);
  assert.match(html, /id="f-cwd"/);
  assert.match(html, /id="f-kind"/);
  assert.match(html, /id="f-lead"/);
  assert.match(html, /id="f-blank"/);
  assert.match(html, /function fillBackendSelect/);
  assert.match(html, /function fillModelSelect/);
  assert.match(html, /localStorage\.setItem\("desk-backend:"/);
  assert.match(html, /localStorage\.setItem\("desk-model:"/);
  assert.match(html, /\.\.\.\(opts\.lead \? \{ role: "lead" \} : \{\}\)/);
  assert.match(html, /row\("autosend", "Auto-send voice"/);
  assert.match(html, /if \(PREFS\.autoSend\) send\(\); else ta\.focus\(\);/);
  assert.doesNotMatch(html, /btn-tomorrow/);
});

test("Robert on the phone: an 8-char id becomes a chip that opens the story; he never moves the screen", () => {
  assert.match(html, /function mdRob\(text\)/);
  assert.match(html, /a\[href\^="#sel="\]/);
  assert.doesNotMatch(html, /a\.op === "select"|a\.op === "focus_terminal"/, "nothing he says moves the operator's screen");
});

test("Robert on the phone: a message typed mid-turn parks in an outbox and goes out when the turn lands", () => {
  assert.match(html, /if \(R\.busy\) \{ el\.classList\.add\("queued"\); R\.outbox\.push\(\{ text, el, quote \}\); robWork\(true, "queued…"\); return; \}/);
  assert.match(html, /const next = R\.outbox\.shift\(\);/);
  assert.match(html, /if \(next\) deliverRobert\(next\.text, next\.el, next\.ws, next\.quote\);/);
  assert.doesNotMatch(html, /qs\("#r-send"\)\.disabled = true/, "the send button is never disabled while he answers");
  assert.match(html, /\.bub\.you\.queued \{ opacity:\.55; \}/);
  assert.match(html, /id="r-work"/);
});

test("the phone shows Leads, not their workers — a Lead's terminals are a count on its card", () => {
  assert.match(html, /const leadLive = \(id\) => !!id && S\.sessions\.some\(\(x\) => x\.id === id && x\.live\);/);
  assert.match(html, /const isWorker = \(s\) => leadLive\(s\.lead_id\);/);
  assert.match(html, /const live = S\.sessions\.filter\(\(s\) => s\.live && !isWorker\(s\)\)\.sort\(byRank\);/);
  assert.doesNotMatch(html, /S\.ended/);
  assert.match(html, /const needsCount = \(\) => S\.sessions\.filter\(\(x\) => x\.live && !isWorker\(x\) &&/);
  assert.match(html, /const kids = workersOf\(s\);/);
  assert.match(html, /const needy = kids\.filter\(\(w\) => rank\(w\) <= 1\)\.length;/);
  assert.match(html, /◆ \$\{kids\.length\}\$\{needy \? ` · \$\{needy\} asking` : ""\}/);
});
