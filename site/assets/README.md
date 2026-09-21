# site/assets/

Product screenshots for the Chronos OSS landing page and README. Everything here is fictional —
seeded into a throwaway daemon, never the live one. See "Regenerating" below to rebuild these from
scratch.

## Files

| File | What it shows |
| --- | --- |
| `desk-hero.webp` / `.png` | `/desk` itself — the wall of live terminal cards: a Lead with two workers (one blocked on a question), plus an independent worker, in varied states. |
| `ticket-run.webp` / `.png` | A ticket detail page (`/app`) mid-review, with its dispatched mock run's cost, summary and real Work log entries. |
| `ask.webp` / `.png` | A ticket blocked on a human-in-the-loop ask, with the answer box open ("Waiting on you"). |
| `phone.webp` / `.png` | The phone PWA (`/phone.html`) at phone size — real, alive counts and an inline "asking" badge. |

`logo.svg`, `favicon.svg`, `og-cover.jpg` and `mascot.svg` are owned by a separate mascot-design
slice of this work and are not in this directory yet.

## Where the data came from

None of it is real. `scripts/demo-seed.mjs` invents three fictional projects (`acme-api`,
`storefront`, `docs-site`) with tickets across the full lifecycle (backlog → planned → in progress →
review → done), a couple of headless runs on the `mock` backend (`src/backends/mock.ts` — no model
calls, no cost), one ticket left genuinely paused on an open ask, and — for `/desk` and `/phone.html`,
which are wired to live terminal *sessions* rather than tickets — five real (harmless) Desk terminal
sessions: one Lead supervising the "Ship checkout redesign" goal, two of its workers (one blocked on
its own question), one independent worker, and one finished/killed session for the "Recent" list.

Those sessions never spawn a real agent CLI or touch real credentials: `mock.ts` now also implements
`interactiveArgs()`, a harmless `node -e` script that prints a short plausible transcript once the
ticket brief is typed in (the same way a real agent's first turn would be), then idles. The actual
state each screenshot shows (working / blocked / done) comes from `mc state`-equivalent API calls and
an ask the seed script makes afterward, not from anything that script prints.

A Lead's workers are only linked to it (`lead_id`) when the caller presents that Lead's own
credential (`x-mc-lead`) — nothing else can claim a worker for a Lead it doesn't own. That credential
is deliberately stripped from every API response, so for this scratch-only seed the script reads it
directly out of the scratch DB file instead — a local, read-only file read of a throwaway sqlite file
the script just created itself, isolated from the live daemon's DB. `CHRONOS_DB` (the same value used
to boot the scratch daemon) must therefore be set when running `demo-seed.mjs`.

Every screenshot was taken with `scripts/demo-screenshot.mjs` against that seeded instance,
authenticated with the **scratch** daemon's own admin token (written into browser storage before the
page loads — never pasted into a visible dialog, never in a URL), and inspected by hand for anything
that looked like it came from the real daemon before being committed.

## Regenerating

You need a **scratch** Chronos daemon — a separate port, a separate throwaway DB (a real file, not
`:memory:` — see above), nothing shared with the live one — plus
[Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) and `cwebp`
(`brew install webp`).

```bash
# 1. Boot a scratch daemon (never the live one — separate port, separate DB, background side
#    effects off). From the repo root:
CHRONOS_PORT=7799 \
CHRONOS_DB=/tmp/chronos-scratch/scratch.db \
CHRONOS_ADMIN_TOKEN=scratch-demo-token \
CHRONOS_SANDBOX_DEFAULT=off \
CHRONOS_DESKTOP_NOTIFY=0 CHRONOS_DAY_HEARTBEAT=0 CHRONOS_STANDUP=0 CHRONOS_AUTOPLAN_MIN=0 \
CHRONOS_PUSH=0 CHRONOS_SELF_DEPLOY=0 CHRONOS_ROBERT_WAKE=0 CHRONOS_ROBERT_DRIVE=0 \
CHRONOS_TERMINAL_PROMPTS=0 CHRONOS_TERMINAL_FAILOVER=off \
CHRONOS_AUTO_MERGE=0 CHRONOS_AUTO_CI_FIX=0 CHRONOS_DELIVERY_POLL_MIN=0 CHRONOS_CI_POLL_SEC=0 \
CHRONOS_QUOTA_GATE=off CHRONOS_MEMORY_CONFLICTS=0 CHRONOS_REPO_SCAN_MIN=0 \
CHRONOS_CONNECTOR_SYNC_MIN=0 CHRONOS_MONITOR_MIN=0 CHRONOS_RECOVER_SWEEP_MIN=0 \
npx tsx src/index.ts &

# 2. Seed it with fictional demo data (over HTTP, plus one direct read-only peek at the scratch DB
#    file for a Lead's session token — see demo-seed.mjs).
CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-demo-token \
CHRONOS_DB=/tmp/chronos-scratch/scratch.db \
  node scripts/demo-seed.mjs

# 3. Capture the screenshots.
CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-demo-token \
  node scripts/demo-screenshot.mjs site/assets

# 4. Shut the scratch daemon down and confirm nothing survived it (the Desk sessions above are real
#    child processes, harmless `node -e` scripts, but still real PIDs on your machine).
kill %1
```

Before committing anything this produces: open every image and check for real workspace names,
ticket keys, tokens, personal paths, or the real Claude/Grok/Cursor usage chips (the screenshot
script already stubs `/api/usage` to an empty snapshot so those never render, but check anyway).
