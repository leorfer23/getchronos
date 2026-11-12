# Voice

Talk to the assistant out loud, from the Desk or your phone. He does what you ask and answers in a
sentence or two. Spanish and English both work, even mixed in one sentence.

## Where

- **Desk call:** 🎙 in the assistant's chat, or ⌘⇧V. Talk; he acts and answers out loud. ⎋ skips what
  he is saying; ⌘⇧V again hangs up. The call bar has your language (he answers in it) and his speed.
- **Talk to one terminal:** 🎤 in a terminal's header (⌘⇧D). Tap, speak, tap again — your words are
  typed into that terminal with ⏎.
- **Phone:** the same call from the phone app. The microphone needs HTTPS, so set up
  [Phone](phone.md) first.

## Set it up

**Hearing** runs on your Mac with whisper.cpp — the audio does not leave the machine:

```bash
bash scripts/install-whisper.sh   # whisper.cpp + ffmpeg (Homebrew), the small model, its login agent
```

`--accurate` adds a larger model for whole sentences (+1.5 GB). Until hearing is set up, the mic
tells you this command instead of failing.

**Speaking** works out of the box with macOS `say`. On Apple Silicon, `bash scripts/install-tts.sh`
adds a local neural voice; `say` stays the fallback.

## Tune it

⚙ Settings → **Voice**:

- **Vocabulary** — names and terms you say (project names, tools). In the project's own
  (synthetic) tests this roughly halved word errors.
- **A faster front** (off by default) — a small fast model answers in about a second and hands real
  work to the project's assistant in the background.
- **Hearing in the cloud** (off by default) — sends finished sentences to ElevenLabs (needs
  `ELEVENLABS_API_KEY`). Your audio leaves the Mac when this is on.

---

**Under the hood:** [VOICE.md](../../VOICE.md) · speech-to-text `src/transcribe.ts` (local whisper on
`127.0.0.1:7778`) · speech `src/speak.ts` · the front `src/talker.ts` · the phone's call engine
`static/phone-voice.js` · launchd agents `scripts/install-launchd.mjs`.
