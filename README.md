# Chronos

A local daemon that runs AI coding agents unattended, and supervises them like a team.

You give it a project, a repo, and a ticket. It picks a model, opens a git worktree, spawns an agent
CLI headless, watches the transcript for signs it has stalled, lets it stop and ask you a question,
reviews the diff, opens the PR, and tells you what happened. Everything is a SQLite row on your own
machine and every agent process is a child of one Node daemon you can `kill`.

It drives whichever CLI you already pay for — **Claude Code, Codex, Cursor, Grok, opencode** — behind
one interface, so a cheap model can grade a ticket and an expensive one can build it.

> **What this is not.** It is not a hosted service, a CI system, or a product with a support
> contract. It was built for one operator on one always-on Mac, it is opinionated, and parts of it
> only make sense once you have watched an agent do something stupid at 3am. It is open because the
> patterns are worth stealing.

---

## Quickstart

Requires Node 22+, macOS (the sandbox is Seatbelt), and at least one agent CLI installed and logged
in.

```bash
git clone https://github.com/leorfer23/getchronos.git && cd getchronos
npm ci
npm start
```

Open <http://localhost:7777/desk>. That is the whole install: no configuration file, no database to
create, no account. The daemon boots with an empty environment and tells you which optional
features are off and how to turn them on.

**Then read [CONFIGURATION.md § the five minutes that matter](./CONFIGURATION.md).** Three defaults
are worth a decision before you point this at a repo you care about: spend is uncapped, the merge
gate can land its own PRs, and the daemon can redeploy itself.

To run it for real, on boot and across crashes:

```bash
npm run install:launchd          # renders launchd/*.plist.template for this machine and loads it
npm run install:launchd -- --all # also the overlay + local whisper, skipping whatever isn't installed
```

The plists are generated rather than committed, because a committed one hardcodes another machine's
home directory, checkout path and node binary. The installer records the **absolute path of the node
that ran it**, so the daemon always uses the runtime `node_modules` was built against —
`better-sqlite3` is native and aborts on a major-version mismatch. Re-run it after changing node
version or moving the checkout.

---

## The shape of it

**A project** (`workspace` in the schema and API) is whatever you want it to be: one repo, a product
across several repos, a client, or a side project. It is the unit of isolation — its own tickets,
memory, budget, sandbox rules, credentials, and its own account.

**A repo** belongs to a project and carries its delivery rules: default branch, whether work ships
as a PR or a direct push, its Definition of Done, the commands that must pass before review.

**A ticket** is a commitment. It has a key (`API-14`), a lifecycle, and a file on disk that is the
thing an agent actually reads. Tickets can mirror to Jira or ClickUp.

**A run** is one agent process working one stage of one ticket. Plan, build, review, grade, CI-fix
and merge-gate are all runs; they differ in the prompt, the tools they are allowed, and whether they
may write anything at all.

**A terminal** is the other half. Not everything should be headless — a live PTY on the Desk is the
same agent with you watching, and a headless run can be interrupted into one mid-flight
(`POST /api/runs/:id/continue`) without losing its context.

---

## What is actually interesting here

Most of this exists because something went wrong once. These are the parts worth reading even if you
never run the daemon.

### Agents cannot read the credentials they use

An agent that can read a token can leak it. So the sandbox denies the credential outright, and the
daemon makes the authenticated call on the agent's behalf — either through an explicit broker
endpoint, or **transparently**: the project's egress proxy terminates TLS with a local CA, injects
the header, and re-originates a verified connection upstream. `git push` and plain `curl` work; the
token never enters the sandbox. The CA is never installed in the system keychain, only handed to the
daemon's own children, and both its private keys are in the sandbox deny list.

`src/egress.ts`, `src/egress-mitm.ts`, `src/egress-ca.ts`, `src/broker.ts`

### One worktree per agent

Two agents in one checkout is data loss with extra steps. Every ticket build gets its own git
worktree, created and cleaned up by the daemon, so parallel work cannot fight over a branch or a
dirty tree.

`src/worktrees.ts`

### A stalled agent files a card; it does not retry

Nothing here retries on its own. When a run stops emitting progress, the supervisor kills it and
files an approval card — you decide. That is a deliberate refusal of the obvious feature: an
automatic retry on a run that failed for a real reason is just the same failure again, twice as
expensive, and you find out in the morning.

`src/monitor.ts`, `src/recovery.ts`

### An agent can stop and ask

`mc ask` parks a run on a human question instead of guessing. The question goes to the coordinator
first, who answers it if it is derivable from the project's own memos and escalates to your phone if
it is not. Read-only runs never park — a planner that waits is a slot held for nothing.

`src/asks.ts`, `src/ask-robert.ts`

### The prompt is asserted, not assumed

What an agent is told is assembled from a dozen sources, and deleting a section fails **silently** —
it looks like the model getting worse. `evals/` replays fixture tickets through the real dispatch
path and asserts the standing protocol survived: the progress instructions, the ask, the handoff
template, the repo's Definition of Done, every rework round in order.

`evals/`

### Every rework round, oldest first

A ticket once oscillated for three rounds because the builder was only ever shown the latest
reviewer verdict, and each fix re-broke what an earlier round demanded. Reviews are now fed in full,
in order, with an explicit instruction to satisfy all of them at once.

`src/tickets.ts`, `evals/cases/rework.json`

### Memory that is a file you can read

Each project has memos: a standing brief you write, and a learnings file the agents append to. They
are rows in SQLite, mirrored one-way to `notes/<project>/*.md` so you can grep and diff them. The
daemon compacts them when they grow and injects the relevant parts by FTS relevance rather than
pasting everything into every prompt.

`src/notes.ts`, `src/recall.ts`, `src/hygiene.ts`, `src/lessons.ts`

### One account per project

A profile is a CLI config directory — its own login, settings, skills and MCP servers. A project
pins one, and that pin beats every default, so one client's work is never billed to another's
account or handed another's tools. Profiles are discovered: every `~/.claude-<name>` directory is
offered under that name.

`src/config.ts`, [CONFIGURATION.md](./CONFIGURATION.md)

---

## Surfaces

| | |
|---|---|
| **Desk** (`/desk`) | the main one — live terminals as a wall of cards, each a real PTY |
| **Phone** (`/phone`) | a PWA behind your own authenticating tunnel; triage from bed |
| **Overlay** (`/overlay.html`) | a small always-on-top native panel, see `desktop/README.md` |
| **Telegram** | control + notifications with no inbound port, via long-polling |
| **`mc` CLI** | what agents themselves use: `mc steps`, `mc ask`, `mc review`, `mc learn` |
| **REST + WebSocket** | everything above is a client of this |

The Telegram bot is off until `CHRONOS_TG_TOKEN` is set. `relay/` is an optional Cloudflare Worker
that gives you remote triggers without opening a port — the daemon dials **out** to it.

---

## Backends

| backend | binary | notes |
|---|---|---|
| `claude-code` | `claude` | default; the richest transcript stream |
| `codex` | `codex` | |
| `cursor-agent` | `cursor-agent` | |
| `grok` | `grok` | also the default rate-limit fallback |
| `opencode` | `opencode` | gateway to whatever it is configured with |
| `openai-api` | — | the API directly, no CLI |
| `mock` | — | a scripted stand-in (`node -e`, zero tokens) that drives the real dispatch path in tests |

Adding one is a module in `src/backends/` and a line in its registry.

Chronos drives each CLI's own binary, so you bring your own auth for each. A project declares which
backends it may use, and `CHRONOS_ROUTE_MODELS` maps a ticket's graded difficulty to a
`backend:model` — so a trivial ticket does not get an expensive model just because it was filed
first.

---

## Guardrails, honestly

Jobs run with `--dangerously-skip-permissions`. That is what unattended autonomy means, and
everything below exists to bound it.

**Sandbox** (per job: `off` / `guard` / `strict`). `guard` is the default: the job's own `cwd` is
granted, secrets and other project directories are denied, kernel-enforced via Seatbelt and
inherited by every subprocess the agent spawns. `strict` adds write-confinement and a network
lockdown. **This is macOS-only** — on any other platform jobs run unsandboxed and the daemon does
not pretend otherwise.

Sibling-project isolation **has no portable default**: checkout locations differ per machine, so
until you set `CHRONOS_PROTECTED_DIRS_EXTRA` an agent in one project can read another's files. The
daemon warns about this at every boot.

**Also enforced:** wall-clock timeout per run, per-run budget, daily budget, concurrency cap, and
the burn guard — which halts the fleet on runs/hour and $/hour, because a runaway can spend a whole
day's budget in four minutes and a total-only cap notices too late.

**Advisory, not a boundary:** `allowed_tools` under skip-permissions, and the prompt-injection guard
that redacts patterns in text arriving from outside the system. Treat anything an agent reads from a
tracker, an issue, or the web as untrusted input.

`sandbox-exec` is Apple-deprecated. It still works, and Chronos falls back to `off` if it is ever
removed — loudly.

See [SECURITY.md](./SECURITY.md) for the threat model and how to report a problem.

---

## Documentation

| | |
|---|---|
| [CONFIGURATION.md](./CONFIGURATION.md) | every environment variable, grouped, with defaults |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | the design: execution model, data model, API, relay |
| [MISSION-CONTROL.md](./MISSION-CONTROL.md) | tickets, reviews, the board, worker visibility and HITL |
| [CLAUDE.md](./CLAUDE.md) | the gotchas — read before changing code |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | how to work on it |
| [SECURITY.md](./SECURITY.md) | threat model, reporting |
| `agents/README.md` | how an executive is defined |
| `notes/example/README.md` | the three memos and what belongs in each |
| `relay/README.md`, `desktop/README.md` | the optional pieces |

## Licence

Apache 2.0. See [LICENSE](./LICENSE).
