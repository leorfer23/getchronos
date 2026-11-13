# Safety

Unattended agents run with permission prompts skipped — that is what unattended means. Everything on
this page exists to bound what they can reach and what they can spend. Read it before pointing
Chronos at a repo you care about.

## The sandbox (macOS)

Every agent can run inside a kernel-enforced macOS sandbox (Seatbelt), inherited by everything it
starts. Three modes, per project or per job:

- **`guard`** (the default) — the agent reads and writes its own working folder. Denied: `~/.ssh`,
  `~/.aws`, `~/.config/gcloud`, `~/.kube`, browser profiles, Chronos's admin token, database and CA
  keys, and every **other** project's repos and secrets.
- **`strict`** — `guard`, plus writes confined to the working folder and a network lockdown.
- **`off`** — the whole machine. Only on purpose.

On Linux or Windows there is no sandbox: agents run unsandboxed, and the daemon warns for every job
that does.

Agents also cannot edit a repo's main checkout — each one claims its own git worktree.

## Two settings with no safe default

Set these in `.secrets` (copy `.secrets.example`) on day one:

```bash
CHRONOS_PROTECTED_DIRS_EXTRA=/Users/you/code          # where your checkouts live
CHRONOS_PROTECTED_SECRETS_EXTRA=/Users/you/code/api/.env
```

Until the first one is set, an agent in one project can **read another project's files**. The
daemon warns about it at every boot.

## Credentials agents never see

- Each project's secrets live in its own `0600` file. An agent gets a short allowlist of environment
  variables plus its own project's secrets — not the daemon's environment.
- Where it can, the daemon makes the authenticated call for the agent: a local proxy adds the
  credential to the request, so `git push` works without the token entering the sandbox.
- Shared vars (🔑) can expire after N hours; an expired one is deleted.
- **No agent sends anything** — no email, Slack message, comment or review. Send tools are removed
  from every agent CLI; agents leave drafts.
- **Every API call names its caller.** A request to the daemon with no token is refused (only health,
  the push key, webhooks with their own secret and the one-time sign-in code are open). `CHRONOS_TOKENLESS=log`
  lets them through but records each one; `GET /api/authz/tokenless` lists who called.
- **The assistant cannot edit your projects.** Their folders are read-only to him; work goes to an
  agent terminal (see [The assistant](assistant.md)).

## Spend

**Spend is uncapped until you cap it.** Chronos tracks what every run costs (`mc cost`), but the
caps ship off:

| Cap | Where | Default |
|---|---|---|
| Daily budget, all projects | `CHRONOS_DAILY_BUDGET` | 0 = none |
| Daily budget, one project | ⚙ Settings → project → Limits | none |
| Runs at once | `CHRONOS_MAX_CONCURRENT`, or per project | none |
| Per run | the job's budget and timeout | per job |
| **Burn guard** | runs/hour and $/hour | alert at 60 runs or $40, stop at 100 runs or $60 |

- Budgets and the burn guard stop new **headless** runs (jobs, ticket stages). Desk terminals run on
  your CLI subscription and are not stopped by a dollar budget.
- Leave the burn guard alone unless you know why. A runaway can spend a day's budget in four minutes;
  a rate catches it, a total notices too late.

## The machine

- Every agent runs at lower CPU priority than you.
- When the Mac is saturated, terminals that **agents** try to open are refused (you can always open
  one). Full test suites and builds take turns through a few machine-wide slots (`mc heavy`).
- Each project gets a fair share of the Mac. Over its share while the Mac is strained, it is warned;
  ⚙ Settings → *Over-budget ladder* can also slow it, then pause its newest heavy process.

## Nothing retries on its own

A run that goes silent is checked for signs of life first. If there are none, you get one card to
decide. Chronos never retries a failed run by itself.

## Sharp edges, on purpose

- Ticket PRs with green CI **merge on their own** by default (`CHRONOS_AUTO_MERGE`).
- The admin token is one bearer credential in a file. It is never served over HTTP and agents cannot
  read it, but it is not rotated for you.
- **Do not expose the port.** For your phone, use an authenticating tunnel — see [Phone](phone.md).
- Tool allowlists and the prompt-injection filter are advisory, not walls. Treat anything an agent
  reads from a tracker, an issue or the web as untrusted.
- `GET /api/isolation/audit` lists setups the sandbox cannot fix for you (a key in `~/.zshrc`, two
  profiles sharing a skills folder).

---

**Under the hood:** [SECURITY.md](../../SECURITY.md) · [CONFIGURATION.md → The five minutes that
matter](../../CONFIGURATION.md#the-five-minutes-that-matter) · sandbox `src/sandbox.ts` · environment
`src/child-env.ts` · credential proxy `src/egress.ts`, `src/broker.ts` · no-send `src/no-send.ts` ·
budgets `src/dispatcher.ts` · burn guard `src/burn-guard.ts` · machine `src/machine.ts`,
`src/resources/` · stalls `src/monitor.ts`, `src/liveness.ts`.
