# CLAUDE.md — Contributing to Chronos

Rules for any agent (or human) editing this codebase. These are hard-won: every one of them
comes from a real shipped bug or a destroyed checkout. Read before writing code.

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
  `npm test` (~20s, in-memory DB). Watch for accidental reverts of files you didn't touch.
- **Deploy = `npm run deploy` only** (build + restart). launchd runs `dist/`, so editing
  `src/` without deploying changes nothing. Check the fleet is idle first:
  `curl -s localhost:7777/api/agents/rollup`.
- Kill a run with `POST /runs/:id/kill` (`/stop` does not exist).

## Architecture entry points

- `ARCHITECTURE.md` — system overview. `LEADS.md` — Leads: role=lead terminals that drive their own workers. `HOSTS.md` — multi-computer design (brain + hosts; phase 1 seam in `src/hosts/`, the rest not built yet). `MISSION-CONTROL.md` §5b — worker visibility/HITL layer
  (steps, asks, mailbox, stall detection).
- Dispatch chain: `src/tickets.ts` (goal templates) → `src/dispatcher.ts` → `src/runner.ts`
  (spawn, watchdog, park) → `src/asks.ts` (HITL park & resume).
- Store modules in `src/store/*`; schema changes are numbered migrations in `src/store.ts`.
- **Touching a goal template in `src/tickets.ts`?** `evals/` replays real tickets through the real
  dispatch path and asserts what the agent is told (progress protocol, ask, handoff sections, repo
  Definition of Done, every rework round in order). It runs as the tail of `npm test`; see
  `evals/README.md`. A lost section does not throw — this is the only thing that catches it.
