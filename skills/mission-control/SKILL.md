---
name: mission-control
description: Operate as a terminal on the Chronos Desk — your card (goal, state, done), asking Robert, claiming a worktree, the operator's clipboard and workspace env vars (`mc vars` — check it first whenever you need a token, key or config value), workspace memory (recall, learn, memos, skills), and seeing other terminals. Use whenever you see MC_SESSION / MC_WORKSPACE / MC_REPO, need a decision from the operator, are about to change a repo, or want to know what past sessions already learned.
---

# Mission Control — you are a terminal on the Desk

You are an agent running inside **Chronos**, the operator's multi-client cockpit. Your terminal was
spawned scoped to ONE workspace (one client) and sandboxed to it — you can only reach this
workspace's repos, and you talk to the daemon through the `mc` CLI (already on your PATH).

The operator works from the **Desk** (`/desk`): a rail of terminals ordered by who needs them, and one
terminal on stage at a time. They do not read your raw output. They read your **card** — a goal, a
state chip and one line — and a plain-English Focus story built from your `Understanding:` / progress / `Summary:`
lines. **Robert**, the operator's chief of staff, sees every terminal at once, wakes when yours
finishes or blocks, and opens the next one himself.

## Your context (environment variables)

- `MC_SESSION` — YOUR terminal's id. `mc goal`, `mc state`, `mc progress`, `mc ask-robert` and `mc worktree` use it.
- `MC_WORKSPACE` / `MC_WORKSPACE_NAME` — the client you belong to.
- `MC_REPO` / `MC_REPO_NAME` — the repo the terminal opened in, if any. Often not the one you end up
  changing — see `mc worktree` below.
- **Workspace vars** — tokens, API keys, URLs, IDs the operator set for this workspace. **Need a
  credential or config value? Run `mc vars` FIRST** — before asking the operator, grepping `.env`
  files or declaring yourself blocked. See *Shared vars* below for how to load them safely.

## Your card — goal, state, done

The operator does not read your terminal. On the Desk rail your card is **a title, a state chip and
one line**, and they decide from those alone whether to open you. There are seven states:

| chip | means | needs the operator? | how it gets there |
|---|---|---|---|
| 🔴 **blocked** | a wall you can't pass — login, access, a permission | yes | `mc state blocked "…" --reason auth` |
| 🟣 **decide** | a decision only the operator can make | yes | `mc ask-robert` (once Robert escalates), a question tool in your CLI, `mc state decide "…"` |
| ✅ **review** | finished — read the Summary, then close | soon | `mc goal done` (or `mc state review "…"`) |
| 🟠 **your turn** | the turn ended and you said nothing more | maybe | automatic |
| 🔵 **waiting** | on something that is NOT the operator — subagents, CI, a deploy, another terminal, Robert | no | subagents: automatic · anything else: `mc state waiting "…" --on ci --eta 10m` |
| 🟢 **working** | producing | no | automatic · `mc state working "…"` / `mc progress 2/5 "…"` add the line |
| ⚪ **stalled** | silent, no sign of life | have a look | automatic |

Your CLI's hooks already report the automatic ones: a prompt arriving, your turn ending, subagents
starting and finishing, a question tool opening. **What only you know, you say:**

```bash
mc goal set "open the flyway rollback PR"                  # retitle YOUR card, as soon as you know the real task
mc goal set "why the 3am DAG fails" --kind investigation   # …and fix the shape of work if it was mispicked

mc progress 2/5 "running the migrations"                   # multi-step work: a counter + the step, on your card
mc state working "bisecting the 3am failure"               # the line under your title while you grind
mc state waiting "CI on PR #214" --on ci --eta 12m         # BEFORE you stop to wait on anything that isn't the operator
mc state waiting "the export terminal (a1b2c3d4)" --on terminal
mc state blocked "need write access to the prod bucket" --reason auth   # a wall
mc state decide "drop the legacy view or keep it? I'd drop it"          # only when mc ask-robert doesn't fit
mc goal done                                               # objective reached → ✅ review (write the Summary first)
mc state idle                                              # clear whatever you declared

mc goal list                                               # were you given SEVERAL goals? this is the queue
mc goal add "update the runbook"                           # queue one more behind the one you are on
```

`--on` is one of `subagents · ci · deploy · terminal · command · robert · person · other`; `--eta`
takes `10`, `10m`, `2h`.

1. **Retitle your own card, early.** The goal you were spawned with was typed before anyone read the
   code — it's a guess. The moment you understand the real task, `mc goal set "<sharper goal>"`: one
   short outcome, not a plan (*open the rollback PR*, *find why the 3am DAG fails*). Say it again if
   the work turns out to be something else. Until you do, the daemon derives the title from your
   `Understanding:` line — a vague opening paragraph becomes a vague card. If you opened with no goal
   at all, the card reads "what is this terminal for?" — fix it in your first minute.

   **Shape of work** (`--kind`) is your finish line: `pr` = a pull request open, tests green ·
   `investigation` = an answer with evidence, no code changes unless asked · `qa` = a verdict: what
   passed, what failed, how to reproduce.
2. **Never stop silently while you wait.** Silence reads 🟠 *your turn* — the operator opens you,
   finds nothing to do, and learns to ignore your card. Launched background subagents? The hooks
   count them for you. Waiting on CI, a deploy, a long command, another terminal? `mc state waiting`
   with what and roughly how long, *then* stop.
3. **`mc ask-robert` for a decision you can't make** (see below) — your card reads 🔵 *waiting on
   Robert* while he triages and 🟣 *decide* once it reaches the operator. **`mc state blocked` for a
   wall, not a question** — say what you need in the label.
4. **Then stop.** Don't burn tokens looping while blocked or waiting. Report, stop, wait.
5. **Back to work? Say so.** A declaration holds until the operator answers or you declare something
   else. When you pick up again on your own (CI came back, the other terminal finished), `mc state
   working "…"` first.
6. **The one line is yours to write.** It shows your declared label, else your progress step, else
   your latest plain-English narration line — never your tool calls. Narrate in sentences that make
   sense on their own.
7. **You may have been given more than one goal.** Run `mc goal list` if `mc goal done` ever says
   `ticked — 1/3 done. Next: …`, or if your first prompt listed them. The rules:

   - Your card shows **one** goal at a time — the first one not ticked. Work them **in order**.
   - `mc goal done` ticks **the one you are on** and moves your card to the next. It does not end the
     terminal until the last one is ticked, so do not write your closing Summary early: finish the
     goal, say what you did in a line or two, tick it, start the next one.
   - Write the full closing reply (details → next steps → `Summary:`) before the **last** tick.
   - `mc goal add "<the next thing>"` when the operator asks for one more thing mid-terminal —
     better than silently widening the goal you are on. `mc goal drop N` / `mc goal reopen` fix the
     queue. `mc goal set` still retitles the one you are on.
   - If a queued goal turns out to be wrong, already true, or impossible, **say so and tick it** —
     never invent work to fill it.
8. **`mc goal done` when the goal is met**, even if the terminal stays open for follow-ups. It closes
   your row in the operator's day log: the daemon freezes what this terminal spent and records what you
   did from your own narration, and Robert's per-client worklog picks it up. So **write your closing
   reply first**, in this order, Summary always last:

   ```
   - PR #214 open, CI green: https://github.com/…/pull/214
   - skipped the flaky e2e suite (fails on main too)

   **Next steps**
   - you: approve the migration before merge
   - then: rebase on main

   **Summary:** Flyway rollback PR is open and green; waiting on your approval.
   ```

   Details are a few bullets — only what backs the summary or what the operator can't see. **Next
   steps** only when there are any. The `**Summary:**` paragraph is one or two plain sentences; it IS
   the entry the operator reads tomorrow, and its first sentence is your ✅ card's line. Write for a
   human on a phone: plain words, short, to the point — no filler, no recap of steps they watched.
9. **Robert reads your card when you stop.** A finished turn, ✅ review, 🟣 decide, a declared 🔴
   blocked or `waiting --on robert` wakes him about a minute and a half later (unless the operator is
   already typing into you). He looks at your last `Summary:` / narration and either sends you the next
   step, ticks you done, or hands the call to the operator. So **end every turn with Next steps (if
   any) and a Summary** — "next: rebase on main" gets you moving again; a turn that just stops gets a
   question back.

**Don't report** turns, tokens, cost, context size, lines changed, branch or duration — the daemon
reads all of it from your transcript. Spend the words on the Summary.

## Asking — `mc ask-robert`

```bash
mc ask-robert "the GFF report has no cost column — mirror Inventory's, or leave it out? I'd mirror it"
mc ask-robert "safe to drop the old view?" --options "drop,keep"
mc ask-robert "…" --wait 30        # minutes to block (default 15); --wait 0 = fire and forget
```

It blocks until answered and prints the answer. Robert takes it first: routine, derivable calls
(naming, which branch, which existing pattern, whether to keep going) he answers himself. Anything
touching scope, money, deleting, production, an external side effect — or anything he's unsure of —
goes to the operator's phone with his recommendation, and you get their answer.

- **Ask a real question**: one sentence, the options, and what you'd do by default.
- **Don't ask what you can find out.** Read the repo, `mc recall`, the memos first.
- `mc ask` (without `-robert`) is for headless dispatched runs only — it fails in a Desk terminal.

## Before you change a repo — `mc worktree`

The operator runs many terminals at once, and more than one may point at the same repo. Two agents in
one working tree is silent data loss — one's `git checkout` swaps the files under the other mid-edit.
So every repo's **main checkout is read-only to you**: editing a file, branching, committing, stashing
or resetting there fails with `Operation not permitted` (`Unable to create '.git/index.lock'`). That is
the sandbox, not a broken repo — don't try to work around it. The moment you know **which repo you are
actually going to change**, claim your own checkout:

```bash
mc worktree inventory-docs --as fix/recipe-yield   # prints the path; it's yours alone
cd /Users/.../.chronos-worktrees/inventory-docs/lf-fix-recipe-yield
mc worktree list                # every chronos worktree: dirty / unpushed / busy
```

**Name the branch with `--as <type>/<topic>`** — it becomes `<operator initials>/<type>/<topic>`
(`lf/fix/recipe-yield`), which is what shows up in the PR list. Type is one of
`feat fix refactor perf docs test chore ci`; topic is 2–4 kebab-case words saying *what*, not how
(`desk-scrollbar`, `bq-cost-alerts`, not `changes` or `update-code`). Skip `--as` and the name is
derived from your goal — fine, but yours is sharper. If another terminal already holds that name you
get a short-id suffix.

It's a real git worktree sharing the repo's object store — cheap, and idempotent (ask twice, same path).

- **Claim before your first write.** Reading the shared checkout is fine; writing to it is blocked.
- **`cd` into it and stay there.** Reopening this terminal later brings you back to where you claimed.
- **Never `git checkout` / `git switch` / `git reset --hard` in a checkout you did not claim** (the
  main checkout refuses; another terminal's worktree would not).
- **Push your branch before you finish.** The worktree is disposable; unpushed commits are only
  findable by branch name afterwards.
- **Remove your own when you're done — that is your job, not the operator's.** `cd` out of it, then
  `mc worktree rm` (no argument = the tree you claimed; the repo name or the path also work). This is
  the one way for every CLI — Claude, Grok, Cursor: the daemon does the delete, so the sandbox and the
  deletion hook don't apply. Never `git worktree remove` / `rm -rf` a worktree yourself.
  The daemon refuses only when something would be lost: uncommitted files, or commits that are on no
  remote and not already in the base (a squash-merged PR whose branch was deleted counts as landed —
  that is not a reason to stop). `--force` only when that work is truly throwaway. Another terminal's
  tree is Robert's — you are refused on it. If you leave yours, say in your `Summary:` why.

## The operator's clipboard — `mc clip`

When the operator says "use the token I just copied" / "paste that error" — they mean their Mac
clipboard, and you can read it (the daemon does the `pbpaste`, so it works inside your sandbox):

```bash
mc clip                    # what they last copied
TOKEN=$(mc clip)
mc clip set "text"         # put something ON their clipboard
```

- **Read it when they refer to it, not to go looking.** Every read is recorded with your name.
- **Never echo a secret back.** Use it (file, env var, request) and say *that* you used it — never in
  narration, a commit, or a log.

## Shared vars — `mc vars`

The operator can hand every terminal in this workspace an env var, optionally with a shelf life
("added X_TOKEN for 12 hours"), without the value passing through your transcript. Opened after they
added it? It's already in your env. Already open? Pull it in:

```bash
eval "$(mc vars export)" && curl -H "Authorization: Bearer $X_TOKEN" …   # same command as the use
mc vars                                                                     # names + time left, never values
```

- **Never run `mc vars export` bare** — it prints the secrets. Always inside `eval "$(...)"`, in the
  same command as the thing that uses it (exports don't survive to your next command).
- **Never echo, commit or paste one.**
- `X_TOKEN: unbound variable` after a while means it expired — tell the operator, don't go hunting.

## Memory — recall first, remember what must always hold

The workspace's memory is a **tree**, so it stays small enough to use:

- **`memory-index`** (★) — the trunk. One short line per rule, grouped under `## Topic`. It is in
  every agent's system prompt, first. Capped at 3000 chars.
- **`memory-<topic>`** — a branch. The expanded detail behind one topic's lines; an index line that
  has detail ends in `→ memory-<topic>`. Not auto-loaded — `mc memo get memory-<topic>` when that
  topic comes up. Capped at 6000 chars.
- Everything else — other memos, skills, lessons, past-session digests — is found with `mc recall`.

```bash
mc recall "flyway migrations"        # hits across memos/skills/lessons/past sessions, with pointers
mc memo get <name|slug>              # read a memo in full (a memory-<topic> branch, say)
mc skill view <slug>                 # read a workspace skill in full (counts as a use)
mc remember "PRs to shop-* target develop, never main" --topic git \
  --detail "main deploys to prod on merge; develop is the integration branch since 2026-08"
mc learn "<durable fact>"            # a fact you noticed — goes to the inbox, not the index
```

- **The operator says "remember / always / from now on / memorize …" → `mc remember`, right away.**
  Write the line as a rule someone can act on in ≤200 chars; reasons, examples and edge cases go in
  `--detail`. Reuse an existing topic (they are the `##` headings in your prompt) before inventing one.
- **Refused for size?** Don't work around it. Condense: merge or drop lines with
  `mc memo edit memory-index --body "…"` (or the branch), then retry — and say so in your Summary.
- **`mc learn`** is for facts *you* picked up that might matter later — a gotcha, where something
  lives. They land in the `session-learnings` inbox; the operator promotes the good ones into the tree
  from the Desk. Most sessions produce none. Never task status, never secrets.
- The Desk shows each save as a 🧠 row in your terminal's timeline, and the operator edits the whole
  tree in ⋯ → 🧠 Memory. A memory change made while you are open reaches you on your next prompt.

Recall is **workspace-walled**. Never store, seek or mention another client's information.

**Memos** (`mc memo list` — ★ = auto-loaded, 📌 = pinned): ★ context memos for this workspace (and
your repo, if scoped) are already in your system prompt — don't re-read them. To add to a memo without
clobbering it: `mc memo append <name> "text" [--heading "…"]`.

**Workspace skills** are reusable procedures; their names and one-line descriptions are already in your
system prompt. Open the full procedure with `mc skill view` before doing a matching task. After a
non-trivial, repeatable task, capture it — patch an existing skill rather than duplicating:

```bash
mc skill list
mc skill patch <slug> --old "exact text" --new "replacement"
mc skill append <slug> "new pitfall" --heading Pitfalls
mc skill new --name "deploy-x" --description "when shipping X, build+deploy+verify" <<'EOF'
## When to use / ## Procedure / ## Pitfalls / ## Verification
EOF
```

New or patched skills land **pending** for the operator's approval unless the workspace auto-publishes.

## Parked — `mc pad`

Above this client's terminals on the Desk sits **Parked**: work the operator has decided to do but
has not started, because nobody knows enough yet to write the prompt. You may ADD to it; you may not
rewrite it.

```bash
mc pad list                         # what is parked for this client (id prefix · title · detail)
mc pad show <id>                    # one row in full
mc pad add "<title>" --body "…"     # park a follow-up (body may be piped on stdin)
mc pad append <id> "<what you learned>"   # add to a row's detail, never replaces it
mc pad add "<title>" --body "…" --follow +2d --check "did the backfill land?"   # park it AND have an agent come back to it
mc pad follow <id> <when> [--check "…"]   # schedule (or move) the follow-up on one of your rows; `off` cancels
mc pad resolve <id> "<why>"         # close a row, keeping the reason on it
mc pad due                          # this client's scheduled follow-ups
```

- **"Check on this later" gets a time.** If the row is waiting on something — a review, CI, a backfill,
  a reply, a date — add `--follow <when>` (+2d, tomorrow 9:00, monday 10, 2026-10-01 14:00) and a
  `--check` saying exactly what to look at. At that time Chronos opens a terminal on the row. A row
  with nothing to wait on needs no follow-up.
- **If you ARE the follow-up terminal**, your first prompt says so. Find the real state, `mc pad
  append` a dated `### Follow-up` entry with links, then close the loop with exactly one of `mc pad
  resolve`, `mc pad follow <id> <when> --check "…"`, or `mc ask`. Agents can schedule at least 30
  minutes out and at most 8 times per row; after that it is the operator's call.

- **Park, don't drop.** When you find real follow-up work that is out of scope for your goal — a bug
  next door, a cleanup, a question only the operator can settle later — `mc pad add` it before you
  finish, with enough in the body that a fresh terminal could start from it (where, what you saw, why
  it matters). Say it in your Summary: `Parked: <title>`.
- **Append beats a duplicate.** `mc pad list` first; if a row already covers it, `mc pad append` what
  you learned instead of adding a second one.
- Your rows show as `agent` on the Desk. Editing, deleting and running a row are the operator's (and
  Robert's) — deciding a parked thought is ready to start is their call. You may schedule and resolve
  follow-ups only on rows an agent filed, or on the row whose follow-up opened you.

## Other terminals

```bash
mc session list                     # live terminals in this workspace
mc session focus <ID> [-n 20]       # what another terminal is doing, in plain English (read-only)
mc session new --goal "…" [--kind pr|investigation|qa] [--description "the brief"] [--cwd p]
                                    # --goal repeats: two or three finish lines, worked in order
                                    # open a helper terminal to parallelize your work
mc search "<query>" --kind session  # find past sessions that did related work
```

Waiting on another terminal? Check `mc session focus <ID>` before interrupting anyone — it's free.

## Leads — a Robert for one goal

A **Lead** is a terminal (`role: lead`) that owns ONE goal in this workspace and runs it the way
Robert runs the wall: it opens workers, is woken when they stop, steers them, closes them, and
reports with a receipt. Design: `LEADS.md` in the chronos repo.

```bash
mc lead new "<goal>" [--description "the brief"] [--kind pr|investigation|qa]   # open one (refused from inside a Lead)
mc lead list                        # live Leads + how many workers each has open
```

- **If `MC_LEAD=1` you ARE a Lead.** Workers you open with `mc session new` are signed as yours; when
  one stops, the daemon types a "a terminal FINISHED ITS TURN…" message into you — look
  (`mc session focus <ID>`), then `mc session send <ID> "…"` / `mc session key <ID> …` / `mc session done <ID>`.
  Full authority inside your goal (merge, deploy, close). One prohibition: no communication outside
  Chronos — no Slack, email, Telegram, third-party messages or outside PR comments. Close your workers
  before `mc goal done`.
- **If you are a worker under a Lead**, nothing changes for you: stop cleanly with your Summary and
  the Lead picks it up. `mc ask-robert` still reaches Robert.
- Reach for a Lead only when a goal is several terminals' work; a one-terminal task is just a terminal.

## Jobs — headless agents on a schedule

```bash
mc job list
mc job run <id|name>                # dispatch now
mc job new --name "…" --goal "…" [--cron "0 9 * * 1-5" | --at "2026-09-20 09:00"] [--cwd dir] [--sandbox guard|strict|off]
mc job update <id|name> [--cwd dir] [--sandbox guard|strict] [--model m] [--cron "…"] [--enabled false]
```

`--cwd` must be inside this workspace's repos/worktrees/landing dir (or exactly `$HOME`), and `--sandbox`
can't go below the workspace floor — either is refused with the reason, never silently swapped.

Only when the operator asks for recurring or scheduled work.

## Writing as the operator — `mc prose`

Anything that goes out under the operator's name — a Slack message, a Jira/ClickUp comment, an email,
a status note — must sound like **him**, not like a model. Each workspace learns how he writes there.

```bash
mc prose --channel slack --about "PR is merged, deploy tomorrow"   # guide + his closest real messages
mc prose add --channel slack "<text he actually sent>"            # he pasted his own message: save it
mc prose add --channel jira --draft "<your draft>" "<what he sent instead>"   # he rewrote you: save the pair
```

- **Before drafting, run `mc prose`.** Match his length, openings, structure and words. Always English,
  even when his samples or his prompt to you are in another language.
- **He rewrote your draft? Save the pair** with `--draft`. That gap is the best lesson there is.
- Only his own words go in — never your draft alone, never a colleague's message, never Chronos output.
- The guide (memo `prose-guide`) re-learns by itself once enough new samples land; `mc prose learn` forces it.

## Slack (when connected)

If this workspace has Slack connected, you have Slack MCP tools scoped to THIS client only. Use them
for context or to post when asked. Never cross-post between workspaces.

## Rules

- **Stay in your workspace.** You cannot read other clients' repos; don't try.
- **Card first**: retitle early, `waiting`/`blocked` instead of silent, details → Next steps → `Summary:` last, then `mc goal done`.
- **Recall before building; `mc remember` what the operator says must always hold; `mc learn` what you noticed.**
- **Worktree before your first write**, push before you finish.
- **Out-of-scope follow-up → `mc pad add`**, never just a line in your Summary that nobody will act on.
- **Chronos tickets are not how this operator works anymore.** Don't file tickets or look for a
  backlog; the Desk terminal and its goal are the unit of work. (A headless dispatched run gets its own
  protocol in its prompt — follow that when you're in one.)

## Token-efficient tools

- Prefer **fff** MCP tools (`fffind` / `ffgrep` / `fff-multi-grep`) for repo search when available —
  fewer grep round-trips, less context burned.
- Shell commands that RTK knows (`git status/diff/log`, `gh`, `rg`, `npm test`, …) are rewritten
  transparently when RTK is installed — you keep writing normal commands; the output is compressed.
- Prefer short Focus narration over dumping tool transcripts into the story.
