# Projects

A **project** is a wall. Everything else lives inside one. (The code and the API call it a
*workspace*.)

It can be one repo, a product across several repos, a client, or a side project. Each project has its
own:

- **repos** — the checkouts its agents may work in
- **account** — the CLI login it is billed to (see below)
- **memory, brief and assistant thread** — nothing is shared with other projects
- **budget, concurrency and sandbox rules**
- **secrets and shared vars** — only its own agents get them
- **git identity** — the name and email on its commits

Nothing crosses from one project into another: not a prompt, a file, a memo or a terminal.

## Create one

- **First time:** the first-run welcome creates your first project from a repo on disk.
- **Later:** ask the assistant — "create a project acme with the repo at ~/code/acme, PRs to main".
- **From a shell on the daemon's Mac:**
  ```bash
  mc ws create acme --name "Acme" --config-dir ~/.claude-acme
  mc repo add web --path ~/code/acme-web --workspace <id> --branch main --delivery pr
  ```
  `mc ws create` also creates the config dir and a `0600` secrets file.

## Repos

A repo belongs to one project and carries its delivery rules:

- **delivery** — `pr` (open a pull request) or `commit` (push to the branch)
- **default branch**
- **gate commands** — the checks that must pass before a build is reviewed (tests, typecheck, build).
  Chronos can suggest them from the repo's own files.

## One account per project

A **profile** is a CLI config directory: its own login, settings, skills and MCP servers.

- `~/.claude` is always there as `claude`.
- Every `~/.claude-<name>` folder shows up as `claude-<name>`. Log in once inside it:
  `CLAUDE_CONFIG_DIR=~/.claude-acme claude`.
- Pin one on the project. That pin beats every default, so the project's work is billed to that
  account and gets only that account's tools.

## Settings per project

Desk → ⋯ → ⚙ **Settings**, then pick the project:

- default CLI and model, and which CLIs it may use
- daily budget and how many runs at once
- sandbox mode (`guard` by default)
- autonomy: auto-plan, auto-build, auto-review, merge gate, auto-merge
- who answers agents' questions: the assistant first, or always you
- the assistant's switches for this project (see [The assistant](assistant.md))

## Shared vars

Need to hand a project's agents an API key for a few hours? Desk → ⋯ → 🔑 **Shared vars**. Each var
can expire after N hours. Agents see the names with `mc vars`, never the values in a transcript.

---

**Under the hood:** `src/store/workspaces.ts` · isolation `src/child-env.ts`, `src/sandbox.ts` ·
profiles `src/config.ts` · settings `src/settings.ts` · `mc ws` / `mc repo` in `scripts/mc` ·
gate commands `src/gates.ts` · [MISSION-CONTROL.md §2–3](../../MISSION-CONTROL.md).
