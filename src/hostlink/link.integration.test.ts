/**
 * Brain link + host process, in one process, over real TLS on random ports. The full Phase 2 path:
 * join with a code → pinned TLS → hello → vitals → an `mc` request through the host's forwarder
 * reaching a stub API with the brain's stamps → and every way in that must be refused.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import express from "express";
import WebSocket from "ws";
import { BrainLink, UpdateRefused, forwardedHost, hostRoutes, lanUrls, parseListen, type HostLinkInfo } from "./brain-link.js";
import { MANUAL_GIT_UPDATE, brainBuild, hostsView } from "./view.js";
import { JoinCodes, OPENSSL, decodeJoinCode, ensureBrainCert, resetBrainCertCache, type BrainCert } from "./join.js";
import { PROTOCOL_VERSION, encodeControl, decodeControl, type Hello, type HostVitals, type UpdateFrame } from "./wire.js";
import { HostLink, connectHeaders } from "../hostd/link.js";
import { startForwarder } from "../hostd/forwarder.js";
import { join, writeHostSecrets, renderHostPlist, hostEntryArgs, writeHostPlist } from "../hostd/join.js";
import { parseEnvFile } from "../env-file.js";
import { pinnedTlsOptions, fetchPeerCert } from "./pin.js";
import { HostRegistry } from "./registry.js";
import { hosts } from "../store.js";

const HAS_OPENSSL = fs.existsSync(OPENSSL);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostlink-it-"));
const WS_TOKEN = "ws-token-for-test";

let cert: BrainCert;
let otherCert: BrainCert;
let brain: BrainLink;
let listenerPort = 0;
let stub: http.Server;
let stubPort = 0;
let seen: Array<{ headers: Record<string, any>; forwardedFrom: string | null; body: any }> = [];
const cleanups: Array<() => unknown> = [];

const url = () => `wss://127.0.0.1:${listenerPort}/host`;
const hello = (id: string, over: Partial<Hello> = {}): Hello => ({
  t: "hello", proto: PROTOCOL_VERSION, version: "0.1.0", host_id: id, name: "m2", platform: "darwin", arch: "arm64",
  capabilities: { clis: [{ name: "claude", path: "/opt/homebrew/bin/claude", version: "2.0.0" }], node: process.version, sandbox: true },
  profiles: [{ name: "claude", dir: "/Users/x/.claude", exists: true }],
  checkouts: [{ path: "/Users/x/Documents/GitHub/chronos", remote_url: "git@github.com:x/chronos.git" }],
  deny: ["galley"], live: [], ...over,
});
const vitals = (): HostVitals => ({ at: Date.now(), cpu: 12, ram: 40, gpu: 3, loadPerCore: 0.4, pressure: 1, swapPct: 10 });

function once<T extends any[]>(subscribe: (cb: (...a: T) => void) => () => void, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error("timed out waiting for event")); }, timeoutMs);
    const off = subscribe((...a: T) => { clearTimeout(t); off(); resolve(a); });
  });
}

async function mintSecret(): Promise<{ code: string; secret: string }> {
  const { code } = brain.mintJoin({ name: "m2", url: url() });
  return { code, secret: decodeJoinCode(code)!.secret };
}

/** A raw authenticated socket, for the tests that need to misbehave where HostLink would not. */
function rawConnect(id: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(), { headers: connectHeaders("pinned", { hostId: id, token }), ...pinnedTlsOptions(cert.certPem, cert.fingerprint) });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_q, res) => { reject(new Error(`HTTP ${res.statusCode}`)); ws.terminate(); });
    ws.once("error", reject);
  });
}

before(async () => {
  if (!HAS_OPENSSL) return;
  resetBrainCertCache();
  cert = ensureBrainCert(path.join(dir, "brain"))!;
  resetBrainCertCache();
  otherCert = ensureBrainCert(path.join(dir, "impostor"))!;
  resetBrainCertCache();

  const app = express();
  app.use(express.json());
  app.all("/api/echo", (req, res) => {
    seen.push({ headers: req.headers, forwardedFrom: forwardedHost(req), body: req.body });
    res.json({ ok: true, method: req.method });
  });
  stub = http.createServer(app);
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  stubPort = (stub.address() as any).port;

  brain = new BrainLink({
    creds: new HostRegistry(),
    codes: new JoinCodes(),
    pingMs: 150,
    apiTarget: () => ({ host: "127.0.0.1", port: stubPort }),
    verifyCaller: (h) => h["x-mc-workspace-token"] === WS_TOKEN,
  });
  const srv = await brain.listen("127.0.0.1:0", cert);
  listenerPort = (srv.address() as any).port;
});

after(async () => {
  for (const c of cleanups.reverse()) await c();
  await brain?.close();
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

let joined: { id: string; token: string; fp: string } | null = null;
let runningHost: HostLink | null = null;

test("join: a code turns into a 600 credential file; the brain keeps only a hash", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { code } = await mintSecret();
  const hostHome = path.join(dir, "hosthome");
  fs.mkdirSync(hostHome, { recursive: true });
  fs.writeFileSync(path.join(hostHome, ".secrets"), "CHRONOS_HOST_DENY=galley\n", { mode: 0o600 });
  const r = await join({ url: url(), code, hostHome, noLaunchd: true });
  assert.match(r.host_id, /^h_/);
  assert.equal(fs.statSync(r.secretsFile).mode & 0o777, 0o600);
  const env = parseEnvFile(r.secretsFile);
  assert.equal(env.CHRONOS_HOST_ID, r.host_id);
  assert.equal(env.CHRONOS_HOST_CERT_FP, cert.fingerprint);
  assert.equal(env.CHRONOS_HOST_BRAINS.split(",")[0], url());
  assert.equal(env.CHRONOS_HOST_DENY, "galley", "operator's own keys survive the rewrite");
  assert.equal(Buffer.from(env.CHRONOS_HOST_TOKEN, "base64url").length, 32);
  const row = hosts.get(env.CHRONOS_HOST_ID)!;
  assert.equal(row.name, "m2", "the name the operator minted the code with, not the Mac's hostname");
  assert.equal(row.status, "offline", "joined, not yet connected");
  assert.equal(row.cert_fp, cert.fingerprint);
  assert.ok(row.token_hash && !JSON.stringify(row).includes(env.CHRONOS_HOST_TOKEN), "brain never stores the token");
  assert.equal(fs.existsSync(path.join(dir, "brain", "hosts.json")), false, "no hosts.json any more");
  joined = { id: env.CHRONOS_HOST_ID, token: env.CHRONOS_HOST_TOKEN, fp: env.CHRONOS_HOST_CERT_FP };
});

test("join: a reused code is refused", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { code } = await mintSecret();
  await join({ url: url(), code, hostHome: path.join(dir, "h-reuse-1"), noLaunchd: true });
  await assert.rejects(join({ url: url(), code, hostHome: path.join(dir, "h-reuse-2"), noLaunchd: true }), /HTTP 401/);
  assert.equal(fs.existsSync(path.join(dir, "h-reuse-2", ".secrets")), false, "nothing written on refusal");
});

test("join: a brain whose cert does not match the code's fingerprint is refused before the code is sent", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  // A code minted by a DIFFERENT brain (another cert): the listener we reach is then an impostor.
  const impostorCodes = new JoinCodes();
  const { code } = impostorCodes.mint({ fp: otherCert.fingerprint, urls: [] });
  const before = brain.codes.pending();
  await assert.rejects(join({ url: url(), code, hostHome: path.join(dir, "h-mitm"), noLaunchd: true }), /fingerprint mismatch/);
  // Also the other way round: the real code, but pinned against the wrong cert, never reaches the brain.
  const real = await mintSecret();
  const tampered = "CHR1-" + Buffer.from(JSON.stringify({ s: real.secret, fp: otherCert.fingerprint, u: [] })).toString("base64url");
  await assert.rejects(join({ url: url(), code: tampered, hostHome: path.join(dir, "h-mitm2"), noLaunchd: true }), /fingerprint mismatch/);
  assert.equal(brain.codes.pending(), before + 1, "the real code was never presented, so it is still unused");
});

test("run: host connects with pinning, brain gets hello then vitals, RPC works, a host without terminals refuses a spawn", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  assert.ok(joined, "join test ran");
  const { id, token, fp } = joined!;
  const onlineP = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const vitalsP = once<[string, HostVitals]>((cb) => brain.onVitals(cb));
  const host = new HostLink({ brains: [url()], hostId: id, token, fp, hello: async () => hello(id), vitals: async () => vitals(), vitalsMs: 50, backoffMinMs: 50, backoffMaxMs: 200 });
  host.start();
  cleanups.push(() => host.stop());
  runningHost = host;
  const [info] = await onlineP;
  assert.equal(info.host_id, id);
  assert.equal(info.via, "lan");
  assert.deepEqual(info.hello.deny, ["galley"]);
  assert.equal(info.hello.capabilities.clis[0].name, "claude");
  const [vid, v] = await vitalsP;
  assert.equal(vid, id);
  assert.equal(v.loadPerCore, 0.4);
  assert.equal(brain.list()[0].vitals?.cpu, 12);
  const row = hosts.get(id)!;
  assert.equal(row.status, "online");
  assert.equal(row.platform, "darwin");
  const caps = JSON.parse(row.capabilities_json!);
  assert.deepEqual(caps.veto, ["galley"]);
  assert.equal(caps.clis[0].name, "claude");
  assert.equal(caps.version, "0.1.0");
  assert.ok(brain.vitalsHistory(id).length >= 1);

  assert.equal((await brain.request(id, "vitals")) as any instanceof Object, true);
  await assert.rejects(brain.request(id, "spawn_pty", { session_id: "s1" }), /runs no terminals/);
  await assert.rejects(brain.request(id, "no_such_op"), /unknown op/);

  // Admin view of the same state.
  const app = express();
  app.use(express.json());
  app.use("/api", hostRoutes((req, res, next) => (req.get("x-mc-admin") === "adm" ? next() : res.status(403).end()), () => brain));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const get = (p: string, admin?: string, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: admin ? { "x-mc-admin": admin, "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
  assert.equal((await get("/api/hosts/links")).status, 403);
  const links = await (await get("/api/hosts/links", "adm")).json();
  assert.equal(links.links[0].host_id, id);
  assert.ok(links.known.some((k: any) => k.host_id === id && k.online));
  const all = await (await get("/api/hosts", "adm")).json();
  const me = all.hosts.find((h: any) => h.id === id);
  assert.equal(me.connected, true);
  assert.equal(me.status, "online");
  assert.equal(me.link.via, "lan");
  assert.ok(me.vitals.history.length >= 1 && me.vitals.history[0].cpu === 12, "sparkline history from the link");
  assert.equal(me.admission.ok, true);
  assert.ok(!JSON.stringify(all).includes("token_hash"));
  const minted = await (await get("/api/hosts/join-codes", "adm", "POST")).json();
  assert.match(minted.code, /^CHR1-/);
  assert.match(minted.command, /npm run host -- join wss:\/\/127\.0\.0\.1:\d+\/host CHR1-/);
  assert.equal(minted.fingerprint, cert.fingerprint);
  await new Promise<void>((r) => srv.close(() => r()));
});

test("forwarder: an mc request reaches the brain's API stamped remote, with host-set stamps discarded", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { id } = joined!;
  const link = runningHost!;
  assert.equal(link.state, "online");
  const fwd = await startForwarder(link, { port: 0, status: () => ({ state: link.state }) });
  cleanups.push(() => new Promise((r) => fwd.close(() => r(null))));
  const fport = (fwd.address() as any).port;

  seen = [];
  const r = await fetch(`http://127.0.0.1:${fport}/api/echo?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mc-workspace-token": WS_TOKEN, "x-mc-admin": "stolen?", "x-mc-remote": "0", "x-mc-host": "h_spoofed", "x-mc-forwarded": "guess", "x-mc-session": "sess-1" },
    body: JSON.stringify({ hello: "brain" }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, method: "POST" });
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.equal(h["x-mc-remote"], "1");
  assert.equal(h["x-mc-host"], id);
  assert.equal(h["x-mc-admin"], undefined, "admin token never crosses from a host");
  assert.equal(h["x-mc-session"], "sess-1");
  assert.equal(seen[0].forwardedFrom, id, "the per-boot forward secret verifies");
  assert.deepEqual(seen[0].body, { hello: "brain" });

  // No workspace token → refused by the brain before it reaches the API.
  seen = [];
  const noTok = await fetch(`http://127.0.0.1:${fport}/api/echo`);
  assert.equal(noTok.status, 401);
  assert.equal(seen.length, 0);
  // Only /api/ is forwarded, after normalization.
  assert.equal((await fetch(`http://127.0.0.1:${fport}/api/../desk`, { headers: { "x-mc-workspace-token": WS_TOKEN } })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${fport}/desk`, { headers: { "x-mc-workspace-token": WS_TOKEN } })).status, 404);
  // The host's own status page is answered locally.
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${fport}/__host/status`)).json(), { state: "online" });
  // A local process faking the stamps without the secret is not "forwarded".
  assert.equal(forwardedHost({ get: (n: string) => ({ "x-mc-forwarded": "guess", "x-mc-host": "h_x" } as any)[n] }), null);
});

test("refusals: bad token, unknown host, no auth, and non-/host paths", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { id } = joined!;
  await assert.rejects(rawConnect(id, "not-the-token"), /HTTP 401/);
  await assert.rejects(rawConnect("h_000000000000", "x"), /HTTP 401/);
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(url(), pinnedTlsOptions(cert.certPem, cert.fingerprint));
    ws.once("open", resolve);
    ws.once("unexpected-response", (_q, res) => { reject(new Error(`HTTP ${res.statusCode}`)); ws.terminate(); });
    ws.once("error", reject);
  }), /HTTP 401/);
  // Every non-/host request on the listener is a bare 404, before auth.
  const httpsGet = (p: string) => new Promise<number>((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port: listenerPort, path: p, ...pinnedTlsOptions(cert.certPem, cert.fingerprint) }, (res: any) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(await httpsGet("/api/health"), 404);
  assert.equal(await httpsGet("/host"), 404, "a plain GET to /host (no upgrade) is also 404");
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${listenerPort}/term`, pinnedTlsOptions(cert.certPem, cert.fingerprint));
    ws.once("open", resolve);
    ws.once("unexpected-response", (_q, res) => { reject(new Error(`HTTP ${res.statusCode}`)); ws.terminate(); });
    ws.once("error", reject);
  }), /HTTP 404/);
  // The listener presents exactly the brain's cert.
  assert.equal((await fetchPeerCert(new URL(url()))).fingerprint, cert.fingerprint);
});

test("version: a host speaking another major is refused with an 'update this host' error", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { id, token } = joined!;
  const ws = await rawConnect(id, token);
  const frames: any[] = [];
  ws.on("message", (m) => frames.push(decodeControl(m as Buffer)));
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  ws.send(encodeControl(hello(id, { proto: "2.0" })));
  assert.equal(await closed, 4426);
  assert.equal(frames[0]?.code, "version");
  assert.match(frames[0]?.message, /update this host/);
});

test("identity: a hello claiming another host id is refused", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { id, token } = joined!;
  const ws = await rawConnect(id, token);
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  ws.send(encodeControl(hello("h_someoneelse")));
  assert.equal(await closed, 4403);
});

test("link down: a host that stops answering pings goes offline after two misses — process not assumed dead", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { id, token } = joined!;
  // Stop the well-behaved links first so the only connection is the silent one below.
  for (const c of cleanups.splice(0)) await c();
  if (brain.isOnline(id)) await once((cb) => brain.onHostOffline(cb));
  const ws = await rawConnect(id, token);
  const onlineP = once((cb) => brain.onHostOnline(cb));
  ws.send(encodeControl(hello(id)));
  await onlineP;
  // Never answer brain pings (a raw socket has no handler) — ws-level pongs are automatic, but the
  // brain's liveness is app-level ping frames, which is what survives a proxy like Cloudflare.
  const t0 = Date.now();
  const [hid, reason] = await once<[string, string]>((cb) => brain.onHostOffline(cb), 3000);
  assert.equal(hid, id);
  assert.match(reason, /2 pings missed/);
  assert.ok(Date.now() - t0 >= 150 * 2, "not before two intervals");
  assert.equal(brain.isOnline(id), false);
  ws.terminate();
});

test("revoke: the credential stops working and a live link is dropped", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  const { code } = await mintSecret();
  const r = await join({ url: url(), code, hostHome: path.join(dir, "h-revoke"), noLaunchd: true });
  const env = parseEnvFile(r.secretsFile);
  const host = new HostLink({ brains: [url()], hostId: env.CHRONOS_HOST_ID, token: env.CHRONOS_HOST_TOKEN, fp: env.CHRONOS_HOST_CERT_FP, hello: async () => hello(env.CHRONOS_HOST_ID), vitals: async () => vitals(), backoffMinMs: 20 });
  const p = once((cb) => brain.onHostOnline(cb));
  host.start();
  await p;
  const off = once((cb) => brain.onHostOffline(cb));
  assert.equal(brain.revoke(env.CHRONOS_HOST_ID), true);
  await off;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.state, "stopped", "a revoked host does not hammer the brain with retries");
  await assert.rejects(rawConnect(env.CHRONOS_HOST_ID, env.CHRONOS_HOST_TOKEN), /HTTP 401/);
  const row = hosts.get(env.CHRONOS_HOST_ID)!;
  assert.equal(row.status, "disabled");
  assert.equal(row.token_hash, null);
  await host.stop();
});

test("tunnel door: /host on the loopback API server takes the same credential (no pinning; plain ws only on loopback)", { skip: !HAS_OPENSSL && "no openssl" }, async () => {
  // Stand-in for api.ts's upgrade router: /host → brainLink.handleUpgrade(…, "tunnel").
  const api = http.createServer((_q, r) => r.writeHead(404).end());
  api.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "", "http://x").pathname === "/host") return brain.handleUpgrade(req, socket, head, "tunnel");
    socket.destroy();
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { api.closeAllConnections(); return new Promise<void>((res) => api.close(() => res())); });
  const tunnel = `ws://127.0.0.1:${(api.address() as any).port}/host`;
  const { code } = await mintSecret();
  const r = await join({ url: tunnel, code, hostHome: path.join(dir, "h-tunnel"), noLaunchd: true });
  const env = parseEnvFile(r.secretsFile);
  assert.equal(env.CHRONOS_HOST_BRAINS.split(",")[0], tunnel);
  // A dead first URL is skipped; the tunnel answers.
  const host = new HostLink({ brains: ["wss://127.0.0.1:1/host", tunnel], hostId: env.CHRONOS_HOST_ID, token: env.CHRONOS_HOST_TOKEN, fp: env.CHRONOS_HOST_CERT_FP, hello: async () => hello(env.CHRONOS_HOST_ID), vitals: async () => vitals() });
  const p = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  host.start();
  const [info] = await p;
  assert.equal(info.via, "tunnel");
  assert.equal(host.url, tunnel);
  await host.stop();
});

// ───────────────────────────── pieces that need no sockets ─────────────────────────────

test("listen spec parsing and advertised LAN URLs", () => {
  assert.deepEqual(parseListen("0.0.0.0:7779"), { host: "0.0.0.0", port: 7779 });
  assert.deepEqual(parseListen("7779"), { host: "0.0.0.0", port: 7779 });
  assert.deepEqual(parseListen(":7779"), { host: "0.0.0.0", port: 7779 });
  assert.deepEqual(parseListen("192.168.1.20:7779"), { host: "192.168.1.20", port: 7779 });
  assert.throws(() => parseListen("nope"));
  const ifaces = { en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }], lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }] } as any;
  assert.deepEqual(lanUrls("0.0.0.0", 7779, ifaces), ["wss://192.168.1.20:7779/host"]);
  assert.deepEqual(lanUrls("10.0.0.5", 7779, ifaces), ["wss://10.0.0.5:7779/host"]);
});

test("CF Access headers go only to CA-verified (tunnel) URLs", () => {
  const cf = { id: "cid", secret: "csec" };
  assert.equal(connectHeaders("ca", { hostId: "h", token: "t", cfAccess: cf })["cf-access-client-id"], "cid");
  assert.equal(connectHeaders("pinned", { hostId: "h", token: "t", cfAccess: cf })["cf-access-client-id"], undefined);
  assert.equal(connectHeaders("loopback-plain", { hostId: "h", token: "t", cfAccess: cf })["cf-access-client-secret"], undefined);
});

test("host secrets writer keeps foreign keys, replaces ours, and is 600", () => {
  const f = path.join(dir, "sec", ".secrets");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "# mine\nCHRONOS_HOST_ROOTS=~/code\nCHRONOS_HOST_ID=old\n", { mode: 0o644 });
  writeHostSecrets(f, { CHRONOS_HOST_ID: "h_new", CHRONOS_HOST_TOKEN: "tok" });
  const txt = fs.readFileSync(f, "utf8");
  assert.match(txt, /# mine/);
  assert.match(txt, /CHRONOS_HOST_ROOTS=~\/code/);
  assert.doesNotMatch(txt, /=old/);
  assert.equal(parseEnvFile(f).CHRONOS_HOST_ID, "h_new");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("plist template renders every token, escapes XML, runs at load and keeps alive", () => {
  const tpl = fs.readFileSync(path.join(process.cwd(), "launchd", "sh.chronos.host.plist.template"), "utf8");
  const out = renderHostPlist(tpl, { programArgs: ["/opt/homebrew/bin/node", "/x/dist/hostd/index.js", "run"], hostHome: "/Users/a&b/.chronos-host", home: "/Users/a&b", user: "a", pathVar: "/opt/homebrew/bin:/usr/bin" });
  assert.doesNotMatch(out, /__[A-Z_]+__/);
  assert.match(out, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.match(out, /a&amp;b/);
  assert.match(out, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(out, /<key>KeepAlive<\/key>\s*<true\/>/);
  const args = hostEntryArgs("/n", path.join(dir, "no-such-repo"));
  assert.equal(args[0], "/n");
  assert.equal(args[1], "--import");
  assert.match(args[2], /^file:\/\/.*tsx\/dist\/loader\.mjs$/);
  assert.equal(args[args.length - 1], "run");
});


test("LaunchAgent entry: bin/getchronos.mjs host run when the tree has it (preflight first); written atomically by writeHostPlist", () => {
  assert.deepEqual(hostEntryArgs("/n", process.cwd()), ["/n", path.join(process.cwd(), "bin", "getchronos.mjs"), "host", "run"]);
  const agents = path.join(dir, "LaunchAgents");
  const file = writeHostPlist({ hostHome: path.join(dir, "hh-plist"), pkgRoot: process.cwd(), launchAgentsDir: agents, env: { node: "/opt/homebrew/opt/node/bin/node", path: "/opt/homebrew/opt/node/bin:/usr/bin" } });
  const out = fs.readFileSync(file, "utf8");
  assert.match(out, /<string>\/opt\/homebrew\/opt\/node\/bin\/node<\/string>\s*<string>[^<]*\/bin\/getchronos\.mjs<\/string>\s*<string>host<\/string>\s*<string>run<\/string>/);
  assert.deepEqual(fs.readdirSync(agents), ["sh.chronos.host.plist"], "no temp file left behind");
});

// ───────────────────────────── phase 6: update over the link ─────────────────────────────

test("update: the Desk asks, the host reports running → restarting, and its hello on the brain's commit settles it done", { skip: (!HAS_OPENSSL && "no openssl") || (!brainBuild().commit && "brain is not a git checkout") }, async () => {
  const { code } = await mintSecret();
  const r = await join({ url: url(), code, hostHome: path.join(dir, "h-upd"), noLaunchd: true });
  const env = parseEnvFile(r.secretsFile);
  const id = env.CHRONOS_HOST_ID;
  const target = brainBuild();
  const OLD = "0".repeat(40);
  const start = (commit: string, onUpdate?: (l: HostLink, f: UpdateFrame) => void) => {
    const l = new HostLink({ brains: [url()], hostId: id, token: env.CHRONOS_HOST_TOKEN, fp: env.CHRONOS_HOST_CERT_FP, hello: async () => hello(id, { install: "git", commit }), vitals: async () => vitals(), backoffMinMs: 50, backoffMaxMs: 200 });
    if (onUpdate) l.on("update", (f: UpdateFrame) => onUpdate(l, f));
    return l;
  };
  const got: UpdateFrame[] = [];
  let online = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const a = start(OLD, (l, f) => {
    got.push(f);
    l.sendControl({ t: "update_status", id: f.id, state: "running", step: "npm ci" });
    l.sendControl({ t: "update_status", id: "someone-else", state: "failed", error: "not ours" });
    l.sendControl({ t: "update_status", id: f.id, state: "restarting" });
  });
  a.start();
  await online;
  const before = hostsView(brain).find((h) => h.id === id)!;
  assert.equal(before.commit, OLD);
  assert.equal(before.install, "git");
  assert.equal(before.update?.available, true, "a different commit than the brain's");
  assert.equal(before.update?.supported, true);

  const rec = brain.requestUpdate(id);
  assert.equal(rec.state, "requested");
  assert.throws(() => brain.requestUpdate(id), (e: any) => e instanceof UpdateRefused && e.status === 409, "one at a time");
  for (let i = 0; i < 100 && brain.updateStatus(id)?.state !== "restarting"; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(brain.updateStatus(id)?.state, "restarting");
  assert.equal(brain.updateStatus(id)?.error, undefined, "a status for another update id is ignored");
  assert.deepEqual(got.map((f) => f.target), [target], "the brain's own version + commit");

  // The host restarts: the old link goes, the new process says hello on the target commit.
  await a.stop();
  online = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const b = start(target.commit!);
  b.start();
  cleanups.push(() => b.stop());
  await online;
  assert.equal(brain.updateStatus(id)?.state, "done");
  const after = hostsView(brain).find((h) => h.id === id)!;
  assert.equal(after.update?.available, false);
  assert.equal(after.update?.status?.state, "done");
  const caps = JSON.parse(hosts.get(id)!.capabilities_json!);
  assert.equal(caps.commit, target.commit, "the registry keeps the commit for when it is offline");
  assert.equal(caps.install, "git");
});

test("update: a host from before self-update is refused with the one line to run on it; a host that comes back on the wrong commit is a failure", { skip: (!HAS_OPENSSL && "no openssl") || (!brainBuild().commit && "brain is not a git checkout") }, async () => {
  const { code } = await mintSecret();
  const r = await join({ url: url(), code, hostHome: path.join(dir, "h-upd-old"), noLaunchd: true });
  const env = parseEnvFile(r.secretsFile);
  const id = env.CHRONOS_HOST_ID;
  const mk = (over: Partial<Hello>) => new HostLink({ brains: [url()], hostId: id, token: env.CHRONOS_HOST_TOKEN, fp: env.CHRONOS_HOST_CERT_FP, hello: async () => hello(id, over), vitals: async () => vitals(), backoffMinMs: 50, backoffMaxMs: 200 });
  let online = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const old = mk({});
  old.start();
  await online;
  const v = hostsView(brain).find((h) => h.id === id)!;
  assert.equal(v.update?.available, true, "older than the brain by construction");
  assert.equal(v.update?.supported, false);
  assert.equal(v.update?.manual, MANUAL_GIT_UPDATE);
  assert.match(MANUAL_GIT_UPDATE, /^cd "\$HOME\/\.chronos-host\/app" && /);
  assert.throws(() => brain.requestUpdate(id), (e: any) => e instanceof UpdateRefused && e.status === 400 && e.message.includes(MANUAL_GIT_UPDATE));
  await old.stop();

  // Phase-6 host that restarts but comes back on the old commit.
  online = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const a = mk({ install: "git", commit: "1".repeat(40) });
  a.on("update", (f: UpdateFrame) => a.sendControl({ t: "update_status", id: f.id, state: "restarting" }));
  a.start();
  await online;
  brain.requestUpdate(id);
  for (let i = 0; i < 100 && brain.updateStatus(id)?.state !== "restarting"; i++) await new Promise((res) => setTimeout(res, 20));
  await a.stop();
  online = once<[HostLinkInfo]>((cb) => brain.onHostOnline(cb));
  const b = mk({ install: "git", commit: "1".repeat(40) });
  b.start();
  cleanups.push(() => b.stop());
  await online;
  assert.equal(brain.updateStatus(id)?.state, "failed");
  assert.match(brain.updateStatus(id)!.error!, /came back on 0\.1\.0 @ 111111111111/);
});
