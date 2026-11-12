# Briefs

A **brief** is one page per project that tells the assistant what the project is and what you want
from it. It is how he stays aligned with your goals without being told again every morning.

Open them from Desk → ⋯ → 📋 **Briefs**.

## The sections, and who writes each

| Section | What goes in it | Written by |
|---|---|---|
| **What this is** | the project in a few lines | you |
| **What the operator wants (goals)** | what you are trying to get done here | you |
| **How work is done here** | branches, review habits, where things deploy | you (the assistant may add facts) |
| **Standing orders** | your rules for this project (below) | **only you** — he can propose a change, never make it |
| **Recently** | the last 12 finished pieces of work, one line each | the daemon |
| **Next** | follow-ups still open, as `- [ ]` items | the daemon |

**Recently** and **Next** fill themselves: when a terminal with a goal ends, or a build finishes, a
cheap model writes one line about what it was, how it ended and what it left pending. A later piece of
work that turns out to be that follow-up ticks it off.

## Standing orders

Five labels, each one line or a few:

```
- Ship: open a PR to main; squash merge
- After merge: npm run deploy, then check /health
- Robert may do alone: merge a green PR that only touches docs
- Ask first: anything touching billing or migrations
- Never: force-push, deploy on Fridays
```

They outrank the assistant's defaults. *May do alone* he just does; *Ask first* he hands to you;
*Never* he never does; *Ship* and *After merge* are the steps a Ship terminal follows once you say
yes. An empty label is not a rule — leave it blank until you have one.

## How it is used

- The project's brief is in front of the assistant on every turn for that project (about 3,000
  characters; Standing orders, goals, Next and Recently are kept first so a long page never pushes them
  out).
- When nothing is running, the assistant's look at the project starts from the brief's goals,
  Standing orders and Next.
- Briefs are the assistant's, not the workers'. Workers get the project's [memory](memory.md).
- A brief is an ordinary memo (`notes/<project>/robert-brief.md`), searchable like any other.

---

**Under the hood:** `src/briefs.ts` (sections, caps, Standing orders) · `src/worklog.ts` (Recently and
Next) · `src/ship-loop.ts` and `src/robert-selfwake.ts` read the Standing orders ·
[MISSION-CONTROL.md §10](../../MISSION-CONTROL.md).
