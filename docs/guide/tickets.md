# Tickets

A terminal is work you watch. A **ticket** is work that runs without you: agents plan it, build it,
review it and open the PR. You approve at the gates you choose.

## The loop

```
ticket → plan → build → review → PR → merge gate → merged
                  ↑         │
                  └─ rework ┘
```

1. **File it.** Ask the assistant ("file a ticket on acme: the export drops the last row"), or
   `mc ticket new --title "…" --body "…"`. It gets a key like `ACM-14` and a markdown file the agent
   reads.
2. **Plan.** A read-only agent investigates and writes the plan, plus a difficulty grade 1–5. With the
   project's scout panel on, a hard ticket (4+) gets three scouts instead of one.
3. **Build.** An agent works in **its own git worktree** on a `mc/<key>` branch. It does not push yet.
4. **Gates.** The repo's own commands (tests, typecheck, build) run in that worktree. A red gate goes
   straight back to build — no reviewer is spent on code that does not build.
5. **Review.** A different agent — ideally a different vendor — reads the plan, the diff and the gate
   results and approves or asks for changes. Every earlier review round is fed back in full, oldest
   first, so a fix cannot re-break what an earlier round asked for. After 3 rounds it comes to you.
6. **PR.** On approval Chronos commits, pushes and opens the PR.
7. **Merge gate** (optional, per project). An agent re-checks CI and writes `APPROVE` (merge) or `HOLD`
   (back to build). Without it, a ticket PR with green CI merges on its own (`CHRONOS_AUTO_MERGE`, on by
   default).

## Who decides

- **Autonomy is off by default.** Each project has its own switches in ⚙ Settings: auto-plan,
  auto-build, auto-review, merge gate. With them off, a ticket waits until you or the assistant
  dispatch it.
- **Risk decides when you are needed.** Each change is tagged low / med / high from the files it
  touched (migrations, auth, deploy and money paths are high). Per repo you choose where a human is
  still required: always (the default), med, high or never.
- **The difficulty grade picks the model** (`CHRONOS_ROUTE_MODELS`), so a one-liner does not get the
  most expensive model.

## Useful commands

```bash
mc ticket list                 # this project's tickets
mc ticket get ACM-14           # one ticket
mc ticket link ACM-10 blocks ACM-12   # ACM-12 waits for ACM-10
mc goal ACM-1                  # a goal = a ticket with children: % done
mc reviews                     # what waits for your review
```

Tickets can mirror to Jira or ClickUp — see [More features](more.md).

---

**Under the hood:** goal templates `src/tickets.ts` · `src/dispatcher.ts` · plan `src/autoplan.ts` ·
scouts and review panels `src/panels.ts` · gates and risk tiers `src/gates.ts` · `src/reviews.ts` ·
`src/merge-gate.ts` · `src/delivery.ts` · [MISSION-CONTROL.md §5](../../MISSION-CONTROL.md) · `evals/`
asserts what each agent is told.
