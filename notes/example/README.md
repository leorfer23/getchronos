# `notes/` — what the daemon writes here

**The database is the source of truth.** These `.md` files are a one-way mirror the
daemon rewrites whenever a memo changes, so you can read, grep, and diff your agents'
memory with ordinary tools. Editing a file here does **not** change what an agent sees;
edit the memo instead (`mc memo edit <slug> --body "…"`) and the file follows.

One directory per project, named by its slug. Everything under `notes/` is gitignored
except this example — it is your own operational memory, and much of it will be
confidential.

## The three memos that matter

| File | Scope | Injected into |
|---|---|---|
| `workspace-instructions.md` | one project | every agent working that project |
| `session-learnings.md` | one project | agents on that project, by relevance |
| `operator-profile.md` | global | every agent, everywhere |

`workspace-instructions.md` is the standing brief: mission, repos, conventions, git
workflow, where the data lives. You write it once and revise it when a rule changes.

`session-learnings.md` is written *by* the agents. When a run discovers something a
future run would have to rediscover — a build flag, a flaky test, a deploy gotcha —
it appends a bullet. `mc learn "<fact>"` is the manual version. The daemon compacts
this memo on its own once it grows large; see `src/hygiene.ts`.

`operator-profile.md` is who *you* are: how you want to be talked to, what "done"
means, when to escalate instead of guess. It is the smallest of the three and the one
that changes least.

## Copy the templates

```bash
mkdir -p notes/<your-slug>
cp notes/example/workspace-instructions.md notes/<your-slug>/
```

…then import them so agents can actually see them — a file on disk that was never
imported is invisible to every agent:

```bash
mc memo set workspace-instructions --file notes/<your-slug>/workspace-instructions.md
```
