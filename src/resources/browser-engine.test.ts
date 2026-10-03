/**
 * The shared browser's engine (browser-engine.ts) with Chrome replaced by a fake CDP peer: a loopback
 * WebSocket server that answers the handful of Target/Browser methods the engine and its proxy use.
 * The launcher seam hands it out instead of spawning anything, so these tests never start a browser
 * (browser-engine.integration.test.ts does, once, when one is installed).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import {
  ChromeEngine, RemoteBrowserEngine, browserConfigFromEnv, chromeArgs, defaultMaxContexts, findEngine, handleBrowserRpc, isForbidden,
  type BrowserConfig, type Launcher,
} from "./browser-engine.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-browser-engine-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake Chrome: contexts, pages, and a record of every method any client sent. */
async function fakeChrome() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  const st = { contexts: new Set<string>(), pages: [] as Array<{ targetId: string; browserContextId: string }>, methods: [] as string[], n: 0, closedBrowser: false };
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      st.methods.push(m.method);
      const ok = (result: unknown = {}) => ws.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case "Target.createBrowserContext": { const id = `CTX${++st.n}`; st.contexts.add(id); return ok({ browserContextId: id }); }
        case "Target.disposeBrowserContext": st.contexts.delete(m.params.browserContextId); st.pages = st.pages.filter((p) => p.browserContextId !== m.params.browserContextId); return ok();
        case "Target.getBrowserContexts": return ok({ browserContextIds: [...st.contexts], defaultBrowserContextId: "DEFAULT" });
        case "Target.createTarget": { const t = { targetId: `T${++st.n}`, browserContextId: m.params.browserContextId ?? "DEFAULT" }; st.pages.push(t); return ok({ targetId: t.targetId }); }
        case "Target.getTargets": return ok({ targetInfos: st.pages.map((p) => ({ ...p, type: "page" })) });
        case "Target.closeTarget": st.pages = st.pages.filter((p) => p.targetId !== m.params.targetId); return ok({ success: true });
        case "Browser.close": st.closedBrowser = true; return ok();
        default: return ok();
      }
    });
  });
  let launches = 0;
  const launcher: Launcher = async (_found, dir) => {
    launches++;
    assert.ok(dir.startsWith(path.join(tmp)), "the profile lives under the data dir");
    let exitedResolve!: () => void;
    const exited = new Promise<void>((r) => (exitedResolve = r));
    return { pid: 4242, wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/fake`, kill: () => { for (const c of wss.clients) c.terminate(); exitedResolve(); }, exited };
  };
  return { st, launcher, launches: () => launches, close: () => wss.close() };
}

const cfg = (over: Partial<BrowserConfig> = {}): BrowserConfig => ({ enabled: true, path: null, idleMs: 60_000, maxContexts: 4, maxPerWorkspace: 2, autoInstall: false, ...over });
const found = () => ({ found: { kind: "chrome-headless-shell" as const, path: "/fake/chrome-headless-shell", version: "153.0.1" }, error: null });

/** A raw CDP client, the way puppeteer/playwright would talk to the endpoint a lease returns. */
async function client(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(String(d)); pending.get(m.id)?.(m); pending.delete(m.id); });
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  return {
    send: (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
    closed,
    ws,
  };
}

test("open starts the browser once, hands out a proxy endpoint per lease, close disposes the context", async () => {
  const chrome = await fakeChrome();
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, "a"), find: found, launch: chrome.launcher, log: () => {} });
  const [a, b] = await Promise.all([eng.open(), eng.open()]);
  assert.equal(chrome.launches(), 1, "two concurrent opens share one launch");
  assert.notEqual(a.context_id, b.context_id);
  assert.match(a.ws_endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36}$/);
  assert.doesNotMatch(a.ws_endpoint, /\/fake$/, "never Chrome's own endpoint");
  assert.equal(eng.status().running, true);
  assert.equal(eng.status().handles, 2);
  await eng.close(a.handle);
  assert.equal(chrome.st.contexts.has(a.context_id), false);
  assert.equal(chrome.st.contexts.has(b.context_id), true);
  assert.equal(await eng.touch(a.handle), false);
  assert.equal(await eng.touch(b.handle), true);
  await eng.stop("test");
  assert.equal(eng.status().running, false);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "a")), [], "the throwaway profile is removed");
  chrome.close();
});

test("the proxy: Browser.close only disconnects that client, foreign contexts are off limits, new contexts are adopted", async () => {
  const chrome = await fakeChrome();
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, "b"), find: found, launch: chrome.launcher, log: () => {} });
  const mine = await eng.open();
  const theirs = await eng.open();
  const c = await client(mine.ws_endpoint);
  // Ordinary traffic passes through.
  const page = await c.send("Target.createTarget", { url: "about:blank", browserContextId: mine.context_id });
  assert.ok(page.result.targetId);
  // Another lease's context cannot be disposed through my endpoint.
  const denied = await c.send("Target.disposeBrowserContext", { browserContextId: theirs.context_id });
  assert.match(denied.error.message, /not a context of this Chronos browser lease/);
  assert.equal(chrome.st.contexts.has(theirs.context_id), true);
  // `browser.newContext()` is adopted by my lease and dies with it.
  const extra = await c.send("Target.createBrowserContext", {});
  const extraId = extra.result.browserContextId;
  assert.ok(chrome.st.contexts.has(extraId));
  // puppeteer's `browser.close()`: answered, the client is dropped, the browser lives on.
  const bye = await c.send("Browser.close");
  assert.deepEqual(bye.result, {});
  await c.closed;
  assert.equal(chrome.st.closedBrowser, false);
  assert.equal(eng.status().running, true);
  await eng.close(mine.handle);
  assert.equal(chrome.st.contexts.has(mine.context_id), false);
  assert.equal(chrome.st.contexts.has(extraId), false, "the adopted context went with the lease");
  assert.equal(chrome.st.contexts.has(theirs.context_id), true);
  // An unknown handle is a 404 at the door.
  await assert.rejects(client(mine.ws_endpoint));
  await eng.stop();
  chrome.close();
});

test("the sweep disposes contexts and default-context pages nobody holds, and handles past the TTL", async () => {
  const chrome = await fakeChrome();
  let now = 1_000_000;
  const lost: string[] = [];
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, "c"), find: found, launch: chrome.launcher, now: () => now, ttlMs: 180_000, log: () => {} });
  eng.onLost((h) => lost.push(...h));
  const held = await eng.open();
  const stale = await eng.open();
  // A context created around the proxy, and a page opened in the default context.
  chrome.st.contexts.add("STRAY");
  chrome.st.pages.push({ targetId: "TDEF", browserContextId: "DEFAULT" });
  chrome.st.pages.push({ targetId: "TMINE", browserContextId: held.context_id });
  now += 100_000;
  await eng.touch(held.handle);
  now += 100_000;
  await eng.sweep();
  assert.equal(chrome.st.contexts.has("STRAY"), false);
  assert.deepEqual(chrome.st.pages.map((p) => p.targetId), ["TMINE"], "the default-context page is closed, the leased one stays");
  assert.equal(chrome.st.contexts.has(stale.context_id), false, "untouched past the TTL: disposed");
  assert.deepEqual(lost, [stale.handle], "…and reported lost so the pool drops it");
  assert.equal(chrome.st.contexts.has(held.context_id), true);
  await eng.stop();
  chrome.close();
});

test("idle: the browser stops idleMs after its last lease, and a new lease starts it again", async () => {
  const chrome = await fakeChrome();
  const eng = new ChromeEngine({ cfg: cfg({ idleMs: 1000 }), dataDir: path.join(tmp, "d"), find: found, launch: chrome.launcher, log: () => {} });
  const a = await eng.open();
  assert.equal(eng.status().idle_stops_at, null, "a lease is held: no idle stop");
  await eng.close(a.handle);
  assert.ok(eng.status().idle_stops_at! > Date.now());
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(eng.status().running, false);
  const b = await eng.open();
  assert.equal(chrome.launches(), 2);
  assert.equal(eng.status().running, true);
  await eng.close(b.handle);
  await eng.stop();
  chrome.close();
});

test("a browser that dies takes its leases with it, reported to the pool", async () => {
  const chrome = await fakeChrome();
  const eng = new ChromeEngine({ cfg: cfg(), dataDir: path.join(tmp, "e"), find: found, launch: chrome.launcher, log: () => {} });
  const lost: string[] = [];
  eng.onLost((h) => lost.push(...h));
  const a = await eng.open();
  // The fake "process" dies: its sockets drop and `exited` resolves.
  (eng as any).run.proc.kill();
  await new Promise((r) => setTimeout(r, 50));
  chrome.close();
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
  const explicit = findEngine({ ...deps, explicit: "/opt/x/chrome-headless-shell", isFile: () => true });
  assert.equal(explicit.found?.kind, "chrome-headless-shell");
});

test("launch flags: loopback, a free port, its own profile; full Chrome gets --headless", () => {
  const shell = chromeArgs({ kind: "chrome-headless-shell", path: "/x", version: null }, "/d/profile-1");
  assert.ok(shell.includes("--remote-debugging-port=0"));
  assert.ok(shell.includes("--remote-debugging-address=127.0.0.1"));
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

test("hosts: the rpc handler and the brain's remote engine speak the same ops", async () => {
  const chrome = await fakeChrome();
  const hostEngine = new ChromeEngine({ cfg: cfg({ maxContexts: 6, maxPerWorkspace: 3 }), dataDir: path.join(tmp, "h"), find: found, launch: chrome.launcher, log: () => {} });
  const lost: string[] = [];
  const remote = new RemoteBrowserEngine((args) => handleBrowserRpc(hostEngine, JSON.parse(JSON.stringify(args))));
  remote.onLost((h) => lost.push(...h));
  await remote.refresh();
  assert.deepEqual([remote.status().cap, remote.status().per_ws], [6, 3], "the host's own caps reach the brain");
  const o = await remote.open();
  assert.equal(remote.status().running, true);
  assert.equal(await remote.touch(o.handle), true);
  await remote.close(o.handle);
  assert.equal(chrome.st.contexts.has(o.context_id), false);
  assert.equal(await remote.touch(o.handle), false, "the host no longer knows it");
  assert.deepEqual(lost, [o.handle]);
  await assert.rejects(handleBrowserRpc(hostEngine, { op: "nope" }), /unknown browser op/);
  // A link that is down is not proof the context is gone.
  const down = new RemoteBrowserEngine(async () => { throw new Error("host h is offline"); });
  assert.equal(await down.touch("x"), true);
  await hostEngine.stop();
  chrome.close();
});
