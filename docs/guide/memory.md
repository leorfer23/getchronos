# Memory

In a plain terminal, every session starts from zero. In Chronos each project remembers — and the memory
is kept small enough that agents actually use it.

Memory is per project. One project's memory never reaches another's agents.

## What there is

- **The memory index** ★ — one short line per rule, grouped by topic ("PRs on acme target develop").
  Loaded into **every** agent's prompt in the project, first. Capped at 3,000 characters.
- **Hot memory** ★ (`memory-hot`) — what is live in the last two weeks, rebuilt by every dream pass.
  Also loaded into every agent. Capped at 1,500 characters.
- **Branches** (`memory-<topic>`) — the detail behind a topic. Not loaded; an agent reads one when the
  topic comes up.
- **Memos** — markdown notes. A memo marked ★ *context* loads into every agent; you can scope one to
  certain repos. 📌 pins it.
- **Lessons** — one-sentence rules learned from corrections and review verdicts, injected where they
  apply (builders, reviewers, or how agents write to you).
- **Skills** — reusable procedures. Only their names and one-line descriptions load; the full text is
  read on demand. New ones wait for your approval unless the project auto-publishes.
- **The worklog** — every finished terminal and build, summarized: what it was, how it ended, what it
  left pending. Searchable, never loaded whole.
- **Learnings inbox** — facts agents noticed (`mc learn`). Not loaded until they are sorted into the
  tree.

## Writing to it

- **Tell any agent or the assistant "remember …" / "from now on …"** — it runs `mc remember`, which puts
  the rule in the index right away:
  ```bash
  mc remember "PRs on acme target develop, never main" --topic git \
    --detail "main deploys to prod on merge"
  ```
- **Agents note facts they pick up** with `mc learn "…"` — that goes to the learnings inbox, not the
  index.
- **Edit it yourself:** Desk → ⋯ → 🧠 **Memory**. A change reaches an open agent on its next prompt.

## Reading it

Agents are told to search before they start work:

```bash
mc recall "flyway migrations"   # memos, skills, lessons and past sessions, ranked
mc memo get memory-git          # one memo in full
mc search "export bug"          # tickets, sessions, runs, jobs, skills
```

## The dream pass

Twice a day (13:00 and 22:00 by default, `CHRONOS_DREAM_HOURS`), one agent per active project tidies
its memory:

- sorts the learnings inbox into the tree,
- condenses the index and branches back under their caps,
- moves lines nobody has used in a while down a level, then to the archive.

Nothing is lost: anything it removes goes to `memory-archive`, and `mc dream undo <run>` puts the last
pass back. Run one now with `mc dream run`.

## Files you can read

Memos are rows in SQLite, mirrored one way to `notes/<project>/*.md`, so you can grep and diff them.
Edit through the Desk or `mc memo` — edits to the files are not read back.

---

**Under the hood:** `src/notes.ts` · `src/memory-tree.ts` · `src/recall.ts` · `src/lessons.ts` ·
`src/skills.ts` · `src/worklog.ts` · `src/dream-pass.ts` + `src/dream.ts` (agent: `agents/dreamer/`) ·
the agent's side: `skills/mission-control/SKILL.md` § Memory.
