# More than one Mac

One Mac is the whole fleet's ceiling. If you have a second computer doing nothing, Chronos can run
agents on it too — still from one Desk.

- **The brain** is the Mac running the daemon, the database and the Desk. It is also a host itself.
- **A host** is any other Mac that runs terminals and headless runs for it. It runs a small process,
  `chronos host`, that keeps **one outbound connection** to the brain. Nothing connects *to* a host:
  no SSH, no Remote Login, no open port — so a company-managed Mac stays compliant.

## Add one

1. Desk → ⋯ → 🖥 **Computers** → **+ Add** → name it → **Get the command**.
2. Paste that one line in Terminal on the other Mac. The code in it works once, for 15 minutes.

Before you do, the other Mac needs Node 22–26, the Xcode command-line tools, and — only for the
projects allowed to run there — the agent CLI logged in and `gh auth login`. The brain needs a way to
be reached (same network, or a tunnel); see [HOSTS.md → Setup](../../HOSTS.md#setup-what-the-operator-does).

## Then forget about it

- **+ Terminal goes wherever there is room.** A chip on each card says which computer it is on. Pin one
  by hand when it matters.
- **Each host has a veto list.** The brain decides which projects may run where, and the host can
  refuse a project on its own — an employer's laptop never runs another client's work.
- **A host is gone** (not just a closed lid — offline past a grace period) → its terminals reopen on
  another computer, with the conversation where it can be carried over.
- **Updates** are a button on the Computers page.

```bash
mc hosts                 # every computer: status, load, live terminals
mc hosts show <name>     # one in full
mc hosts drain <name>    # no new work there
```

---

**Under the hood:** [HOSTS.md](../../HOSTS.md) · the seam `src/hosts/` · link and join `src/hostlink/` ·
the host process `src/hostd/` · placement `src/hosts/placement.ts` · failover `src/host-failover.ts`.
