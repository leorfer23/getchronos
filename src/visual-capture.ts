/**
 * The visual critic's eyes (visual-critic.ts): a page rendered in the machine's ONE shared headless
 * browser (RESOURCES.md → Shared headless browser pool), at desktop and phone width, cut into
 * screen-sized PNGs a vision model can read (a 7000 px full-page strip shrinks to an unreadable
 * sliver).
 *
 * It borrows a lease like any `mc browser` caller — the workspace's own, through that workspace's
 * egress proxy (browser-routes.ts brainPool), released when done — and goes in through the lease's
 * CDP door, so the lease policy holds for the daemon too: no file: URLs, no downloads, only its own
 * context. Two kinds of page:
 *   - HTML the daemon already has (an `mc artifact` page, framed exactly as the Desk frames it): put
 *     into a blank page with Page.setDocumentContent — never a file path, never a data: URL (Chrome
 *     caps those at 2 MB, an artifact may be bigger).
 *   - a public http(s) link the hand-off names. A sign-in wall (a password field, a redirect to a
 *     login page, a 401/403) is reported as `blocked`, never judged: the critic works from what the
 *     agent attached instead and says so. Loopback and private addresses are never opened — a page
 *     on this Mac or its network is not a deliverable, and a browser on the brain must not be a way
 *     into it.
 */
import WebSocket from "ws";
import { browserConfig, type BrowserPool } from "./resources/browser-pool.js";
import type { Workspace } from "./types.js";

export type ViewportName = "desktop" | "phone";
export type Viewport = { name: ViewportName; width: number; height: number; mobile: boolean; scale: number; maxParts: number };
/** Desktop at a common laptop size; phone at a common handset, 2× so text stays legible to the reader. */
export const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900, mobile: false, scale: 1, maxParts: 3 },
  { name: "phone", width: 390, height: 844, mobile: true, scale: 2, maxParts: 4 },
];

export type Shot = { viewport: ViewportName; part: number; parts: number; png: Buffer };
export type Rendered = {
  shots: Shot[];
  /**
   * Why the page itself could not be seen — a sign-in wall, an error page, it did not load — or null.
   * Something the terminal can act on: fix the link, or attach what the page looks like.
   */
  blocked: string | null;
  /** Why the daemon could not render it (browser off or busy, timed out, an address never opened), or null. */
  error: string | null;
  /** What the reader should know beyond the pixels: the page runs on below the cut, it scrolls sideways on a phone. */
  notes: string[];
  final_url?: string | null;
};
export type RenderSource = { html: string } | { url: string };

// ───────────────────────────── addresses ─────────────────────────────

/**
 * Never opened: this Mac, its network, link-local and anything that is not http(s). A deliverable is a
 * page someone else can open; a loopback or private address is a door into the brain's surroundings.
 */
export function refuseAddress(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "not a valid address"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol.replace(":", "")} addresses are not opened — only http(s)`;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0") return "a local address — not a page anyone else can open";
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return "a private network address — not a page anyone else can open";
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || /^::ffff:/.test(h)) return "a private network address — not a page anyone else can open";
  return null;
}

export type LoginProbe = { requested: string; final: string; status: number | null; title: string; hasPassword: boolean; text: string };

/** Is what loaded a sign-in wall rather than the page? The reason, or null. */
export function loginWall(p: LoginProbe): string | null {
  if (p.status === 401 || p.status === 403) return `it answered ${p.status} (a login the shared browser does not have)`;
  let req: URL | null = null, fin: URL | null = null;
  try { req = new URL(p.requested); fin = new URL(p.final); } catch { /* compared as text below */ }
  const SIGNIN = /(\/|\b)(login|log-in|signin|sign-in|sign_in|sso|oauth2?|authorize|auth\/|accounts\/|servicelogin|session\/new)/i;
  const moved = req && fin ? req.host !== fin.host || req.pathname !== fin.pathname : p.requested !== p.final;
  if (moved && (SIGNIN.test(p.final) || (fin && /^(accounts|login|auth|sso|signin|id)\./i.test(fin.hostname)))) {
    return `it redirected to a sign-in page (${fin?.host ?? p.final})`;
  }
  if (p.hasPassword) return "it shows a sign-in form";
  const words = `${p.title} ${p.text}`;
  if (p.text.length < 800 && /\b(sign in|log in|login|single sign-on|continue with (google|microsoft|email))\b/i.test(words)) {
    return "it shows a sign-in page";
  }
  return null;
}

/** The screen-sized slices of a page `height` CSS px tall: how many, and whether it runs on below the last. */
export function partsOf(contentHeight: number, vp: Viewport): { parts: number; cut: number } {
  const h = Math.max(1, Math.ceil(contentHeight));
  const parts = Math.max(1, Math.min(vp.maxParts, Math.ceil(h / vp.height)));
  return { parts, cut: Math.max(0, h - parts * vp.height) };
}

// ───────────────────────────── a CDP client over the lease's door ─────────────────────────────

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners: Array<{ method: string; sessionId: string | null; fn: (params: any) => void }> = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(String(m.error.message ?? "CDP error")));
        else p.resolve(m.result ?? {});
        return;
      }
      if (m.method) for (const l of this.listeners) if (l.method === m.method && (l.sessionId === null || l.sessionId === (m.sessionId ?? null))) l.fn(m.params ?? {});
    });
    ws.on("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("the browser connection closed")); }
      this.pending.clear();
    });
  }
  static async open(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { ws.terminate(); reject(new Error("the browser did not answer")); }, timeoutMs);
      ws.once("open", () => { clearTimeout(t); resolve(); });
      ws.once("error", (e) => { clearTimeout(t); reject(e); });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method: string, sessionId: string | null, fn: (params: any) => void): () => void {
    const l = { method, sessionId, fn };
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter((x) => x !== l); };
  }
  once(method: string, sessionId: string | null, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const off = this.on(method, sessionId, (p) => { clearTimeout(t); off(); resolve(p); });
      const t = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      t.unref?.();
    });
  }
  close(): void {
    try { this.ws.close(); } catch { /* gone */ }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
/** How long a page is given to settle after it loads, and after each resize. Tests shrink them. */
const TIMING = { settleMs: 1200, resizeMs: 900 };
export function setCaptureTiming(t: Partial<typeof TIMING> | null): void {
  Object.assign(TIMING, t ?? { settleMs: 1200, resizeMs: 900 });
}

/** The probe run in the loaded page: where it ended up and whether it is a sign-in wall. */
const PROBE = `(() => { const t = ((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim();
  return { href: location.href, title: document.title || "", pw: !!document.querySelector("input[type=password]"), text: t.slice(0, 1500) }; })()`;

/** The lowest edge of anything visible on the page, in CSS px from the top (0 = could not tell). */
const CONTENT_BOTTOM = `(() => { const b = document.body; if (!b) return 0; const all = b.getElementsByTagName("*"); let h = 0;
  for (let i = 0, n = Math.min(all.length, 20000); i < n; i++) { const r = all[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.bottom > h) h = r.bottom; }
  return h > 0 ? Math.ceil(h + window.scrollY + 16) : 0; })()`;

async function evaluate(c: Cdp, sid: string, expression: string, awaitPromise = false): Promise<any> {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sid);
  return r?.result?.value;
}

/** Wait until the document says it is complete (or the time is up), then let fonts and charts settle. */
async function settle(c: Cdp, sid: string, budgetMs: number): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const st = await evaluate(c, sid, "document.readyState").catch(() => null);
    if (st === "complete") break;
    await sleep(250);
  }
  await evaluate(c, sid, "document.fonts ? document.fonts.ready.then(() => true) : true", true).catch(() => null);
  await sleep(TIMING.settleMs); // chart libraries animate in; a shot mid-animation reads as a broken chart
}

async function shoot(c: Cdp, sid: string, vp: Viewport, notes: string[]): Promise<Shot[]> {
  await c.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile }, sid);
  await sleep(TIMING.resizeMs); // re-layout, and responsive charts redraw on resize
  await evaluate(c, sid, "window.scrollTo(0, 0)").catch(() => null);
  const m = await c.send("Page.getLayoutMetrics", {}, sid);
  const size = m?.cssContentSize ?? m?.contentSize ?? { width: vp.width, height: vp.height };
  // On a phone, content wider than the screen stretches the layout viewport, and the scroll height with
  // it (844 × 924/390 ≈ 2000 px for a page that ends at 800): measure where the content really ends.
  const bottom = Number(await evaluate(c, sid, CONTENT_BOTTOM).catch(() => 0)) || 0;
  const height = bottom > 0 ? Math.min(Number(size.height) || bottom, bottom) : Number(size.height) || vp.height;
  const { parts, cut } = partsOf(height, vp);
  if (Number(size.width) > vp.width + 4) notes.push(`${vp.name}: the page is ${Math.round(size.width)} px wide at a ${vp.width} px screen — it scrolls sideways`);
  if (cut > 0) notes.push(`${vp.name}: the page runs on ${Math.round(cut)} px below the last screen captured`);
  const out: Shot[] = [];
  for (let k = 0; k < parts; k++) {
    const y = k * vp.height;
    const h = Math.min(vp.height, Math.max(1, Math.ceil(height) - y));
    const r = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: vp.width, height: h, scale: 1 } }, sid, 30_000);
    if (r?.data) out.push({ viewport: vp.name, part: k + 1, parts, png: Buffer.from(String(r.data), "base64") });
  }
  return out;
}

/** Render one page in an open context. Never throws: what went wrong comes back as `error`. */
async function renderIn(c: Cdp, contextId: string, src: RenderSource, viewports: Viewport[]): Promise<Rendered> {
  const notes: string[] = [];
  let targetId: string | null = null;
  try {
    targetId = (await c.send("Target.createTarget", { url: "about:blank", browserContextId: contextId }))?.targetId ?? null;
    if (!targetId) return { shots: [], blocked: null, error: "the browser opened no page", notes };
    const sid = (await c.send("Target.attachToTarget", { targetId, flatten: true }))?.sessionId as string;
    await c.send("Page.enable", {}, sid);
    let final: string | null = null;
    if ("html" in src) {
      const tree = await c.send("Page.getFrameTree", {}, sid);
      await c.send("Page.setDocumentContent", { frameId: tree?.frameTree?.frame?.id, html: src.html }, sid, 30_000);
      await settle(c, sid, 15_000);
    } else {
      await c.send("Network.enable", {}, sid);
      let status: number | null = null;
      const off = c.on("Network.responseReceived", sid, (p) => { if (p?.type === "Document" && status === null) status = Number(p?.response?.status) || null; });
      const loaded = c.once("Page.loadEventFired", sid, 25_000);
      const nav = await c.send("Page.navigate", { url: src.url }, sid, 25_000);
      if (nav?.errorText) { off(); return { shots: [], blocked: `it did not load (${nav.errorText})`, error: null, notes }; }
      await loaded;
      await settle(c, sid, 8_000);
      off();
      const p = await evaluate(c, sid, PROBE).catch(() => null);
      final = p?.href ?? null;
      const wall = loginWall({ requested: src.url, final: final ?? src.url, status, title: p?.title ?? "", hasPassword: !!p?.pw, text: p?.text ?? "" });
      if (wall) return { shots: [], blocked: wall, error: null, notes, final_url: final };
      if (status && status >= 400) return { shots: [], blocked: `it answered ${status}`, error: null, notes, final_url: final };
    }
    const shots: Shot[] = [];
    for (const vp of viewports) shots.push(...(await shoot(c, sid, vp, notes)));
    return { shots, blocked: null, error: shots.length ? null : "nothing could be captured", notes, final_url: final };
  } catch (e: any) {
    return { shots: [], blocked: null, error: String(e?.message ?? e).slice(0, 200), notes };
  } finally {
    if (targetId) await c.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => null);
  }
}

/** How long the critic waits for a free context on a busy machine before it judges without renders. */
const LEASE_WAIT_MS = 3 * 60_000;

/**
 * Render each source at every viewport on ONE lease of `pool` — this workspace's, through its egress
 * proxy — and give the context back. One result per source, in order. Never throws.
 */
export async function renderPages(ws: Pick<Workspace, "id">, sources: RenderSource[], o: { pool: BrowserPool; label: string; viewports?: Viewport[] }): Promise<Rendered[]> {
  if (!sources.length) return [];
  // An address never opened is refused before any lease is taken; the rest share one context.
  const refused = sources.map((s) => ("url" in s ? refuseAddress(s.url) : null));
  const fail = (error: string): Rendered[] => sources.map((_, i) => ({ shots: [], blocked: null, error: refused[i] ?? error, notes: [] }));
  if (refused.every(Boolean)) return fail("");
  if (o.pool.hostId === "local" && !browserConfig().enabled) return fail("the shared browser is off on this machine (CHRONOS_BROWSER=off)");
  const deadline = Date.now() + LEASE_WAIT_MS;
  let ticket: string | undefined;
  let lease: { lease_id: string; ws_endpoint: string; context_id: string } | null = null;
  while (!lease) {
    const g = await o.pool.acquire({ workspace_id: ws.id, session_id: null, run_id: null, label: o.label, ticket }, Math.min(30_000, Math.max(0, deadline - Date.now())));
    if (g.granted) lease = g;
    else if ("error" in g) return fail(`the shared browser could not open a page: ${g.error}`);
    else {
      ticket = g.ticket;
      if (Date.now() >= deadline) { o.pool.abandon(g.ticket); return fail(`the shared browser stayed busy (${g.in_use}/${g.cap} in use) — nothing was rendered`); }
    }
  }
  const beat = setInterval(() => o.pool.beat(lease!.lease_id), 30_000);
  beat.unref?.();
  let c: Cdp | null = null;
  try {
    c = await Cdp.open(lease.ws_endpoint);
    const out: Rendered[] = [];
    for (const [i, s] of sources.entries()) {
      if (refused[i]) { out.push({ shots: [], blocked: null, error: refused[i], notes: [] }); continue; }
      out.push(await Promise.race([
        renderIn(c, lease.context_id, s, o.viewports ?? VIEWPORTS),
        sleep(90_000).then((): Rendered => ({ shots: [], blocked: null, error: "rendering took longer than 90 s", notes: [] })),
      ]));
    }
    return out;
  } catch (e: any) {
    return fail(`the shared browser could not be reached: ${String(e?.message ?? e).slice(0, 160)}`);
  } finally {
    clearInterval(beat);
    c?.close();
    await o.pool.release(lease.lease_id).catch(() => false);
  }
}
