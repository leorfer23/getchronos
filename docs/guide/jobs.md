# Jobs

A **job** is agent work you do not sit in front of: "every weekday at 9, check the nightly export",
"in 20 minutes, run the probe", "every hour, triage the support channel".

A job is: instructions (the goal), a CLI and model, a working folder, the tools it may use, and a
trigger. Each run is recorded — status, cost, a summary, and a plain-English story of what it did.

## Triggers

- **Cron** — a schedule in your timezone: `0 9 * * 1-5` (weekdays 09:00), `*/30 * * * *` (every 30 min).
- **Once** — a time: "2026-12-01 09:00". After it fires it stays as a manual job with its run in history.
- **Manual** — runs when you press Run.
- **Webhook** — a trigger with a secret URL (`/api/triggers/hook/<token>`); a GET or POST fires the job.

## Make one

- **Ask the assistant:** "every weekday at 9 check the nightly export on acme and tell me only if it
  failed". He confirms the schedule and model in one line before creating a recurring job — those cost
  money forever.
- **Desk:** ⋯ → ⏱ **Jobs** → **+ New job**.
- **Shell:**
  ```bash
  mc job new --name "nightly export check" --goal "…" --cron "0 9 * * 1-5" \
    --workspace <id> --model sonnet --allowed-tools "Read,Grep,Glob"
  ```

Limit what it can touch: a job that only reads gets read-only tools; anything that edits a repo runs in
the `guard` sandbox. A timeout and a per-run budget cap a runaway.

## Watch them

- **Jobs page** (⋯ → ⏱ Jobs): every job with its last runs as a strip, success rate, cost and average
  time. Run, pause, edit or delete; select several to act on them at once. "System jobs" shows the
  fleet's own runs (plans, builds, reviews, memory passes).
- **Notifications** per job: all endings, failures only, or off.
- **Step in:** a running job can be turned into a live terminal on its own conversation.

```bash
mc job list                    # this project's jobs
mc job run "nightly export check"
mc job update <id|name> --model haiku --notify failures
mc run list --job <id>         # recent runs
```

## The daily job check

Every day at 17:00 (your time) the daemon checks each project's jobs from the last 24 hours — no model
involved. Red means: the last run failed, timed out or was refused; a scheduled fire never ran; or it
failed 3+ times that day.

- All green: nothing happens.
- Anything red: you get one card listing what failed (Inbox → Stalled, Telegram if connected,
  `mc recover`). Nothing re-runs until you approve it; approving opens one terminal in that project to
  find the cause, fix it, re-run the job, and hand off. Leave it and nothing happens.

⚙ Settings → Autonomy → *Daily job check fixes and re-runs failed jobs* skips the card: the terminal
opens right away. It is off on a new install; an install that had projects before the setting existed
keeps it on.

Run it yourself any time: `mc job check`. Turn it off with `CHRONOS_JOB_CHECK=0`.

## When something happens: workspace triggers

A job runs on a clock. A **workspace trigger** waits for an event and then opens the right work in that
project: "when a PR on web fails CI, open a terminal to fix it", "when the daily cost leaves its usual
range, open the cost explainer", "when a client's message arrives, draft the answer".

```bash
mc trigger add pr web --on failing --goal "find why CI broke on {subject} and fix it on its branch"
mc trigger add metric "./bin/cost-today" --within 25% --cron "0 9 * * *" --skill cost-explainer
mc trigger add slack --from ana --goal "read what Ana asked and draft the answer"
mc trigger add command "ls ~/Shared/drop" --lines --goal "load {subject}"
mc trigger add email --from billing@vendor.example --inbox
mc trigger test <id8>          # dry run: what it sees now, and what each event would do
mc trigger list | show <id8> | pause <id8> | resume <id8> | rm <id8>
```

- **Conditions:** a PR event on one of the project's own repos; a Slack DM or @mention (from the inbox
  the Slack triage fills — no model cost); an email from a sender or anything in words (a short
  read-only probe, which costs a model call per look); a command that succeeds, or prints new lines
  (a new file in a folder); a **metric** — a command that prints a number, checked against a band
  (`--band 100..250`) or against its trailing 7-day median (`--within 25%`).
- **Actions:** a terminal with a goal and optionally one of the project's skills (default), a playbook,
  or an inbox item.
- **New events only, one piece of work per event.** The first look is a baseline. While the terminal a
  trigger opened is still open, the next event is typed into it (after its current turn) instead of
  opening another; `--dedupe subject` gives each PR, person or file its own. `--rate 3/day` (the
  default) caps the new work it starts; past it events are recorded, not acted on. Nothing is retried.
- **It respects the machine:** nothing is looked at or opened while the Mac is asleep, in a dark wake
  or offline, or in the project's quiet hours (⚙ Settings → Autonomy → *Trigger quiet hours*).
- **Safe by default:** commands run in the project's sandbox with its own `mc vars`; the terminals a
  trigger opens are boxed like inbox terminals (drafts only, no merge, deploy or message). A trigger an
  agent adds is saved **off** until you turn it on: ⏰ Open loops → *When it happens*.

## Same engine as everything else

Jobs run on the same engine as ticket builds: sandbox, timeouts, retries, rate-limit resume, budgets
and the burn guard all apply.

---

**Under the hood:** scheduler `src/scheduler.ts` (Croner, the DB is the source of truth) ·
`src/dispatcher.ts` → `src/runner.ts` · webhook route in `src/api.ts` (`/triggers/hook/:token`) ·
job check `src/job-check.ts` · `mc job` in `scripts/mc` · the assistant's side `agents/_blocks/jobs.md` ·
workspace triggers `src/ws-triggers.ts` + `src/ws-trigger-routes.ts` (`mc trigger`).
