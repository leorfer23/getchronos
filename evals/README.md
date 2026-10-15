# `evals/` — does a dispatched agent still get told what it needs?

`npm run evals` (also runs as the tail of `npm test`).

`src/*.test.ts` covers whether the code does what it says. This covers something the unit tests
can't see: the **goal string** an agent actually receives. That goal is assembled from a dozen
sources — the ticket body, the repo's Definition of Done, its gate commands, every round of reviewer
notes, ranked lessons, attachments, ancestry, the worktree it will run in — and nothing asserted any
of it. Editing a template in `src/tickets.ts` was deploy-and-pray: a lost section doesn't throw, it
just makes the fleet behave worse, and you find out by watching an agent do something odd.

## How it works

The evals do **not** re-implement the composition — a second copy would drift and prove nothing.
They drive the real `dispatch*` functions (`dispatchTicket`, `dispatchPlan`, `dispatchPlanMerge`,
`dispatchGrade`, `dispatchCiFix`, `dispatchMergeGate`) and intercept the single choke point every
dispatch passes through, `jobs.create`, capturing the spec and throwing a sentinel. So the goal is
the genuine article, resolution logic included, while nothing spawns, no run row is written and no
worktree is created (ci-fix / merge-gate seed a temp git checkout just long enough for
`ensureTicketWorktree` to succeed, then wipe it).

```
evals/
  harness.ts        seed a case → dispatch → capture the goal
  cases/*.json      real tickets, snapshotted out of the live DB
  dispatch.eval.ts  the assertions
```

## The cases are real

```sh
npm run evals:export -- PER-4 PER-3 ACM-95
```

reads `~/chronos/chronos.db` and writes `evals/cases/<KEY>.json` — real title, real body, real repo
config, real reviewer notes. The evals replay those files, never the database: a check that read the
live DB would pass or fail depending on what the fleet was doing that morning, and wouldn't run at
all on another machine. Re-export when a real ticket exercises a shape the corpus is missing.

`gated-repo.json` is the one hand-authored case. **No repo in the live DB has `done_criteria` or
`gate_cmds` set**, so the real corpus cannot prove that either one reaches the builder — that case
covers the path until a real repo is configured, and should be replaced with an exported one when
it is.

## What is asserted

Each assertion is something that would otherwise regress silently and read as the model getting
worse rather than the prompt losing a section:

- **Every case** — the ticket key, title and file pointer; the progress protocol (`mc steps declare`
  / `mc step done`, without which a run looks stalled and gets killed); the ask-a-human instruction;
  the structured handoff and all five of its sections; the workspace-isolation line; the
  do-not-dismiss rule.
- **Repo config** — the Definition of Done and every gate command reach the builder.
- **Rework (PER-3)** — the goal leads with the rework notes and carries **every** review round,
  oldest first, with the newest marked. PER-3 oscillated because the builder was only ever shown the
  latest verdict; each round satisfied the newest reviewer by re-breaking an earlier one. That fix
  lives entirely in a template and nothing but this would catch its loss.
- **Plan runs** — read-only framing, scout-not-architect framing, `--wait 0` (a planner that parks
  holds a slot for nothing), and that `disallowed_tools` actually enforces what the prompt asks for.
- **Plan-merge** — still read-only / scout-not-architect; every scout lens label reaches the merge
  goal; `disallowed_tools` + `isReadOnlyRun(job.name)` so a merge never parks on an ask.
- **Grade** — read-only difficulty 1-5 scale, `mc grade`, no status flip; tool ban + `grade:` prefix
  so it never parks.
- **CI-fix** — the open PR URL, real inspection via `gh pr checks` / `gh run view --log-failed`
  (don't guess), push to the same branch, never open a new PR.
- **Merge-gate** — CI + final `gh pr diff`, repo gate commands, machine-readable
  `MERGE-GATE: APPROVE` / `HOLD` verdict lines, and the hard rule that Chronos owns `gh pr merge`.

## Adding a case

Export it, or write the JSON by hand for a shape the DB doesn't have yet. The
`for (const name of listCases())` loop picks it up and holds it to the standing protocol
automatically; add a named test only for an invariant specific to that case.

Note: `evals/` is outside `tsconfig.json`'s `include`, so it never lands in `dist/`. Its types are
checked by running it.
