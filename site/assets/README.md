# site/assets/

Product screenshots for the Chronos OSS landing page and README. Everything here is fictional —
seeded into a throwaway daemon, never the live one. See "Regenerating" below to rebuild these from
scratch.

## Files

| File | What it shows |
| --- | --- |
| `desk-hero.webp` / `.png` | The Desk's Fleet wall (`/desk`): fleet pulse, an open ask waiting on the operator, Robert's supervision panel. |
| `ticket-run.webp` / `.png` | A ticket detail page (`/app`) mid-review, with its dispatched mock run's cost and one-line summary. |
| `ask.webp` / `.png` | A ticket blocked on a human-in-the-loop ask, with the answer box open ("Waiting on you"). |
| `phone.webp` / `.png` | The phone view (`/phone`) at mobile width. |

`logo.svg`, `favicon.svg`, `og-cover.jpg` and `mascot.svg` are owned by a separate mascot-design
slice of this work and are not in this directory yet.

## Where the data came from

None of it is real. `scripts/demo-seed.mjs` invents three fictional projects (`acme-api`,
`storefront`, `docs-site`) with tickets across the full lifecycle (backlog → planned → in progress →
review → done), a couple of runs on the `mock` backend (`src/backends/mock.ts` — no model calls, no
cost), one ticket left genuinely paused on an open ask, and a goal ticket with three linked children
standing in for a Lead's worker tickets (spinning up a real Lead terminal would mean spawning a real
agent process, which a screenshot script shouldn't do). Every screenshot was taken with
`scripts/demo-screenshot.mjs` against that seeded instance and inspected by hand for anything that
looked like it came from the real daemon before being committed.

## Regenerating

You need a **scratch** Chronos daemon — a separate port, a separate throwaway DB, nothing shared
with the live one — plus [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing)
and `cwebp` (`brew install webp`).

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

# 2. Seed it with fictional demo data (purely over HTTP — see the script for exact endpoints).
CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-demo-token \
  node scripts/demo-seed.mjs

# 3. Capture the screenshots.
CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-demo-token \
  node scripts/demo-screenshot.mjs site/assets
```

Before committing anything this produces: open every image and check for real workspace names,
ticket keys, tokens, personal paths, or the real Claude/Grok/Cursor usage chips (the screenshot
script already stubs `/api/usage` to an empty snapshot so those never render, but check anyway).
