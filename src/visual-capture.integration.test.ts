/**
 * ONE real render through the shared browser's lease door (darwin, when chrome-headless-shell / Chrome
 * for Testing is installed — skipped cleanly otherwise): an `mc artifact`-style page framed as the Desk
 * frames it, captured at desktop and phone width in screen-sized PNGs, its sideways scroll on a phone
 * measured, the lease given back and the browser stopped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromeEngine, browserConfigFromEnv, findEngine } from "./resources/browser-engine.js";
import { BrowserPool } from "./resources/browser-pool.js";
import { renderPages } from "./visual-capture.js";

const engine = process.platform === "darwin" ? findEngine({ home: os.homedir(), platform: process.platform }).found : null;

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;margin:24px} .wide{width:900px;border:1px solid #888} .tall{height:2400px;background:linear-gradient(#fff,#ddd)}</style></head>
<body><h1>Signups up 18% since the new pricing page</h1><table class="wide"><tr><td>a wide table that does not fit a phone</td></tr></table><div class="tall"></div></body></html>`;

test("real browser: a page rendered at desktop and phone width, sliced, measured, and the lease given back", { skip: engine ? false : "no chrome-headless-shell / Chrome for Testing installed", timeout: 90_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-critic-it-"));
  const eng = new ChromeEngine({ cfg: { ...browserConfigFromEnv({}), idleMs: 60_000 }, dataDir, log: () => {} });
  const pool = new BrowserPool("local", eng, () => ({ cap: 2, perWs: 1 }), () => {});
  try {
    const [r] = await renderPages({ id: "ws-it" }, [{ html: PAGE }], { pool, label: "critic integration" });
    assert.equal(r.error, null, r.error ?? "");
    assert.equal(r.blocked, null);
    const desktop = r.shots.filter((s) => s.viewport === "desktop");
    const phone = r.shots.filter((s) => s.viewport === "phone");
    assert.ok(desktop.length >= 2, `a tall page is cut into screens (desktop ${desktop.length})`);
    assert.ok(phone.length >= 2, `phone ${phone.length}`);
    for (const s of r.shots) assert.equal(s.png.subarray(1, 4).toString(), "PNG");
    // A desktop screen is 1440 px wide; a phone screen 390 px at 2× = 780 px (PNG IHDR width at bytes 16..20).
    assert.equal(desktop[0].png.readUInt32BE(16), 1440);
    assert.equal(phone[0].png.readUInt32BE(16), 780);
    assert.match(r.notes.join(" "), /phone: the page is \d+ px wide at a 390 px screen — it scrolls sideways/);
    assert.equal(pool.inUse(), 0, "the lease was given back");
  } finally {
    await eng.stop("test");
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
