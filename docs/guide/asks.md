# Asks and the "needs you" list

Agents in Chronos stop and ask instead of guessing. Everything that needs you ends up in a few places,
and "not now" is a real answer.

## How an agent asks

- **From a terminal:** `mc ask-robert "…" --options "a,b"`. The [assistant](assistant.md) sees it
  first. He answers what is routine; the rest comes to you with his recommendation.
- **From a headless run** (a ticket build, a job): `mc ask "…"`. The run waits a while, then **parks**:
  it frees its slot, and when you answer — minutes or days later, across restarts — it resumes on the
  same conversation.
- **On-screen prompts:** a CLI's own menu or y/n turns the card orange. The assistant may answer it if
  it is plainly in scope; otherwise it is yours.

Want every question to come straight to you in a project? ⚙ Settings → that project → *Who answers
asks* → `escalate`.

## Where you see them

- On the terminal's **Decisions** card, one button per option (you can always type something else).
- At the top of the Desk rail (*needs you*) and in the bar's counts. ⌘J jumps to the next one.
- On your [phone](phone.md), and on Telegram if you set it up, with the options as buttons.

An unanswered ask is re-sent every 2 hours (`CHRONOS_ASK_REMIND_HOURS`).

## Approvals

- **Hand-offs:** *Approve merge* / *merge + deploy* on a terminal's hand-off card.
- **Reviews:** a ticket build waiting on you — `mc reviews`, or its card.
- **Stalled work:** when a run goes silent with no sign of life, you get a card to decide. Chronos
  never retries on its own — a retry of a run that failed for a real reason is the same failure, twice
  the cost.

## "Later" is an answer

Every ask, review and stalled-work card has ⏰ **Later**: +2h, tomorrow 9:00, +2d, or pick a date. The
item leaves the live list and comes back on that date with the same card. Only a real answer closes
it. (`mc ask hold <id> +2d "why"` does the same.)

## The inbox — things that came *to you*

If Slack or a tracker is connected, each project gets an inbox of what needs you there:

- **Slack:** new DMs, @mentions and notes to yourself (a read-only triage job files them).
- **Jira / ClickUp:** a task newly assigned to you, a comment that mentions you, a status change on
  your task.

By default each new item with real work in it opens its **own terminal** after 2 minutes (up to 3 at
a time per project) that investigates and proposes — it never replies to anyone. Thanks, FYIs and
repeats are closed instead. Turn it off in ⚙ Settings → Autonomy → *Inbox opens terminals*. The log is
⋯ → 📥 **Inbox log**.

## Open loops and `mc when`

⏰ on the Desk bar (or `L`) lists everything parked: work waiting on something, follow-ups, unanswered
questions, what runs on a clock.

A terminal waiting on something outside itself parks with `mc when` instead of polling:

```bash
mc when pr https://github.com/acme/web/pull/42 --until merged --note "then deploy"
mc when terminal 3fa9c1d2 --until done
mc when at "tomorrow 9:00"
mc when check "the vendor replied to the support email" --every 30m
```

When it fires, the work continues: typed into the terminal if it is still open, else reopened on its
transcript, else a fresh terminal with the hand-off. `mc when list` shows what is parked.

Park your own thoughts with **+ note** on the rail (`mc pad add`), and give one a follow-up time to
have an agent pick it up then.

---

**Under the hood:** `src/asks.ts` (park and resume) · `src/ask-robert.ts` · `src/terminal-prompts.ts` ·
holds `src/holds.ts` · stalled work `src/monitor.ts`, `src/recovery.ts` · inbox `src/inbox.ts`,
`src/inbox-dispatch.ts` · `mc when` `src/continuations.ts` · [MISSION-CONTROL.md §5b](../../MISSION-CONTROL.md).
