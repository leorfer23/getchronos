# CLAUDE.md — Contributing to Chronos

Rules for any agent (or human) editing this codebase. These are hard-won: every one of them
comes from a real shipped bug or a destroyed checkout. Read before writing code.

## Agent quickstart — where things are

- **Worktree:** `git -C ~/chronos fetch origin && git -C ~/chronos worktree add ~/.chronos-worktrees/chronos/<slug> -b <branch> origin/main --no-track`,
  then `npm ci` in it (there is no `ui/` dir any more — one install covers everything). `git push -u origin <branch>` when you
  push. `gh pr merge --delete-branch` trips over `main` being checked out in `~/chronos`; delete the remote branch by hand
  (`git push origin --delete <branch>`).
- **Shell:** zsh with `nomatch` — quote globs (`--include='*.ts'`) or use `git grep` / `rg`. A plain `grep -r` in `~/chronos`
  also walks nested worktrees under `.claude/worktrees/` — exclude them. macOS has no `timeout` binary.
- **Search tools** (cheaper than grep + sed paging): the **fff** MCP (`grep` / `find_files` / `multi_grep`), registered in every
  profile by `src/efficiency-tools.ts` — it searches the session's cwd, so start in `~/chronos` or a worktree, not `~`.
  **graphify** `query "<question>"` / `explain "<symbol>"` / `path "A" "B"` over the AST graph (`graphify update ~/chronos`
  rebuilds it, no LLM; from a worktree pass `--graph ~/chronos/graphify-out/graph.json`). **ast-grep** (`sg -p '<pattern>' -l ts src`)
  for structural matches such as call sites. RTK compresses Bash output on its own when installed.
- **`mc` CLI:** one file, `scripts/mc`; `installMcCli` (`src/agent-prep.ts`) copies it to `~/.mc/bin/mc`. Commands are
  `if (cmd === "...")` blocks — `rg -n 'cmd === "artifact"' scripts/mc`.
- **DB:** `~/chronos/chronos.db` (`CHRONOS_DB` overrides). Inspect with `sqlite3 -readonly`. Sessions use `created_at` / `ended_at`.
- **Tokens:** `~/chronos/.admin-token` (or `CHRONOS_ADMIN_TOKEN`) → header `x-mc-admin`; a workspace's own token
  (`MC_WORKSPACE_TOKEN` in agent env) → `x-mc-workspace-token`; a Lead's → `x-mc-lead`. Admin-gated routes use `requireAdmin`
  in `src/api.ts`. `curl -s -H "x-mc-admin: $(cat ~/chronos/.admin-token)" localhost:7777/api/hosts`. Sandboxed agents cannot read
  `.admin-token` — print the command for the operator instead.
- **Routes:** nearly all (~313) REST routes are registered in `src/api.ts` as `api.get/post/patch/put/delete("/…"` (mounted at `/api`);
  find one with `git grep -n 'api\.\(get\|post\|patch\|put\|delete\)("/<prefix>' src/api.ts`. Host routes
  (`/hosts/*`) live in `src/hostlink/brain-link.ts` (+ `bar.ts`, `src/hosts/brief.ts`). The Desk UI is `static/desk.html` +
  `static/*.js`, served by `express.static` — no build step.
- **Backends:** `src/backends/<name>.ts` builds each CLI's argv and env. `claude.ts`'s `env()` sets `CLAUDE_CODE_ARTIFACT=1` on
  every claude spawn (that is what gives headless `claude -p` jobs the claude.ai Artifact tool).
- **Modules nothing else points you to:** `src/machine.ts` (governor: nice, admission, `mc heavy` slots + per-workspace slot fairness) ·
  `src/resources/` (process ownership ledger + leak reaper; per-workspace budgets + the warn → slow → pause ladder in
  `budget.ts` / `ladder.ts`, sharing the reaper's guards via `guards.ts`; RESOURCES.md) ·
  `src/host-failover.ts` (offline host → its terminals reopen elsewhere) · `src/hostd/forwarder.ts` / `outbox.ts` / `spill.ts`
  (a host's loopback `mc` API, queued writes, evicted output) · `src/remote-runs.ts` + `src/hostd/procs.ts` (headless runs on
  hosts) · `src/memory-tree.ts` · `src/dream-pass.ts`. Three different "artifacts": `src/artifacts.ts` (`mc artifact` HTML
  pages), `src/session-artifacts.ts` (PRs/docs/pages pinned on a terminal's rail), and the claude.ai Artifact tool.
- **Tests:** `npm test` takes ~100s (~2.7k tests + evals) — run it in the background. Expected, not your diff: inside a
  sandboxed (guard) Desk terminal, `sandbox-exec: sandbox_apply: Operation not permitted` (nested sandbox);
  `src/brainbar-install.test.ts` fails when the worktree path contains `secret` or `token` (it scans the plist for them); if
  still red, `src/hostd/procs.test.ts` "a kill frame ends it…" on ubuntu CI.
- **Desk CSS:** `src/desk-companion.test.ts` bans literal hex colours and `animation`/`transition` in the companion's CSS
  block — use theme tokens (`var(--danger)`, `var(--p-work)`, …).
- **Merge ≠ deploy.** Never run `npm run deploy` unless the operator explicitly said deploy.

## Critical gotchas (each one shipped a real bug)

1. **`dispatch()` runs the executor SYNCHRONOUSLY.** `dispatch()` calls `pump()` which invokes
   `execute()` before `dispatch()` returns, and `execute()` reads run columns
   (`resume_session`, `context`) in its synchronous prologue. NEVER `runs.patch()` after
   `dispatch()` returns expecting the executor to see it — thread values through `dispatch()`
   params instead.
2. **Never write tests that call the real `execute()` with a real backend.** It cascades into
   review/verifier/notify side effects and hangs the suite for 8+ minutes. To cover executor
   paths end-to-end, use `backend: "mock"` (`src/backends/mock.ts` — scripted `node -e`
   stand-in driven by `!directives` in the goal, milliseconds per run; see `src/execute.test.ts`).
   Rules there: `sandbox: "off"` (honored because the npm-test env sets
   `CHRONOS_SANDBOX_DEFAULT=off` — without it `clampSandbox` silently clamps the request back up
   to the `guard` floor and every "unsandboxed" test run spawns through sandbox-exec), tmp-dir
   cwd, `retry_max: 0` (or a rate-limit reset beyond the resume cap) so no run leaves a live
   retry/resume timer keeping the event loop alive.
   For pure logic, still prefer helpers (`shouldPark`, `isReadOnlyRun`, formatters) or stubs.
3. **Read-only runs** (`plan:` / `review:` / `grade:` / `distill:` / `ideas:` / `intake:` / `dream:` — see
   `isReadOnlyRun`) must never park on an open ask and must never be re-dispatched when an ask
   is answered. Gate both paths.
4. **Workspace scoping is a security boundary.** Any endpoint that touches a run/ticket by id
   must verify it belongs to the caller's workspace (`checkScope` + explicit ws comparison).
   A missed check let one workspace drain another's mailbox.
5. **Ticket keys are global per prefix, not per workspace.** `wsPrefix("personal")` and
   `wsPrefix("permits")` both yield `PER`; the sequence max must be computed across ALL
   tickets with that prefix.
6. **An agent IS its directory: `agents/<id>/`.** Persona, model, tools, cwd, sandbox and env are
   declared in `agents/<id>/AGENT.md`; prose shared between agents lives once in `agents/_blocks/`
   and is pulled in with a `{{> name}}` line. `src/agent-defs.ts` loads it. Robert has two
   surfaces — `telegram.md` (propose-and-confirm, no admin token) and `web.md` (execute-directly) —
   and only his *process* wiring stays in `src/telegram/agent.ts`, because the desk runs one manager
   per workspace and Telegram one per chat. A board `@mention` wakes an executive only if its
   handle is in `EXEC_HANDLES` (`src/board.ts`). Persona files are re-read when their mtime moves, so
   a prompt edit lands on the next manager recycle **without** a rebuild — everything else in `src/`
   still needs `npm run deploy`.

## Workflow (non-negotiable)

- **Never edit this live checkout directly.** The daemon runs `git add -A` here and will
  commit your half-finished work. Always use a `git worktree` elsewhere.
- **In a worktree: `npm ci`. NEVER symlink `node_modules`** from the main checkout —
  `git worktree remove --force` follows the symlink and empties the live checkout's real
  `node_modules`.
- **Branch → PR → merge. Never commit to `main`.**
- **Before merging any PR:** read the full diff yourself (subagent tests being green is not
  evidence — every subagent PR to date had ≥1 real bug its tests missed) and rerun
  `npm test` (~100s, in-memory DB; run it in the background). Watch for accidental reverts of files you didn't touch.
- **Deploy = `npm run deploy` only** (build + restart). launchd runs `dist/`, so editing
  `src/` without deploying changes nothing. Check the fleet is idle first:
  `curl -s localhost:7777/api/agents/rollup`.
- Kill a run with `POST /runs/:id/kill` (`/stop` does not exist).

## Architecture entry points

- `ARCHITECTURE.md` — system overview. `LEADS.md` — Leads: role=lead terminals that drive their own workers. `HOSTS.md` — multi-computer design (brain + hosts; the seam in `src/hosts/`, link + host process in `src/hostlink/` + `src/hostd/`, remote terminals in `src/remote-terminals.ts`; placement in `src/hosts/placement.ts` + `candidates.ts`; headless runs on hosts in `src/remote-runs.ts` + `src/hostd/procs.ts`). `MISSION-CONTROL.md` §5b — worker visibility/HITL layer
  (steps, asks, mailbox, stall detection). `RESOURCES.md` — who owns every process (ledger), the leak reaper, and the
  per-workspace share-of-machine budgets/ladder (`src/resources/`).
- Dispatch chain: `src/tickets.ts` (goal templates) → `src/dispatcher.ts` → `src/runner.ts`
  (spawn, watchdog, park) → `src/asks.ts` (HITL park & resume).
- Store modules in `src/store/*`; schema changes are numbered migrations in `src/store/migrate.ts`
  (`src/store.ts` is only a re-export barrel).
- **Touching a goal template in `src/tickets.ts`?** `evals/` replays real tickets through the real
  dispatch path and asserts what the agent is told (progress protocol, ask, handoff sections, repo
  Definition of Done, every rework round in order). It runs as the tail of `npm test`; see
  `evals/README.md`. A lost section does not throw — this is the only thing that catches it.
