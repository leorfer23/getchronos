# Resources — who holds what on this Mac, and what happens when it is too much

Workspace resource governance, in three PRs. This file is the design for all three; PR 1 (the
ownership ledger + leak reaper) is what is built. Code: `src/resources/` (`ledger.ts`, `reaper.ts`,
`brain.ts`), wired from `src/index.ts`, `src/hostd/index.ts` and `GET /api/machine`.

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
`CHRONOS_REAPER_KEEP` (one regex over argv). argv is read only for candidate targets, once per
process, batched in one `ps -o command -p`; a tick that cannot read it signals nothing.

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
link (so `GET /machine` can show a host's rollup) is PR 2, which needs it for budgets anyway.

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

## PR 2 — per-workspace budgets + the ladder (design)

On each machine, from the ledger's per-workspace rollup:

- **Active** workspace = owns at least one live (not ended) owner on that machine.
- **Weight** `w` per workspace (new column, default 1; set in the Spaces tab). **Share** =
  `w(ws) / Σ w(active)`. An idle workspace is not in the sum: its share is lent to the rest automatically.
- **Capacity** of the machine, minus a reserve for the OS, the daemon and the Desk:
  RAM `= total − max(3 GB, 20 %)`; CPU `= ncpu × 100 %`; heavy slots `= the machine's pool size`.
- **Budget**(ws) = share × capacity, per resource. Heavy slots: `max(1, floor(share × slots))`, so
  a lone workspace may hold every slot and two equal workspaces cannot both be starved.
- **Usage**(ws) = Σ RSS, Σ %CPU (median of the last 3 ticks, to ignore a compile spike), slots held.

The ladder runs only while the machine is **strained** (admission's own signals: memory pressure ≥
warning, or load/core over `CHRONOS_MAX_LOAD_PER_CORE`) — over budget on a calm Mac costs nobody anything:

1. **Warn** — over budget: one message to each of the workspace's live terminals (the `mc` mailbox)
   and a Desk card, naming the heaviest processes. Re-sent at most every 10 min.
2. **Slow** — still over after 2 min: renice the workspace's heaviest owned subtrees to 20 (they start
   at `CHRONOS_AGENT_NICE` 10). Undone when back under budget.
3. **Pause** — still over, and pressure critical: SIGSTOP the workspace's **newest heavy process**
   (leak family / test runner / build tool; never a CLI root, never a pty), one per tick, SIGCONT
   oldest-first when back under budget or the machine is calm. A paused process is on the Desk card.

Hosts: a `procs` link frame carries the host's rollup; the same formula runs on the host against its
own capacity, and hostd applies the ladder locally (it already freezes with SIGSTOP for the fence).

## PR 3 — agent tools + efficiency ledger (design)

- **`mc budget`**: the caller's workspace share, budget, usage and ladder rung on its machine, plus its
  own terminal's processes — so an agent can see *it* is the problem before the ladder says so.
- **Prompt rules** (`agents/_blocks/`): test with `mc heavy`, never background a browser, close dev
  servers you started, check `mc budget` before a second suite.
- **Efficiency ledger** on the Desk: per workspace and per terminal, over time — peak/avg RSS, CPU-time,
  slot-minutes, processes reaped (from `proc.reaped` in the activity table) and ladder actions, next to
  what the work shipped. "Which workspace leaks" becomes a number.

### Shared headless browser pool

The incident's root cause was every test run launching its own Chrome. PR 3 removes the reason to:

- **One lightweight headless browser per machine** (brain and each host) — `chrome-headless-shell`
  preferred over full Chrome for Testing — started on demand, stopped when idle. Owned by the daemon
  (or hostd), so the ledger attributes it to nobody's terminal and the reaper never touches it.
- **`mc browser` (lease)** hands an agent a CDP endpoint plus a **fresh browser context**, never its
  own Chrome. Chronos owns the lifetime: the context closes on release, when the lease's heartbeat
  expires, or when the session ends. Usage counts against the workspace's share (PR 2).
- **Prompt rules, in order:** don't start a browser if you can avoid it (fetch the page directly;
  happy-dom / jsdom / linkedom in tests; mock `env.BROWSER`). Need real rendering → `mc browser`.
  Never launch your own Chrome or Puppeteer instance.
- **Out of scope:** the per-client logged-in agent Chromes (ports 9222-9225 via chrome-lazy-mcp — they
  hold Google Workspace logins per client and stay as they are). Cloudflare remote Browser Rendering
  bindings are dropped (Leo's decision).
- **Later, not a dependency:** evaluate Lightpanda as the pool's engine (its claims are unverified).

## Out of scope

- Changing `~/.claude/bin/idle-reaper.py` (personal, not Chronos).
- Reaping anything Chronos did not spawn: Leo's own shells, apps, his real Chrome, Robert's own
  manager processes (not roots), or processes that predate the daemon's last start.
- Persisting the ledger across daemon restarts.
- Env-var (`MC_SESSION`) tagging — proven useless for the leak that motivated this.
- Per-process cgroup-style hard limits (macOS has none worth using; the ladder is the substitute).
