# Voice: one conversation with Robert

> He talks, a reply starts in about a second, he can cut in, he can keep talking. Spanish and English,
> often in one sentence. Code: `src/talker.ts` (the front) · `src/voice-lang.ts` (which language a
> sentence is spoken in) · `src/transcribe.ts` (which language he is heard in) · `src/turn-failure.ts`
> (a failed turn in one sentence) · `src/voice-trace.ts` (call traces) · `static/phone-voice.js` (the
> phone's call engine) · `scripts/talk-latency.mjs`.

## The front (setting `voice.talker`, default off)

Every line to Robert — spoken or typed, Desk or phone — is answered by a small fast model that is
handed, by code, on every turn: what he said, the request ledger and the approval queue of **every**
project (he is the operator; a page locked to one workspace for a screen share gets only that one),
and after a respawn the last few exchanges. It answers in one to three spoken sentences and, when work
must happen, ends with `§delegate <project> ids=… back=… kind=…` lines that code parses and nobody hears.

- **Engines.** `cli` (default): its own warm `claude -p` on the operator's subscription — haiku, effort
  low, thinking off, its own ~2k-token system prompt replacing Claude Code's, `--tools ""`, no MCP, no
  skills, no CLAUDE.md, no output style, no session on disk, cwd `~/.mc/talker` (empty). Spawned 20 s
  after the daemon starts and when a call opens, with a throwaway warm-up turn; recycled every 20 turns.
  `api`: the Messages API with `ANTHROPIC_API_KEY` / `CHRONOS_TALKER_API_KEY` or `AI_GATEWAY_API_KEY`
  in `.secrets`; without a key it stays on `cli`. A provider refusing the key falls back to today's path
  before he hears anything.
- **The walls (code, not prompt).** Reads across workspaces; writes into one only by delegating to that
  workspace's own Robert. What that Robert receives is built by `buildDelegation` from **the operator's
  own words** in this thread (and, with `back=`, his previous one or two) plus ledger ids **of that
  workspace** — never the model's text, never another workspace's rows; an id from elsewhere refuses the
  whole delegation. The only verb the parser knows is `delegate`: the front cannot approve, merge, send
  or deploy, calls no daemon route and holds no daemon token.
- **Async.** He hears "dale, se lo paso a Robert de X" at once; the project Robert's turn runs in the
  background on its own operator lane; one or two sentences of its answer land as a push with no
  operator line, which every live call speaks.
- **The ledger.** `agent.asked` + `markVoiceTurn` every turn; one request per delegation, bound to the
  project Robert's turn (`openRequest`), so the terminals he opens join it; a turn that started no work
  is a closed `chat` request. The front's chat rows are `source = 'front'` and never enter a project
  Robert's recap.

## Speaking and listening, both languages

- **Speaking** (`voice.lang_pick`, on): each sentence is spoken in its own language — function words,
  Spanish spelling (ñ, accents, ¿ ¡) and English contractions decide, with the call's language as the
  tie-breaker — so an English sentence on a Spanish call gets the English voice and phonemizer
  (`em_alex` / `am_michael` today; set `CHRONOS_TTS_VOICE_EN=em_alex` for one voice in both).
  `voice.islands` (experimental, off) reads English words inside a Spanish sentence with English
  phonemes in the sentence's voice (`segments` in `scripts/tts-server.py`): measured, the English words
  improve and the Spanish right after each join gets worse.
- **Listening** (`voice.listen`, `bilingual`): whisper transcribes in the call's language and reports
  its language probabilities; only when the other language clearly wins (≥ 0.3 and 1.5× the hint) is the
  clip transcribed again in that one — never a third language (whisper's own auto-detect turned a
  spoken "Sí" into Arabic and "Dale" into Hindi). `page` = the call's language only, as before.
- **His words while he talks:** the open segment's tail is re-transcribed every ~700 ms
  (`/api/transcribe?partial=1`, skipped while whisper is busy so a final never waits). Display only.
- **End of turn:** 750 ms of silence (was 850). What he says while Robert is busy is shown at once and
  sent as one follow-up the moment the turn ends.

## Hearing: two engines, his vocabulary, short answers

Measured on synthetic speech only (three local TTS voices, Spanish with English tech words, run through
the phone's own VAD and WAV encoder at phone level: 250–3800 Hz, echo, room noise). No recording of a
real voice was used — `voice.keep_clips` below is how the next round gets real data.
`node scripts/stt-bench.mjs` reproduces every number on any folder of clips.

- **Two engines** (`voice.final_engine`, `accurate`). Live words stay on the fast whisper
  (`sh.chronos.whisper`, small, :7778). A finished sentence goes to a second server
  (`sh.chronos.whisper-final`, large-v3-turbo, :7781) so it never waits behind a preview. Not installed,
  still loading, crashed → the same clip goes to the fast engine (30 s before the second is tried again).
  30 sentences, 360 words: small 11.1% word errors at 0.39 s · large-v3-turbo 6.7% at 1.26 s.
- **Half the time on the large model** (`audio_ctx`, per request). whisper encodes 30 s whatever the
  clip's length, and on the large model that pass is the latency: beam 1 instead of 5 saved nothing
  (1.23 s both), `temperature_inc=0` nothing, and `--no-fallback` is parsed but never applied by
  whisper-server 1.9.1. With `audio_ctx=768` (15 s) the same sentences cost 0.66 s and came back no
  worse. It is not free below that: 384 gave 62% errors, and on 13–21 s clips 1250 already cost accuracy
  (3.9% → 6.2%) — so only clips up to 8 s get it; longer ones keep the full window.
- **His vocabulary** (`voice.vocab`, empty by default): comma-separated names and terms, sent as
  whisper's `prompt` with each finished sentence, written as a sentence in the language being
  transcribed. With the terms the test sentences use: small 11.1% → 5.3%, large-v3-turbo + 768 → 3.9% at
  0.66 s (best case — the list held exactly the words that were said).
- **One-word answers stay on the fast engine, without the prompt** (clips under 2 s). On 27 clips of
  "sí / no / dale / pará / colgá / listo" the large model was no better (20 right vs 22), four times
  slower, and worse with a cut window (5 of 11 at 512); the prompt helped none and, as a bare list of
  English-looking terms, turned "Cancelar" into "Can feel that". Padding them with a second of silence
  changed nothing — with the phone's own pre-roll and closing silence they are long enough.
- **Why "sí" was not heard: it never reached whisper.** The phone kept a segment only after 220 ms above
  the `speech` level (0.04); a one-word answer on a quiet mic is 200–350 ms and mostly under it. At
  phone level 13 of 24 one-word commands were dropped by the ear. Now a segment that stayed above the
  level that opened it for 130 ms is kept too: 24 of 24. The price is more noises sent (17 of 24
  synthetic knocks, hums and coughs instead of 3); whisper answered every one with a bracketed phantom
  or nothing, which the call already drops, and those clips play no "sent" beep.
- **«Colgá»** is written "Colgar" by both models (and "Colgada" on a real call): all of them hang up.
- **A sentence cut by a breath** (750 ms of quiet ends a clip — unchanged). When he speaks again within
  1.5 s of a cut and the first half has not reached the page yet, both halves are sent again as one clip
  and become one turn. A complete sentence is never delayed by this; short answers and stops never wait.
  Not measured on real speech: the trace now counts how often it happens (`reopen`, `join`).
- **After the "sent" beep** nothing opens for 220 ms, but the pre-roll keeps recording (it used to be
  thrown away, with the first syllable of whatever he said next). Neutral on the synthetic set
  (8.3% vs 8.8% on 18 second-halves); kept because frames are no longer lost.

## A call that can be cut into

- Barge-in threshold = p90 of what the mic hears while Robert plays and he is silent × 2.2, between
  0.015 and the old 0.075 — a phone whose echo canceller ducks his voice to ~0.03 can now cut in; the
  transcript still goes through the echo guard. A tap on the call screen (phone) or the orb (Desk) stops
  Robert at once.
- While a turn is out: a soft tick every 1.5 s, one spoken "un segundo" past 3.5 s.
- What is read aloud of a reply: three sentences / ~340 characters, then "¿te cuento más?"; "sí",
  "contame", "dale" reads the rest. Markdown headings are never read.
- A failed turn: a dead Claude login or an unreachable provider is cut on the CLI's **first**
  `system/api_retry` (not after its ten retries) and said in one sentence ("El login de Claude de
  Robert venció; hay que renovarlo en la Mac"); a fresh process that cannot authenticate is not
  respawned for it.
- A transcription lost to a dropped connection is retried twice with the same audio. The daemon now
  keeps idle sockets 95 s, longer than cloudflared's 90 s, which is what reset them.

## Diagnose

- `mc voice traces` — the last calls' traces (posted at hang-up, or ⋯ → Send call trace): barge-ins,
  taps, and the mic levels measured while Robert spoke. No audio.
- **His real voice** (`voice.keep_clips`, off): keeps the last 40 clips a call sent for transcription,
  with what was heard, in `~/.mc/voice-clips` — outside the checkout, sealed from every agent sandbox,
  operator-only, 48 MB at most, deleted when the setting goes off. `mc voice clips` lists them (length,
  level, whether a clip starts mid-word, how long the quiet tail was). Compare engines on them:
  `node scripts/stt-bench.mjs --dir "$(mc voice clips --dir)" --engine fast=http://127.0.0.1:7778/inference --engine "final=http://127.0.0.1:7781/inference;audio_ctx=768"`
  (write what was really said in a `<clip>.txt` next to a clip, or as `ref` in `index.json`, to get
  error rates instead of a side-by-side).
- `node scripts/talk-latency.mjs --since 7d` — time to first word and whole reply, front vs today's path.
- `GET /api/voice/config` — is the front on, which engine, warm.
