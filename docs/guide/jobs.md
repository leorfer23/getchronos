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
- Anything red: one terminal opens in that project to find the cause, fix it, re-run the job, and hand
  off.

Run it yourself any time: `mc job check`. Turn it off with `CHRONOS_JOB_CHECK=0`.

## Same engine as everything else

Jobs run on the same engine as ticket builds: sandbox, timeouts, retries, rate-limit resume, budgets
and the burn guard all apply.

---

**Under the hood:** scheduler `src/scheduler.ts` (Croner, the DB is the source of truth) ·
`src/dispatcher.ts` → `src/runner.ts` · webhook route in `src/api.ts` (`/triggers/hook/:token`) ·
job check `src/job-check.ts` · `mc job` in `scripts/mc` · the assistant's side `agents/_blocks/jobs.md`.
