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
deciding whether a stranger gets in.

## The boundaries that do exist

Each of these is real and each has a way to be wrong. They are worth understanding before you point
this at a repo that matters.

**The sandbox** (`src/sandbox.ts`) wraps every guard/strict job in a Seatbelt profile. It denies a
baseline of credential stores (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, the admin token,
the database, the CA private keys, browser profiles), plus whatever you add. It is macOS-only. On
any other platform `buildProfile` returns null and **jobs run unsandboxed** — the daemon does not
pretend otherwise, but it also does not refuse to start.

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
