/**
 * Pairing (src/pair.ts + static/pair.js): a one-time code signs a browser in, once.
 *
 * The routes are asked of the running API — mounted where api.ts mounts them, behind the same gates —
 * and the page code is lifted out of static/pair.js and run in a vm against a fake window.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import express from "express";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { workspaces } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const { PairCodes, RateLimit, pairRoutes, PAIR_GONE, PAIR_TTL_MS } = await import("./pair.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
async function call(method: string, p: string, headers: Record<string, string>, body?: unknown, at = base) {
  const r = await fetch(at + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out, headers: r.headers };
}

test("a code signs in exactly once: 201 with ≥128 random bits, then the token, then 410 for good", async () => {
  const minted = await call("POST", "/pair", admin, {});
  assert.equal(minted.status, 201);
  const { code, expires_at } = minted.json;
  assert.match(code, /^[A-Za-z0-9_-]{32,}$/, "base64url, 24 bytes = 192 bits");
  const ttl = Date.parse(expires_at) - Date.now();
  assert.ok(ttl > PAIR_TTL_MS - 5000 && ttl <= PAIR_TTL_MS, `expires in ~5 min (${ttl} ms)`);
  assert.notEqual((await call("POST", "/pair", admin, {})).json.code, code, "every code is new");

  const first = await call("POST", "/pair/redeem", json, { code });
  assert.equal(first.status, 200);
  assert.equal(first.json.token, CONFIG.adminToken);
  assert.equal(first.headers.get("cache-control"), "no-store", "the token is never cached");
  const again = await call("POST", "/pair/redeem", json, { code });
  assert.deepEqual([again.status, again.json], [410, { error: PAIR_GONE }]);
  // Unknown, malformed, missing: the same answer, word for word — nothing to tell them apart.
  for (const body of [{ code: "x".repeat(32) }, { code: 42 }, {}, { code: "y".repeat(5000) }]) {
    const r = await call("POST", "/pair/redeem", json, body);
    assert.deepEqual([r.status, r.json], [410, { error: PAIR_GONE }], JSON.stringify(body).slice(0, 40));
  }
});

test("only the operator's own token mints: a Robert's derived credential, a wrong token and no token are refused", async () => {
  const ws = workspaces.create({ slug: `pair-${Date.now()}`, name: "Acme", config_dir: fs.mkdtempSync(path.join(os.tmpdir(), "pair-cfg-")) } as any);
  for (const tok of [robertToken(ws.id, "rw"), robertToken(null, "rw", "operator"), robertToken(null, "ro")]) {
    const r = await call("POST", "/pair", { ...json, "x-mc-admin": tok }, {});
    assert.equal(r.status, 403);
    // The read-only one never gets past tokenlessGate (no writes at all); the others reach pair.ts.
    assert.match(r.json.error, /Robert can't make a sign-in link|read-only Robert/);
  }
  // A wrong admin token is no identity at all: refused at the tokenless gate (deny is the default), before pair.ts.
  assert.equal((await call("POST", "/pair", { ...json, "x-mc-admin": "nope" }, {})).status, 401);
  assert.equal((await call("POST", "/pair", json, {})).status, 401);
  assert.equal((await call("POST", "/pair", { ...json, "x-mc-workspace-token": workspaces.get(ws.id)!.token }, {})).status, 403);
});

test("redeeming needs no token even when tokenless requests are refused everywhere else", async () => {
  const prev = process.env.CHRONOS_TOKENLESS;
  process.env.CHRONOS_TOKENLESS = "deny";
  try {
    const { code } = (await call("POST", "/pair", admin, {})).json;
    assert.equal((await call("GET", "/setup/status", json)).status, 401, "deny mode is on");
    const r = await call("POST", "/pair/redeem", json, { code });
    assert.equal(r.status, 200);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_TOKENLESS; else process.env.CHRONOS_TOKENLESS = prev;
  }
});

test("the setup routes are mounted behind the admin gate", async () => {
  // No identity → the tokenless gate (401); a workspace token is an identity, but not the operator (403).
  assert.equal((await call("GET", "/setup/status", { ...json, "x-mc-admin": "nope" })).status, 401);
  assert.equal((await call("POST", "/setup/install/claude", json, {})).status, 401);
  const ws = workspaces.create({ slug: `setup-${Date.now()}`, name: "Acme", config_dir: fs.mkdtempSync(path.join(os.tmpdir(), "setup-cfg-")) } as any);
  assert.equal((await call("POST", "/setup/install/claude", { ...json, "x-mc-workspace-token": workspaces.get(ws.id)!.token }, {})).status, 403);
  assert.equal((await call("POST", "/setup/smoke/nope", admin, {})).status, 404);
});

// ───────────── the parts a live server can't fast-forward: a clock, a host link, a flood ─────────────

async function mini(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  return { at: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/api`, close: () => srv.close() };
}

test("a code past its five minutes is gone, and so is every other expired one", async () => {
  let now = 1_000_000;
  const codes = new PairCodes(PAIR_TTL_MS, () => now);
  const a = codes.mint().code;
  const b = codes.mint().code;
  now += PAIR_TTL_MS - 1;
  assert.equal(codes.redeem(a), true, "one ms before expiry");
  now += 2;
  assert.equal(codes.redeem(b), false, "one ms after");
  codes.mint();
  now += PAIR_TTL_MS;
  codes.mint();
  assert.equal(codes.size, 1, "expired codes are pruned, not kept");
  for (let i = 0; i < 30; i++) codes.mint();
  assert.equal(codes.size, 20, "bounded");

  const s = await mini(pairRoutes({ codes }));
  try {
    const { code } = (await call("POST", "/pair", admin, {}, s.at)).json;
    now += PAIR_TTL_MS;
    assert.equal((await call("POST", "/pair/redeem", json, { code }, s.at)).status, 410);
  } finally { s.close(); }
});

test("a request a host link replayed can neither mint nor redeem", async () => {
  const codes = new PairCodes();
  const live = codes.mint().code;
  const s = await mini(pairRoutes({ codes, forwarded: (req) => (req.get("x-test-host") ? "m2" : null) }));
  try {
    assert.equal((await call("POST", "/pair", { ...admin, "x-test-host": "1" }, {}, s.at)).status, 403);
    assert.equal((await call("POST", "/pair/redeem", { ...json, "x-test-host": "1" }, { code: live }, s.at)).status, 410);
    assert.equal(codes.redeem(live), true, "and the refused attempt did not burn the code");
  } finally { s.close(); }
});

test("redeeming is rate limited per caller: ten tries a minute", async () => {
  let now = 0;
  const s = await mini(pairRoutes({ codes: new PairCodes(), limiter: new RateLimit(10, 60_000, () => now) }));
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("POST", "/pair/redeem", json, { code: `nope-${"z".repeat(20)}-${i}` }, s.at)).status);
    assert.deepEqual(statuses, [...Array(10).fill(410), 429]);
    assert.equal((await call("POST", "/pair/redeem", { ...json, "x-forwarded-for": "100.64.0.9" }, { code: "q".repeat(30) }, s.at)).status, 410, "a phone behind the tunnel has its own window");
    now += 60_000;
    assert.equal((await call("POST", "/pair/redeem", json, { code: "q".repeat(30) }, s.at)).status, 410, "a minute later: tries again");
  } finally { s.close(); }
});

// ───────────── static/pair.js, run against a fake window ─────────────

const PAGE = fs.readFileSync(path.join(process.cwd(), "static", "pair.js"), "utf8");

function fakeWindow(hash: string, answer: { status: number; body: unknown } | "offline", o: { storageThrows?: boolean } = {}) {
  const calls: string[] = [];
  const store = new Map<string, string>();
  const body = { children: [] as any[], appendChild(el: any) { this.children.push(el); } };
  const root = { style: { visibility: "" } };
  const win: any = {
    location: { hash, pathname: "/desk", search: "?x=1", reload: () => calls.push("reload") },
    history: { state: { keep: 1 }, replaceState: (s: unknown, _t: string, url: string) => { calls.push(`replace ${url}`); win.location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : ""; } },
    localStorage: { setItem: (k: string, v: string) => { if (o.storageThrows) throw new Error("QuotaExceeded"); store.set(k, v); } },
    document: { documentElement: root, body, createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }), addEventListener() {} },
    fetch: async (url: string, init: any) => {
      calls.push(`fetch ${url} ${init.body}`);
      if (answer === "offline") throw new TypeError("Failed to fetch");
      return { status: answer.status, json: async () => answer.body };
    },
  };
  return { win, calls, store, root, body };
}

/** pair.js loaded into a window with no code in its hash (so it does nothing on load) → its API. */
function pairApi(): any {
  return vm.runInNewContext(PAGE + "\n;window.ChronosPair", { window: fakeWindow("", { status: 410, body: {} }).win, JSON, String });
}

test("pair.js: the code leaves the address bar first, is redeemed once, and the page reloads signed in", async () => {
  const w = fakeWindow("#jobs&pair=AbCdEfGhIjKlMnOpQrStUvWx", { status: 200, body: { token: "tok-123" } });
  vm.runInNewContext(PAGE, { window: w.win, JSON, String });
  // replaceState ran synchronously, before the network answered — and kept the rest of the hash.
  assert.deepEqual(w.calls.slice(0, 2), ["replace /desk?x=1#jobs", 'fetch /api/pair/redeem {"code":"AbCdEfGhIjKlMnOpQrStUvWx"}']);
  assert.equal(w.root.style.visibility, "hidden", "no token prompt flashes while it trades the code");
  await new Promise((r) => setImmediate(r));
  assert.equal(w.store.get("mc-token"), "tok-123", "the key every page reads the token from");
  assert.equal(w.calls.at(-1), "reload");
  assert.equal(await pairApi().pair(fakeWindow("#jobs", { status: 200, body: { token: "x" } }).win), null, "no code: nothing happens");
});

test("pair.js: a used or expired link, or no Chronos, says why, keeps the page usable and stores nothing", async () => {
  const cases = [
    [{ status: 410, body: { error: "this sign-in link has expired or was already used — run `npm run desk` again" } }, /expired or was already used/, "refused"],
    [{ status: 429, body: {} }, /didn't work/, "refused"],
    ["offline", /Couldn't reach Chronos/, "offline"],
  ] as const;
  for (const [answer, words, outcome] of cases) {
    const w = fakeWindow("#pair=AbCdEfGhIjKlMnOpQrStUvWx", answer);
    assert.equal(await pairApi().pair(w.win), outcome);
    assert.equal(w.store.size, 0);
    assert.equal(w.root.style.visibility, "", "visible again");
    assert.equal(w.body.children.length, 1, "one line says what happened");
    assert.match(w.body.children[0].textContent, words);
    assert.ok(!w.calls.includes("reload"));
  }
});

test("pair.js: a link pasted into a tab already on the page (a hash change, no load) signs in too", async () => {
  const w = fakeWindow("", { status: 200, body: { token: "tok-hc" } });
  const listeners: Record<string, () => void> = {};
  w.win.addEventListener = (ev: string, fn: () => void) => { listeners[ev] = fn; };
  vm.runInNewContext(PAGE, { window: w.win, JSON, String });
  assert.deepEqual(w.calls, [], "nothing on load without a code");
  w.win.location.hash = "#pair=AbCdEfGhIjKlMnOpQrStUvWx";
  listeners.hashchange();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.calls[0], "replace /desk?x=1");
  assert.equal(w.store.get("mc-token"), "tok-hc");
  assert.equal(w.calls.at(-1), "reload");
});

test("pair.js: a browser that won't store the token says so instead of reloading into the prompt", async () => {
  const w = fakeWindow("#pair=AbCdEfGhIjKlMnOpQrStUvWx", { status: 200, body: { token: "tok" } }, { storageThrows: true });
  assert.equal(await pairApi().pair(w.win), "no-storage");
  assert.ok(!w.calls.includes("reload"));
  assert.match(w.body.children[0].textContent, /won't keep the sign-in/);
});

test("pair.js: codeFrom / hashWithout leave every other hash part alone", () => {
  const api = pairApi();
  assert.equal(api.codeFrom("#pair=AbCdEfGhIjKlMnOpQrStUvWx"), "AbCdEfGhIjKlMnOpQrStUvWx");
  assert.equal(api.codeFrom("#ws=acme&pair=AbCdEfGhIjKlMnOpQrStUvWx&range=7d"), "AbCdEfGhIjKlMnOpQrStUvWx");
  assert.equal(api.codeFrom("#pair=short"), null, "too short to be one of ours");
  assert.equal(api.codeFrom("#pair=<script>alert(1)</script>xxxxxxxx"), null);
  assert.equal(api.codeFrom("#reopen=abc"), null);
  assert.equal(api.hashWithout("#ws=acme&pair=AbCdEfGhIjKlMnOpQrStUvWx&range=7d"), "#ws=acme&range=7d");
  assert.equal(api.hashWithout("#pair=AbCdEfGhIjKlMnOpQrStUvWx"), "");
});

test("every page that reads the token loads pair.js in its head, and keeps it under mc-token", () => {
  for (const page of ["desk", "phone", "app", "altitude", "bar"]) {
    const html = fs.readFileSync(path.join(process.cwd(), "static", `${page}.html`), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    assert.ok(head.includes('<script src="/pair.js"></script>'), `${page}.html`);
    assert.match(html, /getItem\("mc-token"\)|store\.get\("mc-token"\)/, `${page}.html reads mc-token`);
    assert.ok(!html.includes("cat ~/chronos/.admin-token") && !html.includes("~/chronos/.admin-token"), `${page}.html names no fixed checkout path`);
  }
});
