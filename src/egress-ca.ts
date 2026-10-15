import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inRepo } from "./repo-root.js";

// Local certificate authority for the egress credential broker. The broker's whole premise is that
// the daemon injects the auth header so the secret never enters the sandbox (src/broker.ts) — but
// agent traffic is HTTPS, and a forward proxy sees only an opaque CONNECT tunnel. To inject a header
// the proxy has to terminate TLS, which means serving a certificate the agent will trust: this CA.
//
// Deliberate limits, because a CA is the kind of thing that quietly becomes a machine-wide hole:
//   - It is NEVER added to the system keychain. Trust is distributed per-spawn via env
//     (NODE_EXTRA_CA_CERTS + a bundle for curl/git/python), so only the daemon's own children
//     trust it — not the operator's browser, not any other process on the Mac.
//   - The private keys live in a 0700 dir and are added to the Seatbelt deny list (config.ts), so a
//     sandboxed agent cannot read them and mint its own certs.
//   - Nothing here decides WHAT gets intercepted. Interception is opt-in per broker credential; a
//     host with no `intercept` cred stays an opaque tunnel (see src/egress.ts).
//
// Crypto: keys via node:crypto, X.509 via /usr/bin/openssl. Absolute path, not PATH-resolved — the
// daemon inherits launchd's PATH and `openssl` there may be nothing (same reasoning as SANDBOX_EXEC
// in sandbox.ts). macOS ships LibreSSL at that path on every machine; a missing binary is not fatal,
// it just means no interception (fail-closed onto the plain tunnel, never onto a bad cert).

export const OPENSSL = "/usr/bin/openssl";

const CA_DAYS = 3650;
const LEAF_DAYS = 30;
// Re-mint a cached leaf well before it expires, so a daemon that stays up for months never serves
// an expired cert (the cache is per-process and would otherwise outlive the certificate).
const LEAF_REFRESH_MS = 25 * 24 * 60 * 60 * 1000;
// Regenerate the CA when it has less than this left. Rotating invalidates every leaf, which is fine:
// leafs are cheap and agent processes pick up the new bundle on their next spawn.
const CA_MIN_REMAINING_SEC = 30 * 24 * 60 * 60;

export function defaultCaDir(): string {
  return process.env.CHRONOS_EGRESS_CA_DIR || inRepo("ca");
}
// The two files a sandboxed agent must never read. config.ts denies these by literal path; keep the
// names in sync with the deny list there.
export const caKeyFile = (dir = defaultCaDir()) => path.join(dir, "ca-key.pem");
export const leafKeyFile = (dir = defaultCaDir()) => path.join(dir, "leaf-key.pem");
// Readable by agents on purpose — a public cert is what trust distribution hands out.
export const caCertFile = (dir = defaultCaDir()) => path.join(dir, "ca-cert.pem");
export const caBundleFile = (dir = defaultCaDir()) => path.join(dir, "ca-bundle.pem");

export function opensslAvailable(): boolean {
  try {
    return fs.statSync(OPENSSL).isFile();
  } catch {
    return false;
  }
}

function ssl(args: string[]): Buffer {
  return execFileSync(OPENSSL, args, { timeout: 15_000, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "pipe"] });
}

function ecKeyPem(): string {
  return crypto
    .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

// Positive, 63-bit, unique per call. Explicit rather than -CAcreateserial: that flag drops a .srl
// file next to the CA key and makes serials sequential (and thus guessable) across restarts.
function serial(): string {
  return "0x" + (crypto.randomBytes(8).readBigUInt64BE() >> 1n).toString(16);
}

// A hostname straight off the wire (the CONNECT line) ends up inside an openssl SAN extension and a
// -subj string, so it is validated as a hostname BEFORE it reaches either. execFile already rules
// out a shell, but `/CN=` and the ext file are their own little parsers — an unvalidated
// "a/O=Evil" or a newline would rewrite the subject or inject a second extension.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function validHost(host: string): boolean {
  if (typeof host !== "string" || !host || host.length > 253) return false;
  if (net.isIP(host) !== 0) return true;
  return HOSTNAME_RE.test(host);
}

export interface Ca {
  dir: string;
  certFile: string;
  keyFile: string;
  bundleFile: string;
  /** True when the bundle is system roots + our CA, i.e. safe to hand to SSL_CERT_FILE-style vars. */
  bundleComplete: boolean;
  certPem: string;
  fingerprint: string;
}

let cached: Ca | null = null;
const leafs = new Map<string, { key: string; cert: string; refreshAt: number }>();

// macOS's OpenSSL-flavoured root store. Tools that honour SSL_CERT_FILE / CURL_CA_BUNDLE replace
// their whole trust store with what we point them at, so the bundle must be roots + ours; if the
// system file is missing we say so (bundleComplete=false) and the caller falls back to
// NODE_EXTRA_CA_CERTS only, which APPENDS and therefore can't strand a child with no roots at all.
const systemRootsFile = () => process.env.CHRONOS_EGRESS_SYSTEM_ROOTS || "/etc/ssl/cert.pem";

function fingerprintOf(certFile: string): string {
  const out = ssl(["x509", "-in", certFile, "-noout", "-fingerprint", "-sha256"]).toString();
  return (out.split("=")[1] ?? "").trim();
}

// `-checkend 0` exits non-zero once the cert is expired; any parse failure lands here too, which is
// what we want — an unreadable CA should be replaced, not trusted.
function certValidFor(certFile: string, seconds: number): boolean {
  try {
    ssl(["x509", "-in", certFile, "-noout", "-checkend", String(seconds)]);
    return true;
  } catch {
    return false;
  }
}

function writeSecret(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // writeFileSync's mode only applies on create; an existing file keeps its own
}

function buildBundle(dir: string, caPem: string): boolean {
  let roots = "";
  try {
    roots = fs.readFileSync(systemRootsFile(), "utf8");
  } catch {
    roots = "";
  }
  const complete = roots.includes("BEGIN CERTIFICATE");
  fs.writeFileSync(caBundleFile(dir), complete ? `${roots.trimEnd()}\n${caPem}` : caPem, { mode: 0o644 });
  return complete;
}

function makeCa(dir: string): void {
  writeSecret(caKeyFile(dir), ecKeyPem());
  writeSecret(leafKeyFile(dir), ecKeyPem());
  ssl([
    "req", "-x509", "-new",
    "-key", caKeyFile(dir),
    "-sha256", "-days", String(CA_DAYS),
    "-subj", "/CN=Chronos Egress Broker CA/O=Chronos",
    "-out", caCertFile(dir),
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  fs.chmodSync(caCertFile(dir), 0o644);
}

/**
 * Load (or create) the CA. Idempotent and cheap after the first call. Returns null when the CA
 * cannot be established — no openssl, unwritable dir — so callers degrade to a plain CONNECT tunnel
 * rather than breaking egress.
 */
export function ensureCa(dir = defaultCaDir()): Ca | null {
  if (cached && cached.dir === dir) return cached;
  if (!opensslAvailable()) {
    warnOnce("openssl", `[egress-ca] ${OPENSSL} not found — TLS interception disabled`);
    return null;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const fresh =
      !fs.existsSync(caKeyFile(dir)) ||
      !fs.existsSync(leafKeyFile(dir)) ||
      !fs.existsSync(caCertFile(dir)) ||
      !certValidFor(caCertFile(dir), CA_MIN_REMAINING_SEC);
    if (fresh) {
      makeCa(dir);
      leafs.clear(); // every cached leaf was signed by the CA we just replaced
      console.log(`[egress-ca] issued CA at ${caCertFile(dir)}`);
    }
    // A key another user can read defeats the deny list, exactly like the broker file (broker.ts).
    for (const f of [caKeyFile(dir), leafKeyFile(dir)]) {
      try {
        if (fs.statSync(f).mode & 0o077) warnOnce(`mode:${f}`, `[egress-ca] ${f} is group/other-readable (chmod 600 it)`);
      } catch {}
    }
    const certPem = fs.readFileSync(caCertFile(dir), "utf8");
    const ca: Ca = {
      dir,
      certFile: caCertFile(dir),
      keyFile: caKeyFile(dir),
      bundleFile: caBundleFile(dir),
      bundleComplete: buildBundle(dir, certPem),
      certPem,
      fingerprint: fingerprintOf(caCertFile(dir)),
    };
    if (!ca.bundleComplete)
      warnOnce("roots", `[egress-ca] ${systemRootsFile()} unreadable — trusting the CA via NODE_EXTRA_CA_CERTS only`);
    cached = ca;
    return ca;
  } catch (e: any) {
    warnOnce("ensure", `[egress-ca] cannot establish CA in ${dir}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Key + cert to serve for `host`, signed by the CA. Cached per host (≈20ms to mint). Returns null
 * for a host that fails validation or when the CA is unavailable — the caller must then NOT
 * intercept that connection.
 */
export function leafFor(host: string, dir = defaultCaDir()): { key: string; cert: string } | null {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!validHost(h)) return null;
  const hit = leafs.get(h);
  if (hit && hit.refreshAt > Date.now()) return { key: hit.key, cert: hit.cert };
  const ca = ensureCa(dir);
  if (!ca) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-leaf-"));
  try {
    const ext = path.join(tmp, "ext");
    const csr = path.join(tmp, "csr");
    const san = net.isIP(h) !== 0 ? `IP:${h}` : `DNS:${h}`;
    fs.writeFileSync(
      ext,
      [
        `subjectAltName=${san}`,
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
    );
    ssl(["req", "-new", "-key", leafKeyFile(dir), "-subj", `/CN=${h}`, "-out", csr]);
    const cert = ssl([
      "x509", "-req", "-in", csr,
      "-CA", ca.certFile, "-CAkey", ca.keyFile,
      "-set_serial", serial(),
      "-days", String(LEAF_DAYS), "-sha256",
      "-extfile", ext,
    ]).toString();
    const key = fs.readFileSync(leafKeyFile(dir), "utf8");
    leafs.set(h, { key, cert, refreshAt: Date.now() + LEAF_REFRESH_MS });
    return { key, cert };
  } catch (e: any) {
    warnOnce(`leaf:${h}`, `[egress-ca] cannot issue leaf for ${h}: ${e?.message ?? e}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Env that makes a spawned agent trust this CA — and ONLY the spawned agent. NODE_EXTRA_CA_CERTS
 * appends to node's built-in roots; the SSL_CERT_FILE family replaces the store wholesale, so those
 * are set only when the bundle really is system-roots-plus-ours.
 */
export function caEnv(dir = defaultCaDir()): Record<string, string> {
  const ca = ensureCa(dir);
  if (!ca) return {};
  const env: Record<string, string> = { NODE_EXTRA_CA_CERTS: ca.certFile };
  if (ca.bundleComplete) {
    env.SSL_CERT_FILE = ca.bundleFile;
    env.CURL_CA_BUNDLE = ca.bundleFile;
    env.GIT_SSL_CAINFO = ca.bundleFile;
    env.REQUESTS_CA_BUNDLE = ca.bundleFile; // python-requests
    env.AWS_CA_BUNDLE = ca.bundleFile;
  }
  return env;
}

/** Test seam: drop the in-process CA/leaf caches (they key off a dir that a test may recreate). */
export function resetCaCache(): void {
  cached = null;
  leafs.clear();
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}
