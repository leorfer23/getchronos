# Session learnings — Example Project

Written by agents, not by you. Every bullet is something a run discovered that a
future run would otherwise have to rediscover. Append with `mc learn "<fact>"`.

Good bullets are specific and load-bearing:

- The integration suite needs `DATABASE_URL` pointing at the *test* database; against
  the dev database it passes locally and fails in CI, because the dev database has
  seed rows the fixtures assume are absent.
- `npm run build` must run before `npm test` — the tests import from `dist/`.
- The deploy script is not idempotent. Running it twice leaves two launchd jobs with
  the same label and the second one silently wins.

Bad bullets are things anyone could read off the repo ("this project uses TypeScript")
or that were only true once ("the build was broken on Tuesday").

The daemon compacts this file on its own once it grows past a few thousand characters.
