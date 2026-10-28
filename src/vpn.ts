/**
 * `mc vpn` — an agent that needs its workspace's VPN asks the daemon for it, and the daemon turns it
 * on, holds it while anyone needs it, and turns it back off after (RESOURCES.md → VPN on demand).
 *
 * Why the daemon and not the agent: a VPN is machine-wide. An agent running `tailscale down` or
 * scripting Tunnelblick itself cuts every other workspace's (and the operator's) traffic, can flip a
 * VPN that belongs to another client, and leaves it on when it crashes. Here:
 *  - a workspace may only touch the ONE VPN its `vpn_config` names (set by the operator, admin-gated);
 *  - a hold belongs to a live terminal or run of that workspace, and ends with it (`session.ended` /
 *    `run.ended`, plus a sweep for anything the bus missed);
 *  - the daemon turns off only a VPN it turned on itself, and only after the last hold ends plus a
 *    short grace (back-to-back jobs don't flap it). One the operator turned on by hand stays on.
 *
 * Holds are keyed by the VPN, not the workspace: two workspaces that name the same VPN share it.
 * They persist in kv, so a daemon restart (every deploy) neither forgets that it owes a VPN a
 * turn-off nor drops the holds of terminals that come back.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { bus } from "./bus.js";
import { kv, runs, sessions, workspaces } from "./store.js";
import type { Workspace } from "./types.js";

export type VpnConfig = { kind: "tailscale" } | { kind: "tunnelblick"; name: string };
export type VpnState = "up" | "down" | "connecting" | "needs-login";

/** What the operator stores on a workspace; null when the column is empty or not one of ours. */
export function parseVpnConfig(raw: string | null | undefined): VpnConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.kind === "tailscale") return { kind: "tailscale" };
    if (v?.kind === "tunnelblick" && typeof v.name === "string" && v.name.trim()) return { kind: "tunnelblick", name: v.name.trim() };
  } catch {}
  return null;
}

export const vpnKey = (c: VpnConfig): string => (c.kind === "tailscale" ? "tailscale" : `tunnelblick:${c.name}`);
export const vpnLabel = (c: VpnConfig): string => (c.kind === "tailscale" ? "Tailscale" : `Tunnelblick "${c.name}"`);
function configFromKey(key: string): VpnConfig | null {
  if (key === "tailscale") return { kind: "tailscale" };
  if (key.startsWith("tunnelblick:") && key.length > "tunnelblick:".length) return { kind: "tunnelblick", name: key.slice("tunnelblick:".length) };
  return null;
}

/** A refusal or failure the caller is told verbatim (the route answers it as a 4xx/5xx with this text). */
export class VpnError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

// ───────────────────────────── drivers ─────────────────────────────

export type Exec = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code !== 0 && !stderr ? String(err.message) : "") });
    });
  });

export interface VpnDriver {
  state(): Promise<VpnState>;
  /** Resolves once it is up; throws VpnError when it cannot get there. */
  up(): Promise<void>;
  down(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(d: VpnDriver, want: VpnState, timeoutMs: number, pollMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await d.state()) === want) return true;
    if (Date.now() >= until) return false;
    await sleep(pollMs);
  }
}

// launchd hands the daemon a minimal PATH, so look where the CLI actually lives.
const TAILSCALE_BINS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
function tailscaleBin(): string {
  const pinned = process.env.CHRONOS_TAILSCALE_BIN;
  if (pinned) return pinned;
  return TAILSCALE_BINS.find((p) => fs.existsSync(p)) ?? "tailscale";
}

/**
 * Tailscale through its CLI. A bare `tailscale up` (no flags) only flips WantRunning back on and
 * keeps every setting made in the app; any flag would make the CLI demand all non-default settings
 * be restated, so none is passed — the wait is bounded by the exec timeout instead of --timeout.
 */
export function tailscaleDriver(exec: Exec = realExec, pollMs = 1000): VpnDriver {
  const d: VpnDriver = {
    async state() {
      const r = await exec(tailscaleBin(), ["status", "--json"], 10_000);
      let backend = "";
      try { backend = String(JSON.parse(r.stdout)?.BackendState ?? ""); } catch {}
      if (!backend) throw new VpnError(`tailscale status failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
      if (backend === "Running") return "up";
      if (backend === "Stopped") return "down";
      if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") return "needs-login";
      return "connecting";
    },
    async up() {
      const r = await exec(tailscaleBin(), ["up"], 45_000);
      if (r.code !== 0) throw new VpnError(`tailscale up failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
      if (!(await waitFor(d, "up", 15_000, pollMs))) throw new VpnError("tailscale up returned but Tailscale is not Running yet — check `tailscale status`");
    },
    async down() {
      const r = await exec(tailscaleBin(), ["down"], 20_000);
      if (r.code !== 0) throw new VpnError(`tailscale down failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
    },
  };
  return d;
}

/**
 * Tunnelblick through its AppleScript dictionary (connect / disconnect / state of a configuration).
 * The configuration name always travels as an argv item, never inside the script text, so no name
 * can change what the script does. Asking for the state first checks the app is running without
 * launching it: a stopped Tunnelblick is a VPN that is down.
 */
export function tunnelblickDriver(name: string, exec: Exec = realExec, pollMs = 1000, connectWaitMs = 60_000): VpnDriver {
  const osa = async (lines: string[], args: string[] = []) => {
    const r = await exec("/usr/bin/osascript", [...lines.flatMap((l) => ["-e", l]), ...args], 20_000);
    if (r.code !== 0) {
      const err = (r.stderr || r.stdout).trim();
      // errAEEventNotPermitted: the daemon was never allowed to drive Tunnelblick (System Settings →
      // Privacy & Security → Automation). Said plainly, since the raw text names neither.
      if (/-1743\b/.test(err)) throw new VpnError("macOS has not allowed Chronos to control Tunnelblick — allow it under System Settings → Privacy & Security → Automation", 409);
      if (/-1728\b/.test(err)) throw new VpnError(`Tunnelblick has no configuration named "${name}"`, 409);
      throw new VpnError(`Tunnelblick: ${err.slice(0, 300) || `osascript exit ${r.code}`}`);
    }
    return r.stdout.trim();
  };
  const perConfig = (verb: string) => ["on run argv", `tell application "Tunnelblick" to ${verb} (item 1 of argv)`, "end run"];
  const d: VpnDriver = {
    async state() {
      if ((await osa(['application "Tunnelblick" is running'])) !== "true") return "down";
      const s = await osa(["on run argv", 'tell application "Tunnelblick" to get state of first configuration whose name is (item 1 of argv)', "end run"], [name]);
      if (s === "CONNECTED") return "up";
      if (s === "EXITING") return "down";
      return "connecting";
    },
    async up() {
      await osa(perConfig("connect"), [name]);
      if (!(await waitFor(d, "up", connectWaitMs, pollMs)))
        throw new VpnError(`Tunnelblick did not connect "${name}" within ${Math.round(connectWaitMs / 1000)}s — if it asks for a password or a code, it cannot connect unattended`, 504);
    },
    async down() {
      // Any `tell` launches the app, so never send one to a Tunnelblick that is not running.
      if ((await d.state()) === "down") return;
      await osa(perConfig("disconnect"), [name]);
      await waitFor(d, "down", 20_000, pollMs);
    },
  };
  return d;
}

export function driverFor(c: VpnConfig): VpnDriver {
  return c.kind === "tailscale" ? tailscaleDriver() : tunnelblickDriver(c.name);
}

// ───────────────────────────── holds ─────────────────────────────

export type VpnHolder = { kind: "session" | "run"; id: string; workspace_id: string | null; label: string; since: string };

type Entry = {
  key: string;
  config: VpnConfig;
  holders: Map<string, VpnHolder>;
  /** True while the VPN is on because THIS daemon turned it on — the only case it turns it off. */
  owned: boolean;
  downAt: number | null;
  timer: NodeJS.Timeout | null;
  lock: Promise<unknown>;
};

export type VpnDeps = {
  driver: (c: VpnConfig) => VpnDriver;
  /** Is the terminal / run behind a hold still alive? A dead one's hold is dropped. */
  isLive: (h: Pick<VpnHolder, "kind" | "id">) => boolean;
  load: () => string | undefined;
  save: (json: string) => void;
  graceMs: number;
  log: (line: string) => void;
};

export type VpnView = {
  vpn: string;
  state: VpnState | "unknown";
  error?: string;
  turned_on_by_chronos: boolean;
  turns_off_at: string | null;
  holders: VpnHolder[];
  other_holders: number;
};

export class VpnLeases {
  private entries = new Map<string, Entry>();
  constructor(private deps: VpnDeps) {
    this.restore();
  }

  private entry(c: VpnConfig): Entry {
    const key = vpnKey(c);
    let e = this.entries.get(key);
    if (!e) {
      e = { key, config: c, holders: new Map(), owned: false, downAt: null, timer: null, lock: Promise.resolve() };
      this.entries.set(key, e);
    }
    return e;
  }

  /** One operation per VPN at a time: two holders asking at once must not run `up` twice, or race a `down`. */
  private locked<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const next = e.lock.then(fn, fn);
    e.lock = next.catch(() => {});
    return next;
  }

  private cancelDown(e: Entry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.downAt = null;
  }

  /** The last hold is gone and the daemon owes this VPN a turn-off: do it after the grace. */
  private scheduleDown(e: Entry): void {
    if (!e.owned || e.holders.size || e.timer) return;
    e.downAt = Date.now() + this.deps.graceMs;
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.locked(e, async () => {
        e.downAt = null;
        if (!e.owned || e.holders.size) return;
        try {
          await this.deps.driver(e.config).down();
          e.owned = false;
          this.deps.log(`[vpn] ${vpnLabel(e.config)} off — the last hold ended`);
        } catch (err: any) {
          // Still owed: the next sweep tries again rather than leaving it on for good.
          this.deps.log(`[vpn] turning ${vpnLabel(e.config)} off failed: ${err?.message ?? err}`);
        }
        this.persist();
      });
    }, this.deps.graceMs);
    e.timer.unref?.();
  }

  /**
   * Hold the VPN for this terminal/run, turning it on if it is off. Resolves once it is up. A hold
   * that is already there is refreshed, not doubled.
   */
  acquire(c: VpnConfig, h: VpnHolder): Promise<VpnView & { turned_on: boolean }> {
    const e = this.entry(c);
    return this.locked(e, async () => {
      this.cancelDown(e);
      const d = this.deps.driver(c);
      const before = await d.state();
      if (before === "needs-login") throw new VpnError(`${vpnLabel(c)} needs the operator to sign in first`, 409);
      e.holders.set(h.id, e.holders.get(h.id) ?? h);
      if (before === "up") {
        this.persist();
        return { ...this.view(e, "up", h.workspace_id), turned_on: false };
      }
      try {
        await d.up();
      } catch (err) {
        // It was off and we started it: put it back rather than leave a half-open tunnel nobody holds.
        // Not when it was already connecting — that is someone else's attempt (the operator typing a
        // password), and cancelling it is not ours to do.
        e.holders.delete(h.id);
        if (before === "down" && !e.holders.size && !e.owned) await d.down().catch(() => {});
        this.persist();
        throw err;
      }
      e.owned = true;
      this.deps.log(`[vpn] ${vpnLabel(c)} on for ${h.kind} ${h.id.slice(0, 8)} (${h.label})`);
      this.persist();
      return { ...this.view(e, "up", h.workspace_id), turned_on: true };
    });
  }

  /** Drop one hold (an explicit `mc vpn down`, or its terminal/run ended). True when it was held. */
  release(holderId: string): boolean {
    let hit = false;
    for (const e of this.entries.values()) {
      if (!e.holders.delete(holderId)) continue;
      hit = true;
      this.scheduleDown(e);
    }
    if (hit) this.persist();
    return hit;
  }

  /** The operator's hand: off now, every hold dropped. */
  forceDown(c: VpnConfig): Promise<VpnView> {
    const e = this.entry(c);
    return this.locked(e, async () => {
      this.cancelDown(e);
      e.holders.clear();
      await this.deps.driver(c).down();
      e.owned = false;
      this.persist();
      this.deps.log(`[vpn] ${vpnLabel(c)} off — the operator turned it off`);
      return this.view(e, "down");
    });
  }

  /** The operator's hand: on, with no hold — the daemon never turns this one off. */
  operatorUp(c: VpnConfig): Promise<VpnView> {
    const e = this.entry(c);
    return this.locked(e, async () => {
      this.cancelDown(e);
      const d = this.deps.driver(c);
      const before = await d.state();
      if (before === "needs-login") throw new VpnError(`${vpnLabel(c)} needs the operator to sign in first`, 409);
      if (before !== "up") await d.up();
      e.owned = false;
      this.persist();
      return this.view(e, "up");
    });
  }

  /** Drop holds whose terminal/run is gone (a missed `*.ended`, or one that ended while the daemon was down). */
  sweep(): void {
    let changed = false;
    for (const e of this.entries.values()) {
      for (const [id, h] of e.holders) {
        if (this.deps.isLive(h)) continue;
        e.holders.delete(id);
        changed = true;
      }
      this.scheduleDown(e);
    }
    if (changed) this.persist();
  }

  async status(c: VpnConfig, workspaceId: string | null): Promise<VpnView> {
    const e = this.entry(c);
    try {
      return this.view(e, await this.deps.driver(c).state(), workspaceId);
    } catch (err: any) {
      return { ...this.view(e, "unknown", workspaceId), error: String(err?.message ?? err) };
    }
  }

  /**
   * A workspace sees only its own holds; another workspace sharing the VPN shows up as a count,
   * never its ids. `workspaceId` null = the operator, who sees every hold.
   */
  private view(e: Entry, state: VpnView["state"], workspaceId: string | null = null): VpnView {
    const all = [...e.holders.values()];
    const mine = workspaceId ? all.filter((h) => h.workspace_id === workspaceId) : all;
    return {
      vpn: vpnLabel(e.config),
      state,
      turned_on_by_chronos: e.owned,
      turns_off_at: e.downAt ? new Date(e.downAt).toISOString() : null,
      holders: mine,
      other_holders: all.length - mine.length,
    };
  }

  private persist(): void {
    const out: Record<string, { owned: boolean; holders: VpnHolder[] }> = {};
    for (const e of this.entries.values()) if (e.owned || e.holders.size) out[e.key] = { owned: e.owned, holders: [...e.holders.values()] };
    try { this.deps.save(JSON.stringify(out)); } catch (err: any) { this.deps.log(`[vpn] could not save holds: ${err?.message ?? err}`); }
  }

  private restore(): void {
    let saved: Record<string, { owned?: boolean; holders?: VpnHolder[] }> = {};
    try { saved = JSON.parse(this.deps.load() || "{}") ?? {}; } catch {}
    for (const [key, s] of Object.entries(saved)) {
      const c = configFromKey(key);
      if (!c) continue;
      const e = this.entry(c);
      e.owned = !!s.owned;
      for (const h of s.holders ?? []) if (h?.id && (h.kind === "session" || h.kind === "run")) e.holders.set(h.id, h);
    }
  }

  reset(): void {
    for (const e of this.entries.values()) this.cancelDown(e);
    this.entries.clear();
  }
}

// ───────────────────────────── the daemon's instance ─────────────────────────────

const KV_KEY = "vpn.holds";
const GRACE_MS = 60_000;

export function holderLive(h: Pick<VpnHolder, "kind" | "id">): boolean {
  if (h.kind === "session") return sessions.get(h.id)?.status === "live";
  return runs.get(h.id)?.status === "running";
}

let leases: VpnLeases | null = null;
export function vpnLeases(): VpnLeases {
  leases ??= new VpnLeases({
    driver: driverFor,
    isLive: holderLive,
    load: () => kv.get(KV_KEY),
    save: (json) => kv.set(KV_KEY, json),
    graceMs: GRACE_MS,
    log: (line) => console.log(line),
  });
  return leases;
}
export function setVpnLeasesForTest(l: VpnLeases | null): void {
  leases?.reset();
  leases = l;
}

let wired = false;
/** Boot hook (index.ts): holds end with their terminal/run, and a sweep catches what the bus missed. */
export function startVpn(): void {
  if (wired) return;
  wired = true;
  const l = vpnLeases();
  bus.on("event", (e: any) => {
    if (e?.topic === "session.ended" && e.session_id) l.release(e.session_id);
    if (e?.topic === "run.ended" && e.run_id) l.release(e.run_id);
  });
  // First sweep after boot settles holds whose terminal did not come back; then once a minute.
  setTimeout(() => l.sweep(), 30_000).unref?.();
  setInterval(() => l.sweep(), 60_000).unref?.();
}

/** The one line an agent of a VPN workspace is told (agentContext): it exists, it is off, how to get it. */
export function vpnPromptLine(ws: Pick<Workspace, "vpn_config"> | undefined): string {
  const c = parseVpnConfig(ws?.vpn_config);
  if (!c) return "";
  return `## Network\nThis workspace's private hosts are behind ${vpnLabel(c)}, which may be off. When a connection to one fails or you know you need it, run \`mc vpn up\` (waits until it is on); \`mc vpn down\` when done. The daemon turns it off after your terminal or run ends — never run tailscale/Tunnelblick yourself.`;
}

/** The config of the workspace a caller acts for; throws the refusal when there is none. */
export function workspaceVpn(wsId: string): { ws: Workspace; config: VpnConfig } {
  const ws = workspaces.get(wsId) ?? workspaces.getBySlug(wsId);
  if (!ws) throw new VpnError("workspace not found", 404);
  const config = parseVpnConfig(ws.vpn_config);
  if (!config) throw new VpnError(`workspace "${ws.slug}" has no VPN set (the operator sets vpn_config on it)`, 404);
  return { ws, config };
}
