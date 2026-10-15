#!/bin/bash
# Build and load the brain's menu bar item: desktop/hostbar.swift compiled into
# ~/.mc/bin/chronos-hostbar and started as the LaunchAgent sh.chronos.brainbar (with `--brain`), which
# shows the whole fleet from the daemon (HOSTS.md → Menu bar).
#
#   scripts/build-brainbar.sh              # install (or reinstall)
#   scripts/build-brainbar.sh --dry-run    # print the steps and the plist, touch nothing
#   node scripts/brainbar.mjs uninstall | status
#
# The logic lives in scripts/brainbar.mjs so it is tested (src/brainbar-install.test.ts) and shared with
# `npm run deploy`, which rebuilds the item only when it is installed and the Swift changed.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/brainbar.mjs" install "$@"
