---
name: agent-coordination
description: Coordinate with other Desk terminals and Robert — see who is working or blocked, read another terminal, wait for one to settle, split work into a helper terminal, and hand off to Robert. Use when your work depends on another terminal, you want to parallelize, or you need Robert to decide or pick something up.
category: ops
tags: [desk, robert, terminals, wait]
version: 3
---

# Agent coordination (Chronos Desk)

The unit of work is a **Desk terminal**: one goal, one shape of work, one state dot. The operator
watches a rail of terminals ordered by who needs them; **Robert** sees every terminal at once, wakes
when one finishes or blocks, and opens the next one himself. Coordination is terminals reading and
waiting on each other, and Robert deciding what you can't.

> **Robert is the only executive.** A `@handle` without an `agents/<id>/` directory wakes nobody.
> Anything outside the fleet's reach — a calendar, a mailbox, a repo nobody can write to — is unowned:
> say so rather than routing it somewhere.

## When to use

- Your work depends on another terminal finishing (a migration, a PR, an investigation)
- You want to split work into a helper terminal
- You need a decision, or something picked up after you're done

## Quick reference

States: `idle` · `working` · `blocked` · `done` · `unknown` — **settled** = `idle` | `done` | `blocked`
Card dots: 🟢 working · 🟠 your turn · 🔴 blocked · ✅ done

```bash
# Who's doing what (this workspace)
mc agents                            # 🔴/🟢/✅ · who · blocked reason   (--all adds recently settled)
mc session list                      # live terminals + ids
mc session focus <ID> [-n 20]        # what one terminal is doing, in plain English (read-only, free)

# Wait for another terminal to settle — blocks server-side, never busy-poll
curl -s -X POST "http://localhost:7777/api/sessions/<ID>/wait" \
  -H "x-mc-workspace-token: $MC_WORKSPACE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"until":"settled","timeout_ms":300000}'
# 200 = settled (body has the state) · 408 = timed out · until also takes "done", "blocked", or a list

# Split work into a helper terminal
mc session new --goal "backfill the 2025 partitions" --kind pr \
  --description "Context: … Done when: … Don't touch: …"

# Need a decision
mc ask-robert "migration terminal is blocked on prod creds — wait, or ship the PR without the backfill? I'd ship"
```

## Procedure

1. **Look before you wait.** `mc agents` / `mc session focus <ID>` — often the terminal you depend on
   already said what you need to know.
2. **Wait, don't poll.** `POST /api/sessions/<ID>/wait` with a `timeout_ms` that matches the work.
   On 408, re-check with `mc session focus` and decide: wait again, work around it, or ask.
3. **Split with a brief, not a sentence.** `mc session new --goal --kind --description`: the
   description becomes the helper's first prompt, so give it context, the done-condition, and what it
   must not touch. Point each terminal at its own `mc worktree` — never two terminals in one checkout.
4. **Decisions go to `mc ask-robert`.** One sentence, the options, your default. Robert answers the
   routine ones and puts the rest on the operator's phone with his recommendation.
5. **Walls go on your card.** `mc state blocked "<what you need>" --reason auth|approval|question` —
   that's what puts you in the operator's "needs you".
6. **Hand off through your `Result:`.** When you finish, the follow-up nobody is doing today goes in
   your closing `Result:` paragraph, then `mc goal done`. Robert reads finished terminals into the
   client's worklog and brief — that is the handoff. You don't post it anywhere else.

## Pitfalls

- **Waits pin the occupant.** A replacement terminal with a new id does not satisfy an
  in-flight wait on the old id — wait on the new id.
- **🟠 is ambiguous.** A terminal that finished its turn and one waiting for input both look like
  "your turn" and both count as settled. Read `mc session focus` before acting on a settled wait.
- **`state_label` is display-only**; waits and `mc agents` use the semantic state.
- **Nobody has a clock.** Never promise "I'll check at 9". A fixed time is a job
  (`mc job new --at "…"`); a condition is a wait.
- **Don't kill, retitle or type into terminals you didn't open.** `mc session kill`, `mc session goal`
  and `mc session send` on someone else's card are the operator's or Robert's call.
- **Don't file Chronos tickets or post to the board** to coordinate — the operator works from the
  Desk, and neither reaches them there.

## Verification

- `mc agents` counts match what the Desk rail shows (🔴 in "needs you").
- A wait returns 200 with a settled state, or 408 at your timeout — never hangs past it.
- A helper you spawned shows up in `mc session list` with the goal you gave it.
