# Why Chronos, not plain terminals

You already run Claude Code or Codex in a terminal. It works. Chronos is for the day you have four of
them open and spend more time watching tabs than shipping.

Chronos is one Node process on your Mac. It opens the same agent CLIs you already use, in real
terminals, and supervises them: it keeps them alive, gives each its own checkout, notices when one
stops, and puts what needs you in one place.

## Before and after

| Plain terminals | Chronos |
|---|---|
| A terminal dies with its window, or when the laptop restarts. | Terminals live in the daemon, not in a window. When the daemon restarts or crashes, each one comes back on its own transcript; one that was mid-work is told to continue. |
| You babysit. You find out it was waiting on a yes 40 minutes later. | An agent stops and asks. The question shows on its card, on your phone and to the assistant, with a button per option. |
| Two agents in one checkout overwrite each other. | Every agent that changes a repo gets its own git worktree. The main checkout is read-only to agents. |
| Nothing remembers yesterday. You paste the same context every morning. | Each project has memory: rules every agent loads, a brief, a log of what was finished and what is pending. |
| You check each tab to see who is done. | The assistant watches the fleet. It wakes when a terminal stops, answers routine questions, and tells you only what needs you. |
| Laptop only. | Phone and voice: triage from a phone, or talk to the assistant out loud. |
| No spend ceiling. A loop at 3am runs until morning. | Daily budgets (global and per project) for headless runs, plus a burn guard that stops new runs when runs per hour or dollars per hour spike. Every run's cost is recorded. |
| One login for everything. | Each project pins its own CLI account. A client's work is never billed to, or given the tools of, another account. |

## Your first session, in 5 minutes

1. **Install.** One line:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/leorfer23/getchronos/main/install.sh | bash
   ```
   It clones to `~/chronos` and runs `npm run setup`, which starts Chronos (and again at every login)
   and, after one yes, installs Claude Code if it is missing (and any CLI whose app you already use —
   ChatGPT, Cursor), signs you in in your browser, tries each agent CLI with one tiny prompt, and opens the Desk signed in — the **Chronos** app (it lands in `~/Applications`), or a
   browser tab on a Mac without Apple's developer tools. Lines that start with `HUMAN STEP:` are yours
   to do. Running setup again is safe. To have an agent do the install, give it
   [INSTALL.md](../../INSTALL.md) (it runs setup with `--yes --json`).

   Back to the Desk later: open the Chronos app, or `npm run desk` in `~/chronos` for a browser tab,
   already signed in (it uses a one-time code, never your admin token in a URL).
2. **Welcome.** One card, one step at a time, every step skippable: **name your assistant**
   ("Robert" unless you pick another), **your agents** (each CLI with Test, Sign in or Install, and
   whether agents get the same tools as your own Claude / ChatGPT), **your first project** (a folder —
   usually a git repo), **your phone** (optional), and **meet** the assistant. The last card also
   folds away a line of *Optional extras* — a nicer voice, speech-to-text, Telegram, your calendar… —
   each with the one thing that turns it on. `npm run setup` prints the same list.
3. **Open a terminal with a goal.** Press **+ Terminal** (or `N`). Pick the project and the CLI, type
   what you want done ("fix the flaky login test and open a PR"), press ⏎. A card appears on the rail.
4. **Watch Focus.** Open the card. **Focus** shows the goal and its "done when" checks, a progress bar,
   the questions it asked, and later its hand-off. The raw terminal is one key away (⌘E).
5. **Answer an ask.** When the agent needs a decision, its card turns to "needs you" and the question
   shows with one button per option. Tap one. The agent continues.
6. **Hand-off and PR.** When it is done, the agent files a hand-off: what changed, the proof, the PR
   link. You approve the merge (or merge and deploy) from that card.
7. **Ask the assistant what's next.** Press ⌘K and type "what now". You get four short sections:
   needs you, landed, underway, next.

Next: [Terminals](terminals.md) for the Desk in detail, or [The assistant](assistant.md).

## What it is not

- **Local.** It runs on your Mac. There is no hosted service and no account to create. Your data is a
  SQLite file and some markdown files on your disk.
- **One operator.** It is built for one trusted person. There are no users, roles or seats. The admin
  token is a single credential, not a login.
- **macOS for the sandbox.** The agent sandbox is macOS Seatbelt. The daemon runs elsewhere, but agents
  there run unsandboxed (and the daemon says so).
- **Not CI.** It drives agent CLIs, not build pipelines.
- **You bring the subscriptions.** Chronos drives Claude Code, Codex, Cursor, Grok and opencode on your
  own logins (setup installs and signs in the missing ones). It adds no fee; it tracks what each run
  cost.

---

**Under the hood:** terminals survive restarts in `src/terminal.ts` (`startTerminals`) + `src/revive.ts` ·
worktrees `src/worktrees.ts` · asks `src/asks.ts`, `src/ask-robert.ts` · memory `src/notes.ts`,
`src/memory-tree.ts` · the assistant's wakes `src/robert-drive.ts` · budgets and burn guard
`src/dispatcher.ts`, `src/burn-guard.ts` · accounts `src/config.ts` (profiles) · sandbox `src/sandbox.ts`.
