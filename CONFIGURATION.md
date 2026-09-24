# Configuration

Chronos reads everything from the environment. There is no config file format to learn: a
gitignored `.secrets` at the repo root is sourced into `process.env` at boot (`src/env.ts`), and
anything already in the environment wins over it.

```bash
cp .secrets.example .secrets
$EDITOR .secrets
```

Two things are true of every setting below, and they are the reason there is no `config.json`:

- **It has a working default.** The daemon boots with an empty `.secrets` and no arguments. Nothing
  in this document is required to start.
- **A machine's settings never reach git.** `.secrets` is ignored, so two machines can run the same
  checkout with different paths, ports, accounts and budgets, and neither one's config breaks when
  the other opens a pull request.

---

## The five minutes that matter

Most of the ~150 knobs below exist because one of them was once wrong at 3am. These are the ones to
actually think about on day one.

### 1. Put a ceiling on spend

Chronos spawns agent CLIs that cost money and can loop. **Both caps ship unset, which means
unlimited** — the daemon says so in `GET /api/health` under `operational.issues`, and you should
believe it.

```bash
CHRONOS_DAILY_BUDGET=20        # USD/day across every project. 0 = no cap.
CHRONOS_MAX_CONCURRENT=3       # simultaneous headless runs. 0 = no cap.
```

Per-project overrides live on the project row (`daily_budget_usd`, `max_concurrent`) and take
precedence. There is a second, separate ceiling that does not care about your budget at all — the
burn guard, which halts the fleet on a *rate* rather than a total:

```bash
CHRONOS_BURN_ALERT_RUNS=60     # runs/hour → alert
CHRONOS_BURN_HALT_RUNS=100     # runs/hour → stop dispatching
CHRONOS_BURN_ALERT_USD=40      # $/hour → alert
CHRONOS_BURN_HALT_USD=60       # $/hour → stop dispatching
```

Leave the burn guard alone unless you know why you are raising it. It is the thing that catches a
loop at 3am, and a budget cap is not a substitute: a runaway can burn a day's budget in four minutes
and then sit there having done it.

### 2. Decide what agents can reach

Headless agents run with permissions skipped — that is the whole point, and it is also the risk. The
sandbox is what stands between an agent and the rest of your machine.

```bash
CHRONOS_SANDBOX_DEFAULT=guard  # off | guard | strict
```

`guard` is the default and the right answer for most work: the agent reads and writes its own
working directory, everything else is denied. `strict` adds a network lockdown. `off` is for when
you have decided, deliberately, that this run needs the whole machine.

The deny list has a portable baseline (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/gws`,
`~/.kube`, the admin token, the database, the CA private keys, browser profiles). **Two things are
machine-specific and have no sensible default**, so set them:

```bash
# Where THIS machine keeps its checkouts. Denied to guard/strict jobs EXCEPT the job's own cwd —
# so a job scoped into one project cannot read a sibling project. Unset, the daemon warns at boot.
CHRONOS_PROTECTED_DIRS_EXTRA=/Users/you/code

# Project-level secret files, appended to the baseline. Colon-separated absolute paths.
CHRONOS_PROTECTED_SECRETS_EXTRA=/Users/you/code/api/.env:/Users/you/code/api/.dev.vars
```

### 3. Point it at your accounts

A **profile** is a CLI config directory: its own login, settings, skills and MCP servers. Whichever
profile a job runs under decides which account is billed and which tools the agent has.

Profiles are discovered, not declared. `~/.claude` is always available as `claude`; every
`~/.claude-<name>` directory is offered as `claude-<name>`. So a second account becomes available by
existing:

```bash
CLAUDE_CONFIG_DIR=~/.claude-acme claude   # log in once, in that directory
```

…and it is then pinnable on a project. **Pin one per project that belongs to a client.** That
pinning is what keeps one client's work off another's account and out of another's skills — a
project's `config_dir` beats every default below.

```bash
CHRONOS_DEFAULT_PROFILE=claude                 # used only when a project pins nothing
CHRONOS_PROFILES=work=/opt/shared/.claude-work # for directories that don't follow the convention
```

### 4. Optional: reach it from your phone

The Phone surface (`/phone`) is a PWA. The daemon itself still only listens on localhost — Chronos
does **not** ship a public tunnel. Two outbound options need no inbound port at all (Telegram and
the optional relay Worker). To open Desk / Phone from the public internet the way this project is
run day-to-day, put **Cloudflare Tunnel + Cloudflare Access** in front of `127.0.0.1:7777`.

Telegram and the relay are off unless configured, and the daemon says so at boot:

```bash
CHRONOS_TG_TOKEN=            # from @BotFather; enables the Telegram bot
CHRONOS_TG_CHAT_ID=          # locks control + notifications to one chat. /start returns the id.

CHRONOS_RELAY_URL=wss://your-relay.workers.dev/ws   # see relay/ — remote triggers, no inbound port
CHRONOS_RELAY_TOKEN=
```

#### Cloudflare Tunnel + Access (recommended for `/phone`)

This matches the reference setup: a named tunnel whose only public hostname points at the local
daemon, with a Zero Trust Access app on that hostname so strangers never reach the admin token or
the terminal WebSocket. Access is the authenticator; Chronos stays a single-operator local daemon
behind it. See [SECURITY.md](./SECURITY.md).

**You need:** a domain on Cloudflare, a [Zero Trust](https://one.dash.cloudflare.com/) team (the
free tier is enough for one operator), Homebrew `cloudflared`, and Chronos already serving
`http://127.0.0.1:7777` (default `CHRONOS_PORT`).

1. **Create a named tunnel.** In Zero Trust → *Networks* → *Tunnels* → *Create a tunnel* →
   Cloudflared. Name it something stable (`chronos-desk`). Cloudflare shows an install token once —
   copy it.

2. **Save the token on the Mac** (never commit it):

   ```bash
   mkdir -p ~/.cloudflared
   # paste the token only — one line, no quotes
   pbpaste > ~/.cloudflared/chronos-desk.token
   chmod 600 ~/.cloudflared/chronos-desk.token
   ```

   The filename `chronos-desk.token` is what `npm run install:launchd -- --all` looks for when it
   installs the optional `sh.chronos.cloudflared` agent. Use that name, or edit the generated plist
   later.

3. **Public hostname → localhost.** Still on the tunnel: *Public Hostname* → *Add*.

   | field | value |
   |---|---|
   | Subdomain | e.g. `desk` |
   | Domain | your zone |
   | Type | HTTP |
   | URL | `127.0.0.1:7777` |

   Leave path empty so `/desk`, `/phone`, `/api`, and the WebSocket upgrade all share one host.
   Save. Cloudflare stores the ingress remotely — `cloudflared tunnel run --token-file …` needs no
   local `config.yml`.

4. **Protect it with Access.** Zero Trust → *Access* → *Applications* → *Add an application* →
   *Self-hosted*.

   - Application domain: the same hostname (`desk.example.com`).
   - Session duration: something phone-friendly (e.g. 30 days / `720h`) so you are not re-authing
     every morning.
   - Identity providers: leave the team defaults (One-time PIN / Google / etc.).
   - Policy: **Allow**, include only *Emails* → your address (or a tight group). Name it clearly
     (`you only`). No bypass policies, no “Everyone”.

5. **Run `cloudflared` at login.** From the Chronos checkout:

   ```bash
   brew install cloudflared          # once
   npm run install:launchd -- --all  # loads sh.chronos.cloudflared when the token file exists
   ```

   That renders `launchd/sh.chronos.cloudflared.plist.template` with this machine's paths and
   bootstraps it (`RunAtLoad` + `KeepAlive`). Equivalent manual command:

   ```bash
   cloudflared tunnel run --token-file ~/.cloudflared/chronos-desk.token
   ```

6. **Install the PWA.** On the phone, open `https://desk.example.com/phone`, complete the Access
   login, then use the browser's *Add to Home Screen*. After that, Web Push (`CHRONOS_PUSH`) and the
   service worker talk to the same origin through the tunnel.

**Checks.** Tunnel *Healthy* in the Zero Trust UI; `curl -sI https://desk.example.com/` returns an
Access redirect (or 200 only *after* you have an Access session cookie); without a session you must
not see Chronos HTML. If the tunnel is up but Access is missing, you have published an unauthenticated
shell to the internet — fix Access before you bookmark it.

**Not the same as** the optional `relay/` Worker (daemon dials *out* for remote triggers) or the
sandbox egress “tunnel” (agent CONNECT proxy). Those are unrelated knobs.

---

## How the daemon finds its own state

Everything Chronos writes lives beside its code: the database, the admin token, the notes mirror,
attachments, tickets, backups, reports, logs. That root is resolved from the module's own location,
so the checkout can live anywhere.

| Variable | Default | What it moves |
|---|---|---|
| `CHRONOS_HOME` | the checkout root | **all** of the state below, in one move |
| `CHRONOS_DB` | `<root>/chronos.db` | the database (`:memory:` for tests) |
| `CHRONOS_PORT` | `7777` | HTTP + WebSocket |
| `CHRONOS_ATTACHMENTS` | `<root>/attachments` | uploaded files |
| `CHRONOS_LOG_DIR` | the checkout root | `chronos.out.log` / `chronos.err.log` |
| `CHRONOS_BROKER_FILE` | `<root>/.broker.json` | broker credentials (sandbox-denied) |
| `CHRONOS_EGRESS_CA_DIR` | `<root>/ca` | the local TLS CA (its keys are sandbox-denied) |
| `CHRONOS_ADMIN_TOKEN` | generated into `<root>/.admin-token` | the admin credential |

Moving `CHRONOS_BROKER_FILE` or `CHRONOS_EGRESS_CA_DIR` moves the deny-list entry with it — that
resolution is deliberate, so an operator cannot accidentally relocate a credential *out* of the
sandbox's protection.

---

## Everything else

Grouped by what it does. Anything not listed here is in the table at the bottom.

### Scheduling and autonomy

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_AUTOPLAN_MIN` | `5` | sweep cadence for read-only planners, minutes. `0` = off |
| `CHRONOS_PLAN_CONCURRENCY` | `1` | simultaneous planning agents per project |
| `CHRONOS_PLAN_COOLDOWN_MIN` | `120` | do not re-plan a failed ticket for this long |
| `CHRONOS_BUILD_CONCURRENCY` | `1` | simultaneous build agents per project |
| `CHRONOS_REVIEW_CONCURRENCY` | `2` | simultaneous reviewers |
| `CHRONOS_REVIEW_MAX_ITER` | `3` | build↔review cycles before a human is asked |
| `CHRONOS_AUTO_MERGE` | **on** | let the merge gate land an approved PR. `0` to disable |
| `CHRONOS_AUTO_CI_FIX` | **on** | dispatch a fixer when CI goes red on an open PR. `0` to disable |
| `CHRONOS_CI_FIX_MAX` | `2` | attempts per ticket before it stops trying |
| `CHRONOS_SELF_DEPLOY` | **on** | rebuild and restart the daemon when its own `main` moves. `0` to disable |

Autonomy is also per project (`auto_plan`, `auto_build`, `auto_review`) — the variables above are
ceilings, not switches, and a project with all three off never dispatches anything on its own. Turn
them on for one project first.

Three of these default to **on**, which surprises people, so they are worth a second look before you
point Chronos at a repo you care about:

- `CHRONOS_AUTO_MERGE` lets the merge gate run `gh pr merge` once a PR passes review and gates. It
  cannot fire on a project whose `auto_review` is off — nothing produces an approval to act on — but
  the moment you enable review on a repo, this is live.
- `CHRONOS_AUTO_CI_FIX` dispatches an agent at a red PR and pushes to the same branch.
- `CHRONOS_SELF_DEPLOY` watches **this** checkout: when its default branch moves and the fleet is
  idle, it runs the test suite, rebuilds, and restarts the daemon. That is very useful when Chronos
  is developing itself and surprising otherwise. `CHRONOS_SELF_DEPLOY=0` turns it off.

### Supervision — the part that notices things went wrong

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_STALL_MINUTES` | `15` | no step update for this long → quiet, and the liveness check runs |
| `CHRONOS_STALL_INSPECT_COUNT` | `3` | quiet checks with no evidence before "needs a look" |
| `CHRONOS_PAUSE_RESURFACE_MIN` | `240` | how often a declared wait is re-surfaced |
| `CHRONOS_STALL_WALK_PRUNE` | `node_modules .git dist build .next target vendor` | directories the write probe skips |
| `CHRONOS_STALL_WALK_MAXDEPTH` | `6` | how deep that probe walks |
| `CHRONOS_STALL_WALK_TIMEOUT_MS` | `2000` | wall-clock bound on one walk |
| `CHRONOS_STALL_TICKET_HRS` | `24` | a ticket in flight this long → flagged |
| `CHRONOS_ASK_REMIND_HOURS` | `2` | re-surface an unanswered human question |
| `CHRONOS_HOLD_AGED_HOURS` | `72` | a "later" with NO date reads `aged` after this long (§5b). Aging is only a presentation safety net — it gets a once-a-day nudge line, never a re-card; the date is what actually brings a hold back. `0` = no aging, dates only |
| `CHRONOS_ASK_ROBERT` | on | route a terminal's question to the coordinator first |
| `CHRONOS_ASK_TRIAGE_MIN` | `3` | how long he has before it becomes yours anyway |
| `CHRONOS_TERMINAL_PROMPTS` | on | wake him when a terminal STOPS on a question (🟠) so he answers or escalates it (§5b) |
| `CHRONOS_ROBERT_DRIVE` | on | wake him when a terminal STOPS without a question — turn finished, goal done (review), decide, declared blocked, `waiting --on robert` — so he sends the next step, ticks it done or hands it up (`src/robert-drive.ts`) |
| `CHRONOS_ROBERT_DRIVE_GRACE_SEC` | 90 | how long a finished turn must stay idle before he hears about it (declared stops use at most 45s, waiting-on-Robert 20s) |
| `CHRONOS_ROBERT_DRIVE_PER_TERMINAL_HOUR` / `CHRONOS_ROBERT_DRIVE_PER_HOUR` | 4 / 30 | rolling-hour caps per terminal and daemon-wide |
| `CHRONOS_ROBERT_DRIVE_MAX_AGE_H` | 12 | a stop older than this when first seen is a parked terminal, not news |
| `CHRONOS_LEAD_DRIVE_GRACE_SEC` | `15` | a Lead's worker reaches its Lead this fast (`LEADS.md`). Only ever LOWERS the grace above — a Lead sits in `mc lead wait`, so Robert's 90s is dead air per worker turn |
| `CHRONOS_LEAD_DIGEST_DEBOUNCE_SEC` / `CHRONOS_LEAD_DIGEST_MAX_WAIT_SEC` | 5 / 20 | a Lead that is NOT pulling its inbox gets one typed digest per burst: wait this long for siblings, never hold the oldest longer than this |
| `CHRONOS_LEAD_DRIVE_PER_WORKER_HOUR` / `CHRONOS_LEAD_DRIVE_PER_LEAD_HOUR` | 20 / 120 | rolling-hour caps on reaching a Lead, tracked apart from Robert's. Over them, the stop becomes Robert's |
| `CHRONOS_LEAD_ASK_FALLBACK_MIN` | `10` | how long a worker's question (`mc ask-lead`) may sit with its Lead before it becomes Robert's anyway — the worker is blocked the whole time |
| `CHRONOS_TERMINAL_PROMPT_CONFIRM_SEC` | `90` | after his answer, how long before the daemon checks the terminal actually moved on |
| `CHRONOS_TERMINAL_PROMPT_DEADLINE_MIN` | `8` | how long a terminal's prompt may sit with him before you get it as buttons |
| `CHRONOS_TERMINAL_FAILOVER` | on | a Desk terminal stopped on a credit/usage wall moves on by itself: `/model <CHRONOS_AGENT_MODEL_FALLBACK>` in the same terminal, then a new terminal on the next backend (`src/terminal-failover.ts`). `off` = it waits for you |
| `CHRONOS_TERMINAL_FALLBACK_BACKENDS` | `grok,cursor` | backends tried in order after `workspace.fallback_backend`; unregistered, uninstalled or not-allowed ones are skipped |
| `CHRONOS_TERMINAL_FAILOVER_MAX` | `3` | failover steps per terminal lineage (the original plus every stand-in) before it gives up and tells you |
| `CHRONOS_TERMINAL_FAILOVER_TYPING_SEC` | `20` | someone typed into the terminal this recently → hold off, look again after |
| `CHRONOS_RECOVER_SWEEP_MIN` | `30` | look for abandoned work this often |
| `CHRONOS_RECOVER_MAX_ASK` | `3` | recovery cards open at once |
| `CHRONOS_MONITOR_MIN` | `5` | general sweep cadence |
| `CHRONOS_CI_POLL_SEC` | `25` | fast CI poll while a PR is open |

Recovery never retries on its own. It files a card and waits for you — that is deliberate, and
`CHRONOS_RECOVER_MAX_ASK` is there so a bad night files three cards rather than forty.

Quiet on its own is not a stall. Past `CHRONOS_STALL_MINUTES` the sweep looks for positive evidence
the agent is still alive — run events or step updates, then output from a terminal on the same
ticket, then a file written under the run's own checkout — and stops at the first one it finds. With
evidence it defers silently and labels the run ("quiet 22m, still writing files"); an agent writing
source, then tests, then docs never alarms again. Only quiet with no evidence at all escalates, and
`CHRONOS_STALL_INSPECT_COUNT` consecutive evidence-free checks mark the run `demand_inspection`. Work
parked on an open question, or on a ticket you are holding, is a declared wait rather than a stall:
it never escalates and is only re-surfaced every `CHRONOS_PAUSE_RESURFACE_MIN`, naming what it waits
on. The write probe is bounded (`_PRUNE` / `_MAXDEPTH` / `_TIMEOUT_MS`) and taken only in the branch
about to escalate; a walk that fails or runs out of time counts as no evidence, never as alive.
Nothing here kills, restarts or steers anything.

### Models and backends

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_DEFAULT_MODEL` | `sonnet` | model for new jobs when nothing else says |
| `CHRONOS_GRADER_BACKEND` / `_MODEL` | `claude-code` / `sonnet` | second-pass difficulty grader |
| `CHRONOS_MERGE_GATE_MODEL` | `sonnet` | the last read before a merge |
| `CHRONOS_INTAKE_MODEL` | `sonnet` | turns a brain-dump into tickets |
| `CHRONOS_VOICE_MODEL` | `opus` | the warm coordinator process (Desk Robert default; overridable in the chat UI) |
| `CHRONOS_AGENT_MODEL` | `opus` | one-shot Telegram turns |
| `CHRONOS_AGENT_FALLBACK_BACKEND` / `_MODEL` | `grok` / `grok-4.5` | used when the primary hits a rate limit |
| `CHRONOS_ROUTE_MODELS` | `1=haiku,2=haiku,3=sonnet,4=opus,5=opus` | difficulty tier → model, overridable per project |
| `CHRONOS_QUOTA_GATE` | `warn` | `off` / `warn` / `enforce` — see below |
| `CHRONOS_QUOTA_TOKENS_5H` | `0` | token ceiling for the rolling 5h window (`0` = unmeasured, and it stays that way) |
| `CHRONOS_QUOTA_HORIZON_SEC` | `1800` | how long a run is assumed to need when there is no history to median |
| `CHRONOS_QUOTA_FLOOR` | — | `anthropic=10,anthropic:profile:.claude-atlas=25` — percent floors, per family or one exact credential |
| `CHRONOS_QUOTA_DECISIONS` | `20` | gate verdicts kept for `GET /api/quota` / `mc quota` |

Before every dispatch the quota gate (`src/quota-gate.ts`) asks whether the credential this run would
spend can actually FINISH it: three gates — is the candidate eligible (installed, allowed here,
credential not proven unusable), does it meet the difficulty tier the ticket needs, and does its known
runway outlast the run — and only then a single `spendPriority` scalar to rank whatever survived. Read
the current picture with `mc quota` or `GET /api/quota`.

`warn` is the default and what a first deploy should run: the verdict is recorded on the run as a
`route:` event and nothing is ever blocked. `enforce` parks a run no candidate can serve (`blocked`,
with the reason), messages the operator once per credential per hour and queues a Robert wake. `off`
skips the gate entirely — including its `/api/operational` issues.

Two things it deliberately will not do: it never treats an unmeasured window as healthy OR as empty
(only a recorded rate limit, an error naming credits, or a credential store that does not exist blocks
anything), and it never drops a ticket to a cheaper tier to conserve quota — if the class it needs has
no viable backend, it stops and says so. A measured percentage only becomes a refusal against a floor
you declared in `CHRONOS_QUOTA_FLOOR`.

Alternate CLIs are found on `PATH` or pointed at explicitly. Chronos drives each one's own binary,
so you bring your own auth for each:

```bash
CHRONOS_CLAUDE_BIN=claude
CHRONOS_CODEX_BIN=codex
CHRONOS_CURSOR_BIN=cursor-agent
CHRONOS_GROK_BIN=grok
CHRONOS_OPENCODE_BIN=opencode
```

### Proactive messages

Every one of these is a message you did not ask for, so every one of them can be turned off, and
several are off already.

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_DAY_HEARTBEAT` | on | periodic fleet check-in |
| `CHRONOS_DAY_HEARTBEAT_CRON` | `*/30 * * * *` | how often |
| `CHRONOS_DAY_HEARTBEAT_START` / `_END` | `09:00` / `20:00` | active window |
| `CHRONOS_DIGEST_HOUR` | `8` | daily digest hour. `-1` = off **and disables the nightly backup** |
| `CHRONOS_DREAM_HOURS` | `13,22` | local hours of the dream slot, when memory maintenance runs. Empty or `-1` = off. **Independent of `CHRONOS_DIGEST_HOUR`** — see Memory and learning |
| `CHRONOS_STANDUP` | on | daily standup |
| `CHRONOS_STANDUP_WORKSPACES` | *(empty)* | which project slugs get one. Empty = none |
| `CHRONOS_STANDUP_CRON` / `_TZ` | `0 10 * * *` / machine tz | when |
| `CHRONOS_PERSONAL_HEARTBEAT` | off | unwired; needs an executive that owns it |
| `CHRONOS_MAIL_SWEEP` | off | unwired; needs an executive with a Gmail MCP |
| `CHRONOS_DESKTOP_NOTIFY` | on | macOS notifications |
| `CHRONOS_PUSH` | on | Web Push to the phone PWA |
| `CHRONOS_REMINDER_LEAD` | `10` | minutes before a calendar event. `0` = off |

To go quiet without stopping the daemon, set `CHRONOS_DAY_HEARTBEAT=0`, `CHRONOS_STANDUP=0`,
`CHRONOS_AUTOPLAN_MIN=0` and `CHRONOS_ASK_REMIND_HOURS=0`. Note that `CHRONOS_DIGEST_HOUR=-1` takes
the nightly database backup with it; the hourly backups continue.

### Robert threads — which project an untagged message lands on

You type into one thread and the daemon picks whose Robert answers (MISSION-CONTROL.md §5c). The
project's slug and name always route — `#atlas`, "en atlas", `ATL-7`, one of its repo names — so
these two knobs are only for shorthand and for how long the thread stays where you left it.

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_THREAD_STICKY_MIN` | `90` | minutes an untagged message keeps landing on the project the last one did. `0` = forever (it still releases on a fleet-wide question like "status") |
| `CHRONOS_THREAD_ALIASES` | *(empty)* | your shorthand for a project, `alias=slug` pairs: `CHRONOS_THREAD_ALIASES="at=atlas,cd=cedar"` makes `#at`, `#cd` and a bare "cd" route. Two characters is enough for an alias you declared; a slug or name needs three |

Nothing else needs configuring: `#all` / `#fleet` / `#shop` always mean the whole shop, and when the
daemon cannot tell it asks instead of guessing.

### Memory and learning

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_AUTO_MEMORY` | on | agents append what they learned to the project's memo |
| `CHRONOS_WORKLOG` | on | every finished terminal/build is summarized into the project's worklog + Robert's brief |
| `CHRONOS_BRIEF_RECENTLY_MAX` | `12` | lines the brief's "Recently" keeps before the oldest roll off (the ledger keeps all) |
| `CHRONOS_WORKLOG_MODEL` | — | model for the worklog summarizer; unset = the project's review model, else haiku |
| `CHRONOS_WORKLOG_MIN_SESSION_SEC` | `120` | a terminal shorter than this that produced nothing is not a piece of work |
| `CHRONOS_LESSON_PROMOTE_AFTER` | `2` | how many sightings before a reviewer's rule binds everyone |
| `CHRONOS_LESSON_IDLE_TTL_DAYS` | `120` | archive a rule nothing has matched in this long |
| `CHRONOS_LESSON_DEDUPE` | on | near-duplicate rules collapse instead of stacking |
| `CHRONOS_MEMORY_BUDGET_TOKENS` | `4000` | token ceiling for one agent's always-injected memory |
| `CHRONOS_STOW_PASS_HORIZON` | off | `1` also decays by unreinforced stow passes, not by date alone |

Memory maintenance runs in the **dream slot**: `CHRONOS_DREAM_HOURS`, a comma list of local hours
(default `13,22`, after the two work blocks of the day). It does not depend on `CHRONOS_DIGEST_HOUR`:
turning the morning digest off leaves maintenance running. A slot missed while the Mac slept or the
daemon was down runs as soon as the daemon is up again — only the latest missed slot, never a backlog —
and the last slot run is kept in the database, so a restart does not run it twice. `-1` or an empty
value turns the slot off.

At every slot, the **dream pass** (`src/dream-pass.ts`, persona `agents/dreamer/`) runs one job per
workspace that has had activity since its last pass — inbox lines waiting, worklog entries, ended
terminals, new lessons, memory reads. Each job runs on that workspace's own Claude profile and default
model, read-only on code, and writes memory only through `mc dream apply`, where the daemon enforces
every cap: the ★ `memory-index` (3000 chars, lines ≤200), the ★ `memory-hot` page rebuilt from the
last 14 days (1500), and the `memory-<topic>` / `memory-repo-<repo>` branches (6000). It triages the
`session-learnings` inbox a chunk at a time (≤12k chars per round) and empties what it triaged. An
index line nothing used for 30 days moves to its branch, a branch line unused for 90 days is archived;
a `## Pinned` section in the index never ages. Everything removed goes to `memory-archive` (never
injected) with where it came from and why, and every pass can be undone: `mc dream runs`,
`mc dream undo <run>`, or ↶ Undo in the Desk's 🧠 Memory dialog. `mc dream run [--workspace slug]`
dreams now, outside the slots.

Weekly memory hygiene (lesson decay and the persona stow pass) takes the first slot on a day at least
six days after its last run.

A persona's memory file is tiered and decays (the stow pass — MISSION-CONTROL.md §10): entries are
`aging` (stale 30 days after they were last reinforced), `perishable` (7 days) or `pinned` (no clock).
The budget is per agent and an agent may lower its own with `memory_budget:` in its `AGENT.md`
frontmatter. Nothing is ever deleted — what leaves goes to `notes/personal/memory-archive-<agent>.md`,
which is never injected and never counted. Turn `CHRONOS_STOW_PASS_HORIZON` on only if you stow daily:
it adds a second horizon in passes (10 aging / 3 perishable) so entries decay at the rate the fleet
actually runs, rather than against a wall clock a daily pass never reaches.

### Hosts — more than one Mac

A **host** is another Mac that runs agents for this daemon (the **brain**); see [HOSTS.md](./HOSTS.md).
With nothing set, there are no hosts and nothing listens beyond `127.0.0.1:7777`: a single-machine
install is unchanged — the Desk shows no Computers chip, tag or picker until a second Mac joins.
Hosts join, report vitals and capabilities, and are listed and edited on the Desk (⋯ → Computers);
remote terminals arrive in Phase 3.

On the brain:

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_HOST_LISTEN` | off | the dedicated LAN listener, e.g. `0.0.0.0:7779`. TLS with a self-signed brain cert (made on first use with `/usr/bin/openssl`), pinned by hosts at join. Serves `/host` WebSocket upgrades with a host token and a bare 404 for everything else |
| `CHRONOS_HOST_PUBLIC_URL` | — | the `wss://<desk-domain>/host` tunnel URL(s), comma-separated, advertised in join codes. The tunnel door (`/host` on the loopback API) is always there and always needs a host token |
| `CHRONOS_HOSTLINK_DIR` | `<root>/hostlink` | the brain cert and its key (sandbox-denied). Joined hosts and their token **hashes** live in the `hosts` table; a Phase 2 `hosts.json` found here is imported once at boot and left in place |
| `CHRONOS_HOST_REPO_URL` | `repository` in package.json, else `https://github.com/leorfer23/getchronos` | what the join command clones on a new Mac (the package is not on npm yet) |

Adding a host: Desk → ⋯ → **Computers** → **+ Add**, or with the admin token
`POST /api/hosts/join-codes {name?}`. It returns a single-use code (15 minutes) and the command to
paste on the new Mac — `commands.lan` when the listener is up, `commands.tunnel` when
`CHRONOS_HOST_PUBLIC_URL` is set, `command` the best of the two:

```bash
{ [ -d ~/.chronos-host/app/.git ] && git -C ~/.chronos-host/app pull --ff-only || git clone <CHRONOS_HOST_REPO_URL> ~/.chronos-host/app; } \
  && cd ~/.chronos-host/app && npm ci && npm run host -- join <url> <code>
```

`npm run host` runs `src/hostd` through tsx, so there is no build step. `GET /api/hosts` lists every
computer (never a token hash): link, vitals history, admission, live terminals, and a checklist per
workspace (allowed?, profile logged in?, repos cloned?). `PATCH /api/hosts/:id`
`{name?, policy?: {deny: [workspace id or slug]}, status?: "draining"|"online"|"disabled", reserve?}`
edits one; `DELETE /api/hosts/:id` revokes it (status `disabled`, token hash forgotten, link dropped —
re-joining is the only way back). `GET /api/hosts/links` is the raw link list.

On the host — `npm run host -- join <url> <code>` writes these into `~/.chronos-host/.secrets` (mode
600) and installs `~/Library/LaunchAgents/sh.chronos.host.plist`. `npm run host -- doctor` prints the
setup checklist; `npm run host -- status` shows the live link.

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_HOST_BRAINS` | written by join | brain URLs, tried in order. LAN names and IPs (`192.168.…`, `*.local`, `*.lan`) are **pinned** to the brain cert; public names get normal CA checks (the tunnel). Plain `ws://` is refused except to loopback |
| `CHRONOS_HOST_ID` / `CHRONOS_HOST_TOKEN` | written by join | this host's credential. The token is never printed or logged |
| `CHRONOS_HOST_CERT_FP` | written by join | the pinned brain cert's SHA-256 |
| `CHRONOS_HOST_DENY` | — | local veto: workspace slugs this Mac refuses, whatever the brain says |
| `CHRONOS_HOST_ROOTS` | `~/Documents/GitHub` | where to look for checkouts (comma- or colon-separated) |
| `CHRONOS_HOST_MC_PORT` | `7777` | the loopback `mc` forwarder, so `MC_API=http://localhost:7777/api` works unchanged for agents on the host |
| `CHRONOS_HOST_HOME` | `~/.chronos-host` | the host's state dir (`.secrets`, logs) |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | — | Cloudflare Access service token, sent only to tunnel (CA-verified) URLs, never to a LAN IP |

### Retention

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOS_RUN_EVENTS_RETAIN` | `300000` | transcript events kept per run |
| `CHRONOS_ACTIVITY_RETAIN` | `20000` | bus events kept |
| `CHRONOS_BACKUP_RETAIN` | `7` | nightly database backups |
| `CHRONOS_HOURLY_BACKUP_RETAIN` | `48` | hourly database backups |
| `CHRONOS_LOG_ROTATE_MAX_MB` / `_RETAIN` | `20` / `3` | rotate past N MB, keep N gzipped |

---

## Full variable list

Every `CHRONOS_*` the code reads, with its default and where it is read. `—` means there is no
literal default: the value is either optional, computed, or a feature switch that is off when unset.

| Variable | Default | Read in |
|---|---|---|
| `CHRONOS_ACTIVITY_RETAIN` | `20000` | `src/config.ts` |
| `CHRONOS_ADMIN` | — | `scripts/mc` |
| `CHRONOS_ADMIN_TOKEN` | — | `scripts/mc` |
| `CHRONOS_AGENT_BACKEND` | `"claude-code"` | `src/config.ts` |
| `CHRONOS_AGENT_BUDGET` | `0.5` | `src/config.ts` |
| `CHRONOS_AGENT_FALLBACK_BACKEND` | `"grok"` | `src/config.ts` |
| `CHRONOS_AGENT_FALLBACK_MODEL` | `"grok-4.5"` | `src/config.ts` |
| `CHRONOS_AGENT_MODEL` | `"opus"` | `src/config.ts` |
| `CHRONOS_AGENT_NICE` | `10` | `src/config.ts` |
| `CHRONOS_AGENT_MODEL_FALLBACK` | `"opus"` | `src/config.ts` |
| `CHRONOS_AGENT_PROFILE` | `"claude"` | `src/config.ts` |
| `CHRONOS_AGENT_TIMEOUT` | `180` | `src/config.ts` |
| `CHRONOS_ASK_REMIND_HOURS` | `2` | `src/config.ts` |
| `CHRONOS_ASK_ROBERT` | — | `src/ask-robert.ts` |
| `CHRONOS_ASK_TRIAGE_MIN` | `3` | `src/ask-robert.ts` |
| `CHRONOS_ATTACHMENTS` | `inRepo` | `src/attachments.ts` |
| `CHRONOS_AUTOPLAN_MIN` | `5` | `src/config.ts` |
| `CHRONOS_AUTO_CI_FIX` | — | `src/config.ts` |
| `CHRONOS_AUTO_MEMORY` | `"1"` | `src/config.ts` |
| `CHRONOS_AUTO_MERGE` | — | `src/config.ts` |
| `CHRONOS_BACKUP_KEEP` | `5` | `scripts/predeploy-backup.mjs` |
| `CHRONOS_BACKUP_RETAIN` | `7` | `src/config.ts` |
| `CHRONOS_BRIEF_RECENTLY_MAX` | `12` | `src/config.ts` |
| `CHRONOS_BROKER_FILE` | — | `src/broker.ts` |
| `CHRONOS_BUILD_CONCURRENCY` | `1` | `src/config.ts` |
| `CHRONOS_BURN_ALERT_RUNS` | `60` | `src/config.ts` |
| `CHRONOS_BURN_ALERT_USD` | `40` | `src/config.ts` |
| `CHRONOS_BURN_HALT_RUNS` | `100` | `src/config.ts` |
| `CHRONOS_BURN_HALT_USD` | `60` | `src/config.ts` |
| `CHRONOS_BURN_SAMPLE_MIN` | `2` | `src/config.ts` |
| `CHRONOS_CAL_IGNORE_CALS` | — | `src/config.ts` |
| `CHRONOS_CAL_IGNORE_TITLES` | — | `src/config.ts` |
| `CHRONOS_CI_FIX_MAX` | `2` | `src/config.ts` |
| `CHRONOS_CI_POLL_SEC` | `25` | `src/config.ts` |
| `CHRONOS_CLAUDE_BIN` | `"claude"` | `src/config.ts` |
| `CHRONOS_CLIPBOARD` | — | `src/clipboard.ts` |
| `CHRONOS_CLIPBOARD_MAX` | `100_000` | `src/clipboard.ts` |
| `CHRONOS_CODEX_BIN` | `"codex"` | `src/config.ts` |
| `CHRONOS_CONNECTOR_SYNC_MIN` | `30` | `src/config.ts` |
| `CHRONOS_CONNECTOR_SYNC_RETAIN` | `2000` | `src/config.ts` |
| `CHRONOS_CURSOR_BIN` | `"cursor-agent"` | `src/config.ts` |
| `CHRONOS_DAILY_BUDGET` | `0` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT` | `"1"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_CRON` | `"*/30 * * * *"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_DIGEST_SKIP` | `"1"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_END` | `"20:00"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_GATE_MODEL` | `"haiku"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_RECENT_MIN` | `12` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_START` | `"09:00"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_TG` | `"1"` | `src/config.ts` |
| `CHRONOS_DAY_HEARTBEAT_TZ` | `""` | `src/config.ts` |
| `CHRONOS_DB` | `path.join` | `scripts/predeploy-backup.mjs` |
| `CHRONOS_DEFAULT_MODEL` | `"sonnet"` | `src/config.ts` |
| `CHRONOS_DEFAULT_PROFILE` | `"claude"` | `src/config.ts` |
| `CHRONOS_DELIVERY_POLL_MIN` | `15` | `src/config.ts` |
| `CHRONOS_DESKTOP_NOTIFY` | — | `src/config.ts` |
| `CHRONOS_DIGEST_HOUR` | `8` | `src/config.ts` |
| `CHRONOS_DREAM_HOURS` | `"13,22"` | `src/config.ts` |
| `CHRONOS_DRIFT_CHECK_MIN` | `30` | `src/config.ts` |
| `CHRONOS_EGRESS_BASE_ALLOW` | — | `src/config.ts` |
| `CHRONOS_EGRESS_CA_DIR` | — | `src/egress-ca.ts` |
| `CHRONOS_EGRESS_LOG_CAP` | `5000` | `src/config.ts` |
| `CHRONOS_EGRESS_SYSTEM_ROOTS` | — | `src/egress-ca.test.ts` |
| `CHRONOS_FAKE_ARGV` | — | `src/telegram/fake-claude.mjs` |
| `CHRONOS_FAKE_FAIL_ONCE` | — | `src/telegram/fake-claude.mjs` |
| `CHRONOS_GATE_TIMEOUT_SEC` | `900` | `src/config.ts` |
| `CHRONOS_GRADER_BACKEND` | `"claude-code"` | `src/config.ts` |
| `CHRONOS_GRADER_MODEL` | `"sonnet"` | `src/config.ts` |
| `CHRONOS_GROK_BIN` | `path.join` | `src/config.ts` |
| `CHRONOS_GWS_BIN` | `"gws"` | `src/config.ts` |
| `CHRONOS_HEARTBEAT_MIN` | `5` | `src/config.ts` |
| `CHRONOS_HEAVY_SLOTS` | `max(1, ncpu / 6)` | `src/config.ts` |
| `CHRONOS_HEARTBEAT_URL` | `""` | `src/config.ts` |
| `CHRONOS_HOLD_AGED_HOURS` | `72` | `src/config.ts` |
| `CHRONOS_HOME` | — | `src/agent-memory.test.ts` |
| `CHRONOS_HOSTLINK_DIR` | `inRepo("hostlink")` | `src/hostlink/join.ts` |
| `CHRONOS_HOST_BRAINS` | — | `src/hostd/index.ts` |
| `CHRONOS_HOST_CERT_FP` | — | `src/hostd/index.ts` |
| `CHRONOS_HOST_DENY` | — | `src/hostd/inventory.ts` |
| `CHRONOS_HOST_HOME` | `~/.chronos-host` | `src/hostd/env.ts` |
| `CHRONOS_HOST_ID` | — | `src/hostd/index.ts` |
| `CHRONOS_HOST_LISTEN` | — | `src/config.ts` |
| `CHRONOS_HOST_MC_PORT` | `7777` | `src/hostd/index.ts` |
| `CHRONOS_HOST_PUBLIC_URL` | — | `src/hostlink/brain-link.ts` |
| `CHRONOS_HOST_REPO_URL` | package.json `repository` | `src/hostlink/brain-link.ts` |
| `CHRONOS_HOST_ROOTS` | `"~/Documents/GitHub"` | `src/hostd/inventory.ts` |
| `CHRONOS_HOST_TOKEN` | — | `src/hostd/index.ts` |
| `CHRONOS_HOURLY_BACKUP_RETAIN` | `48` | `src/config.ts` |
| `CHRONOS_ICAL_BIN` | `"/opt/homebrew/bin/ical"` | `src/config.ts` |
| `CHRONOS_IDEA_EXPIRED_COOLDOWN_DAYS` | `30` | `src/config.ts` |
| `CHRONOS_INTAKE_MODEL` | `"sonnet"` | `src/config.ts` |
| `CHRONOS_LAUNCHD_LABEL` | `"sh.chronos.daemon"` | `src/config.ts` |
| `CHRONOS_LESSON_DEDUPE` | `0.55` | `src/config.ts` |
| `CHRONOS_LESSON_IDLE_TTL_DAYS` | `120` | `src/config.ts` |
| `CHRONOS_LESSON_PROMOTE_AFTER` | `2` | `src/config.ts` |
| `CHRONOS_LEAD_ASK_FALLBACK_MIN` | `10` | `src/config.ts` |
| `CHRONOS_LEAD_DIGEST_DEBOUNCE_SEC` | `5` | `src/config.ts` |
| `CHRONOS_LEAD_DIGEST_MAX_WAIT_SEC` | `20` | `src/config.ts` |
| `CHRONOS_LEAD_DRIVE_GRACE_SEC` | `15` | `src/config.ts` |
| `CHRONOS_LEAD_DRIVE_PER_LEAD_HOUR` | `120` | `src/config.ts` |
| `CHRONOS_LEAD_DRIVE_PER_WORKER_HOUR` | `20` | `src/config.ts` |
| `CHRONOS_LESSON_PROPOSED_TTL_DAYS` | `60` | `src/config.ts` |
| `CHRONOS_LOG_DIR` | `path.join` | `scripts/install-launchd.mjs` |
| `CHRONOS_LOG_ROTATE_MAX_MB` | `20` | `src/config.ts` |
| `CHRONOS_LOG_ROTATE_RETAIN` | `3` | `src/config.ts` |
| `CHRONOS_MAIL_SWEEP` | `"0"` | `src/config.ts` |
| `CHRONOS_MACHINE_GOVERNOR` | on | `src/config.ts` |
| `CHRONOS_MAIL_SWEEP_MIN` | `60` | `src/config.ts` |
| `CHRONOS_MAX_CONCURRENT` | `0` | `src/config.ts` |
| `CHRONOS_MAX_LOAD_PER_CORE` | `2.5` | `src/config.ts` |
| `CHRONOS_MAX_WS_SESSIONS` | `6` | `src/config.ts` |
| `CHRONOS_MAX_SWAP_USED_PCT` | `90` | `src/config.ts` |
| `CHRONOS_MEMORY_BUDGET_TOKENS` | `4000` | `src/config.ts` |
| `CHRONOS_MERGE_GATE_MAX_FIXES` | `2` | `src/config.ts` |
| `CHRONOS_MERGE_GATE_MODEL` | `"sonnet"` | `src/config.ts` |
| `CHRONOS_MONITOR_MIN` | `5` | `src/config.ts` |
| `CHRONOS_NOTIFY_ALL` | — | `src/telegram/api.ts` |
| `CHRONOS_OPENCODE_BIN` | `"opencode"` | `src/config.ts` |
| `CHRONOS_OPENSSL` | `"/usr/bin/openssl"` | `src/hostlink/join.ts` |
| `CHRONOS_PANEL_MIN_DIFFICULTY` | `4` | `src/config.ts` |
| `CHRONOS_PERSONAL_HEARTBEAT` | `"0"` | `src/config.ts` |
| `CHRONOS_PERSONAL_HEARTBEAT_CRON` | `"*/5 * * * *"` | `src/config.ts` |
| `CHRONOS_PERSONAL_HEARTBEAT_END` | `"22:00"` | `src/config.ts` |
| `CHRONOS_PERSONAL_HEARTBEAT_START` | `"08:30"` | `src/config.ts` |
| `CHRONOS_PLAN_CONCURRENCY` | `1` | `src/config.ts` |
| `CHRONOS_PLAN_COOLDOWN_MIN` | `120` | `src/config.ts` |
| `CHRONOS_PORT` | `"7777"` | `scripts/install-launchd.mjs` |
| `CHRONOS_PROFILES` | `""` | `src/config.ts` |
| `CHRONOS_PROTECTED_DIRS` | — | `src/config.ts` |
| `CHRONOS_PROTECTED_DIRS_EXTRA` | — | `src/config.ts` |
| `CHRONOS_PROTECTED_SECRETS` | — | `src/config.ts` |
| `CHRONOS_PROTECTED_SECRETS_EXTRA` | — | `src/config.ts` |
| `CHRONOS_PUSH` | — | `src/config.ts` |
| `CHRONOS_PUSH_SUBJECT` | `"mailto:chronos@localhost"` | `src/push.ts` |
| `CHRONOS_PUSH_SUBS_FILE` | `path.join` | `src/push.ts` |
| `CHRONOS_QUOTA_DECISIONS` | `20` | `src/config.ts` |
| `CHRONOS_QUOTA_FLOOR` | — | `src/config.ts` |
| `CHRONOS_QUOTA_GATE` | `"warn"` | `src/config.ts` |
| `CHRONOS_QUOTA_HORIZON_SEC` | `1800` | `src/config.ts` |
| `CHRONOS_QUOTA_TOKENS_5H` | `0` | `src/config.ts` |
| `CHRONOS_RECOVER_MAX_ASK` | `3` | `src/config.ts` |
| `CHRONOS_RECOVER_SWEEP_MIN` | `30` | `src/config.ts` |
| `CHRONOS_RECOVER_WINDOW_HRS` | `24` | `src/config.ts` |
| `CHRONOS_RELAY_TOKEN` | `""` | `src/config.ts` |
| `CHRONOS_RELAY_URL` | `""` | `src/config.ts` |
| `CHRONOS_REMINDER_LEAD` | `10` | `src/config.ts` |
| `CHRONOS_REPO_SCAN_MIN` | `1440` | `src/config.ts` |
| `CHRONOS_RESUME_RL_MAX_HOURS` | `6` | `src/config.ts` |
| `CHRONOS_RETENTION_SWEEP_MIN` | `60` | `src/config.ts` |
| `CHRONOS_REVIEW_CONCURRENCY` | `2` | `src/config.ts` |
| `CHRONOS_REVIEW_MAX_ITER` | `3` | `src/config.ts` |
| `CHRONOS_REVIEW_MAX_REWORKS` | `1` | `src/config.ts` |
| `CHRONOS_REVIEW_PANEL_QUORUM` | `2` | `src/config.ts` |
| `CHRONOS_ROBERT_WAKE` | — | `src/config.ts` |
| `CHRONOS_ROUTE_MODELS` | `"1=haiku,2=haiku,3=sonnet,4=opus,5=opus,trivial=haiku,easy=sonnet,medium=opus,hard=opus"` | `src/config.ts` |
| `CHRONOS_RUNS_PER_JOB_HOUR` | `12` | `src/config.ts` |
| `CHRONOS_RUN_EVENTS_RETAIN` | `300000` | `src/config.ts` |
| `CHRONOS_SANDBOX_DEFAULT` | `"guard"` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY` | `"1"` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY_MAX_ATTEMPTS` | `3` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY_POLL_SEC` | `60` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY_RETRY_MIN` | `30` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY_TEST_MIN` | `20` | `src/config.ts` |
| `CHRONOS_SELF_DEPLOY_WAIT_MIN` | `90` | `src/config.ts` |
| `CHRONOS_SLACK_TRIAGE_CRON` | `"*/30 10-18 * * 1-5"` | `src/config.ts` |
| `CHRONOS_SLACK_TRIAGE_MODEL` | `"haiku"` | `src/config.ts` |
| `CHRONOS_SLACK_TRIAGE_TZ` | `LOCAL_TZ` | `src/config.ts` |
| `CHRONOS_STALL_MINUTES` | `15` | `src/config.ts` |
| `CHRONOS_STALL_TICKET_HRS` | `24` | `src/config.ts` |
| `CHRONOS_STANDUP` | `"1"` | `src/config.ts` |
| `CHRONOS_STANDUP_CRON` | `"0 10 * * *"` | `src/config.ts` |
| `CHRONOS_STANDUP_TZ` | `LOCAL_TZ` | `src/config.ts` |
| `CHRONOS_STOW_PASS_HORIZON` | — | `src/config.ts` |
| `CHRONOS_STANDUP_WORKSPACES` | `""` | `src/config.ts` |
| `CHRONOS_TERMINAL_PROMPTS` | — | `src/config.ts` |
| `CHRONOS_ROBERT_DRIVE` | — | `src/config.ts` |
| `CHRONOS_ROBERT_DRIVE_GRACE_SEC` | `90` | `src/config.ts` |
| `CHRONOS_ROBERT_DRIVE_PER_TERMINAL_HOUR` | `4` | `src/config.ts` |
| `CHRONOS_ROBERT_DRIVE_PER_HOUR` | `30` | `src/config.ts` |
| `CHRONOS_ROBERT_DRIVE_MAX_AGE_H` | `12` | `src/config.ts` |
| `CHRONOS_TERMINAL_PROMPT_CONFIRM_SEC` | `90` | `src/config.ts` |
| `CHRONOS_TERMINAL_PROMPT_DEADLINE_MIN` | `8` | `src/config.ts` |
| `CHRONOS_TERMINAL_FAILOVER` | `"on"` | `src/config.ts` |
| `CHRONOS_TERMINAL_FALLBACK_BACKENDS` | `"grok,cursor"` | `src/config.ts` |
| `CHRONOS_TERMINAL_FAILOVER_MAX` | `3` | `src/config.ts` |
| `CHRONOS_TERMINAL_FAILOVER_TYPING_SEC` | `20` | `src/config.ts` |
| `CHRONOS_STUCK_RUN_HRS` | `2` | `src/config.ts` |
| `CHRONOS_STUCK_SESSION_HRS` | `8` | `src/config.ts` |
| `CHRONOS_TERM_INPUT_MAX` | `12` | `src/terminal.ts` |
| `CHRONOS_TERM_QUIET_MS` | `6000` | `src/terminal.ts` |
| `CHRONOS_TEST` | — | `src/broker.ts` |
| `CHRONOS_TEST_LEAK` | — | `src/calendar.test.ts` |
| `CHRONOS_TEST_SECRET` | — | `src/agent-defs.test.ts` |
| `CHRONOS_THREAD_ALIASES` | — | `src/config.ts` |
| `CHRONOS_THREAD_STICKY_MIN` | `90` | `src/config.ts` |
| `CHRONOS_TG_CHAT_ID` | `""` | `src/config.ts` |
| `CHRONOS_TG_PROPOSAL_CAP` | `40` | `src/config.ts` |
| `CHRONOS_TG_PROPOSAL_TTL_MS` | `24` | `src/config.ts` |
| `CHRONOS_TG_TOKEN` | `""` | `src/config.ts` |
| `CHRONOS_TIMEOUT` | `3600` | `src/config.ts` |
| `CHRONOS_TRANSCRIBE_MODEL` | — | `src/transcribe.ts` |
| `CHRONOS_TRANSCRIBE_URL` | — | `src/telegram.test.ts` |
| `CHRONOS_VAPID_FILE` | `path.join` | `src/push.ts` |
| `CHRONOS_VERIFY_MODE` | `"enforce"` | `src/config.ts` |
| `CHRONOS_VOICE_EN` | best installed male voice, else `"Zoe (Premium)"` | `src/speak.ts` |
| `CHRONOS_VOICE_ES` | best installed male voice, else `"Marisol (Premium)"` | `src/speak.ts` |
| `CHRONOS_VOICE_MODEL` | `"opus"` | `src/config.ts` |
| `CHRONOS_VOICE_RATE` | — (say default) | `src/speak.ts` |
| `CHRONOS_WORKLOG` | `"1"` | `src/config.ts` |
| `CHRONOS_WORKLOG_MIN_SESSION_SEC` | `120` | `src/config.ts` |
| `CHRONOS_WORKLOG_MODEL` | — | `src/config.ts` |
| `CHRONOS_WRITEBACK_CARD` | — | `src/config.ts` |

`CHRONOS_TEST`, `CHRONOS_TEST_LEAK`, `CHRONOS_TEST_SECRET`, `CHRONOS_FAKE_ARGV` and
`CHRONOS_FAKE_FAIL_ONCE` are set by the test suite and have no use in a running daemon.
