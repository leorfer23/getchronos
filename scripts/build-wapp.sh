#!/bin/bash
# Build wapp as a .app bundle in ~/.mc, symlinked onto the mc PATH as `wapp`.
#
# The bundle is not cosmetic. Accessibility is checked against the calling process, and a bare CLI
# binary launched from a shell gets attributed to the *responsible* process — grant it from Terminal
# and it works from Terminal, then silently fails under launchd, which is where the daemon actually runs.
# A bundle carries its own identity, so one grant covers every caller. LSUIElement keeps it out of
# the Dock (it uses AppKit for NSWorkspace).
#
# A rebuild changes the code hash: re-grant Accessibility afterwards.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop/wapp.swift"
APP="$HOME/.mc/wapp.app"
LINK="$HOME/.mc/bin/wapp"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>wapp</string>
  <key>CFBundleIdentifier</key><string>sh.chronos.wapp</string>
  <key>CFBundleName</key><string>wapp</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

swiftc -O "$SRC" -o "$APP/Contents/MacOS/wapp"

# Sign with the local self-signed identity when it exists. This is what makes the Accessibility grant
# survive a rebuild: an ad-hoc signature pins TCC's stored requirement to the code hash, so every edit
# to wapp.swift silently revoked the permission and had to be re-granted by hand. A certificate makes
# the requirement "this identifier signed by this cert", which the next build still satisfies.
# Create one with scripts/../desktop/README.md → "Stable signing identity".
SIGN_ID="${WAPP_SIGN_ID:-Chronos Local Signing}"
if security find-identity -v -p codesigning | grep -qF "$SIGN_ID"; then
  codesign -s "$SIGN_ID" -f --identifier sh.chronos.wapp "$APP"
else
  echo "warning: '$SIGN_ID' not in the keychain — falling back to ad-hoc." >&2
  echo "         Accessibility will need re-granting after every rebuild." >&2
  codesign -s - -f --identifier sh.chronos.wapp "$APP"
fi

mkdir -p "$(dirname "$LINK")"
ln -sf "$APP/Contents/MacOS/wapp" "$LINK"

echo "built $APP (symlinked as $LINK)"
echo
echo "Grant Accessibility to wapp.app, then verify from a launchd context — NOT just a terminal,"
echo "since a terminal lends it a grant the daemon will not have:"
echo "  open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'"
echo "  open $HOME/.mc"
