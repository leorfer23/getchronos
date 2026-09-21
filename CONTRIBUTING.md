# Contributing

## Before anything else

Read `CLAUDE.md`. It is short, and every line in it comes from a real shipped bug or a destroyed
checkout. The two that catch people first:

- **Never edit the live checkout while a daemon is running in it.** The daemon runs `git add -A` in
  its own directory and will commit your half-finished work. Use `git worktree`.
- **In a worktree, run `npm ci`. Never symlink `node_modules`** from the main checkout —
  `git worktree remove --force` follows the symlink and empties the real one.

## Setup

```bash
npm ci
npm test                      # ~20s, in-memory database, no secrets required
npm start                     # foreground, on CHRONOS_PORT (default 7777)
```

`npm test` needs no configuration. If it wants a secret, that is the bug.

To try changes against a daemon without touching your real state:

```bash
CHRONOS_HOME=/tmp/chronos-scratch CHRONOS_PORT=7799 npm start
```

## The bar for a change

- **Tests green.** `npm test` runs the unit suite and then `evals/`, which replays fixture tickets
  through the real dispatch path. If you touch a goal template in `src/tickets.ts`, the evals are the
  only thing that notices a lost section — a missing block does not throw.
- **Typecheck clean.** `npx tsc -p tsconfig.json --noEmit`.
- **Branch → PR → merge.** Not straight to the default branch.
- **Read your own diff before asking anyone else to.** Especially watch for accidental reverts of
  files you did not mean to touch.

## What the code looks like

Match what is already there. Two conventions are worth stating because they are unusual:

**Comments explain why, against the failure that forced the decision.** `src/store/migrate.ts` is
1300 lines of schema changes each of which says what problem it was solving. `src/guard.ts` explains
which false positive each pattern exists to avoid. This is the most valuable thing in the repo and it
is worth the effort. A comment that restates the code is noise; a comment that records the bug you
would otherwise reintroduce is the point.

**A lost prompt section does not throw.** Most of what an agent is told is assembled from templates,
and deleting a section fails silently and looks like the model getting worse. That is what `evals/`
is for. If you add something an agent must always be told, add the assertion too.

## Things that will get a change sent back

- A test that calls the real `execute()` with a real backend. Use `backend: "mock"`.
- A new endpoint that takes a run or ticket by id without a project-scope check.
- A path built from `~/chronos` or any other literal home-relative location. Use
  `src/repo-root.ts`.
- A new default that requires configuration to be safe.

## Public remote

Day-to-day work targets **https://github.com/leorfer23/getchronos** (`origin`). PRs land there.

If client or operator names ever reappear on HEAD, do **not** rewrite this remote in place. Scrub,
then run `scripts/oss-export-public.sh` and push the orphan tip to getchronos (the same pattern as
the initial public release). The private development remote, if you have one, stays private.

## Reporting bugs

Include what you expected, what happened, and the smallest repro. `chronos.err.log` at the repo root
usually has the real error. For anything exploitable, see `SECURITY.md` instead.
