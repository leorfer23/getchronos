# Mission Control — Architecture & Product Doc

> The multi-client agent layer inside the Chronos daemon: Workspaces, Tickets, an autonomous
> plan→build→review loop, a Telegram control plane, full-text recall, per-client isolation, cost
> and activity ledgers — one operator commanding fleets of coding agents across many clients, 24/7,
> with **hard walls between them**.
>
> **Engine:** [Chronos](./ARCHITECTURE.md) (this repo) runs the agents (jobs, runs, triggers,
> scheduler, sandbox). Mission Control (MC) is the layer on top; this doc covers MC and does not
> re-document the core daemon — see `ARCHITECTURE.md` for that and `README.md` for setup.
>
> **Status:** shipped and running as of **2026-07-12** (hardening `81305ea..33832c9` + `e4860f2`).
> Present tense = in the code today. Unshipped items are labelled. **Stack:** Node/TS + `better-sqlite3`
> + Express + `ws` + `node-pty`; native ticket overlay (`static/overlay.html`); Telegram bot.

> ### ⚠️ DEPLOY — the only correct restart
> launchd (`sh.chronos.daemon`, `gui/501`) runs **`dist/index.js`**, not the TS source. A bare
> `launchctl kickstart` silently reloads **stale compiled code**. Always:
> ```
> npm run deploy      # = npm test && tsc build && launchctl kickstart -k gui/501/sh.chronos.daemon && health
> ```
> **Keychain:** the `claude` CLI stores creds per config dir under service
> `Claude Code-credentials-<sha256(config_dir)[:8]>`. A new capsule needs an interactive
> `CLAUDE_CONFIG_DIR=<dir> claude login` (or a keychain clone) before its agents can run.

---

## 1. What this is — pillars

1. **Isolation first** — one client's auth, secrets, repos and network can never bleed into another's.
   Kernel-enforced (Seatbelt FS + egress proxy), not honor-system.
2. **Fleet, not terminal** — many agents run concurrently under per-workspace budget + concurrency caps.
3. **Autonomous loop** — backlog tickets are planned, built, and QA-reviewed by agents; the human gates.
4. **Recall** — FTS5 over every transcript, ticket, note, skill, session; instant search.
5. **Traceability** — every mutation lands in an activity ledger with a derived actor + a cost ledger.
6. **Manager, not worker** — the Telegram NL agent dispatches and reports; it never does the work in-chat.

---

## 2. Core concepts

| Entity | What it is | Source of truth |
|---|---|---|
| **Workspace** | A sealed client/personal capsule: `config_dir`, `secrets_file`, repos, sandbox + egress policy, git identity, connector, backend/model defaults, autonomy flags. | `workspaces` row |
| **Repo** | A git repo bound to a workspace (an allowed `cwd` root). | `repos` + disk |
| **Ticket** | A unit of work as a `.md` file (frontmatter + body). DB row is the index. | `.md` file |
| **Job** | A Chronos job: a dispatched agent task (cron / webhook / manual), optionally bound to a ticket + workspace + backend. | `jobs` row |
| **Run** | One execution of a job (streamed events, cost, tokens, verdict). | `runs` / `run_events` |
| **Backend** | Who runs it: `claude-code` \| `cursor-agent` \| `codex` \| `openai-api`. | per job/session |
| **Review** | Audit state of a finished build: pending → approved / changes_requested / merged. Carries the evidence-gate results and the change's risk tier. | `reviews` row |
| **Session** | An interactive PTY terminal running an agent CLI, sandboxed to a workspace, AI-titled/summarized. | `sessions` row + live pty |
| **Note / Memo** | Per-workspace markdown vault; notes flagged `context` auto-inject into every agent prompt. | `.md` + `notes` row |
| **Skill** | Per-workspace reusable procedure (`SKILL.md`); L0 index auto-loads, full body on demand. | `.md` + `skills` row |
| **Calendar** | Aggregated agenda from Mac EventKit / Google Workspace / ICS, color-coded per workspace. | `calendars` / `cal_events` |

Hierarchy: **Workspace → Repos → Tickets → Jobs → Runs → Review.** Workspace is the wall everything
below inherits. Jobs/runs left with `workspace_id = NULL` are legacy/unscoped (full daemon env).

---

## 3. Isolation model (pillar #1 — shipped, enforced per run)

Five independent layers, all keyed off the `workspaces` row and applied in `runner.ts` / `terminal.ts`:

**(a) Env allowlist — `child-env.ts`.** A scoped run gets a fixed env allowlist
(`PATH HOME USER LOGNAME SHELL TMPDIR TERM LANG LC_ALL TZ COLORTERM SSH_AUTH_SOCK`) **plus only that
workspace's `secrets_file`** (parsed KEY=VALUE, `0600`). The daemon's ambient secrets — every other
client's tokens — are deliberately excluded. Per-workspace **git identity** (`git_name`/`git_email`)
is injected as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.

On top of the file come that workspace's **shared vars** (`workspace_vars`, migration 106): env the
operator hands one client's agents from the Desk's 🔑 panel, each optionally expiring after N hours.
They win over `secrets_file` on a name clash (the dated, deliberate thing beats the static file) and
are filtered *and* purged on read, so an expired one is gone from disk rather than merely ignored.
A terminal already open when one is added picks it up with `eval "$(mc vars export)"`; the value
never passes through the transcript either way.

**(b) Filesystem sandbox — `sandbox.ts` (macOS Seatbelt / `sandbox-exec`).** Modes `off | guard | strict`
(`sandbox_mode`, default `guard`). `guard` denies the static protected dirs (`~/.ssh`, `~/.aws`,
`~/.config/gcloud`, `~/.kube`, `.admin-token`, browser profiles, …) **plus
`isolationDenyDirs(ws)` = every *other* workspace's repo roots and `secrets_file`**, then re-grants
the job's own `cwd`/`add_dirs`. `strict` additionally confines writes to `cwd` + the CLI's own support
dirs. (Keychain is intentionally *not* denied — the CLI reads its own auth from it and it's
securityd-mediated anyway.)

**(c) Egress firewall — `egress.ts` + `sandbox.ts`.** Per-workspace `egress_config` = `off | audit |
enforce`. An opted-in workspace gets a forward proxy on an ephemeral localhost port; agents are pointed
at it via `HTTP(S)_PROXY`. `audit` logs every outbound host; `enforce` blocks anything off
`baseAllow` + the workspace's `allow` list **and** pairs a Seatbelt rule denying all direct outbound
except localhost, so the agent cannot bypass the proxy (the unsandboxed daemon still reaches upstream on
its behalf). Blocks are logged to `egress_log` and alert Telegram (debounced).

**(d) Content guard — `guard.ts`.** A regex scan (secret-store access, env-exfil, env-dump,
prompt-injection, IP/exfil cedars) that redacts flagged spans to `⟦BLOCKED:rule⟧` and alerts the
operator. Applied wherever agent- or externally-authored text enters an agent prompt: standing
context notes (`contextBlock` — the always-on cross-agent injection chokepoint), the skill index +
skill bodies, ticket titles at **plan and build dispatch**, rework notes, **connector ingestion**
(Jira/ClickUp titles), and captured session learnings. Defense-in-depth, not a hard boundary.

**(e) Budget + concurrency gates — `dispatcher.ts`.** Global `dailyBudgetUsd` + `maxConcurrent` (env),
narrowed per workspace by `daily_budget_usd` (dispatch → `blocked`) and `max_concurrent` (the pump
skips over-cap runs and leaves them queued — no livelock).

**Capsule scaffolding:** `mc ws create <slug>` builds the config dir + `0600` secrets template and
registers the workspace in one shot. `config_dir` is validated on create/update for uniqueness **and
nesting-containment** (409 if it equals, sits inside, or contains another workspace's dir).
`secrets/` and `backups/` are gitignored.

---

## 4. Backends (`src/backends/`)

Pluggable `AgentBackend` interface — one module + one registry line per harness:
`bin() · buildArgs() · oneShot() · env() · parseLine() · extractResult() · detectRateLimit()`
(+ optional `interactiveArgs`, `checkAuth`, `login`). Every backend normalizes its stream to the same
event + `RunResult` shape, so search/review/cost work identically regardless of who ran it.

| Registry key | Binary | State | Notes |
|---|---|---|---|
| `claude-code` (alias `claude`) | `claude` (`CHRONOS_CLAUDE_BIN`) | prod | `-p --output-format stream-json`, `--session-id`, resume, `--append-system-prompt`, `--max-budget-usd`, `CLAUDE_CONFIG_DIR`. |
| `cursor-agent` (alias `cursor`) | `cursor-agent` | wired | `-p --output-format stream-json --force`. No resume, no system-prompt channel (folded into prompt). `checkAuth`/`login` via `cursor-agent status`/`login`. Result schema mapped defensively — **needs a live run to confirm cost/token fields.** |
| `codex` | `codex` (`CHRONOS_CODEX_BIN`) | **UNTESTED** | `codex exec … --json --dangerously-bypass-approvals-and-sandbox`, `CODEX_HOME`=configDir. Binary not installed; cost/tokens report **null** (item text + usage arrive in separate JSONL events, unmergeable in a stateless backend). |
| `openai-api` | `node` → `scripts/openai-oneshot.mjs` | one-shot only | Any OpenAI-compatible `/chat/completions` (`OPENAI_API_KEY`/`OPENAI_BASE_URL` from the ws secrets file). `buildArgs` **throws** — not dispatchable for builds; used for cheap internal LLM calls. |

**`oneShot()` guardrails (`OneShotOpts`):** `allowedTools` + `maxBudgetUsd`, enforced by the claude
backend. The verifier runs `Read,Bash` @ **$0.50**; the Telegram manager agent runs `Bash,Read` @
`CONFIG.agent.maxBudgetUsd` ($0.50). Summaries/titles/learnings route through the workspace's
`review_backend`/`default_backend` (claude → `haiku`).

**Quota/runway gate (`src/quota-gate.ts`).** A backend being installed and allowed is not the same as
it being able to finish the job, and twice the operator only found out he was out of credits when runs
started failing. Every dispatch now passes through a gate that asks the second question, at the
credential a run would actually spend — `claude-code` bills a different account per
`CLAUDE_CONFIG_DIR`, so a profile is the unit, not a vendor. Three orthogonal gates borrowed from
firstmate's `quota-array-dispatch` skill: **eligibility** (registered, allowed in this workspace, the
credential not proven unusable), **reasoning-class fit** (the difficulty tier the ticket was graded at,
never silently downgraded to conserve quota), **runway feasibility** (known runway must outlast the
median run duration for this workspace at this difficulty) — and only then ONE scalar,
`spendPriority`, to rank the survivors; a genuine tie takes the first candidate in the operator's own
`route_config` order and the rationale says so. Evidence comes from what the repo already records
(rate-limited runs and their reset times, failures naming credits/402/session limits, the 5h token
window, burn state) plus file-and-env credential probes that never launch a vendor CLI. **Unmeasured
stays unmeasured**: it blocks nothing and reassures nobody. `CHRONOS_QUOTA_GATE` is `warn` by default
(record the verdict on the run as a `route:` event, never block); `enforce` parks the run as `blocked`,
messages the operator in plain words once per credential per hour, and queues a Robert wake so the call
gets made. Surfaces: `GET /api/quota`, `mc quota`, a critical `/api/operational` issue per exhausted or
logged-out credential in use, and `agents/_blocks/quota.md` — which is what tells Robert to look
before he opens four terminals on one backend.

---

## 5. Tickets & the autonomous loop

**File:** `<repo>/.mc/tickets/<KEY>.md` (in-repo, travels with git) or
`~/chronos/tickets/<slug>/<KEY>.md` when no repo is attached. Key = 3-char workspace prefix + running
number (e.g. `ATL-14`). Frontmatter (id/workspace/repo/status/priority/backend/model/assignee/external/tags)
+ body sections `## Context`, `## Spec / Acceptance criteria`, `## Work log`, `## Review notes`, and an
agent-written `## Plan`. The `.md` is source of truth; the `tickets` row is the search/list index.

**Statuses:** `backlog → planning → planned → in_progress → review → done`, with `ready` (post-review
rework), `blocked` (build failed), and `dismissed` (considered, decided against — closed without
being built). `done` and `dismissed` are the two **closed** states: both leave the queue, the open
counts, and the boards; the ticket and its reasoning stay on disk. Deleting is for a ticket that
should never have been filed — dismissing is for a call that was actually made.

```
backlog ──auto_plan──▶ planning ──plan saved──▶ planned ──auto_build──▶ in_progress
                                                                            │ success
        rework ◀── ready ◀──changes── review ◀──auto_review── (build diff captured)
                                        │ approve / merge
                                        ▼
                                       done ──skill_distill──▶ (maybe distill a reusable skill)
```

- **Plan** (`autoplan.ts` sweep, per-ws `auto_plan`): a **read-only** planning agent (`plan:` job,
  `Edit/Write` disallowed) investigates the repo, calls `mc plan "<md>"` to write the `## Plan` and
  flip the ticket to `planned`. Runs that end without a saved plan are unstuck back to `backlog` with a
  cooldown.
- **Build** (`pumpBuilds`, per-ws `auto_build`): approves `planned` (and reworks `ready`) tickets into a
  `ticket:` build agent. On success `runner.ts`→`reviews.createForRun` captures the working-tree diff
  and queues a review (`review`); on failure the ticket goes `blocked`.
- **Scout panel** (`panels.ts`, per-ws `plan_panel`): a ticket graded difficulty ≥ `panelMinDifficulty`
  (4) is investigated by **three** read-only scouts instead of one, each with a different lens —
  **map** (what exists, how it connects), **prior art** (the helper/pattern/tests already here to
  reuse), **risk** (other callers, edge cases, blast radius, ambiguities). They write findings to the
  ticket's Work log (not `mc plan`), and a `plan:<KEY>:merge` agent — routed to the workspace's
  `review_backend`/`review_model`, since merging is the judgment call — deduplicates, reconciles
  contradictions against the code, keeps every distinct finding, and saves the single brief plus the
  difficulty grade. Diversity of *search*, not of opinion: the planner in this system is deliberately
  a scout and not an architect, and the panel keeps it that way. If the findings show the ticket is
  really several pieces of work, the merge says so and suggests the split (`--parent` + `blocks`
  links) rather than filing it.
- **Evidence gate** (`gates.ts`, per-repo `gate_cmds`): after a successful build, the repo's own
  commands run **in that build's worktree** — `npx tsc --noEmit`, `go test ./...`, `pytest -q`,
  `flutter analyze`, `dbt build`, whatever that repo's toolchain is. Every gate runs even after one
  fails, so the builder gets the full list back. A red gate is filed as a `changes_requested` review
  by actor `ai:gate` with the failing output as the rework note — so the ticket goes to `ready` and
  rebuilds, the `reviewMaxIterations` cap counts the attempt, and **no reviewer is ever spent on
  code that doesn't build**. Green results are stored on the review (`reviews.gate_json`) and shown
  to the reviewer as settled fact. `GET /api/repos/:id/gates/suggest` reads a repo's build files
  (package.json scripts, `go.mod`, `pyproject.toml`, `Cargo.toml`, `pubspec.yaml`, `dbt_project.yml`,
  `pom.xml`, gradle, Makefile) and proposes the list. Legacy `verify_cmd` is folded in as one gate.
- **Review** (`onReviewCreated`, per-ws `auto_review`): a **read-only cross-vendor** QA agent
  (`review:` job, uses `review_backend`/`review_model` so a *different* engine audits the build) reads
  the plan + diff + gate evidence and delivers `mc verdict <id> approve|changes "…"`. Approve →
  `done`; changes → `ready` (rework). `reviewMaxIterations` (default 3) build↔review cycles, then
  it's left in `ready` and escalated to a human via Telegram.
- **Review panel** (`panels.ts`, per-ws `review_panel`): a change whose risk tier is **high** (or
  unknown) is reviewed by three agents with distinct lenses — **spec conformance**, **correctness**,
  **blast radius** — each voting with `mc verdict <id> approve|changes --lens <id>`. Votes accumulate
  in `reviews.panel_json`. **Any one lens asking for changes ends it immediately** (the diff is going
  back either way, so the other reviewers aren't worth spending) and all their notes are handed back
  together. Approval requires every dispatched lens to have reported *and* at least
  `reviewPanelQuorum` (2) to actually approve — a panel where two reviewers crashed can't be mistaken
  for a panel that agreed; a reviewer run that ends without a verdict is recorded as an abstention so
  the panel resolves instead of hanging. Each lens's vote and notes are kept separate in
  `reviews.panel_json` rather than merged into one verdict, because a merged verdict hides exactly
  the disagreement worth reading.
- **Risk tier + human gate** (`gates.ts`, per-repo `human_gate`): each review is tagged `low | med |
  high` from the paths the diff actually touched — high = migrations, auth/secrets, deploy/CI/infra,
  money paths, or a very large change (≥20 files / ≥800 lines); med = dependency manifests and
  config; low = ordinary source. `human_gate` says where the operator is still required:
  `always` (the old `require_human=1`, the default), `med`, `high`, `never`. Below the tier, an AI
  approve **ships it for real** — same `merge()` path a human approve takes, PR and all. Above it,
  the approve is recorded as a recommendation and the review stays `pending`. A repo with no gates,
  or with a red gate, always keeps the human unless `human_gate: never`: handing over a lane is a
  trade of attention for evidence, and no evidence means no trade. Per-repo `risk_paths` overrides
  the built-in globs (`low` demotes, `use_defaults:false` drops them).
- **Gates:** all three respect the global daily budget and per-ws concurrency
  (`planConcurrencyPerWs`=1, `buildConcurrencyPerWs`=1, `reviewConcurrencyPerWs`=2). Manual entry
  points exist too: `mc ticket …`, `POST /api/tickets/:id/dispatch[-plan]`, `mc review`, `mc done`.

**Intake — the chief-of-staff sweep** (`intake.ts`, per-ws `ideas_config.intake`): the loop above
starts at a ticket, which means the operator is still the one who has to notice that a Slack thread,
a meeting that just ended, a review comment or a red CI run *is work*. This scheduled read-only sweep
(default 07:00 on weekdays) reads the signals a repo-only miner can't see — Slack **channels** (DMs
and @mentions stay with `slack-triage`, which files them into the workspace inbox), meetings that ended in the last day (`mc cal`), unresolved
PR review comments (`gh`), blocked delivery, the external tracker, and the operator's own memos —
and files **spec-complete drafts** into the idea pool: title, a pitch that cites the signal it came
from, and `--acceptance`, which becomes the promoted ticket's acceptance criteria **verbatim**
(`ideas.acceptance`). Nothing reaches the backlog until a human says yes: one Telegram card per sweep
listing what it found, with **Take all N** (`POST /api/ideas/promote {ids}`), or batch-triage in the
Ideas view (`P` promotes the selection). Sources are computed from what the workspace actually has,
so an agent is never sent looking for Slack tools that aren't installed.

**The workspace inbox — "something needs you"** (`src/inbox.ts`, `src/inbox-dispatch.ts`,
`src/inbox-routes.ts`, table `inbox_items`, migration 138): one place per client for what came *to the
operator*, as opposed to what the fleet found to do. Two feeds, neither of which ever starts work:
- **Slack** — the read-only `slack-triage:<slug>` job (haiku, business-hours cron, gated by
  `slack_config.triage`) files each new DM / @mention / self-note with `mc inbox add --source slack
  --kind dm|mention|self_note --title … --why … --actor … --url <permalink> --key <channel:ts>
  [--urgent]` (`POST /api/workspaces/:id/inbox`, that workspace's token or admin). It no longer files
  tickets. `--urgent` (a person asking a direct question / request) is the only thing that pushes to
  Telegram, and only for a Slack `dm`/`mention`.
- **Trackers** — every connector sync diffs the Jira/ClickUp pull against the last one (snapshot in
  `kv` `inbox.tracker:<ws>:<source>`) and files, at zero model cost: a task newly assigned to the
  operator (`Connector.me()`, cached per workspace on success), a new comment that @mentions him or
  sits on his task (never his own), a status move on his task (unless Chronos pushed that status).
  The first diff for a workspace records the baseline and files nothing; a pull with more than 10
  brand-new tasks is read as a changed query and reseeds silently. Dedup keys like
  `jira:ANA-12:comment:<id>`, unique per workspace+source. Tracker rows never push.
  Limit: Jira's default JQL only pulls his own tasks, so a mention on someone else's task is only seen
  when `connector_config.jql` widens the pull.

Every field is `guard()`ed at ingestion (it later reaches an agent prompt). On the Desk, 📥 on the bar
carries the unread count (`/api/desk` → `inbox`); the page lists rows grouped by client, newest first,
with **Dispatch / Later (2h · tomorrow 9:00) / ✕**. API: `GET /api/inbox` (scoped token → its client
only), `GET /api/workspaces/:id/inbox`, and admin-only `POST /api/inbox/:id/dismiss|snooze|dispatch`
(each checks the row's workspace first — another client's token gets a 404). **Dispatch is the only
door from a row to work**: it opens a new Desk terminal in that client (workspace default backend,
`goal_kind: investigation`, `created_by: operator`) whose first prompt carries the item — source, what,
why, who, link, tracker key + Chronos ticket — and tells it to investigate and propose, and never to
post to Slack/Jira/ClickUp or message anyone without `mc ask`. The row records the session id.

Autonomy is per-workspace and independently toggleable (also from Telegram): `auto_plan`, `auto_build`,
`auto_review`, `auto_skill` (auto-publish agent skills), `skill_distill` (distill a skill on ticket done).

---

## 5b. Worker visibility & HITL (`mc steps` / `mc ask` / `mc tell`)

The build loop above is a black box unless the worker checkpoints — this layer is how a run stops
being silent between "started" and "done".

- **Progress checklist** (`mc steps declare/start/done/skip`, `src/store/steps.ts`): a worker declares
  3-8 milestones once near the start, then checks them off as it goes. Each transition publishes
  `run.step` on the bus, which the fleet board renders as `AgentOccupant.progress` (`n/total`). A run
  that never declares steps falls back to a **non-cooperative backstop** — `events.lastActivity(run_id)`
  (last streamed tool event) — so the fleet board and the stall detector below still have something to
  judge liveness by. A run with no step updates AND no stream activity reads as stalled and may get killed.
- **Worker questions** (`mc ask`, `src/asks.ts`, `asks` table): a worker blocks on a human decision.
  It notifies (Telegram card + the ticket timeline), then **long-polls in-process**
  (`GET /asks/:id/wait`) — if the operator (or Robert, `mc answer`) answers while the run is still alive, the
  poll just returns it, no dispatch involved. If the wait times out, the CLI's own instructions tell
  the worker to commit WIP and finish cleanly without marking for review; the run then **parks**: status
  `paused`, no review created, its concurrency slot freed. `answerAsk` (`src/asks.ts`) is what makes a
  late answer resume something instead of stranding it: a still-running ask resolves in place, an
  already-ended (parked, or crashed) one gets **re-dispatched** — `claude` backends pass `--resume` on
  the recorded `session_id` (`runs.resume_session`) to continue the exact conversation, other backends
  start fresh seeded with the answer as trigger context. Restart-proof: the ask row and the ticket
  survive a daemon bounce, so an answer typed hours later still finds its way back to the work.
- **Operator → worker mailbox** (`mc tell` / `mc inbox`, `src/messages.ts`, `run_messages` table): the
  operator or Robert redirects a running or parked worker with `mc tell <TICKET> "directive"`. Messages
  are **ticket-scoped** (so they survive park/resume/retry) and piggyback on the worker's own
  checkpoints: any `mc step`/`mc note` call (and a fresh run's spawn-time context, via `runner.ts`'s
  `messagesNote`) delivers whatever is pending and prints a `📨` block. `mc inbox` is a manual check,
  rarely needed given the piggyback.
- **Live steering** (workspace `live_steer`, `runner.ts` `steerRun`, `POST /runs/:id/steer`): opt-in
  push INTO a live process. Steer-capable backends (claude-code, mock) spawn with
  `--input-format stream-json` — the goal travels as the first stdin message, stdin stays open, and a
  `mc tell` targeting a live build run is injected immediately as a new user message (the CLI treats
  it as the next turn) instead of waiting for a checkpoint. The mailbox row is still written first and
  only marked delivered on a successful steer, so the durable path survives a race with run exit. The
  run ends when every sent message has its result event and the runner closes stdin.
- **Live progress**: `run.step` events stream over `/ws` and render on the Fleet cards in /app;
  the step checklist lives in `run_steps` and the ticket's Work log.
- **Stall detector** (`maybeStallSweep`, `src/monitor.ts` + `src/liveness.ts`): a `running` run whose
  event stream has gone quiet for `CONFIG.stallMinutes` (env `CHRONOS_STALL_MINUTES`, default **15**) is
  *quiet*, which is not yet a stall. Quiet never escalates alone — the sweep looks for positive liveness
  evidence first, stopping at the first hit: run events or `run_steps` updates, then output from a live
  terminal on the same ticket/checkout, then a file written under the run's own checkout (a pruned,
  depth- and wall-clock-bounded walk, taken **only** in the branch about to escalate; a failed or
  timed-out walk counts as no evidence, never as alive). With evidence the run is **deferred**: a
  `working` overlay labelled with what the evidence was ("quiet 22m, still writing files"), no Telegram,
  re-checked next sweep. Semantics copied from the open-source firstmate supervisor.
  Without evidence it escalates as before — `blocked`/`stall` overlay plus **one** Telegram + board
  notice — and a per-run escalation count grows each evidence-free sweep; at `CONFIG.stallInspectCount`
  (env `CHRONOS_STALL_INSPECT_COUNT`, default 3) the run is marked `demand_inspection` and one more line
  says so ("no files written, no terminal output for 3 checks — needs a look"). Any evidence clears the
  count. A run parked on an open ask, or whose ticket the operator is holding (`planned`/`review`/
  `shipping`/`blocked`), is a **declared wait**: never a wedge, re-surfaced at most once per
  `CONFIG.pauseResurfaceMinutes` (env `CHRONOS_PAUSE_RESURFACE_MIN`, default 240) with a line naming what
  it waits on. No auto-kill, no auto-retry, no steer in any branch: the operator (or Robert) looks and
  decides — kill, `mc tell`, or leave it.
- **Ask reminders** (`maybeAskReminders`, `src/monitor.ts`): the ask's creation card fires once, so an
  unanswered ask would otherwise go silent forever. Every monitor tick, an open ask older than
  `CONFIG.askRemindHours` (env `CHRONOS_ASK_REMIND_HOURS`, default 2h, 0 = off) since its last reminder
  gets re-notified (Telegram). The daily digest also surfaces the count and
  the oldest one's age. **Both are live-only** since holds landed: a dated ask stops reminding until
  its date (re-pinging before it is exactly the card "later" removes), and an `aged` one trades the
  2-hourly reminder for the once-a-day nudge below.
- **"Later" is an answer** (`src/holds.ts` + the pure `src/hold-bucket.ts`): an open ask, a pending
  review and a stalled-work call all used to have two states on the operator's list — live, or gone —
  so "not now" had nowhere to go: the item stayed live-looking and kept pinging, or somebody cleared it
  with an invented answer. A **dated hold** is the third state. `POST /api/asks/:id/hold {until,reason?}`
  (same for `/reviews/:id/hold` and `/recovery/:id/hold`, `mc ask|review|recover hold <id> +2d "why"`, or
  the **⏰ Later** button on every ask/review/recovery card → `+2h · tomorrow 9:00 · +2d · pick`) writes
  `hold_until` / `hold_reason`; `until` takes the watches grammar (`+20m` / `+48h` / `+2d` / ISO), and
  `{until:null}` lifts it. `holdBucket` puts every row in exactly one bucket from **structured fields
  only** — never hold-reason prose: **dated** (`hold_until` in the future), **aged** (undated and older
  than `CONFIG.holdAgedHours`, env `CHRONOS_HOLD_AGED_HOURS`, default 72), else **live**. Open-list reads
  (`GET /api/asks?status=open`, `/api/reviews`, `/api/recovery`) take `?bucket=live|dated|aged|all` and
  **default to `live`**, so every "needs you" count — dashboard inbox, `mc fleet`, the digest, the phone —
  is live-only, while dated items are listed with the date they come back on. `sweepHolds()` (monitor
  tick) clears a hold the moment its date passes, stamps `resurfaced_at` and re-sends the **original
  card** with a `⏰ back from later` lead line, exactly **once** (the store's resurface `UPDATE` is
  guarded on `hold_until IS NOT NULL`, so two overlapping sweeps can't both send it). An undated `aged`
  item gets a gentle once-per-day nudge line instead of a re-card — aging is only a presentation safety
  net; **the date is the durable mechanism**. A hold is never a close: a held item is not resolved
  because the surrounding work finished, and only a recorded answer (`answer` + `answered_by`, verbatim)
  or an explicit decision resolves it. Answering an ask / deciding a review lifts the hold in the same
  statement.
- **Terminal prompts — Robert answers the 🟠** (`src/terminal-prompts.ts`, block
  `agents/_blocks/terminal-prompts.md`): `mc ask` / `mc ask-robert` only cover questions an agent
  chose to FILE. The common case has no ask row at all — a CLI stops mid-turn on a permission prompt,
  an AskUserQuestion or a y/n, the Desk paints the card orange (`session.activity` waiting + the
  parsed `DeskPrompt`) and waits for a tap. Nothing woke Robert for those, so they sat until the
  operator picked the recommended option himself. Now a waiting prompt of kind `select`/`yn`/
  `question` on a terminal WITH a goal and a workspace `enqueueWake`s him (`src/wake-queue.ts`) with
  key `terminal-prompt:<session>:<hash(question+options)>` and subject `session:<id>`; the payload's
  `say` names the terminal (id8 · client · goal), the question, the numbered options and which one the
  cursor is on, and points at his procedure block. A `turn` never wakes anyone, the same prompt never
  queues twice (unacked, or within 10 minutes of being handled), and a terminal the operator typed
  into himself in the last 60s is his. `terminal-prompt:` keys are **exempt from the 15-minute
  per-subject wake window**: a second question on the same terminal is new news and the terminal is
  blocked on it. He answers with the ONE primitive the Desk's tap uses —
  `POST /api/sessions/:id/input` (`mc session key <id> down,enter` for a menu, a letter for a y/n, one
  sentence for a free question) — or hands it up; the block owns that line (scope, money, destruction,
  external side effects, security, ambiguity → the operator; a tool-permission prompt only when the
  action is plainly in the ticket's scope AND reversible). Two mechanisms keep it from going quiet:
  his keystrokes are **confirmed landed** (`CONFIG.terminalPromptConfirmSec`, env
  `CHRONOS_TERMINAL_PROMPT_CONFIRM_SEC`, default 90s — still on the same prompt hash → ONE re-wake
  "your answer didn't land", then the operator), and a **deadline** like ask-robert's
  (`CONFIG.terminalPromptDeadlineMin`, env `CHRONOS_TERMINAL_PROMPT_DEADLINE_MIN`, default 8 min)
  after which the operator gets the Telegram card with the options as buttons (`tp.<id8>.<idx>`) wired
  to that same input endpoint, the live prompt re-read at tap time so a screen that moved on is
  refused rather than typed at blind. Swept from `desk-watch`'s 30s tick beside `sweepTriageDeadline`;
  `CHRONOS_TERMINAL_PROMPTS=0` turns the whole path off and a 🟠 waits for the operator as before.
  Surfaces: `mc desk digest` prints the parsed question plus the keystrokes that answer each option,
  and `GET /api/robert/wakes` shows the queued wake.
- **Divergence report** (`holdDivergence`, `src/hold-bucket.ts`): one decision written down twice can
  disagree with itself — a ticket in a closed status with its ask still open, a PR merged or closed with
  its review still `pending`. That contradiction rides as `divergence: [...]` on
  `GET /api/agents/rollup` and as one line in `mc desk digest` (`divergence_line`). It **closes
  nothing**: a call closed wrongly leaves review entirely, which is worse than the noise. Read a line as
  "these two records disagree", never as "someone forgot to file the answer" — a call can dissolve
  because its premise was false. Read-only runs (`plan:`/`review:`/…) are excluded: their asks are
  fire-and-forget by design, so the run ending is the expected shape, not a contradiction.

---

## 5d. One terminal, several goals (`src/goals.ts`, `src/store/session-goals.ts`)

A terminal is opened with a **goal** — the line on its Desk card, the reason it exists. It may be
opened with **several**, worked in order:

```bash
mc session new --goal "open the rollback PR" --goal "update the runbook" --goal "tell #eng"
mc goal add "update the runbook"      # queue one more behind whatever you are on
mc goal list                          # 1. ✓ open the rollback PR / 2. · update the runbook
mc goal done                          # ticks the ONE you are on, moves the card to the next
mc goal drop 3 | mc goal reopen       # remove item 3 / untick the last tick
```

**The card still shows one thing.** `sessions.goal`, `goal_kind` and `goal_done_at` keep holding the
*current* goal — the first one not ticked — rewritten from the list after every change
(`syncGoalMirror`). Everything that reads a terminal's goal (the Desk card, the fleet line, Robert's
wake, `term-status.ts`'s phase machine, the day's log) is unchanged and needs no knowledge of the
list. `goals_total` / `goals_done` ride out on every session row for the `2/4` chip.

**A tick is a step, not the end.** `mc goal done` with goals still queued advances the card and
prints what is next; the terminal is only closed out (ledger frozen, day's log written) when the
last one is ticked. The operator closing a card from the Desk sends `goal_done_all` — done is done,
whatever is still queued.

**Nothing was migrated.** A terminal with one goal has no rows in `session_goals` at all and behaves
exactly as it did before the table existed; the first `goal add` folds the goal already on the row
in as item #1, keeping its kind, its source and its tick.

**On the Desk.** The New-terminal dialog's Goal box takes **one goal per line** (a Lead still takes
exactly one — LEADS.md). The header carries a `🎯 2/4` chip, and the Goal card in Focus lists the
queue: click a line to tick or untick it, `+ another goal` to queue one more. `splitGoalText` does
the splitting inside `openSession`, so a saved launch, a jot's Run and `--goal "$(cat goals.txt)"`
all get the queue without their own copy of the trick.

**Agents are told.** `skills/mission-control/SKILL.md` §"Your card" carries the queue rules, and a
terminal spawned with several is given the numbered list in its first prompt.

---

## 5c. Robert threads — one visible thread, N isolated conversations (`src/thread-router.ts`)

The operator types into ONE thread (the Desk chat, or Telegram) and never picks a project first.
Behind it there is one warm Robert **per workspace**: its own Claude profile (`config_dir`), its own
`--resume` session, its own brief, its own scoped chat recap. That is the isolation — cross-workspace
context cannot leak because the conversations are separate CLI processes, not separate prompts.

What used to leak was the **default**: a message with no workspace selected ran on the *unscoped*
manager, which is handed EVERY brief and the unscoped history. The router stands in front of that
default and picks whose Robert executes the turn.

**Resolution order** (`routeMessage`, deterministic, no model call — first hit wins):

| order | signal | `how` |
|---|---|---|
| a | `#slug` / `#alias` anywhere in the message; `#all` / `#fleet` / `#shop` = fleet-wide. The tag is **stripped** before the model sees it and **pins** the thread. Two different tags in one turn = ambiguous. | `tag` |
| b | a ticket key (`ATL-7` → its ticket's workspace; an unknown key falls back to its prefix, and a prefix two workspaces share is **ambiguous** — keys are global per prefix, CLAUDE.md gotcha 5), a repo name or path, a workspace name/slug/alias, a session id | `key` / `name` |
| c | fleet-wide intent — "status", "what now", "who needs me", "qué pasó", "all projects", "the shop" — with no workspace signal | `fleet` |
| d | **sticky**: the workspace the previous routed message in this thread landed on (kv `thread.sticky:<surface>`, expires after `CONFIG.thread.stickyMinutes`, default 90; a fleet-wide turn releases it; a social message never moves it) | `sticky` |
| d' | failing all of that, the terminal the surface has on screen (`ctx.stagedSessionId` / `ctx.uiWorkspace`). It is a tier-b signal but sits **below** the sticky on purpose: the Desk always has something on its stage, so higher up it would decide nearly every untagged message and the composer's chip (which shows the *sticky*) would be a lie. | `key` |
| e | nothing to go on → **ask**. The router never guesses: the surface offers the candidates as one tappable line plus "prefix with #slug", and the tap re-runs the original text on the choice. | `ask` |

**Integration.** `resolveTurn(text, {selected, route, surface, stagedSessionId})` is the one seam both
surfaces call; `commitTurn` records where it landed. An explicit workspace selector (Flow's picker,
Telegram `/conv`) always wins; "all workspaces" / no selection = router on; `route: false` means the
fleet manager literally. The turn then runs on `askManagerWeb(text, …, routedWs)` — that workspace's
own manager, profile and thread — and **the chat row is stored under the routed `workspace_id`**, which
is what keeps every recap that project's own.

**The single visible thread.** `GET /api/agent/history?ws=all` returns every workspace's rows plus the
unscoped ones in one timeline, each carrying its `workspace_id`. The Desk chip-marks each row (`#slug`,
colour derived from the slug; unscoped rows read `fleet`), clicking a chip filters to that project and
hovering dims the rest, and the composer's chip shows and sets the sticky project (`auto` = router). On
Telegram the reply is prefixed `#slug ·` whenever the operator did not say where himself.

**Cross-workspace handoff is explicit only.** `agents/_blocks/threads.md` (included from both of
Robert's surfaces) tells him he only ever sees this workspace's history and brief, must never claim
knowledge of another project's work, and must ask for `#slug` rather than guess; moving anything
between projects is a fleet-level action he asks the operator to repeat with `#all`.

**Debug & control.** `GET /api/thread/route?text=&surface=&session=` → `explainRoute` (the decision,
the signals it weighed, the sticky, the alias set). `POST /api/thread/sticky {ws|null}` pins or
releases. `mc thread sticky [slug|clear]`, `mc thread route "text"`.

---

## 6. Telegram control plane (`src/telegram/`)

The bot is the operator's phone-side cockpit. Design principle (the operator): the NL agent is the **MANAGER of
the control plane, never a worker** — it reads fleet state and dispatches real agents, and is told
explicitly not to write code/research/content itself, not even a trivial edit.

- **Manager persona** (`agents/robert/telegram.md`): tools capped to **`Bash,Read`** @ budget; it curls
  `localhost` GET routes to answer, and routes any work request to a ticket/plan/session/job.
- **PROPOSE protocol:** the only way it mutates is to end a reply with **exactly one** trailing line
  `PROPOSE {"label","method","path","body"}`. It's lifted out, allowlisted (`/api/` + POST/PATCH/DELETE
  only), shown as a confirm card (`px.x`/`px.d` callbacks), and executed by Telegram **only on ✅** —
  attaching the admin header unconditionally — the ✅ tap from the claimed operator chat is the
  authorization. A `run_id` in the response spawns a live ticker.
- **Live run ticker** (`ticker.ts`): edit-in-place message with elapsed/turns/cost/snippet, throttled;
  `/watch <run>` attaches one. `push.ts` pushes run outcomes (respecting each job's `notify`
  policy: all/failures/off), review-queued/updated cards, and skill-approval cards.
- **Parallel asks:** each message spawns its own agent (cap **3**, `/abort` to kill); the first ask in an
  idle chat resumes the kv-persisted chat session, concurrent asks start fresh.
- **Voice** (`voice.ts`): OGG → transcription → same agent path. Defaults to a **local whisper.cpp**
  server on :7778 (no key, no per-use cost); set `CHRONOS_TRANSCRIBE_URL` to an OpenAI-style
  `/audio/transcriptions` endpoint (+ `OPENAI_API_KEY`) to use a cloud model instead (`src/transcribe.ts`).
- **Onboarding:** `/claim <last-8-of-admin-token>` (TOFU) links the one controlling chat.
- **Commands:** `/today /tickets /dispatch /sessions /send /notes /memo /plan /review
  /approve|changes|merge /skills /skill /search /jobs /run /watch /abort /runs /digest /status /logs
  /stop`, plus a tappable menu + per-workspace autonomy toggles.

### 6b. The board (`src/board.ts`, `src/store/board.ts`)

One public feed, in-house, SQLite-backed. It replaced an external relay with per-agent keys,
channel maps and a presence job — all of which was infrastructure for a property nobody wanted.
No DMs, no channels: full cross-project
visibility is the design. Rendered by /app's Board view.

- **Posts + flat threads.** `board_posts` (migration 92): root posts and one level of replies —
  a reply to a reply is flattened to the root by the store.
- **@mention = wake.** `startBoardWatcher` wakes a mentioned executive with the thread as context;
  their reply posts back into the thread. Since the 2026-08-31 retirement `EXEC_HANDLES` holds only
  only the handles in `EXEC_HANDLES`; anything else resolves to nobody and is dropped. Wake chains are still
  depth-capped (`BOARD_WAKE_MAX_DEPTH` = 3) so two executives could not ping-pong the token budget
  if a second one returns, and error posts are pinned to the cap so they never wake anyone.
- **Heartbeats are posts.** Every executive heartbeat lands as that agent's own board post
  (kind `heartbeat`); Robert's bookends still mirror to Telegram and the Flow thread.
- **Robert's event triage** (`src/robert-wake.ts`): review.created / ticket blocked / ask.created
  wake Robert (15-min per-ticket debounce, `CHRONOS_ROBERT_WAKE`); his call posts to the board
  tagged with the ticket, at max depth (an automatic post never chain-wakes peers).
- **Workers never post to the board directly.** Their words go through `mc note`/`mc tell`/`mc ask`,
  which land on the ticket timeline; executives and the operator post to the board.

---

## 7. Search & recall (pillar #4 — FTS5, shipped)

One `search_fts` virtual table (`fts5`, `porter unicode61`; `title, body` indexed,
`kind/ref_id/workspace/ts` unindexed) fed by every writer:

| kind | indexed text |
|---|---|
| `event` | assistant + result text from `run_events` (on insert) |
| `ticket` | key + title + body (create/update/note/plan) |
| `session` | title + first prompt + AI summary + tags + ticket |
| `note` / `skill` | title/name + body/description |

Query via `GET /api/search?q=&workspace=&kind=&since=` or `mc search`. Ranked, workspace/kind/date
filtered.

---

## 8. Traceability & cost (pillar #5)

- **Activity ledger** (`activity.ts`): one bus listener persists every event (except high-frequency
  `run.event`) into the `activity` table (retain 20k). The **actor** is derived: explicit `actor` wins,
  else from job-name prefix + `trigger_src` → `human | cron | telegram | trigger:<name> | ai:planner |
  ai:builder | ai:reviewer | system`. `GET /api/activity` / `mc activity`.
- **Reviews** carry `actor` (human vs `ai:reviewer`); **`connector_syncs`** keeps a per-sync history
  (pulled/created/updated/pushed/error).
- **Cost ledger** (`runs.costReport`): per-workspace, **stage-split** (`plan | build | review | distill
  | other`, from job-name prefix) sum of cost/tokens. `GET /api/costs` (MTD default) + `mc cost` + the
  daily Telegram digest's MTD line. (`GET /api/stats` adds 7/30-day spend, success rate, top jobs.)
- **Altitude** (`src/analytics.ts`, page `static/altitude.html` at `/altitude`, `mc altitude`): the
  same ledger over a **window** instead of a moment — spend, tokens, terminals, runs, turns, model
  time and code churn, bucketed by day/week/month and split by client, model, stage, opener and
  local hour × weekday, with a previous-period delta and CSV export. Two rules it does not share
  with the older endpoints: buckets are **local** days (`substr(started_at,1,10)` is the UTC date,
  which files a 22:00 terminal under tomorrow and starts "this month" on the wrong evening), and
  every breakdown comes from **one pass over the same rows**, so two panels on one screen cannot
  disagree. Windows: `today | yesterday | 7d | 30d | 90d | mtd | last-month | qtd | last-quarter |
  ytd | all`, or an explicit `from`/`to`. Runs and Desk terminals stay disjoint and are summed once
  each; estimated dollars travel labelled (`coverage`), never as metered fact.

---

## 9. Calendar (`src/calendar.ts`)

Aggregated read-only agenda, color-coded per workspace, refreshed every 15 min. Three source types on
the `calendars` row:

- **`local`** — the Mac Calendar store via the `ical` CLI (EventKit): whatever the Mac syncs (Google
  personal/Workspace, iCloud, Exchange), no OAuth. The daemon shells out to `ical` itself on the 15-min
  refresh. `POST /api/calendars/ingest` (admin) still accepts a pre-fetched push, as a fallback for a
  context where the daemon lacks Calendar TCC access — nothing uses it today.
- **`gws`** — Google Workspace via the `gws` CLI, each account isolated in its own `HOME`/config dir.
- **`ics`** — a plain ICS URL fetch (tolerant parser).

Noise filters (`calIgnoreTitles`/`calIgnoreCals`) drop holidays/birthdays/lunch. `GET /api/calendar`
returns the merged agenda; `mc cal` prints it; `reminders.ts` fires a Mac + Telegram reminder N minutes
before timed events.

---

## 10. Recall & learning surfaces

- **Notes / memos** (`notes.ts`): per-workspace markdown vault under `~/chronos/notes/<slug>/`. Notes
  flagged `context` (★) are concatenated (bounded 8k, guarded) into **every** agent's system prompt via
  `agentContext`. Sessions auto-distill durable learnings into a `session-learnings` memo (opt-in
  `CHRONOS_AUTO_MEMORY`, not context-flagged until the operator promotes it).
- **Robert's brief + the worklog** (`briefs.ts`, `worklog.ts`): one standing page per workspace,
  `notes/<ws>/robert-brief.md` — what the project is, what the operator wants, how work is done there,
  then the two sections nothing but the daemon writes: **`## Recently`** (the last
  `CHRONOS_BRIEF_RECENTLY_MAX`=12 finished pieces of work, one line each) and **`## Next`** (`- [ ]`
  items). `briefsBlock` injects it into every Robert turn (`PER_WS_CAP` 3k scoped / 14k unscoped;
  Recently+Next are rendered FIRST so a long brief can never push them out — `renderNotes` drops a
  note whole when it overruns). Every **finished** desk terminal that had a goal (`session.ended`) and
  every finished build (`run.ended`, read-only kinds excluded) is summarized by the cheap model into
  one structured entry — what the work was, how it ended, what it left `pending`, the follow-ups the
  worker itself named — and written twice: the full dated ledger in `notes/<ws>/worklog.md` (history,
  FTS-searchable, never injected whole) and the brief's two sections. Next items are deduped by token
  overlap and **ticked** when a later entry turns out to be that follow-up (same ticket key or
  near-identical text); Recently rolls off into the ledger. Idempotent per source
  (`kv` `worklog:run:<id>` / `worklog:session:<id>`), so a replayed event or a restart never
  double-appends. Surfaces: `GET/POST /api/workspaces/:id/worklog`, `mc worklog [--limit N]`,
  `mc worklog add`, and `mc worklog backfill <ws> --since 7d` (spends model calls over already-ended
  work; never automatic).
- **Lessons** (`lessons.ts`, `lessons` table): the loop that makes the workforce better instead of
  just busier. Every `changes_requested` verdict and every operator correction is distilled (cheap
  model) into **one imperative rule**, scoped to a repo and optionally a path glob, and injected back
  where it applies: `topic: build` into the build goal (ranked against that ticket's own text),
  `topic: review` into the reviewer's checklist (ranked against the diff's actual files),
  `topic: comms` into `agentContext` — so *every* agent that writes to the operator learns how they
  want to be written to. A rule from the operator is `active` immediately (they don't repeat
  himself); a rule from an AI reviewer starts `proposed` and is promoted only when the same
  complaint recurs (`lessonPromoteAfter`, default 2). Near-duplicates fold into the existing rule
  (token-overlap ≥ `lessonDedupeSimilarity`) instead of piling up restatements. `hits`/`last_fired`
  record which rules actually reach a prompt; the Sunday hygiene sweep archives proposals nobody saw
  twice (`lessonProposedTtlDays`) and active rules that stopped matching any work
  (`lessonIdleTtlDays`). Surfaces: `mc lesson list|add|promote|archive|rm`, `GET/POST /api/lessons`.
  Robert is instructed to file one whenever he's corrected.
- **Stow pass** (`stow.ts`, `memory-tiers.ts`, `memory-budget.ts`): memory that decays and is budgeted,
  because a persona memory file is injected on *every* turn and until now only ever grew. Each bullet
  carries a trailing HTML-comment marker naming its tier and the date it was last reinforced —
  `<!--a:DATE-->` aging (stale at 30 days), `<!--p:DATE-->` perishable (7 days, prose must name a
  checkable expiry), `<!--P-->` pinned (no clock, never evicted), `<!--g-->` one grace pass for an
  unmarked legacy entry. One pass = report the token total against the budget
  (`memoryBudgetTokens`, per-agent `memory_budget:` in `AGENT.md`) → reinforce **only** entries the
  caller can name evidence for (the pass never refreshes a date on its own) → read the clocks → if
  still over budget, evict aging entries oldest-reinforced-first, but only when archiving the whole
  eligible pool would actually reach the budget (otherwise it evicts nothing and reports the pinned
  floor) → re-report. Stale never means deleted: everything retired is appended with provenance to
  `notes/personal/memory-archive-<agent>.md`, the cold tier — never injected, never counted, recovery
  is a grep. Surfaces: `POST /api/agents/:name/stow {reinforced?}` (Robert calls it when a long session
  ends or the operator says "stow"), `GET /api/agents/:name/memory/report`, and the weekly hygiene
  sweep, which passes only the evidence the daemon can see for itself (a lesson filed or fired, a
  learning captured, in the last 7 days). Semantics copied from the open-source firstmate `stow` skill.
- **Skills** (`skills.ts`): per-workspace `SKILL.md` vault under `~/chronos/skills-vault/`,
  progressive disclosure — only the L0 index (name + description) auto-loads; full body on
  `mc skill view`. Agents create/patch skills; they land `pending` for human approval unless
  `auto_skill`. `skill_distill` mines a reusable skill from a shipped ticket.
- Both are mirrored into agents two ways: claude gets them as `--append-system-prompt`; cursor/other
  CLIs get the `mission-control` skill body written into each repo's `AGENTS.md` (auto-generated block,
  git-excluded).

---

## 11. Ops (`monitor.ts`, launchd)

- **Deploy:** see the banner at the top — `npm run deploy` only.
- **Backups:** nightly `db.backup()` at `digestHour` (default 08:00) → `~/chronos/backups/`, retain
  `CHRONOS_BACKUP_RETAIN`=7 (oldest pruned), Telegram alert on failure.
- **Heartbeat:** optional `CHRONOS_HEARTBEAT_URL` pinged every `heartbeatMin` (healthchecks.io style).
- **Monitor sweep** (every 5 min): flags stuck runs (>2h `running`), idle live terminals (>8h), and
  budget breach (warn 80%, alarm 100%, once/day). Also runs the **stall detector**
  (`CHRONOS_STALL_MINUTES`, default 15) and **ask reminders** (`CHRONOS_ASK_REMIND_HOURS`, default
  2h) — see §5b. **Daily digest** at `digestHour`: spend + open/review/live per workspace + review
  queue + unanswered-ask count/oldest age.
- **Admin token:** `~/chronos/.admin-token` (`0600`, sandbox-denied). The native overlay
  (`desktop/overlay.swift`) reads the file and injects `window.__MC_TOKEN__` via WKUserScript —
  never the daemon over HTTP (sandboxed agents keep loopback for `mc`/egress, so templating into
  `/overlay.html` would leak it; see PER-4 / `src/static-html.ts`). Sent as `x-mc-admin`.

---

## 12. REST API surface (`src/api.ts`, mounted at `/api`)

`requireAdmin` (header `x-mc-admin` == admin token) gates **workspace/repo mutations, egress config, and
skill status transitions**; everything else is open so agents on `localhost` can drive the backlog.

```
# health / meta
GET  /health /stats /costs?workspace=&from=&to= /activity?workspace=&topic=&actor=
GET  /quota                                                    (§4 — per-credential headroom/runway + the last gate verdicts)
GET  /analytics?preset=|from=&to=&bucket=&workspace=&top=      (§8 Altitude — one window, every breakdown)
GET  /analytics/export.csv?table=series|workspaces|terminals|jobs|models|stages
GET  /backends  GET /backends/:name/auth  POST /backends/:name/login

# jobs / runs / triggers (core Chronos)
GET/POST /jobs   GET/PATCH/DELETE /jobs/:id   POST /jobs/:id/run
GET  /runs?job_id=   GET /runs/:id   GET /runs/:id/events   POST /runs/:id/kill
GET/POST /triggers   GET/PATCH/DELETE /triggers/:id   GET|POST /triggers/hook/:token

# workspaces / repos                                    (mutations admin-only *)
GET/POST* /workspaces   GET /workspaces/:id   PATCH*/DELETE* /workspaces/:id
GET /workspaces/:id/slack  POST/DELETE /workspaces/:id/slack
GET /workspaces/:id/egress  PUT* /workspaces/:id/egress   GET /egress/log
POST* /workspaces/:id/repos   PATCH*/DELETE* /repos/:id   GET /repos/:id/gates/suggest
POST /workspaces/:id/sync                                 (clickup/jira reconcile)

# tickets
GET/POST /tickets?workspace=&status=   GET/PATCH/DELETE /tickets/:id
POST /tickets/:id/note   /tickets/:id/dispatch   /tickets/:id/dispatch-plan   /tickets/:id/plan

# Robert threads (§5c) — one visible thread, one conversation per workspace
GET  /agent/history?ws=all|<ws>|agent:<id>   POST /agent {text, ws?, route?, surface?, session?}
GET  /thread/route?text=&surface=&session=   POST /thread/sticky {ws|null}

# worker visibility & HITL (§5b) — mc steps / mc ask / mc tell
GET/POST /runs/:id/steps   POST /runs/:id/steps/:idx
GET/POST /asks   GET /asks/:id/wait?timeout_ms=   POST /asks/:id/answer
POST /messages   GET /runs/:id/inbox

# reviews
GET /reviews?state=   GET /reviews/:id      (rows carry gate_json + risk)
POST /reviews/:id/{approve,changes,merge,dispatch-review,verdict}

# sessions / notes / skills / calendar / search
GET/POST /sessions?workspace=   GET /sessions/:id   POST /sessions/:id/kill
PATCH /sessions/:id {goal, goal_done, goal_done_all, goal_kind, title}     (the card: §5d)
GET/POST /sessions/:id/goals   PATCH/DELETE /sessions/:id/goals/:goalId    (the goal queue, §5d)
GET/POST /notes?workspace=   GET /notes/:id   PATCH/DELETE /notes/:id
GET/PUT*/POST* /workspaces/:id/brief          (Robert's standing page per workspace, §10)
GET/POST /workspaces/:id/worklog?limit=      POST* /workspaces/:id/worklog/backfill
GET/POST /lessons?workspace=&repo=&state=&topic=   PATCH/DELETE /lessons/:id
GET /workspaces/:id/skills   GET /skills/:id   POST /workspaces/:id/skills   PATCH /skills/:id
POST* /skills/:id/{approve,reject,archive}   DELETE* /skills/:id
GET/POST /calendars   PATCH/DELETE /calendars/:id   POST /calendars/{refresh,ingest,import-local}
GET  /calendar?from=&to=&workspace=      GET /search?q=&workspace=&kind=&since=

# workspace inbox (§5 "The workspace inbox")
GET /inbox?workspace=&all=   GET/POST /workspaces/:id/inbox   POST* /inbox/:id/{dismiss,snooze,dispatch}
```

The Express server also serves the native overlay at `/overlay.html` (verbatim HTML via
`serveHtml` — no token templating; see PER-4 / `src/static-html.ts`); `/` and `/index.html`
302-redirect there. The same rule serves `/app` (Mission UI), `/desk` (the terminal wall), `/phone`
and `/altitude` (the fleet from above). A WebSocket serves live transcripts/terminals.

`/api/analytics` is scoped like every other workspace-touching route: a caller holding a workspace
token is pinned to its own workspace whatever `?workspace=` says, and the workspace roster in the
payload is trimmed to that one client — an operator filtering to one client still gets the full
roster, because the filter strip needs it.

---

## 13. `mc` CLI (`scripts/mc`)

Installed to `~/.mc/bin/mc` and put on every spawned agent's `PATH` (with `MC_WORKSPACE`/`MC_REPO`/
`MC_TICKET` seeding defaults), so agents drive the backlog from inside a run. Command groups:

```
ticket new|list|get|update|rm   review <KEY>   done   note   plan
memo list|get|context|new|edit|append|rm        (★context notes auto-load into agents)
lesson list|add|promote|archive|rm              (rules learned from corrections, injected into agents)
worklog [ws] | worklog add | worklog backfill    (what finished here, what it left pending — §10)
job list|get|run|rm|new         skill list|view|new|patch|append
search   ws list|create         repo list       session list|new|kill
reviews list|approve|changes|merge   verdict <reviewId> approve|changes
run list|get   activity   cost   cal   status
steps declare|start|done|skip                   (worker progress checklist, §5b)
goal set|done|clear   goal add|list|drop|reopen  (this terminal's finish line, or several — §5d)
ask "question" [--options a,b]   asks            (mc ask; asks = open asks list)
answer <id8> "text"                              (operator/Robert side of mc ask)
tell <TICKET> "directive"   inbox                (operator/Robert → worker mailbox, §5b)
inbox add|list                                   (the workspace inbox: Slack triage files here — §5)
```

`mc note` is how a worker speaks on the ticket timeline: it appends to the ticket's Work log.
Everything else a worker does reaches the timeline as a lifecycle event.

---

## 14. Status: shipped vs remaining

**Shipped.** Isolation engine (env allowlist, Seatbelt FS + egress firewall, content guard,
per-project budget/concurrency/git-identity, credential capsules); pluggable backends; native `.md`
tickets and the autonomous plan→build→review loop; FTS5 recall; review loop + cross-vendor QA;
ClickUp/Jira connectors; PTY terminal sessions and the Desk; notes + skills vaults; unified calendar;
activity + cost ledgers; Telegram control plane; backups, monitor and recovery cards.

**The surfaces, and what each is for**
- **Desk** (`static/desk.html`, `GET /desk`) — the terminal wall, and the one the README points a
  new operator at: every live agent terminal as a card, grouped by project, with its goal and turn
  state. Needs the admin token for `/term`, so it runs in the native window (`mc-app /desk`) or in a
  browser tab that stored the token once.
- **Phone** (`static/phone.html`, `GET /phone`) — the same daemon from a phone: one terminal at a
  time, a chat-style composer, and a triage screen. Put an authenticating tunnel in front of it.
- **Mission UI** (`static/app.html`, `GET /app`) — Chat / Tickets / Board / Fleet, the full-window
  read-write surface.
- **Overlay** (`static/overlay.html`) — the compact floating ticket panel. `GET /` and
  `/index.html` 302 here; the old React dashboard that used to live at `/` was deleted 2026-08-01
  and `/classic` still 410s.

None of these has a build step. `marked` and `DOMPurify` are vendored under `static/vendor/`.

**Remaining debt / caveats**
- **`codex` backend is untested** — no binary installed; cost/tokens report null. (`cursor-agent`'s
  result schema was live-verified; camelCase `usage` fields, no cost — subscription pricing.)
- **Native shells are Swift, not Tauri.** `desktop/app.swift` builds to `mc-app` (a normal
  resizable window; it takes the page as an argument — `mc-app /desk` is the terminal wall, a bare
  `mc-app` opens `/app`), and `desktop/overlay.swift` builds to `mc-overlay` (the always-on-top
  ticket panel). Both read `.admin-token` themselves and inject `window.__MC_TOKEN__`, which is what
  lets `/desk` attach to `/term`. `scripts/build-app.sh` bundles the first one.
- **`desktop/src-tauri/` is vestigial.** A Tauri v2 scaffold from before the Swift shells existed.
  Nothing builds it; `scripts/build-app.sh` reads one file out of it (`icons/icon.icns`). Retiring it
  properly — keep the icons, drop the Rust — is a decision for another day.

### Not built / ideas (from the original spec, not in code)
- A separate Ink/Bubbletea terminal client sharing the REST API.
- Calendar write-back (create/move events) and calendar-item → ticket automation.
- Cross-backend session resume (`session_id` semantics are Claude-specific).
