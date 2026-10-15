# `local/` — your machine, not the repo

Everything in this directory is gitignored except this file.

Chronos is a personal operations daemon: sooner or later you will write a script that
only makes sense on your machine — a sync against your own bank export, a one-off
launchd job, a bot for your house. Those do not belong in a shared repo, but they do
belong next to the daemon so they can read its database and reuse its modules.

Put them here.

```
local/
  README.md              ← tracked (this file)
  my-sync.mjs            ← ignored
  com.example.job.plist  ← ignored
```

Reference them from launchd with an absolute path, exactly as you would a tracked
script. Nothing in `src/` may import from `local/` — the daemon must build and boot
on a clean clone with this directory empty.
