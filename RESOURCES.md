# Resources — who holds what on this Mac, and what happens when it is too much

Workspace resource governance, in three PRs. This file is the design for all three; PR 1 (the
ownership ledger + leak reaper), PR 2 (per-workspace budgets + the ladder, brain only) and PR 3's
shared headless browser pool (`mc browser`) are built.
Code: `src/resources/` (`ledger.ts`, `reaper.ts`, `guards.ts`, `budget.ts`, `ladder.ts`, `brain.ts`;
`browser-engine.ts`, `browser-pool.ts`, `browser-routes.ts`), the heavy-slot fairness rule in
`src/machine.ts` (`HeavyPool`), wired from `src/index.ts`, `src/hostd/index.ts` and `GET /api/machine`.

It extends the machine governor (`src/machine.ts`: `nice`, admission, `mc heavy` slots), which
defends against the fleet being *too big*. This defends against processes that *should not exist
any more* (PR 1), and then against one workspace taking more than its share (PR 2).

## The incident (2026-10-02, the 12-core / 18 GB M3 brain)

- Load 21-30, swap 6.8 of 7.2 GB, ~3.3k free pages.
- **188 headless Chrome processes** from `~/Library/Caches/.wrangler/chrome/mac_arm-126.0.6478.182/…/Google
  Chrome for Testing.app` — wrangler's local Browser Rendering, started by collage-ai's
  `[browser] binding = "BROWSER"` under `@cloudflare/vitest-pool-workers`. ~2-4 GB RSS.
- 32 browser roots had **PPID 1** (their vitest had exited); 96 were older than an hour, some 5 h.
- All started by Claude Code subagents (worktrees under `collage-ai/.claude/worktrees/agent-*`)
  inside **one** Desk terminal. That terminal held both heavy slots — slots serialize suites, they
  do not stop leaks.
- **The orphans could not be attributed after the fact.** puppeteer launches its browser detached
  (own process group, own session) with a stripped environment: `ps eww` showed ~6 variables, no
  `MC_SESSION`, no `MC_WORKSPACE`. Env tagging and process groups are both dead ends.
- `~/.claude/bin/idle-reaper.py` (a personal launchd job, not Chronos) never matched them. Chronos owns this now.

## Decisions (final)

- **Enforcement is a ladder:** warn → slow (renice) → pause (SIGSTOP the newest heavy process).
  Leftovers of an **ended** terminal/run and **orphans** are killed with no warning.
- **Limits are a share of the machine:** a per-workspace weight; RAM, CPU and heavy slots split by
  weight across the workspaces *active* on that machine; an idle workspace's share is lent. The
  same rule on the brain and on every host, each judged on its own capacity.
- **Order:** PR 1 = ownership ledger + leak reaper. PR 2 = per-workspace budgets + the ladder.
  PR 3 = agent tools (`mc budget`, prompt rules) + an efficiency ledger on the Desk.

## PR 1 — the ownership ledger

Attribution is **lineage observed while the parent is alive** (`src/resources/ledger.ts`):

- **One `ps` per tick** (`CHRONOS_REAPER_TICK_MS`, 10 s): `ps -Ao pid,ppid,pgid,uid,rss,pcpu,lstart,comm`
  — ~50 ms here; never `ps eww` (~90 ms, reads every environment). Skipped entirely when nothing runs
  and nothing is owned.
- **Roots** are what the spawner holds in memory — `localHost.listLive()` on the brain (Desk ptys
  and headless runs), the live channels on a host — **never `sessions.pid` from the DB**, which
  survives a restart and can then name anybody. A root is believed only if it is the spawner's
  **direct child** and started within [-5 s, +60 s] of when the spawner says it spawned it.
- **Owner = one incarnation** `(kind, id, root pid)`. promoteToLead / a model failover reopen the same
  session id under a new pid: the old incarnation ends, its leftovers are reaped, the new pty starts clean.
- **Sticky**: an entry is keyed by `(pid, start time)` — a recycled pid is a stranger and the entry is
  dropped. A process keeps its owner after reparenting to launchd, and the tree walk starts from
  **everything owned**, so a renderer forked by an already-orphaned Chrome is still owned.
- **An owner ends** the tick its root leaves the spawner's live list (not on the DB row): the bus's
  `session.ended` / `run.ended` only *kick* an early tick.
- In memory, bounded: entries die with their process, an ended owner once it owns nothing, 50k cap.

Known gaps, accepted: a grandchild born *and* orphaned inside one tick (≤ 10 s) is never seen with
its parent and stays unowned (the incident's Chromes lived for hours). A daemon restart forgets the
ledger — survivors from before it are unowned and untouched (the safe direction). "Detached" means
no longer under a living *owned* parent, so a Linux subreaper (systemd --user) adopting an orphan
instead of PID 1 changes nothing.

## PR 1 — the leak reaper

`src/resources/reaper.ts`, same tick. Three rules (a tick serves rule 3 first — finish what was started):

1. **Ended owner** → SIGTERM now, SIGKILL after the grace, no warning, for what it still holds
   **attached** (under a living owned parent) and its **leak-family** processes wherever they are. Its
   other **detached** processes (PPID 1 — they daemonized on purpose) are **left running**, together
   with what runs below them except leak-family descendants: never signalled, announced once as
   `left_running` (log line, `proc.reaped` event with `signal: null`, `left_running` in the rollup).
2. **Orphan of a live owner** (owned, detached) → SIGTERM, after `CHRONOS_REAPER_ORPHAN_GRACE_MS` (2 min)
   orphaned — **only for the leak family**: an executable matching `chrom(e|ium)|headless_shell|firefox|
   webkit|msedge|workerd` (`CHRONOS_REAPER_ORPHAN_FAMILY` overrides), or `node`/`bun`/`deno` whose argv
   names a test runner (`vitest|jest|mocha|playwright|puppeteer|tinypool|karma|wdio|cypress`; argv is
   read once per new orphan with `ps -o command -p`, never per tick).
3. **Escalate:** a SIGTERM still alive after `CHRONOS_REAPER_KILL_GRACE_MS` (10 s) → SIGKILL, aimed
   the same way.

**Keep-list** — never signalled under any rule, attached or not, nor anything below it: argv
matching Claude Code's `claude daemon` / `bg-pty-host` / `bg-spare` (`--bg-pty-host`, `--bg-spare`),
`limactl`, `colima`, `gpg-agent`, `ssh-agent`, `watchman`, `git fsmonitor--daemon`, `ollama`, plus
`CHRONOS_REAPER_KEEP` (one regex over argv). argv is read for every candidate target **and every
owned ancestor of one** (a vitest inside a background Claude session is spared by the kept
`claude --bg-pty-host` ABOVE it — and nothing else ever reads a `claude`'s argv), once per process,
batched in one `ps -o command -p`. A target whose own or any ancestor's argv is unread is never
signalled; a tick that cannot read them signals nothing.

**Why rule 1 spares detached processes (review of #128).** Sticky lineage makes a terminal the owner
of every shared per-user daemon its CLI happened to start on demand. Measured on the brain: `claude
daemon run --json-path ~/.claude/daemon.json` (PPID 1) with `claude bg-pty-host` / `bg-spare` children
under `/tmp/cc-daemon-501/`, one of them a 5-hour-old background Claude session (`--resume`) that other
sessions — the operator's own — were using. "Kill everything the ended owner holds" would have
SIGTERMed that daemon and every session it hosts when one Desk terminal closed. Same class: `colima
start` / limactl hostagent (Docker dies), `pg_ctl start`, gpg-agent, ssh-agent, watchman, git fsmonitor,
gradle/kotlin daemons, `ollama serve`, `redis-server`, an MCP server (`dart mcp-server`, found orphaned
here). Detaching is the signal that a process meant to outlive its launcher; leak-family processes
(a headless Chrome, an orphaned vitest) never mean that. Leak-family descendants of a spared process
still die, which is how a Bash tool's orphaned `zsh -c "npx vitest"` loses its vitest while `vite`
keeps its esbuild. The keep-list covers what is attached at the moment its owner ends.

**Dev servers.** A dev server in a Desk terminal dies with the terminal **only while it is attached**
(running under the CLI / its shell). One that detached (`npm run dev &` whose shell has exited, a
`nohup`, `pg_ctl start`) is **left running** and reported, not killed.

**Why the orphan rule is a family, not "every orphan":** an agent's `npm run dev &` is *also* PPID 1
the moment its shell tool exits, and the agent may be curling it a minute later. A LISTEN-socket
exemption was rejected: wrangler/puppeteer browsers may listen on a debugging port, so it would exempt
exactly the leak. An orphaned browser engine or test runner is never something a live agent is still
driving through its (dead) parent; anything else waits for rule 1, which leaves it running too. The cost: a browser an agent
deliberately backgrounds with `&` dies 2 minutes after its launcher does — run it in the foreground
of a tool call, or under a process that stays alive.

**Aim.** A signal goes to the **process group** when the group's leader is owned by the same owner and
every member of the group is too (Chrome's renderers go with their browser in one kill(2)); otherwise
to each owned pid. **At most `CHRONOS_REAPER_MAX_SIGNALS` (20) kill(2) calls per tick**; the rest
wait for the next tick.

**Never signalled:** pid ≤ 1; the spawner (daemon / hostd) and **its process group** (a headless run
lives in the daemon's group — its group is never a target); a live root (a running terminal's own
CLI); another user's process; any executable under a protected prefix — `/Applications/Google
Chrome.app/` always (Leo's own browser, driven by the claude-in-chrome extension), plus
`CHRONOS_REAPER_PROTECT`; and **any process the ledger does not own**. Immediately before signalling,
every target's start time is read again (`ps -o lstart -p`); a target whose start moved is skipped, and
if the re-check itself fails nothing is signalled that tick.

**Modes** (`CHRONOS_REAPER`): `on` (**default**) · `dry` (decide, log and publish each target once,
never signal) · `off` (no ledger at all). Default `on` because a mis-kill needs a mis-attribution, and
every attribution path is guarded: roots come from the spawner's own live children (a pid that is
still your unreaped child cannot be recycled), everything else is lineage observed at the moment plus
the start-time identity, re-checked right before the kill. `dry` is one `.secrets` line away for a
first look on a new machine.

**Trail.** Every signal is logged (`[reaper] SIGTERM group 52749 — 12 procs, 340 MB — session ae29a268
(ws …): session ended — Google Chrome for Testing`) and published as `proc.reaped` (signal, reason
`session_ended|orphan|escalate|left_running`, dry, pid/group, count, rss_mb, cmd, session_id|run_id,
workspace_id; `left_running` has `signal: null`).
`activity.ts` records it — the raw material of PR 3's efficiency ledger.

**Surface.** `GET /api/machine` (and so `mc machine`) gains `procs`: `{ mode, every_ms, sampled_at,
workspaces: [{workspace_id, pids, rss_mb, cpu, orphans, reaped, left_running}], owners: [{kind, id,
workspace_id, ended, pids, rss_mb, cpu, orphans, reaped, left_running}] }`. Admin sees every workspace; a workspace token sees
only its own rows. Brain only: a request forwarded from a host gets no `procs`.

**Hosts.** hostd runs the same `Reaper` over its own live channels (`src/hostd/index.ts`), on its own
`CHRONOS_REAPER*` env, logging to the host log. Not yet reported to the brain: a `procs` frame on the
link (so `GET /machine` can show a host's rollup) is still a TODO — see PR 2 → Hosts.

### Knobs

| Env | Default | Meaning |
|---|---|---|
| `CHRONOS_REAPER` | `on` | `on` · `dry` (log, never signal) · `off` (no ledger). |
| `CHRONOS_REAPER_TICK_MS` | `10000` | Ledger sample + reaper pass interval (min 1000). |
| `CHRONOS_REAPER_KILL_GRACE_MS` | `10000` | SIGTERM → SIGKILL. |
| `CHRONOS_REAPER_ORPHAN_GRACE_MS` | `120000` | How long a leak-family process must be orphaned before rule 2. |
| `CHRONOS_REAPER_MAX_SIGNALS` | `20` | kill(2) calls per tick, all rules together. |
| `CHRONOS_REAPER_ORPHAN_FAMILY` | browsers + workerd | Regex over the executable name for rule 2 (an invalid one keeps the default). |
| `CHRONOS_REAPER_PROTECT` | — | Extra comma-separated executable path prefixes never signalled. |
| `CHRONOS_REAPER_KEEP` | — | Extra keep-list regex over argv: never signalled, nor anything below it (an invalid one is logged and ignored). |

## PR 2 — per-workspace budgets + the ladder (built, brain only)

`src/resources/budget.ts` (the math, pure), `src/resources/ladder.ts` (the rungs), `src/resources/guards.ts`
(the guards it shares with the reaper), `src/machine.ts` `HeavyPool` (slot fairness), wired in
`src/resources/brain.ts`.

### Shares and budgets

On each tick, from the ledger's snapshot (the ladder runs right after the reaper's pass, on the same `ps`):

- **Active** workspace = owns at least one live (not ended) owner on this machine.
- **Weight** `w` per workspace: the per-workspace setting `resources.weight` (default 1, 0.1–100), shown
  on the Desk's ⚙ Settings page for a workspace under Limits. **Share** = `w(ws) / Σ w(active)`. An idle
  workspace is not in the sum: its share is lent to the rest automatically. `GET /machine` shows a workspace
  with nothing live the share it *would* get (`active: false`).
- **Capacity**, minus a reserve for the OS, the daemon and the Desk: RAM `= total − max(3 GB, 20 %)`
  (`CHRONOS_LADDER_RESERVE_MB` / `_PCT`); CPU `= ncpu × 100 %`; heavy slots `= the machine's pool size`.
- **Budget** = share × capacity. Heavy slots: `max(1, floor(share × slots))`, so a lone workspace may hold
  every slot and two equal workspaces cannot both be starved.
- **Usage** = Σ RSS and Σ %CPU of what the workspace's **live** owners hold (CPU = median of the last 3
  ticks, to ignore a compile spike), and slots held (holders carry `workspace_id`). An ended owner's
  leftovers do not count: they are the reaper's (killed, or deliberately left running).
- **Over** = RSS over budget, or CPU over budget. Slots are not part of "over" — holding more than the slot
  budget is lending, and fairness takes it back the moment somebody else waits.

### Heavy-slot fairness

Measured 2026-10-02: one terminal held both of the brain's slots while other workspaces' suites waited.
In `HeavyPool.pump`, a waiter whose workspace already holds its slot budget is **passed over** while a
waiter of a **different** workspace that is under its own budget is waiting (its poll parked, or it
polled within `FAIR_WAITING_MS` = 5 s — a ctrl-C'd `mc heavy` does not hold a free slot back for the
90 s its queue entry survives). It keeps its place. Nobody else waiting → the slot is lent (`mc heavy`
for a lone workspace is unchanged). Two workspaces both at budget hold nobody back: plain FIFO, never a
deadlock. An unattributed caller (no workspace: the operator's own shell) is never held back and never
holds anyone back. The workspace comes from the caller's workspace token, else the `session_id`'s row.
The budget is the weighted share over the machine's active workspaces (the brain's ledger, local pool
only) plus every contender in the pool (a waiter is active by definition, which is all a host's pool on
the brain can see).

### The ladder

It runs only while the machine is **strained**: memory pressure ≥ warning, or load/core over
`CHRONOS_MAX_LOAD_PER_CORE` (admission's own inputs, `currentLoad()`). Over budget on a calm Mac costs
nobody anything. Per workspace, while strained **and** over:

1. **Warn** at once: one line to each of the workspace's live owners on this Mac. A headless run gets
   the **`mc tell` mailbox** (`sendMessage`: steered live when it can be, else at its next checkpoint).
   A Desk terminal is **typed into** (`sendInput`, as host failover tells a terminal it moved;
   rate-limited and recorded as `session.input`) — see *Warn delivery* below for why. It names the share,
   budget, usage, pressure and load, and the three heaviest process groups with RSS and CPU
   (`node (vitest) ×4 2.1 GB 310% CPU (this terminal)`). At most once per `CHRONOS_LADDER_WARN_EVERY_MS`
   (10 min) per workspace.
2. **Slow** — still over after `CHRONOS_LADDER_SLOW_AFTER_MS` (2 min): renice the workspace's **heavy
   processes only** (the same `isHeavy` as rung 3: leak family, test runners, build tools) together with
   their own descendants — a Chrome's renderers, a vitest's workers — to `CHRONOS_LADDER_NICE` (20),
   heaviest first (subtree RSS, or CPU when only CPU is over), up to `CHRONOS_LADDER_MAX_ACTIONS` (3) per
   workspace per tick. Never a non-heavy process at the top of a subtree, and nothing in the never-list
   (shells, ptys, agent CLIs, `mc`) even below a heavy one; a runtime running the `mc` CLI (`mc heavy --
   npx vitest`) is never heavy. A process already at 20 — e.g. a worker forked by a reniced vitest after
   the fact, born there — counts as already slowed.
   **Renice is one-way on macOS without root**: only root may *lower* a nice value (measured here:
   `renice 10` on our own nice-20 `sleep` → `Permission denied`). So nothing is ever put back, and that
   is exactly why rung 2 renices only short-lived heavy processes: a suite, a build, a headless browser
   exit on their own and take the nice value with them. An agent's MCP servers (chrome-devtools-mcp, fff,
   graphify, `dart mcp-server`…), persistent tool shells, `mc` long-polls and dev servers live for the
   whole terminal; reniced, they would stay slow long after the episode — they are never touched. When
   the episode ends the ladder forgets its records with ONE log line per workspace ("N heavy process(es)
   reniced to 20 stay there until they exit"). A workspace over budget with nothing heavy gets only the
   warning, plus `(over budget, nothing heavy to slow)` logged once per episode. Considered and NOT done:
   `taskpolicy -b` / `-B` (PRIO_DARWIN_BG) *is* reversible unprivileged (measured: pri 4 → 31), but it
   clamps to the E-cores and throttles I/O — `machine.ts` rejected it for agents for that reason, and
   Leo's decision was renice.
3. **Pause** — still over (past the 2 min) **and** memory pressure critical: SIGSTOP the workspace's
   **newest heavy process**, one per workspace per tick. Heavy = leak family (the reaper's), a node/bun/deno
   running a test runner, or a build tool (`tsc`, `esbuild`, `webpack`, `rollup`, `cargo`, `rustc`, `go`,
   `gradle`, `swift*`, `xcodebuild`, `clang`, `javac`, `bazel`, `ninja`…, or a runtime whose argv runs
   `tsc` / `vite build` / `next build`…; `CHRONOS_LADDER_HEAVY` adds names). Never a CLI root, a shell or
   pty (`zsh`, `bash`, `login`, `tmux`, `spawn-helper`…), an agent CLI (`claude`, `codex`, `grok`, …), a
   keep-listed process or anything below one.

Back down: paused processes get SIGCONT **oldest pause first**, up to `CHRONOS_LADDER_MAX_ACTIONS` per tick,
when the workspace is back under budget (`under_budget`) or the machine is calm (`calm`). Between them —
still strained, still over, but pressure only "warning" — nothing more is paused and nothing resumes.

**Every paused pid is SIGCONTed:**
- **before the reaper signals it** — the reaper calls `beforeSignal(pids)` right before each kill(2); a
  SIGSTOPped process never handles SIGTERM (it stays pending), so it would sit out the grace and be
  SIGKILLed (`reason: reaped`);
- when its owner ends and the reaper spares it (a detached non-leak process is left running) —
  the next ladder pass (`owner_ended`);
- when the ladder is switched off (`disabled`; the global setting takes effect on the next tick, no restart);
- on daemon exit — `process.on("exit")` (index.ts turns SIGTERM/SIGINT into `process.exit`), synchronous,
  with one blocking `ps` to re-check start times; if `ps` cannot answer the SIGCONT goes anyway (a process
  left stopped forever is the worse failure than a no-op SIGCONT to a stranger) (`shutdown`);
- **after a crash**: the paused list is mirrored to `CHRONOS_LADDER_STATE` (default
  `<CHRONOS_DB>.ladder-paused.json`, gitignored by `chronos.db.*`; written on every change, removed when
  empty). On boot, before the first tick, every recorded pid that is **still stopped** (`ps` state `T`)
  **and** still the same process (start time) gets SIGCONT (`boot`); nothing else is touched, and the file
  goes. If `ps` cannot answer, the file is kept for the next start. Remaining risk, accepted: a SIGKILLed
  daemon that paused a process and then is never started again leaves it stopped; and a process the
  previous daemon paused that someone else ALSO stopped (a `^Z`) is resumed.

**Modes** (`CHRONOS_LADDER`, overridden live by the Desk's global setting `resources.ladder`):
`warn` (**default**) — only rung 1 acts; rungs 2-3 log `(would renice to 20) …` / `(would pause) …` and
publish their event with `dry: true`, once per episode (pause: once per would-be target), so the first
deploy is observable · `slow` — rungs 1-2 · `on` — all three · `off` — nothing; anything slowed or paused
is released on the next tick. Independent of `CHRONOS_REAPER`, except that `CHRONOS_REAPER=off` means
no ledger and so no ladder (the slot fairness still works, weighing only the pool's contenders).

**Safety** — the reaper's guards, shared through `guards.ts` (not copied): ledger-owned only; never
pid ≤ 1, the daemon, a live root, another user's process, a protected path, the keep-list or anything
below it, with every owned ancestor's argv read first (an unread one is a veto — nothing is reniced or
paused that tick); the start time re-read (`ps -o lstart -p`) right before every renice and every
SIGSTOP/SIGCONT on the way down; capped actions per tick. The ladder signals **pids only, never a
process group** — so the daemon's own group (where headless runs live) is never a target, while a headless
run's own test runner can still be paused by pid like a terminal's.

**Trail.** Every action is a log line with its numbers (`[ladder] SIGSTOP pid 4242 — node (vitest), 2048 MB,
300% CPU — session ab12cd34 (ws acme): memory pressure critical, RAM 9.1 GB / 7.2 GB, CPU 640% / 600%`) and
a bus event — `budget.warn` (usage, budget, share, weight, pressure, load, heaviest, told/failed),
`budget.slow` (pids, nice, rss, cpu, over_ms, dry), `budget.pause` (pid, cmd, rss, cpu, owner, dry),
`budget.resume` (action `cont`, reason `under_budget|calm|owner_ended|reaped|disabled|shutdown|boot`,
`paused_ms`) — which `activity.ts` records like `proc.reaped`. `budget.warn` also carries `deferred`.

**Warn delivery — why typing.** Looked for a channel that reaches a terminal's agent without typing:
the `mc tell` mailbox and its `mc step`/`mc note` piggyback are run-scoped (`resolveMessageTarget` refuses
a session: "type into the terminal for sessions"); the CLI hooks hand context back only on
`UserPromptSubmit` (`memory_notice`) — i.e. on the operator's NEXT prompt, which an agent mid-task never
sees — and `PostToolUse` is installed only for the ask tools; a Desk toast/card is the operator's, not the
agent's. So a terminal is typed into, as host failover does. To keep it out of the operator's own line,
`tellOwner` (brain.ts) DEFERS a terminal anyone typed into in the last 30 s (`sessionActivity().last_in`);
the ladder retries it on the following ticks (still within the episode, without resetting the 10-minute
clock) and logs "delivered late". The line always starts with `[chronos budget]` and is one line
(`sendInput` folds newlines). Residual risk: a half-typed draft the operator left untouched for >30 s
still gets the warning appended to it.

**Surface.** `GET /api/machine` → `procs.ladder: {mode, strained, critical, capacity:{rss_mb, cpu, slots},
measured_at}` and each `procs.workspaces[]` row gains `weight, share, active, budget:{rss_mb, cpu, slots},
usage:{rss_mb, cpu, slots}, over, rung (ok|warn|slow|pause — the rung reached; in warn mode only warn acted),
paused:[pids], slowed`. A workspace token sees only its own row (PR 1's `callerScope` rule). `mc machine`
prints one line per row it gets — the caller's own, or every workspace for the operator.

### Knobs

| Env / setting | Default | Meaning |
|---|---|---|
| `CHRONOS_LADDER` / global setting `resources.ladder` | `warn` | `off` · `warn` · `slow` · `on` (see Modes). |
| setting `resources.weight` (per workspace) | `1` | The workspace's weight in the share (0.1–100). |
| `CHRONOS_LADDER_SLOW_AFTER_MS` | `120000` | Over budget (while strained) this long before rung 2. |
| `CHRONOS_LADDER_WARN_EVERY_MS` | `600000` | A workspace is warned at most this often (min 60000). |
| `CHRONOS_LADDER_NICE` | `20` | Rung 2's nice value (1–20). |
| `CHRONOS_LADDER_MAX_ACTIONS` | `3` | Per tick: subtrees reniced per workspace, and SIGCONTs on the way down. |
| `CHRONOS_LADDER_RESERVE_MB` / `_RESERVE_PCT` | `3072` / `20` | RAM kept back for the OS, daemon and Desk: the larger of the two. |
| `CHRONOS_LADDER_HEAVY` | — | Extra regex over the executable name: more build tools the pause rung may stop. |
| `CHRONOS_LADDER_STATE` | `<CHRONOS_DB>.ladder-paused.json` | Where the paused list is mirrored for crash recovery (none for an in-memory DB). |

### Decisions made while building it

- **Weight in kv, not a column.** The per-workspace settings mechanism (`settings:ws:<id>` in kv, resolved
  on every read) already does exactly this, renders on the Desk's Settings page with no UI work, needs no
  migration, and a change lands on the next tick. A column would have meant a migration, a schema field,
  a PATCH path and a hand-built Desk control for one number.
- **Warn delivery** reuses the two existing channels (terminal: typed input like host failover's `tell`;
  run: the `mc tell` mailbox) — no new channel, no Desk card yet (PR 3's Desk work can render the
  `budget.*` events, which are already in activity).
- **Renice is never undone** (one-way without root, see Slow), so rung 2 is restricted to heavy
  processes. Pause is undone when the workspace is back under budget OR the machine is calm.
- **"Never the daemon or its group"** = never a group signal at all (pid-only), never the daemon pid —
  the same meaning PR 1 gives it. Excluding every pid in the daemon's group would have made headless
  runs' test runners immune.
- **Usage counts live owners only** (see Shares and budgets).
- **The tick is the reaper's** (`CHRONOS_REAPER_TICK_MS`, 10 s): the ladder rides `Reaper.afterTick`, inside
  the reaper's re-entry guard — one `ps` for both, never interleaved.

### Hosts — not in this PR (TODO)

Brain only. A host's processes are in the host's own ledger (hostd runs the same `Reaper`), and the brain
does not see them, so the brain's ladder never touches a remote terminal. What PR 2 deliberately leaves:

- **A `procs` link frame** (hostd → brain, every reaper tick or on change): the host's per-workspace
  rollup (`pids, rss_kb, cpu, orphans, left`) plus `totalMb` / `ncpu`. The brain would merge it into
  `GET /machine` for that host and use its active workspaces in that host's `HeavyPool` slot budget
  (today a host's pool weighs only its contenders).
- **A hostd-local ladder**: the same `Ladder` class over hostd's `Reaper`, with `tell` going over the link
  (a host terminal is typed into by the brain) and weights pushed down in the welcome frame. It must not
  fight the **fence** (`src/hostd/fence.ts`): while a host is fenced it has SIGSTOPped whole process groups
  itself, and a ladder SIGCONTing "oldest first" would thaw work the brain may already have moved. The
  host ladder must stand down while fenced (no pause, no resume) and must not SIGCONT a pid the fence
  stopped; reconcile's `attach` thaws by group, which also wakes ladder-paused pids — the ladder should
  then simply re-evaluate. Not done here because the fence interplay needs its own tests on a real host.

## PR 3 — agent tools + efficiency ledger (design)

- **`mc budget`**: the caller's workspace share, budget, usage and ladder rung on its machine, plus its
  own terminal's processes — so an agent can see *it* is the problem before the ladder says so.
- **Prompt rules** (`agents/_blocks/`): test with `mc heavy`, never background a browser, close dev
  servers you started, check `mc budget` before a second suite.
- **Efficiency ledger** on the Desk: per workspace and per terminal, over time — peak/avg RSS, CPU-time,
  slot-minutes, processes reaped (from `proc.reaped` in the activity table) and ladder actions, next to
  what the work shipped. "Which workspace leaks" becomes a number.

### Shared headless browser pool — built (`mc browser`)

The incident's root cause was every test run launching its own Chrome. This removes the reason to.
Code: `src/resources/browser-engine.ts` (the process, discovery, the CDP proxy, the host rpc),
`browser-pool.ts` (leases, caps, fairness, heartbeats), `browser-routes.ts` (`/api/browser/*`).

**How an agent uses it.** `mc browser run -- <cmd>` — like `mc heavy`: long-polls for a lease, runs
the command with `CHRONOS_BROWSER_WS` (a CDP endpoint), `CHRONOS_BROWSER_CONTEXT` (its browser
context id) and `CHRONOS_BROWSER_LEASE` in its env, heartbeats every 30 s, releases on exit (ctrl-C and
`kill` included). Verified with puppeteer-core 25.12 and playwright-core 1.63:

```js
const browser = await puppeteer.connect({ browserWSEndpoint: process.env.CHRONOS_BROWSER_WS });
const ctx = browser.browserContexts().find((c) => c.id === process.env.CHRONOS_BROWSER_CONTEXT);
// Playwright: const b = await chromium.connectOverCDP(ws); const ctx = await b.newContext();
```

Also `mc browser status` (engine, running, contexts in use / cap, your leases), `mc browser lease
[--label x]` / `beat <id>` / `release <id>` by hand. The rules agents are given (in order: avoid a
browser — fetch + happy-dom/jsdom/linkedom, mock `env.BROWSER`; need rendering → `mc browser run`; never
launch your own Chrome or Puppeteer) are `agents/_blocks/browser.md`, folded into every Desk terminal's
prompt by `terminal.ts`, and the mission-control skill.

**The browser.** One per machine (brain and each host), started on the first lease, stopped
`CHRONOS_BROWSER_IDLE_MS` (10 min) after the last one ends.

- **Engine**: the newest `chrome-headless-shell` in the puppeteer cache (`$PUPPETEER_CACHE_DIR`,
  `~/.cache/puppeteer`), else Chrome for Testing (`/Applications/Google Chrome for Testing.app`, then the
  cache), or `CHRONOS_BROWSER_PATH`. **Never** `/Applications/Google Chrome.app` or the operator's real
  Chrome profile — refused even when a knob names it. Nothing is downloaded unless
  `CHRONOS_BROWSER_AUTO_INSTALL=1`; the install is one line:
  `npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer`. On the brain
  (2026-10-03): chrome-headless-shell 153.0.8010.36 from the cache, ~0.3 s warm start.
- **No debugging port.** `--remote-debugging-pipe`: CDP is fds 3/4 of the daemon's own child. Nothing
  listens (the real-browser test checks `lsof -iTCP -sTCP:LISTEN` on the browser and its helpers) and
  no `DevToolsActivePort` is written. The lease proxy is the only way in.
- A throwaway `--user-data-dir`, mode 0700, under `<state>/.browser-pool/profile-*` (also 0700; hostd:
  `~/.chronos-host/browser-pool/`), deleted on stop, and any left by a crash deleted on the next start;
  `--use-mock-keychain`, no sync/extensions/background networking.
- **The daemon's own child** (hostd's on a host), in its process group: the ledger adopts only
  below `localHost.listLive()` roots, so it is nobody's leftover, and the reaper never signals the
  spawner's group. SIGKILLed on the daemon's `exit`; launchd takes the group down otherwise.

**The lease proxy — the only door.** Each lease gets `ws://127.0.0.1:<proxy>/devtools/browser/<secret>`
on a loopback-only proxy in the daemon (hostd): a 256-bit random secret per lease, matched in constant
time against every live lease (an unknown, wrong-length or released secret is a 404; the pool's lease
and handle ids are never credentials). Each client connection gets its own browser session
(`Target.attachToBrowserTarget` over the pipe), so its discovery and auto-attach state is its own, and
every message is checked against the lease (`policy()` in browser-engine.ts — an allow-list, default
deny):

- **Targets**: a lease sees and touches only targets whose `browserContextId` is one of its contexts.
  `Target.getTargets`, `getBrowserContexts` (only its own ids), `getTargetInfo` and the
  `targetCreated` / `targetInfoChanged` / `targetDestroyed` / `attachedToTarget` / `detachedFromTarget`
  events (including those `setDiscoverTargets` produces) are filtered; `attachToTarget`,
  `activateTarget`, `closeTarget`, `autoAttachRelated` on a foreign target are refused;
  `createTarget` needs one of the lease's `browserContextId`s (no default-context pages);
  `disposeBrowserContext` only on its own. One browser means a lease's `setAutoAttach` also reaches
  other leases' new pages: the proxy resumes those (`Runtime.runIfWaitingForDebugger`) and detaches
  at once, so nobody's page stalls and nothing reaches the client.
- **Flat sessions**: a message with a `sessionId` passes only for a session the proxy saw attached to
  one of the lease's targets; anything else is refused before it reaches Chrome.
- **Browser-wide**: `Browser.getVersion` only, plus `Browser.close` / `crash` (puppeteer's
  `browser.close()` on a connected browser — answered `{}`, only that client is disconnected),
  `grantPermissions` / `resetPermissions` / `setPermission` and `Storage.get/set/clearCookies` for the
  lease's own contexts, and `Browser.setDownloadBehavior` (Playwright sends it per context) forced to
  `deny`. Everything else — `SystemInfo`, `Tracing`, `Memory`, `Target.exposeDevToolsProtocol`,
  `attachToBrowserTarget`, `sendMessageToTarget`, other `Browser.*`, `Storage.*` without the lease's
  context — is refused. On a page's own session a fixed set of page-scoped domains passes (Page,
  Runtime, Network, DOM, Input, Emulation, Fetch, …; `TARGET_DOMAINS`).
- **No reach into the daemon's disk** (the browser runs unsandboxed as the daemon's user): only
  `http(s):`, `about:`, `data:`, `blob:` for `Page.navigate` / `Target.createTarget` (Chrome itself
  blocks a page's own `file:` loads — the real-browser test checks `fetch('file:///etc/hosts')`);
  `DOM.setFileInputFiles`, `Network.loadNetworkResource`, `Page.setDownloadBehavior`, file drags and
  `Security.setIgnoreCertificateErrors` are refused.
- **Egress**: a lease's contexts (given and adopted) are created with `proxyServer` = its workspace's
  egress proxy when it has one — the brain's own, or on a host the host's, started from the policy the
  brain sends with the `open` rpc — so an egress-locked workspace does not get the open internet by
  borrowing the browser. Loopback stays direct (Chrome's implicit bypass), so dev servers work. A
  credential-brokering workspace's intercepted hosts fail TLS in the browser (it does not trust the
  interception CA).
- `Target.createBrowserContext` (Playwright's `browser.newContext()`) is created by the daemon and
  adopted by the lease (≤ 9 contexts per lease; a `proxyServer` of the client's own is refused); it
  dies with the lease. Releasing a lease closes its connections and disposes its contexts.

A sweep every 30 s disposes contexts no lease holds, closes pages in the default context, and
disposes a handle untouched for 3 min (the engine-side TTL: on a host, what cleans up after a brain
that went away for good).

**Threat model.** Workspaces are client boundaries (different employers), and on one machine they
share this browser. A lease holder — an agent of one workspace, possibly confused or compromised — must
not read, drive or end another workspace's pages, cookies or storage, must not read the daemon's
disk through the browser, and must not leave its workspace's egress policy through it. The defences
are: no port (the pipe is the daemon's alone), one door with an unguessable per-lease secret, a
per-method allow-list scoped to the lease's contexts, separate per-context cookie jars (Chrome
browser contexts share nothing), and the egress proxy per context. Not defended against: a local
process running as the operator's own user that reads the daemon's memory or ptraces the browser
(same user — outside what any of this can stop), and Chrome renderer exploits crossing contexts
(contexts are not separate OS sandboxes per workspace; separate browsers per workspace would be).

**Leases.** Pools live on the brain, one per machine, like the heavy slots; in memory on purpose.

- `POST /api/browser/leases {label, ticket?, session_id?, run_id?}` long-polls 55 s →
  `{granted, lease_id, ws_endpoint, context_id, expires_at, host_id}`, or `{granted:false, ticket,
  in_use, cap, waiting}` (pass `ticket` back to keep the place in line), or 503 `{error}` when no
  engine is installed / `CHRONOS_BROWSER=off` (waiting would not help). `PUT /api/browser/leases/:id`
  heartbeats → `{expires_at}`; `DELETE` releases; `GET /api/browser` = this machine's block + the leases
  the caller may see.
- A lease ends — and `Target.disposeBrowserContext` closes all its pages — on release; when its
  heartbeat lapses (90 s, the heavy-slot window); on `session.ended` / `run.ended` of the session or
  run it named; or when the browser itself goes (crash, idle stop): the pool drops it and the next
  heartbeat 404s.
- **Scoping** (CLAUDE.md gotcha #4): the lease's workspace is the caller's token's. A workspace token
  sees, beats and releases only its own workspace's leases (404 otherwise); a `session_id` / `run_id`
  it names must be its own workspace's (404). Admin sees and releases all. `ws_endpoint` is only ever
  in the grant, never in a listing.
- `GET /api/machine` gains `browser: {enabled, engine, version, pid, running, in_use, cap, per_ws,
  waiting, idle_stops_at, error}` for the caller's machine.

**Caps and fairness** (decisions):

- At most `CHRONOS_BROWSER_MAX_CONTEXTS` leases per machine; default one per 2 GB of RAM, 1..8
  (18 GB brain → 8).
- Fair share `CHRONOS_BROWSER_MAX_PER_WS`, default half the cap (rounded up). Below it a workspace is
  granted whenever there is room; at or past it, only while **no other workspace is waiting** — an idle
  machine lends the whole browser, and the next free context goes to the workspace under its share
  even if the one over it asked first. Nothing is ever taken back from a holder.
- **PR 2 hook**: every lease records `workspace_id`, `session_id`, `run_id`;
  `browserUsage()` (browser-pool.ts) returns per machine and workspace the live leases and the
  lease-milliseconds since boot. Budgets can count browser use against a workspace's share from it;
  nothing here depends on PR 2.

**Hosts** (built, mirrors the heavy slots). An `mc browser` on a host reaches the brain through the
host's forwarder; the brain keys the lease to the forwarding host's pool (`forwardedHost`, gated by
`forwardedGate` as every forwarded call). That pool drives the HOST's own `ChromeEngine` over the
`browser` rpc (`open` / `close` / `touch` / `status`, `RemoteHost.browserRpc`); the browser, its proxy
and its TTL live in hostd, so the endpoint an agent gets is on its own machine's loopback. The host's
caps come from its own RAM and `CHRONOS_BROWSER_*` in `~/.chronos-host/.secrets`, reported with every
reply (2 / 1 until the first one). Not built: leasing while the brain is away (the forwarder answers
503, as for every non-queued call; `mc browser run` exits with that error) — the host would need its
own pool and a local auth story first. A host older than this PR answers "unknown rpc op browser".

**Known limits.**

- **A browser crash ends every lease on that machine** (one process for all of them); their next
  heartbeat 404s and the next `mc browser run` starts a fresh browser.
- Downloads never work through a lease (always denied — they would write to the daemon's disk).
- **Later, not a dependency:** evaluate Lightpanda as the pool's engine (its claims are unverified).
- **Out of scope:** the per-client logged-in agent Chromes (ports 9222-9225 via chrome-lazy-mcp — they
  hold Google Workspace logins per client and stay as they are). Cloudflare remote Browser Rendering
  bindings are dropped (Leo's decision).

### Browser knobs

| Env | Default | Meaning |
|---|---|---|
| `CHRONOS_BROWSER` | `on` | `off` = no leases on this machine (503). Nothing starts until a lease either way. |
| `CHRONOS_BROWSER_PATH` | — | Explicit engine executable. Refused under `/Applications/Google Chrome.app/` or the real Chrome profile. |
| `CHRONOS_BROWSER_IDLE_MS` | `600000` | Stop the browser this long after its last lease ended (min 1000). |
| `CHRONOS_BROWSER_MAX_CONTEXTS` | 1 per 2 GB RAM, 1..8 | Concurrent leases on this machine. |
| `CHRONOS_BROWSER_MAX_PER_WS` | `ceil(cap / 2)` | A workspace's fair share; past it, granted only while no other workspace waits. |
| `CHRONOS_BROWSER_AUTO_INSTALL` | off | `1` = with no engine found, run the install line once (`npx`, 5 min cap). |
| `CHRONOS_BROWSER_DATA_DIR` | `<state>/.browser-pool` | Where the throwaway profile lives (brain; hostd uses `~/.chronos-host/browser-pool`). |
| `PUPPETEER_CACHE_DIR` | `~/.cache/puppeteer` | Also searched for engines. |

## Out of scope

- Changing `~/.claude/bin/idle-reaper.py` (personal, not Chronos).
- Reaping anything Chronos did not spawn: Leo's own shells, apps, his real Chrome, Robert's own
  manager processes (not roots), or processes that predate the daemon's last start.
- Persisting the ledger across daemon restarts.
- Env-var (`MC_SESSION`) tagging — proven useless for the leak that motivated this.
- Per-process cgroup-style hard limits (macOS has none worth using; the ladder is the substitute).
