#!/usr/bin/env node
// Regenerates the site/assets/ product screenshots against a running SCRATCH daemon (see
// site/assets/README.md for how to boot one and run scripts/demo-seed.mjs first).
//
// Chrome for Testing only — never the operator's real Chrome (~/.claude/BROWSER.md). Requires the
// `playwright` package (already a transitive dep via @playwright/mcp) and, for the .webp step,
// `cwebp` (brew install webp) on PATH.
//
// Usage:
//   CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-demo-token \
//     node scripts/demo-screenshot.mjs site/assets

import { chromium } from "playwright";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const CFT = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = (process.env.CHRONOS_BASE_URL ?? "http://127.0.0.1:7799").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.CHRONOS_ADMIN_TOKEN;
const OUT = process.argv[2];
if (!ADMIN_TOKEN) {
  console.error("CHRONOS_ADMIN_TOKEN is required.");
  process.exit(1);
}
if (!OUT) {
  console.error("usage: node scripts/demo-screenshot.mjs <out-dir>");
  process.exit(1);
}
if (!fs.existsSync(CFT)) {
  console.error(`Chrome for Testing not found at ${CFT} — install it (see ~/.claude/BROWSER.md or npx @puppeteer/browsers install chrome@stable), never the real Chrome.`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// Real host CLI usage (Claude/Grok/Cursor %) is machine-wide, not scoped to this scratch daemon or
// workspace — it would leak the operator's real account usage into a public screenshot. Every page
// gets a harmless empty snapshot instead of the real one.
async function stubUsage(page) {
  await page.route("**/api/usage", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ meters: [] }) })
  );
}

async function main() {
  const browser = await chromium.launch({ executablePath: CFT, headless: true });

  // desk-hero: /app's Fleet tab — spend/success metrics + the blocked cart-drawer run card. This
  // scratch demo never opens a real Desk terminal (that would mean spawning a real agent CLI — see
  // site/assets/README.md), so /desk's own Fleet tab (built around live terminal widgets) stays
  // empty; /app's Fleet tab reads the same ticket/run/ask data the rest of this demo seeds and is
  // what actually looks alive.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.locator("button[data-view=fleet]").click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/desk-hero.png` });
    await ctx.close();
    console.log("wrote desk-hero.png");
  }

  // ticket-run: /app Tickets, the acme-api idempotency ticket (a reviewed mock run).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await page.locator("button[data-view=tickets]").click();
    await page.waitForTimeout(400);
    await page.getByText("Support idempotency keys on POST /charges").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/ticket-run.png` });
    await ctx.close();
    console.log("wrote ticket-run.png");
  }

  // ask: /app Tickets, the cart-drawer ticket (open ask, answer box visible).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await page.locator("button[data-view=tickets]").click();
    await page.waitForTimeout(400);
    await page.getByText("Cart drawer loses state on refresh").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/ask.png` });
    await ctx.close();
    console.log("wrote ask.png");
  }

  // phone: /app's Tickets view at mobile width. /phone.html is wired to live terminal SESSIONS
  // (Working/Needs you/Finished), which this scratch demo never creates (no real agent spawned —
  // see desk-hero above), so it renders an honest but empty "nothing open" screen. /app is the
  // same ticket data as the rest of this demo and is responsive down to phone width, so it's what
  // actually shows "an ask reaching you on your phone".
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.locator("button[data-view=tickets]").click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/phone.png` });
    await ctx.close();
    console.log("wrote phone.png");
  }

  await browser.close();

  // .webp (optimized) alongside each .png (README fallback), if cwebp is on PATH.
  try {
    execFileSync("cwebp", ["-version"], { stdio: "ignore" });
    for (const name of ["desk-hero", "ticket-run", "ask", "phone"]) {
      execFileSync("cwebp", ["-quiet", "-q", "82", `${OUT}/${name}.png`, "-o", `${OUT}/${name}.webp`]);
      console.log(`wrote ${name}.webp`);
    }
  } catch {
    console.warn("cwebp not found on PATH — .png files written, but .webp was skipped (brew install webp).");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
