/**
 * Keeps the brain's picture of this Mac true between hellos (HOSTS.md → Inventory stays true).
 *
 * hello carries the inventory once per connection, and a link that stays up for a week would keep
 * reporting the profiles, clones and logins of the day it connected. So the host looks again — every
 * `everyMs` (10 min), soon after a `~/.claude-*` directory or a scanned root changes, and when the
 * brain names new GH_CONFIG_DIRs — and pushes an `inventory` frame only when something differs from
 * what the brain last heard. Looking is cheap (a readdir, a few `--version`s, keychain existence
 * checks, `gh auth status`); the frame is rarer still.
 *
 * Only to a brain that speaks 1.5 (its welcome says so): an older brain would not know the frame.
 */
import fs from "node:fs";
import type { GhAuthInfo, Hello, HostToBrain, Inventory } from "../hostlink/wire.js";

export type GhDirs = Array<{ dir: string; workspaces: string[] }>;
type InventoryFrame = Extract<HostToBrain, { t: "inventory" }>;

export type InventoryPusherOptions = {
  collect: (ghDirs: GhDirs | null) => Promise<Inventory>;
  send: (f: InventoryFrame) => boolean;
  /** How often to look regardless of events. */
  everyMs?: number;
  /** Quiet time after a watched change before looking (a login or a clone writes in bursts). */
  debounceMs?: number;
  /** After a profile directory appears, look again this much later: the login finishes after the mkdir. */
  recheckMs?: number;
  /** Directories to watch (non-recursive): $HOME for `.claude-*`, and the checkout roots. null = timer only. */
  watch?: { home: string; roots: string[] } | null;
  log?: (s: string) => void;
};

export const INVENTORY_EVERY_MS = 10 * 60_000;

/** Does a welcome's protocol version understand the `inventory` frame (1.5+)? */
export function speaksInventory(proto: unknown): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(String(proto ?? ""));
  return !!m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 5));
}

/** Order-independent identity of an inventory: what "changed" compares. */
export function inventoryKey(inv: Partial<Inventory>): string {
  const by = <T>(xs: T[] | undefined, k: (x: T) => string) => [...(xs ?? [])].sort((a, b) => k(a).localeCompare(k(b)));
  return JSON.stringify({
    clis: by(inv.clis, (c) => c.name).map((c) => [c.name, c.path, c.version, c.auth ?? null]),
    profiles: by(inv.profiles, (p) => p.name).map((p) => [p.name, p.dir, p.exists, p.auth ?? null]),
    checkouts: by(inv.checkouts, (c) => c.path).map((c) => [c.path, c.remote_url]),
    gh: by(inv.gh, (g) => g.dir).map((g) => [g.dir, g.auth, g.account ?? null, [...g.workspaces].sort()]),
  });
}

export class InventoryPusher {
  private last: string | null = null;
  /** The gh report the brain last received — hello carries none, so the baseline borrows it. */
  private sentGh: GhAuthInfo[] | undefined;
  private ghDirs: GhDirs | null = null;
  private ghKey: string | null = null;
  private enabled = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private recheck: NodeJS.Timeout | null = null;
  private watchers: fs.FSWatcher[] = [];
  private inflight: Promise<Inventory | null> | null = null;
  private again: string | null = null;

  constructor(private readonly o: InventoryPusherOptions) {}

  /** The GH_CONFIG_DIRs the brain's last policy named (null before one). */
  get gh(): GhDirs | null { return this.ghDirs; }

  /** hello just carried an inventory: that is what the brain knows now. gh rides only in pushes. */
  baseline(h: Pick<Hello, "capabilities" | "profiles" | "checkouts">): void {
    this.last = inventoryKey({ clis: h.capabilities?.clis, profiles: h.profiles, checkouts: h.checkouts, gh: this.sentGh });
  }

  /** The link came up: push only if the brain understands it. */
  online(brainProto: unknown): void {
    this.enabled = speaksInventory(brainProto);
  }

  offline(): void {
    this.enabled = false;
  }

  /** The brain's policy named the GH_CONFIG_DIRs its workspaces use here. New ones are probed now. */
  setGhDirs(dirs: unknown): void {
    const list: GhDirs = Array.isArray(dirs)
      ? dirs.filter((d): d is { dir: string; workspaces: string[] } => !!d && typeof d.dir === "string").map((d) => ({ dir: d.dir, workspaces: Array.isArray(d.workspaces) ? d.workspaces.filter((w) => typeof w === "string") : [] }))
      : [];
    const key = JSON.stringify(list);
    this.ghDirs = list;
    // The first policy this process sees always differs (null): gh is first reported then, even with
    // no dirs named — the default login is always probed. A reconnect with the same dirs costs nothing.
    if (key === this.ghKey) return;
    this.ghKey = key;
    void this.push("gh dirs");
  }

  /**
   * Look now; send when it differs from what the brain has (or `force`). Overlapping calls coalesce:
   * one look at a time, and one more after it if something asked meanwhile.
   */
  async push(reason: string, force = false): Promise<Inventory | null> {
    if (this.inflight) { this.again = this.again ?? reason; return this.inflight; }
    this.inflight = (async () => {
      try {
        const inv = await this.o.collect(this.ghDirs);
        const key = inventoryKey(inv);
        if (this.enabled && (force || key !== this.last) && this.o.send({ t: "inventory", reason, ...inv })) {
          this.last = key;
          this.sentGh = inv.gh;
        }
        return inv;
      } catch (e: any) {
        this.o.log?.(`[host] inventory (${reason}) failed: ${e?.message ?? e}`);
        return null;
      } finally {
        this.inflight = null;
        const next = this.again;
        this.again = null;
        if (next) void this.push(next);
      }
    })();
    return this.inflight;
  }

  /**
   * For the `inventory` rpc (Desk → Refresh): a fresh look returned to the caller, which applies it.
   * Recorded as what the brain now knows, so the next timer tick does not send it again.
   */
  async snapshot(): Promise<Inventory> {
    const inv = await this.o.collect(this.ghDirs);
    this.sentGh = inv.gh;
    this.last = inventoryKey(inv);
    return inv;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.push("periodic"), this.o.everyMs ?? INVENTORY_EVERY_MS);
    this.timer.unref?.();
    const w = this.o.watch;
    if (!w) return;
    const soon = (reason: string, recheck: boolean) => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.push(reason), this.o.debounceMs ?? 2000);
      this.debounce.unref?.();
      if (recheck) {
        if (this.recheck) clearTimeout(this.recheck);
        this.recheck = setTimeout(() => void this.push(`${reason} (recheck)`), this.o.recheckMs ?? 2 * 60_000);
        this.recheck.unref?.();
      }
    };
    const watch = (dir: string, onName: (name: string) => void) => {
      try {
        const fw = fs.watch(dir, { persistent: false }, (_ev, name) => onName(String(name ?? "")));
        fw.on("error", () => { try { fw.close(); } catch {} });
        this.watchers.push(fw);
      } catch {
        // A root that does not exist (yet), or a platform without fs.watch: the timer still covers it.
      }
    };
    watch(w.home, (name) => { if (name.startsWith(".claude")) soon("profiles", true); });
    for (const r of w.roots) watch(r, (name) => { if (name && !name.startsWith(".")) soon("checkouts", false); });
  }

  stop(): void {
    for (const t of [this.timer, this.debounce, this.recheck]) if (t) clearTimeout(t);
    this.timer = this.debounce = this.recheck = null;
    for (const fw of this.watchers) { try { fw.close(); } catch {} }
    this.watchers = [];
  }
}
