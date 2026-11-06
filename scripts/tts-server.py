#!/usr/bin/env python3
"""Robert's voice, local: Kokoro-82M on Apple's MLX, behind the smallest server that does the job.

The daemon's POST /api/speak calls this first (src/speak.ts) and falls back to macOS `say` when it
is not running. Installed by scripts/install-tts.sh into ~/.mc/tts/venv, kept up by the launchd agent
sh.chronos.tts (launchd/sh.chronos.tts.plist.template).

Why not mlx-audio's own server (`mlx_audio.server`): it answers any web page (CORS "*"), loads any
model a request names (`POST /v1/models`), and reads any file a request points `ref_audio` at. Every
agent on this Mac can reach loopback, and so can every tab in the browser. This one does one thing:
    POST /speak {"text": "...", "lang": "es"|"en", "speed": 1.0}  →  audio/wav (24 kHz mono)
    GET  /health                                                  →  {"ok": true, "model", "voices"}
with a fixed model and fixed voices, bound to 127.0.0.1, refusing anything a browser sends (an
Origin header, or a Host that is not this loopback address — DNS rebinding), one request at a time.

Env: CHRONOS_TTS_PORT (7779), CHRONOS_TTS_MODEL (mlx-community/Kokoro-82M-bf16),
     CHRONOS_TTS_VOICE_ES (em_alex), CHRONOS_TTS_VOICE_EN (am_michael).
"""
import io
import json
import os
import re
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from mlx_audio.tts.utils import load_model

PORT = int(os.environ.get("CHRONOS_TTS_PORT", "7779"))
MODEL = os.environ.get("CHRONOS_TTS_MODEL", "mlx-community/Kokoro-82M-bf16")
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z]+$")
MAX_CHARS = 1200
MAX_BODY = 16 * 1024


def voice(env: str, default: str) -> str:
    v = os.environ.get(env, default)
    if not VOICE_RE.match(v):
        sys.exit(f"[tts] {env}={v!r} is not a Kokoro voice name (like em_alex)")
    return v


# lang → (voice, Kokoro lang_code). Kokoro's codes: "a" American English, "e" Spanish.
VOICES = {
    "es": (voice("CHRONOS_TTS_VOICE_ES", "em_alex"), "e"),
    "en": (voice("CHRONOS_TTS_VOICE_EN", "am_michael"), "a"),
}
HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


def log(msg: str) -> None:
    print(f"[tts] {msg}", file=sys.stderr, flush=True)


t0 = time.time()
model = load_model(MODEL)
RATE = int(model.sample_rate)


def synth(text: str, lang: str, speed: float) -> bytes:
    v, code = VOICES[lang]
    parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(text=text, voice=v, speed=speed, lang_code=code)]
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# Load the voices and the Spanish/English phonemizers now, not on the first sentence he waits for.
# A language that cannot load is dropped, not fatal: its sentences fall back to `say` in the daemon.
# BaseException on purpose — spaCy's downloader (misaki's English, when en_core_web_sm is missing)
# ends with sys.exit(), and that must not take Spanish down with it.
for lang, sample in (("es", "Hola."), ("en", "Hi.")):
    try:
        synth(sample, lang, 1.0)
    except BaseException as e:
        log(f"{lang} disabled ({e!r}) — run scripts/install-tts.sh; /api/speak uses `say` for it meanwhile")
        VOICES.pop(lang)
if not VOICES:
    sys.exit("[tts] no language could be loaded")
log(f"{MODEL} ready in {time.time() - t0:.1f}s — " + " ".join(f"{k}={v[0]}" for k, v in VOICES.items()) + f" on 127.0.0.1:{PORT}")


class Handler(BaseHTTPRequestHandler):
    server_version = "chronos-tts"

    def log_message(self, fmt, *args):  # one line per request is ours, below
        pass

    def reply(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error(self, code: int, msg: str) -> None:
        self.reply(code, json.dumps({"error": msg}).encode(), "application/json")

    def refused(self) -> bool:
        if self.headers.get("Origin") is not None:
            self.error(403, "not for browsers")
            return True
        if self.headers.get("Host") not in HOSTS:
            self.error(403, "loopback only")
            return True
        return False

    def do_GET(self):
        if self.refused():
            return
        if self.path != "/health":
            return self.error(404, "not found")
        body = {"ok": True, "model": MODEL, "voices": {k: v[0] for k, v in VOICES.items()}, "sample_rate": RATE}
        self.reply(200, json.dumps(body).encode(), "application/json")

    def do_POST(self):
        if self.refused():
            return
        if self.path != "/speak":
            return self.error(404, "not found")
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.error(415, "send JSON")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY:
            return self.error(413, "body too large or empty")
        try:
            req = json.loads(self.rfile.read(n))
            text = str(req.get("text") or "").strip()[:MAX_CHARS]
            lang = req.get("lang") or "en"
            speed = float(req.get("speed") or 1.0)
        except (ValueError, TypeError, AttributeError):
            return self.error(400, "bad JSON")
        if not text:
            return self.error(400, "nothing to say")
        if lang not in VOICES:
            return self.error(400 if lang not in ("es", "en") else 503, f"no voice loaded for {lang!r}")
        speed = min(2.0, max(0.5, speed))
        t = time.time()
        try:
            wav = synth(text, lang, speed)
        except Exception as e:  # a bad sentence must not take the voice down
            log(f"synth failed: {e!r}")
            return self.error(500, "synthesis failed")
        secs = (len(wav) - 44) / 2 / RATE
        log(f"{lang} {len(text)} chars → {secs:.1f}s audio in {time.time() - t:.2f}s")
        self.reply(200, wav, "audio/wav")


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
