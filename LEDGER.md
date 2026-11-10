# The request ledger

> One durable record per thing the operator asked for: **what he said → where it went → what state it is
> in → what came back → what decision he owes.** Written by code at every entry point, moved by events
> the daemon already publishes, never by a model re-reading screens. It is the floor the coordinator,
> the verifier, the executor and the voice front stand on.
>
> Code: `src/ledger-model.ts` (pure: vocabulary, work types, roll-up, queue order, compact text) ·
> `src/store/requests.ts` (rows, migration 156) · `src/ledger.ts` (writers, sweep, decisions, read views) ·
> `src/ledger-routes.ts` (`/api/ledger`) · `mc ledger` (scripts/mc).

## The model

| Table | One row per | Holds |
|---|---|---|
| `requests` | thing asked for | his words verbatim · `via` (how it arrived) · `surface` · `turn_id` · work type (`kind`) · `prereqs` · derived `state` + `state_line` · `result_at` · `closed_at` · `parent_id` |
| `request_terminals` | (request, terminal) | `role` · `is_primary` · the window `[linked_at, until)` its hand-offs count in |
| `request_deliverables` | thing that came back | `kind` (pr · deploy · slack_draft · email_draft · artifact · dashboard · doc · answer) · `ref` (what it is) · `target_hash` (what it is *now*) · `state` |
| `request_decisions` | question put to him | `action` (merge · deploy · send · review · answer) · bound `target_hash` · `status` (open · held · decided · superseded) · `decision` (yes · no · later · change · answered) + his `words`, `decided_by`, `decided_at`, `hold_until`, `audio_ref` |
| `request_checks` | verifier check run | `name` · pass/fail/skip · `evidence[]` refs (+ meta: screen, viewport, side) · `target_hash` it ran against · `ran_by`, `ran_at` — **empty until the verifier exists** |

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

- PR → its head SHA. **Not filled yet**: the verifier stamps it (`requests.bindTarget(deliverable, sha)`) after
  checking the PR; the executor merges with `--match-head-commit`. Re-binding moves every open item on that
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

**The wall.** The operator's token reads every workspace. A project Robert's token or a workspace token reads
only its own workspace's rows; a foreign id is the same 404 as a missing one; a workspace-less row is never
theirs. There is no tokenless read: the ledger holds what he said in every workspace.

## Deciding

`POST /api/ledger/:id/decision {item?, decision: yes|no|later|change, words?, target_hash?, until?, by?, audio_ref?}`
records his answer and **executes nothing** — the executor acts on a recorded yes, later. It takes the
operator's hand: his token, no agent header (`x-mc-lead` / `x-mc-session` / `x-mc-agent`) and `x-mc-operator: 1`,
the same three as closing a terminal. That keeps Robert and agents from recording a yes through `mc` or curl,
but it is a convention the fleet-wide Robert (who holds the admin token) could imitate: the executor must still
check where an approval came from.

- A request owing more than one decision needs `item` (id or prefix); the 409 lists them.
- `yes` on merge/deploy/send needs a bound item and `target_hash` equal to the item's and its deliverable's
  current one — otherwise 409 with what the target is now. Any decision that names a target must match it.
- `change` needs his words. `later` takes `until` (ISO, `+30m`, `+2h`, `+1d`) — a dated hold comes back on the
  sweep after its date; an undated one waits until he picks it up.
- `POST /api/ledger/:id/close {words?}` — he closed it; whatever it owed stops being a question.
- Every decision is published as `ledger.decided` (kept by the activity trail); every state move as `ledger.updated`.

## Restart, replay, backfill

Every write is an upsert keyed so a replayed event writes nothing new; every state is re-derived from rows, so
events may arrive repeated or out of order (a hand-off filed before the open is processed still lands — the
window opens at the terminal's own creation). A restart loses only the in-memory turn map, whose turns died with
the process. Every hand-off in a window is part of the result, but only the newest one raises questions — live,
each hand-off is the newest when it lands, and a backfill does not bring back hand-offs he already dealt with. Thirty seconds after boot and every minute after, the sweep reopens due holds, settles PRs GitHub
already settled, adopts orphans, backfills terminals older than `kv ledger.since`, and re-derives every open row.

## Not yet

- **Verifier**: fill `request_checks` (`requests.addCheck`) and bind PR heads (`requests.bindTarget`). The queue
  already ranks verified items first and the detail view already shows the missing slots.
- **Executor**: act on `decided`/`yes` items whose `target_hash` still matches, then move the deliverable
  (`merged` / `sent` / `deployed`), which closes the request.
- **Voice front**: built (VOICE.md, `src/talker.ts`, setting `voice.talker`, off by default) — it speaks from
  `ledgerText` + `queueView` and opens one request per delegation with `openRequest` (turn bound).
- Telegram turns do not publish `agent.asked`, so a terminal Robert opens from Telegram is recorded as his own.
- Dashboards and documents are read from links in the hand-off's text: the hand-off has no link field of its own
  yet, and nothing tells an agent to name its deliverable's link (KIND_CONTRACT for `investigation` is unchanged).
- Migration 156 lands next to 155 and 157 from parallel work: deploy them in order — a database that reaches 156
  before 155 exists would skip 155.
