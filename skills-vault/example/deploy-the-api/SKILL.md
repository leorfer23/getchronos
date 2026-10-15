---
name: deploy-the-api
description: Ship example-api to production. Use when asked to deploy, release, or roll back the API.
tags: [deploy, example]
---

# Deploy example-api

The shape of a project skill: the steps you would otherwise have to repeat in every prompt, and
the two or three things that have gone wrong before.

## Steps

1. `git fetch && git status` — the deploy builds from the checkout, so a dirty tree ships your
   uncommitted work.
2. `npm test` — green before you build, not after.
3. `npm run build`
4. `./deploy.sh production`
5. `curl -sf https://api.example.com/health` — it must return 200 before you call it done.

## Gotchas

- The deploy script is not idempotent: running it twice leaves two workers with the same name and
  the second silently wins. If you are unsure whether it ran, check before re-running.
- A failed health check does not roll back on its own. `./deploy.sh production --rollback` does.

## Never

- Deploy from a branch. Production builds from the default branch only.
