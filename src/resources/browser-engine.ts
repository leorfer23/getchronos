/**
 * The machine's one shared headless browser (RESOURCES.md → Shared headless browser pool): which
 * engine is installed, the process itself, and the ONE door agents reach it through.
 *
 * 2026-10-02: every test run launching its own Chrome left 188 headless Chrome processes (2-4 GB)
 * behind and pushed the brain to load 30 with full swap. This is the alternative: ONE browser per
 * machine, started on demand, stopped when idle, the daemon's own child (so the ledger never
 * attributes it to a terminal and the reaper never touches it — ledger.ts adopts only below
 * `localHost.listLive()` roots, and the spawner's process group is never a target).
 *
 * Workspaces share this browser but are CLIENT boundaries (different employers; ~/.claude/BROWSER.md:
 * separate cookie jars are the client boundary). So:
 *
 *  - **No debugging port.** Chrome runs with `--remote-debugging-pipe`: CDP is fds 3/4 of the
 *    daemon's own child, nothing listens, nothing can be found on the loopback or in the profile.
 *  - **One door: the lease proxy.** `ws://127.0.0.1:<proxy>/devtools/browser/<secret>`, a 256-bit
 *    secret per lease compared in constant time. Each client connection gets its own browser
 *    session (`Target.attachToBrowserTarget`), so its discovery / auto-attach state is its own, and
 *    every message is checked against the lease (`policy`): it sees and touches only targets in its
 *    own browser contexts, flat sessions pass only when the proxy saw them attached to such a
 *    target, and the browser-wide domains are allow-listed per method.
 *  - **No reach into the daemon's disk.** The browser runs unsandboxed as the daemon's user, so
 *    `file:` URLs, file uploads by path, downloads and `Network.loadNetworkResource` are refused —
 *    an agent's sandbox must not gain a file reader by borrowing the browser.
 *
 * The bookkeeping (who holds what, caps, fairness, heartbeats) is browser-pool.ts. Seam: `Launcher`
 * (spawn + the CDP pipe) — the tests hand back a fake Chrome speaking over an in-process transport.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

// ───────────────────────────── config ─────────────────────────────

export type BrowserConfig = {
  /** CHRONOS_BROWSER=off disables `mc browser` entirely (no lease is ever granted). */
  enabled: boolean;
  /** CHRONOS_BROWSER_PATH: an explicit executable. Refused under a protected prefix. */
  path: string | null;
  /** Stop the browser this long after its last lease ended. */
  idleMs: number;
  /** Concurrent leases on this machine. */
  maxContexts: number;
  /** A workspace's fair share: past it, it is granted only while no other workspace waits. */
  maxPerWorkspace: number;
  /** CHRONOS_BROWSER_AUTO_INSTALL=1: with no engine found, `npx @puppeteer/browsers install` it once. */
  autoInstall: boolean;
};

/** Never launched, whatever a knob says: the operator's own browser and profile (~/.claude/BROWSER.md). */
export const FORBIDDEN_PREFIXES = ["/Applications/Google Chrome.app/", path.join(os.homedir(), "Library/Application Support/Google/Chrome")];

/** The one-line install the docs, the refusal and the auto-install all use. */
export const INSTALL_HINT = "npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer";

/** One context per ~2 GB of RAM, at least 1, at most 8: a headless page is 50-150 MB, a heavy one more. */
export function defaultMaxContexts(totalBytes: number): number {
  const gb = totalBytes / 1024 ** 3;
  return Math.max(1, Math.min(8, Math.floor(gb / 2)));
}

const num = (v: string | undefined, dflt: number, min: number): number => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? Math.max(min, n) : dflt;
};

export function browserConfigFromEnv(env: Record<string, string | undefined>, totalBytes = os.totalmem()): BrowserConfig {
  const maxContexts = Math.round(num(env.CHRONOS_BROWSER_MAX_CONTEXTS, defaultMaxContexts(totalBytes), 1));
  return {
    enabled: !/^(off|0|false|no)$/i.test((env.CHRONOS_BROWSER ?? "on").trim()),
    path: env.CHRONOS_BROWSER_PATH?.trim() || null,
    idleMs: num(env.CHRONOS_BROWSER_IDLE_MS, 600_000, 1000),
    maxContexts,
    maxPerWorkspace: Math.round(num(env.CHRONOS_BROWSER_MAX_PER_WS, Math.max(1, Math.ceil(maxContexts / 2)), 1)),
    autoInstall: /^(1|on|true|yes)$/i.test((env.CHRONOS_BROWSER_AUTO_INSTALL ?? "").trim()),
  };
}

// ───────────────────────────── discovery ─────────────────────────────

export type EngineKind = "chrome-headless-shell" | "chrome-for-testing" | "custom";
export type EngineFound = { kind: EngineKind; path: string; version: string | null };
export type Discovery = { found: EngineFound | null; error: string | null };

export type FindDeps = {
  explicit?: string | null;
  home: string;
  platform: NodeJS.Platform;
  /** Puppeteer cache roots, in order. Default: $PUPPETEER_CACHE_DIR, ~/.cache/puppeteer. */
  cacheRoots?: string[];
  isFile?: (p: string) => boolean;
  list?: (dir: string) => string[];
};

export const isForbidden = (p: string): boolean => {
  const abs = path.resolve(p);
  return FORBIDDEN_PREFIXES.some((pre) => abs === pre.replace(/\/$/, "") || abs.startsWith(pre.endsWith("/") ? pre : pre + "/"));
};

/** `mac_arm-153.0.8010.36` → `153.0.8010.36`. */
const versionOf = (dir: string): string | null => /-(\d+(?:\.\d+)+)$/.exec(dir)?.[1] ?? null;
const cmpVersion = (a: string | null, b: string | null): number => {
  const pa = (a ?? "0").split(".").map(Number), pb = (b ?? "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const CFT_APP = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/**
 * What is installed, best first: an explicit path, the newest chrome-headless-shell in the puppeteer
 * cache, then Chrome for Testing (/Applications, then the cache). Never downloads anything.
 */
export function findEngine(d: FindDeps): Discovery {
  const isFile = d.isFile ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const list = d.list ?? ((dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } });
  if (d.explicit) {
    if (isForbidden(d.explicit)) return { found: null, error: `CHRONOS_BROWSER_PATH ${d.explicit} is the operator's own Chrome — refused; install chrome-headless-shell: ${INSTALL_HINT}` };
    if (!isFile(d.explicit)) return { found: null, error: `CHRONOS_BROWSER_PATH ${d.explicit} does not exist` };
    const base = path.basename(d.explicit);
    const kind: EngineKind = /headless[_-]shell/i.test(base) ? "chrome-headless-shell" : /Chrome for Testing/.test(d.explicit) ? "chrome-for-testing" : "custom";
    return { found: { kind, path: d.explicit, version: null }, error: null };
  }
  const roots = d.cacheRoots ?? [process.env.PUPPETEER_CACHE_DIR, path.join(d.home, ".cache", "puppeteer")].filter((x): x is string => !!x);
  const newest = (sub: string, exeIn: (platDir: string) => string | null): EngineFound | null => {
    const hits: EngineFound[] = [];
    for (const root of roots) {
      const base = path.join(root, sub);
      for (const v of list(base)) {
        for (const plat of list(path.join(base, v))) {
          const rel = exeIn(plat);
          if (!rel) continue;
          const exe = path.join(base, v, plat, rel);
          if (isFile(exe)) hits.push({ kind: sub === "chrome" ? "chrome-for-testing" : "chrome-headless-shell", path: exe, version: versionOf(v) });
        }
      }
    }
    return hits.sort((a, b) => cmpVersion(b.version, a.version))[0] ?? null;
  };
  const shell = newest("chrome-headless-shell", (plat) =>
    plat.startsWith("chrome-headless-shell-") ? (d.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell") : null,
  );
  if (shell) return { found: shell, error: null };
  if (d.platform === "darwin" && isFile(CFT_APP)) return { found: { kind: "chrome-for-testing", path: CFT_APP, version: null }, error: null };
  const cft = newest("chrome", (plat) =>
    plat.startsWith("chrome-mac") ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" : plat.startsWith("chrome-linux") ? "chrome" : null,
  );
  if (cft) return { found: cft, error: null };
  return { found: null, error: `no headless browser installed on this machine — install one: ${INSTALL_HINT}` };
}

/** The flags every launch gets: CDP over a pipe (no port), a throwaway profile, nothing that phones home. */
export function chromeArgs(found: EngineFound, userDataDir: string): string[] {
  const args = [
    // fds 3 (in) / 4 (out) of the daemon's child. Never --remote-debugging-port: a port on the
    // loopback is a door any local process can find, around every rule below.
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--password-store=basic",
    // No keychain prompt on the operator's screen from a daemon-owned browser.
    "--use-mock-keychain",
  ];
  // The headless shell is headless by construction; full Chrome needs the flag.
  if (found.kind !== "chrome-headless-shell") args.push("--headless=new");
  return args;
}

// ───────────────────────────── seams ─────────────────────────────

/** Raw CDP messages, one JSON text each. Chrome's pipe frames them with a NUL byte. */
export interface CdpTransport {
  send(msg: string): void;
  onMessage(cb: (msg: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type Launched = {
  pid: number;
  /** The CDP pipe — the only way into this browser. */
  transport: CdpTransport;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves when the process is gone. */
  exited: Promise<void>;
};
export type Launcher = (found: EngineFound, userDataDir: string) => Promise<Launched>;

/** NUL-framed CDP over Chrome's fds 3 (we write) and 4 (we read). */
export function pipeTransport(w: Writable, r: Readable): CdpTransport {
  const msgLs: Array<(m: string) => void> = [];
  const closeLs: Array<() => void> = [];
  let parts: Buffer[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeLs) cb();
  };
  r.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      parts.push(chunk.subarray(start, i));
      const msg = Buffer.concat(parts).toString("utf8");
      parts = [];
      start = i + 1;
      for (const cb of msgLs) cb(msg);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  });
  r.on("close", close);
  r.on("error", close);
  w.on("error", close);
  return {
    send: (m) => { if (!closed) { w.write(m); w.write("\0"); } },
    onMessage: (cb) => msgLs.push(cb),
    onClose: (cb) => closeLs.push(cb),
    close: () => { try { w.end(); } catch {} close(); },
  };
}

/** Spawn the engine with its CDP on a pipe. Readiness is the first answer over that pipe (ChromeEngine). */
export const systemLauncher: Launcher = (found, dir) =>
  new Promise<Launched>((resolve, reject) => {
    // Not detached: the browser stays in the daemon's process group, which the reaper never signals
    // and launchd takes down with the daemon if it ever dies without stopping it.
    const child = spawn(found.path, chromeArgs(found, dir), { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    let tail = "";
    child.stderr?.on("data", (b: Buffer) => { tail = (tail + b.toString("utf8")).slice(-2000); });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    // A daemon that exits without stopping the browser must not leave it behind.
    const onExit = () => { try { child.kill("SIGKILL"); } catch {} };
    process.once("exit", onExit);
    void exited.then(() => process.off("exit", onExit));
    child.once("error", (e) => reject(new Error(`could not start ${found.path}: ${e.message}`)));
    child.once("spawn", () => {
      const transport = pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable);
      resolve({
        pid: child.pid!,
        transport,
        kill: (s) => { try { child.kill(s); } catch {} },
        exited: exited.then(() => {
          if (tail.trim()) lastStderr = tail.trim().split("\n").slice(-3).join(" | ");
        }),
      });
    });
  });
let lastStderr = "";

// ───────────────────────────── the daemon's end of the pipe ─────────────────────────────

/**
 * Ids the daemon sends with. Clients' ids must stay below: a response's id says whose it is. Chrome
 * only takes int32 ids, so the daemon's half of the space is [2^30, 2^31).
 */
const DAEMON_ID_BASE = 2 ** 30;
const DAEMON_ID_MAX = 2 ** 31 - 1;
const CDP_TIMEOUT_MS = 15_000;

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };

/**
 * The one CDP connection. The daemon's own calls (`send`) carry ids from DAEMON_ID_BASE up; anything
 * on a session goes to whoever registered that session (`routes`) — a lease connection — and a
 * session nobody registered is dropped. Root events (no session) feed the target registry.
 */
class Mux {
  private next = DAEMON_ID_BASE;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly routes = new Map<string, (m: Msg) => void>();
  private rootLs: Array<(m: Msg) => void> = [];
  private closeLs: Array<() => void> = [];
  closed = false;

  constructor(private readonly t: CdpTransport) {
    t.onMessage((s) => this.dispatch(s));
    t.onClose(() => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP pipe closed")); }
      this.pending.clear();
      for (const cb of this.closeLs) cb();
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("CDP pipe closed"));
      const id = this.next++;
      if (this.next > DAEMON_ID_MAX) this.next = DAEMON_ID_BASE;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, CDP_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.t.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** A client's message, already vetted, on its own session. */
  post(m: Msg): void {
    if (!this.closed) this.t.send(JSON.stringify(m));
  }

  onRoot(cb: (m: Msg) => void): void { this.rootLs.push(cb); }
  onClose(cb: () => void): void { this.closeLs.push(cb); }
  close(): void { this.t.close(); }

  private dispatch(s: string): void {
    let m: Msg;
    try { m = JSON.parse(s); } catch { return; }
    if (typeof m.id === "number" && m.id >= DAEMON_ID_BASE) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message ?? "CDP error"));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.sessionId) return void this.routes.get(m.sessionId)?.(m);
    if (m.method) for (const cb of this.rootLs) cb(m);
  }
}

// ───────────────────────────── the lease policy ─────────────────────────────

/**
 * Domains a lease may use on a session attached to one of ITS targets. Everything there is scoped to
 * that target (its page, its frames, its context's storage partition). Per-method exceptions follow
 * in `policy`. Not here, so refused: Browser, SystemInfo, Tracing, Memory, Extensions, PWA, Cast,
 * DeviceAccess, BluetoothEmulation, BackgroundService, ServiceWorker, Autofill, Schema, Tethering…
 */
export const TARGET_DOMAINS = new Set([
  "Accessibility", "Animation", "Audits", "CacheStorage", "Console", "CSS", "Database", "Debugger", "DOM", "DOMDebugger",
  "DOMSnapshot", "DOMStorage", "Emulation", "EventBreakpoints", "Fetch", "HeapProfiler", "IndexedDB", "Input", "Inspector",
  "IO", "LayerTree", "Log", "Media", "Network", "Overlay", "Page", "Performance", "PerformanceTimeline", "Preload",
  "Profiler", "Runtime", "Security", "Storage", "Target", "WebAudio", "WebAuthn",
]);

/** Schemes a lease may load. `file:` above all: the browser reads the daemon user's disk. */
const URL_OK = /^(https?:|about:|data:|blob:)/i;
const urlOk = (u: unknown) => u == null || u === "" || (typeof u === "string" && URL_OK.test(u.trim()));

/** What the proxy does with one client message. */
export type Verdict =
  | { pass: true; params?: Record<string, unknown> }
  | { deny: string }
  | { reply: Record<string, unknown> }
  | { reply: Record<string, unknown>; thenClose: true }
  | { adopt: true };

export type LeaseView = {
  /** Is this context one of the lease's? */
  ownCtx(ctx: unknown): boolean;
  /** Is this target in one of the lease's contexts (as far as the proxy has seen)? */
  ownTarget(targetId: unknown): boolean;
  /** Is this flat session one the proxy saw attached to one of the lease's targets? */
  ownSession(sessionId: unknown): boolean;
};

/**
 * Allow-list, per method. `child` = the message is on a session attached to one of the lease's
 * targets; otherwise it is on the lease's own browser session.
 */
export function policy(method: string, p: Record<string, any>, child: boolean, v: LeaseView): Verdict {
  const domain = method.split(".")[0];
  const ctxOk = (c: unknown) => (v.ownCtx(c) ? null : "not a browser context of this Chronos browser lease");
  const tgtOk = (t: unknown) => (v.ownTarget(t) ? null : "not a target of this Chronos browser lease");
  const deny = (why: string | null): Verdict => (why ? { deny: why } : { pass: true });
  switch (method) {
    // ── Browser: only these. ──
    case "Browser.getVersion":
      return { pass: true };
    case "Browser.close":
    case "Browser.crash":
    case "Browser.crashGpuProcess":
      // puppeteer's `browser.close()` on a connected browser: answered, and only this client goes.
      return { reply: {}, thenClose: true };
    case "Browser.setDownloadBehavior":
      // Playwright sends it for every context it makes. Downloads would write wherever the agent
      // names on the daemon's disk, so they are always denied; the call itself succeeds.
      if (p.browserContextId == null) return { reply: {} };
      return v.ownCtx(p.browserContextId) ? { pass: true, params: { behavior: "deny", browserContextId: p.browserContextId } } : { deny: ctxOk(p.browserContextId)! };
    case "Browser.grantPermissions":
    case "Browser.resetPermissions":
    case "Browser.setPermission":
      return deny(ctxOk(p.browserContextId));
    // ── Storage: cookies of the lease's own contexts only. ──
    case "Storage.getCookies":
    case "Storage.setCookies":
    case "Storage.clearCookies":
      return deny(ctxOk(p.browserContextId));
    // ── Target: everything filtered to the lease. ──
    case "Target.getBrowserContexts":
    case "Target.getTargets":
    case "Target.setDiscoverTargets":
      return { pass: true }; // responses / events are filtered
    case "Target.setAutoAttach":
      return { pass: true, params: { ...p, flatten: true } }; // foreign auto-attaches are resumed + detached by the proxy
    case "Target.createBrowserContext":
      return p.proxyServer || p.proxyBypassList ? { deny: "a Chronos browser lease may not set a context proxy" } : { adopt: true };
    case "Target.disposeBrowserContext":
      return deny(ctxOk(p.browserContextId));
    case "Target.createTarget":
      if (!v.ownCtx(p.browserContextId)) return { deny: "Target.createTarget needs one of this lease's browserContextIds" };
      return urlOk(p.url) ? { pass: true } : { deny: "only http(s), about:, data: and blob: URLs" };
    case "Target.attachToTarget":
      return v.ownTarget(p.targetId) ? { pass: true, params: { ...p, flatten: true } } : { deny: tgtOk(p.targetId)! };
    case "Target.activateTarget":
    case "Target.closeTarget":
    case "Target.autoAttachRelated":
      return deny(tgtOk(p.targetId));
    case "Target.getTargetInfo":
      // No targetId = the session's own target: the browser itself, or the lease's own page.
      if (p.targetId == null) return { pass: true };
      return deny(tgtOk(p.targetId));
    case "Target.detachFromTarget":
      if (p.sessionId != null) return v.ownSession(p.sessionId) ? { pass: true } : { deny: "not a session of this Chronos browser lease" };
      return deny(tgtOk(p.targetId));
    // ── No reach into the daemon's disk, on any session. ──
    case "Page.navigate":
      return urlOk(p.url) ? { pass: true } : { deny: "only http(s), about:, data: and blob: URLs" };
    case "Page.setDownloadBehavior":
    case "Page.handleFileChooser":
    case "DOM.setFileInputFiles":
    case "Network.loadNetworkResource":
    case "Security.setIgnoreCertificateErrors":
      return { deny: `${method} is not available through a Chronos browser lease` };
    case "Input.dispatchDragEvent":
      return p.data?.files?.length ? { deny: "dragging local files is not available through a Chronos browser lease" } : { pass: true };
  }
  if (domain === "Target") return { deny: `${method} is not available through a Chronos browser lease` };
  if (domain === "Storage") {
    // On a page's own session the storage is that page's; a named context must be the lease's.
    if (!child) return { deny: "Storage on the browser session needs one of this lease's contexts" };
    return deny(p.browserContextId == null ? null : ctxOk(p.browserContextId));
  }
  if (child && TARGET_DOMAINS.has(domain)) return { pass: true };
  return { deny: `${method} is not available through a Chronos browser lease` };
}

// ───────────────────────────── the engine ─────────────────────────────

export type EngineStatus = {
  engine: EngineKind | null;
  version: string | null;
  path: string | null;
  pid: number | null;
  running: boolean;
  /** Live lease handles on the browser. */
  handles: number;
  /** When the idle stop fires (no lease left), or null. */
  idle_stops_at: number | null;
  /** Why the last start failed (no engine installed, …), until one succeeds. */
  error: string | null;
  /** Remote engines report the HOST's own caps (the brain cannot see a host's RAM). */
  cap?: number;
  per_ws?: number;
};

export type Opened = { handle: string; context_id: string; ws_endpoint: string };

/** Who a lease is for: its contexts go through that workspace's egress proxy, when it has one. */
export type OpenOpts = { workspace_id?: string | null; /** a host: the brain's egress policy for it */ egress?: unknown };

/** What the pool needs from a browser, local or on a host. */
export interface BrowserEngine {
  /** Start the browser if needed and open a fresh context behind a new proxy handle. */
  open(o?: OpenOpts): Promise<Opened>;
  /** Dispose every context of the handle (closes all its pages) and drop its clients. */
  close(handle: string): Promise<void>;
  /** Heartbeat. false = the handle is gone (browser restarted, TTL). */
  touch(handle: string): Promise<boolean>;
  status(): EngineStatus;
  /** Handles the engine lost on its own (browser crashed, TTL) — the pool drops their leases. */
  onLost(cb: (handles: string[]) => void): void;
  stop(why?: string): Promise<void>;
}

type Handle = {
  /** Internal id (the pool and the host rpc speak it). Never a credential. */
  id: string;
  /** The capability in the proxy URL: 256 random bits, compared in constant time. */
  secret: Buffer;
  contexts: Set<string>;
  /** The workspace's egress proxy every context of this lease goes through (null = direct). */
  proxyServer: string | null;
  touched: number;
  conns: Set<LeaseConn>;
};
type Running = {
  found: EngineFound;
  proc: Launched;
  mux: Mux;
  dir: string;
  startedAt: number;
  proxy: http.Server;
  proxyPort: number;
  wss: WebSocketServer;
  sweep: NodeJS.Timeout;
  /** targetId → browserContextId, from the daemon's own discovery and what leases were shown. */
  targets: Map<string, string>;
};

/** Contexts one lease may create on its own (`browser.newContext()`), beyond the one it was given. */
export const MAX_CONTEXTS_PER_HANDLE = 8;
const SWEEP_MS = 30_000;
const WS_MAX = 256 * 1024 * 1024; // full-page screenshots are big
const SECRET_BYTES = 32;

export type ChromeEngineOpts = {
  cfg: BrowserConfig;
  /** The daemon's (or hostd's) state dir for profiles: `<dataDir>/profile-*`. */
  dataDir: string;
  find?: () => Discovery;
  launch?: Launcher;
  install?: () => Promise<void>;
  now?: () => number;
  /** Dispose a handle nobody touched for this long (null = never). The pool's own window is 90 s. */
  ttlMs?: number | null;
  sweepMs?: number;
  log?: (line: string) => void;
  /**
   * The egress proxy a lease's contexts must use (`http://127.0.0.1:<port>`), or null. An agent of an
   * egress-locked workspace must not get the open internet by borrowing the daemon's browser.
   */
  proxyFor?: (o: OpenOpts) => Promise<string | null> | string | null;
};

export class ChromeEngine implements BrowserEngine {
  private run: Running | null = null;
  private starting: Promise<Running> | null = null;
  private readonly handles = new Map<string, Handle>();
  /** Opens in flight: the idle stop waits for them. */
  private opening = 0;
  /** Contexts a client is creating through the proxy right now (the stray sweep waits for them). */
  private adopting = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleAt: number | null = null;
  private lastError: string | null = null;
  private installed = false;
  private lostLs: Array<(h: string[]) => void> = [];
  private readonly now: () => number;
  private readonly log: (l: string) => void;

  constructor(private readonly o: ChromeEngineOpts) {
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? ((l) => console.log(`[browser] ${l}`));
  }

  private find(): Discovery {
    return this.o.find ? this.o.find() : findEngine({ explicit: this.o.cfg.path, home: os.homedir(), platform: process.platform });
  }

  status(): EngineStatus {
    const r = this.run;
    return {
      engine: r?.found.kind ?? null,
      version: r?.found.version ?? null,
      path: r?.found.path ?? null,
      pid: r?.proc.pid ?? null,
      running: !!r,
      handles: this.handles.size,
      idle_stops_at: this.idleAt,
      error: this.lastError,
      cap: this.o.cfg.maxContexts,
      per_ws: this.o.cfg.maxPerWorkspace,
    };
  }

  onLost(cb: (h: string[]) => void): void { this.lostLs.push(cb); }

  private ensure(): Promise<Running> {
    if (this.run) return Promise.resolve(this.run);
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<Running> {
    let d = this.find();
    if (!d.found && this.o.cfg.autoInstall && !this.installed && !this.o.cfg.path) {
      this.installed = true;
      this.log(`no engine installed — CHRONOS_BROWSER_AUTO_INSTALL: ${INSTALL_HINT}`);
      try { await (this.o.install ?? installHeadlessShell)(); } catch (e: any) { this.log(`install failed: ${e?.message ?? e}`); }
      d = this.find();
    }
    if (!d.found) {
      this.lastError = d.error;
      throw new Error(d.error ?? "no headless browser installed");
    }
    const found = d.found;
    // One browser per daemon: any profile dir still here is a crashed predecessor's. 0700 all the way
    // down: cookies and storage of every lease live in it while the browser runs.
    fs.mkdirSync(this.o.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.o.dataDir, 0o700);
    for (const n of fs.readdirSync(this.o.dataDir)) if (n.startsWith("profile-")) fs.rmSync(path.join(this.o.dataDir, n), { recursive: true, force: true });
    const dir = fs.mkdtempSync(path.join(this.o.dataDir, "profile-"));
    fs.chmodSync(dir, 0o700);
    let proc: Launched | null = null;
    let mux: Mux | null = null;
    try {
      proc = await (this.o.launch ?? systemLauncher)(found, dir);
      mux = new Mux(proc.transport);
      const m = mux;
      // Ready = the browser answers over the pipe (or dies first).
      const died = proc.exited.then(() => { throw new Error(`${path.basename(found.path)} exited during startup${lastStderr ? ` — ${lastStderr}` : ""}`); });
      await Promise.race([m.send("Browser.getVersion"), died]);
      void died.catch(() => {});
      const targets = new Map<string, string>();
      m.onRoot((e) => {
        const info = e.params?.targetInfo;
        if ((e.method === "Target.targetCreated" || e.method === "Target.targetInfoChanged") && info?.targetId && info.browserContextId) targets.set(info.targetId, info.browserContextId);
        else if (e.method === "Target.targetDestroyed" && e.params?.targetId) targets.delete(e.params.targetId);
      });
      await m.send("Target.setDiscoverTargets", { discover: true });
      const { server, wss, port } = await this.listen();
      const sweep = setInterval(() => void this.sweep(), this.o.sweepMs ?? SWEEP_MS);
      sweep.unref?.();
      const run: Running = { found, proc, mux: m, dir, startedAt: this.now(), proxy: server, proxyPort: port, wss, sweep, targets };
      this.run = run;
      this.lastError = null;
      void proc.exited.then(() => this.gone(run, "exited"));
      m.onClose(() => this.gone(run, "CDP pipe closed"));
      this.log(`started ${found.kind}${found.version ? ` ${found.version}` : ""} (pid ${proc.pid}, CDP over a pipe) — lease proxy on 127.0.0.1:${port}`);
      return run;
    } catch (e: any) {
      mux?.close();
      proc?.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
      this.lastError = String(e?.message ?? e);
      throw e;
    }
  }

  /** The browser went away without `stop()`: every lease on it is lost. */
  private gone(run: Running, why: string): void {
    if (this.run !== run) return;
    this.run = null;
    this.teardown(run);
    run.proc.kill("SIGKILL");
    const lost = [...this.handles.keys()];
    this.handles.clear();
    this.clearIdle();
    this.log(`browser ${why} — ${lost.length} lease${lost.length === 1 ? "" : "s"} lost`);
    if (lost.length) for (const cb of this.lostLs) cb(lost);
  }

  private teardown(run: Running): void {
    clearInterval(run.sweep);
    for (const h of this.handles.values()) for (const c of h.conns) c.end();
    try { run.wss.close(); } catch {}
    try { run.proxy.close(); } catch {}
    run.mux.close();
    void run.proc.exited.then(() => fs.rmSync(run.dir, { recursive: true, force: true }));
  }

  async open(o: OpenOpts = {}): Promise<Opened> {
    if (!this.o.cfg.enabled) throw new Error("the shared browser is off on this machine (CHRONOS_BROWSER=off)");
    this.opening++;
    this.clearIdle();
    try {
      const proxyServer = (await this.o.proxyFor?.(o)) ?? null;
      const run = await this.ensure();
      const r = await run.mux.send("Target.createBrowserContext", { disposeOnDetach: false, ...(proxyServer ? { proxyServer } : {}) });
      const ctx = String(r.browserContextId);
      const id = randomUUID();
      const secret = randomBytes(SECRET_BYTES);
      this.handles.set(id, { id, secret, contexts: new Set([ctx]), proxyServer, touched: this.now(), conns: new Set() });
      return { handle: id, context_id: ctx, ws_endpoint: `ws://127.0.0.1:${run.proxyPort}/devtools/browser/${secret.toString("base64url")}` };
    } finally {
      this.opening--;
      this.armIdle();
    }
  }

  async close(handle: string): Promise<void> {
    const h = this.handles.get(handle);
    if (!h) return;
    this.handles.delete(handle);
    for (const c of h.conns) c.end();
    const run = this.run;
    if (run) for (const ctx of h.contexts) await run.mux.send("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {});
    this.armIdle();
  }

  async touch(handle: string): Promise<boolean> {
    const h = this.handles.get(handle);
    if (!h) return false;
    h.touched = this.now();
    return true;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleAt = null;
  }

  private armIdle(): void {
    if (!this.run || this.handles.size || this.opening || this.idleTimer) return;
    this.idleAt = this.now() + this.o.cfg.idleMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.idleAt = null;
      if (!this.handles.size && !this.opening) void this.stop("idle");
    }, this.o.cfg.idleMs);
    this.idleTimer.unref?.();
  }

  /**
   * Housekeeping, every 30 s while running: handles past the TTL, contexts no lease holds, and
   * pages in the default context (nobody's lease, so nobody would ever close them).
   */
  async sweep(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const ttl = this.o.ttlMs;
    if (ttl != null) {
      for (const h of [...this.handles.values()]) {
        if (this.now() - h.touched > ttl) {
          this.log(`lease handle ${h.id.slice(0, 8)} untouched for ${Math.round((this.now() - h.touched) / 1000)}s — disposed`);
          await this.close(h.id);
          for (const cb of this.lostLs) cb([h.id]);
        }
      }
    }
    // A context being created right now is in Chrome's list before it is in a handle's set.
    if (this.opening || this.adopting) return;
    try {
      const { browserContextIds = [], defaultBrowserContextId } = await run.mux.send("Target.getBrowserContexts");
      // Read AFTER the await: one pipe, so anything created before the list was taken has already
      // been recorded by its own (earlier) response.
      const held = new Set<string>();
      for (const h of this.handles.values()) for (const c of h.contexts) held.add(c);
      for (const id of browserContextIds as string[]) {
        if (held.has(id)) continue;
        this.log(`stray context ${id.slice(0, 8)} (no lease) — disposed`);
        await run.mux.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => {});
      }
      const { targetInfos = [] } = await run.mux.send("Target.getTargets");
      for (const t of targetInfos as Array<{ targetId: string; type: string; browserContextId?: string }>) {
        if (t.type === "page" && t.browserContextId && t.browserContextId === defaultBrowserContextId) {
          await run.mux.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
        }
      }
    } catch {
      // The browser is going away; `gone` handles that.
    }
  }

  async stop(why = "stop"): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.clearIdle();
    const lost = [...this.handles.keys()];
    this.teardown(run);
    this.handles.clear();
    run.proc.kill("SIGTERM");
    const t = new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref?.());
    if (!(await Promise.race([run.proc.exited.then(() => true), t]))) run.proc.kill("SIGKILL");
    await Promise.race([run.proc.exited, new Promise((r) => setTimeout(r, 2000).unref?.())]);
    fs.rmSync(run.dir, { recursive: true, force: true });
    this.log(`stopped (${why})${lost.length ? ` — ${lost.length} lease${lost.length === 1 ? "" : "s"} closed` : ""}`);
    if (lost.length) for (const cb of this.lostLs) cb(lost);
  }

  // ───────────── the lease proxy: the only door ─────────────

  /** The handle whose secret this is. Every handle is compared, each in constant time. */
  private bySecret(s: string): Handle | undefined {
    let got: Buffer;
    try { got = Buffer.from(s, "base64url"); } catch { return undefined; }
    if (got.length !== SECRET_BYTES) return undefined;
    let hit: Handle | undefined;
    for (const h of this.handles.values()) if (timingSafeEqual(h.secret, got)) hit = h;
    return hit;
  }

  private listen(): Promise<{ server: http.Server; wss: WebSocketServer; port: number }> {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_MAX });
    server.on("upgrade", (req, sock, head) => {
      const m = /^\/devtools\/browser\/([A-Za-z0-9_-]{1,64})$/.exec(req.url ?? "");
      const h = m ? this.bySecret(m[1]) : undefined;
      const run = this.run;
      if (!h || !run) {
        sock.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, sock, head, (client) => {
        const conn = new LeaseConn(h, client, run, this);
        h.conns.add(conn);
        void conn.start();
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve({ server, wss, port: (server.address() as { port: number }).port }));
    });
  }

  /** `Target.createBrowserContext` from a lease: made by the daemon, adopted before the client sees its id. */
  async adoptContext(h: Handle): Promise<Record<string, unknown>> {
    if (h.contexts.size >= MAX_CONTEXTS_PER_HANDLE + 1) throw new Error(`a Chronos browser lease holds at most ${MAX_CONTEXTS_PER_HANDLE + 1} contexts`);
    const run = this.run;
    if (!run) throw new Error("browser is not running");
    this.adopting++;
    try {
      const r = await run.mux.send("Target.createBrowserContext", { disposeOnDetach: false, ...(h.proxyServer ? { proxyServer: h.proxyServer } : {}) });
      if (!this.handles.has(h.id)) {
        void run.mux.send("Target.disposeBrowserContext", { browserContextId: r.browserContextId }).catch(() => {});
        throw new Error("the lease ended");
      }
      h.contexts.add(String(r.browserContextId));
      return r;
    } finally {
      this.adopting--;
    }
  }
}

/** Methods whose answers are filtered to the lease, or teach the proxy something. */
const WATCHED = new Set(["Target.getTargets", "Target.getBrowserContexts", "Target.getTargetInfo", "Target.attachToTarget", "Target.createTarget", "Target.disposeBrowserContext"]);

/**
 * One agent connection on the lease proxy. It gets its own browser session (so `setDiscoverTargets`
 * and `setAutoAttach` are its own state), every message is vetted by `policy`, and every answer and
 * event is filtered to the lease's contexts before it goes back.
 */
class LeaseConn {
  private bsid: string | null = null;
  private queue: string[] = [];
  private ended = false;
  /** Flat sessions this client may speak on: attached to one of the lease's targets, seen by us. */
  private readonly sessions = new Set<string>();
  /** Targets this client has been shown (the lease's own). */
  private readonly shown = new Set<string>();
  /** `${sessionId}:${id}` → the method, for answers that need filtering. */
  private readonly pending = new Map<string, { method: string; params: any }>();
  private readonly view: LeaseView;

  constructor(private readonly h: Handle, private readonly ws: WebSocket, private readonly run: Running, private readonly eng: ChromeEngine) {
    this.view = {
      ownCtx: (c) => typeof c === "string" && h.contexts.has(c),
      ownTarget: (t) => typeof t === "string" && h.contexts.has(run.targets.get(t) ?? ""),
      ownSession: (s) => typeof s === "string" && this.sessions.has(s),
    };
    ws.on("message", (d) => (this.bsid ? this.fromClient(String(d)) : this.queue.push(String(d))));
    ws.on("close", () => this.end());
    ws.on("error", () => this.end());
  }

  async start(): Promise<void> {
    try {
      const r = await this.run.mux.send("Target.attachToBrowserTarget");
      if (this.ended) return void this.run.mux.send("Target.detachFromTarget", { sessionId: r.sessionId }).catch(() => {});
      this.bsid = String(r.sessionId);
      this.run.mux.routes.set(this.bsid, (m) => this.fromChrome(m, null));
      for (const s of this.queue.splice(0)) this.fromClient(s);
    } catch {
      this.end();
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.h.conns.delete(this);
    try { this.ws.close(); } catch {}
    const mux = this.run.mux;
    for (const s of this.sessions) mux.routes.delete(s);
    if (this.bsid) {
      mux.routes.delete(this.bsid);
      void mux.send("Target.detachFromTarget", { sessionId: this.bsid }).catch(() => {});
    }
  }

  private toClient(m: Msg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private fromClient(raw: string): void {
    let m: Msg;
    try { m = JSON.parse(raw); } catch { return this.end(); }
    const id = m.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= DAEMON_ID_BASE || typeof m.method !== "string") {
      return this.toClient({ id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), error: { code: -32600, message: "invalid request" } });
    }
    const sid = m.sessionId;
    const back = (x: Record<string, unknown>) => this.toClient({ id, ...(sid ? { sessionId: sid } : {}), ...x });
    // Flat sessions: only those the proxy saw attached to one of this lease's targets.
    if (sid != null && !this.sessions.has(sid)) return back({ error: { code: -32001, message: "not a session of this Chronos browser lease" } });
    const v = policy(m.method, (m.params ?? {}) as Record<string, any>, sid != null, this.view);
    if ("deny" in v) return back({ error: { code: -32000, message: v.deny } });
    if ("reply" in v) {
      back({ result: v.reply });
      if ("thenClose" in v) setTimeout(() => this.end(), 50).unref?.();
      return;
    }
    if ("adopt" in v) {
      void this.eng.adoptContext(this.h).then((r) => back({ result: r }), (e) => back({ error: { code: -32000, message: String(e?.message ?? e) } }));
      return;
    }
    const params = v.params ?? m.params ?? {};
    if (WATCHED.has(m.method)) this.pending.set(`${sid ?? ""}:${id}`, { method: m.method, params });
    this.run.mux.post({ id, method: m.method, params, sessionId: sid ?? this.bsid! });
  }

  /** A target event / answer is the lease's if its context is. Records what the client was shown. */
  private mine(info: { targetId?: string; browserContextId?: string } | undefined): boolean {
    if (!info?.targetId || !info.browserContextId || !this.h.contexts.has(info.browserContextId)) return false;
    this.run.targets.set(info.targetId, info.browserContextId);
    this.shown.add(info.targetId);
    return true;
  }

  private adoptSession(sessionId: string, targetId?: string): void {
    this.sessions.add(sessionId);
    if (targetId) this.shown.add(targetId);
    this.run.mux.routes.set(sessionId, (m) => this.fromChrome(m, sessionId));
  }

  /** `via` = the child session it came on, null for this client's browser session. */
  private fromChrome(m: Msg, via: string | null): void {
    const out = (x: Msg) => this.toClient(via ? { ...x, sessionId: via } : (({ sessionId: _s, ...rest }) => rest)(x));
    if (m.id != null) {
      const key = `${via ?? ""}:${m.id}`;
      const p = this.pending.get(key);
      this.pending.delete(key);
      if (!p || m.error) return out(m);
      const r = m.result ?? {};
      switch (p.method) {
        case "Target.getTargets":
          return out({ ...m, result: { ...r, targetInfos: (r.targetInfos ?? []).filter((t: any) => this.mine(t)) } });
        case "Target.getBrowserContexts":
          return out({ id: m.id, result: { browserContextIds: (r.browserContextIds ?? []).filter((c: string) => this.h.contexts.has(c)) } });
        case "Target.getTargetInfo":
          if (p.params?.targetId == null) return out(m); // the session's own target
          return this.mine(r.targetInfo) ? out(m) : out({ id: m.id, error: { code: -32000, message: "not a target of this Chronos browser lease" } });
        case "Target.attachToTarget":
          if (r.sessionId) this.adoptSession(String(r.sessionId), p.params?.targetId);
          return out(m);
        case "Target.createTarget":
          if (r.targetId) { this.run.targets.set(r.targetId, p.params.browserContextId); this.shown.add(r.targetId); }
          return out(m);
        case "Target.disposeBrowserContext":
          this.h.contexts.delete(p.params.browserContextId);
          return out(m);
      }
      return out(m);
    }
    const e = m.params ?? {};
    switch (m.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        return this.mine(e.targetInfo) ? out(m) : undefined;
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        if (!this.shown.has(e.targetId)) return;
        if (m.method === "Target.targetDestroyed") this.shown.delete(e.targetId);
        return out(m);
      case "Target.attachedToTarget": {
        const child = String(e.sessionId ?? "");
        if (child && this.mine(e.targetInfo)) {
          this.adoptSession(child, e.targetInfo.targetId);
          return out(m);
        }
        // Auto-attach reached another lease's (or the default context's) target: let it run and let go.
        if (child) {
          if (e.waitingForDebugger) void this.run.mux.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
          void this.run.mux.send("Target.detachFromTarget", { sessionId: child }, via ?? this.bsid ?? undefined).catch(() => {});
        }
        return;
      }
      case "Target.detachedFromTarget":
        if (!this.sessions.has(e.sessionId)) return;
        this.sessions.delete(e.sessionId);
        this.run.mux.routes.delete(e.sessionId);
        return out(m);
      case "Target.receivedMessageFromTarget":
        return;
    }
    // Every other event: on a child session it is that target's own; on the browser session only
    // the Target events above are this lease's business.
    if (via) out(m);
  }
}

/** CHRONOS_BROWSER_AUTO_INSTALL: the documented one-liner, once, bounded. */
export function installHeadlessShell(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "@puppeteer/browsers", "install", "chrome-headless-shell@stable", "--path", path.join(os.homedir(), ".cache", "puppeteer")], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("install timed out after 5 min")); }, 300_000);
    timer.unref?.();
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`install exited ${code}`)); });
  });
}

// ───────────────────────────── hosts ─────────────────────────────

/** The `browser` rpc a host answers (hostd/index.ts). Every reply carries the host's engine status. */
export type BrowserRpc = { op: "open"; workspace_id?: string | null; egress?: unknown } | { op: "close"; handle: string } | { op: "touch"; handle: string } | { op: "status" };

export async function handleBrowserRpc(engine: BrowserEngine, args: unknown): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as { op?: string; handle?: unknown };
  const handle = typeof a.handle === "string" ? a.handle : "";
  switch (a.op) {
    case "open": {
      const o = args as { workspace_id?: unknown; egress?: unknown };
      return { ...(await engine.open({ workspace_id: typeof o.workspace_id === "string" ? o.workspace_id : null, egress: o.egress })), status: engine.status() };
    }
    case "close": await engine.close(handle); return { ok: true, status: engine.status() };
    case "touch": return { alive: await engine.touch(handle), status: engine.status() };
    case "status": return { status: engine.status() };
    default: throw new Error(`unknown browser op ${String(a.op)}`);
  }
}

/**
 * A host's browser, driven from the brain over the link (the `browser` rpc). The process, the proxy
 * and the TTL all live on the host; this keeps the last status the host reported, for `GET /machine`
 * and for the host's own caps (sized from ITS RAM and ITS knobs).
 */
export class RemoteBrowserEngine implements BrowserEngine {
  private last: EngineStatus | null = null;
  private lostLs: Array<(h: string[]) => void> = [];

  constructor(private readonly rpc: (args: BrowserRpc) => Promise<unknown>) {}

  private note(r: unknown): any {
    const s = (r as { status?: EngineStatus } | null)?.status;
    if (s && typeof s === "object") this.last = s;
    return r;
  }

  /** Ask the host for its status (and caps); errors leave the last one in place. */
  async refresh(): Promise<void> {
    try { this.note(await this.rpc({ op: "status" })); } catch {}
  }

  async open(o: OpenOpts = {}): Promise<Opened> {
    const r = this.note(await this.rpc({ op: "open", workspace_id: o.workspace_id ?? null }));
    if (!r?.handle || !r?.ws_endpoint) throw new Error("the host answered the browser lease without an endpoint (is it up to date?)");
    return { handle: String(r.handle), context_id: String(r.context_id), ws_endpoint: String(r.ws_endpoint) };
  }

  async close(handle: string): Promise<void> {
    this.note(await this.rpc({ op: "close", handle }));
  }

  async touch(handle: string): Promise<boolean> {
    try {
      const r = this.note(await this.rpc({ op: "touch", handle }));
      if (r?.alive === false) {
        for (const cb of this.lostLs) cb([handle]);
        return false;
      }
      return true;
    } catch {
      // The link is down: not proof the context is gone. The pool's own stale window decides.
      return true;
    }
  }

  status(): EngineStatus {
    return this.last ?? { engine: null, version: null, path: null, pid: null, running: false, handles: 0, idle_stops_at: null, error: null };
  }

  onLost(cb: (h: string[]) => void): void { this.lostLs.push(cb); }

  async stop(): Promise<void> {}
}
