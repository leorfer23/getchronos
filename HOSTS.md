# Hosts — one Desk, N computers

> Status: **being built.** Phase 1 (the seam: `src/hosts/`, migration 134), phase 2 (link, join,
> host process, the hosts registry and the Desk's Computers panel), phase 3 (remote terminals,
> pinned + sticky), phase 4 (placement and the per-host governor), phase 5 (headless runs, the ship
> pipeline and the egress proxy on hosts) and phase 6 (onboarding: preflight, the `getchronos`
> package, self-update, uninstall) have landed; see *Phases*. This is the plan the implementation PRs
> follow; each phase at the end is one PR (or a short series) and updates this file when it lands.

## The gap

Chronos runs every agent CLI as a child of the daemon, on the daemon's Mac. One laptop is the whole
fleet's ceiling. Measured on the operator's 12-core / 18 GB M3 Pro on 2026-09-24: load 234, memory
pressure *warning*, swap 93%, ~16 idle `claude` CLIs holding 4.3 GB — while a 32 GB M2 Pro and a
24 GB M5 Pro sat on the same desk doing nothing.

The machine governor (`src/machine.ts`) can refuse new agents on a saturated Mac. It cannot give
them somewhere else to go. Hosts are that somewhere else.

## What it is

- **One brain, N hosts.** The brain is the Chronos you run today: daemon, DB, Desk, Robert,
  connectors, Telegram. A **host** is any Mac that runs agent processes for it. The brain is always
  also a host (`local`), so a single-machine install is exactly what it is today — no config, no new
  process, no new port.
- **A host is a small process, `chronos host`**, from the same codebase. It spawns PTYs and headless
  runs, owns its git checkouts and worktrees, builds its own sandbox profiles, tails its own CLI
  transcripts, and reports its vitals. It keeps **one outbound WebSocket** to the brain. Nothing
  connects *to* a host: no SSH, no Remote Login, no open port. That matters on company-managed
  (MDM) Macs, where enabling Remote Login alone can flag the machine as non-compliant.
- **Adding a computer takes two steps:**
  1. Desk → ⋯ → **Computers → + Add**. The brain mints a one-time join code and shows one command.
  2. On the new Mac: paste that command (today a node check + `git clone` + `npm ci` +
     `npm run host -- join`; once published, `npx getchronos host join <brain-url> <code>`). It
     installs a user-level LaunchAgent, stores its credential, connects, and shows up on the Desk
     with its vitals. After that, updates are a button on the Desk.
- **Policy lives on the brain, and the host has the last word.** The brain decides which workspaces
  a host may run and places work there. The host also keeps a **local veto list** in its own
  `.secrets`. The brain can never route a denied workspace to it, and neither can a bug in the
  brain's placement code.
- **The operator never has to think about hosts.** "+ Terminal" goes wherever there is room. A
  host chip on each card says where it went. You can pin a host by hand when it matters.

### Example: the operator's desk

| Host | Owner | RAM | Runs | Never |
|---|---|---|---|---|
| `local` (M3 Pro, brain) | operator | 18 GB | everything | — |
| `m2` (M2 Pro) | employer A (MDM) | 32 GB | employer A + all personal | employer B, employer C |
| `m5` (M5 Pro) | employer C (MDM) | 24 GB | employer C + all personal | employer A, employer B |

The brain keeps a reserve margin for itself (it also runs the Desk and the daemon), so work lands on
`m2` and `m5` first and the brain takes the overflow.

## Non-goals (v1)

- **Linux or Windows hosts.** The sandbox is Seatbelt (`sandbox-exec`), which is macOS only. A
  host reports `platform`, and the brain refuses to place sandboxed work on a host that can't honor
  it. Linux hosts are a later phase with their own sandbox, not a v1 afterthought.
- **Moving a live terminal between hosts.** A CLI's resume transcript lives on the host that ran
  it (`<configDir>/projects/*.jsonl`), so resume is always on the same host. A "move" is a
  close-and-reopen-with-a-brief, the same as a failover stand-in today.
- **Brain failover.** One brain. If it is down, hosts keep their processes running and reconnect
  when it returns (see *Reconnect*). They do not elect a new brain.
- **Sharing one checkout over the network** (NFS/SMB). Every host has its own clones. Git over a
  network filesystem is slow and corrupts under concurrent writers.

---

## Architecture

```
                         ┌──────────────── brain (chronosd) ─────────────────┐
  Desk / phone ──/ws,/term──► api · bus · DB · placement · ScreenMirror · focus parsers
                         │        │                                          │
                         │   HostRegistry ── LocalHost (in-process, today's code)
                         │        └───────── RemoteHost ◄── wss /host ──┐    │
                         └──────────────────────────────────────────────┼────┘
                                                                        │ (outbound from host)
                    ┌──────────────── host (chronos host) ──────────────┴───┐
                    │  pty + child spawns · worktrees · sandbox · transcript │
                    │  tails · vitals · heavy slots · mc forwarder :7777     │
                    │  └─► claude / cursor / grok / opencode CLIs            │
                    └────────────────────────────────────────────────────────┘
```

### The seam: `Host`

Everything in the coupling inventory (below) reduces to one interface. `LocalHost` wraps today's
code with no behavior change. `RemoteHost` speaks the wire protocol to a `chronos host` process,
which runs **the same modules** (`sandbox.ts`, `worktrees.ts`, `child-env.ts`'s base env,
`claude-trust.ts`, `term-hooks.ts`, the transcript tailers, `machine.ts`) on its own filesystem.

```ts
interface Host {
  id: string;                        // "local" | stable id minted at join
  // processes
  spawnPty(spec: SpawnSpec): Promise<PtyHandle>;        // PtyHandle ≈ node-pty IPty: write/resize/kill/onData/onExit
  spawnProcess(spec: SpawnSpec): Promise<ProcHandle>;   // headless runs: stdout lines, stdin, kill, exit
  signal(pid: number, sig: Signal): void;               // stop a run by its persisted pid (added in phase 1)
  listLive(): Promise<LiveInfo[]>;                      // reconcile after a brain restart
  // filesystem & git, always in the host's own paths
  checkout(repo: RepoRef): Promise<string | null>;      // the host's clone of this repo, or null
  worktree(op: WorktreeOp): Promise<WorktreeResult>;    // add / remove / list / status
  exec(cmd: ExecSpec): Promise<ExecResult>;             // gates, git diff/commit/push, gh — cwd + timeout
  prepare(p: PrepareSpec): Promise<void>;               // trust cwd, install hooks/skill/mc, AGENTS.md, drop dir
  // observation
  transcript(sub: TranscriptSub): Subscription;         // raw JSONL deltas for focus/usage; brain parses
  vitals(): Vitals;                                     // pushed every 5s
  slots: HeavySlotPool;                                 // per-host `mc heavy`
}
```

The ~20 modules that use `live` today (`sessionScreen`, `sendInput`, `isLive`, `killSession`,
failover, Robert's drive, watches, …) stay as they are. Only what sits behind the `Live` entry
changes: a `PtyHandle` instead of an `IPty`. Screen parsing (`ScreenMirror`, `ModeTracker`, turn
detection) stays on the brain. It is fed the same bytes either way.

### `SpawnSpec`: intent, not paths

The brain never sends a host an absolute path it made up. It sends **what** to run, and the host
works out **where**:

```ts
type SpawnSpec = {
  session_id: string; workspace: { id; slug }; backend; model; role; resume?: string;
  repo?: { id; remote_url };        // host resolves its own checkout (repo_checkouts)
  worktree?: { branch; base };      // host creates it under its own .chronos-worktrees
  cwd_hint?: "repo" | "worktree" | "home" | "landing";
  profile: string;                  // profile NAME ("medialab"), host maps name → its dir
  sandbox: { mode; allow: string[]; egress_locked: boolean };
  env: Record<string, string>;      // secrets + workspace vars ONLY; host supplies HOME/USER/PATH/TMPDIR/SHELL
  nice: number; cols; rows; seed?: { text; enter_after_ms };   // type-then-Enter runs host-side (no jitter)
};
```

### Paths belong to a host

Hosts have different users and homes (`/Users/alice` vs `/Users/a.smith`). Every stored path gets an
owner:

- **`hosts`** table: `id, name, platform, status (online|offline|draining|disabled), policy_json,
  reserve_json, token_hash, cert_fp, last_seen_at, capabilities_json, created_at`. A `local` row
  always exists.
- **`repo_checkouts(repo_id, host_id, path, head, scanned_at)`**. `repos.path` stays the brain's
  own checkout: the migration backfills it as the `local` row, so nothing that reads `repos.path`
  on the brain breaks. Hosts report their checkouts by scanning their landing dirs and matching
  `git remote get-url origin` to `repos.git_remote` (today's `repo-scan.ts`, run on the host).
- **Profiles by name.** Workspaces keep `config_dir` for `local`. Each host reports a registry of
  `profile name → dir` (the same `~/.claude-*` discovery as `config.ts:108`, run on the host). The
  spec carries the name.
- **`sessions.host_id`** (default `local`). `sessions.cwd`, `worktree_path` and `pid` are
  interpreted on that host. `runs.host_id` does the same for headless runs.

### Transport

One protocol, two ways in. The host config holds an ordered list of brain URLs and uses the first
one that answers:

| | LAN (direct) | Tunnel |
|---|---|---|
| URL | `wss://<brain-lan-ip>:7779/host` | `wss://<your-desk-domain>/host` |
| Brain listens on | a **dedicated host listener**, `CHRONOS_HOST_LISTEN=0.0.0.0:7779`, that serves `/host` upgrades and nothing else | nothing new: `cloudflared` already forwards to loopback `:7777` |
| Encryption | TLS with a brain self-signed cert, **pinned** by fingerprint at join | Cloudflare's TLS |
| Auth | host token | Cloudflare Access service token (`CF-Access-Client-Id/Secret`) **and** host token |
| Latency | LAN | Cloudflare edge round-trip (tens of ms): fine for agents, noticeable only when typing by hand |
| Works when the laptop leaves home | no | yes |

- The main API stays **loopback-only** (`api.ts:4522`). The host listener only accepts
  `/host` WebSocket upgrades with a valid host token. Every other path returns 404 before auth
  runs.
- Keystrokes, PTY bytes, secrets and tokens all cross this link. LAN is TLS with a pinned cert, the
  tunnel is TLS: nothing goes over plain `ws://`.

**Frames** are JSON control messages plus binary PTY/stdout data, multiplexed by a `ch` (channel) id:

```
host → brain   hello{host_id, version, platform, capabilities, profiles, checkouts, live[]}
               vitals{cpu, ram, gpu, loadPerCore, pressure, swapPct}         every 5s
               data{ch, seq, bytes}   exit{ch, code, signal}   transcript{ch, delta}
               api{req_id, session_id, method, path, headers, body}         ← mc forwarder
               rpc_result{id, ok, value|error}
brain → host   spawn_pty{id, spec}  spawn_proc{id, spec}  write{ch, bytes}  resize{ch, cols, rows}
               kill{ch, signal}  rpc{id, op, args}  api_result{req_id, status, body}
               policy{deny[], reserve}  ack{ch, seq}
               update{id, target{version, commit}}                             ← phase 6
host → brain   update_status{id, state: running|restarting|failed|current, step?, error?}
both           ping/pong (15s; 2 missed = link down, NOT process dead)
```

- **Flow control:** per-channel `seq` plus brain `ack`s. The host keeps a 256 KB ring per PTY (the
  same size as `replayTail` today) and resends from the last ack after a reconnect. The Desk's
  per-socket pacing (`term-fanout.ts`) is unchanged: it is brain → browser.
- **Versioning:** `hello.proto` (protocol `major.minor`) and `hello.version` + `hello.commit` (the
  code). The brain refuses a host with an incompatible protocol major; a host whose code differs from
  the brain's shows *Update available* (see *Updating a host*).

### `mc`, hooks and the sandbox on a host

Agents on a host need the Chronos API (`mc state`, `mc ask`, hooks, `mc statusline`). The Seatbelt
egress lock only allows `localhost`, and SBPL can't whitelist an IP literal (`sandbox.ts:80-90`).
Both problems have the same fix:

- `chronos host` listens on **`127.0.0.1:7777` on the host** and forwards each HTTP request over the
  WebSocket as an `api` frame. `MC_API=http://localhost:7777/api` is then correct on every machine,
  and the sandbox rule stays exactly as it is.
- The forwarder stamps every request with the **host id** and the **session id** it came from. The
  brain treats forwarded requests as **remote**. The "no token on loopback = trusted" rule
  (`authz.ts:22-29`) never applies to them. They need the workspace token the brain issued for that
  session, and the session must belong to that host.
- The per-workspace **egress proxy** (`egress.ts`) runs on the host, next to the agent, with the
  policy the brain sends. *(Phase 5: without credential brokering — a workspace whose egress
  intercepts TLS to inject a secret stays on the brain, so no CA exists on a host; see phase 5.)*

### Placement

`POST /sessions` and the dispatcher pick a host with one pure function (`place()`, unit-tested like
`admission()`):

1. **Eligible** = online and not draining, **and** the workspace is allowed by brain policy **and**
   not in the host's local veto, **and** the host has the backend installed and logged in for the
   workspace's profile, **and** the repo is checked out there (or the host has `auto_clone` on).
2. **Sticky first:** resume, revive, a failover stand-in or a worktree already on a host → that
   host, or fail with a reason. Never a silent move.
3. **Pinned:** the operator chose a host in "+ Terminal" → that host.
4. **Otherwise the most headroom:** `admission()` per host on its own vitals, then score by free
   capacity. The brain's reserve (`CHRONOS_BRAIN_RESERVE`) is subtracted from its own score, so it
   takes overflow, not first pick.
5. **Nobody has room:** an operator open goes to the best eligible host anyway (the operator is
   never refused, as today). An agent open is refused with every host's reason ("m2: load 3.1/core;
   m5: offline; local: pressure warning + swap 93%").

**Cloud is the other kind of target.** `cursor-cloud` sessions already run with no local process
(`desk-cloud.ts`). `place()` treats them as one more target for work that fits them: headless jobs
with a repo on GitHub and no need for local tools or local data. Where work can run is then:
`local` → the operator's hosts → Cursor Cloud. For a Desk terminal the operator picks it
explicitly. For a job it is a per-workspace setting (`placement: hosts | hosts+cloud`). The
operator never gets a surprise cloud bill.

**Heavy slots are per host.** `mc heavy` asks through the forwarder, and the brain grants from that
host's pool (`ncpu/6` of *that* machine). Two suites on two machines don't wait for each other.

### Reconnect and restarts

What survives what:

| Event | PTYs on that host | What the brain does |
|---|---|---|
| Link drops (Wi-Fi, sleep) | keep running; output buffered in the ring | cards show "host offline"; on reconnect `hello.live[]` → re-attach, resend from the last ack |
| Brain restart / deploy | **remote PTYs keep running** | boot reconciles: `listLive()` per host, re-attach. `reapAll()` (`store/sessions.ts:365`) and the boot-time `interrupted` sweep (`db.ts:58-74`) only apply to `host_id = 'local'`. Otherwise every deploy would double the fleet. |
| `chronos host` restart / update | die with it (children of the host process) | revive with `--resume` **on the same host**, the same path `local` takes after a deploy today |
| Host offline past `CHRONOS_HOST_FAILOVER_GRACE_MIN` (default 5) | unreachable (powered off, asleep, off the network) | **host failover** (`src/host-failover.ts`): each live terminal on it is reopened on an online computer — the brain when it has the repo, else a host that reported a checkout. The branch is checked out fresh from origin when it was pushed (else a new worktree off the default branch, and the seed says so). A claude terminal resumes its conversation from the brain's transcript mirror (copied to `<profile>/projects/<slug of the new cwd>/<new id>.jsonl`, the only place `claude --resume` looks); any other gets a brief. The old row ends with `end_reason` `host_failover`, one line per host goes to the Desk chat, and when the host reconnects reconcile kills the old process there (its row ended here) — never resumed. Counted from the brain's boot too, so a brain restart moves nothing that simply has not reconnected yet. `CHRONOS_HOST_FAILOVER=off` restores the wait |
| Host gone for good | — | Desk → Computers → Remove: its live sessions end, its checkouts are forgotten, its token is revoked |

A host that loses the brain for longer than `CHRONOS_HOST_ORPHAN_MIN` (default: never) can be set
to stop its agents. By default it lets them finish: the work is committed to git on the host either
way.

### The ship pipeline on a host

Build, gate, review and merge (`runner.ts`, `gates.ts`, `reviews.ts`, `delivery.ts`) do their git
work in the worktree, and that worktree is on the host. They switch from `execFileSync(…, {cwd})` to
`host.exec({cwd, cmd, timeout})`. The host enforces the timeout itself, so a dropped link can't
leave a runaway gate. `gh` runs where the worktree is, so the host needs `gh` logged in for that
workspace. The host capability report covers it and placement checks it. Merges by PR URL can stay
on the brain.

---

## Security

The trust model is **brain → host**: a host does what its brain tells it to, within its local
veto. Owning the brain means owning its hosts, the same way owning the daemon means owning the
Mac today. So the design protects the **link** and the **boundaries between workspaces**:

- **Join:** the code is single-use, expires in 15 minutes, and carries the brain's TLS cert
  fingerprint. `host join` refuses a brain whose cert doesn't match, so there is no
  trust-on-first-use.
- **Host token:** 32 random bytes, stored hashed (`token_hash`), revocable from the Desk. The host
  keeps it in its own `.secrets` with mode 600.
- **Least data per host.** A host receives its own sessions' spawns, input and API responses. It
  never gets the bus firehose, the DB, other hosts' vitals, or another workspace's secrets.
  `workspace_vars` and `secrets_file` values are sent inside the `spawn` frame, only for the
  workspace being spawned.
- **Two locks on workspace isolation:** brain policy (checked in `place()` and again when the spawn
  frame is sent) **and** the host's local veto (checked by the host before it forks anything). A
  host that refuses a spawn logs it on the brain as a policy violation.
- **Least credentials per host:** a host only has logins for the profiles it runs. The setup
  checklist says so, and the capability report shows it. On an employer's machine, don't log in the
  other employers' profiles at all.
- **No inbound on hosts.** Nothing listens on a host except its loopback forwarder. The brain's
  optional LAN listener serves only `/host`.

## Setup (what the operator does)

On the brain, once — pick how new computers reach it (either or both):

```bash
# Same network: open the host listener (TLS, pinned at join)
echo 'CHRONOS_HOST_LISTEN=0.0.0.0:7779' >> .secrets
# Anywhere: advertise the tunnel (cloudflared already forwards /host to :7777)
echo 'CHRONOS_HOST_PUBLIC_URL=wss://desk.example.com/host' >> .secrets
npm run deploy
```

The first time the LAN listener starts, macOS may ask whether **node** may accept incoming
connections. Allow it, or hosts on the same network cannot connect (the tunnel is unaffected). If you
clicked Deny: System Settings → Network → Firewall → Options → set node to *Allow*.

### Before adding a computer

On the new Mac (the Desk's **+ Add** shows the same list):

- **Node 22–26.** `node -v`. If it is older, newer, or missing: `brew install node@24`, then make it
  win on PATH *after* Homebrew's own line in `.zprofile` (which re-prepends `/opt/homebrew/bin`):
  `echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> "$HOME/.zprofile" && exec zsh -l`.
- **Xcode command-line tools** (git): `xcode-select --install`.
- **Each client that may run there, logged in** — and only those. On an employer's Mac, do not log
  in the other employers' profiles at all: `CLAUDE_CONFIG_DIR="$HOME/.claude-<client>" claude`.
- **`gh auth login`** for the GitHub account that client uses; a second account on the same Mac goes
  in its own config dir: `GH_CONFIG_DIR="$HOME/.gh-<client>" gh auth login`.
- Nothing inbound: no Remote Login, no SSH, no open port. MDM-managed Macs stay compliant.

### Adding it

1. Desk → ⋯ → **Computers** → **+ Add** → name it → **Get the command**. With both transports set,
   pick *Same network* or *Anywhere*. The code inside works once, for 15 minutes.
2. Paste it in Terminal on that Mac. It is one line, safe to re-run:
   ```bash
   node -e '<fails unless node is 22–26, with the fix>' && D="$HOME/.chronos-host/app" \
     && { [ -d "$D/.git" ] && git -C "$D" fetch -q origin main && git -C "$D" reset -q --hard FETCH_HEAD \
          || git clone -q https://github.com/leorfer23/getchronos "$D"; } \
     && cd "$D" && npm ci --no-audit --no-fund && npm run host -- join wss://192.168.1.20:7779/host CHR1-…
   ```
   Once `getchronos` is published and the brain sets `CHRONOS_HOST_INSTALL=npm`, the line is
   `node -e '…' && npx -y getchronos@<brain version> host join <url> <code>`; npx's copy lives in
   npm's cache, which npm prunes when it likes, so `join` first installs that same version into
   `~/.chronos-host/app` (with the same node's npm) and runs from there.

   Every path is `"$HOME/…"`: a `~` inside quotes is not expanded, and a paste that lost its `~`
   once created `./.chronos-host` wherever the operator stood.

   `npm run host` enters through `bin/getchronos.mjs`, which runs a **preflight** before anything
   else loads: node in range, `npm ci` finished (tsx, the native modules load), and the git on PATH
   can fetch over https. A failure prints one `fix:` line to paste. Then `join` checks the brain's
   fingerprint, stores its token in `~/.chronos-host/.secrets` (mode 600), installs
   `~/Library/LaunchAgents/sh.chronos.host.plist` and connects. The Desk's *Waiting for it to
   connect…* turns into ✓.
3. The computer's page in **Computers** shows what it reported: its version, CLIs, which clients may
   run there (toggle to keep one off it — that writes the brain policy; a client the Mac vetoes itself
   is shown locked), each client's profile logged in or not, and each repo cloned or not. Fix anything
   ✗ on that Mac (`claude` login per profile, `gh auth login`, `git clone` under
   `CHRONOS_HOST_ROOTS`). `npm run host -- doctor` there prints the same checklist, preflight first.

The LaunchAgent runs `bin/getchronos.mjs host run` with **the node that ran `npm ci`**
(`process.execPath` at join, #50) — never whatever a login shell finds — addressed by Homebrew's
`opt/<formula>` link when that is the same binary: the `Cellar/<version>` path `process.execPath`
reports is deleted by the next `brew upgrade` + cleanup, and launchd then cannot start the host at
all, with nothing in any log. Both native modules are N-API (better-sqlite3 ≥ 13, node-pty ≥ 1), so a
node upgrade inside 22–26 needs no rebuild.

From then on: the header chip becomes **N computers** (one bar per connected computer; click for
each one's CPU/RAM/GPU), terminals that run elsewhere carry the computer's name on the rail, and
"+ Terminal" gets a computer picker. *Takes work* off = drain (what runs keeps running, nothing new
lands). **Remove this computer** revokes its token and drops its link; re-adding it needs a new code.

Host-side knobs (in `~/.chronos-host/.secrets`):

```bash
CHRONOS_HOST_BRAINS=wss://192.168.1.20:7779/host,wss://desk.example.com/host   # tried in order
CHRONOS_HOST_DENY=galley,gfm         # local veto: the brain can never place these here
CHRONOS_HOST_ROOTS=~/Documents/GitHub # where to look for (and clone) checkouts
CHRONOS_HOST_AUTO_CLONE=0            # 1 = clone a missing repo on first placement
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=…   # only for a tunnel URL behind Cloudflare Access
```

### Updating a host

A computer whose commit (git install) or version (npm install) differs from the brain's shows
**Update available** in Computers, with an **Update** button, and **Update all** in the list's header.
Updating ends that computer's terminals while it restarts; the brain revives each with `--resume` on
the same computer when it says hello again (the confirm says so). What the host does (`update.ts`):

1. builds the new version **beside** the running one, in `~/.chronos-host/app.next` — git: a local
   clone of the app checked out at the brain's commit, fetched from the app's own `origin` (the brain
   sends a commit, never a URL); npm: `getchronos@<brain version>`;
2. installs its dependencies with the **same node** the host runs (`process.execPath` + its own
   `npm-cli.js`, not whatever `npm` is on PATH);
3. runs the new version's own preflight under that node;
4. only then swaps: `app` → `app.prev`, `app.next` → `app`; rewrites the plist for the next login;
5. `launchctl kickstart -k gui/<uid>/sh.chronos.host` — its own label.

Any failure before 4 deletes the candidate, reports the error to the Desk, and **keeps the old
version running**. A host that does not answer for 20 minutes mid-update is shown as failed.
`app.prev` is the way back by hand:
`cd "$HOME/.chronos-host" && mv app app.bad && mv app.prev app && launchctl kickstart -k gui/$(id -u)/sh.chronos.host`.

- A host from **before** self-update (it reports no `install` in hello) cannot be asked; the Desk shows
  the one line to paste on it once:
  `cd "$HOME/.chronos-host/app" && git fetch -q origin main && git reset -q --hard FETCH_HEAD && npm ci --no-audit --no-fund && launchctl kickstart -k gui/$(id -u)/sh.chronos.host`.
- A host run by hand (not by its LaunchAgent) refuses a Desk update — it cannot restart itself; run
  `npm run host -- update` there. A host running from someone's own checkout (`dev`) is never updated
  from the Desk.
- The brain updates with `npm run deploy`, as always; hosts then show *Update available*.

### Uninstalling

`npm run host -- uninstall` (or `npx getchronos host uninstall`) boots the LaunchAgent out and deletes
its plist; `--purge` also deletes `~/.chronos-host` (credential, logs, app). It prints what it left:
`~/.mc` (the `mc` CLI), the hooks/skill copies inside agent profiles, and the computer's row on the
brain — Desk → Computers → **Remove this computer** revokes its token.

### Menu bar

A host can show, in its own menu bar, whether it is working and on what — so a glance at each Mac on
the desk answers "is m2 busy?". Offered after `join` (never installed unasked), or any time:

```bash
node "$HOME/.chronos-host/app/bin/getchronos.mjs" host menubar install   # a clone: npm run host -- menubar install
# or at join time: … host join <url> <code> --menubar
```

It needs the Xcode command-line tools (`xcode-select --install` — a host already has them for git):
`desktop/hostbar.swift` is compiled on the host with `xcrun swiftc -O` into
`~/.chronos-host/bin/chronos-hostbar` and started by `~/Library/LaunchAgents/sh.chronos.hostbar.plist`
(at login; restarted after a crash, not after **Quit**, which lasts until the next login).
`menubar status` says whether it runs, `menubar uninstall` removes it, `host uninstall` takes it too,
and `doctor` lists it. A self-update rebuilds and restarts it from the new code when it is installed —
and never fails the update if the rebuild does (the log says why).

What it shows — the hourglass is the Chronos mark (`site/assets/favicon.svg`), drawn natively:

| State | Title | Tooltip / menu header |
|---|---|---|
| Agents working | slate hourglass, **amber sand running**, and the number producing output in the last 20 s | `m2 · connected · 2 working of 3` |
| Connected, nothing working | monochrome hourglass, sand settled in the bottom bulb, no number | `m2 · connected · nothing running` |
| Link to the brain down | the same hourglass with a small ⚠ badge; the number stays (agents keep running while the link is down) | `m2 · reconnecting — <reason>` / `· offline` |
| Host process not running | empty outline hourglass, dimmed, `–` | `Chronos host · not running` |

The menu: the header (with how long the link has been down, and why), one row per live terminal and
headless run — `● app — claude-code · 12m`, filled while it produces output, hollow when idle — then
**Open host log** (`host.out.log` in Console) and **Quit**. The name is the operator's name for the
computer from the Desk (the brain sends it in `welcome`, the host remembers it in `~/.chronos-host/name`),
else its hostname.

It reads only `GET http://127.0.0.1:<port>/__host/status`, every 3 s, at the port the forwarder binds
(`CHRONOS_HOST_MC_PORT` from `.secrets` — the one key it reads there — else 7777, then 7787–7796,
accepting only a reply with a `host_id`). That endpoint is loopback-only and unauthenticated, so it is
built from an allowlist (`src/hostd/status.ts`): link state + reason, name, version/commit, and per item
kind, short id, **repo folder**, backend, started / last output, active. Never a token, an env var, a
workspace or a title; a worktree reports its repo folder, not its branch (a ticket key carries the
workspace prefix), and error text loses URL userinfo and query strings.

#### On the brain: the whole fleet

The brain Mac (daemon, Desk, DB) can carry the same item, showing every computer at once. Opt-in,
from the brain's checkout:

```bash
scripts/build-brainbar.sh              # compile + load; --dry-run prints the steps and the plist
node scripts/brainbar.mjs status       # running (pid N) | installed, not running | not installed
node scripts/brainbar.mjs uninstall
```

The same `desktop/hostbar.swift`, compiled with `xcrun swiftc -O` into `~/.mc/bin/chronos-hostbar`
(beside the Desk's `mc-app`) and started with `--brain` by `~/Library/LaunchAgents/sh.chronos.brainbar.plist`
(from `launchd/sh.chronos.brainbar.plist.template`: at login, restarted after a crash, not after **Quit**).
`install-launchd.mjs` never installs it, and `npm run deploy` touches it only when it is installed:
then it rebuilds and restarts it if `hostbar.swift` is newer than the binary, and never fails the
deploy if that does not work.

It polls `GET http://127.0.0.1:${CHRONOS_PORT:-7777}/api/hosts/bar` every 3 s — admin only, like
`/api/hosts` — with the admin token read from `~/.mc/.admin-token`, else `<repo>/.admin-token` (the
plist carries only paths and the port; the token is read from the file, never logged). A rejected
token is re-read and retried once at once, so a rotated token needs no restart.

| State | Title | Tooltip / menu |
|---|---|---|
| Agents working anywhere | slate hourglass, **amber sand running**, and the fleet's working count | `Chronos · 3 working of 7` |
| Nothing working | monochrome hourglass, sand settled, no number | `Chronos · nothing running` / `· 0 working of 4` |
| A host with live work is offline | the ⚠ badge; the number is what the brain can still see working | `m5 offline with work on it · 2 working elsewhere` |
| Daemon not answering (or it refuses the token) | empty outline hourglass, dimmed, `–` | `Chronos · daemon not answering` / `· admin token refused` |

The menu: one section per computer — **This Mac** first, then each host by name with
`connected`/`offline` (and for how long) and `N working` — with up to 8 rows each,
`● open the rollback PR — claude-code · 12m` (the Desk card's title, else the repo folder; ● producing
output, ○ idle), then `+N more`; then **Open Desk** (`~/.mc/mc-app.app` on `/desk`, else
`http://localhost:7777/desk`), **Open daemon log** (`chronos.out.log`) and **Quit**.

"Working" is the brain's own signal, the one the Desk paints by: a terminal's pty produced bytes within
the last `CHRONOS_TERM_QUIET_MS` (6 s). A remote terminal's bytes stream to the brain, so this holds
for every computer without asking any of them; a terminal on a host whose link is down cannot be seen
producing and counts as idle (hence the badge). A headless run counts while it is `running`; cloud
sessions run on no computer and are left out. The reply (`src/hostlink/bar.ts`) is an allowlist:
per computer id, name, link state, since, counts; per item kind, short id, repo folder, backend,
started / last output, active — and `title`, which only this admin-gated brain endpoint carries,
never a host's `/__host/status`.

### Troubleshooting

Every one of these happened on the first two hosts. `npm run host -- doctor` on the host checks all
of them.

| Symptom | Cause | Fix |
|---|---|---|
| `npm ci` fails in `better-sqlite3` (`gyp ERR!`), then the host crash-loops with `ERR_MODULE_NOT_FOUND … tsx/dist/loader.mjs` | Homebrew's node 26 with better-sqlite3 11, which had no prebuild for it and could not compile; `npm ci` stopped half-way and left no tsx | Fixed at the root: better-sqlite3 13 ships N-API prebuilds (no compile). On an old checkout: `cd "$HOME/.chronos-host/app" && git fetch -q origin main && git reset -q --hard FETCH_HEAD && npm ci`. The preflight now names a half-finished install instead of crashing |
| `node -v` in your terminal is not the node the host runs | `.zprofile`'s `brew shellenv` re-prepends `/opt/homebrew/bin` after your PATH edit; version managers differ between login and non-login shells | Put the node you want **after** the shellenv line (see *Before adding a computer*), open a new terminal, re-run the join line. The LaunchAgent always runs the node that installed it |
| A reinstall over SSH built with a different node | A login shell over SSH picked Homebrew's node, the terminal used another | Run the join line in Terminal on that Mac. Hosts need no SSH at all |
| `git: 'remote-https' is not a git command` | A `git` earlier on PATH (a broken `~/.local/bin/git` with exec-path `//libexec/git-core`) shadowed the real one; agents' git over https fails the same way | `mv "$HOME/.local/bin/git" "$HOME/.local/bin/git.broken"` — the preflight prints the exact path |
| `mc` from an agent on the host talks to the wrong daemon (404s) | An old standalone Chronos on that Mac owns `127.0.0.1:7777` | Handled: the forwarder falls back to 7787–7796 and tells agents which (#48). `host status` finds it |
| A pasted command made `./.chronos-host` in the current folder | The paste lost its `~` | Commands now use `"$HOME/…"`; delete the stray folder |
| LAN host never connects; the tunnel works | macOS blocked incoming connections to node on the brain | Allow node in the firewall prompt / System Settings → Network → Firewall |
| The host stopped starting after `brew upgrade` | The plist named a `Cellar/<version>` node that `brew cleanup` deleted | Re-run the join line (plists now use `opt/<formula>`); a Desk update rewrites the plist too |
| `menubar install` says `swiftc not found` | No Xcode command-line tools (the `/usr/bin/swiftc` shim does not count) | `xcode-select --install`, then install again |
| The menu bar item shows `–` | The host process is not running, or answers on a port the item does not try | `npm run host -- status`; a pinned `CHRONOS_HOST_MC_PORT` in `.secrets` is read by both |
| Terminals fail with `posix_spawnp failed` | node-pty's `spawn-helper` lost its exec bit (npm ships it 644) | Handled by the postinstall, also when installed from npm; the preflight prints the `chmod +x` line |

Host-side logs: `~/.chronos-host/host.out.log` and `host.err.log`. Onboarding and updates add
nothing to them beyond versions, commits, paths and errors — no workspace names; placement policy
stays on the brain, keyed by workspace id.

## Coupling inventory (what has to move behind the seam)

From a full read of the daemon on 2026-09-24. Every item is a `file:line` in today's tree.

| Area | Today | Behind `Host` |
|---|---|---|
| PTY lifecycle | `live` Map of `IPty` (`terminal.ts:199-239`), spawn `:609`, exit `:667-711`, resize/write/kill, `typeSeed` `:892` | `PtyHandle`; type-then-Enter on the host |
| Boot/revive | `reapAll()` + resume revive (`terminal.ts:1526-1569`), `db.ts:58-74` | `local` only; remote → `listLive()` reconcile |
| Headless runs | `spawn` + watchdog + stdin steer (`runner.ts:383-443`), `stopRun` `process.kill` | `ProcHandle`; the host enforces the watchdog too |
| Paths | `repos.path`, `config_dir`, `default_dir`, `secrets_file`, `sessions.cwd/worktree_path` | `repo_checkouts`, profile registry, `host_id` |
| Worktrees & git | `worktrees.ts`, `tickets.ts:1004-1261`, `reviews.ts`, `gates.ts`, `delivery.ts` | `host.worktree()` / `host.exec()` |
| Transcripts | `focus.ts:280-560`, `session-usage.ts`, `grok-resume.ts`, grok billing log | host streams raw deltas, brain parses |
| Profile prep | `claude-trust.ts`, `grok-trust.ts`, `term-hooks.ts`, `installMcSkill/Cli`, `syncAgentsMd`, `efficiency-tools.ts` | `host.prepare()` plus host boot |
| Env & secrets | `child-env.ts` copies the daemon's `HOME/USER/PATH`, reads `secrets_file` from disk | brain sends values; host supplies the base env |
| Sandbox | `sandbox.ts` built from `os.homedir()`, `config.ts:530-571` deny list, `isolationDenyDirs` | built on the host from host paths |
| API reach | loopback bind `api.ts:4522`, loopback trust `authz.ts:22-29`, `MC_API=localhost` | host forwarder; forwarded = remote |
| Egress | lock allows only localhost (`sandbox.ts:80-90`), proxy on brain loopback (`egress.ts:200-255`) | proxy on the host |
| Governor | vitals, admission, heavy slots all brain-only (`machine.ts`) | per-host vitals, admission and pools |
| Drops & attachments | `~/.mc/drops`, `~/chronos/attachments` absolute paths in prompts | forwarded to the host; `mc attach get` |
| Misc | `awake.ts` caffeinate, `mc pdf` sends a path, ticket `file_path` in seeds | host caffeinates itself; upload bytes; `mc ticket show` |

Already remote-shaped, and the template for this work: `cursor-cloud` sessions (`desk-cloud.ts`,
`cloud-handoff.ts`, `BackendKind "cloud"`). They are sessions with no local process that are
reconciled at boot.

## Phases

Each phase ships on its own, keeps `npm test` green, and leaves a single-machine install exactly as
it was.

1. **Seam, no behavior change.** ✅ Landed. What is in it:
   - **Schema (migration 134):** `hosts` with a `local` row (inserted by the migration and
     re-ensured at every boot by `ensureLocalHost`), `repo_checkouts` backfilled from `repos.path`
     as host `local` and kept in sync by `store/repos.ts` in the same transaction, and
     `host_id TEXT NOT NULL DEFAULT 'local'` on `sessions` and `runs` (a plain column, not a
     foreign key: SQLite refuses `ADD COLUMN … REFERENCES` with a non-null default). Store modules
     in `src/store/hosts.ts`.
   - **`src/hosts/`:** the `Host` interface, `PtyHandle`, `ProcHandle`, and `LocalHost`. Real in
     this phase: `spawnPty`, `spawnProcess`, `signal`, `listLive`, `vitals`, `slots`. `hostFor(row)`
     / `hostById(id)` resolve `local` and throw on any other id.
   - **Routed through the seam:** `live` holds a `PtyHandle` (on `local` it *is* node-pty's IPty);
     `openSession` spawns through `hostFor(row).spawnPty`; `runner.ts` through
     `hostFor(run).spawnProcess`; `stopRun` and `continueFromRun` signal through the run's host;
     agent admission, `GET /machine` and `mc heavy`'s slot endpoints read the local host.
   - **Boot is `local` only:** `sessions.reapAll()`, the boot revive in `startTerminals()` and
     `db.ts`'s interrupted sweep all filter on `host_id = 'local'`.
   - **Deviations from the sketch above.** `spawnPty`/`spawnProcess` take a fully built command
     line (`PtySpawn`/`ProcSpawn`: cmd, args, cwd, env) because every host is the brain; the
     intent-shaped `SpawnSpec` replaces them in phase 3. `Host.signal(pid, sig)` was added: a stop
     arrives from the API holding a run row with a persisted pid, not a handle, and must answer
     synchronously. The **profile registry by name** did not land here: it is something hosts
     report, so it arrives with `hello` in phase 2 (workspaces keep `config_dir` for `local`).
   - **Not moved yet, on purpose:** fs and git (worktrees, trust/hooks/skill/AGENTS.md prep,
     transcript tails) still run in-process on the brain's paths and move behind `checkout`,
     `worktree`, `prepare` and `transcript` in phase 3; the ship pipeline's `execFileSync` moves
     behind `exec` in phase 5. Brain-side services that spawn CLIs of their own (Robert's manager,
     one-shot title/digest helpers, accelerators) stay on the brain.
2. **`chronos host` + link + join.** Host process, `/host` endpoint, host listener, join codes, a
   pinned cert, both transports, `hello`/vitals/capabilities, the Desk **Computers** panel, and a
   vitals chip per host in the header. Nothing is placed on hosts yet.
   - **Landed (transport core):** `src/hostlink/wire.ts` (frames, protocol version, per-channel
     seq, the 256 KB `Ring` + `SeqTracker`), `src/hostlink/join.ts` (single-use 15-min join codes
     carrying the cert fingerprint and URL hints, 32-byte host tokens stored hashed, the brain's
     self-signed cert via `/usr/bin/openssl`), `src/hostlink/pin.ts` (LAN names/IPs pinned, public
     names CA-verified, `ws://` only on loopback), `src/hostlink/brain-link.ts` (the
     `CHRONOS_HOST_LISTEN` listener and the tunnel `/host` door on the loopback API, both token-gated;
     hello/version/identity checks; 15s ping with 2 misses = link down; RPC with ids and timeouts;
     the `api` frame handler replaying forwarded `mc` requests into the daemon's own API with
     brain-set `x-mc-host` / `x-mc-remote: 1` and a per-boot forward secret, admin token stripped,
     workspace or Lead token required; `POST /api/hosts/join-codes`, `GET /api/hosts/links`,
     `DELETE /api/hosts/:id`), and `src/hostd/` (`npm run host -- join|run|status|doctor`, the
     `sh.chronos.host` LaunchAgent, hello with CLIs/profiles/checkouts/veto, vitals every 5s from
     `machine.ts`, the loopback `mc` forwarder, `spawn_pty`/`spawn_proc` answered "not yet").
   - **Landed (registry + Desk):** `src/hostlink/registry.ts` keeps hosts in the `hosts` table — join
     inserts the row (the operator's name, the token hash, the pinned cert fingerprint), hello
     writes `capabilities_json` (version, CLIs, profiles, checkouts, veto) and goes `online`, link
     down goes `offline`, revoke is `disabled` + `token_hash` null. `draining` / `disabled` are the
     operator's and survive the link coming and going; "connected right now" is always the live link,
     never the column. hello's checkouts become `repo_checkouts` rows, matched to repos by
     normalized git remote (ssh / scp / https, `.git`, slashes). The Phase 2 `hosts.json` is imported
     once at boot and left in place. `GET /api/hosts` (no token hash, ever), `PATCH /api/hosts/:id`
     (`name`, `policy: {deny: [workspace id or slug]}`, `status: draining|online|disabled`,
     `reserve`), `host.online` / `host.offline` / `host.updated` on the bus; the Desk's fleet chip,
     ⋯ → Computers (+ Add with the real join command), host tags on the rail and the "+ Terminal"
     computer picker, which sends `host_id` with `POST /sessions`. Join codes return one command per
     transport (`commands.lan`, `commands.tunnel`).
   - **Deferred:** `authz.ts` did not read `forwardedHost()` yet (done in phase 3). Per-host admission on the Desk is computed from the host's vitals with
     `machine.ts`'s thresholds (display only; placement is Phase 4). The full "New terminal" dialog
     (⇧N) has no computer picker yet — only the quick line does. A paused (`disabled`, not revoked)
     host's `chronos host` stops retrying on the 401, so re-enabling it needs that process restarted.
   - **Deviations:** join is a `/host` upgrade with `Authorization: Join <code>` rather than a separate
     endpoint, so the listener still serves nothing but `/host`. Pinning is chosen by the URL's
     hostname (see `pin.ts`), not by a flag. The wire carries `hello.proto` (protocol `major.minor`)
     separately from `hello.version` (the chronos package version); only a different protocol major
     is refused.
3. **Remote terminals.** `spawn_pty` streaming, input, resize, kill and exit; the ring and ack
   resend; reconnect with re-attach; the forwarder with remote authz; `prepare()`; worktrees on
   the host; transcript streaming into focus and usage; drops. Placement: pinned plus sticky only.
   - **Landed:**
     - **SpawnSpec** (`src/hosts/spawn-spec.ts`): repo and every workspace repo by git remote, a
       ticket worktree by branch + base, profile by NAME, sandbox `{mode, allow, egress_locked}`,
       system text, seed, and an env of secrets / workspace vars / `mc` identity / Lead tokens only.
       Values under the brain's home travel as `~/…` (flagged in `env_home_relative`) and the host
       expands them against its own home; a value naming a brain-only path elsewhere is dropped and
       logged by key. `brainPathsIn()` runs on every remote spawn and refuses one that would leak a
       brain path (asserted in tests). `Host.spawnPty` takes `PtySpawn | SpawnSpec`: `local` builds
       argv exactly as before, a remote host takes intent.
     - **`openSession`** (`terminal.ts`): the target host is the row's (resume, continue-headless,
       failover stand-in: sticky) or the pin (`host_id`), else `local`. The local path is unchanged —
       the only moves are that its Live wiring became `installLive()` (shared with remote spawns and
       re-adoption) and profile prep sits under `if (!remote)`. Brain lock #1
       (`assertRemotePlacement`) runs before any row is written: connected, not `disabled` (nor
       `draining` for new work), workspace not denied by `hosts.policy_json` **or** by the veto the
       host reported in hello, not a cloud backend, not egress-locked, macOS with sandbox-exec when
       sandboxed. A remote row is created with `cwd = ""` and gets the host's answer
       (`sessions.setCwd`).
     - **`RemoteHost`** (`src/hosts/remote.ts`): a `PtyHandle` per channel whose write/resize/kill
       are frames; data frames go through `SeqTracker` (a resend overlap is dropped, once) into the
       same `onData` a node-pty fires; batched acks; frames that beat the spawn reply are held;
       exit → the ordinary `onExit` close-out → `release`. Registered on first hello, marked offline
       (never removed) on link down.
     - **The host** (`src/hostd/terminals.ts`): local veto first (CHRONOS_HOST_DENY **plus** the
       brain's `policy` frame, which can only add refusals), then checkout by git remote
       (`normalizeGitRemote`, moved store-free to `hostlink/git-remote.ts`; missing → a clear error,
       or `CHRONOS_HOST_AUTO_CLONE=1` clones into the first root), ticket worktree via
       `worktree-core.ts` (the brain's own code, split from `worktrees.ts` so the host never opens a
       DB), profile name → its dir, Seatbelt profile built from its own home (every checkout here
       that is not the workspace's is denied), `niceWrap`, `prepare()` (skill, `mc` into
       `~/.mc/bin`, card hooks, claude/grok trust, AGENTS.md — `agent-prep.ts`, split from
       terminal.ts), env base + `MC_API=http://localhost:<forwarder>/api`. Output is ringed with a
       seq; live streaming stops on link down and resumes only after the brain's `attach{ch, seq,
       transcript_offset}`, which resends what the brain lacks. An exit while the brain is away is
       held (reported in `hello.live[].exit`) until `release`. Seeds are typed host-side.
     - **Reconnect** (`src/remote-terminals.ts`): on hello, rows live on that host are reconciled
       against `hello.live[]`: held + reported → re-attach from our last seq; reported but not held
       (the brain restarted) → adopted into `live` (`adoptRemoteSession`) then attached; not
       reported (the host restarted) → ended, and revived `--resume` on the same host when its CLI
       can resume; a reported channel whose row ended here → killed there. Boot still reaps and
       revives only `local` rows. `host_offline` on `GET /sessions/:id`, `/sessions/:id/status` and
       `/desk` rows (which stay `live` while their host is away).
     - **Transcripts:** the host tails the CLI's JSONL (focus.ts's own `locateTranscript` against its
       paths) and streams whole lines with their file offset; the brain writes them by offset into
       `<hostlink>/transcripts/<session>.jsonl` (`hosts/transcript-mirror.ts`), which Focus
       (`FocusCtx.transcriptFile`), the usage ledger and so term-status read like a local file.
     - **Authz for forwarded requests** (`authz.ts`, `forwardedGate` in front of `/api`): never
       loopback-trusted; a workspace or live Lead token is required (a Lead's only from its own
       host); `x-mc-session` — now sent by `mc` — must be live, on the forwarding host, in the
       token's workspace; the workspace must not be denied on that host. `callerScope` returns
       invalid for a token-less forwarded request instead of "unrestricted".
     - **Pin + drops + worktrees:** `POST /sessions` takes `host_id` (id or name; `mc session new
       --host`). `POST /sessions/:id/drop` for a remote terminal forwards the bytes (≤ 16 MB, one
       control frame) and the host writes them into its own `~/.mc/drops/<session>`.
       `POST /sessions/:id/worktree` (`mc worktree`) names the branch on the brain and creates the
       worktree on the host. Refused host spawns (`veto: …`) and brain-policy refusals publish
       `host.policy_violation`.
     - **Protocol 1.1** (additive): `live[].exit` / `transcript_offset`, `transcript.offset` /
       `reset`, brain → host `attach` and `release`.
   - **Deferred:** cursor-agent transcripts (a SQLite store, no append-only shape to stream — the
     Desk story/usage for a remote cursor terminal stay empty); per-host heavy slots (a remote
     `mc heavy` queues on the brain's pool) and real per-host admission (phase 4); the egress proxy
     on hosts, so an egress-**locked** workspace is refused on hosts and an audit-mode one runs
     there without the audit proxy (phase 5); ticket files (`tickets/<ws>/…` on the brain) are not
     granted — a remote ticket seed says `mc ticket get <KEY>` instead of a path; grok's legacy
     unpinned resume id lookup (`grok-resume.ts`) runs only for local terminals; after a BRAIN
     restart the scrollback that was already acked is gone (the host resends only unacked output;
     the attach repaint redraws a full-screen TUI); `CHRONOS_HOST_ORPHAN_MIN`.
   - **Deviations:** checkout/worktree/prepare/transcript are done inside a remote spawn rather than
     as separate `Host` verbs (nothing on the brain needs them alone yet). Host isolation denies every
     checkout on that host that is not the workspace's (the brain's local rule denies other
     workspaces' registered repos; a host cannot tell whose an unregistered clone is, and is never
     told another client's repos). Keystrokes typed while a host is offline are dropped, not queued.
     A failover stand-in opens on the walled terminal's host. The workspace's `default_dir` landing
     dir is a brain path, so a repo-less remote terminal lands in the first workspace checkout on the
     host, else its home. The spawn frame carries `resume_cwd` only for a directory the host itself
     reported for that row (or the terminal it stands in for).
4. **Placement and governor.** `place()` with policy, veto, capabilities and headroom; per-host
   admission and heavy slots; brain reserve; drain; refusal reasons across hosts.
   - **Landed:**
     - **`place()`** (`src/hosts/placement.ts`, pure, unit-tested like `admission()`): eligibility
       (online; not `disabled`, nor `draining` for fresh work; workspace not denied by brain policy
       nor by the host's reported veto — a pin or sticky row refused for policy is a 403 and a
       `host.policy_violation`; not a cloud backend; not egress-locked; macOS with sandbox-exec when
       sandboxed; the backend's CLI on the host's PATH; the workspace's profile NAME reported, and
       logged-in (`exists`) for claude-code; the repo in `repo_checkouts` for that host, or the host
       reports `auto_clone`; a repo with no git remote cannot go to a host). Then sticky → pinned →
       most headroom → nobody has room, exactly as above. The brain is always eligible: every guard it
       has always had still runs in `openSession`.
     - **Score** (`headroom()`, 0–100): `50·clamp(1 − loadPerCore / CHRONOS_MAX_LOAD_PER_CORE) +
       50·(1 − RAM used %)` (unknown RAM = half), then −25 for pressure *warning*, −50 for
       *critical*, and −10 more when swap is past `CHRONOS_MAX_SWAP_USED_PCT` under pressure (swap
       alone is a calm Mac's resting state, as `admission()` already holds). No fresh reading = 0 and
       ranked last. Candidates must first pass `admission()` on their own numbers; among those the
       best score wins, ties broken host-before-brain, then name, then id. `CHRONOS_BRAIN_RESERVE`
       (default **25**) comes off the brain's score: an idle brain (~70) loses to a host until that
       host is a quarter of the scale busier (~45), so hosts fill first and the brain takes overflow.
     - **Sticky** (`src/hosts/candidates.ts` `stickyFor`): a resume or revive → the row's host; a
       continue-from-headless → its row's host, else the brain (runs are brain-only until phase 5);
       a failover stand-in → the walled terminal's host (and admission-exempt); a ticket → the brain
       if its worktree directory exists there, else the host of the last terminal that worked it
       (while that host is still joined); an explicit `cwd` with no pin → the brain (it is a brain
       path). A pin that disagrees with a sticky host is refused, not obeyed.
     - **One door:** `openSession` calls `placeTerminal()` before any row is written, replacing the
       brain-only admission check; `assertRemotePlacement` still re-checks lock #1 right before a
       remote spawn. So the Desk's Auto (`POST /sessions` with no `host_id`), `mc session new`,
       Robert, Leads, failover stand-ins and revives all place the same way. `POST /sessions`
       answers a refusal with its status (403 policy, 409 unavailable, 400 full — what a saturated
       brain always answered). Opens that read a brain file are pinned `local`: the login terminal a
       headless job opens (`runner.ts promptLogin`) and the next-day planner (its brief is a brain
       path).
     - **Kill switch** `CHRONOS_PLACEMENT=auto|pinned|local` (default `auto`): `pinned` is phase 3
       (only pins and sticky rows leave the brain), `local` refuses pins elsewhere too. Sticky rows
       reopen on their host in every mode — the switch stops new work flowing out, it does not strand
       a terminal whose transcript is on another disk.
     - **Visibility:** when there was a choice (more than one computer in play) or the pick is
       remote, `sessions.placement` (migration 135) holds the reason ("most headroom (m2 62 · local
       70−25)", "pinned", "sticky — …"), the log gets one `[placement]` line, and the bus
       `session.placed {session_id, host_id, reason}`. The Desk's host tag / stage chip tooltip shows
       it. With one computer nothing is written: the column stays null.
     - **Per-host governor:** vitals frames carry `ncpu`, `load1`, `swapUsedMb`, `swapTotalMb`
       (protocol **1.2**, additive; a 1.1 host still works with its ratios, `ncpu` read as 1), and
       hello carries `capabilities.auto_clone`. `RemoteHost.vitals()` runs `machine.ts admission()` on
       them (`loadFromVitals`) — the Desk's Computers view reads the same verdict — and vitals older
       than six frames (30 s, by the brain's receive time, not the host's clock) are no reading.
     - **Per-host heavy slots:** `machine.ts`'s slot queue became a `HeavyPool` class; the brain keeps
       one per host (`heavyPoolFor(id, size)`), the brain's own under the old function names.
       `RemoteHost.slots` is its host's pool, sized `max(1, floor(ncpu / 6))` of that machine on every
       grant. `GET /machine` and `/machine/slots*` serve the caller's computer: `forwardedHost(req)`
       (the brain's own stamp, behind `forwardedGate`) → that host, else the brain. A terminal's slots
       are released on `session.ended` whichever pool holds them.
   - **Deferred:** a remote spawn that fails after an Auto placement (the host refuses, a profile
     turns out not to be logged in) is not retried on the next computer — the open fails with the
     host's message; the brain reserve is one knob (`hosts.reserve_json` is stored and pushed to hosts
     but not read by placement); the dispatcher's headless runs and the `placement: hosts | hosts+cloud`
     workspace setting wait for phase 5; per-host `mc heavy` is keyed by the forwarding host only (an
     `x-mc-session` alone, without the forwarder's stamp, is the brain's own agent); the full ⇧N
     dialog still has no computer picker.
   - **Deviations:** the brain is not subject to eligibility checks (its own guards run in
     `openSession`, and a single-machine install must place exactly as before); `local` cannot be
     drained (the API refuses, as in phase 2), so "drain" applies to hosts. A ticket's worktree is
     sticky by record (the brain's directory, or the last session's host) rather than by asking hosts
     what they have. Refusal wording with one computer in play is today's, word for word
     (`machine saturated — …`); with several it is `no computer has room — m2: …; m5: offline; local:
     …`. The two Desk heartbeats in `startServer` are `unref`'d so a test can boot the real API and
     exit.
5. **Headless runs and the ship pipeline.** `spawn_proc`, `host.exec()` for gates, reviews and
   delivery; `gh` capability; the verifier on the host; egress proxy and CA on the host.
   - **Landed:**
     - **ProcSpec** (`src/hosts/proc-spec.ts`): `spawn_proc`'s intent. The repo by git remote, every
       workspace repo, a cwd ONLY when the host reported it (a worktree it made), the profile by name,
       sandbox + egress policy, env through the terminals' `portableEnv`, the run's timeout, and the
       ticket markdown (it lives in the brain's gitignored `.mc/tickets/`) delivered as a file. The CLI's
       argv is built **by the host** with its own backend registry from a pseudo-job: goal, system text
       and trigger context are prose the brain composed (tickets.ts, reviews.ts…), and the brain paths
       in them — the worktree, the repo, the ticket file — become `{{chronos:repo:<id>}}` /
       `{{chronos:wtroot:<id>}}` tokens the host expands to its own paths. `brainPathsInProc` refuses a
       spec with a brain path anywhere else (asserted in tests).
     - **The host** (`src/hostd/procs.ts`, sharing `resolve.ts` with terminals.ts): veto first, then
       checkout / host-reported cwd (held to its checkouts and their worktree roots) / profile / the
       runner's own worktree sandbox (main checkout read-only, `.git`/`.mc` granted) / egress / prepare.
       Stdout goes out as **whole lines** through a seq'd `Ring` of 4 MB (`PROC_RING_BYTES`: an evicted
       line is a lost run event), stderr as `stderr` frames with the tail replayed on attach, steer via
       `stdin` frames; `kill` / `ack` / `attach` / `release` / `exit` are the pty frames, routed by
       channel owner (one channel-number space for terminals and runs). The host's **own watchdog**
       stops a run at its timeout + 15 s grace and reports `exit.timed_out` — a dropped link cannot leave
       a runaway. `exec` runs a command (or a gate line through `bash -lc` with the host's runtime PATH)
       in a checkout/worktree it reported, with its own timeout and head/tail output caps; `oneshot` is
       the verifier's judge there; `worktree_ensure` makes a ticket worktree under its checkout.
     - **Brain** (`RemoteHost.spawnProcess` → `RemoteProc`): the `ProcHandle` runner.ts already reads —
       stdout a stream fed in seq order (SeqTracker drops a resend's overlap), `onClose` after it drained,
       steer writes held across a drop. `execute()` builds the ProcSpec instead of an argv for a remote
       run and hands the handle to `superviseRun()` (split out of execute: reader, steer, watchdog,
       close → finalize), so a remote run is parsed, steered, timed out and finalized by the same code.
       `runs.cwd` records where it ran on its host.
     - **Placement** (`src/hosts/run-placement.ts`): `dispatch()` places a run before `pump()` (gotcha #1)
       with the same `place()` — `opened_by: agent`, so never past a host's admission, with the brain's
       reserve — plus `needs.procs` (protocol 1.4 hosts), `needs.gh` for `ci-fix:`/`merge-gate:`,
       `needs.brokered`. Sticky: a job pinned to a host's worktree (`jobs.host_id`, migration 137), a
       native resume of a transcript on a host. A run is never refused for load: no eligible host / no
       room → the brain, as before (only sticky work can be refused, when its computer can't take it).
       Kill switches: `CHRONOS_PLACEMENT` (now for runs too) and per workspace `placement: brain|hosts`.
     - **Which runs move**: `ticket:`, `ci-fix:`, `merge-gate:` (worktree on the host — tickets.ts places
       FIRST and creates the worktree there, so no brain worktree makes the ticket look brain-bound);
       the read-only `plan:`, `grade:`, `review:` (pinned to its build's worktree), `distill:`, `ideas:`;
       and any job whose cwd is a workspace repo's checkout. **Stay on the brain:** `intake:` and
       `prose:` (Slack/MCP read through the brain profile's OAuth logins), `dream:` (no repo; brain
       state, brain landing dir), cloud hand-offs, unscoped jobs, jobs started in any other brain
       directory or granted brain-only add-dirs, and any job whose goal still names a brain file after
       tokenizing (attachments, a no-repo ticket's markdown). Robert's manager, the one-shot helpers,
       the next-day planner and accelerators are not jobs and never reach placement.
     - **The ship pipeline** (`src/hosts/workdir.ts`): a `WorkDir` is a directory with its owner;
       `execIn` is `execFileTimed` on the brain and `host.exec` elsewhere. Routed through it: gates
       (`runGates`/`mergeGate` take injected runners, so gates.ts stays store-free for the host), the
       review diff/commit (`captureDiff`, `createForRun`, `ensureReviewForTicket`), `merge()` — `shipPR`
       (push + `gh pr create` with the host's gh login, GH_CONFIG_DIR from the workspace env), the
       checkout back to default, commit delivery landing on **that host's** checkout — and the verifier
       (`oneshot` on the host). The reviewer and a rate-limit stand-in inherit the build's pin. Merge by
       PR URL, the delivery poll and post-merge commands stay on the brain.
     - **Reconnect** (`src/remote-runs.ts`): boot leaves remote running runs alone and sweeps QUEUED
       ones wherever placed (the queue was memory), plus runs on revoked hosts. On hello: held →
       re-attach; reported but not held (brain restarted) → adopted (`adoptRun`: same supervisor, the
       watchdog minus elapsed time, then the dispatcher's `afterRun` retry/chain); not reported (host
       restarted) → `interrupted` naming the host (the recovery card's, as after a deploy); ended here →
       killed there. Revoking a host interrupts its runs. `stopRun` / continue-from-run kill a remote
       run through its channel; a continued run's terminal opens on its host in `runs.cwd`.
     - **Egress on hosts** (`src/egress-core.ts`, `src/hostd/egress.ts`): the proxy is store-free; a
       host runs one per workspace from the policy each spawn carries (terminals and runs), locks the
       agent to it with Seatbelt in `enforce`, refuses a locked spawn it cannot proxy, and streams each
       allow/deny back as an `egress` frame into the brain's audit log (dropped if that workspace may
       not run on that host). The phase-3/4 "egress-locked stays on the brain" rule is lifted for hosts
       that report `capabilities.egress`.
     - **Protocol 1.4** (additive, one block in wire.ts): `stdin`, `stderr`, `egress` frames,
       `exit.timed_out`, `capabilities.procs/egress`, the exec spec/result.
   - **Deferred:** `placement: hosts+cloud` — choosing Cursor Cloud for a job on its own needs a job
     shape it can take (GitHub-only, `delivery=pr`) and a budget rule so the operator never gets a
     surprise bill; not a small addition, so the setting takes `brain|hosts` only. Credential brokering
     on hosts (and so a CA on hosts): a brokered workspace stays on the brain. Ticket attachments are
     not shipped (a run whose goal names them stays on the brain; a reviewer pinned to a host after
     attachments were added sees their paths but not the files). An adopted steer-mode run resumes with
     one message outstanding; steers queued in the dead brain's memory are gone (the mailbox is the
     durable path), and bytes processed but not yet acked when the brain died can repeat once. The
     ticket-file copy is synced back only by the brain that sent it (not after an adoption). A host
     update or restart ends its runs (they are its children) — they come back as `interrupted`, not
     resumed.
   - **Deviations:** runs are placed in `dispatch()` and build worktrees in tickets.ts before the job
     exists, rather than both by one call; `exec`/`oneshot`/`worktreeEnsure` live on `RemoteHost`, not
     the `Host` interface (on the brain they are the execFile calls the modules always made). Exec is
     held to the host's checkouts and worktree roots (defense in depth on top of the veto). Commit
     delivery for a build that ran on a host lands on the host's checkout, not the brain's — the branch
     only exists there. Checkout scans for `exec` are cached for a minute.
6. **Onboarding polish.** `npx getchronos host join` published, `chronos host doctor`,
   `CONFIGURATION.md` section, and an "update host" flow for version mismatches.
   - **Landed:**
     - **Node:** better-sqlite3 11 → 13 (N-API, prebuilds inside the npm tarball: no install script,
       no compile, one binary for every node major). `engines.node` `>=22 <27`. Verified: `npm ci` +
       the whole suite on node 26.10 (where 11.10 fails to compile) and 24.8; `npm ci` + both natives
       loading on 22.23.
     - **Preflight** (`bin/host-core.mjs`, plain JS with no dependencies, so it runs on a broken tree):
       node in 22–26, `node_modules` whole (tsx unless `dist/` is built; better-sqlite3 and node-pty
       actually load; node-pty's `spawn-helper` executable), git on PATH able to fetch over https
       (`--exec-path` exists and has `git-remote-https`). Each failure prints one `fix:` line using
       `$HOME`. `join`/`update` stop on any failure; `run` (what launchd restarts forever) stops only
       on what would crash anyway and logs the rest; `doctor` lists them first.
     - **CLI** `bin/getchronos.mjs`: `host join|run|status|doctor|update|uninstall` (+ internal
       `preflight`). `npm run host` is now `node bin/getchronos.mjs host`; it preflights, then loads
       `dist/hostd/index.js` or `src/hostd/index.ts` through tsx **in the same process** (signals from
       launchd reach the host). The LaunchAgent runs it; `hostEntryArgs` keeps the direct entry for a
       tree that predates it.
     - **Package** `getchronos` (still `private: true` — publishing is the operator's call): bin
       `getchronos`, a `files` allowlist (`bin/`, `dist/` minus tests, the host plist template,
       `scripts/mc` + its skill, the node-pty postinstall, `HOSTS.md`; `.pem`/`.secrets*`/`*.db`
       negated), `prepack` = build. `pack.test.ts` plants decoys and asserts none ship.
     - **Install path:** `installKind()` — `git` (the clone at `~/.chronos-host/app`), `npm`
       (`~/.chronos-host/app/node_modules/getchronos`), `ephemeral` (npx's cache: join installs the
       same version into `~/.chronos-host/app` with this node's npm and re-runs join from there — a
       LaunchAgent must not point into a cache npm prunes), `dev` (any other checkout: runs, never
       updated from the Desk). The plist's node is `stableNodePath(process.execPath)`.
     - **Self-update** (`src/hostd/update.ts`, protocol **1.3**, additive): hello carries `commit`
       and `install`; brain → host `update{id, target}`, host → brain `update_status`. Staged
       candidate, same-node `npm ci`/`npm install`, candidate preflight, rename swap, plist rewrite,
       `kickstart -k` of its own label (only when launchd runs this very pid). The brain keeps each
       host's last update in memory (`requested → running → restarting → done|failed`), settles it on
       the next hello, and times one out after 20 minutes. `updateVerdict()` (pure, `view.ts`):
       git hosts compare commits, npm hosts versions; a host that reports no `install` predates this
       and is "update available, by hand" with the one line to paste. `POST /api/hosts/:id/update`,
       `POST /api/hosts/update-all`. Desk: version line, *Update* (armed) and *Update all*.
     - **Join UX:** the command starts with a node check, uses `"$HOME/…"`, resets an existing clone
       to `origin/main` instead of `pull --ff-only` (which fails on the detached HEAD an update leaves),
       and becomes `npx -y getchronos@<brain version> host join …` with `CHRONOS_HOST_INSTALL=npm`.
       + Add lists the prerequisites.
     - **Uninstall:** bootout + plist; `--purge` removes `~/.chronos-host` (refuses a directory that
       does not look like one); prints what it left.
     - **postinstall fix:** `scripts/fix-node-pty-perms.mjs` resolves node-pty through module
       resolution — installed as a dependency, npm hoists node-pty beside `getchronos` and the old
       relative path fixed nothing.
     - **Menu bar** (after phase 6): `desktop/hostbar.swift` + `getchronos host menubar
       install|uninstall|status` (`src/hostd/menubar.ts`), `join --menubar`, rebuilt by a self-update
       (`afterSwap`), listed by `doctor`, removed by `uninstall`. `/__host/status` grew `link`,
       `reason`, `name`, `version`/`commit` and `work[]` from an allowlist (`status.ts`); the brain's
       `welcome` carries the host's Desk name (additive, no protocol bump). See *Menu bar* above.
       Deviation: the LaunchAgent is `KeepAlive {SuccessfulExit: false}` rather than `KeepAlive true`,
       so **Quit** is not undone by launchd a second later.
     - **Brain menu bar**: the same item on the brain, `--brain`, for the whole fleet
       (`GET /api/hosts/bar`, `src/hostlink/bar.ts`; `scripts/build-brainbar.sh` /
       `scripts/brainbar.mjs`, LaunchAgent `sh.chronos.brainbar`; `npm run deploy` refreshes it only
       when installed). No `mc menubar` subcommand: `mc` is the agents' CLI and runs sandboxed,
       while installing a LaunchAgent is the operator's call. See *Menu bar → On the brain*.
   - **Deferred:** publishing (see *Publishing* below); a Desk "roll back" (`app.prev` is kept, the
     rollback is one pasted line); streaming `update_status` across a link drop mid-update (the final
     state still arrives via hello); a Desk update for a host started by hand; migrating a host's
     loaded LaunchAgent definition in place (an update rewrites the plist file for the next login,
     while `kickstart` restarts the definition launchd already has — which already points at the same
     app dir); Linux hosts.
   - **Deviations:** "`git fetch && git reset --hard <sha>` in the app dir" became a staged clone at
     `<sha>` beside it, because `npm ci` in place deletes the running host's `node_modules` and a
     failure there leaves nothing to restart into — the one outcome this phase exists to prevent. The
     join line resets to `origin/main` (not the brain's commit) so a brain on an unpushed commit can
     still add computers; the Desk then offers the update.

### Publishing (operator)

Prepared, not done. From a **fresh clone** (a stale `dist/` would ship otherwise), with node 22–26:

```bash
git clone https://github.com/leorfer23/getchronos /tmp/getchronos-release && cd /tmp/getchronos-release
npm ci && npm test
npm pack --dry-run          # read the file list: bin/, dist/ (no tests), plist template, mc, skill
npm pkg delete private      # the safety latch
npm login && npm publish --access public
```

Then set `CHRONOS_HOST_INSTALL=npm` in the brain's `.secrets` and `npm run deploy`: new join lines
become `npx -y getchronos@<version> host join …`. Bump `version` on every release — npm hosts update
by version, not commit.

## Open questions

- **Distribution.** Prepared as `getchronos` (phase 6; see *Publishing*). Still `private: true` and
  unpublished, so the join line stays git until the operator publishes. Open: publish on every merge
  to main (versions move with commits), or only on tagged releases?
- **Auto-clone.** Off by default: cloning a client's repo onto an employer-owned machine is a
  decision, not a side effect. Is a per-host opt-in enough, or per workspace × host?
- **Tunnel for hosts by default?** The tunnel works anywhere and needs no new brain listener, but
  every keystroke goes through the Cloudflare edge. The current proposal is LAN first, tunnel second.
