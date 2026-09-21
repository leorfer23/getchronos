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
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CFT = "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = (process.env.CHRONOS_BASE_URL ?? "http://127.0.0.1:7799").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.CHRONOS_ADMIN_TOKEN;
const OUT = process.argv[2];
// Written by demo-seed.mjs: the Lead session's id, so the Desk's own (client-only, localStorage)
// fold state can start with the Lead's worker group open — otherwise the hero shows just the Lead
// card with its workers collapsed out of view.
const IDS_PATH = process.env.CHRONOS_DEMO_IDS_FILE ?? path.join(os.tmpdir(), "chronos-demo-ids.json");
const IDS = fs.existsSync(IDS_PATH) ? JSON.parse(fs.readFileSync(IDS_PATH, "utf8")) : {};
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

// Every UI (desk.html, app.html, phone.html) reads the SCRATCH daemon's own admin token from
// browser state set before the page's own scripts run — desk/phone from localStorage("mc-token"),
// app from window.__MC_TOKEN__ (normally injected by the native desktop wrapper) — never from a
// pasted-into-a-dialog flow or a URL, so the token never appears in a screenshot or a URL bar.
// NEVER the live daemon's token — only ever this scratch instance's own.
async function authedContext(browser, viewport, deviceScaleFactor, { leadOpen } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, colorScheme: "dark" });
  await ctx.addInitScript(({ token, leadOpen }) => {
    try {
      window.localStorage.setItem("mc-token", token);
      if (leadOpen) window.localStorage.setItem("desk-lead-open", JSON.stringify([leadOpen]));
    } catch {}
    window.__MC_TOKEN__ = token;
  }, { token: ADMIN_TOKEN, leadOpen });
  return ctx;
}

async function main() {
  const browser = await chromium.launch({ executablePath: CFT, headless: true });

  // desk-hero: /desk itself — the wall of live terminal cards (Lead + workers, grouped, in varied
  // states). scripts/demo-seed.mjs opens these as real (harmless, mock-backend) Desk sessions.
  {
    const ctx = await authedContext(browser, { width: 1440, height: 900 }, 2, { leadOpen: IDS.leadId });
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/desk`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    // Focus the blocked pricing worker so the main panel shows an actual open question, not just
    // the Lead's goal text.
    const blockedRow = page.getByText("Migrate checkout to new pricing API", { exact: false });
    if (await blockedRow.isVisible().catch(() => false)) {
      await blockedRow.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: `${OUT}/desk-hero.png` });
    await ctx.close();
    console.log("wrote desk-hero.png");
  }

  // ticket-run: /app Tickets, the acme-api idempotency ticket (a reviewed mock run, with real
  // Work log entries — see demo-seed.mjs).
  {
    const ctx = await authedContext(browser, { width: 1440, height: 900 }, 2);
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
    const ctx = await authedContext(browser, { width: 1440, height: 900 }, 2);
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

  // phone: the actual phone PWA (static/phone.html) at phone size — the default dashboard, which
  // already shows real, alive counts and an inline "1 asking" badge on the blocked Lead group
  // (drilling further just switches tabs within the Lead's own multi-ticket session view, not to
  // the individual worker's question, so the dashboard itself is the clearer shot).
  {
    const ctx = await authedContext(browser, { width: 390, height: 844 }, 3);
    const page = await ctx.newPage();
    await stubUsage(page);
    await page.goto(`${BASE}/phone`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
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
