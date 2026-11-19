#!/usr/bin/env bash
# Refuses a push that carries a private name (a real workspace, client or account) into this public
# repo. The list itself is private, so it never lives here: one case-insensitive pattern per line in
# `.oss-names.local` (gitignored) or the file named by CHRONOS_OSS_NAMES. No list = nothing to check.
# Scans the tree at HEAD and every commit message in the push range.
set -euo pipefail
list="${CHRONOS_OSS_NAMES:-$(git rev-parse --show-toplevel)/.oss-names.local}"
# A linked worktree has no copy of the gitignored list: without this the check passed there, silently.
# Fall back to the main checkout's (the folder that holds the shared .git).
if [ ! -s "$list" ] && [ -z "${CHRONOS_OSS_NAMES:-}" ]; then
  main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
  [ -s "$main/.oss-names.local" ] && list="$main/.oss-names.local"
fi
[ -s "$list" ] || exit 0
pat=$(grep -v '^\s*#' "$list" | grep -v '^\s*$' | paste -sd'|' -)
[ -n "$pat" ] || exit 0
# As a pre-push hook git passes (remote, url) — not a range — so the range is never taken from args.
if git rev-parse -q --verify origin/main >/dev/null; then range="origin/main..HEAD"; else range="HEAD"; fi
hits=$(git grep -niIP "$pat" HEAD -- . ':!static/vendor' || true)
msgs=$(git log --format='%h %s%n%b' "$range" 2>/dev/null | perl -ne "print if /$pat/i" || true)
if [ -n "$hits$msgs" ]; then
  echo "check-names: private names found — not pushing." >&2
  [ -n "$hits" ] && echo "$hits" | cut -c1-200 >&2
  [ -n "$msgs" ] && echo "commit messages:" >&2 && echo "$msgs" >&2
  exit 1
fi
