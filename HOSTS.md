# Hosts — one Desk, N computers

> Status: **built.** All six phases have landed — the seam (`src/hosts/`), the link, join and host process
> (`src/hostlink/`, `src/hostd/`), remote terminals, placement and the per-host governor, headless runs
> and the ship pipeline on hosts (`src/remote-runs.ts`, `src/hostd/procs.ts`), and onboarding
> (preflight, `getchronos`, self-update, uninstall). This file describes the system as it is; the
> phase-by-phase build log is in [docs/hosts-history.md](docs/hosts-history.md).

**Contents** — [The gap](#the-gap) · [What it is](#what-it-is) · [Non-goals](#non-goals-v1) ·
[Architecture](#architecture) ([the seam](#the-seam-host) · [transport](#transport) ·
[`mc` on a host](#mc-hooks-and-the-sandbox-on-a-host) · [placement](#placement) ·
[reconnect and restarts](#reconnect-and-restarts) · [ship pipeline](#the-ship-pipeline-on-a-host) ·
[Robert and the fleet](#robert-and-the-fleet)) · [Security](#security) ·
[Setup](#setup-what-the-operator-does) ([before adding](#before-adding-a-computer) · [adding](#adding-it) ·
[updating](#updating-a-host) · [uninstalling](#uninstalling) · [menu bar](#menu-bar) ·
[troubleshooting](#troubleshooting)) · [Coupling inventory](#coupling-inventory-historical) ·
[Build history](#build-history) · [Publishing](#publishing-operator) · [Open questions](#open-questions)

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
  `profile name → dir` (the same `~/.claude-*` discovery as `config.ts:108`, run on the host, and run
  again on every hello and inventory look — see *Inventory stays true*), each with `auth`: whether it
  is logged in. The spec carries the name.
- **`sessions.host_id`** (default `local`). `sessions.cwd`, `worktree_path` and `pid` are
  interpreted on that host. `runs.host_id` does the same for headless runs.

### Inventory stays true

`hello` carries a host's inventory once per connection; a link that stays up for a week would keep
reporting the day it connected. So (protocol 1.5) the host looks again — profiles re-discovered,
logins probed, roots re-scanned, CLIs re-checked (`src/hostd/inventory-push.ts`):

- **every 10 minutes**, and ~2s after a `~/.claude-*` directory or a top-level entry under a
  `CHRONOS_HOST_ROOTS` root changes (`fs.watch`, non-recursive; a new profile directory is looked at
  again 2 minutes later, because the login finishes after the `mkdir`), and when the brain's policy
  names new GH_CONFIG_DIRs;
- and pushes an `inventory` frame **only when something differs** from what the brain last heard
  (only to a brain whose welcome says 1.5+).

The brain stores it like a hello (live hello for placement, `capabilities_json` + `repo_checkouts`)
and, when anything changed, publishes **`host.inventory`** `{host_id, name, reason, changes[]}` —
short phrases like `profile claude-acme logged in`, `checked out web`, `gh ~/.config/gh-acme not
logged in`. The Desk repaints on it; anything that wants to wake on "a computer can now do X" can
listen for it.

- **Profile login (`auth: yes|no|unknown`).** claude keeps a profile's login in the keychain item
  `Claude Code-credentials-<first 8 hex of sha256(dir)>` (the default `~/.claude` also checks the
  unsuffixed item), or in a credentials file in the dir. The host checks the item's **existence**
  with `security find-generic-password -s <name>` — never `-w`/`-g`, the secret is never read. A
  process whose keychain search list has no login keychain (an SSH session; launchd outside the
  login session) answers `unknown`, never `no`. Placement refuses a claude-code terminal on a
  profile reported `no` ("profile X not logged in there") unless the workspace env carries
  `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`; `unknown` is allowed. Profile routing on a host
  skips a sibling reported `no`.
- **gh login.** The brain's `policy` frame carries `gh_dirs`: each distinct `GH_CONFIG_DIR` the
  workspaces allowed there carry in their env (`~/…`). The host runs `gh auth status` (10s timeout)
  for each, plus gh's default, and reports `gh[] {dir, workspaces, auth, account}`. Shown in the
  Desk's Tools row and in `doctor`; **never** a placement veto.
- **Refresh.** `POST /api/hosts/:id/refresh` (admin; Desk → Computers → *Refresh*) re-sends the
  policy, then asks the host's `inventory` rpc for a fresh look and applies it; the answer lists what
  changed. For `local` it re-discovers the brain's own profiles. A 1.4 host answers the same rpc
  (without logins or gh), so Refresh works on it too.
- **Vitals failures are said.** A host whose vitals sample throws logs `[host] vitals failed: …` once
  per distinct error and sends it to the brain (`[hostlink] <id> reported vitals: …`), so "no recent
  vitals" in a placement refusal has a cause to find.

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
               inventory{reason, clis, profiles, checkouts, gh}           ← 1.5, on change
brain → host   spawn_pty{id, spec}  spawn_proc{id, spec}  write{ch, bytes}  resize{ch, cols, rows}
               kill{ch, signal}  rpc{id, op, args}  api_result{req_id, status, body}
               policy{deny[], reserve, gh_dirs[]}  ack{ch, seq}
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
- When the brain is unreachable the forwarder does not just fail: status writes are queued and
  replayed, `mc heavy` is granted locally, the rest get a readable 503 (see *Reconnect and restarts*).
- The per-workspace **egress proxy** (`egress.ts`) runs on the host, next to the agent, with the
  policy the brain sends. *(Phase 5: without credential brokering — a workspace whose egress
  intercepts TLS to inject a secret stays on the brain, so no CA exists on a host; see phase 5.)*

**`mc` commands that name a path.** A path an agent on a host types is a path on THAT disk, so every
command that carries one either goes to the host or carries the content instead:

| Command | On a host |
|---|---|
| `mc worktree list` | the brain asks every online host about the caller's workspace repos (rpc `worktree_list`, by git remote, each with its default branch); rows carry `host_id` and the host's `repo_path`. An offline host's trees are not listed until it reconnects; a host from before the op lists none. |
| `mc worktree rm` | routed by the tree's host (`removeWorktreeAs` prefers the caller's own computer when a path or branch exists on two). The brain checks who may (owner / Lead / Robert) and its own sessions on that host for busy; the host (rpc `worktree_remove`, `src/hostd/worktrees.ts`) checks what may: a `.chronos-worktrees` tree that git lists for its checkout of that repo, never the checkout itself, never one a terminal or run there is in, never uncommitted edits or unpushed commits without `--force` — the same `removeWorktreeAt` (`worktree-core.ts`) the brain runs on its own trees. The terminal's host offline → 409 saying so. |
| end of a ticket terminal | the brain's clean-only cleanup runs on the host (`worktree_remove` with `mode: "cleanup"`); host offline → left there. |
| worktree reaper | `reapDoneWorktrees` also asks each online host, on the monitor's sweep and 60 s after a host's hello: the same rule as the brain's own (an `mc/<key>` branch of a finished ticket, clean, nothing working in it). That is also how a tree left by a terminal that ended while its host was away goes. |
| `mc pdf <file>` | sends the file's bytes (`{b64}`, ≤ 11 MB, inside the 16 MB JSON limit) — always when `MC_HOST_ID` names a host, else when the brain answers *not found* for the path. Bytes are read by the caller, so no path scope applies. |
| `mc job new` | the job is pinned to the forwarding host (`jobs.host_id`; its cwd stays the host's path) when the cwd is one of the workspace's checkouts that host reported, a folder in one, or a worktree under one (`src/hosts/job-cwd.ts`); otherwise refused with the checkouts it does have. Never the old silent fallback to the brain's `$HOME`. |
| `mc ticket get` | the ticket's markdown lives on the brain, so a remote terminal's seed says `mc ticket get <key>` instead of a path; the brain's tickets dir is not granted on a host. |

### Agents know where they are

An agent on m2 that says "open http://localhost:5173" is pointing the operator at the brain's port
5173. So every agent is told which computer it is on, and the board does not pretend otherwise:

- **Env.** Every terminal and headless run gets `MC_HOST_ID`, `MC_HOST_NAME` (the operator's name for
  the computer) and `MC_HOST_BRAIN` (`1` on the brain, whose id is `local`). The brain sets them in
  `mcEnv`; a host re-stamps them from its own identity at spawn (`hostd/resolve.ts` `hostSelfEnv`),
  so they are right even while the brain is away.
- **Prompt.** A terminal on a host is opened with one short block (`agents/_blocks/on-host.md`):
  localhost, files, the browser and logins are THIS machine's; show the operator a page with
  `mc artifact put`; `mc clip` is the operator's clipboard. Nothing is added on the brain.
- **`mc whoami`** prints computer, workspace, repo, session, cwd and api — from the env first, then
  the brain's view of the session (bounded, so it still answers while the brain is away).
- **`mc session list`** shows each terminal's computer (`host_name` on `GET /sessions`), and
  **`mc repo list`** from a host shows that host's checkout (`host_path`, added to `GET /workspaces`
  only for a forwarded request) or "not on this host".
- **Loopback links on the board.** A remote terminal's Focus feed rewrites `http://localhost:5173/x`
  to `localhost:5173/x (on m2)` (`focus.ts` `tagLoopbackLinks`): text, not a link that would open the
  brain's port. Hosts are not reachable by address from the brain (they dial out), so nothing is
  rewritten to a LAN URL.

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
While the brain is away the host grants from its own pool of the same size.

**The shared browser is per host too.** `mc browser` asks through the forwarder; the brain keeps the
lease in that host's pool and drives the host's OWN headless browser over the `browser` rpc, so the
CDP endpoint an agent gets is on its own loopback. Caps come from the host's RAM and its own
`CHRONOS_BROWSER_*`. No leases while the brain is away (RESOURCES.md → Shared headless browser pool).

### Reconnect and restarts

What survives what:

| Event | PTYs on that host | What the brain does |
|---|---|---|
| Link drops (Wi-Fi, sleep, the brain's lid closed) | keep running; output buffered in the ring, overflow spilled to disk; `mc` keeps working (below) | cards show "host offline"; on reconnect `hello.live[]` → re-attach, resend from the last ack (spilled output first), then the host replays its queued `mc` writes |
| Brain restart / deploy | **remote PTYs keep running** | boot reconciles: `listLive()` per host, re-attach. `reapAll()` (`store/sessions.ts:365`) and the boot-time `interrupted` sweep (`db.ts:58-74`) only apply to `host_id = 'local'`. Otherwise every deploy would double the fleet. |
| `chronos host` restart / update | die with it (children of the host process) | revive with `--resume` **on the same host**, the same path `local` takes after a deploy today |
| Host offline past `CHRONOS_HOST_FAILOVER_GRACE_MIN` (default 20) | unreachable (powered off, asleep, off the network) — and **frozen by its own fence** a little before the grace (below) | **host failover** (`src/host-failover.ts`): each live terminal on it is reopened on an online computer — the brain when it has the repo, else the hosts placement would allow (policy, veto, CLI and login, profile, checkout, sandbox — `ineligible()`), most headroom first, the next one when an open fails. The branch is checked out fresh from origin when it was pushed (else a new worktree off the default branch, and the seed says so — and names the `wip/<id8>` branch its unsaved work lands on if the host comes back). A claude terminal resumes its conversation from the brain's transcript mirror (copied to `<profile>/projects/<slug of the new cwd>/<new id>.jsonl`, the only place `claude --resume` looks); any other gets a brief. A ticket's stand-in is never sticky to the dead host (`stickyFor` ignores a `movedFrom` open, and a moved row no longer makes its ticket sticky). A Lead's worker that moves keeps its slice (re-pointed to the stand-in) and its Lead's inbox says `moved → <new id8>`. The host is checked again right before the stand-in opens and before the old row ends: back by then → no move (a stand-in already open is closed again). The old row ends with `end_reason` `host_failover`, one line per host goes to the Desk chat, and when the host reconnects reconcile **salvages** the old process's worktree, then kills it (its row ended here) — never resumed. A move that could not happen is said once, and tried afresh after the host has been back. Counted from the brain's boot and its last wake from sleep too (`kern.waketime`, dark wakes included — a closed lid on battery wakes the brain for seconds at a time, too short for a host to finish a hello), so neither a brain restart nor a closed lid moves anything that simply has not reconnected yet. `CHRONOS_HOST_FAILOVER=off` restores the wait |
| Host gone for good | — | Desk → Computers → Remove: its live sessions end, its checkouts are forgotten, its token is revoked |

**While the brain is away, a host keeps its agents working and catches up after** (`src/hostd/`):

- **Status writes are queued.** `mc state`, `mc progress`, card hook events, `mc step`, `mc learn`,
  `mc remember`, `mc pad add|append` — an explicit allowlist in `outbox.ts` — go to
  `~/.chronos-host/outbox/` (one 0600 file each, with the request's own headers minus those the
  brain drops anyway — admin token, `authorization`, cookies, Access headers — so the brain still
  attributes them to the right terminal; sealed from agents, see *Security*). The forwarder answers `202 {queued:true}`; `mc` prints
  `mc: queued — …` and exits 0. After the welcome they are replayed in order, and while any are left
  new allowlisted writes queue behind them (a fresh `done` must not be overwritten by a stale
  `working`). 4xx drops an entry, 503 stops the replay until the next try (30 s), a 5xx five times
  drops it. Capped at 2000 writes / 16 MB, oldest dropped first. Delivery is at-least-once.
- **Everything else answers 503 with words**: `{error: "brain unreachable from this host — …",
  retry_after_s: 60}`, and an ask (`mc ask-robert`) says the operator can't see it right now. Never
  queued: a question nobody can see is not worth waiting on.
- **`mc heavy` is granted from the host's own pool** (`ncpu/6`, the brain's rule for this machine),
  also when the link drops mid-poll. A slot granted locally stays local until released, even after
  the brain is back — for that overlap the host can briefly run up to twice its suites.
- **Output past the ring spills to disk** (`spill.ts`, `~/.chronos-host/spill/`, 64 MB per
  channel): what the ring would evict unacked is appended to a per-channel file with its seq and
  resent ahead of the ring on attach, so the brain's ack/resend logic sees one unbroken stream. The
  file goes once the brain acks past it; a full spill is a gap, as before. Wiped at host start.

#### The fence: two agents never work the same goal

The brain cannot tell a host that is gone from one it merely cannot reach, so failover alone could
leave the original running beside its stand-in. The host fences itself (`src/hostd/fence.ts`):

- Every `welcome` carries the brain's grace (`failover_grace_ms`, protocol 1.6; null when
  `CHRONOS_HOST_FAILOVER=off`). A host that has heard nothing from the brain for the grace **less a
  margin** (a quarter of it, at most 2 minutes: 18 of 20 minutes) freezes every terminal and run it
  holds — `SIGSTOP` to the terminal's process group (the CLI and the commands it runs), never a kill.
  Both sides count on their own clock from the last frame they heard; the host's mark is never more
  than one vitals interval (5 s) later than the brain's, so the margin is the guarantee. A host that
  slept through the grace freezes on its first tick awake, before its link can come back.
- Nothing thaws on its own. When the link is back, reconcile decides per channel: `attach` (still
  this host's — `SIGCONT`, it carries on, output resent as usual) or salvage + `kill` (it was moved).
  A kill to a frozen process is followed by `SIGCONT`, so it lands.
- The brain asleep looks the same from the host: a closed lid on the brain pauses the hosts' work
  after 18 minutes, and it resumes within seconds of the brain waking (the brain itself never moves
  anything before it has been awake for the whole grace — `kern.waketime`). That is the price of
  never running a goal twice; `CHRONOS_HOST_FENCE=off` on a host trades it back.
- Frozen work is visible: `host status` prints a `fence` line, `GET /__host/status` (the menu bar)
  carries `fenced` and `frozen` per item, and `hello.live[]` marks frozen channels. Frozen work does
  not count as busy (the host may idle-sleep).
- Runs (`procs.ts`) share the host process's group, so only the run's CLI is stopped; a command it
  started keeps going until it ends. A run's own timeout still applies while frozen.

#### Salvage before kill

A moved terminal's worktree may hold what its stand-in was told it lost. When reconcile finds it on
a returning host, the brain asks the host (rpc `salvage`, `src/hostd/salvage.ts`) to push it first:
uncommitted changes and unpushed commits become one WIP commit — built on a scratch index from the
working tree, parented on HEAD, so the worktree, its branch and its index do not move — pushed by sha
to `wip/<session id8>` with `--no-verify`. Never a force push, never the default branch, never the
shared checkout (only a linked worktree: the shared one holds other terminals' work). Then the
process is stopped. The Desk chat gets one line (`m2 is back: … now on origin as wip/ab12cd34 — told
ef56…`), and the stand-in (found by its placement line) is told the branch to fetch. A failed push
says where the worktree still is. An older host answers `unknown op` and gets the plain kill.

#### A host the brain refuses

A protocol the brain cannot speak (close 4426), a hello naming another id (4403), a revoked or
disabled credential (4401, or HTTP 401/403 at the door): the brain logs it once and keeps it
(`refused` in `GET /api/hosts`; the Desk shows **needs update** / **refused**, and for a version the
one line to paste on that Mac). The host freezes its work at once (the brain will not take it back),
shows `rejected` in `host status`, and asks again every 10 minutes instead of giving up for good.

#### Awake while working

A host holds `caffeinate -i` while it has unfrozen work (`src/caffeinate.ts`, the brain's
`awake.ts` mechanism without the store): an idle-sleeping host looks gone to the brain. On battery
too — the work is why the Mac is a host — down to 20 % charge. It cannot beat a closed lid.

Not done: an update-only handshake, so the Desk's **Update** button could reach a host refused for
its protocol (today: the pasted line); resuming a moved claude terminal's conversation ON ANOTHER
HOST (only the brain holds the transcript mirror, so a remote stand-in gets a brief).

### The ship pipeline on a host

Build, gate, review and merge (`runner.ts`, `gates.ts`, `reviews.ts`, `delivery.ts`) do their git
work in the worktree, and that worktree is on the host. They switch from `execFileSync(…, {cwd})` to
`host.exec({cwd, cmd, timeout})`. The host enforces the timeout itself, so a dropped link can't
leave a runaway gate. `gh` runs where the worktree is, so the host needs `gh` logged in for that
workspace. The host capability report covers it and placement checks it. Merges by PR URL can stay
on the brain.

### Robert and the fleet

Robert runs the computers the way he runs the terminals: he can see them, he is woken when one needs
a call, and changes to them are the operator's (`agents/_blocks/hosts.md`, in both his surfaces).

- **What he sees.** With more than one computer, his turn opens with a `HOSTS:` line ahead of FLEET
  NOW (`src/fleet-line.ts`, from `hostsView()`): per computer cpu/ram, live terminals, and what is
  wrong — `m5 OFFLINE 12m`, `draining`, `full (…)`, `claude logged out`, `profile claude-acme logged out`, `behind brain (update)`. A
  terminal on a host ends its FLEET NOW row with ` · @m2`, plus ` · ⚠ m2 offline` while that link is
  down. A brain with no joined host builds none of it (one SELECT) and reads exactly as before.
- **`mc hosts`.** `mc hosts` lists the computers (status, load, live, commit/behind, notes), `mc hosts
  show <name>` prints one in full, `mc hosts drain|resume <name>` and `mc hosts update <name|all>`
  call the admin routes. Without the admin token (a terminal, a Lead) it reads `GET /api/hosts/brief`
  instead (`src/hosts/brief.ts`): per computer name, online, headroom, live count, and whether *the
  caller's own* workspace may run there (`ineligible()`, the verdict placement acts on) — never another
  workspace's policy, the inventory or a token. A workspace token answers for its own workspace only.
- **Where a terminal went.** `POST /api/sessions` answers with `placement` (why) and `host_name`, and
  `mc session new` prints them: `spawned session 1a2b3c4d (claude-code/·) → m2 (most headroom (…))`.
- **What wakes him** (`src/robert-host-drive.ts`, same durable queue and Desk thread as terminal
  wakes, all-workspaces scope): a host offline past the failover grace + 2 min *with terminals on it*
  (an idle laptop closing is not news); terminals host failover could not move (`session.host_failover`
  mode `stuck`, batched per host); a `host.policy_violation`; a CLI that an allowed workspace's default
  backend needs reported logged out, or a claude profile those workspaces are pinned to reported
  logged out (protocol 1.5 `auth`; a `host.inventory` change triggers a sweep within seconds); a
  connected host behind the brain for
  `CHRONOS_ROBERT_HOST_BEHIND_H` hours (default 24). Once per host per state (the offline episode, the
  policy, the brain commit, the CLI and day). Off with ⚙ Settings → Robert → *Wake on computer
  trouble* (`robert.hosts`, `CHRONOS_ROBERT_HOST_WAKES=0`) or the master `robert.enabled`; every new
  host wake counts against `robert.per_hour` with the terminal wakes.
- **What he may do.** Read anything. Pin a terminal (`--host`) only with a reason; placement is the
  default. Draining, disabling, revoking, policy and updates are confirm-first (a UI ask on the Desk, a
  ✅ card on Telegram); he never loosens a policy to make a refusal go away.

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
- **The host's state is sealed from its agents.** Agents run as the same user as `chronos host`, so
  mode 600 does not keep them out. Every Seatbelt profile (Desk terminals, headless runs, the
  verifier) denies read+write of the whole host home (`CHRONOS_HOST_HOME`, default `~/.chronos-host`:
  `.secrets`, `outbox/`, `spill/`) and the brain's `hostlink/` dir (TLS key, host token hashes,
  transcript mirrors) — `CONFIG.sandbox.sealed`, the last rules in the profile, after the agent's cwd
  and any `sandbox_allow` re-grant, and not replaced by `CHRONOS_PROTECTED_SECRETS`. Without it, one
  client's agent could read the host token or another client's queued workspace token. Sandbox
  mode `off` has no profile and no seal.
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
# Cloudflare Access service token (Zero Trust → Access → Service Auth). The Desk's
# "Anywhere" join command prefixes these so the host can pass Access on every reconnect.
echo 'CF_ACCESS_CLIENT_ID=…' >> .secrets
echo 'CF_ACCESS_CLIENT_SECRET=…' >> .secrets
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
   is shown locked), each client's profile logged in or not, each repo cloned or not, and each gh
   login its clients use. Fix anything ✗ on that Mac (`claude` login per profile, `gh auth login`,
   `git clone` under `CHRONOS_HOST_ROOTS`), then **Refresh** — or wait: the host notices within
   minutes (*Inventory stays true*). `npm run host -- doctor` there prints the same checklist,
   preflight first.

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
CHRONOS_HOST_FENCE=on                # off = never freeze work when the brain is unreachable (see The fence)
CHRONOS_HOST_AWAKE=on                # off = never hold caffeinate; _ON_BATTERY=off releases on battery
CHRONOS_HOST_AWAKE_MIN_BATTERY=20    # …and below this charge it releases anyway
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
- The same actions without the Desk (all admin-gated, `src/hostlink/brain-link.ts`):
  `POST /api/hosts/:id/update` (one computer; `mc hosts update <name>`), `POST /api/hosts/update-all`
  (every connected host that is behind; `mc hosts update all`), and `POST /api/hosts/:id/refresh` (look
  again at profiles, logins, clones and gh without updating). On the host itself,
  `GET http://127.0.0.1:<port>/__host/status` (loopback only, served by `src/hostd/forwarder.ts`) shows
  its version, commit and link state; `npm run host -- status` reads it for you.

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
| Placement says `profile X not logged in there` | The profile directory exists but its keychain login does not | `CLAUDE_CONFIG_DIR=~/.X claude` on that Mac, log in, then Desk → Computers → **Refresh** |
| A profile logged in since the host started is not offered | Before 1.5 profiles were discovered once per process | Handled: re-discovered on every look; Refresh to see it now |
| Placement says `no recent vitals from X` | The host's vitals sampler throws | `host.err.log` there (and the brain's log) has `vitals failed: <why>`, once per distinct error |
| Host log shows `[host] link down (closed 1006) — reconnecting`, or `closed 4408 no hello`, while the brain's lid is closed | Expected: the brain is asleep or unreachable, so the socket dies uncleanly (1006) or a half-open redial is dropped before its hello (4408, `HELLO_TIMEOUT_MS`) | Nothing. Terminals and runs keep going on the host; `mc` status writes queue in `~/.chronos-host/outbox/` and output past the ring spills to `spill/`. When the brain is back the log says `online via …` and `replaying N mc writes` |
| A host shows **offline** and the brain's `chronos.out.log` has no `[hostlink]` line for it at all | The brain logs a link only once its hello lands (`online via …`) or its credential is refused (`host upgrade refused …`); a connection that never arrives, or dies before hello, leaves no trace there | Look on the host: `host.out.log` / `host.err.log` print `[host] <url>: <error>` per failed dial and `brain refused this host — …` for 4401/4403/4426. Check the URL it dials (`npm run host -- status`): a LAN URL needs `CHRONOS_HOST_LISTEN` on the brain and the firewall to allow node; a tunnel URL needs `CHRONOS_HOST_PUBLIC_URL` and, behind Access, `CF_ACCESS_CLIENT_ID`/`_SECRET` on the host. `npm run host -- doctor` checks the rest |
| Terminals fail with `posix_spawnp failed` | node-pty's `spawn-helper` lost its exec bit (npm ships it 644) | Handled by the postinstall, also when installed from npm; the preflight prints the `chmod +x` line |

Host-side logs: `~/.chronos-host/host.out.log` and `host.err.log`. Onboarding and updates add
nothing to them beyond versions, commits, paths and errors — no workspace names; placement policy
stays on the brain, keyed by workspace id.

## Coupling inventory (historical)

The pre-hosts map, from a full read of the daemon on 2026-09-24: everything that assumed "this Mac", and
where it went. All of it is behind the seam now; kept because it says where to look when something
still behaves as if there were one computer. References are symbol names (the original `file:line`s rotted).

| Area | Then (one Mac) | Now (behind `Host`) |
|---|---|---|
| PTY lifecycle | the `live` Map of `IPty` in `terminal.ts`, `openSession`, `typeSeed` (`term-seed.ts`) | `PtyHandle`; remote PTYs in `remote-terminals.ts` + `hostd/terminals.ts` |
| Boot/revive | `sessions.reapAll()` + resume revive (`startTerminals`), the boot run sweep in `store/db.ts` | `local` only; remote → `listLive()` reconcile on the host's hello |
| Headless runs | `runner.ts` spawn + watchdog + stdin steer, `stopRun` (`dispatcher.ts`) | `ProcHandle`; `remote-runs.ts` + `hostd/procs.ts`, the host enforces the watchdog too |
| Paths | `repos.path`, `config_dir`, `default_dir`, `secrets_file`, `sessions.cwd/worktree_path` | `repo_checkouts`, profile registry, `host_id` |
| Worktrees & git | `worktrees.ts`, the ship path in `tickets.ts`, `reviews.ts`, `gates.ts`, `delivery.ts` | `RemoteHost` ship verbs `exec` / `oneshot` / `worktreeEnsure`; `hosts/workdir.ts` picks local or remote |
| Transcripts | `focus.ts`, `session-usage.ts`, `grok-resume.ts`, grok billing log | host streams raw deltas, brain parses (`hosts/transcript-mirror.ts`) |
| Profile prep | `claude-trust.ts`, `grok-trust.ts`, `term-hooks.ts`, `installMcSkill` / `installMcCli` / `syncAgentsMd` (`agent-prep.ts`), `efficiency-tools.ts` | resolved inside a remote spawn from its `SpawnSpec` (`hostd/resolve.ts`), plus host boot |
| Env & secrets | `childEnv` (`child-env.ts`) copies the daemon's `HOME/USER/PATH`, reads `secrets_file` from disk | brain sends values; host supplies the base env (`HOST_OWN_ENV`, `hostd/resolve.ts`) |
| Sandbox | `sandbox.ts` built from `os.homedir()`, `CONFIG.sandbox.secrets` deny list, `isolationDenyDirs` | built on the host from host paths |
| API reach | loopback `server.listen` in `startServer` (`api.ts`), loopback trust in `callerScope` (`authz.ts`), `MC_API=localhost` | host forwarder (`hostd/forwarder.ts`); forwarded = remote (`forwardedHost`) |
| Egress | lock allows only localhost (`sandbox.ts`), proxy on the brain's loopback (`egress.ts`) | proxy on the host (`hostd/egress.ts`) |
| Governor | vitals, admission, heavy slots all brain-only (`machine.ts`) | per-host vitals, admission and pools |
| Drops & attachments | `~/.mc/drops`, `~/chronos/attachments` absolute paths in prompts | forwarded to the host; `mc attach get` |
| Misc | `awake.ts` caffeinate, `mc pdf` sends a path, ticket `file_path` in seeds | host caffeinates itself; upload bytes; `mc ticket show` |

Already remote-shaped then, and the template for this work: `cursor-cloud` sessions (`desk-cloud.ts`,
`cloud-handoff.ts`, `BackendKind "cloud"`) — sessions with no local process, reconciled at boot.

## Build history

All six phases have landed (seam → link and join → remote terminals → placement → headless runs and the ship
pipeline on hosts → onboarding and self-update). What each phase built, and why, is in
[docs/hosts-history.md](docs/hosts-history.md).

## Publishing (operator)

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
