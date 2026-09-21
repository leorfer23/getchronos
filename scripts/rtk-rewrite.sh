#!/usr/bin/env bash
# Chronos-managed RTK PreToolUse hook (Claude Code / Grok).
# Upstream: https://github.com/rtk-ai/rtk/blob/master/hooks/claude/rtk-rewrite.sh
# Requires: rtk >= 0.23.0, jq. No-ops cleanly when either is missing.
#
# Exit code protocol for `rtk rewrite`:
# 0 + stdout  Rewrite found → auto-allow with updatedInput
# 1           No RTK equivalent → pass through
# 2           Deny rule → pass through (native deny)
# 3 + stdout  Ask rule → rewrite but let the CLI prompt

if ! command -v jq &>/dev/null; then
  exit 0
fi

if ! command -v rtk &>/dev/null; then
  exit 0
fi

CACHE_DIR=${XDG_CACHE_HOME:-$HOME/.cache}
CACHE_FILE="$CACHE_DIR/rtk-hook-version-ok"
if [ ! -f "$CACHE_FILE" ]; then
  RTK_VERSION_RAW=$(rtk --version 2>/dev/null)
  RTK_VERSION=${RTK_VERSION_RAW#rtk }
  RTK_VERSION=${RTK_VERSION%% *}
  if [ -n "$RTK_VERSION" ]; then
    IFS=. read -r MAJOR MINOR _ <<<"$RTK_VERSION"
    if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 23 ]; then
      exit 0
    fi
  fi
  mkdir -p "$CACHE_DIR" 2>/dev/null
  touch "$CACHE_FILE" 2>/dev/null
fi

INPUT=$(cat)
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")
[ -z "$CMD" ] && exit 0

REWRITTEN=$(rtk rewrite "$CMD" 2>/dev/null)
EXIT_CODE=$?

case $EXIT_CODE in
  0) [ "$CMD" = "$REWRITTEN" ] && exit 0 ;;
  1|2) exit 0 ;;
  3) ;;
  *) exit 0 ;;
esac

if [ "$EXIT_CODE" -eq 3 ]; then
  jq -c --arg cmd "$REWRITTEN" \
    '.tool_input.command = $cmd | {
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": .tool_input
      }
    }' <<<"$INPUT"
else
  jq -c --arg cmd "$REWRITTEN" \
    '.tool_input.command = $cmd | {
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": "RTK auto-rewrite",
        "updatedInput": .tool_input
      }
    }' <<<"$INPUT"
fi
