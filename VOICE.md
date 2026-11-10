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
- `node scripts/talk-latency.mjs --since 7d` — time to first word and whole reply, front vs today's path.
- `GET /api/voice/config` — is the front on, which engine, warm.
