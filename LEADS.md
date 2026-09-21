# Leads — a Robert for one goal, in one workspace

## The gap

Robert is the only thing on the Desk that can orchestrate. A terminal agent can fork subagents, but
those are invisible on the wall, share its transcript, and get messy. What the operator wants is to
say "take Atlas, ship X" and have something that opens, watches and steers its own terminals until
X is shipped — and only talks to him or Robert when it must.

## What a Lead is

- **A terminal**, opened and closed per goal like any other. It has a card, a story, a pty you can
  type into. `role = "lead"` is what makes it one.
- **Bound to one workspace and one goal.** It cannot see or touch anything outside its workspace:
  the workspace token is already that wall; a Lead adds a per-session `lead_token` that lets it type
  into other terminals *of its own workspace* — the one thing a worker may never do.
- **Robert's deputy, not his peer.** Robert still drives the wall. A Lead's workers stop → the Lead is
  woken (typed into), not Robert. The Lead itself stops → Robert is woken, as for any terminal. The
  operator keeps one Robert; Robert keeps N Leads.
- **Full autonomy inside the goal.** It plans, opens workers (`mc session new`), steers them
  (`mc session send|key`), reviews, closes, merges, deploys — whatever the goal takes. The ONE
  prohibition: it never communicates outside Chronos. No Slack, no email, no Telegram, no third-party
  message, no comment on someone else's PR. It speaks to the operator through its card and asks, and
  to Robert through `mc ask-robert`.
- **Ends with a receipt.** `mc goal done` after its workers are closed, with a Summary that names
  what landed (PR URLs, what was verified, what was skipped).

## Mechanics

### Data
- `SessionRole` gains `"lead"`. `OpenSessionSchema.role` accepts it.
- Migration 117: `ALTER TABLE sessions ADD COLUMN lead_token TEXT`. Set to 32 random hex at create
  when `role = "lead"`; cleared in `sessions.end`. `sessions.getByLeadToken(tok)`.
- Migration 120: `ALTER TABLE sessions ADD COLUMN lead_id TEXT` (+ index on `(lead_id, status)`), and
  `lead_wakes(key, lead_id, session_id, kind, created_at)`. Backfilled from the old
  `created_by = "lead:<id8>"` strings where exactly one live-or-dead `role='lead'` row matches that
  prefix.
- **`sessions.lead_id` is the link, and the daemon stamps it.** `POST /sessions` sets it from
  `leadScope(req)` (the `x-mc-lead` credential the caller actually presented) and forces the new
  terminal into the Lead's workspace. It is NEVER read from the request body. `created_by` is still
  written as before, but it is only the day-log label now — nothing routes on it, so a worker that
  signs itself `lead:abc12345` gets `lead_id = null` and its stops go to Robert like any terminal's.
  `sessions.workersOf(leadId, {status})` is the one query behind "whose workers are these".
- `mc session new` sends `x-mc-lead` alongside the workspace token when `MC_LEAD_TOKEN` is set — that
  header, not the `created_by` string, is what makes the new terminal the Lead's.

### Authz (src/authz.ts)
- New header `x-mc-lead: <lead_token>`. `leadScope(req)` → `{ ws, leadId }` when the token belongs to
  a **live** session with `role = "lead"`, else null.
- `POST /sessions/:id/input` accepts admin OR a Lead typing into a terminal **it owns**:
  `target.lead_id === leadId` (and same workspace, as a second wall) — `leadMayType` in authz.ts.
  Anything else is the same 404 a wrong-workspace caller gets, so a Lead cannot map the wall by
  probing ids. Narrower than workspace-wide on purpose: that let one Lead type into another Lead's
  workers and into the operator's own windows. A Lead's own `lead_id` is null, so it cannot type into
  itself either. Everything else stays admin-gated exactly as today.
- Kill/done/goal/new are already workspace-scoped; a Lead reaches them with its workspace token.

### Spawn (src/terminal.ts openSession)
- `role = "lead"` → system prompt = `agentPrompt("lead")` + FOCUS_CONTRACT + workspace ctx.
- Env adds `MC_LEAD_TOKEN`, `MC_AGENT_NAME=lead:<id8>`, `MC_LEAD=1`.
- Default title `Lead · <goal>`; seed = deskSeed (goal + description) with a first line saying it is
  the Lead for this goal.
- Children count against `CONFIG.maxSessionsPerWorkspace` like any terminal.

### The inbox (`lead_events`, src/store/lead-events.ts)
A worker stopping is a ROW, not a keystroke. One typed wake per stop meant five workers finishing
together cost five Lead turns and five flattened 1200-char lines, and a Lead that wanted to WAIT for
the next one had no way to — the live Collage Lead polled with `sleep 40; mc session focus <id>` in a
loop. Measured 2026-09-18: 7 wakes typed at Leads that day, 42 messages typed by them.

- Migration 121: `lead_events(id, lead_id, session_id, kind, key UNIQUE, payload, created_at,
  seen_at, delivered_at, acked_at)`. `kind` is a stop (`review|turn|decide|blocked|robert`) or
  `ended`. `key` is the drive key — the dedupe, so the same stop re-armed is one row; NULL for the
  kinds with no stop behind them. `payload` carries `{ id8, goal, card_line,
  last_result|last_said (≤1200 chars, newlines kept), phase, progress }`.
- `seen_at` = handed to the Lead (pulled or digested) · `delivered_at` = typed into it, or escalated
  · `acked_at` = the Lead typed into that worker, so it is no longer outstanding.
- Pruned to 7 days at startup, beside `lead_wakes`.

### Wake routing (src/robert-drive.ts)
- In `fireIfStill`, after `kind` is known: if the terminal's `lead_id` resolves to a live `role="lead"`
  session → the stop becomes a `lead_events` row (idempotent on `key`) and `notifyLead(leadId)`
  decides how it travels. Same grace, same operator-owns rule. Log `[lead-drive]`.
- **Pulled** — the Lead is blocked in `mc lead wait`: its waiter resolves with the unseen events, they
  are marked seen, and NOTHING is typed into it.
- **Pushed** — nobody is pulling: ONE digest, debounced `digestDebounceSec`
  (`CHRONOS_LEAD_DIGEST_DEBOUNCE_SEC`, 5s) from the newest unseen event and never holding the oldest
  longer than `digestMaxWaitSec` (`CHRONOS_LEAD_DIGEST_MAX_WAIT_SEC`, 20s), typed through the same
  guarded path as before — `N of your workers stopped: <id8> REVIEW — <goal> · <id8> BLOCKED — <goal>
  … Run \`mc lead inbox\` for what each one said, then \`mc lead wait\` instead of sleeping.` One line
  on purpose: `sendInput` flattens newlines, and what each worker actually said is in the inbox.
- A worker's pty ending is an `ended` event. It wakes a waiter and rides along in a digest that is
  being sent anyway, but never causes one and is never escalated: a closed terminal is nobody's turn.
- **The Lead typing into one of its workers acks that worker's events** (`session.input` on a terminal
  this Lead owns, whose `by` is neither `operator` nor `daemon`) — it plainly knows that worker
  stopped, so a digest about it afterwards would be telling it what it just did.
- **Its own caps, not Robert's.** `CONFIG.leadDrive`: `CHRONOS_LEAD_DRIVE_PER_WORKER_HOUR` (20) and
  `CHRONOS_LEAD_DRIVE_PER_LEAD_HOUR` (120), in their own rolling-hour maps. A Lead steering six
  workers hears from them far more often than Robert hears from the whole wall, and neither budget
  may eat the other's. A digest is ONE keystroke burst, so it costs the Lead one; each stop in it
  still costs its own worker one. Both windows are re-read at write time.
- **Nothing is ever dropped.** Over a Lead cap the stop is **escalated to Robert** at `fireIfStill`
  time (his own caps apply). A digest that cannot be delivered — dead pty, input rate limit, or the
  Lead itself on a `decide` / `blocked` / tracked prompt — retries after 30s, up to 5 times, and then
  escalates every pending stop in it through `enqueueWake` with Robert's own say-text, marking them
  delivered so nothing reaches him twice.
- **One keystroke at a time per Lead.** `sendInput` writes Enter 200ms after the text, so two messages
  typed together merged into one line. Keystrokes to the same Lead are spaced ≥ 600ms.
- **What the Lead was told is durable** (`lead_wakes`, written the moment an event is first seen or
  delivered), because a restart re-derives a stop's `since` and every idle worker would otherwise
  reach its Lead again about a stop it was already told about. Mirrors `alreadyWoken()`: same session
  + phase, nothing typed into the worker since = same stop. Pruned to 7 days at startup.
- A Lead's own `turn` stop is not news while any of its live workers is still **working** (`isStopped`
  in robert-drive.ts). Stopped = `your_turn`/`review`/`decide`/`blocked`, or `waiting` on somebody who
  has to act — `robert`/`person`/`terminal`/`other`. A worker `waiting --on subagents|ci|command|deploy`
  comes back by itself, so it counts as working: its Lead idling meanwhile is doing its job. A worker
  with no status at all counts as working too — unknown is not evidence the group has frozen.
  Once every live worker is stopped, the group is waiting on the Lead and the Lead on nobody: a normal
  `turn` stop that wakes Robert after the usual grace, with an extra line naming how many workers are
  frozen behind it. A worker's status event re-evaluates its Lead's timer for exactly this reason — an
  idle Lead emits no status of its own.
  `decide` / `blocked` / `review` / `robert` on a Lead go to Robert as for any terminal.
- **A worker's stop is dropped when it already reported.** `mc report` (below) and the turn ending
  seconds later are ONE moment, and the report is the better half of it — so `fireToLead` skips the
  scraped stop while a report from that worker is unacked and younger than 2 minutes. Without it the
  Lead reads the same worker twice in one digest and answers it twice.
- **A Lead's worker waits `leadDrive.graceSec` (`CHRONOS_LEAD_DRIVE_GRACE_SEC`, 15s), not Robert's
  90.** `graceMs` was tuned for "the operator answers in ten seconds and Robert never needs to know";
  for a Lead sitting in `mc lead wait` that is ninety seconds of dead air per worker turn, times
  every worker it has open. `armTimer` takes `min(graceMs(kind), leadDrive.graceSec)` when the
  session has a live Lead — it only ever LOWERS the grace, and the operator-owns rule still applies.

### The worker side (PR 3)
A worker of a Lead used to be a terminal that did not know it had one. It was told nothing, its only
way to report was to stop and let 1200 characters be scraped off its transcript, and its
`mc ask-robert` went over its Lead's head to the one agent that does NOT know this goal.

- **It is told.** `openSession` folds `agents/_blocks/lead-worker.md` into the system prompt (ahead
  of FOCUS_CONTRACT, via `agentBlock` — the same directory and re-read-on-edit as a `{{> block}}`,
  filled with the Lead's id8 and goal), and exports `MC_LEAD_ID` — an id, not a credential. ≤10 lines:
  whose worker it is, that its brief is a slice, `mc report` before it stops, `mc ask-lead` for
  questions, nothing outside Chronos.
- **`mc report <done|partial|blocked> "summary" [--pr URL] [--tests] [--verified] [--question]
  [--next]`** → `POST /api/sessions/:id/report`, workspace-scoped like `/status`, 409 with
  "this terminal has no live Lead" when `resolveLead` finds none. It writes a `lead_events` row of
  kind `report` (`key` NULL — no stop behind it) and `notifyLead`s. `done` declares the card `review`
  and `blocked` declares it `blocked`, through `declareStatus`, so the Desk says what the Lead was
  told. Caps: summary 2000, each field 1000, ≤5 http(s) PR URLs.
- **`mc ask-lead "q" [--options] [--wait 10]`** creates the ask with `route: "lead"` when the session
  has a live Lead (else it is exactly `mc ask-robert`, and says so in one line). It files an `ask`
  inbox row and `notifyLead`s; nothing goes to Robert and nothing to the phone. `mc ask-robert` run
  inside a Lead's worker behaves as `mc ask-lead` — one habit for agents — unless `--robert`.
  - The Lead answers with the ordinary `mc answer <id8> "…"`, which sends `x-mc-lead`.
    `POST /asks/:id/answer` accepts a Lead credential ONLY for an ask whose session carries that
    Lead's `lead_id` (`leadMayAnswer`); anything else is a 404, and `answered_by` is `lead:<id8>`.
    Admin/Robert/operator paths are untouched.
  - **Never a terminus.** An ask still open after `leadDrive.askFallbackMin`
    (`CHRONOS_LEAD_ASK_FALLBACK_MIN`, 10m), or whose Lead ends, is re-routed to Robert through
    `triageAsk` — the path a `route: "robert"` ask takes on creation. Exactly once: the `route`
    rewrite is guarded on the route it is leaving, so whichever sweep wins, the others see a Robert
    ask and stop. Swept beside `sweepTriageDeadline` (desk-watch.ts) and on `session.ended`.
  - The card reads `waiting --on terminal` · "its Lead is deciding: …" (term-status.ts), not Robert's
    line. `isStopped` already counts `waiting --on terminal` as stopped, so a Lead that never answers
    still freezes the group visibly.
- **`mc lead broadcast "text" [--only id8,id8] [--except id8,id8]`** → `POST /api/leads/me/broadcast`
  (leadGate) → `sendInput` to each live worker of this Lead, ≥300ms apart, `by: "lead:<id8>"` (so it
  acks their events like any Lead input). One result line per worker; a 429 for one is reported, not
  fatal. Measured 2026-09-18: a Lead typed the same standing instruction into five workers one by one.
- **Inbox rendering moved server-side.** `leadEventLines` (src/lead-report.ts) composes a stop, a
  report and an ask; `publicLeadEvent` ships `lines` and `mc` prints them. One rendering, asserted on
  without a daemon — three shapes formatted in a shell script is how they drift.

### Lead-authenticated endpoints (src/api.ts)
Header `x-mc-lead`, resolved with `leadScope(req)`; 401 without it, 403 when it is not a live Lead.
Scoped to `leadScope.leadId`, never to the workspace: two Leads in one client are two walls, and no
response ever carries a `lead_token`.
- `GET /api/leads/me/events/wait?timeout_ms=` — long-poll, capped at 55s like `GET /asks/:id/wait`.
  Returns immediately when anything is unseen and marks what it returns seen. One waiter per Lead: a
  second request replaces the first, which resolves empty. The waiter is dropped on client disconnect
  and when the Lead ends.
- `GET /api/leads/me/events[?all=1][&limit=]` — the inbox: outstanding (unacked), or the history.
- `GET /api/leads/me/workers` — one row per worker of this Lead, live first then ended today:
  `id8, status, phase, word, line, progress, goal, goal_done, worktree_branch, minutes_live`.
- `POST /api/leads/me/close-done` — close only this Lead's live workers whose goal is ticked
  (`closeDoneSessions` filter). Optional `rm_worktrees` tries a non-force remove per claim and
  returns every refusal. See Powers below.

### Promotion (Desk right-click → ◆ Promote to Lead)
- `POST /api/sessions/:id/promote-lead` (workspace-scoped; 403 with `x-mc-lead`, 409 for a Lead, a
  Lead's worker, or a terminal with no workspace — `leadPromotionError`).
- A Lead's persona and `MC_LEAD_TOKEN` only exist from spawn, so `promoteToLead` (terminal.ts) stops
  the pty, waits for its onExit to finish (`entry.onExited`; `restarting` keeps a ticket's worktree),
  sets `role = "lead"`, and reopens under the same id with `--resume` — `revive` mints the token.
  The seed says it was promoted; a CLI without a system-prompt channel gets the persona in it.

### mc (scripts/mc)
- `mc lead new "<goal>" [--workspace ID] [--description "..."] [--backend b] [--model m]` →
  `POST /sessions` with `role: "lead"`.
- `mc lead list` → live leads with their worker count.
- `mc lead wait [--timeout 9m]` — loops 55s long-polls until events land (one compact block per
  event: `● <id8> REVIEW — <goal>`, the card line, what it said with its newlines) or the timeout
  passes, which prints `(no worker events in 9m)` and the `mc lead workers` table. 9m by default
  because Claude Code's Bash tool kills a command at 10m.
- `mc lead inbox [--all]`, `mc lead workers`. All three need `MC_LEAD_TOKEN` and say so when it is
  not set.
- `mc lead broadcast "text" [--only …] [--except …]`, `mc lead board`, `mc lead board add "t" ["t"…]`,
  `mc lead board set <n> [--status s] [--worker id8] [--pr URL] [--note "…"]` — same credential.
- `mc report …` and `mc ask-lead …` run in a WORKER (MC_SESSION); `mc answer` sends `x-mc-lead` when
  `MC_LEAD_TOKEN` is set, which is how a Lead answers its own workers.
- `mc session send|key` use `x-mc-lead` when `MC_LEAD_TOKEN` is set and no admin token is readable.
- `mc session new` inside a Lead sends `x-mc-lead` (from `MC_LEAD_TOKEN`) on top of the workspace
  token, so the daemon stamps `lead_id`. `created_by` still comes from `MC_AGENT_NAME`, as the label.
- `mc lead list` counts workers by `lead_id`, not by the `created_by` string.

### Persona (agents/lead/AGENT.md)
Own file, loaded by `agent-defs`. Reuses `{{> wall-hands}}` for the hands. Its own prose covers:
who it is (Robert's deputy for ONE goal), the loop (recall → plan → open workers with a brief each →
`mc lead wait` → act on each stop → wait again — never `sleep`, never a `mc session focus` poll →
review evidence → close workers → tick done → report), what it may do (everything the
goal takes), the one prohibition (no outside comms), when it asks (the goal itself is ambiguous, or
the operator's words are needed for something the goal does not settle — `mc ask-robert` first,
`mc state blocked` when only the operator can answer), and the report shape (FOCUS_CONTRACT).

### The board (`lead_slices`, src/store/lead-slices.ts)
A Lead's plan lived in the turn that wrote it and nowhere else: one compaction and the terminal
steering seven workers could no longer say which slice each was on, or which were already merged.

- Migration 122: `lead_slices(id, lead_id, n, title, status, session_id, pr_url, note, created_at,
  updated_at, UNIQUE(lead_id, n))`. `status` is `todo|doing|review|done|dropped`. `n` is the Lead's
  own numbering (max+1, computed inside the insert's transaction) and is what `--slice 3` and
  `mc lead board set 3` mean — never the row id.
- `/api/leads/me/board` (leadGate, scoped to `leadScope.leadId`): GET list + `{done, total}`, POST
  `{title}`, PATCH `/:n`. A `session_id` on a PATCH is resolved against `sessions.workersOf(leadId)`
  and refused otherwise — a board that could point at a neighbour Lead's workers would be a way to
  name (and through `/desk` to watch) terminals this Lead may not touch.
- `mc session new --slice <n>` sends `slice` in the POST body; the daemon honours it only for the
  Lead whose credential it presented (like `lead_id`), links the worker and sets the slice `doing`.
  It is never a column on the session row.
- Auto-maintenance: a `mc report done` from a linked worker sets its slice `review` and fills
  `pr_url` from the first `--pr`. Never `done` — signing it off after checking the evidence is the
  Lead's, and a worker marking its own work done is the thing a Lead exists to not do.
- `dropped` is off the board: it counts toward neither `done` nor `total`.

### Desk (static/desk.html + GET /desk)
- `/desk` sessions carry `role`, `lead_id` (for a worker of a live Lead), `workers` (live count, on
  a Lead), and `board` — `{done, total}` or null when that Lead has written no plan (so "no plan" and
  "nothing done yet" do not draw the same). The row shows it as a quiet `3/7` beside the worker count.
- A Lead row looks different: `.row.lead` — a `◆ Lead` chip before the client name, a doubled stripe,
  worker count in the side. A worker of a Lead shows `↳` before its title.
- Stage header on a Lead: `◆ Lead · N workers`.
- Spawn: the quick line gets a `◆ Lead` toggle (remembered per session); the dialog gets an
  "Open as Lead" button. Both send `role: "lead"`.
- Counts line adds `N lead(s)` when any is live.
- Workers fold under their Lead (2026-09-18: sub agents must not bloat the rail). Folded by default;
  the `▸ N` button on the Lead row unfolds it (`localStorage desk-lead-open`), children sit indented
  in triage order. A blocked/deciding worker lifts its whole group to that band and turns the fold
  red; ⌘J / "needs you" reaching it unfolds the Lead. A folded worker's finished turn is the Lead's
  to answer, so it leaves the needs-you walk. J/K walk only the rows the rail shows.

## Powers

A Lead gets Robert-like hands **only over its own workers** (`sessions.lead_id ===` its id, via
`leadScope(req)` / `leadGate` in `src/api.ts`). Every security refusal Robert gets, the Lead gets —
and a Lead may never invent an override the operator has not said yes to.

1. **Worktrees** — `removeWorktreeAs` (`src/worktrees.ts`) accepts `caller.lead`. It may delete the
   tree of a worker of its own (live or ended) inside its workspace. All 409s stay (uncommitted /
   unpushed / busy). `force` on a worker's tree → 403
   `"a lead may not force-remove a worker's worktree — <what would be lost>; ask the operator (mc ask-robert)"`.
   `mc worktree rm` sends `x-mc-lead` when `MC_LEAD_TOKEN` is set.
2. **Close-done** — `POST /api/leads/me/close-done` (`leadGate`) closes only its live workers whose
   goal is ticked, reusing `closeDoneSessions` (the same function `/desk/close-done` uses).
   `mc lead close-done [--rm-worktrees]` never force-removes; it prints every worktree refusal.
3. **Reopen** — a Lead may reopen only its own workers; `lead_id` is kept through `revive`; the
   reopened pty gets `leadWorkerBlock` + `MC_LEAD_ID` again. Another Lead → 404.
4. **Worklog** — `POST /workspaces/:id/worklog` allows a Lead only in its own workspace; author is
   forced to `lead:<id8>`. `mc worklog` sends the header.
5. **Still closed** to a Lead: vars write, `/desk/close-done` (the whole wall), `/sessions/:id/drop`.
6. **Audit** — every use publishes a bus event with `by` / `actor` `lead:<id8>` (`src/activity.ts`).

## Scale

1. **Budget** — live workers with `lead_id` count against `CONFIG.leadDrive.maxWorkers`
   (`CHRONOS_LEAD_MAX_WORKERS`, default 10), not `maxSessionsPerWorkspace`. The Lead itself still
   occupies a workspace seat. Machine admission (`admissionNow` in `openSession`) still applies.
2. **Signing** — `mc session new` without `MC_AGENT_NAME` but with `MC_SESSION` signs
   `created_by = agent:<MC_SESSION id8>` so it does not skip admission as `"operator"`.
3. **Cost** — `GET /api/leads/me/workers` and `mc lead list` roll up cost/tokens of the workers and
   the Lead the same way `/desk/log` does (`snapshotUsage` / frozen columns).
4. **Adopt** — `mc lead adopt <leadId>` / `POST /leads/me/adopt`: a live Lead in the same workspace
   takes the ended Lead's live workers, board and inbox (`lead.adopted` bus event).
5. **Orphan** — when a worker's Lead has ended and its stop reaches Robert, the say-text names the
   dead Lead's goal and board (`done/total`) so Robert has context.

## Out of scope
- Robert opening Leads on his own (he can: `mc lead new`), and a Leads block in his prompt.
- Nesting (a Lead opening a Lead) — refused at spawn: a Lead may not open `role: "lead"`.
