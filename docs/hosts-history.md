# Hosts — build history

> Moved out of [HOSTS.md](../HOSTS.md), where it was the *Phases* section: the plan each implementation PR
> followed and what it landed. Every phase below has shipped. HOSTS.md describes the system as it is;
> this file is why it is that way. `file:line` references here are as of each phase and may have moved.

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
   - **Deviations from the sketch in HOSTS.md (*The seam*).** `spawnPty`/`spawnProcess` take a fully built command
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
     dir is a brain path, so a repo-less remote terminal (`cwd_hint: "landing"`) lands in a landing
     dir the host builds from its own checkouts of the workspace's repos — `~/.chronos-landing/<slug>`,
     one symlink per checkout, only symlinks ever added or pruned (`src/hostd/landing.ts`) — in the one
     checkout when there is only one, else its home. A CLI transcript that never appears is logged
     once on the host (the brain's mirror stays empty, so a failover would brief instead of resume). The spawn frame carries `resume_cwd` only for a directory the host itself
     reported for that row (or the terminal it stands in for).
4. **Placement and governor.** `place()` with policy, veto, capabilities and headroom; per-host
   admission and heavy slots; brain reserve; drain; refusal reasons across hosts.
   - **Landed:**
     - **`place()`** (`src/hosts/placement.ts`, pure, unit-tested like `admission()`): eligibility
       (online; not `disabled`, nor `draining` for fresh work; workspace not denied by brain policy
       nor by the host's reported veto — a pin or sticky row refused for policy is a 403 and a
       `host.policy_violation`; not a cloud backend; not egress-locked; macOS with sandbox-exec when
       sandboxed; the backend's CLI on the host's PATH; the workspace's profile NAME reported, and
       its dir there (`exists`) for claude-code — and, since protocol 1.5, not reported logged out
       (`auth: "no"`; see HOSTS.md → *Inventory stays true*); the repo in `repo_checkouts` for that host, or the host
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
       `welcome` carries the host's Desk name (additive, no protocol bump). See HOSTS.md → *Menu bar*.
       Deviation: the LaunchAgent is `KeepAlive {SuccessfulExit: false}` rather than `KeepAlive true`,
       so **Quit** is not undone by launchd a second later.
     - **Brain menu bar**: the same item on the brain, `--brain`, for the whole fleet
       (`GET /api/hosts/bar`, `src/hostlink/bar.ts`; `scripts/build-brainbar.sh` /
       `scripts/brainbar.mjs`, LaunchAgent `sh.chronos.brainbar`; `npm run deploy` refreshes it only
       when installed). No `mc menubar` subcommand: `mc` is the agents' CLI and runs sandboxed,
       while installing a LaunchAgent is the operator's call. See *Menu bar → On the brain*.
   - **Deferred:** publishing (see HOSTS.md → *Publishing*); a Desk "roll back" (`app.prev` is kept, the
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
