#!/bin/bash
# Build the Desk window (desktop/app.swift) as a .app bundle in ~/.mc, symlinked onto the mc PATH
# as `mc-app`.
#
# The bundle exists for one reason: an icon. A bare Mach-O binary — which is what `swiftc -o
# ~/.mc/bin/mc-app` produced — has no Info.plist, so macOS has nowhere to read CFBundleIconFile
# from and falls back to the generic Unix-executable tile (the dark square with green "exec").
# The icon is desktop/icon.icns — the hourglass mark, built from desktop/icon.svg by
# scripts/build-icon.sh. A bundle is what lets macOS read it, and the same Info.plist gets it a real
# name in the Dock and ⌘-tab instead of "mc-app".
set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/desktop"
SRC="$DESKTOP/app.swift"
ICNS="$DESKTOP/icon.icns"
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
  <key>NSMicrophoneUsageDescription</key><string>Chronos listens while a voice call with Robert is connected, or while you talk to the bar.</string>
  <!-- The bar (desktop/app.swift → static/bar.html): Services → "Send to Chronos" on selected text or a
       file, and chronos://capture?… for other apps (Shot). Both only fill the bar in; ↵ sends. -->
  <key>NSServices</key><array><dict>
    <key>NSMenuItem</key><dict><key>default</key><string>Send to Chronos</string></dict>
    <key>NSMessage</key><string>sendToChronos</string>
    <key>NSPortName</key><string>Chronos</string>
    <key>NSSendTypes</key><array><string>public.utf8-plain-text</string><string>public.url</string></array>
    <key>NSSendFileTypes</key><array><string>public.image</string><string>com.adobe.pdf</string><string>public.plain-text</string></array>
    <key>NSRequiredContext</key><dict/>
  </dict></array>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>sh.chronos.capture</string>
    <key>CFBundleURLSchemes</key><array><string>chronos</string></array>
  </dict></array>
</dict></plist>
PLIST

# Which checkout and port this app belongs to (desktop/app.swift chronosConfig): the token is read from
# that checkout and the Desk loaded from that port however the app is started. ChronosSource is the
# source's hash, so `npm run setup` rebuilds only when app.swift or either of these changed.
REPO="$(dirname "$DESKTOP")"
plutil -insert ChronosHome -string "${CHRONOS_HOME:-$REPO}" "$APP/Contents/Info.plist"
plutil -insert ChronosURL -string "http://localhost:${CHRONOS_PORT:-7777}" "$APP/Contents/Info.plist"
plutil -insert ChronosSource -string "$(shasum -a 256 "$SRC" | cut -c1-16)" "$APP/Contents/Info.plist"

cp "$ICNS" "$APP/Contents/Resources/icon.icns"
swiftc -O "$SRC" -o "$APP/Contents/MacOS/mc-app"

# Same reasoning as build-wapp.sh: sign with the local identity when it exists so the code hash is
# not the thing macOS remembers about this app; ad-hoc otherwise.
# No `-v`: a self-signed identity is listed as CSSMERR_TP_NOT_TRUSTED, which `-v` hides — so the app
# was signed ad-hoc even with the certificate in the keychain, and every rebuild reset its
# Accessibility and microphone grants. codesign signs with it either way; trust is not needed.
SIGN_ID="${MC_APP_SIGN_ID:-Chronos Local Signing}"
if security find-identity -p codesigning | grep -qF "\"$SIGN_ID\""; then
  codesign -s "$SIGN_ID" -f --identifier sh.chronos.app "$APP"
else
  codesign -s - -f --identifier sh.chronos.app "$APP"
fi

mkdir -p "$(dirname "$LINK")"
ln -sf "$APP/Contents/MacOS/mc-app" "$LINK"

# ~/.mc is a dot-directory, and Spotlight never indexes those — so the bundle there cannot be found
# by name. A copy in ~/Applications can. Same bundle id and signature, so it is the same app to macOS.
SPOT="$HOME/Applications/Chronos.app"
mkdir -p "$(dirname "$SPOT")"
rm -rf "$SPOT"
ditto "$APP" "$SPOT"

# Everything below reaches past $HOME into the login session (Spotlight, LaunchServices, the Dock).
# CHRONOS_APP_NO_REGISTER=1 skips it: a test build into a scratch HOME must not register a second
# sh.chronos.app — chronos:// links would open it instead of the real one — or restart the Dock.
if [ -z "${CHRONOS_APP_NO_REGISTER:-}" ]; then
  mdimport "$SPOT" 2>/dev/null || true

  # The Services menu and the chronos:// scheme are read from Info.plist by LaunchServices and pbs; a
  # rebuilt bundle is not picked up until they re-scan.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
  /System/Library/CoreServices/pbs -update 2>/dev/null || true

  # The icon is cached per bundle path by the icon services daemon, and a rebuilt bundle at the same
  # path keeps showing the old tile until the mtime moves and the Dock restarts. Both are cheap.
  touch "$APP"
  killall Dock 2>/dev/null || true
fi

echo "built $APP (symlinked as $LINK, copied to $SPOT for Spotlight)"
