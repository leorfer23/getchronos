import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import tls from "node:tls";
import {
  ensureCa, leafFor, caEnv, validHost, resetCaCache,
  caKeyFile, leafKeyFile, caCertFile, caBundleFile, opensslAvailable,
} from "./egress-ca.js";

// Each test gets its own CA dir; the module caches per-dir, so also reset between tests.
function freshDir(): string {
  resetCaCache();
  return fs.mkdtempSync(path.join(os.tmpdir(), "chronos-ca-"));
}

const skip = !opensslAvailable() ? { skip: `${"/usr/bin/openssl"} unavailable` } : {};

test("ensureCa issues a CA with private keys locked to the owner", skip, () => {
  const dir = freshDir();
  const ca = ensureCa(dir);
  assert.ok(ca, "CA should be established");
  assert.equal(ca!.certFile, caCertFile(dir));
  assert.match(ca!.certPem, /BEGIN CERTIFICATE/);
  assert.match(ca!.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i);
  for (const f of [caKeyFile(dir), leafKeyFile(dir)])
    assert.equal(fs.statSync(f).mode & 0o077, 0, `${f} must not be group/other readable`);
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "CA dir must not be group/other readable");
});

test("ensureCa is idempotent — it does not re-issue on every call", skip, () => {
  const dir = freshDir();
  const first = ensureCa(dir)!.fingerprint;
  resetCaCache(); // force it back through the on-disk path, not the memo
  assert.equal(ensureCa(dir)!.fingerprint, first);
});

test("ensureCa replaces a CA that is expired or unreadable", skip, () => {
  const dir = freshDir();
  const first = ensureCa(dir)!.fingerprint;
  fs.writeFileSync(caCertFile(dir), "not a certificate\n");
  resetCaCache();
  assert.notEqual(ensureCa(dir)!.fingerprint, first);
});

// The real proof: a client that trusts the CA completes a handshake against a server using a leaf
// the way the proxy will serve it — through SNI, keyed on the name the client asked for.
test("a leaf served via SNI is trusted by a client holding the CA", skip, async () => {
  const dir = freshDir();
  const ca = ensureCa(dir)!;
  const server = https.createServer(
    {
      SNICallback: (servername, cb) => {
        const leaf = leafFor(servername, dir);
        cb(leaf ? null : new Error("no leaf"), leaf ? tls.createSecureContext(leaf) : undefined);
      },
    },
    (_req, res) => res.end("brokered"),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, servername: "api.github.com", path: "/", ca: ca.certPem },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(b));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "brokered");

    // ...and a client that does NOT hold the CA must still reject it. Trust is opt-in per spawn;
    // if this ever passes, the CA leaked into the ambient trust store.
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const req = https.request({ host: "127.0.0.1", port, servername: "api.github.com", path: "/" }, resolve);
          req.on("error", reject);
          req.end();
        }),
      /self-signed|self signed|unable to verify/i,
    );
  } finally {
    server.close();
  }
});

test("leafFor caches per host and mints for IP literals", skip, () => {
  const dir = freshDir();
  const a = leafFor("api.github.com", dir)!;
  const b = leafFor("API.GitHub.com.", dir)!; // case + trailing dot normalise to the same entry
  assert.equal(a.cert, b.cert);
  assert.notEqual(leafFor("github.com", dir)!.cert, a.cert);
  assert.ok(leafFor("93.184.216.34", dir), "IP literals get an IP SAN, not a DNS one");
});

test("leafFor refuses hostnames that could rewrite the subject or extensions", skip, () => {
  const dir = freshDir();
  for (const bad of ["", "a b.com", "evil.com/O=Chronos", "x\nsubjectAltName=DNS:*", "-x.com", "..", "a".repeat(300)])
    assert.equal(leafFor(bad, dir), null, `should refuse ${JSON.stringify(bad)}`);
});

test("validHost accepts real hostnames and IPs, rejects the rest", () => {
  for (const good of ["github.com", "api.github.com", "a-b.example.co.uk", "127.0.0.1", "::1"])
    assert.equal(validHost(good), true, good);
  for (const bad of ["", "-a.com", "a..b", "a b", "a/b", "a\tb", "*.github.com"])
    assert.equal(validHost(bad), false, JSON.stringify(bad));
});

test("the trust bundle is system roots PLUS ours, never ours alone", skip, () => {
  const dir = freshDir();
  const roots = path.join(dir, "fake-roots.pem");
  // A stand-in root store: two certs, so we can prove concatenation kept them.
  const other = ensureCa(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-ca-other-")))!;
  fs.writeFileSync(roots, `${other.certPem}${other.certPem}`);
  process.env.CHRONOS_EGRESS_SYSTEM_ROOTS = roots;
  resetCaCache();
  try {
    const ca = ensureCa(dir)!;
    assert.equal(ca.bundleComplete, true);
    const bundle = fs.readFileSync(caBundleFile(dir), "utf8");
    assert.equal(bundle.match(/BEGIN CERTIFICATE/g)!.length, 3, "2 system roots + ours");
    assert.ok(bundle.includes(ca.certPem.trim()));
    const env = caEnv(dir);
    assert.equal(env.NODE_EXTRA_CA_CERTS, ca.certFile);
    assert.equal(env.SSL_CERT_FILE, ca.bundleFile);
    assert.equal(env.CURL_CA_BUNDLE, ca.bundleFile);
    assert.equal(env.GIT_SSL_CAINFO, ca.bundleFile);
  } finally {
    delete process.env.CHRONOS_EGRESS_SYSTEM_ROOTS;
    resetCaCache();
  }
});

// Without a readable root store, replacing a child's whole trust store would strand it with one
// root and break every other TLS call — so only the appending var is set.
test("with no system root store, only NODE_EXTRA_CA_CERTS is exported", skip, () => {
  const dir = freshDir();
  process.env.CHRONOS_EGRESS_SYSTEM_ROOTS = path.join(dir, "does-not-exist.pem");
  resetCaCache();
  try {
    const ca = ensureCa(dir)!;
    assert.equal(ca.bundleComplete, false);
    const env = caEnv(dir);
    assert.equal(env.NODE_EXTRA_CA_CERTS, ca.certFile);
    assert.equal(env.SSL_CERT_FILE, undefined);
    assert.equal(env.CURL_CA_BUNDLE, undefined);
  } finally {
    delete process.env.CHRONOS_EGRESS_SYSTEM_ROOTS;
    resetCaCache();
  }
});

test("caEnv is empty when the CA cannot be established", () => {
  resetCaCache();
  // An un-creatable dir (a path under a regular file) is the portable way to fail mkdir.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-ca-")), "file");
  fs.writeFileSync(f, "x");
  assert.equal(ensureCa(path.join(f, "ca")), null);
  assert.deepEqual(caEnv(path.join(f, "ca")), {});
  resetCaCache();
});
