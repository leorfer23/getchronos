# `skills-vault/` — per-project skills

A skill is a folder with a `SKILL.md`: a procedure you want agents to follow, loaded on demand
rather than pasted into every prompt. Chronos ships the generic ones in `skills/`; this directory
is for the ones that only make sense for one of *your* projects.

```
skills-vault/
  <project-slug>/
    <skill-name>/
      SKILL.md
```

Everything under here is gitignored except this README and `example/`, because a skill written for
one client tends to name that client's systems, schemas and people.

`mc skill` installs a vault skill into a project's config directory; see `skills/mission-control/`.
