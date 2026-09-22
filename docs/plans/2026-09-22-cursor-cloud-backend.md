# Plan: Cursor Cloud Agents as a Chronos backend (`cursor-cloud`)

Status: approved by Leo 2026-09-22 · PoC green · owner: agent picking this up
PoC: `~/Documents/chronos-cloud-poc/poc.mjs` (launch → SSE → reconcile → PR) against https://github.com/leorfer23/chronos-cloud-poc/pull/1

## Goal

Chronos jobs and Desk terminals can run on Cursor Cloud Agents (Cursor-hosted VMs) instead of a local process.
Two entry points:

1. **Manual** — operator (or Robert) opens a "cloud" terminal from the Desk for a ticket/goal.
2. **Job** — dispatcher sends a job to the cloud; Chronos records events, result, PR and cost exactly like a local run.

Constraint from Leo: **no self-hosted compute** (no VPS, no Cloudflare workers/containers). Only what the provider hosts.
Phase 1 scope: **GitHub repos with `delivery=pr`, code-only work, no secrets, no MCPs.** Access/secrets/MCP come later.

## The model: launch, sleep, reconcile

A cloud run is not a child process. Chronos **launches**, stores the ids, and **reconciles** whenever it is alive.
The Mac may sleep or be off while the agent works; nothing is lost because Cursor keeps the run state and a
24 h replayable event stream. What does NOT work while Chronos is down: **triggering** (cron is local) and **steering**
(`mc tell` waits until the daemon is back; Cursor accepts it as a new run then).

Verified facts (PoC 2026-09-22, API v1, https://cursor.com/docs/cloud-agent/api/endpoints):

| Fact | Value |
|---|---|
| Launch | `POST https://api.cursor.com/v1/agents` → `{agent:{id:"bc-…",url,latestRunId}, run:{id:"run-…",status}}` |
| Auth | `Authorization: Bearer $CURSOR_API_KEY` (user key `crsr_…`; already in `mc vars` for Personal + Chronos workspaces) |
| Stream | `GET /v1/agents/{id}/runs/{runId}/stream` SSE, events `status\|thinking\|assistant\|tool_call\|interaction_update\|result\|error\|done`; `Last-Event-ID` resumes; `X-Cursor-Stream-Retention-Seconds: 86400` |
| Poll | `GET /v1/agents/{id}/runs/{runId}` → `status RUNNING\|FINISHED\|ERROR\|CANCELLED\|EXPIRED`, `result` (final text), `durationMs`, `git.branches[{repoUrl,branch,prUrl}]` |
| Usage | `GET /v1/agents/{id}/usage?runId=` → exact tokens + `cost.chargedCents` (vendor total, not an estimate) |
| Steer | `POST /v1/agents/{id}/runs {prompt:{text}}` → new run; `409 agent_busy` while one is active |
| Stop | `POST /v1/agents/{id}/runs/{runId}/cancel` |
| Repos | `GET /v1/repositories` (1 req/min); repo must be reachable by the Cursor GitHub App (Galley org: yes, 501 repos; Medialab: not installed; personal: per-repo) |
| Limits | 20 req/min per user; one active run per agent; launch can return `429 resource_exhausted … GitHub rate limited, retryAfter 60` right after a repo is added to the app → retryable |
| Idempotency | `agentId: "bc-<uuid>"` in the create body; `409 agent_id_conflict` on reuse |
| Output | draft PR on branch `cursor/<name>-<n>`, commits signed by Cursor; PoC run: 52.6 s, 2.48 ¢ |

## Mapping Chronos → Cursor

| Chronos | Cursor create body |
|---|---|
| `job.goal` + `job.append_system` + trigger `context` + `repo.done_criteria` + `repo.gate_cmds` (as "run these before you finish") | `prompt.text` — Cursor has no system prompt; fold like `src/backends/cursor.ts buildArgs` already does |
| `repo.git_remote` (normalised to `https://github.com/owner/repo`), `repo.default_branch` | `repos[0] = {url, startingRef}`; `job.add_dirs` that resolve to repos with a GitHub remote → extra `repos[]` (≤20) |
| `repo.delivery === "pr"` | `autoCreatePR: true`, `workOnCurrentBranch: false` (Phase 1 refuses `delivery=commit`) |
| `job.model` | `model.id` from `GET /v1/models` (`auto`/null → omit). Validate against the catalog in `validateSpawnTarget` |
| `run.id` | `agentId: "bc-" + run.id` when `run.id` is a UUID, else a stored fresh uuid — a retried dispatch must not launch twice |
| `job.name` / `ticket.key` | `name` (≤100 chars) |
| `mc tell` / `POST /runs/:id/steer` | `POST /v1/agents/{id}/runs` |
| `mc stop` / run cancel | `POST …/cancel` |
| `job.timeout_sec` | client-side: reconcile marks `timeout` and cancels when exceeded |
| `job.max_budget_usd` | client-side after `usage`: over budget → flag on the run, no further follow-ups |

## Data model

`runs` gains (migration in `src/store/migrate.ts`):

- `cloud_agent_id TEXT` — `bc-…`
- `cloud_run_id TEXT` — `run-…` of the run this row tracks (a steer creates a new one; keep the latest here, log each in `run_events`)
- `cloud_url TEXT` — `https://cursor.com/agents/<id>` (Desk link)
- `cloud_last_event_id TEXT` — SSE cursor for replay on wake

`pid` stays null for cloud runs. `sessions` (Desk terminals) gets the same four columns so a cloud terminal card can show the link and state without a pty.

## Runner changes (`src/runner.ts`)

`execute()` today: `spawn` at ~L367, `parseLine`/`extractResult` per stdout line at ~L435-451, finalisation at ~L607. Add a branch **before the spawn**: if `backend.kind === "cloud"`, hand off to `executeCloud(job, runId)`:

1. **Launch** with retry on 429 (`retryAfter` header/body, cap 3 tries, 60 s apart). Persist `cloud_*` columns + `status: running`; publish `run.started`.
2. **Attach** the SSE stream. Map each event to a `NormalizedEvent` and store via the existing `run_events` path so Focus/Desk render it unchanged:
   - `assistant`/`thinking` deltas → concatenate; emit as `assistant` text events (throttle to one row per ~1 s or per `interaction_update: text-completed`, not one row per token)
   - `tool_call` → `tool_use` event
   - `status` → `run.step` bus event
   - `result`/`done` → finalise
   - persist `id:` of each SSE frame into `cloud_last_event_id` (batched, not per frame)
3. **Finalise** = one `GET runs/{runId}` + one `GET usage?runId=`: `summary`/`result_text` ← `result`, tokens ← usage, `cost_usd` ← `chargedCents/100` with `cost_estimated = 0`, `ticket.pr_url` ← `git.branches[].prUrl` (first with a PR), `status` ← `FINISHED→ok`, `ERROR→failed`, `CANCELLED→stopped`, `EXPIRED→timeout`. Then the **same** post-run path as today (verifier, review queueing, `run.ended`), so merge-gate/review/verifier don't know it was cloud.
4. **Verifier & gates**: Phase 1 runs them locally by `git fetch origin cursor/<branch>` into a worktree (existing `worktrees.ts`), so evidence gates keep working. Phase 2 may run gates inside the cloud VM via `.cursor/environment.json`.

Stream disconnect (Mac sleeps, network drops) is **not** a failure: mark nothing, let the reconciler pick it up.

## Reconciler (new `src/cloud-reconcile.ts`)

- Runs at daemon boot and every **60 s while any run has `backend=cursor-cloud AND status=running`** (nothing to do → no timer).
- Per run: `GET runs/{runId}` (1 call). If still `RUNNING` and no stream attached → re-attach the stream from `cloud_last_event_id`. If terminal → finalise exactly as step 3 above. Older than `job.timeout_sec` → cancel + `timeout`.
- Budget the calls: ≤ 20 req/min total across all runs; back off on 429.
- Pending `mc tell` messages sent while the daemon was down are not queued by Chronos in Phase 1 (they fail fast with a clear "cloud run, daemon was down" message). Phase 2: queue them in `run_events` and flush on reconcile.

## Backend module (`src/backends/cursor-cloud.ts`)

Implements `AgentBackend` (`src/backends/types.ts`) with:

- `name: "cursor-cloud"`, `kind: "cloud"` (new optional field on the interface; local backends leave it undefined), `supportsHeadless: true`, `supportsResume: true` (resume = follow-up on the same agent), `pinsSession: true`, `appendsSystem: false`, `capabilities: {}` (no tool allowlist, no MCP in Phase 1)
- `models` from `GET /v1/models` cached 1 h (39 ids on 2026-09-22, e.g. `claude-fable-5-1`, `claude-opus-5`, `composer-2.5`, `gpt-5.6-sol`)
- `buildArgs`/`oneShot`/`interactiveArgs`: throw "cloud backend has no local process" — the runner must branch before calling them
- New methods used by `executeCloud`/reconciler: `launch(job, runId, context)`, `stream(agentId, runId, lastEventId)`, `getRun`, `usage`, `followup`, `cancel`, `parseSse(frame)`
- `checkAuth()` = `GET /v1/me`; `env()` reads `CURSOR_API_KEY` from `workspaceVars.active(ws)` first (already there for Personal + Chronos), then daemon env
- Register in `src/backends/index.ts` REGISTRY; `listBackends()` exposes `kind` so the Desk picker can label it ☁
- `validateSpawnTarget`: for `cursor-cloud`, also refuse when the job's repo has no GitHub remote or `delivery !== "pr"`, with a message naming the repo
- Quota gate (`src/quota-gate.ts`): treat `cursor-cloud` like `cursor-agent` for credit walls; the only new signal is the 429 on launch

## Desk / Robert

- Spawn dialog and `mc ticket new --backend`: `cursor-cloud` appears in the backend list with a ☁ badge; disabled with a tooltip when the workspace's repo has no GitHub remote or the Cursor app can't see it (`GET /v1/repositories`, cached 10 min because of its 1 req/min limit)
- Terminal card for a cloud run: no pty; shows state from `runs`, a link to `cloud_url`, the PR link when it lands, and a composer that maps to follow-up
- Fleet/companion: cloud runs show as normal rows; `mc state/progress` derive from the SSE `status`/`tool_call` events
- Robert: may pick `cursor-cloud` for tickets in workspaces whose `backends` allow it; it must say "cloud" in the wake line. No cron changes (heartbeats stay off).

## Rollout

1. PR 1 — backend module + `kind` + registry + migration + `validateSpawnTarget` rules. Unit tests with a mocked `fetch` (launch, 429 retry, SSE parse incl. resume, finalise mapping). No runner wiring yet.
2. PR 2 — `executeCloud` in the runner + reconciler + `run.ended` parity. Test with the mock: sleep-mid-stream → reconcile finishes the run.
3. PR 3 — Desk picker/card/link + `mc tell`/stop mapping + Robert allow-list. Smoke on the Chronos workspace against `chronos-cloud-poc`.
4. Phase 2 (separate plan): secrets via Cursor Dashboard env-scoped secrets + `envVars` (beta), MCP servers, gates inside the VM via `.cursor/environment.json`, Medialab once an owner installs the Cursor GitHub App on `medialab-ai`, and a Claude-cloud path (`claude --cloud` terminals + Routines) whose completion signal is a GitHub PR watcher.

## Non-goals (Phase 1)

- Self-hosted workers (`agent worker`) — they are compute we host
- Webhooks — v0-only and need a public endpoint we don't have; polling on wake replaces them
- `delivery=commit` repos, non-GitHub remotes, repos the Cursor app can't see
- Secrets, MCP, `envVars`

## Definition of done

- A ticket in the Chronos workspace built with `--backend cursor-cloud` ends with `runs.status=ok`, exact `cost_usd`, `ticket.pr_url` set, review queued — while the daemon was stopped for ≥ 2 min mid-run and restarted.
- `mc tell` on that run creates a follow-up run and its events appear in Focus.
- `npm test` green; new tests never hit the network.
