# Project instructions — Example Project

Standing brief for every agent that works this project. Keep it short enough that an
agent reads all of it. Delete any section that does not apply.

## Mission — what "adding value" means here

One paragraph. Not the company's mission: *this project's*. An agent with a free hour
should be able to read this and pick the right thing to do.

> Example: this is the reporting pipeline behind the customer-facing dashboard. Value
> here means correct numbers delivered on time; a late-but-right refresh beats an
> early-but-wrong one every time.

## Repos

| Repo | Path | What it is |
|---|---|---|
| `example-api` | `~/code/example-api` | the service |
| `example-dbt` | `~/code/example-dbt` | warehouse models |

## Git & delivery

- Branch → PR → merge. Never commit to `main` directly.
- One PR per ticket; the ticket id goes in the title.
- Tests green before you open the PR, not after.

## Conventions

- Match the surrounding idiom. No new dependencies without asking.
- Loud errors over silent failure.

## Data access

Where the credentials live and what they reach. Name the tool, not the secret:

- `psql` → read replica only. No writes from an agent, ever.
- Production console → human hands only.

## Escalation

Blocked twice on the same thing, or facing a decision that is the operator's to make →
post to the board (`mc ask`) rather than guessing.
