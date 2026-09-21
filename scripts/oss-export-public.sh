#!/usr/bin/env bash
# Build a single-commit public tree with no private history.
#
# HEAD was scrubbed of client names, but older commits still carry notes/,
# skills-vault/<client>/, agents/_retired/, and real eval tickets. Making the
# existing remote public would publish that. This script writes an orphan
# branch you can push to a *new* public repo (or force-push after a backup).
#
# Usage (from a clean checkout of the scrubbed tip):
#   ./scripts/oss-export-public.sh
#   git push -u <public-remote> oss-public:main
#
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree dirty — commit or stash first" >&2
  exit 1
fi

# Refuse to export if client names reappear on HEAD.
if git grep -niE 'galley|medialab|gofundme|jelly-|incro\b|shareout|finanzas|leonelfernandez|galley-solutions' \
  -- ':!node_modules' ':!dist' ':!package-lock.json' ':!scripts/oss-export-public.sh' >/tmp/oss-scrub-hits.txt 2>/dev/null; then
  echo "client-name hits still on HEAD — refuse to export:" >&2
  cat /tmp/oss-scrub-hits.txt >&2
  exit 1
fi

TIP=$(git rev-parse HEAD)
BRANCH=oss-public
git branch -D "$BRANCH" 2>/dev/null || true
git checkout --orphan "$BRANCH"
git add -A
git commit -m "$(cat <<'EOF'
Chronos: public release

Single-commit export with no operator or client history. Clone this tip,
not the private development remote, when distributing.
EOF
)"

echo
echo "orphan branch '$BRANCH' ready (from $TIP)."
echo "Push to a NEW public remote, e.g.:"
echo "  git remote add public git@github.com:<you>/chronos.git"
echo "  git push -u public $BRANCH:main"
echo "Do not force-push over the private remote until you have a backup."
