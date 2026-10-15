/**
 * What changed between two inventories of one host, in words (protocol 1.5, HOSTS.md → Inventory stays
 * true). Pure. The lines go out on the bus as `host.inventory` — the Desk repaints on it, and anything
 * that wakes on "a computer can now do X" reads them — so they name things, never paths' contents or
 * secrets: a profile, a CLI, a repo directory's basename, a gh dir.
 */
import path from "node:path";
import type { Inventory } from "./wire.js";

type Inv = Partial<Inventory> | null | undefined;

export function inventoryDiff(before: Inv, after: Inv): string[] {
  const out: string[] = [];
  const authWord = (a: string | undefined) => (a === "yes" ? "logged in" : a === "no" ? "not logged in" : "login unknown");

  const pb = new Map((before?.profiles ?? []).map((p) => [p.name, p]));
  const pa = new Map((after?.profiles ?? []).map((p) => [p.name, p]));
  for (const [n, p] of pa) {
    const was = pb.get(n);
    if (!was) out.push(`profile ${n} appeared${p.auth ? ` (${authWord(p.auth)})` : ""}`);
    else if (!!was.exists !== !!p.exists) out.push(`profile ${n} ${p.exists ? "appeared" : "is gone"}`);
    else if ((was.auth ?? null) !== (p.auth ?? null) && p.auth) out.push(`profile ${n} ${authWord(p.auth)}`);
  }
  for (const n of pb.keys()) if (!pa.has(n)) out.push(`profile ${n} is gone`);

  const cb = new Map((before?.clis ?? []).map((c) => [c.name, c]));
  for (const c of after?.clis ?? []) {
    const was = cb.get(c.name);
    if (!!was?.path !== !!c.path) out.push(`${c.name} ${c.path ? "installed" : "uninstalled"}`);
    else if (c.path && (was?.auth ?? null) !== (c.auth ?? null) && c.auth) out.push(`${c.name} ${authWord(c.auth)}`);
    else if (c.path && was?.version && c.version && was.version !== c.version) out.push(`${c.name} updated`);
  }

  const kb = new Set((before?.checkouts ?? []).map((c) => c.path));
  const ka = new Set((after?.checkouts ?? []).map((c) => c.path));
  const added = [...ka].filter((p) => !kb.has(p)).map((p) => path.basename(p));
  const removed = [...kb].filter((p) => !ka.has(p)).map((p) => path.basename(p));
  if (added.length) out.push(`checked out ${added.sort().join(", ")}`);
  if (removed.length) out.push(`no longer has ${removed.sort().join(", ")}`);

  // gh only compares when both sides reported it: its first report is not a change.
  if (before?.gh && after?.gh) {
    const gb = new Map(before.gh.map((g) => [g.dir, g]));
    for (const g of after.gh) {
      const was = gb.get(g.dir);
      if (was && was.auth !== g.auth) out.push(`gh ${g.dir} ${authWord(g.auth)}`);
    }
  }
  return out;
}
