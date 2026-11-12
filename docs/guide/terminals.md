# Terminals

A **terminal** is a real terminal running an agent CLI (Claude Code, Codex, Cursor, Grok or opencode)
inside one project: its sandbox, its account, its memory. The **Desk** (`/desk`) shows them all.

## The Desk

- **The rail** (left) lists live terminals, sorted by who needs you: *needs you* → *to review* →
  *your turn* → *stalled* → *in flight*. Below it: **Notes** (parked thoughts) and **Recent** (ended
  terminals you can reopen with their context).
- **The stage** (right) shows the terminal you picked.
- **The bar** (top): counts, your CLI usage, ☀️ Start the day, 🤖 the assistant (⌘K), ⏰ open loops,
  ⋯ for Jobs, Briefs, Memory, Settings and the rest.

## Open one

- **Quick:** pick the project, CLI and model in the quick bar, type the goal, press ⏎. An empty ⏎ opens
  a blank terminal. The *ask* button beside it sets how far it may ship: ask → merge → merge + deploy.
- **Full dialog:** `⇧N` — working folder, a longer brief, several goals (one per line), which
  computer, or open it as a [Lead](leads.md).
- **From inside another terminal:** `mc session new --goal "…"`.

Write the goal as an outcome: "the login test passes on CI and a PR is open". The agent is told to turn
it into a goal plus 2–4 **done when** checks before it starts, and to ask if it is unclear.

## Focus

Open a card and you see **Focus**, not a wall of tool output:

1. **Goal** — the outcome, its done-when checks, a progress bar, a timer, time left, and what it may
   ship (*ask*, *merge* or *deploy*).
2. **Decisions** — every open question, with a button per option; then what was decided.
3. **Talk** — what you typed to it, its reply, and any screenshots it shows you.
4. **Hand-off** — the summary, what changed, the proof, before/after screenshots, the PR, and
   **Approve merge / deploy** buttons.

The raw terminal is always one key away: ⌘E. ◨ (⌘⇧T) puts a companion with the goal and the clock
beside it.

## The seven states

| State | Means | You |
|---|---|---|
| ■ blocked | hit a wall it cannot pass | look now |
| ? decide | a decision only you can make | answer it |
| ✓ review | finished — read the hand-off | approve or ask for changes |
| ↩ your turn | its turn ended | reply, or leave it |
| ! stalled | silent with no sign of work | look, then retry or kill |
| ⧗ waiting | waiting on CI, a subagent, a person… with an ETA | nothing |
| ● working | working | nothing |

The state comes from what the agent declares (`mc state`), its CLI's hooks, and the screen itself.
⌘J jumps to the next terminal that needs you.

## Hand-off and shipping

- The agent files its hand-off with `mc outcome` — written for someone who will not open the diff.
- Before you hear "ready", a verifier checks a hand-off that asks for a merge, review or deploy: the PR
  is open and mergeable, the repo's check command passes at the PR head, and a second model reads the
  diff against what you asked. A fail goes back to the agent first.
- A click on **Approve merge** types the approval into the terminal; the agent merges and says so.
- It never ships further than you allowed (ask / merge / deploy), set when you open it or on the Goal
  card.
- A green PR whose terminal already closed comes back once, in a **Ship** terminal that asks you one
  question.

## Quick actions

Each state shows a few one-tap chips under the terminal: ✓ Approve, 🔀 Merge, 🔍 QA pass,
▶ Continue, 🎲 Your call, ❓ Status, ⏸ Pause, ↻ Retry, 🤖 Ask Robert, ⏹ Kill. Edit the list, add your
own, or give one a key from the chips' edit button.

## It keeps going

- **Restarts and crashes:** terminals live in the daemon, not in a window. When the daemon comes back,
  each terminal reopens on its own transcript; one that was mid-work is told to continue.
- **Out of credits:** a terminal that hits its CLI's limit switches model, or opens a stand-in on the
  next CLI with the goal and the story so far (⚙ Settings → Failover). The old one stays open.
- **Ended:** reopen it from **Recent** (or `mc session reopen <id>`) with its context intact.

---

**Under the hood:** `src/terminal.ts` (open, revive) · states `src/term-status.ts` · Focus
`src/focus.ts` · hand-off and verifier `src/request-verifier.ts` · ship loop `src/ship-loop.ts` ·
quick actions `src/quick-actions.ts` · failover `src/terminal-failover.ts` · several goals
`src/goals.ts` · the agent's side: `skills/mission-control/SKILL.md`.
