/**
 * Phone access (phone-access.ts + phone-routes.ts) over a fake `tailscale` CLI: every state the Desk's
 * Phone dialog can land in, what enabling runs (exactly `serve --bg <port>`, and only when it is safe),
 * whose account gets recorded as the owner, and the argv allowlist that keeps `tailscale funnel` out.
 * The fake keeps state the way tailscaled does — a successful `serve --bg` shows up in `serve status`.
 * Shapes match `tailscale status --json` / `serve status --json` of tailscale 1.102 (ipnstate.Status,
 * ipn.ServeConfig).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

const access = await import("./phone-access.js");
const { phoneRoutes } = await import("./phone-routes.js");
const { requireAdmin, robertToken } = await import("./authz.js");
const { CONFIG } = await import("./config.js");
import type { PhoneDeps, Run, RunResult } from "./phone-access.js";

const HOST = "mac.example-tailnet.ts.net";
const PORT = 7913;
const OWNER = "owner@example.com";

function status(over: Record<string, unknown> = {}, self: Record<string, unknown> = {}) {
  return {
    BackendState: "Running",
    CertDomains: [HOST],
    CurrentTailnet: { Name: "example.com", MagicDNSSuffix: "example-tailnet.ts.net", MagicDNSEnabled: true },
    Self: { DNSName: HOST + ".", UserID: 42, ...self },
    User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Owner" } },
    ...over,
  };
}
const ours = (port = PORT) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });

type Fake = {
  missing?: boolean;
  status?: unknown;
  statusRaw?: RunResult;
  serve?: unknown;
  /** What `serve --bg` answers; by default it succeeds and serve then proxies to the port. */
  bg?: (port: string) => RunResult;
  /** `serve --bg` "succeeds" but nothing changes (a tailscaled that ignored it). */
  bgNoop?: boolean;
};
function fake(o: Fake) {
  const calls: string[] = [];
  let serve: any = o.serve ?? {};
  const run: Run = async (args) => {
    calls.push(args.join(" "));
    assert.ok(access.allowedTailscaleArgs(args), `unexpected argv: tailscale ${args.join(" ")}`);
    if (o.missing) return { code: null, stdout: "", stderr: "", missing: true };
    if (args[0] === "status") return o.statusRaw ?? { code: 0, stdout: JSON.stringify(o.status ?? status()), stderr: "" };
    if (args[1] === "status") return { code: 0, stdout: JSON.stringify(serve), stderr: "" };
    const r = o.bg ? o.bg(args[2]) : { code: 0, stdout: `Available within your tailnet:\n\nhttps://${HOST}/\n|-- proxy http://127.0.0.1:${args[2]}\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=443 off\n`, stderr: "" };
    if (r.code === 0 && !r.timedOut && !o.bgNoop) {
      const next = { ...serve, ...ours(Number(args[2])) };
      delete next.AllowFunnel; // serve on a Funnel port turns Funnel off for it (serve_v2.go applyFunnel)
      serve = next;
    }
    return r;
  };
  let owner: string | null = null;
  let home = "";
  const deps = (over: Partial<PhoneDeps> = {}): PhoneDeps => ({
    run, port: PORT, env: {}, home: (home ||= fs.mkdtempSync(path.join(os.tmpdir(), "mc-phone-home-"))),
    owner: () => owner, setOwner: (l) => { owner = l; }, ...over,
  });
  return { run, calls, deps, owner: () => owner, setOwner: (l: string | null) => { owner = l; } };
}
const step = async (o: Fake, own: string | null = null) => {
  const f = fake(o);
  f.setOwner(own);
  return (await access.detectTailscale(f.deps())).status;
};

test("each state the dialog can show, with the next step in plain words", async () => {
  const missing = await step({ missing: true });
  assert.equal(missing.step, "missing");
  assert.equal(missing.installed, false);
  assert.equal(missing.fix?.command, "brew install --cask tailscale-app");
  assert.equal(missing.fix?.link, "https://tailscale.com/download/mac");

  assert.equal((await step({ statusRaw: { code: 1, stdout: "", stderr: "failed to connect to local Tailscale service" } })).step, "stopped", "app not running");
  assert.equal((await step({ status: status({ BackendState: "NeedsLogin" }) })).step, "logged-out");
  assert.equal((await step({ status: status({ BackendState: "NeedsMachineAuth" }) })).step, "needs-approval");
  assert.equal((await step({ status: status({ BackendState: "Stopped" }) })).step, "stopped");
  assert.equal((await step({ status: status({ BackendState: "Starting" }) })).step, "starting");
  assert.equal((await step({ status: status({}, { Tags: ["tag:server"] }) })).step, "tagged");

  const noHttps = await step({ status: status({ CertDomains: null }) });
  assert.equal(noHttps.step, "no-https");
  assert.equal(noHttps.fix?.link, "https://console.tailscale.com/admin/dns");
  assert.equal(noHttps.https_ready, false);
  assert.equal((await step({ status: status({ CurrentTailnet: { MagicDNSEnabled: false } }) })).step, "no-https", "MagicDNS off");

  const ready = await step({});
  assert.deepEqual({ step: ready.step, serving: ready.serving, url: ready.url, https_ready: ready.https_ready, running: ready.running, installed: ready.installed },
    { step: "ready", serving: false, url: `https://${HOST}`, https_ready: true, running: true, installed: true });
});

test("someone else's serve on the address is reported, never replaced", async () => {
  const other = await step({ serve: ours(3000) });
  assert.equal(other.step, "conflict");
  assert.match(other.message, /http:\/\/127\.0\.0\.1:3000/);
  assert.equal(other.fix?.command, "tailscale serve --https=443 off");
  const files = await step({ serve: { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Path: "/srv/site" } } } } } });
  assert.equal(files.step, "conflict");
  assert.equal((await step({ serve: { TCP: { "443": { TCPForward: "127.0.0.1:22" } } } })).step, "conflict", "raw TCP on 443");
  const fg = await step({ serve: { Foreground: { abc: ours(5173) } } });
  assert.equal(fg.step, "conflict");
  assert.match(fg.message, /running in a terminal/);
  assert.equal((await step({ serve: { Web: { [`${HOST}:443`]: { Handlers: { "/grafana": { Proxy: "3001" } } } } } })).step, "ready", "another path on the same port is not ours to worry about");
});

test("serving this daemon: on only once the owner is recorded, and only for the Mac's current account", async () => {
  const noOwner = await step({ serve: ours() });
  assert.deepEqual([noOwner.step, noOwner.serving, noOwner.owner_set], ["ready", true, false]);
  const on = await step({ serve: ours() }, OWNER);
  assert.deepEqual([on.step, on.serving, on.owner_set, on.url], ["on", true, true, `https://${HOST}`]);
  const switched = await step({ serve: ours() }, "someone-else@example.com");
  assert.equal(switched.step, "ready");
  assert.match(switched.message, /different account/);
  const funnel = await step({ serve: { ...ours(), AllowFunnel: { [`${HOST}:443`]: true } } }, OWNER);
  assert.equal(funnel.step, "funnel", "public is never 'on'");
});

test("a serve target names this daemon only when it is this port on this machine", () => {
  for (const p of ["7913", "localhost:7913", "127.0.0.1:7913", "http://127.0.0.1:7913", "http://localhost:7913/", "http://[::1]:7913"]) assert.equal(access.proxyPort(p), 7913, p);
  for (const p of ["http://10.0.0.5:7913", "http://example.com:7913", "", null, 7913]) assert.equal(access.proxyPort(p), null, String(p));
});

test("enabling runs exactly `tailscale serve --bg <port>` and records the Mac's own account as the owner", async () => {
  const f = fake({});
  const r = await access.enableTailscale(f.deps());
  assert.deepEqual(r, { ok: true, url: `https://${HOST}` });
  assert.deepEqual(f.calls.filter((c) => c.startsWith("serve --bg")), [`serve --bg ${PORT}`]);
  assert.equal(f.owner(), OWNER);
  // Again, with it already on: nothing is run a second time.
  const again = await access.enableTailscale(f.deps());
  assert.deepEqual(again, { ok: true, url: `https://${HOST}` });
  assert.equal(f.calls.filter((c) => c.startsWith("serve --bg")).length, 1);
});

test("a serve someone set up by hand is adopted: the owner is recorded, serve is not run", async () => {
  const f = fake({ serve: ours() });
  assert.deepEqual(await access.enableTailscale(f.deps()), { ok: true, url: `https://${HOST}` });
  assert.equal(f.calls.some((c) => c.startsWith("serve --bg")), false);
  assert.equal(f.owner(), OWNER);
});

test("enabling refuses — touching nothing — whenever a step comes first or the address is taken", async () => {
  for (const o of [{ missing: true }, { status: status({ BackendState: "NeedsLogin" }) }, { status: status({ CertDomains: [] }) }, { status: status({}, { Tags: ["tag:ci"] }) }, { serve: ours(3000) }] as Fake[]) {
    const f = fake(o);
    const r = await access.enableTailscale(f.deps());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409, JSON.stringify(o));
      assert.ok(r.error.length > 10);
    }
    assert.equal(f.calls.some((c) => c.startsWith("serve --bg")), false, `serve ran for ${JSON.stringify(o)}`);
    assert.equal(f.owner(), null);
  }
});

test("when Tailscale still wants a click, the link it printed comes back; a hang or a no-op is an error, not 'on'", async () => {
  const click = fake({ bg: () => ({ code: null, stdout: "\nServe is not enabled on your tailnet.\n\n         https://login.tailscale.com/f/serve?node=nABC123\n\n", stderr: "", timedOut: true }) });
  const r1 = await access.enableTailscale(click.deps());
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.fix?.link, "https://login.tailscale.com/f/serve?node=nABC123");
    assert.equal(r1.step, "no-https");
  }
  const hang = fake({ bg: () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  const r2 = await access.enableTailscale(hang.deps());
  assert.ok(!r2.ok && r2.status === 502 && /30 seconds/.test(r2.error), JSON.stringify(r2));
  const noop = fake({ bgNoop: true });
  const r3 = await access.enableTailscale(noop.deps());
  assert.ok(!r3.ok && r3.status === 502, JSON.stringify(r3));
  for (const f of [click, hang, noop]) assert.equal(f.owner(), null, "no owner without a verified serve");
});

test("Funnel on Chronos's own address: enabling makes it private again (serve turns Funnel off for its port)", async () => {
  const f = fake({ serve: { ...ours(), AllowFunnel: { [`${HOST}:443`]: true } } });
  const r = await access.enableTailscale(f.deps());
  assert.deepEqual(r, { ok: true, url: `https://${HOST}` });
  assert.equal(f.calls.filter((c) => c.startsWith("serve --bg")).length, 1);
  assert.equal((await access.detectTailscale(f.deps())).status.step, "on");
});

test("the real runner only ever runs the allowlist — never funnel, never reset, never off", async () => {
  for (const ok of [["status", "--json", "--peers=false"], ["serve", "status", "--json"], ["serve", "--bg", "7777"]]) assert.equal(access.allowedTailscaleArgs(ok), true, ok.join(" "));
  for (const no of [["funnel", "--bg", "7777"], ["funnel", "7777"], ["serve", "reset"], ["serve", "--https=443", "off"], ["serve", "--bg", "7777", "off"], ["serve", "--bg", "http://evil.example:7777"], ["up"], ["status"]]) {
    assert.equal(access.allowedTailscaleArgs(no), false, no.join(" "));
    await assert.rejects(access.realRun(no, 1000), /refused to run/, no.join(" "));
  }
});

test("an existing Cloudflare setup is reported, with its public URL when one is configured", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-phone-cf-"));
  assert.deepEqual(access.cloudflareSetup({}, home), { configured: false, url: null });
  fs.mkdirSync(path.join(home, ".cloudflared"));
  fs.writeFileSync(path.join(home, ".cloudflared", "chronos-desk.token"), "x");
  assert.deepEqual(access.cloudflareSetup({}, home), { configured: true, url: null }, "a tunnel whose address Chronos doesn't know");
  assert.deepEqual(access.cloudflareSetup({ CHRONOS_DESK_URL: "https://desk.example.com/desk" }, home), { configured: true, url: "https://desk.example.com" });
  assert.deepEqual(access.cloudflareSetup({ CHRONOS_HOST_PUBLIC_URL: "wss://desk.example.com/host" }, os.tmpdir()), { configured: true, url: "https://desk.example.com" });
  assert.deepEqual(access.cloudflareSetup({ CHRONOS_DESK_URL: `https://${HOST}` }, os.tmpdir()), { configured: false, url: null }, "a ts.net address is Tailscale, not Cloudflare");
});

test("status: Tailscale when it is on, else the Cloudflare URL when known, else nothing", async () => {
  const on = fake({ serve: ours() });
  on.setOwner(OWNER);
  const s1 = await access.phoneStatus(on.deps({ env: { CHRONOS_DESK_URL: "https://desk.example.com" } }));
  assert.deepEqual([s1.method, s1.url], ["tailscale", `https://${HOST}`]);
  const s2 = await access.phoneStatus(fake({}).deps({ env: { CHRONOS_DESK_URL: "https://desk.example.com" } }));
  assert.deepEqual([s2.method, s2.url, s2.tailscale.step], ["cloudflare", "https://desk.example.com", "ready"]);
  const s3 = await access.phoneStatus(fake({ missing: true }).deps());
  assert.deepEqual([s3.method, s3.url], [null, null]);
  // The contract fields the Desk (and the onboarding wizard) read.
  for (const k of ["installed", "running", "https_ready", "serving", "url"]) assert.ok(k in s3.tailscale, k);
});

// ── the routes, over HTTP with the real authz ──
const routeFake = fake({});
const app = express();
app.use(express.json());
const api = express.Router();
api.use(phoneRoutes(requireAdmin, routeFake.deps()));
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => server.close());

test("GET /phone/status is admin-gated; POST /phone/tailscale/enable is the operator's own token only", async () => {
  assert.equal((await fetch(base + "/phone/status")).status, 403);
  const s = await fetch(base + "/phone/status", { headers: { "x-mc-admin": CONFIG.adminToken } });
  assert.equal(s.status, 200);
  const body: any = await s.json();
  assert.deepEqual(Object.keys(body).sort(), ["cloudflare", "method", "tailscale", "url"]);

  const robert = robertToken(null, "rw", "operator");
  for (const h of [{}, { "x-mc-admin": robert }, { "x-mc-admin": "wrong" }] as Record<string, string>[]) {
    const r = await fetch(base + "/phone/tailscale/enable", { method: "POST", headers: h });
    assert.equal(r.status, 403, JSON.stringify(h));
  }
  assert.equal(routeFake.calls.some((c) => c.startsWith("serve --bg")), false, "nothing ran for a refused caller");
  const ok = await fetch(base + "/phone/tailscale/enable", { method: "POST", headers: { "x-mc-admin": CONFIG.adminToken } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { url: `https://${HOST}` });
  assert.equal(routeFake.owner(), OWNER);
});
