import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { ensureCa, leafFor, opensslAvailable, resetCaCache } from "./egress-ca.js";
import { decideInjection, interceptConnect, resetMitmServer } from "./egress-mitm.js";
import type { BrokerCred } from "./broker.js";

const skip = !opensslAvailable() ? { skip: "/usr/bin/openssl unavailable" } : {};

const cred = (over: Partial<BrokerCred> = {}): BrokerCred => ({
  slug: "gh",
  host: "api.github.com",
  header: "Authorization",
  scheme: "Bearer",
  secret: "s3cr3t",
  allow_methods: ["GET", "POST"],
  allow_path_prefixes: ["/repos"],
  intercept: true,
  ...over,
});

// ---- the decision, without a socket in sight ------------------------------------------------

test("decideInjection injects only inside the credential's method + path allowlist", () => {
  const c = cred();
  const d = decideInjection(c, "GET", "/repos/acme-co/chronos", "api.github.com", "api.github.com");
  assert.equal(d.kind, "inject");
  assert.equal((d as any).header, "Authorization");
  assert.equal((d as any).value, "Bearer s3cr3t");

  // Outside the allowlist the request still goes out — just naked. Reachability is the egress
  // allowlist's job, not the credential's.
  assert.equal(decideInjection(c, "GET", "/gists", "api.github.com", "api.github.com").kind, "pass");
  assert.equal(decideInjection(c, "DELETE", "/repos/acme-co/chronos", "api.github.com", "api.github.com").kind, "pass");
  // Segment-boundary, inherited from credAllows: "/repos" must not grant "/reposteria".
  assert.equal(decideInjection(c, "GET", "/reposteria", "api.github.com", "api.github.com").kind, "pass");
});

test("decideInjection refuses a Host header that disagrees with the tunnel", () => {
  const d = decideInjection(cred(), "GET", "/repos/x/y", "evil.example", "api.github.com");
  assert.equal(d.kind, "reject");
  assert.equal((d as any).status, 403);
});

test("decideInjection tolerates a Host header with a port or trailing dot", () => {
  for (const h of ["api.github.com:443", "api.github.com.", undefined, ""])
    assert.equal(decideInjection(cred(), "GET", "/repos/x/y", h, "api.github.com").kind, "inject", String(h));
});

test("decideInjection fails loudly when the secret cannot be resolved or is unusable", () => {
  const missing = decideInjection(cred({ secret: undefined, secret_env: "CHRONOS_TEST_UNSET" }), "GET", "/repos/x/y", undefined, "api.github.com");
  assert.equal(missing.kind, "reject");
  assert.equal((missing as any).status, 503);
  assert.match((missing as any).why, /CHRONOS_TEST_UNSET/);
  assert.doesNotMatch((missing as any).why, /s3cr3t/);

  const bad = decideInjection(cred({ secret: "tok\r\nX-Evil: 1" }), "GET", "/repos/x/y", undefined, "api.github.com");
  assert.equal(bad.kind, "reject");
  assert.match((bad as any).why, /control characters/);
  assert.doesNotMatch((bad as any).why, /X-Evil/); // the message must never quote the value
});

// ---- the real thing: a tunnel, a certificate, an upstream ------------------------------------

interface Rig {
  request: (opts: { method?: string; path: string; headers?: Record<string, string> }) => Promise<{ status: number; body: string }>;
  seen: any[];
  audit: any[];
  close: () => void;
}

// Stands up an upstream HTTPS server and a listener that plays the role of the proxy's post-CONNECT
// socket, so a request goes client → TLS(our leaf) → injection → TLS(verified) → upstream, exactly
// as it will in the daemon.
async function rig(over: Partial<BrokerCred> = {}): Promise<Rig> {
  resetCaCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-mitm-"));
  const ca = ensureCa(dir)!;
  const leaf = leafFor("localhost", dir)!;
  const seen: any[] = [];
  const audit: any[] = [];

  const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, host: req.headers.host });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as any).port;

  const c = cred({ host: `localhost:${upstreamPort}`, ...over });
  const tunnel = net.createServer((sock) => {
    interceptConnect(sock, undefined, leaf, {
      host: "localhost",
      port: upstreamPort,
      cred: c,
      upstreamCa: ca.certPem,
      record: (e) => audit.push(e),
    });
  });
  await new Promise<void>((r) => tunnel.listen(0, "127.0.0.1", r));
  const tunnelPort = (tunnel.address() as any).port;

  const open: (net.Socket | tls.TLSSocket)[] = [];
  return {
    seen,
    audit,
    close: () => { for (const s of open) s.destroy(); upstream.close(); tunnel.close(); },
    request: ({ method = "GET", path: p, headers = {} }) =>
      new Promise((resolve, reject) => {
        const raw = net.connect(tunnelPort, "127.0.0.1");
        open.push(raw);
        raw.on("error", reject);
        // The 200 lands before any TLS byte — the server cannot send a ServerHello until it has our
        // ClientHello, which we only send after this.
        raw.once("data", (greeting) => {
          assert.match(greeting.toString(), /^HTTP\/1\.1 200 /);
          const tsock = tls.connect({ socket: raw, servername: "localhost", ca: ca.certPem });
          open.push(tsock);
          tsock.on("error", reject);
          tsock.once("secureConnect", () => {
            // `agent: false` would discard createConnection and dial port 80; the socket has to be
            // handed over through an agent.
            const agent = new http.Agent();
            (agent as any).createConnection = () => tsock;
            const req = http.request({ agent, method, path: p, headers: { host: "localhost", ...headers } }, (res) => {
              let b = "";
              res.on("data", (d) => (b += d));
              res.on("end", () => resolve({ status: res.statusCode!, body: b }));
            });
            req.on("error", reject);
            req.end();
          });
        });
      }),
  };
}

after(() => { resetMitmServer(); resetCaCache(); });

test("an allowed request reaches upstream carrying a credential the client never had", skip, async () => {
  const r = await rig();
  try {
    const res = await r.request({ path: "/repos/acme-co/chronos" });
    assert.equal(res.status, 200);
    assert.equal(res.body, "upstream-ok");
    assert.equal(r.seen[0].authorization, "Bearer s3cr3t");
    assert.equal(r.seen[0].url, "/repos/acme-co/chronos");
    assert.deepEqual(r.audit.map((a) => [a.injected, a.why]), [[true, "broker:gh"]]);
  } finally {
    r.close();
  }
});

test("a request outside the allowlist is forwarded unchanged, not blocked", skip, async () => {
  const r = await rig();
  try {
    const res = await r.request({ path: "/gists" });
    assert.equal(res.status, 200, "reachability is the egress allowlist's job, not the credential's");
    assert.equal(r.seen[0].authorization, null, "no credential leaves the daemon for an unlisted path");
    assert.equal(r.audit[0].injected, false);
  } finally {
    r.close();
  }
});

// The agent controls its own headers. If it could keep an Authorization of its choosing alongside
// ours, which one the upstream honours would be the upstream's decision, not the operator's.
test("a client-supplied Authorization is replaced, never duplicated", skip, async () => {
  const r = await rig();
  try {
    await r.request({ path: "/repos/acme-co/chronos", headers: { authorization: "Bearer attacker-token" } });
    assert.equal(r.seen[0].authorization, "Bearer s3cr3t");
  } finally {
    r.close();
  }
});

test("a Host header that disagrees with the tunnel never reaches upstream", skip, async () => {
  const r = await rig();
  try {
    const res = await r.request({ path: "/repos/acme-co/chronos", headers: { host: "evil.example" } });
    assert.equal(res.status, 403);
    assert.match(res.body, /does not match the tunnel/);
    assert.equal(r.seen.length, 0);
  } finally {
    r.close();
  }
});

test("an unresolvable secret 503s instead of quietly sending an unauthenticated request", skip, async () => {
  const r = await rig({ secret: undefined, secret_env: "CHRONOS_TEST_UNSET" });
  try {
    const res = await r.request({ path: "/repos/acme-co/chronos" });
    assert.equal(res.status, 503);
    assert.match(res.body, /CHRONOS_TEST_UNSET/);
    assert.equal(r.seen.length, 0);
  } finally {
    r.close();
  }
});

// The upgrade path is a different code path from ordinary requests: once the upstream says 101 it
// is raw bytes in both directions, and getting the direction of the leftover buffer wrong is silent
// — the connection stays open and merely misbehaves.
test("a WebSocket upgrade is spliced through, in the right direction, with the credential", skip, async () => {
  resetCaCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-ws-"));
  const ca = ensureCa(dir)!;
  const leaf = leafFor("localhost", dir)!;
  let upstreamAuth: string | null | undefined;

  const upstream = https.createServer({ key: leaf.key, cert: leaf.cert });
  upstream.on("upgrade", (req, sock) => {
    upstreamAuth = req.headers.authorization ?? null;
    // One write, so the first frame really does ride in the same segment as the 101 and lands in
    // node's `head` buffer — which is the buffer whose direction this test is about.
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nupstream-first-frame");
    sock.on("data", (d) => sock.write(`echo:${d}`));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as any).port;

  const tunnel = net.createServer((sock) =>
    interceptConnect(sock, undefined, leaf, {
      host: "localhost", port: upPort, cred: cred({ host: `localhost:${upPort}` }),
      upstreamCa: ca.certPem, record: () => {},
    }),
  );
  await new Promise<void>((r) => tunnel.listen(0, "127.0.0.1", r));

  const raw = net.connect((tunnel.address() as any).port, "127.0.0.1");
  try {
    const got = await new Promise<string>((resolve, reject) => {
      raw.on("error", reject);
      raw.once("data", () => {
        const t = tls.connect({ socket: raw, servername: "localhost", ca: ca.certPem });
        t.on("error", reject);
        t.once("secureConnect", () => {
          t.write("GET /repos/acme-co/chronos HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
          let buf = "";
          t.on("data", (d) => {
            buf += d;
            if (buf.includes("upstream-first-frame")) t.write("ping");
            if (buf.includes("echo:ping")) resolve(buf);
          });
        });
      });
    });
    assert.match(got, /^HTTP\/1\.1 101 /);
    assert.equal(upstreamAuth, "Bearer s3cr3t", "an upgrade to an allowed path is credentialed too");
    // Exactly once: with the leftover buffer unshifted instead of written, this frame goes back
    // UPSTREAM and returns as "echo:upstream-first-frame" — present, but never delivered directly.
    assert.equal(got.match(/upstream-first-frame/g)?.length, 1);
    assert.doesNotMatch(got, /echo:upstream-first-frame/);
  } finally {
    raw.destroy();
    upstream.close();
    tunnel.close();
  }
});

test("a POST body streams through to upstream with the header attached", skip, async () => {
  const r = await rig();
  try {
    const res = await r.request({ method: "POST", path: "/repos/acme-co/chronos/issues" });
    assert.equal(res.status, 200);
    assert.equal(r.seen[0].method, "POST");
    assert.equal(r.seen[0].authorization, "Bearer s3cr3t");
  } finally {
    r.close();
  }
});
