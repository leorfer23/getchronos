/**
 * The owner gate (phone-gate.ts), asked of the running server: pages, static files, the API and the
 * WebSocket doors. A request that came through Tailscale is refused unless its identity header is the
 * owner's; everything else — this Mac's own processes, the Cloudflare tunnel — is untouched. And the
 * property the whole design leans on: a forged header can only ever take access away. Each refusal is
 * paired with the same request getting through, so a route that vanished cannot pass for a guarded one.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const gate = await import("./phone-gate.js");
const { phoneGateVerdict, setPhoneOwner, phoneOwner, isTailscaleAddr, decodeQWords, loginMatches, REFUSAL_TEXT } = gate;

const root = `http://127.0.0.1:${PORT}`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); setPhoneOwner(null); });

const OWNER = "owner@example.com";
const owner = { "tailscale-user-login": OWNER, "tailscale-user-name": "Owner", "tailscale-headers-info": "https://tailscale.com/s/serve-headers", host: "mac.example-tailnet.ts.net", "x-forwarded-host": "mac.example-tailnet.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.101.102.103" };
const stranger = { ...owner, "tailscale-user-login": "colleague@example.com", "tailscale-user-name": "Colleague" };
// What serve sends for a tagged device: the proxy headers, no identity.
const tagged = { host: "mac.example-tailnet.ts.net", "x-forwarded-host": "mac.example-tailnet.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.88.1.2" };
// What cloudflared sends (CONFIGURATION.md §4): a public client address, the tunnel's hostname.
const cloudflare = { host: "desk.example.com", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https", "cf-connecting-ip": "203.0.113.7" };

async function get(p: string, headers: Record<string, string> = {}) {
  const r = await fetch(root + p, { headers });
  const text = await r.text();
  return { status: r.status, text, type: r.headers.get("content-type") ?? "" };
}

const v = (h: Record<string, string>, o: string | null = OWNER) => phoneGateVerdict((n) => h[n.toLowerCase()], o);

test("the verdict: untouched unless it came through Tailscale; through Tailscale only the owner", () => {
  assert.deepEqual(v({}), { ok: true }, "a local process");
  assert.deepEqual(v(cloudflare), { ok: true }, "the Cloudflare tunnel");
  assert.deepEqual(v(owner), { ok: true });
  assert.deepEqual(v(stranger), { ok: false, reason: "stranger" });
  assert.deepEqual(v(tagged), { ok: false, reason: "anonymous" });
  assert.deepEqual(v({ "x-forwarded-for": "fd7a:115c:a1e0::9" }), { ok: false, reason: "anonymous" }, "a tailnet IPv6 source");
  assert.deepEqual(v({ host: "100.101.102.103", "x-forwarded-for": "100.64.0.1" }), { ok: false, reason: "anonymous" }, "opened by Tailscale IP, not name");
  assert.deepEqual(v({ "tailscale-funnel-request": "?1", "x-forwarded-for": "198.51.100.4", host: "mac.example-tailnet.ts.net" }), { ok: false, reason: "funnel" });
  assert.deepEqual(v({ ...owner, "tailscale-funnel-request": "?1" }), { ok: false, reason: "funnel" }, "funnel wins over any login");
  assert.deepEqual(v({ ...owner, "tailscale-user-login": "" }), { ok: false, reason: "anonymous" }, "an empty identity is none");
  assert.deepEqual(v(owner, null), { ok: false, reason: "not-enabled" }, "no owner recorded: fail closed");
  assert.deepEqual(v({ "tailscale-user-login": `${OWNER}, colleague@example.com` }), { ok: false, reason: "stranger" }, "two identity headers never match");
});

test("Tailscale's address ranges, and nothing around them", () => {
  for (const a of ["100.64.0.1", "100.101.102.103", "100.127.255.254", "::ffff:100.70.1.1", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0:ab12::5]", " 100.100.100.100"]) assert.equal(isTailscaleAddr(a), true, a);
  for (const a of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "127.0.0.1", "203.0.113.7", "fd7a:115c:a1e1::1", "fc00::1", "::1", "not an ip"]) assert.equal(isTailscaleAddr(a), false, a);
});

test("logins: byte-for-byte for an ASCII owner; Q-decoded only for an owner who needs it", () => {
  assert.equal(loginMatches(OWNER, OWNER), true);
  assert.equal(loginMatches("Owner@example.com", OWNER), false, "no case folding");
  assert.equal(loginMatches(`=?utf-8?q?${OWNER}?=`, OWNER), false, "an ASCII owner is never matched through a decode");
  assert.equal(decodeQWords("=?utf-8?q?j=C3=B6rg_m@example.com?="), "jörg m@example.com");
  assert.equal(decodeQWords("=?utf-8?q?j=C3=B6r?= =?utf-8?q?g@example.com?="), "jörg@example.com", "a long value split into words");
  assert.equal(decodeQWords("=?iso-8859-1?q?j=F6rg?="), null, "only UTF-8 Q words");
  assert.equal(loginMatches("=?utf-8?q?j=C3=B6rg@example.com?=", "jörg@example.com"), true);
  assert.equal(loginMatches("=?utf-8?q?j=C3=B6rg@example.org?=", "jörg@example.com"), false);
});

test("a stranger on the tailnet gets a 403 for every page, file and route — before any of them runs", async () => {
  setPhoneOwner(OWNER);
  for (const p of ["/", "/desk", "/phone", "/sw.js", "/phone.webmanifest", "/desk-quick-actions.js", "/vendor/qrcode.js", "/api/health", "/api/push/vapid", "/api/sessions", "/api/workspaces", "/api/phone/status"]) {
    for (const [who, h] of [["another account", stranger], ["a tagged device", tagged]] as const) {
      const r = await get(p, h);
      assert.equal(r.status, 403, `${p} as ${who}: ${r.status}`);
      if (p.startsWith("/api/")) assert.equal(JSON.parse(r.text).error, who === "a tagged device" ? REFUSAL_TEXT.anonymous : REFUSAL_TEXT.stranger);
      else assert.match(r.type, /^text\/plain/, `${p}: a plain message, not the page`);
      assert.doesNotMatch(r.text, /<html|<script|"ok"/i, `${p} leaked a body`);
    }
  }
  const r = await fetch(root + "/api/sessions", { method: "POST", headers: { ...stranger, "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp", goal: "x" }) });
  assert.equal(r.status, 403, "no terminal for a stranger, whatever the body says");
});

test("the owner, this Mac and the Cloudflare tunnel get exactly what they got before", async () => {
  setPhoneOwner(OWNER);
  for (const p of ["/desk", "/phone", "/sw.js", "/api/health", "/api/sessions", "/api/workspaces"]) {
    const plain = await get(p);
    // Pages and liveness answer a bare request; an API route refuses one (deny is the default) — either
    // way the owner and cloudflared must get exactly what a bare request from this Mac gets.
    if (!p.startsWith("/api/") || p === "/api/health") assert.equal(plain.status, 200, `${p} with no header: ${plain.status}`);
    assert.equal((await get(p, owner)).status, plain.status, `${p} as the owner`);
    assert.equal((await get(p, cloudflare)).status, plain.status, `${p} through cloudflared`);
  }
});

test("forging a header never adds access: the owner's login buys nothing a bare request lacks", async () => {
  setPhoneOwner(OWNER);
  const forged = { "tailscale-user-login": OWNER }; // what a process on this Mac could send
  for (const p of ["/api/authz/tokenless", "/api/phone/status", "/api/isolation/audit", "/api/drafts"]) {
    const bare = await get(p);
    // No token = no identity: refused at the tokenless gate (401, deny is the default) — and a login header changes nothing.
    assert.equal(bare.status, 401, `${p} needs a token`);
    assert.equal((await get(p, forged)).status, bare.status, `${p}: the owner's login is not a credential`);
    assert.equal((await get(p, owner)).status, bare.status, `${p}: not even through Tailscale itself`);
    assert.equal((await get(p, { ...owner, "x-mc-admin": CONFIG.adminToken })).status, 200, `${p}: the owner with the token gets in`);
  }
  const enable = await fetch(root + "/api/phone/tailscale/enable", { method: "POST", headers: forged });
  assert.equal(enable.status, 401, "turning phone access on needs the admin token, not a login");
  // …and forging someone else's login, or a Funnel marker, only locks the forger out.
  assert.equal((await get("/api/health", { "tailscale-user-login": "someone@example.com" })).status, 403);
  assert.equal((await get("/api/health", { "tailscale-funnel-request": "?1" })).status, 403);
});

test("until phone access is turned on, nobody gets in through Tailscale — the owner included", async () => {
  setPhoneOwner(null);
  assert.equal(phoneOwner(), null);
  const r = await get("/api/health", owner);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.text).error, REFUSAL_TEXT["not-enabled"]);
  assert.equal((await get("/api/health")).status, 200, "this Mac is unaffected");
  setPhoneOwner(OWNER);
  assert.equal((await get("/api/health", owner)).status, 200);
});

/** The first response line of a raw WebSocket handshake. */
function upgrade(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, "127.0.0.1");
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\r\n")) { resolve(buf.split("\r\n")[0]); s.destroy(); } });
    s.on("error", reject);
    s.on("close", () => resolve(buf.split("\r\n")[0] || "(closed)"));
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${headers.host ?? `127.0.0.1:${PORT}`}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
    for (const [k, val] of Object.entries(headers)) if (k !== "host") lines.push(`${k}: ${val}`);
    s.write(lines.join("\r\n") + "\r\n\r\n");
  });
}

test("the WebSocket doors (/ws, /term, /host) follow the same rule", async () => {
  setPhoneOwner(OWNER);
  const tok = encodeURIComponent(CONFIG.adminToken);
  for (const p of [`/ws?token=${tok}`, `/term?token=${tok}&id=nope`, "/host"]) {
    assert.match(await upgrade(p, stranger), /^HTTP\/1\.1 403/, `${p} as another account`);
    assert.match(await upgrade(p, tagged), /^HTTP\/1\.1 403/, `${p} from a tagged device`);
  }
  // Control: the same handshakes get through for the owner and for this Mac (101), and the token is
  // still what /ws demands — the owner's identity does not replace it.
  assert.match(await upgrade(`/ws?token=${tok}`, owner), /^HTTP\/1\.1 101/);
  assert.match(await upgrade(`/ws?token=${tok}`, {}), /^HTTP\/1\.1 101/);
  assert.match(await upgrade("/ws?token=wrong", owner), /^HTTP\/1\.1 401/);
});
