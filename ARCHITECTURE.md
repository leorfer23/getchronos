# Chronos — Local Claude Code Job Manager

> A local daemon that schedules, triggers, runs, and supervises autonomous Claude Code
> instances on an always-on Mac. Web dashboard + Telegram bot for control. Cloud relay
> for true remote wake-ups.

**Status:** Implemented — Node/TS daemon + `mc` CLI in `~/chronos`; sections below track the built system (some subsystems still evolving).
**Host assumption:** one macOS machine, powered on 24/7.

---

## 1. Goals

- Define **jobs**: a goal/prompt + working dir + model + tool scope + guardrails.
- Run each job as a **headless Claude Code process** that works until the goal is done, then exits.
- Fire jobs by **cron schedule**, **webhook**, **remote relay message**, **Telegram command**, or **manual** click.
- A **System Manager**: see every job, every run, live streaming output, history, cost, status; start/stop/edit.
- Control & observe from **anywhere** via a Cloud Relay + Telegram bot (no open inbound ports on the Mac).

### Non-goals (v1)
- Multi-machine fleet / horizontal scaling. (Single host. Designed to *allow* it later, not solve it now.)
- Replacing CI. This drives *Claude Code*, not generic build pipelines.

---

## 2. Key assumptions & how they shape the design

| Assumption | Consequence |
|---|---|
| Mac on 24/7 | No `pmset` wake scheduling / Wake-on-LAN needed. Daemon just stays resident. Add `caffeinate` to prevent sleep as belt-and-suspenders. |
| Headless execution | Spawn `claude -p` child processes, parse `stream-json`. No visible terminal. |
| Full cloud relay | Remote triggers arrive via a Cloudflare Worker + Durable Object; the daemon holds an **outbound** WebSocket to it. No inbound firewall holes. |
| Inherit local env | Spawning the `claude` binary inherits a config dir's settings, **skills, and MCP servers** automatically — huge: every job gets your full toolbelt for free. |
| One profile per account | A profile is a CLI config dir — `claude` (`~/.claude`) plus every `~/.claude-<name>`, each with its own account/plan/auth/skills/MCP. A project **pins its profile** via `workspaces.config_dir`; the daemon sets `CLAUDE_CONFIG_DIR` on the child accordingly. |

---

## 3. Recommended stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Daemon | **Node 20 + TypeScript** | Matches your stack; `child_process.spawn` is the natural fit for driving the CLI; one language end-to-end. |
| Scheduler | **Croner** (in-process) | Zero-dep, DST-safe, timezone-aware, computes next-run times for the UI. **Source of truth = the DB**, not the OS crontab — avoids the "two sources of truth" problem. |
| Process supervision | **launchd** (`KeepAlive` + `RunAtLoad`) | Native macOS. Its *only* job is keeping `chronosd` alive across crashes/reboots. It does **not** schedule Claude jobs — Croner does. Clean separation. |
| Persistence | **better-sqlite3** | Synchronous, fast, zero-config, single-file. Perfect for a single-node local daemon; no Postgres/Redis to run. |
| API/stream | **Express + `ws`** | REST for CRUD, WebSocket hub for live run streaming to dashboard. |
| Dashboard | **React + Vite + TS** | Your stack. Served as static assets by the daemon. |
| Cloud relay | **Cloudflare Worker + Durable Object** | You already use Cloudflare heavily. DO gives a durable per-machine queue + hibernatable WebSocket = offline buffering + instant push. Pennies to run. |
| Telegram | **`grammY`** (or raw Bot API) | Control + notify + trigger from your phone. |
| Secrets | **Per-workspace `secrets_file`** (0600 env file on disk) injected via the `childEnv` allowlist, plus **shared vars** (`workspace_vars`, optionally time-boxed) | Each workspace's keys reach only its own runs. Keychain not used (see §11). |

**Why CLI-spawn over the Agent SDK:** the spawned `claude` binary inherits your `~/.claude`
settings, all your **skills**, and your configured **MCP servers** with no extra wiring. The SDK
would require re-declaring all of that per job. We keep the SDK as a future upgrade path if we
need in-process tool interception.

---

## 4. High-level architecture

```
                          ┌─────────────────────────────────────────────┐
   Phone / remote ──────▶ │  Cloudflare Worker  +  Durable Object (queue) │
   webhook / curl         │   POST /t/:jobId   (HMAC auth, nonce replay)  │
                          └───────────────▲───────────────┬──────────────┘
                                          │ outbound WSS   │ push
                                          │ (daemon dials  │
                                          │  out — no open │
                                          │  inbound port) ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  MAC (24/7)                                                            │
   │                                                                        │
   │   launchd ──keeps alive──▶  chronosd (Node/TS)                         │
   │                              ├─ Scheduler (Croner)  ◀── jobs table     │
   │                              ├─ Dispatcher ─▶ Guardrails ─▶ Runner     │
   │                              │                              │ spawn    │
   │                              │                              ▼          │
   │                              │                   claude -p --output    │
   │                              │                   -format stream-json   │
   │                              │                   (inherits ~/.claude)  │
   │                              ├─ SQLite (jobs, runs, run_events…)        │
   │                              ├─ REST + WS API  ◀──▶  React dashboard    │
   │                              ├─ Relay client (WSS to CF DO)             │
   │                              └─ Telegram bot (control + notify)         │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Claude execution model

### 5.1 The spawned command (verified against `claude --help`, Jun 2026)

```bash
claude -p "<goal / prompt>" \
  --output-format stream-json \          # NDJSON: one event per line
  --input-format text \
  --model <alias|id> \                   # e.g. opus | claude-opus-4-8
  --session-id <uuid> \                  # addressable + idempotent run
  --append-system-prompt "<persona/role for this job>" \
  --add-dir <extra dirs the job may touch> \
  --allowed-tools "Bash(git *),Edit,Read,Write" \   # per-job whitelist
  --disallowed-tools "Bash(rm *)" \
  --max-budget-usd <cap> \               # cost ceiling (no --max-turns flag exists)
  --dangerously-skip-permissions         # required for unattended autonomy
# cwd = job.cwd
# env = job.env (+ keychain-injected secrets)
#     + CLAUDE_CONFIG_DIR=<profile dir>   ← selects the plan/account:
#         claude           → ~/.claude              (the default)
#         claude-<name>    → ~/.claude-<name>       (discovered; one per account)
#       This switches auth, settings, skills, AND configured MCP servers for the run.
```

> **Profiles.** `CLAUDE_CONFIG_DIR` is the single switch that picks which plan/account a job runs
> under. Each profile carries its own login, `settings.json`, skills, and MCP servers — so a
> `claude-acme` job gets the Acme account's tools and billing, a `claude` job gets the
> personal one. Resolution order is `workspaces.config_dir ?? CONFIG.profiles[job.profile] ??
> CONFIG.profiles.claude` — the workspace row wins, so a client workspace can never be billed to
> the wrong account. The job editor surfaces this as a **Profile** dropdown; new profiles are just
> new config dirs registered in `CONFIG.profiles`.
>
> A config dir that is in neither `CONFIG.profiles` nor any `workspaces.config_dir` is
> **unreachable**: MCP servers and skills added there are invisible to every session, with no error
> to say so. `claude-work` was exactly this and was retired 2026-09-01 (merged into
> `claude-acme`).

**Verified facts that shaped this:**
- `-p` / `--print` runs non-interactively and **exits when the task completes** → "runs until the goal is done" is the natural behavior.
- `stream-json` is newline-delimited JSON, one object per line; **does not** require `--verbose`.
- **There is no `--max-turns`.** Bound runaway with `--max-budget-usd` **and** our own wall-clock watchdog (below).
- `--allowed-tools`/`--allowedTools` and `--disallowed-tools` both accepted; space- or comma-separated.
- `--session-id <uuid>` makes a run addressable → enables resume/retry. `--resume`/`--continue`/`--fork-session` available for continuity jobs.
- A bare spawn **inherits** `~/.claude` settings, skills, MCP servers. Use `--strict-mcp-config`/`--bare`/`--safe-mode` only when a job needs isolation.
- Claude Code's own **hooks** (PreToolUse etc., configured in `settings.json`) are available to spawned jobs — a second guardrail layer below our app-level checks.

### 5.2 stream-json event shape

Each stdout line is one JSON object. Event `type` ∈ `system | assistant | user | stream_event | result`.
The **final** `result` event carries the run summary:

```jsonc
{
  "type": "result",
  "subtype": "success",          // or error subtype
  "is_error": false,
  "result": "…final text…",
  "session_id": "uuid",
  "total_cost_usd": 0.1234,
  "num_turns": 12,
  "duration_ms": 84213,
  "usage": { "input_tokens": …, "output_tokens": …,
             "cache_read_input_tokens": …, "cache_creation_input_tokens": … }
}
```

The runner streams every line → persists to `run_events` → broadcasts on WS. On the `result`
event it writes the rollup (cost, turns, tokens, status) to the `runs` row.

### 5.3 Run lifecycle

```
trigger (cron | webhook | relay | telegram | manual)
  → Dispatcher creates run(status=queued)
  → Guardrails: concurrency slot free? daily $ budget ok? job enabled?  (else → blocked/deferred)
  → Runner spawns claude -p …            (status=running)
  → parse NDJSON → run_events + WS broadcast
  → wall-clock watchdog: kill if > job.timeout_sec        (status=timeout)
  → process exit:
        result.is_error=false → status=success
        non-zero / is_error    → status=failed
  → [optional] Verifier pass: a 2nd headless claude judges "was the goal met?" (LLM-as-judge)
  → Notify (Telegram/Slack/desktop) + retry per policy on failure
```

---

## 6. Data model (SQLite)

```sql
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,          -- uuid
  name            TEXT NOT NULL,
  description     TEXT,
  goal            TEXT NOT NULL,             -- the prompt
  append_system   TEXT,                      -- --append-system-prompt
  profile         TEXT NOT NULL DEFAULT 'claude',  -- key into CONFIG.profiles → CLAUDE_CONFIG_DIR
  cwd             TEXT NOT NULL,
  add_dirs        TEXT,                       -- json array
  model           TEXT,                       -- alias or id; null = default
  allowed_tools   TEXT,                       -- string passed to --allowed-tools
  disallowed_tools TEXT,
  mcp_mode        TEXT DEFAULT 'inherit',      -- inherit | strict | bare | safe
  trigger_type    TEXT NOT NULL,               -- cron | webhook | manual | relay
  cron_expr       TEXT,                        -- when trigger_type=cron
  timezone        TEXT DEFAULT 'America/Santo_Domingo',
  max_budget_usd  REAL,
  timeout_sec     INTEGER DEFAULT 3600,
  retry_json      TEXT,                        -- {max:2, backoff_sec:60}
  verify          INTEGER DEFAULT 0,           -- run LLM-judge verifier
  env_json        TEXT,                        -- non-secret env; secret refs by name
  enabled         INTEGER DEFAULT 1,
  created_at      TEXT, updated_at TEXT
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT REFERENCES jobs(id),
  status        TEXT NOT NULL,   -- queued|running|success|failed|timeout|killed|blocked
  trigger_src   TEXT,            -- cron|webhook|relay|telegram|manual + who
  session_id    TEXT,            -- claude --session-id
  pid           INTEGER,
  started_at    TEXT, ended_at TEXT,
  exit_code     INTEGER,
  num_turns     INTEGER,
  cost_usd      REAL,
  tokens_in     INTEGER, tokens_out INTEGER,
  is_error      INTEGER,
  summary       TEXT,            -- final result text (truncated)
  error         TEXT,
  verify_json   TEXT             -- verifier verdict
);

CREATE TABLE run_events (         -- full transcript for replay/audit
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT REFERENCES runs(id),
  ts      TEXT,
  type    TEXT,                   -- system|assistant|user|stream_event|result
  payload TEXT                    -- raw json line
);

CREATE TABLE trigger_log (        -- every inbound trigger, for audit + replay protection
  id        TEXT PRIMARY KEY,
  job_id    TEXT,
  source    TEXT,                 -- relay|webhook|telegram
  nonce     TEXT UNIQUE,          -- replay protection
  payload   TEXT,
  run_id    TEXT,                 -- dispatched run, if any
  received_at TEXT
);

CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);  -- daily budget cap, concurrency, tokens, etc.
```

---

## 7. Daemon internals

- **Scheduler** — on boot, loads `enabled` cron jobs, registers Croner tasks; reschedules on any job CRUD. Each fire calls the Dispatcher.
- **Dispatcher** — single choke point for *all* trigger sources. Enforces guardrails, creates the `run` row, hands to the Runner. Concurrency-capped queue (default `max_concurrent = 3`).
- **Runner** — `spawn('claude', args, {cwd, env})`; line-reader on stdout → `run_events` + WS; watchdog timer; on exit writes rollup; triggers Verifier + Notifier + retry.
- **Guardrails** — see §11.
- **WS hub** — topics: `run.started`, `run.event`, `run.ended`, `job.updated`. Dashboard subscribes per-run for live logs.
- **Relay client** — persistent outbound WSS to the Cloudflare DO; reconnect w/ backoff; drains queued trigger messages, ACKs each.

---

## 8. API spec (local, served by daemon)

```
# Jobs
GET    /api/jobs                 list
POST   /api/jobs                 create
GET    /api/jobs/:id             detail (+ next run time)
PATCH  /api/jobs/:id             update (reschedules)
DELETE /api/jobs/:id
POST   /api/jobs/:id/run         manual trigger  → {run_id}
POST   /api/jobs/:id/enable      {enabled:bool}

# Runs
GET    /api/runs?job_id=&status= list / filter
GET    /api/runs/:id             detail + rollup
GET    /api/runs/:id/events      full transcript (paged)
POST   /api/runs/:id/kill        SIGTERM→SIGKILL the child

# Ops
GET    /api/health               daemon up, relay connected, concurrency, budget today
GET    /api/stats                runs/cost over time
WS     /ws                       live stream (subscribe by run_id / firehose)

# Local webhook ingress (LAN; for local scripts/apps)
POST   /trigger/:jobId           Authorization: Bearer <token>
```

---

## 9. Cloud relay (remote wake-up)

**Cloudflare Worker** routes; **one Durable Object** per machine = a durable mailbox.

```
Remote sender (phone, IFTTT, another service)
   │  POST https://relay.example.com/t/:jobId
   │  Authorization: Bearer <scoped-token>   X-Signature: HMAC(body, secret)   X-Nonce
   ▼
Worker → validate token + HMAC + nonce(not seen) → DO.enqueue({jobId, payload, nonce, ts})
   ▼
DO holds messages (buffers while Mac offline/unreachable)
   ▲  outbound WSS (daemon dials out, hibernatable)
chronosd relay-client  ← push  ← DO drains queue → daemon dispatches run → ACK → DO deletes
```

**Why outbound-only:** the Mac never opens an inbound port. It *dials* the relay. Safer, works
behind NAT/firewall, survives IP changes. The DO buffers so a transient disconnect loses nothing.

**Security:** per-job scoped bearer tokens, HMAC body signature, nonce replay protection (stored
in `trigger_log.nonce UNIQUE`), optional allowlist of job IDs reachable remotely.

---

## 10. Control surfaces

Three ways to drive the same daemon API — all funnel through the Dispatcher:

1. **Web dashboard** (React/Vite) — primary System Manager.
   - Pages: **Jobs** (table + next-run + enable toggle), **Job editor** (goal, **profile** (any discovered config dir), cwd, model, tools, schedule, guardrails), **Runs** (history, status, cost), **Run detail** (live + replayed transcript, kill button), **Triggers** (tokens, relay status), **Settings** (budgets, concurrency, notifiers).
   - Live logs via WS.

2. **Telegram bot** — control + observe + trigger from your phone. Talks to the daemon through the **same relay** (bot updates routed via Worker → DO → daemon), so it works with zero inbound ports.
   - `/jobs` — list + status
   - `/run <job>` — fire now
   - `/status [run]` — live status / last result
   - `/stop <run>` — kill
   - `/new` — guided job creation (stepwise prompts) or `/new <json>`
   - `/edit <job> <field> <val>` — quick edits (enable/disable, schedule, model)
   - `/logs <run>` — tail recent events
   - Push **notifications** on run success/failure (so the bot is notifier *and* controller *and* a trigger source — one integration, three roles).

3. **HTTP** — REST (local/LAN) + relay webhook (remote). For scripts and other apps.

---

## 11. Safety & guardrails (critical — jobs run `--dangerously-skip-permissions`)

Autonomous + skip-permissions = real blast radius. Layered defense:

| Control | Mechanism |
|---|---|
| **Filesystem scope** | `cwd` + explicit `--add-dir`; deny tools like `Bash(rm *)`, `Bash(sudo *)` via `--disallowed-tools`. Optionally wrap in `sandbox-exec` (macOS Seatbelt) per job. |
| **Tool scope** | Per-job `--allowed-tools` whitelist. Default deny-destructive. |
| **Cost ceiling** | `--max-budget-usd` per run **+** a daily aggregate cap in `settings`; Dispatcher blocks new runs once the day's spend is hit. |
| **Time ceiling** | Wall-clock watchdog → SIGTERM then SIGKILL at `timeout_sec` (compensates for missing `--max-turns`). |
| **Concurrency** | `max_concurrent` cap; excess runs queue. Prevents fork-bomb of claude processes. |
| **Secrets** | Per-workspace `secrets_file` — a plaintext `KEY=VALUE` env file, mode `0600`, denied to every other workspace. `childEnv` (`src/child-env.ts`) builds each run's env from a fixed allowlist plus *only* that workspace's `secrets_file`, so one client's keys never leak into another's runs. Keychain is **not** used (Claude reads its own auth from the login keychain, but Chronos stores no secrets there). Mask in transcripts. |
| **Shared vars** | The operator-facing half of the same idea: `workspace_vars` rows (Desk 🔑 panel, `mc vars`) merged into `childEnv` after the file, each with an optional expiry — "here's `X_TOKEN` for 12 hours". Values DO live in SQLite, which is why `dbPath`/`-wal`/`-shm` are in the sandbox secrets deny-list (they already held every workspace API token). Mutations are admin-gated; the one route that serves values (`GET /workspaces/:id/vars/export`) demands the admin token or that workspace's own token — never the tokenless-loopback pass every other read route allows. Expiry is enforced on read *and* deletes the row, so a lapsed credential stops existing. |
| **Audit** | Every trigger (`trigger_log`) + every event (`run_events`) persisted. Per RULES.md, also append destructive ops to `.claude/audit/YYYY-MM-DD.log`. |
| **Relay auth** | Scoped bearer + HMAC + nonce replay protection; remotely-triggerable jobs explicitly opt in. |
| **Kill switch** | Global "pause all" in settings + per-run kill. launchd unload = hard stop. |
| **Verifier (opt-in)** | Second LLM-judge pass confirms the goal was actually achieved before marking success. |

### 11.1 Machine governor (`src/machine.ts`)

The guardrails above bound what one run may *do*. This one bounds what the fleet does to the Mac it
all runs on. Measured 2026-09-18 on the operator's 12-core / 18 GB machine with ~20 live Desk
terminals: load average 32–38, swap 12.9 GB of 13.3 GB used, 21 `claude` CLIs at 250% CPU, 90
vitest/workerd processes at 168% (five agents each running a full vitest-pool suite at once), 13
tsc/esbuild at 34%. The Desk was *not* the cost — webview 9%, WindowServer 7.6%, daemon 3.5% — it
was simply losing a fair fight, because every agent CLI ran at nice 0.

Three mechanisms, all local to the daemon and none of them persisted:

| Mechanism | What it does |
|---|---|
| **Priority** | Every agent pty (`src/terminal.ts`) and every headless run (`src/runner.ts`) is spawned as `/usr/bin/nice -n <N> <sandbox-exec …> <cli>`. The wrap sits OUTSIDE `sandboxWrap`, so `nice` execs `sandbox-exec` execs the CLI and the value is inherited all the way down (verified with `ps -o nice`), along with everything the agent forks — vitest, tsc, workerd. Deliberately *not* `taskpolicy -b`: background QoS clamps to the E-cores and throttles I/O, which cripples agents rather than deprioritizing them. |
| **Spawn admission** | `openSession` refuses an **agent**-created terminal when the machine is over the line, with a message that names the numbers (`machine saturated — load 34.1 on 12 cores, memory pressure critical (swap 97% used); …`). The operator opening a terminal by hand is never refused: when he asks for one, that IS the priority. Neither is a failover stand-in, which replaces a terminal rather than adding one. Checked before the per-workspace seat cap — seats are one client's fair share, this is whether the machine can run a process at all. |
| **Heavy slots** | `mc heavy -- <cmd>` takes one of N machine-wide permits, runs the command with inherited stdio, and gives the permit back (also on ctrl-C, on a crash via a 90s heartbeat timeout, and when the holding terminal ends). Long-polled over `POST /api/machine/slots`, in memory — a permit that outlived a restart would be one nobody can release. Fail-open: no daemon, the command still runs. Every Desk terminal's standing contract tells agents to run full suites, typechecks and builds this way; a single targeted test file does not need it. |

**Why memory pressure, not swap%.** `vm.swapusage`'s TOTAL is dynamic on macOS and the kernel does
not page back in eagerly, so a small mostly-full swapfile is what a *calm* Mac looks like — measured
here at 73% used with `kern.memorystatus_vm_pressure_level` = 1 and plenty of memory free. Judged on
swap alone the governor refuses spawns on a healthy machine. So the memory rule is: **critical
pressure (4) refuses on its own; warning pressure (2) refuses only when swap is also over
`CHRONOS_MAX_SWAP_USED_PCT`; swap% alone never refuses.** With no pressure reading (off darwin, or
the sysctl failed) the memory rule does not apply and load decides. Both sysctls are read in one
`execFileSync`, cached 5s, and never throw.

**Keeping your place in line.** A refused `POST /api/machine/slots` returns a `ticket`. `mc heavy`
sends it on the next poll and resumes the *same* queue entry, so a 55s long-poll timeout does not
cost a waiter its position — without this, ten agents behind a five-minute suite would keep pushing
the oldest one to the back. An entry is granted only while a poll is actually attached (a client that
hung up is skipped, never handed a permit it cannot use), and an entry nobody re-polls for within 90s
is swept.

`GET /api/machine` (and `mc machine`) reports load, memory pressure, swap, slots in use and the
current admission verdict.

| Env | Default | Meaning |
|---|---|---|
| `CHRONOS_AGENT_NICE` | `10` | Priority every agent process starts at. `0` = off. |
| `CHRONOS_MACHINE_GOVERNOR` | on | `0`/`off` disables admission entirely. |
| `CHRONOS_MAX_LOAD_PER_CORE` | `2.5` | 1-minute load average per core an agent may be admitted at. |
| `CHRONOS_MAX_SWAP_USED_PCT` | `90` | Swap-in-use %, applied only as a second opinion under *warning* memory pressure (darwin only). |
| `CHRONOS_HEAVY_SLOTS` | `max(1, ncpu / 6)` | Concurrent heavy commands machine-wide. |

---

## 12. Notifications

Pluggable notifier interface; v1 channels: **Telegram** (primary), **Slack** (you have the MCP),
**macOS desktop** (`osascript`/`terminal-notifier`). Fires on `success | failed | timeout | budget-exceeded`.
Payload: job name, status, duration, cost, one-line result summary, deep link to run detail.

---

## 13. Repo layout

```
chronos/
  packages/
    daemon/                     # chronosd
      src/
        index.ts                # entry (launchd target); caffeinate; boot scheduler+relay+api
        scheduler.ts            # Croner ← jobs table
        dispatcher.ts           # single trigger choke point + guardrails gate
        runner.ts               # spawn claude -p, parse stream-json, watchdog
        verifier.ts             # optional LLM-judge pass
        store.ts                # better-sqlite3 + migrations
        guardrails.ts           # budgets, concurrency, tool/dir policy
        api.ts                  # express REST
        ws.ts                   # websocket hub
        relay-client.ts         # outbound WSS to CF DO
        telegram.ts             # grammY bot (control + notify)
        notify.ts               # notifier fan-out
        secrets.ts              # keychain access
      migrations/
    dashboard/                  # React + Vite + TS  (built → served by daemon)
      src/ pages/ components/ lib/{api,ws}.ts
    relay/                      # Cloudflare Worker + Durable Object
      src/{worker.ts, machine-do.ts}
      wrangler.jsonc
    shared/                     # TS types shared daemon↔dashboard↔relay
  launchd/sh.chronos.daemon.plist
  ARCHITECTURE.md
  README.md
```

---

## 14. Build roadmap

- **Phase 1 — Core loop:** store + scheduler + dispatcher + runner (stream-json parse) + guardrails (budget/timeout/concurrency) + REST `/api/jobs`,`/run`,`/runs`. Prove: cron fires → claude runs → result captured. CLI-only.
- **Phase 2 — System Manager UI:** React dashboard, WS live logs, run history, kill, job editor.
- **Phase 3 — Remote:** Cloudflare relay (Worker + DO), daemon relay-client, scoped tokens/HMAC.
- **Phase 4 — Telegram:** bot for list/run/status/stop/new/edit + notifications (routed via relay).
- **Phase 5 — Polish:** verifier pass, retries/backoff, desktop+Slack notifiers, stats charts, Seatbelt sandboxing.

---

## 15. Open decisions

1. **Profiles** — resolved: per-job `profile` field → `CLAUDE_CONFIG_DIR`, overridden by `workspaces.config_dir`. Open sub-question: register profiles in a `settings` table (label → dir) so the dropdown is data-driven and new accounts are easy to add, instead of the hardcoded `CONFIG.profiles` map? (Recommended — a dir missing from that map is silently unreachable, which is how `claude-work` rotted.)
2. **Verifier default** — on or off by default? (Adds cost + latency but catches "looked done but wasn't.")
3. **Relay hosting** — your existing Cloudflare account/zone, or a throwaway `*.workers.dev`?
4. **Timezone** — defaulted to `America/Santo_Domingo`; confirm.
5. **Concurrency + daily $ cap** — starting values (suggest 3 concurrent, $X/day)?
```
