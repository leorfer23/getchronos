#!/bin/bash
# Speech-to-text for calls and dictation — local and free, nothing leaves the Mac: whisper.cpp's server
# with the multilingual `small` model, kept running by the launchd agent sh.chronos.whisper on
# 127.0.0.1:7778 (CHRONOS_WHISPER_PORT moves it). Without it the mic answers "Speech-to-text isn't set
# up on this Mac yet" and Robert still speaks (macOS `say`). See VOICE.md.
#
#   bash scripts/install-whisper.sh              # install or update, then (re)start the agent (~470 MB)
#   bash scripts/install-whisper.sh --accurate   # also the larger model for finished sentences (+1.5 GB)
#   launchctl bootout gui/$(id -u)/sh.chronos.whisper; rm ~/.cache/whisper/ggml-small.bin   # remove it
#
# Supply chain, on purpose:
#   - whisper.cpp and ffmpeg come from Homebrew (whisper.cpp has no Intel bottle: there it builds from
#     source, which takes a few minutes);
#   - the models are the ones whisper.cpp's own models/download-ggml-model.sh fetches, and each file is
#     checked against the SHA-1 published in whisper.cpp's models/README.md before it is used.
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only" >&2; exit 1; }

ACCURATE=0
for a in "$@"; do
  case "$a" in
    --accurate) ACCURATE=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --accurate)" >&2; exit 1 ;;
  esac
done

# Not on PATH is common from a fresh shell: Homebrew's own bin is only added by the profile it writes.
BREW="$(command -v brew || true)"
if [ -z "$BREW" ]; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then BREW="$b"; break; fi
  done
fi
[ -n "$BREW" ] || { echo "needs Homebrew — install it from https://brew.sh, then run this again" >&2; exit 1; }
command -v node >/dev/null || { echo "needs node (the same one Chronos runs on)" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$HOME/.cache/whisper"
SRC="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
PORT="${CHRONOS_WHISPER_PORT:-7778}"

# --convert (webm/mp4/ogg → wav) is how the phone's and the Desk's recordings reach the model, and the
# server will not start without a working ffmpeg beside it.
echo "→ whisper.cpp + ffmpeg (Homebrew)"
"$BREW" install whisper.cpp ffmpeg

# name, SHA-1 (whisper.cpp models/README.md)
fetch() {
  local name="$1" sha="$2" dest="$DIR/ggml-$1.bin"
  mkdir -p "$DIR"
  if [ -f "$dest" ] && [ "$(shasum -a 1 "$dest" | cut -d' ' -f1)" = "$sha" ]; then
    echo "→ ggml-$name.bin already here"
    return
  fi
  echo "→ downloading ggml-$name.bin"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$SRC/ggml-$name.bin"
  local got
  got="$(shasum -a 1 "$dest.part" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    rm -f "$dest.part"
    echo "ggml-$name.bin failed its checksum (got $got, want $sha) — nothing installed" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}
fetch small 55356645c2b361a969dfd0ef2c5a50d530afd8d5
if [ "$ACCURATE" = 1 ]; then fetch large-v3-turbo 4af2b29d7ec73d781377bfd1758ca957a807e941; fi

node "$REPO/scripts/install-launchd.mjs" --only sh.chronos.whisper
if [ "$ACCURATE" = 1 ]; then node "$REPO/scripts/install-launchd.mjs" --only sh.chronos.whisper-final; fi

echo "waiting for the model to load…"
for _ in $(seq 1 90); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    echo "speech-to-text is up on 127.0.0.1:$PORT — press the mic on the Desk or the phone"
    exit 0
  fi
  sleep 1
done
echo "sh.chronos.whisper did not answer — see ${CHRONOS_LOG_DIR:-${CHRONOS_HOME:-$REPO}}/whisper.err.log" >&2
exit 1
