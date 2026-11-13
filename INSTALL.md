# Installing Chronos — instructions for an agent

You are installing Chronos for a person, on their Mac. Follow these steps in order. Run the commands
exactly as written. Do not improvise around a failure: every failure prints the one command that fixes
it — run that, or hand it to the person.

Chronos is a local app: one background process on this Mac plus the Desk (a Mac app, or a page at
`http://localhost:7777/desk`). Installing it touches only its own folder (`~/chronos` by default),
`~/.mc`, `~/Applications/Chronos.app` and two login items (`sh.chronos.daemon`, `sh.chronos.app`).
Nothing needs `sudo`.

## 1. Check the Mac

```bash
sw_vers -productVersion   # macOS — Chronos is built for it
node -v                   # must be v22 to v26
git --version             # comes with Apple's command-line tools
```

- No Node, or a version outside 22–26: the installer prints the exact fix (Homebrew `node@24`, or nvm).
  Run it, then continue.
- No git: run `xcode-select --install`. That opens a dialog — **HUMAN STEP**: tell the person to click
  "Install" and wait for it to finish. Then continue.

## 2. Install

One command. `--yes` lets setup install a missing agent CLI and start its sign-in without asking;
`--json` ends the output with a report you can read.

```bash
curl -fsSL https://raw.githubusercontent.com/leorfer23/getchronos/main/install.sh | bash -s -- --yes --json
```

Or, step by step (same result):

```bash
git clone https://github.com/leorfer23/getchronos.git ~/chronos
cd ~/chronos && npm ci && npm run setup -- --yes --json
```

To use another folder or port, put `CHRONOS_DIR=…` (installer only) and `CHRONOS_PORT=…` in front of
the command.

If you must not install login items (a CI box, a sandbox, or the person said so), Chronos does not
start on its own: clone and install, start it in the background yourself, then run setup with
`--foreground` (the Desk then opens in the browser instead of the app):

```bash
git clone https://github.com/leorfer23/getchronos.git ~/chronos && cd ~/chronos && npm ci
nohup npm start > chronos.log 2>&1 &
npm run setup -- --foreground --yes --json
```

Setup takes a few seconds when everything is already there; installing a CLI or building the app the
first time takes a minute or two.

## 3. Check it worked

```bash
curl -s http://localhost:7777/api/health    # → {"ok":true}
```

The last thing setup prints (on stdout, with `--json`) is the report:

```json
{ "ok": true, "exit": 0,
  "checks": [ { "id": "claude", "ok": true, "line": "Claude Code 2.1.322 — Claude Max subscription, answered in 3.1 s", "fix": null } ],
  "human_steps": [],
  "desk": { "opened": "app", "reopen": "Chronos is in your Applications folder" } }
```

The report also carries `optional`: extras this Mac doesn't have yet (a nicer voice, speech-to-text,
Telegram, the phone…), each with its `how`. None is needed — don't install them unless the person asks.

Exit codes: **0** Chronos is running and at least one agent CLI works · **2** nothing could be
installed or signed in because nobody could be asked — run again with `--yes` · **1** something else;
each check with `"ok": false` carries its `fix`.

Running setup again is safe and fast: `cd ~/chronos && npm run setup -- --yes --json`.

## 4. Hand back to the person

- Every line that starts with `HUMAN STEP:` (also in `human_steps`), word for word. Signing in to Claude
  or ChatGPT happens in their browser; setup waits up to 3 minutes for it, then moves on.
- Each failed check's `fix`, if you could not run it yourself.
- How to get back to the Desk: the report's `desk.reopen` — "Chronos is in your Applications folder",
  or `npm run desk` in the Chronos folder (it opens the Desk in the browser, signed in).
- Tell them the Desk is open (`desk.opened` is `"app"` or `"browser"`).

## Do not

- **Do not edit files in the Chronos folder.** It is the running app, not a project to work on.
  `CLAUDE.md` there is for people changing Chronos itself — do not follow its workflow to install.
- **Do not run `npm run deploy`.** It runs the test suite and restarts Chronos; setup is the install.
- **Do not read, print or copy `.admin-token`.** `npm run desk` signs a browser in without it.
- **Do not install other login items** (`npm run install:launchd -- --all` and the like). Setup installs
  the two Chronos needs.
- **Do not pass `--replace-existing` or `--force-update`** unless the person asked: they take over a
  Chronos set up from another folder, or update a checkout that has someone's changes in it.
- Do not use `sudo`, and do not install Node or the agent CLIs some other way than the printed fixes.

## If something goes wrong

| What you see | Do this |
|---|---|
| `Chronos needs Node 22–26` | run the fix it prints, open a new shell, run the install command again |
| `Port 7777 is taken by another program` or `Another Chronos is already running on port 7777` | `CHRONOS_PORT=7778` in front of the install command |
| `Chronos from <folder> already starts at login on this Mac` | there is already a Chronos here: run `npm run setup -- --yes --json` in that folder instead, and tell the person |
| `… has local changes — not updating it` / `… is on branch …` | someone works in that checkout: leave it; use `CHRONOS_DIR=$HOME/getchronos` for a new one, or ask the person |
| `better-sqlite3` / `node-pty` fails to load, `NODE_MODULE_VERSION` mismatch | `cd ~/chronos && rm -rf node_modules && npm ci`, then setup again |
| `Chronos was started but isn't answering` | `tail -20 ~/chronos/chronos.err.log` and report what it says |
| No agent CLI ready (`"exit": 1`) | run each failed check's `fix`; sign-ins are a `HUMAN STEP` |
