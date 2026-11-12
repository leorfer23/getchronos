# Leads

A **Lead** is a terminal that runs its own team for one goal. Say "take acme, ship the new billing
page" and the Lead plans it, opens worker terminals, steers them, reviews their work and reports back
with a receipt.

Think of it as an assistant for one goal in one project. The assistant still runs the Desk; a Lead
runs its slice of it.

## What it can do

- **Open workers** (`mc session new`) and type into them — the one thing an ordinary terminal may
  never do to another.
- **Keep a board:** numbered slices of the plan, each with a status, a worker and a PR. It survives
  the Lead's own context being compacted.
- **Wait for free:** `mc lead wait` blocks until one of its workers stops, and costs nothing meanwhile.
- **Close its own finished workers** and remove their worktrees — only when the work is committed
  and pushed.
- **Merge and deploy** if the goal needs it, within your rules.

## What it cannot do

- See or touch anything outside its project.
- Message anyone outside Chronos — no Slack, email, Telegram or PR comments. It reaches you through its
  card and asks, and the assistant through `mc ask-robert`.
- Open another Lead, kill terminals outright, or force-remove a worktree.

## Who gets woken

- A **worker** stops → its Lead is told (not the assistant).
- A worker asks a question → `mc ask-robert` inside a worker goes to its Lead first; the Lead passes up
  what only the assistant or you can settle.
- The **Lead** stops → the assistant is woken, as for any terminal.

## Open one

- **Desk:** type one goal in the quick bar and press ◆ (*Open as a Lead*). Or right-click a live
  terminal → ◆ *Promote to Lead*; it keeps its conversation.
- **Shell or the assistant:** `mc lead new "ship the new billing page" --workspace <id>`.

Workers land on whichever computer has room (see [More than one Mac](hosts.md)). A Lead has up to 10
open workers by default (`CHRONOS_LEAD_MAX_WORKERS`); a worker whose goal is ticked frees its slot.

`mc lead list` shows live Leads, their workers and what they cost.

---

**Under the hood:** [LEADS.md](../../LEADS.md) · persona `agents/lead/AGENT.md` · wake routing
`src/robert-drive.ts` · board `src/store/lead-slices.ts` · inbox `src/store/lead-events.ts` · powers and
limits `src/authz.ts`, `src/api.ts` (`leadScope`, `leadCloseDone`).
