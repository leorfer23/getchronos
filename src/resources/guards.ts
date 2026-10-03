/**
 * The guards every hand on a process goes through — the reaper's signals (reaper.ts) and the budget
 * ladder's renice / SIGSTOP / SIGCONT (ladder.ts). Extracted from the reaper so the two can never
 * drift: a process one of them may not touch, the other may not touch either.
 *
 *  - `touchable`: never pid ≤ 1, never the spawner (daemon / hostd) itself, never a live root (a
 *    running terminal's own CLI), never another user's process, never an executable under a
 *    protected prefix (Leo's own `/Applications/Google Chrome.app`). Ledger-owned is the caller's
 *    half: both callers only ever consider `ledger.entries`.
 *  - The KEEP-LIST (`isKept`, `keptBelow`): a process whose argv matches it — Claude Code's daemon /
 *    bg-pty-host / bg-spare, colima, gpg-agent… — is never touched, and neither is anything below it.
 *  - `chainRead`: "nothing below a kept process" can only be checked once the argv of the target AND
 *    of every owned ancestor has been read; an unread link in the chain is a veto, never a pass.
 *    `readChains` reads what is missing, batched in one `ps -o command -p`.
 *
 * The start-time re-check right before a signal stays with each caller: it is the last thing either
 * does before kill(2) / setpriority(2), so it lives next to that call.
 */
import type { Entry, ProcLedger } from "./ledger.js";

/** What every hand is told about the machine it acts on. */
export type GuardCtx = {
  selfPid: number;
  uid: number | null;
  liveRootPids: Set<number>;
};

/** argv on the keep-list? */
export const isKept = (argv: string | null | undefined, cfg: { keep: RegExp[] }): boolean =>
  !!argv && cfg.keep.some((r) => r.test(argv));

export function touchable(e: Entry, ctx: GuardCtx, cfg: { protect: string[] }): boolean {
  const p = e.proc;
  if (p.pid <= 1 || p.pid === ctx.selfPid || ctx.liveRootPids.has(p.pid)) return false;
  if (ctx.uid != null && p.uid !== ctx.uid) return false;
  if (cfg.protect.some((pre) => p.comm.startsWith(pre))) return false;
  return true;
}

/** Every kept process and everything below it (from the last snapshot). Only what has been read can be kept. */
export function keptBelow(ledger: ProcLedger): Set<number> {
  const out = new Set<number>();
  for (const e of ledger.entries.values()) {
    if (!e.kept) continue;
    const stack = [e.pid];
    while (stack.length) {
      const p = stack.pop()!;
      if (out.has(p) || !ledger.entries.has(p)) continue;
      out.add(p);
      for (const c of ledger.children.get(p) ?? []) stack.push(c);
    }
  }
  return out;
}

/** The argv of `pid` and of every owned ancestor of it has been read (null = gone before it could be, which counts as read). */
export const chainRead = (ledger: ProcLedger, pid: number): boolean =>
  ledger.entries.get(pid)?.argv !== undefined && ledger.ancestors(pid).every((a) => ledger.entries.get(a)!.argv !== undefined);

export function setArgv(e: Entry, argv: string | null, cfg: { keep: RegExp[] }): void {
  e.argv = argv;
  e.kept = isKept(argv, cfg);
}

/**
 * Read argv (and so the keep-list verdict) for `pids` and every owned ancestor of each, once per
 * process, cached on the entry. false = the read failed: the caller must not touch anything this
 * tick, because an unread ancestor could be a kept one.
 */
export async function readChains(
  ledger: ProcLedger,
  pids: Iterable<number>,
  args: (pids: number[]) => Promise<Map<number, string> | null>,
  cfg: { keep: RegExp[] },
): Promise<{ ok: boolean; unread: number }> {
  const chain = new Set<number>();
  for (const p of pids) {
    chain.add(p);
    for (const a of ledger.ancestors(p)) chain.add(a);
  }
  const unread = [...chain].filter((p) => ledger.entries.get(p)?.argv === undefined);
  if (!unread.length) return { ok: true, unread: 0 };
  const argv = await args(unread).catch(() => null);
  if (!argv) return { ok: false, unread: unread.length };
  for (const p of unread) setArgv(ledger.entries.get(p)!, argv.get(p) ?? null, cfg);
  return { ok: true, unread: unread.length };
}
