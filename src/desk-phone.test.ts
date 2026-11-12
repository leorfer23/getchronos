/**
 * The Desk's Phone dialog (static/desk-phone.js), run in a vm the way src/desk-quick-actions.test.ts
 * runs its page code: the pairing link it builds, the QR it draws from the vendored encoder
 * (static/vendor/qrcode.js — every dark module drawn, nothing in the quiet zone), the countdown, and
 * which view each status from GET /api/phone/status gets. The dialog's CSS is held to the Desk's
 * rule: theme tokens only, no literal colours, no animation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const ctx: any = { window: {} };
vm.runInNewContext(read("static/desk-phone.js"), ctx);
const P = ctx.window.ChronosPhone._;
const qrCtx: any = {};
vm.runInNewContext(read("static/vendor/qrcode.js"), qrCtx);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const BASE = "https://mac.example-tailnet.ts.net";

test("the QR carries /phone#pair=<code> on the reachable address", () => {
  assert.equal(P.pairUrl(BASE, "AbC_dEf-0123456789xyz"), `${BASE}/phone#pair=AbC_dEf-0123456789xyz`);
  assert.equal(P.pairUrl(BASE + "/", "x"), `${BASE}/phone#pair=x`);
  assert.equal(P.pairUrl(BASE, null), `${BASE}/phone`, "no code: the bare page");
});

test("the SVG draws every dark module of the real code, with a four-module quiet zone", () => {
  const link = P.pairUrl(BASE, "AbC_dEf-0123456789xyzAbC_dEf-0123456789xyz");
  const rows: boolean[][] = plain(P.qrModules(qrCtx.qrcode, link));
  const n = rows.length;
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `a QR side is 17 + 4·version modules, got ${n}`);
  assert.ok(rows.every((r) => r.length === n));
  const svg: string = P.qrSvg(rows);
  assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  const drawn = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const dark = rows.flatMap((r, y) => r.flatMap((on, x) => (on ? [[x + 4, y + 4]] : [])));
  assert.deepEqual(drawn, dark, "exactly the encoder's dark modules, shifted by the quiet zone");
  assert.ok(drawn.every(([x, y]) => x >= 4 && y >= 4 && x < n + 4 && y < n + 4), "nothing in the quiet zone");
  assert.match(svg, /fill="currentColor"/, "its colour comes from the box (theme tokens), not the SVG");
  // The three finder patterns: a dark 7×7 ring in three corners — what a camera locks on to.
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(rows[oy][ox + i] && rows[oy + 6][ox + i] && rows[oy + i][ox] && rows[oy + i][ox + 6], `finder at ${ox},${oy}`);
    }
  }
});

test("the countdown reads m:ss and stops at expiry", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(P.left("2026-11-11T12:05:00Z", now), "5:00");
  assert.equal(P.left("2026-11-11T12:00:09.2Z", now), "0:10");
  assert.equal(P.left("2026-11-11T12:00:00Z", now), null);
  assert.equal(P.left("not a date", now), null);
});

test("each status gets its view: the QR once a method works, otherwise the next step and the right buttons", () => {
  assert.deepEqual(plain(P.viewFor({ url: BASE, method: "tailscale", tailscale: { step: "on" } })), { kind: "qr", method: "tailscale", base: BASE });
  assert.deepEqual(plain(P.viewFor({ url: "https://desk.example.com", method: "cloudflare", tailscale: { step: "missing" } })).method, "cloudflare");
  const ready = P.viewFor({ url: null, method: null, tailscale: { step: "ready", message: "Ready." }, cloudflare: { configured: false, url: null } });
  assert.deepEqual([ready.kind, ready.enable, ready.message], ["steps", true, "Ready."]);
  assert.equal(P.viewFor({ tailscale: { step: "funnel" } }).enable, true, "enabling is the fix for Funnel");
  for (const s of ["missing", "stopped", "logged-out", "no-https", "tagged", "conflict", "error"]) assert.equal(P.viewFor({ tailscale: { step: s } }).enable, false, s);
  assert.equal(P.viewFor({ tailscale: { step: "missing" } }).phoneApps, true);
  assert.equal(P.viewFor({ tailscale: { step: "ready" }, cloudflare: { configured: true, url: null } }).cfUnknown, true);
  assert.equal(P.viewFor(null).kind, "steps", "no answer is still a view");
});

test("the dialog's CSS: theme tokens only — no literal colours, no animation", () => {
  const css = /var CSS = \[([\s\S]*?)\]\.join/.exec(read("static/desk-phone.js"))?.[1] ?? "";
  assert.ok(css.length > 200, "found the CSS block");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /rgba?\(|hsla?\(/i);
  assert.doesNotMatch(css, /animation|transition/i);
  assert.match(css, /\.ph-qr \{[^}]*background:var\(--term-ink\); color:var\(--term-bg\)/, "dark modules on a light field in both themes");
});
