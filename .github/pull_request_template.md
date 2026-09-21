<!-- CONTRIBUTING.md has the bar in full. This is the short version. -->

## What this changes, and the failure that forced it

## Checks

- [ ] `npm test` green (unit suite **and** `evals/`)
- [ ] `npx tsc -p tsconfig.json --noEmit` clean
- [ ] I read my own diff, including files I did not mean to touch
- [ ] No path built from a literal home-relative location (`src/repo-root.ts` instead)
- [ ] Any new endpoint taking a run or ticket by id calls `checkScope`
- [ ] If I added something an agent must always be told, `evals/` asserts it
