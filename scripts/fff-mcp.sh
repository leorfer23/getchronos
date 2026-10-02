#!/usr/bin/env bash
# Chronos-managed launcher for the fff MCP server (fast repo search), installed to ~/.mc/bin by the
# daemon (src/efficiency-tools.ts) and registered as the `fff` command for claude, cursor and grok.
# Usage: fff-mcp.sh [/abs/path/to/fff-mcp] [extra fff-mcp flags…]
#
# fff indexes ONE base directory, by default the session's cwd. Two common cwds break that:
#   - $HOME or /: fff refuses to start ("Can not run certain FFF features in a file system root or
#     home directories"), so the CLI shows "fff failed to connect".
#   - a Desk landing dir (a folder of symlinked repos): fff does not follow symlinks, so it starts and
#     every grep says "0 matches" — silently useless.
# So the base is: $MC_REPO when it is a directory path (Chronos itself sets MC_REPO to a repo id, so
# for a Desk terminal the next rule decides); else the git toplevel of the cwd; else the cwd, unless
# that is $HOME, /, or a farm of symlinked repos — then say why on stderr and exit 0.

bin=""
if [ $# -gt 0 ]; then bin="$1"; shift; fi
if [ -z "$bin" ] || [ ! -x "$bin" ]; then bin=$(command -v fff-mcp 2>/dev/null || true); fi
if [ -z "$bin" ]; then
  echo "fff: fff-mcp is not installed (brew install dmtrKovalenko/fff/fff-mcp)" >&2
  exit 0
fi

base=""
if [ -n "${MC_REPO:-}" ] && [ -d "$MC_REPO" ]; then
  base="$MC_REPO"
else
  base=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi

if [ -z "$base" ]; then
  here=$(pwd -P)
  home=$(cd "$HOME" 2>/dev/null && pwd -P)
  if [ "$here" = "/" ] || [ "$here" = "$home" ]; then
    echo "fff: not indexing $here (home or filesystem root) — open the session in a repo, or set MC_REPO" >&2
    exit 0
  fi
  for entry in "$here"/* "$here"/.[!.]*; do
    if [ -L "$entry" ] && [ -d "$entry" ]; then
      echo "fff: $here is a landing dir of symlinked repos (fff does not follow symlinks) — cd into one repo, or set MC_REPO" >&2
      exit 0
    fi
  done
  base="$here"
fi

exec "$bin" --no-update-check "$@" "$base"
