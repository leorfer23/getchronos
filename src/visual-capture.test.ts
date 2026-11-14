/**
 * The critic's eyes (src/visual-capture.ts) against a stand-in Chrome: a loopback WebSocket that speaks
 * the CDP calls the module makes, behind a real BrowserPool with a fake engine. What is asserted: the
 * lease is taken for the workspace and given back, the page is rendered at both widths in screen-sized
 * slices, what is measured is reported, a sign-in wall is reported instead of captured, and an address
 * on this Mac or its network is never opened. The real browser is in visual-capture.integration.test.ts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { BrowserPool } from "./resources/browser-pool.js";
import type { BrowserEngine } from "./resources/browser-engine.js";
import { VIEWPORTS, loginWall, partsOf, refuseAddress, renderPages, setCaptureTiming } from "./visual-capture.js";

setCaptureTiming({ settleMs: 1, resizeMs: 1 });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Page = { status: number; href: string; title: string; pw: boolean; text: string };
/** What the stand-in Chrome does per URL; HTML pages always load. */
const pages: Record<string, Page> = {
  "https://bi.example.com/d/1": { status: 200, href: "https://bi.example.com/d/1", title: "Signups", pw: false, text: "Signups up 18% since the new pricing page. ".repeat(40) },
  "https://app.hex.example/app/9": { status: 200, href: "https://app.hex.example/login?next=/app/9", title: "Log in", pw: true, text: "Log in to continue" },
  "https://bi.example.com/gone": { status: 404, href: "https://bi.example.com/gone", title: "Not found", pw: false, text: "Not found" },
};
const seen = { methods: [] as string[], html: [] as string[], urls: [] as string[], widths: [] as number[] };
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
after(() => wss.close());
wss.on("connection", (ws) => {
  let width = 1440;
  let current: Page | null = null;
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    seen.methods.push(m.method);
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    const event = (method: string, params: unknown) => ws.send(JSON.stringify({ method, params, sessionId: "S1" }));
    switch (m.method) {
      case "Target.createTarget": return reply({ targetId: "T1" });
      case "Target.attachToTarget": return reply({ sessionId: "S1" });
      case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "F1" } } });
      case "Page.setDocumentContent": seen.html.push(m.params.html); current = null; return reply({});
      case "Page.navigate": {
        seen.urls.push(m.params.url);
        current = pages[m.params.url];
        reply({ frameId: "F1" });
        event("Network.responseReceived", { type: "Document", response: { status: current?.status ?? 200 } });
        return event("Page.loadEventFired", {});
      }
      case "Runtime.evaluate": {
        const e = String(m.params.expression);
        if (e === "document.readyState") return reply({ result: { value: "complete" } });
        if (e.includes("innerText")) return reply({ result: { value: { href: current?.href, title: current?.title, pw: current?.pw, text: current?.text } } });
        if (e.includes("getBoundingClientRect")) return reply({ result: { value: 2000 } }); // where the content really ends
        return reply({ result: { value: true } });
      }
      case "Emulation.setDeviceMetricsOverride": width = m.params.width; seen.widths.push(width); return reply({});
      // 2000 px of content. On a phone it is 520 px wide — it scrolls sideways — and, as Chrome does then,
      // the reported scroll height is stretched: slicing by it would add blank screens.
      case "Page.getLayoutMetrics": return reply({ cssContentSize: { width: width < 600 ? 520 : width, height: width < 600 ? 4000 : 2000 } });
      case "Page.captureScreenshot": return reply({ data: PNG });
      default: return reply({});
    }
  });
});
const port = await new Promise<number>((r) => wss.on("listening", () => r((wss.address() as any).port)));

function poolWith(open: BrowserEngine["open"]) {
  const closed: string[] = [];
  const engine: BrowserEngine = {
    open, close: async (h) => { closed.push(h); }, touch: async () => true, onLost: () => {}, stop: async () => {},
    status: () => ({ engine: "chrome-headless-shell", version: null, path: null, pid: null, running: true, handles: 0, idle_stops_at: null, error: null }),
  };
  return { pool: new BrowserPool("local", engine, () => ({ cap: 2, perWs: 1 }), () => {}), closed };
}

test("refuseAddress: this Mac, its network and non-web schemes are never opened", () => {
  for (const u of ["http://localhost:7777/api/sessions", "http://127.0.0.1/x", "http://10.0.0.5/", "http://192.168.1.6:3000", "http://172.20.1.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://printer.local/", "file:///etc/hosts", "javascript:alert(1)", "not a url"]) {
    assert.ok(refuseAddress(u), u);
  }
  for (const u of ["https://bi.example.com/d/1", "https://app.hex.example/x", "http://172.32.0.1/"]) assert.equal(refuseAddress(u), null, u);
});

test("loginWall: a 401/403, a redirect to a sign-in page, a password field or a bare sign-in page", () => {
  const base = { requested: "https://bi.example.com/d/1", final: "https://bi.example.com/d/1", status: 200, title: "Signups", hasPassword: false, text: "x".repeat(2000) };
  assert.equal(loginWall(base), null);
  assert.match(loginWall({ ...base, status: 403 })!, /answered 403/);
  assert.match(loginWall({ ...base, final: "https://accounts.example.com/ServiceLogin?continue=x" })!, /redirected to a sign-in page \(accounts\.example\.com\)/);
  assert.match(loginWall({ ...base, final: "https://bi.example.com/login?next=/d/1" })!, /redirected to a sign-in page/);
  assert.match(loginWall({ ...base, hasPassword: true })!, /sign-in form/);
  assert.match(loginWall({ ...base, title: "Welcome", text: "Continue with Google" })!, /sign-in page/);
});

test("partsOf: screen-sized slices, capped, saying how much runs on below", () => {
  const [desk, phone] = VIEWPORTS;
  assert.deepEqual(partsOf(500, desk), { parts: 1, cut: 0 });
  assert.deepEqual(partsOf(2000, desk), { parts: 3, cut: 0 });
  assert.deepEqual(partsOf(5000, desk), { parts: 3, cut: 5000 - 3 * 900 });
  assert.deepEqual(partsOf(2000, phone), { parts: 3, cut: 0 });
});

test("a page and a link rendered on one lease of the workspace, at both widths, then given back", async () => {
  const { pool, closed } = poolWith(async (o) => ({ handle: `h-${o?.workspace_id}`, context_id: "C1", ws_endpoint: `ws://127.0.0.1:${port}/devtools/browser/secret` }));
  const out = await renderPages({ id: "ws-a" }, [{ html: "<h1>Signups</h1>" }, { url: "https://bi.example.com/d/1" }, { url: "https://app.hex.example/app/9" }, { url: "http://127.0.0.1:7777/api/sessions" }, { url: "https://bi.example.com/gone" }], { pool, label: "critic test" });
  assert.equal(out.length, 5);
  const [page, link, walled, local, gone] = out;
  assert.deepEqual(page.shots.map((s) => `${s.viewport}-${s.part}/${s.parts}`), ["desktop-1/3", "desktop-2/3", "desktop-3/3", "phone-1/3", "phone-2/3", "phone-3/3"]);
  assert.ok(page.shots.every((s) => s.png.subarray(1, 4).toString() === "PNG"));
  assert.match(page.notes.join(" "), /phone: the page is 520 px wide at a 390 px screen — it scrolls sideways/);
  assert.equal(link.shots.length, 6);
  assert.equal(link.blocked, null);
  assert.equal(walled.shots.length, 0);
  assert.match(walled.blocked!, /redirected to a sign-in page \(app\.hex\.example\)/);
  assert.match(local.error!, /local address|private network/);
  assert.equal(local.blocked, null, "an address never opened is the daemon's refusal, not something wrong with the page");
  assert.equal(gone.blocked, "it answered 404", "an error page is something the terminal can fix");
  assert.equal(gone.shots.length, 0);
  assert.deepEqual(seen.html, ["<h1>Signups</h1>"], "HTML goes in as document content — no data: URL, no file");
  assert.deepEqual(seen.urls, ["https://bi.example.com/d/1", "https://app.hex.example/app/9", "https://bi.example.com/gone"], "the local address was never navigated to");
  assert.ok(seen.widths.includes(1440) && seen.widths.includes(390));
  assert.ok(seen.methods.filter((m) => m === "Target.closeTarget").length >= 3, "every page it opened is closed");
  assert.deepEqual(closed, ["h-ws-a"], "the lease was the workspace's, and it was given back");
  assert.equal(pool.inUse(), 0);
});

test("only refused addresses: no lease is taken at all; a browser that cannot open a page is said, not thrown", async () => {
  let opened = 0;
  const { pool } = poolWith(async () => { opened++; throw new Error("no chrome-headless-shell installed"); });
  const refused = await renderPages({ id: "ws-a" }, [{ url: "http://localhost:3000" }], { pool, label: "t" });
  assert.match(refused[0].error!, /local address/);
  assert.equal(opened, 0);
  const broken = await renderPages({ id: "ws-a" }, [{ html: "<p>x</p>" }], { pool, label: "t" });
  assert.match(broken[0].error!, /could not open a page: no chrome-headless-shell installed/);
  assert.equal(pool.inUse(), 0);
});
