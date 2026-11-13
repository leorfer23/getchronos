# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/leorfer23/getchronos/security/advisories/new) on this
repository. Please do not open a public issue for anything exploitable.

Include what an attacker gets, and the smallest thing that demonstrates it. A proof of concept is
welcome; a working weapon is not necessary and please do not attach one.

This is a personal project with no SLA. You will get a human reply, not a ticket number.

## What this software actually is

Chronos spawns AI coding agents on your machine with permission prompts disabled and lets them run
unattended. That is the product, not a bug. Everything below is about bounding it.

**It is built for one trusted operator on one machine.** There is no multi-user model: the admin
token is a single credential, not a login, and anyone who holds it can open a shell through the
terminal WebSocket. Do not expose the port to a network you do not control. If you want it on your
phone, put an authenticating tunnel in front of it — the daemon is not the thing that should be
deciding whether a stranger gets in. The one-minute way is Tailscale serve, reachable only from your
own tailnet ([docs/guide/phone.md](./docs/guide/phone.md)); the recipe with a domain (Cloudflare
Tunnel + Access in front of `127.0.0.1:7777`) is in [CONFIGURATION.md §4](./CONFIGURATION.md#4-optional-reach-it-from-your-phone).

## The boundaries that do exist

Each of these is real and each has a way to be wrong. They are worth understanding before you point
this at a repo that matters.

**The sandbox** (`src/sandbox.ts`) wraps every guard/strict job in a Seatbelt profile. It denies a
baseline of credential stores (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, the admin token,
the database, the CA private keys, browser profiles), plus whatever you add. It is macOS-only. On
any other platform `buildProfile` returns null and **jobs run unsandboxed** — the daemon does not
pretend otherwise, but it also does not refuse to start. Chronos's own multi-computer state — the
brain's `hostlink/` dir and a host's `~/.chronos-host` (its token, queued requests carrying workspace
tokens, terminal output) — is sealed: denied after every re-grant, including a workspace's
`sandbox_allow`, because agents run as the same user and file modes do not stop them
([HOSTS.md → Security](./HOSTS.md#security)).

An agent on a client's profile (any Claude config dir other than the default `~/.claude`) is walled
off from the operator's own CLI homes in guard and strict alike: it writes nothing in `~/.claude` — its
`settings.json` hooks, skills, commands and CLAUDE.md run inside every one of the operator's own
sessions, so a write there would be code execution across the workspace boundary — nor in
`~/.claude.json` or `~/.codex`; and of `~/.claude` it reads only the instructions and extensions client
profiles link in (top-level `*.md`, `rules`, `skills`, `commands`, `agents`, `output-styles`,
`workflows`, `hooks`) plus what `CHRONOS_CLAUDE_SHARED_EXTRA` names, never settings, transcripts,
prompt history, file snapshots, plugins or logins. Files behind links in `~/.claude` (a dotfiles
`settings.json`, a skill kept in `~/.agents/skills`) are walled by their real path too, one level
deep. The wall comes after every re-grant — a cwd of `$HOME`, an add-dir, a read-only tier — except a
workspace's `sandbox_allow`: naming a path in it there is the one way to reopen it, read AND write.
The operator's own profile keeps all of it, as does a workspace pinned to it that a usage wall moved to
a sibling login.

**What the sandbox does not decide** is how you set the machine up around it: a profile whose
`skills` dir is a link to another profile's, a client's plugin marketplace installed in a second
profile, a key exported in `~/.zshrc`, one `~/.aws/credentials` for two projects — or the other way
round, a client profile whose hook or MCP server runs a script in `~/.claude` the wall above hides.
`GET /api/isolation/audit` (admin) lists those — names and paths, never values — with what to change
(`src/profile-audit.ts`). It reports; it does not fix.

**The owner gate** (`src/phone-gate.ts`) runs before every page, route and WebSocket. Tailscale serve
proxies to loopback, so a phone's request looks like a local process's — and a tailnet can hold other
people. Anything that arrives through Tailscale gets in only when its identity header is the account
recorded when phone access was turned on; a tagged device (no identity) or Funnel (public) is refused.
Forging the header from this Mac can only lock the forger out: the gate refuses, it never grants.

**Project scoping** is a security boundary, not a UI filter. An endpoint that takes a run or ticket
by id verifies it belongs to the caller's project. A missed check once let one project drain
another's mailbox, which is why `checkScope` exists and why new endpoints are expected to use it.

**Environment isolation** (`src/child-env.ts`) means a spawned agent gets an allowlisted environment
plus its own project's secrets file — not the daemon's environment. A variable you export before
starting the daemon does not silently reach every agent.

**Egress interception** (`src/egress*.ts`) is how an agent uses a credential it cannot read: the
daemon runs a local TLS-intercepting proxy that injects the credential into outbound requests. The
CA's private keys are in the sandbox deny list, and the CA is never installed into the system
keychain — only the daemon's own children are pointed at it. Moving `CHRONOS_EGRESS_CA_DIR` moves
the deny-list entry with it, deliberately, so the keys cannot be relocated out of protection.

**Content guarding** (`src/guard.ts`) redacts prompt-injection patterns in text that arrives from
outside the system — a tracker ticket, an issue body, a memo. It is a mitigation, not a boundary.
Treat anything an agent reads from the outside as untrusted input, because it is.

## Known sharp edges

These are design decisions, not oversights. They are listed because you should make them on purpose:

- **Agents run with `--dangerously-skip-permissions`.** Unattended autonomy requires it.
- **Spend is uncapped until you cap it.** `CHRONOS_DAILY_BUDGET` and `CHRONOS_MAX_CONCURRENT` both
  default to unlimited. The burn guard limits the *rate*, not the total.
- **`CHRONOS_AUTO_MERGE` and `CHRONOS_AUTO_CI_FIX` default to on**, so a project with auto-review
  enabled can land its own PR. See CONFIGURATION.md → Scheduling and autonomy.
- **`CHRONOS_SELF_DEPLOY` defaults to on** and will rebuild and restart the daemon from its own
  default branch.
- **The admin token is a bearer credential in a file.** It is denied to sandboxed agents and never
  served over HTTP, but it is not rotated for you.
