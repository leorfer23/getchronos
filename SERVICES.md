# Services — always-on processes

A **service** is a plain command the daemon keeps running all day for a workspace: a Slack bot on
Socket Mode, a local API, a file watcher. It is the third kind of thing Chronos runs:

| | What it is | Lifetime |
|---|---|---|
| Terminal | an agent session on the Desk | until its goal is done |
| Job / run | a scheduled or headless agent run | one run |
| **Service** | a non-agent process | always, until it is switched off |

Code: `src/services.ts` (supervisor), `src/service-routes.ts` (`/api/services`),
`src/store/services.ts` (migration 152), `mc service` in `scripts/mc`, the Services page in
`static/desk.html`.

## What the daemon does for one

- **The switch is `enabled`.** On = start it now and again at every boot. Off = stop it and leave it.
- **It runs in a pty** (`localHost.spawnPty`), as `/bin/bash -c <command>` in its `cwd`, so its output
  is a terminal's — colours and all. The Desk tails it in a read-only xterm.
- **Env:** the workspace's own (`childEnv`: the allowlist, the workspace `secrets_file`, its shared
  vars), then the service's `env`, then `MC_SERVICE=<name>`. Values never leave the daemon: the API
  returns `env_keys` only.
- **Restart policy** on an exit it did not cause: `always` (default), `on-failure` (non-zero exit or
  a signal only), `never`.
- **Backoff:** 1s, 2s, 4s, 8s, 16s (max 60s). After **5 restarts in a row** none of which stayed up
  **60s**, it is a **crash loop**: status `crashed`, the operator is told once (desktop notification,
  Desk toast, `service.alarm` on the bus), and it is tried again every **10 minutes** while switched
  on. On a laptop the cause is often outside the service (woke up with no network, a VPN not up yet),
  and a bot that stays down until someone notices is exactly what this is for. A run that stays up 60s
  clears the alarm.
- **Stop** = SIGTERM to its process group, SIGKILL after 10s.
- **Logs:** a 256k-character ring in memory (what the Desk and `mc service logs` read) and
  `service-logs/<id>.log` on disk, rotated at 5 MB, 3 kept. The supervisor writes its own dim
  `── <time> chronos: … ──` lines into the same stream: started, exit code and uptime, restarting in…,
  crash loop, deployed.
- **Resources:** a service is a root of the process ledger as owner kind `service` (RESOURCES.md).
  Its CPU/RAM counts against its workspace's budget and shows on the Desk and in `mc service ls`. The
  ladder never renices or pauses it: a reniced or SIGSTOPped bot is an outage, not a lighter
  workspace. When it stops, the leak reaper cleans up what it left, like any ended owner.
- **Deploy** (`ref` set): `git fetch origin <ref>` and `git checkout --detach FETCH_HEAD` in its cwd
  (with the workspace's env, so its git credentials), then a restart if it is on. **Refused when
  tracked files have uncommitted changes**, so a deploy never discards work. Give a service its own
  worktree; never point it at a checkout agents work in.

## Daemon restarts

A service's lifetime is the daemon's. A graceful daemon exit SIGTERMs every service. Boot
(`startServices`, `index.ts`) reconciles the rows: a process the previous daemon left running is
stopped first (same pid **and** same start time; a recycled pid is never signalled), stopped rows are
reset, and every enabled service starts again with a fresh streak. So `npm run deploy` means a few
seconds offline per service. A service that cannot afford that needs to catch up on what it missed
when it starts again.

## Trust

A service runs as the daemon's user, **outside the agent sandbox**, the same trust as a launchd agent.
So everything that changes what runs, or whether it runs, is **operator-only** (admin token):
defining, editing, deleting, start/stop/restart/deploy. A workspace token may read its own
workspace's services and logs (404 for another's). An agent that needs a restart asks the operator.
It never kills the process itself.

## Commands

```bash
mc service add bot --workspace acme --cwd /Users/operator/work/acme-bot --command "./run.sh" \
  --ref main --env LOG_LEVEL=info --start          # define it and switch it on
mc service ls                                      # ● on / ○ off · state · uptime · CPU/RAM
mc service logs bot -f                             # follow its output
mc service off bot | on bot | restart bot
mc service deploy bot                              # fetch + check out --ref, restart
mc service edit bot --command "./run.sh --verbose" --unset LOG_LEVEL
mc service rm bot                                  # stops it; the log stays on disk
```

`:id` in the API (and the name in `mc service`) is the service id, or its name when that name is
unique among what the caller sees (add `--workspace <slug>` otherwise).

## API

```
GET    /api/services[?workspace=]        list, with live CPU/RAM and uptime
GET    /api/services/:id
GET    /api/services/:id/logs?from=N     output since offset N (or ?tail=chars) → {from,to,data,truncated}
POST   /api/services                     {workspace,name,command,cwd,description?,ref?,restart?,env?,start?}  (admin)
PATCH  /api/services/:id                 definition fields; env merges (null removes)                         (admin)
DELETE /api/services/:id                                                                                      (admin)
POST   /api/services/:id/start|stop|restart|deploy                                                            (admin)
```

Bus: `service.changed` {service_id, workspace_id, name, status} on every state change,
`service.alarm` {…, reason} when one gives up.

## Not yet

- Brain only: a service runs on this Mac, not on a joined host.
- No health probe beyond "the process is alive". A wedged process that stays up looks healthy.
- No per-service sandbox profile. The operator-only boundary is the control.
