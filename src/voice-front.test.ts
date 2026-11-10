/**
 * The voice path around the front: the language each sentence is spoken in, the language each
 * utterance is heard in, a failed turn said in one sentence, a dead login cut on the CLI's first retry,
 * the tunnel keep-alive, and the call traces kept for `mc voice traces`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { islands, pickLang, scoreLang } from "./voice-lang.js";
import { transcribeBilingual } from "./transcribe.js";
import { authNotice, failureKind, plainFailure } from "./turn-failure.js";
import { apiRetryFatal, isAuthError, isUnreachableError } from "./manager-fallback.js";
import { noteVoiceTrace, resetVoiceTraces, voiceTraces } from "./voice-trace.js";
import { applyKeepAlive, KEEP_ALIVE_MS } from "./api.js";
import { CONFIG } from "./config.js";
import { WarmManager } from "./telegram/agent.js";

// ───────────────────────────── speaking: one language per sentence ─────────────────────────────

test("each sentence is spoken in its own language, whatever the call's toggle says", () => {
  const es = ["Che Robert, ¿cómo venimos con lo del tablero?", "Dale, decile que lo pruebe en el teléfono.", "No, esperá, primero quiero ver las capturas.", "Pasalo para mañana a las diez."];
  const en = ["Hey Robert, what's waiting for me this morning?", "Tell the team the release is going out after lunch.", "Which pull requests are ready to merge right now?", "Move that to tomorrow, I'm driving."];
  for (const s of es) assert.equal(pickLang(s, "en"), "es", s);
  for (const s of en) assert.equal(pickLang(s, "es"), "en", s);
});

test("no signal keeps the hint (an OK or a number never flips the voice); code-switched Spanish stays Spanish", () => {
  assert.equal(pickLang("OK.", "es"), "es");
  assert.equal(pickLang("OK.", "en"), "en");
  assert.equal(pickLang("PR 212.", "es"), "es");
  assert.equal(pickLang("Mergeá la feature branch y después hacé el deploy a staging.", "en"), "es", "two English nouns do not make it English");
  assert.equal(pickLang("Ok, let's see, ¿qué onda con el worktree del login?", "es"), "es");
  assert.equal(scoreLang("¿Sí?").es > 0, true, "¿ is Spanish spelling");
});

test("English words inside a Spanish sentence become English runs, read in the sentence's voice", () => {
  const segs = islands("Mergeá la feature branch y después hacé el deploy a staging.", "es");
  assert.deepEqual(segs.map((s) => s.lang), ["es", "en", "es", "en"]);
  assert.equal(segs[1].text, "feature branch");
  assert.equal(segs[3].text, "deploy a staging.", "a shared word (\"a\") does not cut the run; punctuation stays with it");
  assert.ok(segs.map((s) => s.text).join(" ").includes("Mergeá la"), "nothing is lost");
  // Acronyms stay with the sentence ("pe erre" is how it is said), and a plain sentence is one run.
  assert.deepEqual(islands("El PR doscientos doce está listo.", "es").map((s) => s.lang), ["es"]);
  assert.equal(islands("Hey, the PR is ready.", "en").length, 1, "English sentences are not split");
});

// ───────────────────────────── listening: Spanish or English, never a third ─────────────────────────────

test("heard in the call's language; transcribed again in the other one only when whisper clearly hears it", async () => {
  const calls: string[] = [];
  const fake = (probs: Record<string, number>) => async (_b: Buffer, o: { language?: string }) => {
    calls.push(o.language!);
    return { text: `in ${o.language}`, probs };
  };
  // "Sí" on a Spanish call — whisper's own guess said Arabic (measured); we never leave es/en.
  let r = await transcribeBilingual(Buffer.from("x"), { hint: "es" }, fake({ ar: 0.49, en: 0.12, es: 0.097 }));
  assert.deepEqual([r.lang, r.passes, calls.splice(0)], ["es", 1, ["es"]]);
  // English on a Spanish call: second pass in English.
  r = await transcribeBilingual(Buffer.from("x"), { hint: "es" }, fake({ en: 0.91, es: 0.03 }));
  assert.deepEqual([r.text, r.lang, r.passes, calls.splice(0)], ["in en", "en", 2, ["es", "en"]]);
  // A close call keeps the hint.
  r = await transcribeBilingual(Buffer.from("x"), { hint: "en" }, fake({ en: 0.4, es: 0.5 }));
  assert.equal(r.lang, "en");
  // An engine with no probabilities (a cloud endpoint): one pass, as before.
  r = await transcribeBilingual(Buffer.from("x"), { hint: "es" }, async () => ({ text: "hola", probs: null }));
  assert.deepEqual([r.text, r.passes], ["hola", 1]);
});

// ───────────────────────────── a failed turn: one sentence, at once ─────────────────────────────

const REAL_AUTH = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";

test("the real expired-login message is an auth error, said as one plain sentence he can act on", () => {
  assert.equal(isAuthError(REAL_AUTH), true, "it used to fall through as a generic failure (two respawns, ~85 s)");
  assert.equal(failureKind(new Error(REAL_AUTH)), "auth");
  assert.equal(plainFailure(new Error(REAL_AUTH), "hola robert, ¿cómo va?").reply, "El login de Claude de Robert venció; hay que renovarlo en la Mac.");
  assert.equal(plainFailure(new Error(REAL_AUTH), "hey robert").reply, "Robert's Claude login expired; it has to be renewed on the Mac.");
  assert.ok(!plainFailure(new Error(REAL_AUTH)).reply.startsWith("⚠️"), "no ⚠️: the phone speaks it");
  assert.equal(failureKind(new Error("fetch failed: getaddrinfo ENOTFOUND api.anthropic.com")), "unreachable");
  assert.equal(isUnreachableError("provider unreachable: no response from the API on the first attempt"), true);
  assert.ok(plainFailure(new Error("tool crashed")).reply.startsWith("⚠️ tool crashed"), "anything else stays the error it was");
  assert.match(authNotice("che"), /venció/);
});

test("a CLI api_retry is judged on the FIRST retry: a dead login or no response ends the turn, a 529 does not", () => {
  assert.match(apiRetryFatal({ error: "authentication_failed", error_status: 401 })!, /authentication_failed/);
  assert.ok(isAuthError(apiRetryFatal({ error: "authentication_failed", error_status: 401 })));
  assert.ok(apiRetryFatal({ error: "account_on_hold", error_status: 403 }));
  assert.ok(isUnreachableError(apiRetryFatal({ error: "unknown", error_status: null, no_response: { waited_ms: 30000 } })));
  assert.equal(apiRetryFatal({ error: "overloaded", error_status: 529 }), null, "the CLI's own retries handle a busy API");
  assert.equal(apiRetryFatal({ error: "rate_limit", error_status: 429 }), null);
  assert.equal(apiRetryFatal({ error: "server_error", error_status: 500 }), null);
});

test("WarmManager: an authentication_failed retry kills the turn at once, and a fresh process is not respawned for it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warm-auth-"));
  const count = path.join(dir, "spawns");
  const bin = path.join(dir, "fake-claude");
  // A stand-in for `claude -p --input-format stream-json`: on the first message it reports an
  // authentication_failed retry (as the real CLI does) and then hangs, as it would for its 10 retries.
  fs.writeFileSync(bin, `#!/usr/bin/env node
require("fs").appendFileSync(${JSON.stringify(count)}, "x");
process.stdin.once("data", () => {
  console.log(JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 5000, error_status: 401, error: "authentication_failed" }));
  setTimeout(() => {}, 60000);
});
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
  const was = CONFIG.claudeBin;
  (CONFIG as any).claudeBin = bin;
  try {
    const m = new WarmManager({ system: "s", model: "haiku", turnTimeoutMs: 30_000, maxTurns: 5, sandbox: "off", cwd: dir, customArgs: [] });
    const t0 = Date.now();
    await assert.rejects(m.turn("hola"), (e: any) => isAuthError(e) && /authentication_failed/.test(e.message));
    assert.ok(Date.now() - t0 < 5000, `failed in ${Date.now() - t0} ms, not after the CLI's retries`);
    assert.equal(fs.readFileSync(count, "utf8").length, 1, "one spawn: a process born for this turn already read the login fresh");
    m.kill();
  } finally {
    (CONFIG as any).claudeBin = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────── the tunnel's keep-alive ─────────────────────────────

test("the daemon keeps idle sockets longer than cloudflared does (90 s), so a reused one is never reset", () => {
  const s = http.createServer();
  applyKeepAlive(s);
  assert.ok(s.keepAliveTimeout > 90_000, "cloudflared originRequest keepAliveTimeout defaults to 1m30s");
  assert.equal(s.keepAliveTimeout, KEEP_ALIVE_MS);
  assert.ok(s.headersTimeout > s.keepAliveTimeout, "Node requires headersTimeout above keepAliveTimeout");
});

// ───────────────────────────── call traces ─────────────────────────────

test("call traces keep moves and levels only, the last few, with a summary for mc voice traces", () => {
  resetVoiceTraces();
  assert.equal(noteVoiceTrace({}).ok, false);
  const r = noteVoiceTrace({
    client: "phone-1", ua: "Android Chrome", why: "hang-up",
    events: [[10, "barge"], [20, "barge:echo-or-noise"], [30, "tap-stop"], [40, "heard:hola"]],
    levels: [[1, 0.004, 0.004, 0.015], [2, 0.006, 0.005, 0.015], [3, 0.03, 0.005, 0.015]],
    summary: { threshold: 0.015, audio: "x".repeat(500) },
    audio: "base64-would-be-dropped",
  });
  assert.ok(r.ok);
  const [t] = voiceTraces(1);
  assert.equal(t.summary.barges, 1);
  assert.equal(t.summary.barge_false, 1);
  assert.equal(t.summary.taps_stop, 1);
  assert.equal(t.summary.play_rms_max, 0.03);
  assert.ok(!JSON.stringify(t).includes("base64-would-be-dropped"), "nothing outside the shape is kept");
  for (let i = 0; i < 12; i++) noteVoiceTrace({ events: [[i, "x"]] });
  assert.equal(voiceTraces(50).length, 8, "only the last few, in memory");
});
