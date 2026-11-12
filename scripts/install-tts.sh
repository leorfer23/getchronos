#!/bin/bash
# Robert's local neural voice (Kokoro-82M on MLX, Apple Silicon only) — optional; without it
# /api/speak uses macOS `say`. Installs into ~/.mc/tts and loads the launchd agent sh.chronos.tts.
#
#   bash scripts/install-tts.sh          # install or update, then (re)start the agent
#   rm -rf ~/.mc/tts && launchctl bootout gui/$(id -u)/sh.chronos.tts   # remove it all
#
# Supply chain, on purpose:
#   - mlx-audio is pinned to a release at least two weeks old, and EVERY dependency is resolved with
#     --exclude-newer (nothing uploaded after that date can be pulled in transitively);
#   - its own venv, no sudo, nothing system-wide;
#   - the model is fetched as safetensors + JSON only (weights are data, not code); Kokoro's voices
#     also ship as .pt pickles, which are never downloaded — mlx-audio reads voices/<name>.safetensors;
#   - spaCy's English model comes from its official release pinned by sha256 (below);
#   - the server is ours (scripts/tts-server.py), not mlx_audio.server: see its header for why.
set -euo pipefail
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Kokoro on MLX needs an Apple Silicon Mac" >&2; exit 1; }
command -v uv >/dev/null || { echo "needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }

MLX_AUDIO="${CHRONOS_TTS_MLX_AUDIO:-0.6.1}"
EXCLUDE_NEWER="${CHRONOS_TTS_EXCLUDE_NEWER:-2026-10-22}"
MODEL="${CHRONOS_TTS_MODEL:-mlx-community/Kokoro-82M-bf16}"
VOICES="${CHRONOS_TTS_VOICES:-em_alex am_michael}"
ROOT="$HOME/.mc/tts"
PY="$ROOT/venv/bin/python"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT"
[ -x "$PY" ] || uv venv "$ROOT/venv" --python 3.12 -q
# misaki's English phonemizer needs spaCy's en_core_web_sm and, when it is missing, runs spaCy's own
# downloader at RUNTIME (a network install from inside the server). It is installed here instead,
# from the official release, pinned by hash — uv refuses the wheel if a single byte differs.
SPACY_EN="https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl#sha256=1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
uv pip install -q --python "$PY" --exclude-newer "$EXCLUDE_NEWER" "mlx-audio[tts]==$MLX_AUDIO" "misaki[en]" "en_core_web_sm @ $SPACY_EN"
"$PY" -c "import importlib.metadata as m; print('mlx-audio', m.version('mlx-audio'), '| mlx', m.version('mlx'))"

voice_args=()
for v in $VOICES; do voice_args+=("voices/$v.safetensors"); done
"$PY" - "$MODEL" "${voice_args[@]}" <<'PY'
import sys
from huggingface_hub import snapshot_download
model, voices = sys.argv[1], sys.argv[2:]
# The model's own weights/config, then exactly the voices we use — never the .pt files.
path = snapshot_download(model, allow_patterns=["config.json", "kokoro-*.safetensors"] + voices)
print("model at", path)
PY

node "$REPO/scripts/install-launchd.mjs" --only sh.chronos.tts
echo "waiting for the voice to warm up…"
for _ in $(seq 1 60); do
  curl -s -m 2 http://127.0.0.1:7779/health >/dev/null 2>&1 && { curl -s http://127.0.0.1:7779/health; echo; exit 0; }
  sleep 1
done
echo "sh.chronos.tts did not answer — see ${CHRONOS_LOG_DIR:-${CHRONOS_HOME:-$REPO}}/tts.err.log" >&2
exit 1
