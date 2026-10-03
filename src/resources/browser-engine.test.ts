/**
 * The shared browser's engine (browser-engine.ts) with Chrome replaced by a fake CDP peer behind the
 * launcher seam: an in-process "pipe" that answers the Target/Browser methods the engine and the
 * lease proxy use, with flat sessions, discovery and auto-attach. The proxy, the policy and the
 * daemon's mux are the real code; only Chrome is fake. browser-engine.integration.test.ts runs the
 * real engine once.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  ChromeEngine, RemoteBrowserEngine, browserConfigFromEnv, chromeArgs, defaultMaxContexts, findEngine, handleBrowserRpc, isForbidden, policy,
  type BrowserConfig, type CdpTransport, type Launcher, type LeaseView,
} from "./browser-engine.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-browser-engine-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Sess = { kind: "browser" | "target"; targetId?: string; discover?: boolean; autoAttach?: { wait: boolean } };

/** A fake Chrome on a fake pipe. Root session = "" (the daemon's). */
function fakeChrome() {
  const st = {
    contexts: new Set<string>(),
    targets: new Map<string, { ctx: string; url: string }>(),
    sessions: new Map<string, Sess>([["", { kind: "browser" }]]),
    calls: [] as Array<{ method: string; sessionId?: string; params: any }>,
    resumed: [] as string[],
    n: 0,
  };
  let launches = 0;
  const launcher: Launcher = async (_found, dir) => {
    launches++;
    assert.ok(dir.startsWith(tmp), "the profile lives under the data dir");
    let toDaemon: ((s: string) => void) | null = null;
    const closeLs: Array<() => void> = [];
    let closed = false;
    const emit = (m: any) => setImmediate(() => { if (!closed) toDaemon?.(JSON.stringify(m)); });
    const info = (id: string) => ({ targetId: id, type: "page", url: st.targets.get(id)!.url, title: "", attached: false, browserContextId: st.targets.get(id)!.ctx });
    const toBrowserSessions = (fn: (sid: string, s: Sess) => void) => { for (const [sid, s] of st.sessions) if (s.kind === "browser") fn(sid, s); };
    const created = (id: string) =>
      toBrowserSessions((sid, s) => {
        if (s.discover) emit({ method: "Target.targetCreated", params: { targetInfo: info(id) }, ...(sid ? { sessionId: sid } : {}) });
        if (s.autoAttach) {
          const child = `S${++st.n}`;
          st.sessions.set(child, { kind: "target", targetId: id });
          emit({ method: "Target.attachedToTarget", params: { sessionId: child, targetInfo: info(id), waitingForDebugger: s.autoAttach.wait }, ...(sid ? { sessionId: sid } : {}) });
        }
      });
    const handle = (m: any) => {
      st.calls.push({ method: m.method, sessionId: m.sessionId, params: m.params });
      const sid = m.sessionId ?? "";
      const s = st.sessions.get(sid);
      const ok = (result: any = {}) => emit({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      const err = (message: string) => emit({ id: m.id, error: { code: -32000, message }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      if (!s) return err("No session with given id");
      const p = m.params ?? {};
      switch (m.method) {
        case "Browser.getVersion": return ok({ product: "FakeChrome/1" });
        case "Target.attachToBrowserTarget": { const b = `B${++st.n}`; st.sessions.set(b, { kind: "browser" }); return ok({ sessionId: b }); }
        case "Target.createBrowserContext": { const c = `CTX${++st.n}`; st.contexts.add(c); return ok({ browserContextId: c }); }
        case "Target.disposeBrowserContext":
          st.contexts.delete(p.browserContextId);
          for (const [t, v] of st.targets) if (v.ctx === p.browserContextId) st.targets.delete(t);
          return ok();
        case "Target.getBrowserContexts": return ok({ browserContextIds: [...st.contexts], defaultBrowserContextId: "DEFAULT" });
        case "Target.createTarget": {
          const t = `T${++st.n}`;
          st.targets.set(t, { ctx: p.browserContextId ?? "DEFAULT", url: p.url ?? "about:blank" });
          ok({ targetId: t });
          return created(t);
        }
        case "Target.getTargets": return ok({ targetInfos: [...st.targets.keys()].map(info) });
        case "Target.setDiscoverTargets":
          s.discover = !!p.discover;
          ok();
          if (s.discover) for (const t of st.targets.keys()) emit({ method: "Target.targetCreated", params: { targetInfo: info(t) }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
          return;
        case "Target.setAutoAttach": s.autoAttach = p.autoAttach ? { wait: !!p.waitForDebuggerOnStart } : undefined; return ok();
        case "Target.attachToTarget": {
          if (!st.targets.has(p.targetId)) return err("No target with given id");
          const child = `S${++st.n}`;
          st.sessions.set(child, { kind: "target", targetId: p.targetId });
          return ok({ sessionId: child });
        }
        case "Target.detachFromTarget": st.sessions.delete(p.sessionId); return ok();
        case "Target.closeTarget": st.targets.delete(p.targetId); return ok({ success: true });
        case "Target.activateTarget": return ok();
        case "Runtime.runIfWaitingForDebugger": st.resumed.push(s.targetId!); return ok();
        case "Runtime.evaluate": return ok({ result: { type: "string", value: s.targetId } });
        default: return ok();
      }
    };
    let exitedResolve!: () => void;
    const exited = new Promise<void>((r) => (exitedResolve = r));
    const transport: CdpTransport = {
      send: (raw) => handle(JSON.parse(raw)),
      onMessage: (cb) => { toDaemon = cb; },
      onClose: (cb) => closeLs.push(cb),
      close: () => { if (!closed) { closed = true; for (const cb of closeLs) cb(); } },
    };
    return { pid: 4242, transport, kill: () => { transport.close(); exitedResolve(); }, exited };
  };
  return { st, launcher, launches: () => launches };
}

const cfg = (over: Partial<BrowserConfig> = {}): BrowserConfig => ({ enabled: true, path: null, idleMs: 60_000, maxContexts: 4, maxPerWorkspace: 2, autoInstall: false, ...over });
const found = () => ({ found: { kind: "chrome-headless-shell" as const, path: "/fake/chrome-headless-shell", version: "153.0.1" }, error: null });
const engine = (dir: string, over: Partial<ConstructorParameters<typeof ChromeEngine>[0]> = {}) => {
  const chrome = fakeChrome();
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, dir), find: found, launch: chrome.launcher, log: () => {}, ...over });
  return { chrome, eng };
};

/** A CDP client the way puppeteer/playwright talk to the endpoint a lease returns. */
async function client(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const events: any[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.id != null) { pending.get(m.id)?.(m); pending.delete(m.id); } else events.push(m);
  });
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  return {
    send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    events,
    closed,
    ws,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const errOf = (m: any) => m.error?.message ?? "";

test("open starts the browser once over the pipe, hands out a secret proxy endpoint per lease, close disposes the context", async () => {
  const { chrome, eng } = engine("a");
  const [a, b] = await Promise.all([eng.open(), eng.open()]);
  assert.equal(chrome.launches(), 1, "two concurrent opens share one launch");
  assert.notEqual(a.context_id, b.context_id);
  assert.match(a.ws_endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9_-]{43}$/, "256-bit base64url secret");
  assert.ok(!a.ws_endpoint.includes(a.handle), "the internal handle id is not the credential");
  assert.equal((fs.statSync(path.join(tmp, "a")).mode & 0o777), 0o700);
  const prof = fs.readdirSync(path.join(tmp, "a")).find((n) => n.startsWith("profile-"))!;
  assert.equal((fs.statSync(path.join(tmp, "a", prof)).mode & 0o777), 0o700, "the profile is the daemon user's only");
  assert.ok(chrome.st.calls.some((c) => c.method === "Target.setDiscoverTargets" && !c.sessionId), "the daemon keeps its own target registry");
  await eng.close(a.handle);
  assert.equal(chrome.st.contexts.has(a.context_id), false);
  assert.equal(chrome.st.contexts.has(b.context_id), true);
  assert.equal(await eng.touch(a.handle), false);
  assert.equal(await eng.touch(b.handle), true);
  await eng.stop("test");
  assert.equal(eng.status().running, false);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "a")), [], "the throwaway profile is removed");
});

test("isolation: lease A cannot list, attach to, activate or close lease B's page, nor create in B's or the default context", async () => {
  const { eng } = engine("iso");
  const A = await eng.open(), B = await eng.open();
  const a = await client(A.ws_endpoint), b = await client(B.ws_endpoint);
  const bPage = (await b.send("Target.createTarget", { url: "about:blank", browserContextId: B.context_id })).result.targetId;
  const aPage = (await a.send("Target.createTarget", { url: "https://example.com/", browserContextId: A.context_id })).result.targetId;
  assert.ok(aPage && bPage);
  const listed = (await a.send("Target.getTargets")).result.targetInfos.map((t: any) => t.targetId);
  assert.deepEqual(listed, [aPage], "A sees only its own page");
  assert.match(errOf(await a.send("Target.attachToTarget", { targetId: bPage, flatten: true })), /not a target of this Chronos browser lease/);
  assert.match(errOf(await a.send("Target.closeTarget", { targetId: bPage })), /not a target of this Chronos browser lease/);
  assert.match(errOf(await a.send("Target.activateTarget", { targetId: bPage })), /not a target of this Chronos browser lease/);
  assert.match(errOf(await a.send("Target.getTargetInfo", { targetId: bPage })), /not a target/);
  assert.match(errOf(await a.send("Target.createTarget", { url: "about:blank", browserContextId: B.context_id })), /needs one of this lease's browserContextIds/);
  assert.match(errOf(await a.send("Target.createTarget", { url: "about:blank" })), /needs one of this lease's browserContextIds/, "no default-context pages");
  assert.deepEqual((await a.send("Target.getBrowserContexts")).result, { browserContextIds: [A.context_id] });
  assert.match(errOf(await a.send("Target.disposeBrowserContext", { browserContextId: B.context_id })), /not a browser context of this Chronos browser lease/);
  // A's own page works end to end on a flat session.
  const sess = (await a.send("Target.attachToTarget", { targetId: aPage, flatten: true })).result.sessionId;
  assert.equal((await a.send("Runtime.evaluate", { expression: "1" }, sess)).result.result.value, aPage);
  // B's session is not A's to speak on, nor is a made-up one.
  const bSess = (await b.send("Target.attachToTarget", { targetId: bPage, flatten: true })).result.sessionId;
  assert.match(errOf(await a.send("Runtime.evaluate", { expression: "1" }, bSess)), /not a session of this Chronos browser lease/);
  assert.match(errOf(await a.send("Runtime.evaluate", { expression: "1" }, "S999")), /not a session/);
  a.ws.close(); b.ws.close();
  await eng.stop();
});

test("isolation: discovery and auto-attach show a lease only its own targets — and never stall another's", async () => {
  const { chrome, eng } = engine("disc");
  const A = await eng.open(), B = await eng.open();
  const a = await client(A.ws_endpoint), b = await client(B.ws_endpoint);
  const bOld = (await b.send("Target.createTarget", { url: "about:blank", browserContextId: B.context_id })).result.targetId;
  await a.send("Target.setDiscoverTargets", { discover: true });
  await a.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await settle();
  const bNew = (await b.send("Target.createTarget", { url: "about:blank", browserContextId: B.context_id })).result.targetId;
  const aNew = (await a.send("Target.createTarget", { url: "about:blank", browserContextId: A.context_id })).result.targetId;
  await settle();
  const seen = JSON.stringify(a.events);
  assert.ok(!seen.includes(bOld) && !seen.includes(bNew), "no event about B's pages reaches A");
  assert.ok(a.events.some((e) => e.method === "Target.targetCreated" && e.params.targetInfo.targetId === aNew));
  const att = a.events.find((e) => e.method === "Target.attachedToTarget");
  assert.equal(att?.params.targetInfo.targetId, aNew, "A is auto-attached to its own page");
  assert.equal(att.sessionId, undefined, "browser-session events reach the client as root events");
  // A's auto-attach also caught B's new page (one browser): the proxy let it run and let go of it.
  assert.ok(chrome.st.resumed.includes(bNew), "B's page is not left waiting on A's debugger");
  const aSessions = [...chrome.st.sessions.entries()].filter(([, s]) => s.targetId === bNew);
  assert.equal(aSessions.length, 0, "A's session on B's page was detached");
  // A's own auto-attached session is usable.
  assert.equal((await a.send("Runtime.evaluate", { expression: "1" }, att.params.sessionId)).result.result.value, aNew);
  a.ws.close(); b.ws.close();
  await eng.stop();
});

test("browser-wide domains are allow-listed: getVersion yes; SystemInfo, Tracing, Memory, exposeDevToolsProtocol, other Browser.* no", async () => {
  const { chrome, eng } = engine("dom");
  const A = await eng.open();
  const a = await client(A.ws_endpoint);
  assert.equal((await a.send("Browser.getVersion")).result.product, "FakeChrome/1");
  for (const [m, p] of [
    ["SystemInfo.getInfo", {}], ["Tracing.start", {}], ["Memory.getDOMCounters", {}], ["Browser.getBrowserCommandLine", {}],
    ["Browser.getWindowForTarget", {}], ["Target.exposeDevToolsProtocol", { targetId: "x" }], ["Target.attachToBrowserTarget", {}],
    ["Storage.getCookies", {}], ["Storage.clearDataForOrigin", { origin: "https://x" }], ["Runtime.evaluate", { expression: "1" }],
    ["Target.createBrowserContext", { proxyServer: "http://evil:1" }],
  ] as const) {
    const r = await a.send(m, p);
    assert.match(errOf(r), /not available|needs one of this lease's|not a browser context|may not set a context proxy/, `${m} must be refused`);
  }
  assert.ok(!chrome.st.calls.some((c) => ["SystemInfo.getInfo", "Tracing.start", "Browser.getBrowserCommandLine"].includes(c.method)), "never reached Chrome");
  assert.deepEqual((await a.send("Storage.getCookies", { browserContextId: A.context_id })).result, {}, "its own context's cookies are fine");
  a.ws.close();
  await eng.stop();
});

test("no reach into the daemon's disk: file: URLs, uploads by path, downloads, loadNetworkResource", async () => {
  const { chrome, eng } = engine("disk");
  const A = await eng.open();
  const a = await client(A.ws_endpoint);
  assert.match(errOf(await a.send("Target.createTarget", { url: "file:///etc/hosts", browserContextId: A.context_id })), /only http\(s\)/);
  const page = (await a.send("Target.createTarget", { url: "about:blank", browserContextId: A.context_id })).result.targetId;
  const s = (await a.send("Target.attachToTarget", { targetId: page, flatten: true })).result.sessionId;
  assert.match(errOf(await a.send("Page.navigate", { url: "file:///Users/x/.admin-token" }, s)), /only http\(s\)/);
  assert.match(errOf(await a.send("Page.navigate", { url: "chrome://settings" }, s)), /only http\(s\)/);
  assert.ok(!errOf(await a.send("Page.navigate", { url: "https://example.com/" }, s)), "the web is fine");
  for (const m of ["DOM.setFileInputFiles", "Network.loadNetworkResource", "Page.setDownloadBehavior"]) {
    assert.match(errOf(await a.send(m, { files: ["/etc/hosts"], url: "file:///etc/hosts", behavior: "allow", downloadPath: "/tmp" }, s)), /not available/, m);
  }
  assert.match(errOf(await a.send("Input.dispatchDragEvent", { type: "drop", x: 1, y: 1, data: { items: [], files: ["/etc/hosts"], dragOperationsMask: 1 } }, s)), /local files/);
  // Playwright's per-context download call succeeds, but downloads are always denied.
  await a.send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId: A.context_id, downloadPath: "/Users/x" });
  const dl = chrome.st.calls.find((c) => c.method === "Browser.setDownloadBehavior")!;
  assert.deepEqual(dl.params, { behavior: "deny", browserContextId: A.context_id });
  a.ws.close();
  await eng.stop();
});

test("a forged, wrong-length or released handle is rejected at the door", async () => {
  const { eng } = engine("door");
  const A = await eng.open();
  const base = A.ws_endpoint.replace(/[^/]+$/, "");
  await assert.rejects(client(base + randomBytes(32).toString("base64url")), /404/);
  await assert.rejects(client(base + randomBytes(16).toString("base64url")), /404/);
  await assert.rejects(client(base + A.handle), /404/, "the internal handle id is not a key");
  const ok = await client(A.ws_endpoint);
  await eng.close(A.handle);
  await ok.closed;
  await assert.rejects(client(A.ws_endpoint), /404/, "a released lease's secret is dead");
  await eng.stop();
});

test("Browser.close only disconnects that client; contexts it creates are adopted and die with the lease", async () => {
  const { chrome, eng } = engine("b");
  const mine = await eng.open(), theirs = await eng.open();
  const c = await client(mine.ws_endpoint);
  const extraId = (await c.send("Target.createBrowserContext", {})).result.browserContextId;
  assert.ok(chrome.st.contexts.has(extraId));
  assert.ok(!errOf(await c.send("Target.createTarget", { url: "about:blank", browserContextId: extraId })), "its own new context is usable");
  assert.deepEqual((await c.send("Browser.close")).result, {});
  await c.closed;
  assert.equal(eng.status().running, true);
  assert.ok(!chrome.st.calls.some((x) => x.method === "Browser.close"), "never reached Chrome");
  await eng.close(mine.handle);
  assert.equal(chrome.st.contexts.has(mine.context_id), false);
  assert.equal(chrome.st.contexts.has(extraId), false, "the adopted context went with the lease");
  assert.equal(chrome.st.contexts.has(theirs.context_id), true);
  await eng.stop();
});

test("egress: a lease's contexts — given and adopted — go through its workspace's proxy", async () => {
  const seen: any[] = [];
  const { chrome, eng } = engine("egress", { proxyFor: (o) => { seen.push(o); return o.workspace_id === "ws-locked" ? "http://127.0.0.1:41000" : null; } });
  const L = await eng.open({ workspace_id: "ws-locked" });
  const F = await eng.open({ workspace_id: "ws-free" });
  const creates = chrome.st.calls.filter((c) => c.method === "Target.createBrowserContext");
  assert.equal(creates[0].params.proxyServer, "http://127.0.0.1:41000");
  assert.equal(creates[1].params.proxyServer, undefined);
  const c = await client(L.ws_endpoint);
  await c.send("Target.createBrowserContext", {});
  assert.equal(chrome.st.calls.filter((x) => x.method === "Target.createBrowserContext")[2].params.proxyServer, "http://127.0.0.1:41000");
  assert.deepEqual(seen.map((o) => o.workspace_id), ["ws-locked", "ws-free"]);
  void F;
  c.ws.close();
  await eng.stop();
});

test("the sweep disposes contexts and default-context pages nobody holds, and handles past the TTL", async () => {
  let now = 1_000_000;
  const lost: string[] = [];
  const { chrome, eng } = engine("c", { now: () => now, ttlMs: 180_000 });
  eng.onLost((h) => lost.push(...h));
  const held = await eng.open();
  const stale = await eng.open();
  chrome.st.contexts.add("STRAY");
  chrome.st.targets.set("TDEF", { ctx: "DEFAULT", url: "about:blank" });
  chrome.st.targets.set("TMINE", { ctx: held.context_id, url: "about:blank" });
  now += 100_000;
  await eng.touch(held.handle);
  now += 100_000;
  await eng.sweep();
  assert.equal(chrome.st.contexts.has("STRAY"), false);
  assert.deepEqual([...chrome.st.targets.keys()], ["TMINE"], "the default-context page is closed, the leased one stays");
  assert.equal(chrome.st.contexts.has(stale.context_id), false, "untouched past the TTL: disposed");
  assert.deepEqual(lost, [stale.handle], "…and reported lost so the pool drops it");
  await eng.stop();
});

test("idle: the browser stops idleMs after its last lease, and a new lease starts it again", async () => {
  const { chrome, eng } = engine("d", { cfg: cfg({ idleMs: 1000 }) });
  const a = await eng.open();
  assert.equal(eng.status().idle_stops_at, null, "a lease is held: no idle stop");
  await eng.close(a.handle);
  assert.ok(eng.status().idle_stops_at! > Date.now());
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(eng.status().running, false);
  const b = await eng.open();
  assert.equal(chrome.launches(), 2);
  await eng.close(b.handle);
  await eng.stop();
});

test("a browser that dies takes its leases with it, reported to the pool", async () => {
  const { eng } = engine("e");
  const lost: string[] = [];
  eng.onLost((h) => lost.push(...h));
  const a = await eng.open();
  (eng as any).run.proc.kill();
  await settle();
  assert.deepEqual(lost, [a.handle]);
  assert.equal(eng.status().running, false);
});

test("no engine installed: open fails with the install line, and a disabled engine refuses", async () => {
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, "f"), find: () => ({ found: null, error: "no headless browser installed on this machine — install one: npx x" }), log: () => {} });
  await assert.rejects(eng.open(), /no headless browser installed/);
  assert.match(eng.status().error ?? "", /install one/);
  const off = new ChromeEngine({ cfg: cfg({ enabled: false }), dataDir: path.join(tmp, "g"), find: found, log: () => {} });
  await assert.rejects(off.open(), /CHRONOS_BROWSER=off/);
});

test("policy: per-method allow-list, default deny", () => {
  const v: LeaseView = { ownCtx: (c) => c === "MINE", ownTarget: (t) => t === "TM", ownSession: (s) => s === "SM" };
  const ok = (m: string, p: any = {}, child = true) => "pass" in policy(m, p, child, v);
  assert.ok(ok("Page.navigate", { url: "https://x" }));
  assert.ok(ok("Runtime.evaluate"));
  assert.ok(!ok("Runtime.evaluate", {}, false), "page domains only on a page's session");
  assert.ok(!ok("Some.unknownMethod"));
  assert.ok(!ok("Memory.getDOMCounters"));
  assert.ok(!ok("Target.sendMessageToTarget", { targetId: "TM" }, false));
  assert.ok(!ok("Target.setRemoteLocations", {}, false));
  assert.ok(ok("Target.attachToTarget", { targetId: "TM" }, false));
  assert.ok(!ok("Target.attachToTarget", { targetId: "TB" }, false));
  assert.ok(ok("Storage.clearDataForOrigin", { origin: "https://x" }, true), "a page's own storage, on its session");
  assert.ok(!ok("Storage.clearDataForOrigin", { origin: "https://x", browserContextId: "OTHER" }, true));
  assert.ok(ok("Target.detachFromTarget", { sessionId: "SM" }, false));
  assert.ok(!ok("Target.detachFromTarget", { sessionId: "SB" }, false));
});

test("discovery: newest headless shell first, then Chrome for Testing — never the operator's Chrome", () => {
  const files = new Set([
    "/h/.cache/puppeteer/chrome-headless-shell/mac_arm-127.0.6533.88/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "/h/.cache/puppeteer/chrome-headless-shell/mac_arm-153.0.8010.36/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "/h/.cache/puppeteer/chrome-headless-shell/mac_arm-138.0.7204.92/chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "/h/.cache/puppeteer/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ]);
  const list = (dir: string) => {
    const kids = new Set<string>();
    for (const f of files) if (f.startsWith(dir + "/")) kids.add(f.slice(dir.length + 1).split("/")[0]);
    return [...kids];
  };
  const deps = { home: "/h", platform: "darwin" as const, cacheRoots: ["/h/.cache/puppeteer"], isFile: (p: string) => files.has(p), list };
  const d = findEngine(deps);
  assert.equal(d.found?.kind, "chrome-headless-shell");
  assert.equal(d.found?.version, "153.0.8010.36");
  for (const f of [...files]) if (f.includes("headless-shell")) files.delete(f);
  assert.equal(findEngine(deps).found?.kind, "chrome-for-testing");
  files.clear();
  const none = findEngine(deps);
  assert.equal(none.found, null);
  assert.match(none.error!, /npx @puppeteer\/browsers install chrome-headless-shell@stable/);
  const refused = findEngine({ ...deps, explicit: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", isFile: () => true });
  assert.equal(refused.found, null);
  assert.match(refused.error!, /operator's own Chrome — refused/);
  assert.equal(isForbidden("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), true);
  assert.equal(isForbidden("/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"), false);
  assert.equal(findEngine({ ...deps, explicit: "/opt/x/chrome-headless-shell", isFile: () => true }).found?.kind, "chrome-headless-shell");
});

test("launch flags: CDP over a pipe and never a port, its own profile; full Chrome gets --headless", () => {
  const shell = chromeArgs({ kind: "chrome-headless-shell", path: "/x", version: null }, "/d/profile-1");
  assert.ok(shell.includes("--remote-debugging-pipe"));
  assert.ok(!shell.some((a) => a.startsWith("--remote-debugging-port") || a.startsWith("--remote-debugging-address")));
  assert.ok(shell.includes("--user-data-dir=/d/profile-1"));
  assert.ok(!shell.some((a) => a.startsWith("--headless")));
  assert.ok(chromeArgs({ kind: "chrome-for-testing", path: "/x", version: null }, "/d").includes("--headless=new"));
});

test("config: RAM-derived cap (1 per 2 GB, 1..8), fair share half of it, knobs win", () => {
  assert.equal(defaultMaxContexts(18 * 1024 ** 3), 8);
  assert.equal(defaultMaxContexts(8 * 1024 ** 3), 4);
  assert.equal(defaultMaxContexts(1 * 1024 ** 3), 1);
  const d = browserConfigFromEnv({}, 8 * 1024 ** 3);
  assert.deepEqual([d.enabled, d.maxContexts, d.maxPerWorkspace, d.idleMs, d.autoInstall], [true, 4, 2, 600_000, false]);
  const k = browserConfigFromEnv({ CHRONOS_BROWSER: "off", CHRONOS_BROWSER_MAX_CONTEXTS: "3", CHRONOS_BROWSER_MAX_PER_WS: "1", CHRONOS_BROWSER_IDLE_MS: "5000", CHRONOS_BROWSER_PATH: "/p", CHRONOS_BROWSER_AUTO_INSTALL: "1" }, 8 * 1024 ** 3);
  assert.deepEqual([k.enabled, k.maxContexts, k.maxPerWorkspace, k.idleMs, k.path, k.autoInstall], [false, 3, 1, 5000, "/p", true]);
});

test("hosts: the rpc handler and the brain's remote engine speak the same ops, workspace and egress included", async () => {
  const asked: any[] = [];
  const { chrome, eng: hostEngine } = engine("h", { cfg: cfg({ maxContexts: 6, maxPerWorkspace: 3 }), proxyFor: (o) => { asked.push(o); return o.egress ? "http://127.0.0.1:42000" : null; } });
  const lost: string[] = [];
  // What browser-routes.ts does on the brain: the open carries the workspace's egress policy.
  const remote = new RemoteBrowserEngine((args) => handleBrowserRpc(hostEngine, JSON.parse(JSON.stringify(args.op === "open" ? { ...args, egress: { mode: "enforce", allow: [] } } : args))));
  remote.onLost((h) => lost.push(...h));
  await remote.refresh();
  assert.deepEqual([remote.status().cap, remote.status().per_ws], [6, 3], "the host's own caps reach the brain");
  const o = await remote.open({ workspace_id: "ws-a" });
  assert.equal(asked[0].workspace_id, "ws-a");
  assert.equal(chrome.st.calls.find((c) => c.method === "Target.createBrowserContext")!.params.proxyServer, "http://127.0.0.1:42000", "the host's own egress proxy");
  assert.equal(remote.status().running, true);
  assert.equal(await remote.touch(o.handle), true);
  await remote.close(o.handle);
  assert.equal(chrome.st.contexts.has(o.context_id), false);
  assert.equal(await remote.touch(o.handle), false, "the host no longer knows it");
  assert.deepEqual(lost, [o.handle]);
  await assert.rejects(handleBrowserRpc(hostEngine, { op: "nope" }), /unknown browser op/);
  const down = new RemoteBrowserEngine(async () => { throw new Error("host h is offline"); });
  assert.equal(await down.touch("x"), true, "a link that is down is not proof the context is gone");
  await hostEngine.stop();
});
