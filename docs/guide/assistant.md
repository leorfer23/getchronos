# The assistant

The assistant runs your agents the way a lead runs a team. He is called **Robert** unless you give him
another name. He plans, opens terminals, unblocks, checks quality and tells you what matters. He does
not write the code himself — agents do that.

He answers what a few quick lookups settle; anything bigger (a fix, research, writing) opens a terminal with
your request and he tells you which in one line. ⚙ Settings → Robert → **What Robert does himself**.

## Talk to him

- **Desk:** 🤖 or ⌘K opens his chat. Type in plain words. ⌘⇧K puts him full screen.
- **Name a project with `#`:** `#acme what's left on the checkout bug?` Without a tag he works out the
  project from what you wrote (a ticket key, a repo name, the last project you talked about). If he
  cannot tell, he asks — he never guesses.
- **Phone, voice, Telegram:** the same assistant. See [Phone](phone.md) and [Voice](voice.md). On
  Telegram he proposes and you confirm.

Useful things to say:

- "what now" / "status" → four short sections: **Needs you · Landed · Underway · Next**. A quiet day
  is one line: "Quiet shop."
- "open a terminal on acme to fix the flaky login test"
- "every weekday at 9, check the nightly export and tell me if it failed" → a [job](jobs.md)
- "tell me when the PR for the login fix is merged" → a watch
- "remember: PRs on acme target develop" → [memory](memory.md)

## One per project

Behind the one chat there is one assistant per project: its own account, its own conversation, its
own [brief](briefs.md). That is how projects stay apart — he only sees the project he is working for.

## What he watches, and when he wakes

You do not need to ask. He wakes when:

- **a terminal stops** — it finished, is blocked, needs a decision, or is waiting on him;
- **an agent asks him** (`mc ask-robert`) — he answers what is routine and passes the rest to you with
  his recommendation (see [Asks](asks.md));
- **a terminal shows an on-screen question** (a menu, a y/n) — he answers it when it is plainly in
  scope and reversible; otherwise, or if he has not answered within a few minutes, it comes to you;
- **terminals are working** — every few minutes he looks over the project and pushes what is stuck;
- **nothing is running but something changed** (a green PR, a red job, a terminal left waiting) — he
  may open **one** terminal to move it, inside his hours (09–21 by default), at most one per project
  per hour. He never sends you a message for this; the terminal is the message.

Every wake is capped per terminal and per hour, so he cannot loop. Each switch lives in ⚙ Settings →
Robert, per project.

## What he never does

- **Send anything.** No email, Slack message, comment or review goes out from him or any agent. They
  leave a draft and tell you where it is. The send tools are removed from every agent CLI.
- **Move your screen.** He names the terminal or ticket; you tap it.
- **Mix projects.** Work for another project goes to that project's assistant.
- **Write standing orders.** Those are yours (see [Briefs](briefs.md)).

## He gets better

Correct him once ("don't ping me for green CI") and he writes it down as a rule — a lesson that
changes how every agent in that project works or reports.

## Daily buttons

- ☀️ **Start the day** — one terminal per project reads what happened and proposes today's work. Nothing
  starts until you answer.
- 🌙 **Plan tomorrow** (⋯ menu) — one planner per project files tomorrow's cards; ▶ Run on a card opens
  its terminal.

## Rename him

The first-run welcome asks for a name. Change it later in ⚙ Settings, or with
`PUT /api/assistant {"name": "…"}`. Only the name you see and hear changes.

---

**Under the hood:** persona `agents/robert/` + `agents/_blocks/` · one per project
`src/thread-router.ts` · wakes `src/robert-drive.ts`, `src/terminal-prompts.ts`, `src/robert-sweep.ts`, `src/robert-selfwake.ts`,
`src/wake-queue.ts` · watches `src/watches.ts` · no-send `src/no-send.ts` · lessons `src/lessons.ts` ·
☀️ `src/startday.ts`, 🌙 `src/nextday.ts` · switches `src/settings.ts` ·
[MISSION-CONTROL.md §5c](../../MISSION-CONTROL.md).
