# The request ledger

> One durable record per thing the operator asked for: **what he said → where it went → what state it is
> in → what came back → what decision he owes.** Written by code at every entry point, moved by events
> the daemon already publishes, never by a model re-reading screens. It is the floor the coordinator,
> the verifier, the executor and the voice front stand on.
>
> Code: `src/ledger-model.ts` (pure: vocabulary, work types, roll-up, queue order, compact text) ·
> `src/store/requests.ts` (rows, migration 156) · `src/ledger.ts` (writers, sweep, decisions, read views) ·
> `src/ledger-routes.ts` (`/api/ledger`) · `mc ledger` (scripts/mc) · the executor: `src/executor.ts`,
> `src/store/executor.ts` (migration 159), `src/executor-routes.ts`, `mc executor`.

## The model

| Table | One row per | Holds |
|---|---|---|
| `requests` | thing asked for | his words verbatim · `via` (how it arrived) · `surface` · `turn_id` · work type (`kind`) · `prereqs` · derived `state` + `state_line` · `result_at` · `closed_at` · `parent_id` |
| `request_terminals` | (request, terminal) | `role` · `is_primary` · the window `[linked_at, until)` its hand-offs count in |
| `request_deliverables` | thing that came back | `kind` (pr · deploy · slack_draft · email_draft · artifact · dashboard · doc · answer) · `ref` (what it is) · `target_hash` (what it is *now*) · `state` |
| `request_decisions` | question put to him | `action` (merge · deploy · send · review · answer) · bound `target_hash` · `status` (open · held · decided · superseded) · `decision` (yes · no · later · change · answered) + his `words`, `decided_by`, `decided_at`, `hold_until`, `audio_ref` |
| `request_checks` | verifier check run | `name` · pass/fail/skip · `evidence[]` refs (+ meta: screen, viewport, side) · `target_hash` it ran against · `ran_by`, `ran_at` — written by the verifier (below) |
| `request_verifications` | verifier pass | why it ran (`trigger`) · the targets it judged (`target_key`) · `ready` · `reason` · `told` (one of the two rounds) · `round` (migration 158) |

- **A request fans out, a terminal carries on.** A request links to any number of terminals; a terminal can
  serve a later request too. Each terminal has at most one open *primary* link: the request that owns what
  it hands off. Hand-offs (`mc outcome`) are attributed by time — an outcome filed at `t` belongs to the
  primary link whose window holds `t`.
- **A workspace is a wall.** A request has one workspace (or none = the operator's own); it only ever links
  terminals of that workspace. A message to the whole shop gets one workspace-less row for what he said and
  one child row per project it reached (`parent_id`), so every project's row stays inside that project.
- **Work type = goal kind.** One vocabulary (`GOAL_KINDS`), set where it already is (the spawn dialog,
  `mc goal set --kind`); the request mirrors its primary terminal's kind unless the opener set it.
  `WORK` in `ledger-model.ts` says, per type, what done means, what it may produce, what it usually asks,
  and which evidence slots a verifier fills:

| kind | done means | decisions | evidence slots (required) |
|---|---|---|---|
| `pr` | PR open, tests green, nothing else broke | merge | tests · regression · pr_ready · matches_request |
| `ui` | PR + before/after shots per screen and width + a walkthrough | merge | tests · regression · shots · walkthrough · pr_ready · matches_request |
| `investigation` | an answer in the form asked for — a draft, a page, a dashboard | send · review | queries · crosscheck · assumptions |
| `qa` | a verdict with repro steps | review | exercised · repro_steps |
| `product` | live: merged, deployed, checked in production; bugs reproduced before, fixed after; replies as drafts | merge · deploy · send | tests · pr_ready · post_deploy · matches_request (+ repro_before · fixed_after for a bug) |
| `chat` | nothing to finish | — | — |

  `prereqs` holds what must hold before the work can run: today an analysis or QA request in a workspace
  with a VPN configured gets `vpn` (`mc vpn up` first).

## Where requests come from

| Entry | Seen as | `via` |
|---|---|---|
| His words to Robert (Desk, phone, bar, voice) | `agent.asked` (turn id, words, surface, `voice`) — the row is written when that turn opens or steers a terminal | `voice` / `typed` |
| Robert opens a terminal in that turn | `session.started`, created_by `robert`, while that workspace's Robert is on the turn | (the turn's) |
| Robert types his words into a terminal | `session.input` by `robert`, same turn test (see *Steers*) | (the turn's) |
| Robert opens one on his own (a wake, a self-wake) | the turn running is not an operator turn — one row per turn, in Robert's words | `robert` |
| A terminal opened by hand (Desk, phone, his shell, a launch, Plan tomorrow) | `session.started`, created_by `operator`; words = goal as typed + his dialog brief | `hand` |
| Capture, inbox, job-check, proactive, follow-up | `session.started` by `created_by` | `capture` · `inbox` · `job-check` · `robert` · `follow-up` |
| A Lead's worker | `session.started` with `lead_id` — joins its Lead's request | — |
| Failover / host-failover / continuation stand-ins | `session.failover` · `session.host_failover` · `continuation.fired` — links move to the stand-in, the old window closes | — |
| Anything live and unknown (a ship terminal, a handoff, a missed event) | the sweep adopts it after a 2-minute grace | from `created_by` |
| Live when the ledger first started | the boot sweep backfills it (goal as words) | `backfill` |

**The turn test needs nothing from the model.** A workspace runs more than one Robert at once — his conversation
(the operator lane) and the daemon's wakes (the wake lane: wakes, ask triage, desk watches) — on separate
processes with the same credential, so a terminal they open or a line they type says nothing about which turn
sent it. What does: every tool call a turn makes is announced before it runs (`agent.step`), and
`robert-steps.ts terminalMove` reads the announcement back — `mc session new --goal "…"` says the goal,
`mc session send <id> "…"` / `mc session key <id> …` / `POST /sessions/<id>/input` name the terminal and the
words. The ledger keeps every turn at work per workspace (its lane: operator if `agent.asked` named it, else
wake; its announcements; which came back — `tool_done`, known for the operator lane) and matches each
open/keystroke to the announcement that describes it (`ledger-model.ts pickTurn`):

| tier | evidence | `attribution` |
|---|---|---|
| 0 | an unspent, in-flight announcement that names it — the goal; the terminal typed into, its words | `exact` |
| 1–2 | an announcement of that kind of move that names nothing (a raw POST), or another goal | `step` |
| 3–4 | no announcement: the turns with a call in flight, else whoever moved last | `recent` |

One candidate at the best tier is the answer. Several: the oldest announcement (an earlier call lands first);
within a second of each other, or with no announcement at all, **the operator's turn** — losing his words is the
costlier error — and the link is marked `ambiguous` (`GET /api/ledger?ambiguous=1`, `mc ledger --ambiguous`).
An ambiguous keystroke never moves who owns a terminal's hand-offs: it only rides along as a steer. A spent
announcement accounts for one terminal; one older than 2 minutes (a refused open) is not evidence. A turn is
over when its `agent.push` names it, or after 3 minutes without a move. The seam: when the API knows the caller's
turn or lane (a lane-tagged credential per Robert process — planned), it puts `turn` / `lane` on
`session.started` / `session.input` and nothing is guessed (`attribution: caller`). The voice front can open a
request first and `bindTurn(turn, request)` so what a project Robert opens in that turn joins it.

**Steers.** Robert typing the operator's words into a terminal that is still working on its own request is an
adjustment: the new request rides along as a secondary link and closes once the terminal hands off (its result
belongs to the terminal's own request). Typed into a terminal that already handed its request off, the words are
new work: the new request takes the terminal over and the old window closes. Robert typing during a turn of his
own (answering a prompt) is driving existing work and writes nothing.

## States

Five, most urgent first. A request's state is the most urgent of its parts (`rollUp`):

| state | means |
|---|---|
| `needs_operator` | a decision item is open, or a terminal serving it asks him (`decide`) or is `blocked` |
| `stuck` | a terminal `stalled`, stopped (`your_turn`) or ended without a hand-off; or nothing picked it up within 10 minutes |
| `working` | a terminal is `working` / `waiting` on it and nothing is owed |
| `done` | the work is finished and nothing is owed now — but something is still open: a terminal not yet closed, a "later", a yes the executor has not carried out |
| `closed` | he closed it; or every link ended / handed over, nothing is owed, and every yes was carried out |

Terminal phases come from `term-status.ts` (the one resolved status per terminal). A chat terminal that stops
is finished, not stuck; a terminal that stopped on a question he put off ("later") is parked — `done`, held —
not stuck. A request whose links all moved on before any hand-off is `closed` — "continued in a
later request". A fleet-wide row is as urgent as its most urgent child.

## What came back, and what he owes

A hand-off becomes deliverables and decision items, from its `ask`:

- `merge` → one `merge` item per PR · `deploy` → a `deploy` deliverable and item · `merge+deploy` → both ·
  `review` → a `review` item on the PR, or on the hand-off itself (`answer`) · `none` → nothing to decide.
  An analysis or QA hand-off is itself an `answer` deliverable, and every link its summary or changes name (not
  its proof — that is evidence) is a `doc` deliverable, or a `dashboard` when the link says so.
- What the agent already shipped (`mc outcome --shipped "merged #12"`) settles the deliverable and asks nothing;
  a PR GitHub reports merged or closed (`session_prs`, polled by the ship loop) settles it on the next sweep.
- A draft (`mc hook` on a Slack/Gmail draft tool) is a `slack_draft` / `email_draft` deliverable with a `send` item.
- His open questions (asks routed to him, or escalated) are `answer` items. They are answered on the ask
  (`POST /api/asks/:id/answer`); the ledger follows — one decision, written once.
- An item is asked once per version of its target. A newer hand-off or a rewritten draft raises a new item
  and supersedes the older open one on the same target (within the workspace), so he never hears one PR twice.

**Target hashes.** Every executable item (merge · deploy · send) is bound to its deliverable's `target_hash`:

- PR → its head SHA. The verifier stamps it (`requests.bindTarget(deliverable, sha)`) when it reads the PR,
  and re-stamps it when its sweep sees the head move; the executor merges with `--match-head-commit`. Re-binding moves every open item on that
  deliverable in one statement, so a yes he gave to an older head matches nothing.
- Draft → `draftHash` = `sha256:` + sha256 of `JSON.stringify([channel, to, subject, text])`, channel and
  recipient trimmed and lower-cased, subject trimmed (`""` for Slack), text verbatim; recipients of an email
  joined with `", "`. `mc hook` computes it where the text is — the text never reaches the daemon — and the
  executor recomputes it from the draft it is about to send. Two implementations of one formula, kept in step
  by `src/ledger-mc.test.ts`.
- Page → `v<version>` (artifact.updated).
- Deploy → the commit that would go out. **Not filled yet** — the verifier or the executor binds it, so a
  deploy yes is refused until then (he can still say later, no or change).

## Reading it

- `GET /api/ledger` — rows, most urgent first. `?state=` a comma list, `open`, `active` (default: not closed) or
  `all` · `?needs=decision` · `?workspace=` (operator only) · `?since=2h|ISO` · `?session=<id>` ·
  `?format=text` for the compact block.
- `GET /api/ledger/:id` — one request in full: terminals (goal, done-when, phase), result (the hand-offs in its
  windows), deliverables, decisions, checks, and the expected evidence slots of its work type.
- `GET /api/ledger/queue` — every open item, in the order he should hear it: questions blocking a terminal ·
  executable, bound and verified · bound, unverified · reviews · unbound · failing checks; oldest first inside
  each. Held items are listed apart. Each carries a speakable `line`.
- `ledgerText(ws)` / `ledgerLines(rows)` — one short plain-language line per open request, capped, ids only on
  rows he may have to act on. Meant to replace `fleet-line.ts`'s per-terminal block; **not wired into Robert's
  prompt yet**.
- `mc ledger [list|show <id>|queue|mine|text]`.

**The wall.** The operator's token reads every workspace, and so does the fleet-wide Robert's credential (reads
only — he granted that; every write here is the operator's hand). A project Robert's token or a workspace token reads
only its own workspace's rows; a foreign id is the same 404 as a missing one; a workspace-less row is never
theirs. There is no tokenless read: the ledger holds what he said in every workspace.

## Deciding

`POST /api/ledger/:id/decision {item?, decision: yes|no|later|change, words?, target_hash?, until?, by?, audio_ref?, surface?, how?, override?}`
records his answer. With the executor on, a yes on a merge or a send is then carried out (see *Executing*);
otherwise nothing runs. It takes the operator's hand: his token itself from this Mac (`isOperator` — no Robert
process holds it: each carries a credential derived from it, which the server tells apart), no agent header
(`x-mc-lead` / `x-mc-session` / `x-mc-agent` / `x-mc-workspace-token`) and `x-mc-operator: 1`.

- A request owing more than one decision needs `item` (id or prefix); the 409 lists them.
- `yes` on merge/deploy/send needs a bound item and `target_hash` equal to the item's and its deliverable's
  current one — otherwise 409 with what the target is now. Any decision that names a target must match it.
- `change` needs his words. `later` takes `until` (ISO, `+30m`, `+2h`, `+1d`) — a dated hold comes back on the
  sweep after its date; an undated one waits until he picks it up.
- `POST /api/ledger/:id/close {words?}` — he closed it; whatever it owed stops being a question.
- Every decision is published as `ledger.decided` (kept by the activity trail); every state move as `ledger.updated`.

## Executing

`src/executor.ts` — the execution owner. Daemon code, not a model: it carries out one thing he said yes to, that
exact version, once. `executor.enabled` (⚙ Settings → Executor, default **off**): off, a yes is recorded exactly as
before and the response says `executed: false, executor: "off"`.

**The only door.** The decision route above, from his hand, after `recordDecision` checked the yes names the target
he was shown. Then `approve()` writes ONE row in `executor_approvals` (migration 159; a unique index on the decision
item): action, target ref, `target_hash`, when, `approved_by`, surface, his exact words, how (`tap` · `voice_strong` ·
`voice_confirmed` — from the body, else from `by`; a weak spoken yes carries nothing out), `audio_ref`, an optional
override, `expires_at` (`executor.ttl_minutes`, default 5). `executeApproval()` claims it in one conditional UPDATE
(single use: a replay or a race gets `replay`; past its time it is `expired`, used up, and asked again). No route takes
an approval id; `carryOutDecision` has one caller (a test reads the source to hold that). At boot an unused approval is
voided, never run late.

**Before anything runs**, read at that moment: the switches; the request still in the workspace the yes was given in;
the item still `decided`/`yes` and still bound to the approved hash; the deliverable not already final; the workspace
real (a workspace-less request has no identity of its own to act under).

| action | re-reads the real thing | then | refuses when |
|---|---|---|---|
| `merge_pr` (`executor.merge_pr`, default on) | `gh pr view` — GitHub's live head, under the workspace's own env (`childEnv`: its `GH_TOKEN`/`GH_CONFIG_DIR`, else the login its agents use) | `gh pr merge <url> --<merge_method> --match-head-commit <approved sha>` — never `--admin`/`--auto`/`--delete-branch`, never deploys; confirms MERGED (else `queued`) | the PR is not this workspace's (`prBelongsTo`) · checks (below) · not open / a draft · head ≠ approved |
| `send_draft` (`executor.send_draft`, default off) | the channel's `DraftSender.read` — the provider's live draft, never a kept copy (`GET /api/drafts` is display only) | `send` exactly what was read and hashed (`draftHash`) | no sender for the channel · draft gone · live hash ≠ approved |
| `deploy` | — | never: a disabled seam, it will need its own yes each time | always (`executed: false`) |

**Checks** (`request_checks`, read only — the verifier writes them): only a check naming THIS head counts; the newest run
of each counts; any `fail` refuses; a required check of the work type (`WORK`) not `pass` refuses. No rows at all:
`executor.no_checks` = `refuse` (default) or `allow`; or his one-off override (`override: "no_checks"` with the yes,
operator-only like everything on this route) — either way the log says which.

**After.** Every ending writes `executor_log`: who approved, his words, surface, how, the approved and the live hash,
what ran, status (`done` · `refused` · `failed` · `queued` · `void`), a reason code, the error text, any override.
Done → the deliverable moves (`merged` / `sent`, twins too) and the live terminal is told not to do it again. A failure
a later yes could fix (checks, a GitHub refusal, expiry) retires the spent yes and raises a fresh item; when what he
approved is gone (`moved`) the deliverable is unbound too, so no yes passes until the verifier binds the new version.
No sender / deploy / switched off: nothing is re-asked — he does it himself, as today. Each result is published as
`executor.result` with `say: {es, en}` ("Mergeado." / "No pude: …") for the voice layer, and returned in the response:
`{ok, item, request, executed, executor?, execution?}`. `GET /api/executor/log` (operator only) · `GET
/api/executor/status` · `mc executor log|status`.

**Sending, per workspace (2026-11).** The daemon can send nothing yet, so no sender exists and `send_draft` refuses
with the reason: Slack drafts are made through each workspace's official Slack MCP (OAuth token cached by the CLI in
that workspace's profile dir; the daemon holds no Slack token), and Slack's public Web API has no method to read or
send a person's draft — the executor could never re-read what he approved, so a Slack sender cannot be built on it.
Gmail drafts are made through the claude.ai Gmail connector of each workspace's Claude profile (credentials held by
claude.ai); the Gmail API can (`users.drafts.get` format=raw, then `users.drafts.send` with that same raw message, so
what goes out is what was hashed) given, per workspace: a Google OAuth client + refresh token with `gmail.compose`
for the account that workspace drafts from, the draft id captured by `mc hook` from the tool's response, and a
measured canonical form between the connector's MIME and the hook's text. The agents' no-send deny list is unchanged.

**The phone** (`static/phone-deck.js decideLedger`, owned elsewhere — not edited here) still answers a carried-out
yes with "Recorded.". Its yes branch should speak the result:
`var r = await post("yes", { target_hash: L.target_hash, words: meta.words || null });`
`if (r && r.execution) return t(r.execution.say.es, r.execution.say.en);` — and, once `GET /api/executor/status`
says `enabled` with `merge_pr.on`, never fall back to typing the approval line for an unbound merge: say it is not
verified yet instead, so merges only go through the executor.

**What this stops, and what it does not.** It stops a model — any Robert (project rw/ro, fleet-wide, either lane), a
terminal, a Lead, a job — that follows a bad instruction or a prompt injection, or is simply confused, from recording or
carrying out a yes: none of them holds a credential the decision route accepts, and their sandbox denies the token
file. It stops a yes from covering anything but the version he was shown, from being used twice or late, from crossing
workspaces, and from merging past failing or missing checks. It does not stop anything running as the operator's OS user
outside the sandbox (malware, an unsandboxed terminal or a workspace whose sandbox he set to off, a daemon command
that reads the token file for an agent): such a process can read the admin token and speak as him. Agents also keep
their own `gh pr merge` (Leads have merge authority; the Desk's approval line asks a terminal to merge) — the executor
adds a guarded road, it does not close that one.

## Restart, replay, backfill

Every write is an upsert keyed so a replayed event writes nothing new; every state is re-derived from rows, so
events may arrive repeated or out of order (a hand-off filed before the open is processed still lands — the
window opens at the terminal's own creation). A restart loses only the in-memory turn map, whose turns died with
the process. Every hand-off in a window is part of the result, but only the newest one raises questions — live,
each hand-off is the newest when it lands, and a backfill does not bring back hand-offs he already dealt with. Thirty seconds after boot and every minute after, the sweep reopens due holds, settles PRs GitHub
already settled, adopts orphans, backfills terminals older than `kv ledger.since`, and re-derives every open row.

## The verifier

`src/request-verifier.ts` (runs it) · `src/verify-model.ts` (pure: what each check concludes) · readiness in
`ledger-model.ts` (`slotsFor`, `readiness`) and `ledger.ts` (`itemReadiness`). "Ready for his yes" is decided by
code and evidence, never by the terminal's own claim.

- **Trigger.** Every new decision item (`ledger.item_raised`, published by `raiseItem`): a hand-off asking for a
  merge, review or deploy, or a draft. A burst from one hand-off is one pass (5 s debounce); at most two passes run
  at once. A pass whose targets (items + their hashes) match the last finished one is not repeated. The sweep
  (every 3 min) re-reads the head of every open PR item: a moved head is re-bound at once and re-checked.
- **Where it runs.** In the workspace that owns the request, never workspace-less ones: gh reads with that
  workspace's read env (`ghReadEnv`), only for a PR of its own repos (`prBelongsTo`); the repo's checks in the
  terminal's own worktree through its sandbox (`sandboxWrap`), under `nice` and a heavy slot (`mc heavy`); the
  reader as a `review:` run of that workspace (its sandbox, its review engine). Read-only to the outside world:
  no merge, send, deploy, PR comment or post.
- **Checks.** Any PR: `pr_ready` (open, not a draft, no conflict, not behind its base, CI not red), `tests` (the
  repo's `gate_cmds` re-run at the PR head — only when the worktree is exactly at that head and clean; output kept
  on the check; no command configured = `skip` with that reason, never `pass`), `matches_request` (a second
  reader, never the model that wrote it — `pickReviewer` — given his words and the goal; no Bash, no writes, so it
  cannot park on an ask or post anything). Backend: `goal_test` (a test file in the diff; skip when undecidable),
  `regression` (skip: not machine-checked). UI: `shots` (before/after per screen at phone AND desktop width,
  labels `before-<screen>-phone` …, evidence meta `{screen, viewport, side}` for the phone's card) and
  `walkthrough` (`mc show` steps). Analysis/QA: the reader judges `queries` · `crosscheck` · `assumptions` /
  `exercised` · `repro_steps`. Drafts: `draft_bound` — the words on file re-hashed with `draftHash` (the formula
  `mc hook` uses) and bound, or matched against what the hook bound.
- **Ready** = on the item's CURRENT target: every required slot has a result, none failed, and every gate passed
  (`pr_ready`, `matches_request`, `shots`, `draft_bound` — a skip is not enough). Other required slots may be
  skipped with a reason; the queue line says them ("checks pass (not checked: tests, regression)"). A check run
  against an older head or older words is stale and counts for nothing.
- **Fail → the terminal.** A fail the terminal can fix is typed into it (`[verifier] Not ready… round n of 2`),
  at most two rounds; after that, and when its terminal is closed, the request surfaces as not ready with the
  reason (`GET /api/ledger/:id` → `verification`, the queue line). Infrastructure trouble (GitHub unreachable, no
  verdict) is a skip and is never told.
- **Reading and re-running.** `GET /api/ledger/:id` → `checks` (each with `stale`), `readiness` per open item,
  `verification` (passes, rounds told); the queue item → `verification` (ready, failed, gaps, evidence).
  `POST /api/ledger/:id/verify` / `mc ledger verify <id>` — the operator's token only (a workspace token reads
  its own checks, never re-runs). Setting `verifier.enabled` (Safety) turns the automatic verifier off per
  workspace; the operator's re-run still works.
- **Visual** (`src/visual-critic.ts`, `src/visual-capture.ts`, house style in `src/house-style.ts`). A hand-off whose
  answer is a page, a dashboard or a document — every `mc artifact` page the terminal published, the links an analysis
  hands off (code hosts and trackers are references), screenshots it attached that are not a UI before/after pair —
  is rendered in the shared headless browser on a lease of that workspace (its egress proxy) at desktop and phone
  width, sliced into screens, and judged by a read-only `review:critic-…` run against the bar and the workspace's
  house style (`mc style`). `visual` is a non-required slot on answer items: absent when there was nothing to look
  at, but a fail (fixes, or charts to **remove**) is a fail, told in the same two rounds. A page behind a login (or
  an error page) is never guessed at: judged from what was attached, said so on the check, and with nothing
  attached the terminal is asked for screenshots. Renders live in `~/.mc/critic/<workspace>/` (denied to every
  other workspace); a page of another workspace named in a hand-off is never opened. Setting `verifier.critic`.

## Not yet

- **Executor senders**: no channel has one (see *Executing → Sending*); deploys are a disabled seam.
- **Voice front**: built (VOICE.md, `src/talker.ts`, setting `voice.talker`, off by default) — it speaks from
  `ledgerText` + `queueView` and opens one request per delegation with `openRequest` (turn bound).
- Telegram turns do not publish `agent.asked`, so a terminal Robert opens from Telegram is recorded as his own.
- Dashboards and documents are read from links in the hand-off's text: the hand-off has no link field of its own
  yet, and nothing tells an agent to name its deliverable's link (KIND_CONTRACT for `investigation` is unchanged).
- Migration 156 lands next to 155 and 157 from parallel work: deploy them in order — a database that reaches 156
  before 155 exists would skip 155. Likewise 159 (the executor) after 158 (the verifier).
