# More features

Smaller things that are easy to miss. Each one is a few lines here and a link to the full doc.

## Services — always-on processes

A plain command the daemon keeps running for a project: a Slack bot, a local API, a file watcher. Not
an agent.

- Restarts it on exit with backoff; after 5 quick crashes in a row it tells you once and retries every
  10 minutes.
- Logs on the Desk (⋯ → ◉ **Services**) and with `mc service logs <name> -f`.
- Runs outside the agent sandbox, so only you can add, change or restart one.

```bash
mc service add bot --workspace acme --cwd ~/code/acme-bot --command "npm start" --start
```

See [SERVICES.md](../../SERVICES.md).

## Pages agents publish

An agent can write an HTML page — a report, a comparison, a picker — and publish it with
`mc artifact put`. It opens on the Desk in a sandboxed frame and is pinned on that terminal. With
`mc artifact ask` the page *is* the question: you click or fill it, and the agent gets the answer.

Claude terminals also have the claude.ai Artifact tool; an agent asks you which kind you want before
its first page.

## The shared browser

Agents that need a real browser (screenshots, rendering) borrow one shared headless browser through
`mc browser run -- <command>` instead of each launching its own Chrome. See
[RESOURCES.md](../../RESOURCES.md).

## Jira and ClickUp

A project can mirror its tickets to Jira or ClickUp. Pulls create and update tickets; pushes are
explicit (`mc comment`, `mc push-status`, `mc hours`). New assignments, mentions and status changes on
your tasks land in the project's [inbox](asks.md).

## Telegram

Control and notifications from Telegram, with no inbound port (long polling). Set
`CHRONOS_TG_TOKEN` (from @BotFather) and `CHRONOS_TG_CHAT_ID` in `.secrets`. There the assistant
proposes and you confirm risky actions with a tap.

## Shared vars

Hand one project's agents an env var, optionally for N hours: Desk → ⋯ → 🔑 **Shared vars**, or
`mc vars set NAME VALUE --hours 12` on the daemon's Mac. Agents list names with `mc vars`; values never
pass through a transcript.

## Files between computers

`mc file put report.pdf` on one computer, `mc file get report.pdf` on another. Files leave the shelf
after 7 days.

## Spend over time

📊 **Altitude** (⋯ menu, or `/altitude`): spend, usage, terminals and runs over a window, split by
project, model and stage, with CSV export. `mc cost` and `mc altitude` print the same in a shell.

## The day's log

⋯ → 🗒 **Log** (or `mc desk log`): every terminal worked on today, what it cost, what it left behind,
and how to reopen it.

---

**Under the hood:** services `src/services.ts` · pages `src/artifacts.ts`, `static/artifact-view.js` ·
browser `src/resources/browser-*.ts` · trackers `src/connectors/` · Telegram `src/telegram/` · shared
vars `src/child-env.ts` · files `mc file` in `scripts/mc` · Altitude `src/analytics.ts`.
