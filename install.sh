#!/usr/bin/env bash
# Install Chronos on this Mac:
#
#   curl -fsSL https://raw.githubusercontent.com/leorfer23/getchronos/main/install.sh | bash
#
# What it does, in order — nothing needs sudo, and running it again is safe:
#   1. checks for macOS (warns elsewhere), Node 22–26 and git, and prints the fix for whichever is missing
#   2. clones Chronos into ~/chronos (CHRONOS_DIR=… to pick another folder), or updates a clean,
#      idle checkout that is already there; it never touches a folder that isn't Chronos, a checkout
#      with local changes or on another branch, or one whose Chronos is running
#   3. installs its packages (skipped when they are already current), then runs `npm run setup`, which
#      starts Chronos, checks your agent CLIs and opens the Desk, signed in
#
# Flags after `bash -s --` go to `npm run setup` (e.g. `| bash -s -- --yes --json` for an agent), except
# --force-update, which updates a checkout with local changes or on another branch anyway.
# CHRONOS_REPO_URL clones from somewhere else (a fork, a local path when testing this script).
set -euo pipefail

# Everything lives in a function called on the last line: if the download stops halfway, bash has
# nothing half-defined to run.
main() {
  local dir="${CHRONOS_DIR:-$HOME/chronos}"
  local repo="${CHRONOS_REPO_URL:-https://github.com/leorfer23/getchronos.git}"
  local port="${CHRONOS_PORT:-7777}"
  local force=0 setup_args=() a
  for a in "$@"; do
    if [ "$a" = "--force-update" ]; then force=1; else setup_args+=("$a"); fi
  done

  say "Installing Chronos into $dir"

  # 1. What it needs.
  if [ "$(uname -s)" != "Darwin" ]; then
    say "  ! Chronos is built for macOS (agents run inside the Mac's sandbox). Continuing — expect gaps."
  elif ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
    # Checked before git: on a Mac without the developer tools, /usr/bin/git is a stub that pops a dialog.
    fail "Chronos needs git, which comes with Apple's command-line tools." "xcode-select --install" \
      "HUMAN STEP: click \"Install\" in the window that opens, wait for it to finish, then run the installer again."
  fi
  check_node
  git --version >/dev/null 2>&1 || fail "Chronos needs git." "xcode-select --install"
  say "  ✓ Node $(node -v | sed 's/^v//') and git"

  # 2. The code.
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    is_chronos "$dir" || fail "$dir already exists and isn't a Chronos folder — not touching it." \
      "curl -fsSL https://raw.githubusercontent.com/leorfer23/getchronos/main/install.sh | CHRONOS_DIR=\"\$HOME/getchronos\" bash"
    if curl -fsS -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      # A running Chronos has its packages loaded from this folder: a pull and `npm ci` under it can
      # break it mid-flight. Leave the code alone; setup reuses what is running and opens the Desk.
      say "  ✓ Chronos is already running — leaving $dir as it is"
    else
      update_checkout "$dir" "$force"
    fi
  else
    git clone --quiet "$repo" "$dir"
    say "  ✓ downloaded Chronos"
  fi
  cd "$dir"

  # 3. Packages (only when package-lock.json or node changed since the last install), then setup.
  local stamp="node_modules/.chronos-installed" want
  want="$(shasum -a 256 package-lock.json | cut -d' ' -f1) $(node -v)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    say "  ✓ packages already installed"
  else
    say "  … installing packages (about a minute the first time)"
    npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
    printf '%s\n' "$want" > "$stamp"
    say "  ✓ packages installed"
  fi

  # Setup may ask one question. Piped from curl, our stdin is the script itself — give it the terminal
  # when there is one; an agent (no terminal at all) passes --yes instead.
  if ( : </dev/tty ) 2>/dev/null; then
    npm run --silent setup -- ${setup_args[@]+"${setup_args[@]}"} </dev/tty
  else
    npm run --silent setup -- ${setup_args[@]+"${setup_args[@]}"}
  fi
}

say() { printf '%s\n' "$*"; }

# fail <what is wrong> <the one command that fixes it> [a line for a human] — then stop.
fail() {
  say "  ✗ $1"
  say "      $2"
  [ -n "${3:-}" ] && say "$3"
  exit 1
}

is_chronos() {
  [ -e "$1/.git" ] && [ -f "$1/package.json" ] && grep -q '"name": "getchronos"' "$1/package.json"
}

check_node() {
  local v major
  v="$(node -v 2>/dev/null || true)"
  major="${v#v}"
  major="${major%%.*}"
  if [ -n "$v" ] && [ "$major" -ge 22 ] 2>/dev/null && [ "$major" -le 26 ]; then return 0; fi
  # node@24 rather than `node`: Homebrew's `node` moves to the next major the day it ships, and a major
  # outside 22–26 is one nothing has been tested on.
  if command -v brew >/dev/null 2>&1; then
    fail "Chronos needs Node 22–26 (you have: ${v:-none})." \
      "brew install node@24 && echo 'export PATH=\"$(brew --prefix)/opt/node@24/bin:\$PATH\"' >> \"\$HOME/.zprofile\" && exec zsh -l   # then run the installer again"
  elif [ -n "${NVM_DIR:-}" ]; then
    fail "Chronos needs Node 22–26 (you have: ${v:-none})." "nvm install 24 && nvm alias default 24   # then run the installer again"
  else
    fail "Chronos needs Node 22–26 (you have: ${v:-none})." \
      "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . \"\$HOME/.nvm/nvm.sh\" && nvm install 24   # then run the installer again"
  fi
}

# A clean checkout of main, fast-forwarded. Anything else is someone's work in progress: say so and stop.
update_checkout() {
  local dir="$1" force="$2" branch dirty
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  dirty="$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null | head -1)"
  if [ "$force" != 1 ] && { [ "$branch" != "main" ] || [ -n "$dirty" ]; }; then
    local why="has local changes"
    [ "$branch" != "main" ] && why="is on branch $branch, not main"
    fail "$dir $why — not updating it, so nothing of yours is overwritten." \
      "curl -fsSL https://raw.githubusercontent.com/leorfer23/getchronos/main/install.sh | bash -s -- --force-update   # or: cd \"$dir\" && npm run setup"
  fi
  if git -C "$dir" pull --quiet --ff-only; then
    say "  ✓ updated $dir"
  else
    say "  ! couldn't update $dir (offline, or it has moved on) — using it as it is"
  fi
}

main "$@"
