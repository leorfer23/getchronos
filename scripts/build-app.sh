#!/bin/bash
# Build the Desk window (desktop/app.swift) as a .app bundle in ~/.mc, symlinked onto the mc PATH
# as `mc-app`.
#
# The bundle exists for one reason: an icon. A bare Mach-O binary — which is what `swiftc -o
# ~/.mc/bin/mc-app` produced — has no Info.plist, so macOS has nowhere to read CFBundleIconFile
# from and falls back to the generic Unix-executable tile (the dark square with green "exec").
# The Desk's own icon shipped in desktop/src-tauri/icons/icon.icns and nothing on this surface
# consumed it. A bundle does, and the same Info.plist gets it a real name in the Dock and ⌘-tab
# instead of "mc-app".
set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop"
SRC="$DESKTOP/app.swift"
ICNS="$DESKTOP/src-tauri/icons/icon.icns"
APP="$HOME/.mc/mc-app.app"
LINK="$HOME/.mc/bin/mc-app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>mc-app</string>
  <key>CFBundleIdentifier</key><string>sh.chronos.app</string>
  <key>CFBundleName</key><string>Chronos</string>
  <key>CFBundleDisplayName</key><string>Chronos</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Chronos listens while a voice call with Robert is connected.</string>
</dict></plist>
PLIST

cp "$ICNS" "$APP/Contents/Resources/icon.icns"
swiftc -O "$SRC" -o "$APP/Contents/MacOS/mc-app"

# Same reasoning as build-wapp.sh: sign with the local identity when it exists so the code hash is
# not the thing macOS remembers about this app; ad-hoc otherwise.
SIGN_ID="${MC_APP_SIGN_ID:-Chronos Local Signing}"
if security find-identity -v -p codesigning | grep -qF "$SIGN_ID"; then
  codesign -s "$SIGN_ID" -f --identifier sh.chronos.app "$APP"
else
  codesign -s - -f --identifier sh.chronos.app "$APP"
fi

mkdir -p "$(dirname "$LINK")"
ln -sf "$APP/Contents/MacOS/mc-app" "$LINK"

# The icon is cached per bundle path by the icon services daemon, and a rebuilt bundle at the same
# path keeps showing the old tile until the mtime moves and the Dock restarts. Both are cheap.
touch "$APP"
killall Dock 2>/dev/null || true

echo "built $APP (symlinked as $LINK)"
