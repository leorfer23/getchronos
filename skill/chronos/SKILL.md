---
name: chronos
description: Create, run, schedule, and manage autonomous Claude Code jobs via the local Chronos daemon (http://localhost:7777). Use when the user wants to schedule or cron a Claude task, run an automated/headless Claude job, trigger Claude work on a schedule or webhook, set up a recurring agent, or list/inspect/stop/edit Chronos jobs and runs. Trigger on "schedule a job", "cron a claude task", "run X every morning", "chronos", "automate this with claude", "set up a recurring agent".
---

# Chronos — local Claude Code job manager

Chronos is a local daemon (at `~/chronos`, served on **http://localhost:7777**) that schedules and
runs **headless Claude Code jobs** on this Mac. Each job = a goal/prompt + account profile + model
+ schedule + guardrails. It runs `claude -p` for the job, streams output, records every run, and
can fire jobs by cron, manual click, Telegram, or a remote Cloudflare relay webhook.

**You manage it entirely through its REST API with `curl` (Bash tool).** Always check it's up first:

```bash
curl -s http://localhost:7777/api/health
```
If that fails, the daemon may be stopped: `launchctl kickstart -k gui/$(id -u)/sh.chronos.daemon`.

## Create a job

```bash
curl -s -X POST http://localhost:7777/api/jobs -H 'Content-Type: application/json' -d '{
  "name": "daily-report",
  "goal": "Summarize today's git commits in ~/myrepo and write SUMMARY.md.",
  "profile": "claude",
  "model": "sonnet",
  "cwd": "/Users/you/myrepo",
  "trigger_type": "cron",
  "cron_expr": "0 9 * * *",
  "timezone": "America/Santo_Domingo",
  "sandbox": "guard",
  "retry_max": 1,
  "verify": true
}'
```
Returns the created job (with `id`). Only `name` and `goal` are required.

### Job fields

| field | meaning | default |
|---|---|---|
| `name` *(req)* | short label | — |
| `goal` *(req)* | the prompt Claude executes until done | — |
| `profile` | account/config dir: `claude` (`~/.claude`), or any discovered `claude-<name>` (`~/.claude-<name>`). A project's own `config_dir` wins over this | `claude` |
| `model` | `haiku` (cheapest) · `sonnet` (balanced) · `opus` (priciest) · or full id; `null`=default | `sonnet` |
| `cwd` | working directory the job runs in | `$HOME` |
| `add_dirs` | JSON array of extra dirs the job may access | — |
| `trigger_type` | `manual` · `cron` · `webhook` | `manual` |
| `cron_expr` | standard 5-field cron (needed when `trigger_type:"cron"`) | — |
| `timezone` | IANA tz for the cron | `UTC` |
| `sandbox` | `guard` (deny secrets/other projects, keep cwd) · `strict` (writes confined to cwd) · `off` | `guard` |
| `allowed_tools` / `disallowed_tools` | tool hints (additive, NOT a hard restriction — see gotchas) | — |
| `max_budget_usd` | per-run cost ceiling | — |
| `timeout_sec` | wall-clock kill timer | `3600` |
| `retry_max` / `retry_backoff_sec` | auto-retry failed/timed-out runs | `0` / `60` |
| `verify` | run an LLM-judge after success to confirm the goal was met (flips to failed if not) | `false` |
| `on_success` / `on_failure` | id or exact name of a follow-up job to trigger when this run ends (fires after retries are exhausted) | — |
| `enabled` | whether cron triggers fire | `true` |
| `append_system` | extra system prompt for the job | — |

## Other operations

```bash
curl -s http://localhost:7777/api/jobs                 # list jobs (+ next_run)
curl -s http://localhost:7777/api/jobs/<id>            # one job
curl -s -X PATCH http://localhost:7777/api/jobs/<id> -d '{"enabled":false}'   # edit (e.g. disable)
curl -s -X DELETE http://localhost:7777/api/jobs/<id>  # delete
curl -s -X POST http://localhost:7777/api/jobs/<id>/run    # run now -> {run_id, status}

curl -s "http://localhost:7777/api/runs?job_id=<id>"   # run history
curl -s http://localhost:7777/api/runs/<run_id>        # run detail (status, cost_usd, num_turns, summary, verify_verdict)
curl -s http://localhost:7777/api/runs/<run_id>/events # full transcript
curl -s -X POST http://localhost:7777/api/runs/<run_id>/kill   # kill a running job

curl -s http://localhost:7777/api/stats                # spend today/7d/30d, success rate, top jobs
```

## Triggers (event → job)
A **trigger** is a reusable object that fires a job when a matching event arrives. Source `http`
gives you an inbound webhook at a secret URL; an optional **filter** decides which events count, and
**inject** controls whether the event payload is fed into the job's prompt.

```bash
# Create an HTTP trigger bound to a job. Response includes token + hook_url.
curl -s -X POST http://localhost:7777/api/triggers -d '{
  "name": "cf-5xx",
  "job_id": "<job-id>",
  "inject": "goal",                       // "goal" = append event to the prompt; "none" = ignore it
  "filter": [                              // all conditions ANDed; omit/empty = fire on every call
    { "path": "body.alert_type", "op": "equals", "value": "http_5xx_spike" },
    { "path": "body.count",      "op": "gt",     "value": 10 }
  ]
}'
curl -s http://localhost:7777/api/triggers                 # list (with hook_url)
curl -s -X PATCH http://localhost:7777/api/triggers/<id> -d '{"enabled":false}'
curl -s -X DELETE http://localhost:7777/api/triggers/<id>

# Fire it (what an external service POSTs). 200 = matched+dispatched, 202 = received but filtered out.
curl -s -X POST http://localhost:7777/api/triggers/hook/<token> -d '{"alert_type":"http_5xx_spike","count":137}'
```

- **Filter ops:** `equals` `contains` `regex` `gt` `lt` `exists`. `path` is a dot-path into the event
  object `{ method, headers, query, body, ip, ts }`, e.g. `body.alert_type`, `headers.x-github-event`.
- **inject: "goal"** appends the event (its `body`) to the job's prompt under a "Trigger context"
  header, so the run knows *what* happened (the alert, the email, etc.), not just *that* it happened.
  Stored on the run's `context` field. (Retries of a triggered run currently don't re-inject.)
- **Reachability:** the hook is on `localhost:7777` — reachable locally / on the LAN / via a tunnel
  (cloudflared, ngrok). The Mac has **no inbound port**, so internet services (Cloudflare, GitHub)
  need a tunnel, or extend the relay Worker to forward payloads to the engine (future).
- Anything that can POST becomes a trigger: Cloudflare Notifications, GitHub, Stripe, an iPhone
  Shortcut, or email via a routing→webhook hop. "Poll" and "telegram" sources are planned.

## Ticket dependencies (local-only graph)
Tickets link to each other; `GET /api/tickets/<id>` returns `links[]` (each `{type, dir, ticket}`)
and `blocked` (true when an upstream `blocks` ticket is still open). **A blocked ticket is refused by
dispatch** (`POST /tickets/<id>/dispatch` → 400 `blocked by …`) until every blocker is `done`. The
`GET /api/tickets` list also carries a `blocked` flag per row. Prefer the `mc` CLI (`mc ticket link`)
when working a ticket; raw REST:
```bash
# add: FROM blocks TO (TO can't build until FROM is done). type: blocks|parent|relates|duplicates
curl -s -X POST http://localhost:7777/api/tickets/<from_id>/links -H 'Content-Type: application/json' \
  -d '{"to_id":"<to_id>","type":"blocks"}'
curl -s -X DELETE http://localhost:7777/api/tickets/<from_id>/links/<link_id>   # remove
```
Cycles are rejected. Links stay in Chronos (not pushed to Jira/ClickUp).

## Remote trigger (from anywhere, no inbound port)
A deployed Cloudflare relay can wake a job by name. The agent (`AGENT_TOKEN`) and ingress
(`INGRESS_TOKEN`) tokens live in `~/chronos/relay/.relay-secrets`.
```bash
source ~/chronos/relay/.relay-secrets
curl -X POST https://<your-relay>.workers.dev/t/<job-name> \
  -H "Authorization: Bearer $INGRESS_TOKEN" -H "X-Nonce: $(uuidgen)" -d '{}'
```

## Conventions & cost
- **Pick `profile` by project**, and prefer pinning it on the project itself (`config_dir`) so a job cannot be billed to the wrong account by forgetting the field.
- **Pick the cheapest model that fits:** `haiku` for simple/frequent jobs (sub-cent with caching),
  `sonnet` for real work, `opus` only for hard reasoning. Avoid leaving model unset *and* relying on
  the profile default — that can be Opus `[1m]` (~$0.18 even for trivial tasks).
- **Keep `sandbox: "guard"`** unless a job legitimately needs broader access.
- Every Claude run carries ~30k tokens of fixed session overhead (tools + config), so even tiny
  jobs cost a few cents on Sonnet; check `/api/stats` for spend.

## Gotchas
- Jobs run with `--dangerously-skip-permissions`, so `allowed_tools` is **additive, not a sandbox**.
  Real isolation = the Seatbelt `sandbox` field + `cwd` + `timeout_sec` + `max_budget_usd`.
- `cron_expr` is 5-field (min hour dom mon dow). The DB is the source of truth; the daemon
  reschedules automatically on any job create/edit/delete.
- Dashboard (human UI) is at http://localhost:7777, local-only. Remote control = Telegram bot
  (@Cronos23_bot) + the relay above.
- **Run statuses:** `success` `failed` `timeout` `killed` (manual stop) `blocked` (budget cap) ·
  `rate_limited` (hit a 429/out-of-credits wall — *not* counted as failure: no retry, no `on_failure`
  chain; auto-resumes at the limit's reset time if within `CHRONOS_RESUME_RL_MAX_HOURS`, default 6) ·
  `interrupted` (run was active when the daemon restarted — reconciled to this on next boot).
  Failed/timed-out runs now record the CLI's own message (e.g. "session limit") in `error`.
