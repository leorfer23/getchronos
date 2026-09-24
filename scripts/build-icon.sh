#!/bin/bash
# Rebuild desktop/icon.icns from desktop/icon.svg — the Mac app icon (the hourglass mark from
# site/assets/favicon.svg on the night ground, inside Apple's icon grid).
#
# qlmanage renders the SVG with WebKit but paints the page white, so the squircle's corners are cut
# back to transparent with an antialiased mask of the same rounded rect (Pillow). iconutil then packs
# every size macOS asks for. Only needed after editing icon.svg; the .icns is committed.
set -euo pipefail
DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
qlmanage -t -s 1024 -o "$TMP" "$DESKTOP/icon.svg" >/dev/null
python3 - "$TMP/icon.svg.png" "$TMP/icon-1024.png" <<'PY'
import sys
from PIL import Image, ImageDraw
im = Image.open(sys.argv[1]).convert("RGBA")
s = 4
mask = Image.new("L", (1024 * s, 1024 * s), 0)
ImageDraw.Draw(mask).rounded_rectangle([100 * s, 100 * s, 924 * s - 1, 924 * s - 1], radius=185 * s, fill=255)
im.putalpha(mask.resize((1024, 1024), Image.LANCZOS))
im.save(sys.argv[2])
PY
mkdir -p "$TMP/icon.iconset"
for n in 16 32 128 256 512; do
  sips -z "$n" "$n" "$TMP/icon-1024.png" --out "$TMP/icon.iconset/icon_${n}x${n}.png" >/dev/null
  sips -z "$((n * 2))" "$((n * 2))" "$TMP/icon-1024.png" --out "$TMP/icon.iconset/icon_${n}x${n}@2x.png" >/dev/null
done
iconutil -c icns "$TMP/icon.iconset" -o "$DESKTOP/icon.icns"
echo "built $DESKTOP/icon.icns"
