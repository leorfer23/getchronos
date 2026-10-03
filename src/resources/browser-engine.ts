/**
 * The machine's one shared headless browser (RESOURCES.md → Shared headless browser pool): which
 * engine is installed, the process itself, and the CDP door agents reach it through.
 *
 * 2026-10-02: every test run launching its own Chrome left 188 headless Chrome processes (2-4 GB)
 * behind and pushed the brain to load 30 with full swap. This is the alternative: ONE browser per
 * machine, started on demand, stopped when idle, the daemon's own child (so the ledger never
 * attributes it to a terminal and the reaper never touches it — ledger.ts adopts only below
 * `localHost.listLive()` roots, and the spawner's process group is never a target).
 *
 *  - Engine: `chrome-headless-shell` from the puppeteer cache, else Chrome for Testing. NEVER
 *    `/Applications/Google Chrome.app` (the operator's own browser — ~/.claude/BROWSER.md).
 *  - A throwaway user-data-dir under the daemon's state dir, `--remote-debugging-port=0` (the port
 *    is read back from `DevToolsActivePort`), loopback only.
 *  - Agents never get Chrome's own endpoint. Each lease gets a handle on a loopback CDP PROXY
 *    (`ws://127.0.0.1:<proxy>/devtools/browser/<handle>`) that passes everything through except what
 *    would hurt the other leases: `Browser.close` (puppeteer's `browser.close()` on a connected
 *    browser sends it — it would kill every workspace's pages) is answered and only disconnects that
 *    client; `Target.disposeBrowserContext` works only on the lease's own contexts; a context the
 *    client creates (`browser.newContext()`) is adopted by its lease and dies with it.
 *  - A periodic sweep disposes contexts nobody holds, closes pages opened in the default context,
 *    and (TTL) disposes handles nobody has touched — on a host that is what cleans up when its
 *    brain goes away for good.
 *
 * The bookkeeping (who holds what, caps, fairness, heartbeats) is browser-pool.ts. Seams: `Launcher`
 * (spawn + DevToolsActivePort) and `CdpConnect` (the daemon's own CDP client) — the tests fake both.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/** The flags every launch gets. Loopback, a free port, a throwaway profile, nothing that phones home. */
export function chromeArgs(found: EngineFound, userDataDir: string): string[] {
  const args = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
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

export type Launched = {
  pid: number;
  /** Chrome's own browser endpoint (never handed to an agent). */
  wsEndpoint: string;
  kill(signal?: NodeJS.Signals): void;
  /** Resolves when the process is gone. */
  exited: Promise<void>;
};
export type Launcher = (found: EngineFound, userDataDir: string) => Promise<Launched>;

export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
  onClose(cb: () => void): void;
}
export type CdpConnect = (wsEndpoint: string) => Promise<Cdp>;

const LAUNCH_TIMEOUT_MS = 20_000;

/** Spawn the engine and wait for `DevToolsActivePort` (line 1 = port, line 2 = browser path). */
export const systemLauncher: Launcher = (found, dir) =>
  new Promise<Launched>((resolve, reject) => {
    // Not detached: the browser stays in the daemon's process group, which the reaper never signals
    // and launchd takes down with the daemon if it ever dies without stopping it.
    const child = spawn(found.path, chromeArgs(found, dir), { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr?.on("data", (b: Buffer) => { tail = (tail + b.toString("utf8")).slice(-2000); });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    // A daemon that exits without stopping the browser must not leave it behind.
    const onExit = () => { try { child.kill("SIGKILL"); } catch {} };
    process.once("exit", onExit);
    void exited.then(() => process.off("exit", onExit));
    let done = false;
    const fail = (why: string) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${why}${tail.trim() ? ` — ${tail.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
    };
    child.once("error", (e) => fail(`could not start ${found.path}: ${e.message}`));
    child.once("exit", (code, sig) => fail(`${path.basename(found.path)} exited during startup (${sig ?? code})`));
    const file = path.join(dir, "DevToolsActivePort");
    const poll = setInterval(() => {
      let lines: string[];
      try { lines = fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()); } catch { return; }
      const port = Number(lines[0]);
      if (!port || !lines[1]?.startsWith("/devtools/browser/")) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ pid: child.pid!, wsEndpoint: `ws://127.0.0.1:${port}${lines[1]}`, kill: (s) => { try { child.kill(s); } catch {} }, exited });
    }, 50);
    const timer = setTimeout(() => fail(`no DevToolsActivePort after ${LAUNCH_TIMEOUT_MS / 1000}s`), LAUNCH_TIMEOUT_MS);
  });

const WS_MAX = 256 * 1024 * 1024; // full-page screenshots are big

/** The daemon's own CDP client: request/response by id, nothing else. */
export const systemCdp: CdpConnect = (url) =>
  new Promise<Cdp>((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: WS_MAX });
    let next = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    const closeLs: Array<() => void> = [];
    ws.on("message", (data) => {
      let m: any;
      try { m = JSON.parse(String(data)); } catch { return; }
      const p = typeof m?.id === "number" ? pending.get(m.id) : undefined;
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message ?? "CDP error"));
      else p.resolve(m.result ?? {});
    });
    ws.once("close", () => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP connection closed")); }
      pending.clear();
      for (const cb of closeLs) cb();
    });
    ws.once("error", (e) => reject(e));
    ws.once("open", () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) return rej(new Error("CDP connection closed"));
            const id = ++next;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, 15_000);
            timer.unref?.();
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        close: () => { try { ws.close(); } catch {} },
        onClose: (cb) => closeLs.push(cb),
      }),
    );
  });

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

/** What the pool needs from a browser, local or on a host. */
export interface BrowserEngine {
  /** Start the browser if needed and open a fresh context behind a new proxy handle. */
  open(): Promise<Opened>;
  /** Dispose every context of the handle (closes all its pages) and drop its clients. */
  close(handle: string): Promise<void>;
  /** Heartbeat. false = the handle is gone (browser restarted, TTL). */
  touch(handle: string): Promise<boolean>;
  status(): EngineStatus;
  /** Handles the engine lost on its own (browser crashed, TTL) — the pool drops their leases. */
  onLost(cb: (handles: string[]) => void): void;
  stop(why?: string): Promise<void>;
}

type Handle = { id: string; contexts: Set<string>; touched: number; clients: Set<WebSocket> };
type Running = {
  found: EngineFound;
  proc: Launched;
  cdp: Cdp;
  dir: string;
  startedAt: number;
  proxy: http.Server;
  proxyPort: number;
  wss: WebSocketServer;
  sweep: NodeJS.Timeout;
};

/** Contexts one lease may create on its own (`browser.newContext()`), beyond the one it was given. */
export const MAX_CONTEXTS_PER_HANDLE = 8;
const SWEEP_MS = 30_000;

export type ChromeEngineOpts = {
  cfg: BrowserConfig;
  /** The daemon's (or hostd's) state dir for profiles: `<dataDir>/profile-*`. */
  dataDir: string;
  find?: () => Discovery;
  launch?: Launcher;
  connect?: CdpConnect;
  install?: () => Promise<void>;
  now?: () => number;
  /** Dispose a handle nobody touched for this long (null = never). The pool's own window is 90 s. */
  ttlMs?: number | null;
  sweepMs?: number;
  log?: (line: string) => void;
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
    // One browser per daemon: any profile dir still here is a crashed predecessor's.
    fs.mkdirSync(this.o.dataDir, { recursive: true, mode: 0o700 });
    for (const n of fs.readdirSync(this.o.dataDir)) if (n.startsWith("profile-")) fs.rmSync(path.join(this.o.dataDir, n), { recursive: true, force: true });
    const dir = fs.mkdtempSync(path.join(this.o.dataDir, "profile-"));
    let proc: Launched | null = null;
    try {
      proc = await (this.o.launch ?? systemLauncher)(found, dir);
      const cdp = await (this.o.connect ?? systemCdp)(proc.wsEndpoint);
      const { server, wss, port } = await this.listen(proc.wsEndpoint);
      const sweep = setInterval(() => void this.sweep(), this.o.sweepMs ?? SWEEP_MS);
      sweep.unref?.();
      const run: Running = { found, proc, cdp, dir, startedAt: this.now(), proxy: server, proxyPort: port, wss, sweep };
      this.run = run;
      this.lastError = null;
      void proc.exited.then(() => this.gone(run, "exited"));
      cdp.onClose(() => this.gone(run, "CDP connection closed"));
      this.log(`started ${found.kind}${found.version ? ` ${found.version}` : ""} (pid ${proc.pid}) — CDP proxy on 127.0.0.1:${port}`);
      return run;
    } catch (e: any) {
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
    for (const h of this.handles.values()) for (const c of h.clients) try { c.terminate(); } catch {}
    try { run.wss.close(); } catch {}
    try { run.proxy.close(); } catch {}
    run.cdp.close();
    void run.proc.exited.then(() => fs.rmSync(run.dir, { recursive: true, force: true }));
  }

  async open(): Promise<Opened> {
    if (!this.o.cfg.enabled) throw new Error("the shared browser is off on this machine (CHRONOS_BROWSER=off)");
    this.opening++;
    this.clearIdle();
    try {
      const run = await this.ensure();
      const r = await run.cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
      const ctx = String(r.browserContextId);
      const id = randomUUID();
      this.handles.set(id, { id, contexts: new Set([ctx]), touched: this.now(), clients: new Set() });
      return { handle: id, context_id: ctx, ws_endpoint: `ws://127.0.0.1:${run.proxyPort}/devtools/browser/${id}` };
    } finally {
      this.opening--;
      this.armIdle();
    }
  }

  async close(handle: string): Promise<void> {
    const h = this.handles.get(handle);
    if (!h) return;
    this.handles.delete(handle);
    for (const c of h.clients) try { c.close(1000, "lease released"); } catch {}
    const run = this.run;
    if (run) for (const ctx of h.contexts) await run.cdp.send("Target.disposeBrowserContext", { browserContextId: ctx }).catch(() => {});
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
   * Housekeeping, every 30 s while running: handles past the TTL, contexts nobody holds (a client
   * that went around the proxy), and pages in the default context (`browser.newPage()` on a
   * connected browser — nobody's lease, so nobody would ever close them).
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
      const { browserContextIds = [], defaultBrowserContextId } = await run.cdp.send("Target.getBrowserContexts");
      // Read AFTER the await: same CDP connection, so anything created before the list was taken has
      // already been recorded by its own (earlier) response.
      const held = new Set<string>();
      for (const h of this.handles.values()) for (const c of h.contexts) held.add(c);
      for (const id of browserContextIds as string[]) {
        if (held.has(id)) continue;
        this.log(`stray context ${id.slice(0, 8)} (no lease) — disposed`);
        await run.cdp.send("Target.disposeBrowserContext", { browserContextId: id }).catch(() => {});
      }
      const { targetInfos = [] } = await run.cdp.send("Target.getTargets");
      for (const t of targetInfos as Array<{ targetId: string; type: string; browserContextId?: string }>) {
        if (t.type === "page" && t.browserContextId && t.browserContextId === defaultBrowserContextId) {
          await run.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
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

  // ───────────── the CDP proxy ─────────────

  private listen(upstream: string): Promise<{ server: http.Server; wss: WebSocketServer; port: number }> {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_MAX });
    server.on("upgrade", (req, sock, head) => {
      const m = /^\/devtools\/browser\/([0-9a-f-]{36})$/.exec(req.url ?? "");
      const h = m ? this.handles.get(m[1]) : undefined;
      if (!h) {
        sock.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, sock, head, (client) => this.pipe(h, client, upstream));
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve({ server, wss, port: (server.address() as { port: number }).port }));
    });
  }

  /** One agent connection ↔ one upstream connection to Chrome, with the few rules that protect the others. */
  private pipe(h: Handle, client: WebSocket, upstream: string): void {
    h.clients.add(client);
    const up = new WebSocket(upstream, { perMessageDeflate: false, maxPayload: WS_MAX });
    const queue: string[] = [];
    const toUp = (s: string) => (up.readyState === WebSocket.OPEN ? up.send(s) : queue.push(s));
    const reply = (msg: Record<string, unknown>) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); };
    up.on("open", () => { for (const s of queue.splice(0)) up.send(s); });
    up.on("message", (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); });
    const end = () => {
      h.clients.delete(client);
      try { client.close(); } catch {}
      try { up.close(); } catch {}
    };
    up.on("close", end);
    up.on("error", end);
    client.on("close", end);
    client.on("error", end);
    client.on("message", (data) => {
      const s = String(data);
      // Cheap pre-check: only the few methods that matter are ever parsed.
      if (!s.includes("Browser.") && !s.includes("BrowserContext")) return toUp(s);
      let m: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try { m = JSON.parse(s); } catch { return toUp(s); }
      const base = { id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}) };
      switch (m.method) {
        // puppeteer's `browser.close()` on a connected browser: would kill every lease's pages.
        case "Browser.close":
        case "Browser.crash":
        case "Browser.crashGpuProcess":
          reply({ ...base, result: {} });
          setTimeout(end, 50).unref?.();
          return;
        case "Target.createBrowserContext":
          if (h.contexts.size >= MAX_CONTEXTS_PER_HANDLE + 1) {
            return reply({ ...base, error: { code: -32000, message: `a Chronos browser lease holds at most ${MAX_CONTEXTS_PER_HANDLE + 1} contexts` } });
          }
          // Created by the daemon, so it is adopted by this lease before the client ever sees its id.
          if (!this.run) return reply({ ...base, error: { code: -32000, message: "browser is not running" } });
          this.adopting++;
          void this.run.cdp
            .send("Target.createBrowserContext", { ...(m.params ?? {}), disposeOnDetach: false })
            .then((r) => {
              if (!this.handles.has(h.id)) {
                void this.run?.cdp.send("Target.disposeBrowserContext", { browserContextId: r.browserContextId }).catch(() => {});
                return;
              }
              h.contexts.add(String(r.browserContextId));
              reply({ ...base, result: r });
            })
            .catch((e) => reply({ ...base, error: { code: -32000, message: String(e?.message ?? e) } }))
            .finally(() => { this.adopting--; });
          return;
        case "Target.disposeBrowserContext": {
          const ctx = String(m.params?.browserContextId ?? "");
          if (!h.contexts.has(ctx)) return reply({ ...base, error: { code: -32000, message: "not a context of this Chronos browser lease" } });
          h.contexts.delete(ctx);
          return toUp(s);
        }
        default:
          return toUp(s);
      }
    });
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
export type BrowserRpc = { op: "open" } | { op: "close"; handle: string } | { op: "touch"; handle: string } | { op: "status" };

export async function handleBrowserRpc(engine: BrowserEngine, args: unknown): Promise<Record<string, unknown>> {
  const a = (args ?? {}) as { op?: string; handle?: unknown };
  const handle = typeof a.handle === "string" ? a.handle : "";
  switch (a.op) {
    case "open": return { ...(await engine.open()), status: engine.status() };
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

  async open(): Promise<Opened> {
    const r = this.note(await this.rpc({ op: "open" }));
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
