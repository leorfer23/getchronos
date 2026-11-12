# Your phone

The phone app (`/phone`) is Chronos in your pocket: talk to the assistant, say yes to what is waiting
for you, get an alert when a terminal is stuck. It needs an HTTPS address — the app's offline shell,
its notifications and the microphone only work on a secure page — and Chronos itself only ever
listens on this Mac. The easy way to give it one is Tailscale: free, no domain, no Cloudflare account.

## In about a minute, with Tailscale

1. **On the Mac:** install Tailscale and sign in (Google, Apple, GitHub, Microsoft…):
   `brew install --cask tailscale-app`, or download it from [tailscale.com/download/mac](https://tailscale.com/download/mac).
2. **In the Desk:** ⋯ → 📱 **Phone** → **Turn on phone access**.
3. **On the phone:** install Tailscale from the [App Store](https://apps.apple.com/us/app/tailscale/id1470499037)
   or [Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn) and sign in with
   **the same account** as the Mac.
4. **Scan the QR code** with the phone's camera. The page opens signed in. The code in it works once,
   for 5 minutes — **New code** makes another.
5. **Make it an app.** A banner offers it:
   - **iPhone:** Share → **Add to Home Screen**. An iPhone app keeps its own sign-in, separate from
     Safari, so tap **Copy link** on the banner first and paste it when the app asks.
   - **Android:** tap **Install**.

If the dialog says HTTPS certificates are off: on the
[DNS page of the Tailscale admin console](https://console.tailscale.com/admin/dns), turn on MagicDNS
if it is off, select **Enable HTTPS**, then **Check again**. Your machine names go into a public
certificate log when you do, so rename the Mac first if its name is private.

## Who can open it

- The address is `https://<this-mac>.<your-tailnet>.ts.net`. Only devices on your own tailnet can
  reach it — it is not on the internet.
- At that address Chronos answers **only your Tailscale account**: the one signed in on this Mac when
  you turned phone access on. Anyone else on the same tailnet — a colleague on a company tailnet, a
  device someone shared with you — gets "This Chronos only answers its owner." Tagged devices
  (servers, CI) carry no identity, so they are refused too.
- Being your account is not a password: the phone still signs in with a pairing code from the Desk.
- Chronos never uses Tailscale Funnel (it would put the address on the public internet) and refuses
  anything that arrives through it.
- To turn it off: `tailscale serve --https=443 off`.

## If something is off

| The dialog or phone says | Do this |
|---|---|
| Tailscale isn't installed / not signed in / not running | Open the Tailscale app on the Mac and sign in, then **Check again**. |
| Tailscale already shares something else at that address | Chronos won't replace another app. If you don't need that one, `tailscale serve --https=443 off`, then **Check again**. |
| This Mac is a tagged device | The Mac belongs to an admin's tag, not to a person. Sign it in to your own account, or use Cloudflare (below). |
| "This Chronos only answers its owner" | The phone is signed in to Tailscale with a different account than the Mac. Use the same one. |
| "Phone access over Tailscale isn't turned on" | Desk → ⋯ → Phone → **Turn on phone access** — also after you switch the Mac to another Tailscale account. |

## Already have a domain on Cloudflare?

Put Cloudflare Tunnel + Access in front of the daemon instead:
[CONFIGURATION.md §4](../../CONFIGURATION.md#4-optional-reach-it-from-your-phone). Put your public
address in `.secrets` at the repo root (`CHRONOS_DESK_URL=https://desk.example.com`) and the same Phone
dialog shows a QR code for it. If Access asks you to sign in on the phone first, scan the code again
afterwards.

## No app at all: Telegram

For alerts and a word with the assistant without installing anything, connect a Telegram bot —
`CHRONOS_TG_TOKEN` and `CHRONOS_TG_CHAT_ID` in `.secrets`
([CONFIGURATION.md §4](../../CONFIGURATION.md#4-optional-reach-it-from-your-phone)). The daemon talks to
Telegram outbound; nothing reaches the Mac from outside.

---

**Under the hood:** `tailscale serve` + status `src/phone-access.ts` · the owner gate
`src/phone-gate.ts` · routes `src/phone-routes.ts` · the Desk dialog `static/desk-phone.js` · the
install banner `static/phone-install.js` · security model [SECURITY.md](../../SECURITY.md).
