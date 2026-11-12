/**
 * The phone's install banner (static/phone-install.js), run in a vm: which phones get it, and which
 * pasted text counts as a pairing link (the iPhone path — a Home Screen app has its own storage, so
 * it signs in with a fresh link, never with a copied token).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/phone-install.js"), "utf8"), ctx);
const I = ctx.window.PhoneInstall._;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("platforms: iPhone, iPad (which says Macintosh, but has touch), Android — and the Mac is neither", () => {
  assert.equal(I.platform(IPHONE, 5), "ios");
  assert.equal(I.platform(IPAD, 5), "ios");
  assert.equal(I.platform(IPAD, 0), "other", "a Mac's Safari");
  assert.equal(I.platform(ANDROID, 5), "android");
  assert.equal(I.platform(MAC_CHROME, 0), "other");
});

test("shown on a signed-in phone browser, until dismissed or installed; Android only when the browser can install", () => {
  const base = { platform: "ios", signedIn: true, standalone: false, dismissed: false, canPrompt: false };
  assert.equal(I.shouldShow(base), true);
  assert.equal(I.shouldShow({ ...base, signedIn: false }), false, "pairing hasn't worked yet");
  assert.equal(I.shouldShow({ ...base, standalone: true }), false, "already the installed app");
  assert.equal(I.shouldShow({ ...base, dismissed: true }), false);
  assert.equal(I.shouldShow({ ...base, platform: "other" }), false, "the Mac's full-screen front");
  assert.equal(I.shouldShow({ ...base, platform: "android" }), false, "no install prompt offered");
  assert.equal(I.shouldShow({ ...base, platform: "android", canPrompt: true }), true);
});

test("a pasted pairing link is recognised; a pasted token is not", () => {
  const code = "AbC_dEf-0123456789xyz";
  assert.equal(I.pairCode(`https://mac.example-tailnet.ts.net/phone#pair=${code}`), code);
  assert.equal(I.pairCode(`  https://mac.example-tailnet.ts.net/phone#pair=${code}\n`), code);
  assert.equal(I.pairCode(`https://desk.example.com/phone?x=1#pair=${code}&y=2`), code);
  assert.equal(I.pairCode(`pair=${code}`), code);
  assert.equal(I.pairCode("a".repeat(64)), null, "an admin token stays a token");
  assert.equal(I.pairCode("https://mac.example-tailnet.ts.net/phone#pair=short"), null);
  assert.equal(I.pairCode("https://x.example/phone#repair=AbC_dEf-0123456789xyz"), null, "only a pair= parameter");
  assert.equal(I.pairCode(null), null);
});
