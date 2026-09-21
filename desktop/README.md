# Mission Control — desktop shells

Native windows over the local Chronos daemon (`http://localhost:7777`). The daemon runs under
launchd; these are just renderers in real windows, and each reads `.admin-token` itself and injects
`window.__MC_TOKEN__` (the daemon never templates the token into HTML).

| File | Builds to | What it is |
|---|---|---|
| `app.swift` | `mc-app` (`scripts/build-app.sh`) | Resizable app window. Takes the page as an argument: `mc-app /desk` is the terminal wall, bare `mc-app` opens `/app`. |
| `overlay.swift` | `mc-overlay` | Always-on-top ticket panel over `/overlay.html`. |
| `wapp.swift` | `wapp` (`scripts/build-wapp.sh`) | Drives the real WhatsApp desktop client. See below. |

**`src-tauri/` is vestigial.** It is a Tauri v2 scaffold from before the Swift shells existed, and
nothing builds it any more — `scripts/build-app.sh` reads exactly one file out of it,
`icons/icon.icns`. The section below is kept for whoever wants to revive it; it points at `/`, which
now redirects to the small overlay rather than the dashboard it was written against.

## The Tauri scaffold (unused)

A thin native window with a global hotkey (**Cmd+Shift+M**) registered in `src-tauri/src/main.rs`.

## One-time setup

1. **Install Rust** (Tauri needs it):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   source "$HOME/.cargo/env"
   ```
2. **Tauri CLI**:
   ```bash
   cargo install tauri-cli --version "^2"
   ```
3. macOS build deps come with Xcode Command Line Tools (`xcode-select --install`).

## Run (dev)

The Chronos daemon must be up on :7777 (it is, via launchd).
```bash
cd desktop/src-tauri
cargo tauri dev          # opens the native window
```

## Package a .app

```bash
# add real icons once (from any square PNG):
cargo tauri icon ../icon-source.png
# then flip "bundle.active": true in tauri.conf.json and:
cargo tauri build        # -> src-tauri/target/release/bundle/macos/Mission Control.app
```

## Notes
- The window points straight at `http://localhost:7777`; `dist-ui/` is only the bundler
  fallback (redirects to the daemon, or shows "daemon not running").
- Global shortcut is registered in `src/main.rs`. Add a tray icon there next.
- `bundle.active` is **false** by default so `cargo tauri dev` runs without needing icons.

## Ticket overlay (floating widget)

Tiny always-on-top panel with full ticket CRUD, grouped by workspace → repo. Page lives at
`static/overlay.html` (served by the daemon at `/overlay.html`); the native shell is
`desktop/overlay.swift` — no Tauri/Rust needed:

```bash
swiftc -O desktop/overlay.swift -o ~/.mc/bin/mc-overlay
mc-overlay &   # floating panel; drag by top edge, ✕ to close, position persists
```

In the panel: `＋` new ticket (Enter to save), status pill = dropdown, double-click title to
edit, `✕` twice to delete. Closed tickets hidden unless "closed" is checked.

### Launch at login

```bash
cp launchd/sh.chronos.overlay.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/sh.chronos.overlay.plist
```

Closing the panel (✕) keeps it closed until next login — no KeepAlive by design.
Relaunch manually anytime: `mc-overlay &`.

## wapp (WhatsApp from an agent)

`desktop/wapp.swift` drives the **real** WhatsApp desktop client — `whatsapp://send` to open the chat
and load the text, Accessibility to read the composer back and press Return. No linked device and no
reverse-engineered protocol: WhatsApp only ever sees its own official client, so ban exposure stays
behavioral (volume, reply-ratio) instead of fingerprint-based. Linked-device libraries (Baileys,
whatsapp-web.js) were rejected for exactly that reason — they get the number banned.

```bash
./scripts/build-wapp.sh   # builds ~/.mc/wapp.app, symlinks ~/.mc/bin/wapp
wapp doctor
```

### Stable signing identity

The build signs with a self-signed **"Chronos Local Signing"** certificate, and that is load-bearing.
Ad-hoc signing pins TCC's stored requirement to the code hash, so every edit to `wapp.swift` silently
revoked Accessibility and it had to be re-granted by hand. With a certificate the requirement becomes
`identifier "sh.chronos.wapp" and certificate leaf = H"…"` — no hash — which the next build still
satisfies. Verify with `codesign -d -r- ~/.mc/wapp.app`.

Recreate it on a new machine (the build falls back to ad-hoc, loudly, if it is missing):

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=Chronos Local Signing" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature"
# -legacy matters: `security` cannot read an OpenSSL 3 default PKCS12, and the password cannot be empty
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -out wapp.p12 -passout pass:chronos \
  -name "Chronos Local Signing"
security import wapp.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -P chronos
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
rm key.pem wapp.p12   # the identity now lives in the keychain
security find-identity -v -p codesigning   # must list it, or codesign will not use it
```

Changing the certificate changes the requirement, so Accessibility needs re-granting once after that.

Then grant **Accessibility** to `~/.mc/wapp.app` in System Settings → Privacy & Security →
Accessibility (drag it in from `~/.mc`). Grant the **bundle**, not your terminal. Accessibility is
checked against the calling process, and a bare CLI binary is attributed to whatever was responsible
for launching it: grant it from Terminal and it works from Terminal, then fails under launchd — which
is exactly where an agent runs. The bundle carries its own identity, so one grant covers every caller.
That is also why this is a compiled binary rather than a shell script: Claude Code's own path carries
its version (`…/versions/2.1.220`) and would lose the grant on every update.

**Verify from a launchd context, never from a terminal** — a terminal lends the process a grant an agent
will not have, so `wapp doctor` in a shell will happily report success on a setup that is broken for
her. Drop a throwaway LaunchAgent that runs `wapp doctor` and read its stdout.

```bash
wapp draft --to "+5491122334455" --text "hola"   # opens chat, loads text, does NOT send; prints a token
wapp send --token <tok>                          # presses Return
wapp cancel                                      # drop the token
wapp probe --depth 8                             # dump the AX tree (selector tuning)
```

The draft/send split is the approval gate, and it is structural rather than a prompt instruction:
`send` needs a token from `draft`, the token dies after 10 minutes, and `send` re-reads the composer
and aborts unless it still holds byte-for-byte the approved text. So nothing can go out that the operator has
not seen sitting in their own WhatsApp window. No agent ships wired to `wapp`: if you give one this
tool, tell it to default to `draft` and to call `send` only on an explicit go-ahead.

Groups have no `whatsapp://` URL scheme — draft the text and paste it by hand.

### Scheduled sends

```bash
wapp draft --to "+5491122334455" --text "buen día"   # he sees it; note the token
wapp schedule --token <tok> --at 07:00 [--days mon,tue,wed,thu,fri] [--once]
wapp schedules
wapp unschedule <id>
```

`schedule` consumes a `draft` token, so a scheduled message is one the operator saw sitting in their own window
before it was stored. The text is then **frozen**: fire time re-sends those exact bytes.

Deliberately **not** built on a Chronos cron job. A job dispatches an agent, and there is no shell
backend — so 7am would mean an LLM deciding what to send, which erases the whole approval model and
costs tokens every morning. Instead each schedule writes its own LaunchAgent
(`~/Library/LaunchAgents/sh.chronos.wapp-<id>.plist`) that calls `wapp fire <id>`; no model is in the
path. `fire` is for launchd only — it logs and posts a desktop notification on every outcome, since
a scheduled message that silently never went out is the worst failure here (`~/.mc/state/wapp.log`).

**Timing is approximate, by design.** This Mac sleeps after a minute (`pmset -g custom` → `sleep 1`,
on AC too), and nothing here wakes it. `StartCalendarInterval` runs the job when the machine next
wakes rather than skipping the day, so 07:00 means "07:00 or shortly after you open the lid". Making
it exact would need `pmset repeat wake`, which was consciously not done. `sh.chronos.whatsapp` opens
WhatsApp at login so a fire finds it running **with a window** — with the window closed the AX tree is
just the menu bar and there is no composer to write into.

### Things the AX layer does that will bite again

- **`?text=` appends, it does not replace.** Open a chat that already holds a draft and the parameter
  is concatenated onto it. That append is also the only reliable proof the right chat opened, so it is
  kept rather than worked around: an unexpected prefix is reported as a conflict and the draft is left
  alone (`--force` replaces it, `wapp clear` empties it). `fire` never forces — unattended is exactly
  when destroying something the operator typed is unrecoverable. Cmd+V appends the same way, so the clipboard
  fallback only runs against an empty composer.
- **The Send button moves.** It has been observed both after the composer and before it
  (`[attach][send][composer][emoji]`). Keying off "the next button after the composer" quietly picked
  the emoji picker and a scheduled send silently did nothing. Match the **label**, never the position.
- **An emptied composer does not prove a send.** `?text=` is re-applied a beat after the chat opens
  and can refill the box right after a real send — which reported a false failure and left a `--once`
  schedule armed to fire again the next day. Success is a **new transcript row** quoting the text;
  the empty box is only a secondary signal.
- **`fire` boots out its own launchd job** when retiring a `--once`, which can kill the process
  mid-call. Delete the state files *before* the bootout, never after.
