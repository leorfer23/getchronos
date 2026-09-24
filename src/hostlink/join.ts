/**
 * Trust material for the brain ⇄ host link: join codes, host credentials, and the brain's own TLS
 * certificate (HOSTS.md → Security).
 *
 * The chain of trust, in the order it is built:
 *
 *  1. The operator mints a **join code** on the brain (admin only). It is single-use, dies in 15
 *     minutes, and carries the SHA-256 fingerprint of the brain's TLS cert plus the URLs the brain can
 *     be reached at. It travels out-of-band — the operator copies one command onto the new Mac.
 *  2. `host join` connects to the URL, checks the cert against the fingerprint **before sending
 *     anything**, and only then presents the code. There is no trust-on-first-use: a man in the
 *     middle on the LAN has a different cert and never sees the code.
 *  3. The brain consumes the code and answers with a **host credential**: an id and 32 random bytes.
 *     The brain keeps only a hash of the token, so a copy of its state files does not let anyone
 *     impersonate a host.
 *
 * Nothing here touches the network; `brain-link.ts` and `hostd/` do that.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inRepo } from "../repo-root.js";

// ───────────────────────────── fingerprints ─────────────────────────────

/** Canonical fingerprint form: 64 lowercase hex chars, no colons. Accepts Node's `AA:BB:…` form too. */
export function normalizeFp(fp: string | null | undefined): string {
  return String(fp ?? "").replace(/:/g, "").trim().toLowerCase();
}

/** SHA-256 over the DER certificate — the same value `openssl x509 -fingerprint -sha256` prints. */
export function fingerprintOfPem(pem: string): string {
  return normalizeFp(new crypto.X509Certificate(pem).fingerprint256);
}

/** Constant-time: a fingerprint is not secret, but comparing it this way costs nothing and never leaks. */
export function fpEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = Buffer.from(normalizeFp(a)), y = Buffer.from(normalizeFp(b));
  return x.length === 64 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ───────────────────────────── join codes ─────────────────────────────

export const JOIN_TTL_MS = 15 * 60 * 1000;
const CODE_PREFIX = "CHR1-";

export type JoinCodePayload = {
  /** The single-use secret. Only its hash is kept on the brain. */
  secret: string;
  /** Brain TLS cert fingerprint (normalized hex); "" when the brain has no cert (tunnel-only). */
  fp: string;
  /** Where the brain said it can be reached, best first. The URL typed into `join` wins over these. */
  urls: string[];
};

/**
 * The code is self-describing so the join command stays one line: `CHR1-<base64url(json)>`. It is
 * long (~150 chars with two URLs) — that is fine for copy-paste, and embedding the fingerprint is
 * the whole point: the operator never has to compare hex by eye.
 */
export function encodeJoinCode(p: JoinCodePayload): string {
  const json = JSON.stringify({ s: p.secret, fp: normalizeFp(p.fp), u: p.urls });
  return CODE_PREFIX + Buffer.from(json).toString("base64url");
}

export function decodeJoinCode(code: string): JoinCodePayload | null {
  const c = String(code ?? "").trim();
  if (!c.startsWith(CODE_PREFIX)) return null;
  try {
    const v = JSON.parse(Buffer.from(c.slice(CODE_PREFIX.length), "base64url").toString("utf8"));
    if (!v || typeof v.s !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(v.s)) return null;
    const fp = normalizeFp(v.fp);
    if (fp && !/^[0-9a-f]{64}$/.test(fp)) return null;
    const urls = Array.isArray(v.u) ? v.u.filter((x: unknown): x is string => typeof x === "string") : [];
    return { secret: v.s, fp, urls };
  } catch {
    return null;
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export type JoinConsume = { ok: true; name: string | null } | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Outstanding join codes, **in memory on purpose**. A code lives 15 minutes; a brain restart inside
 * that window costs the operator one click to mint another, and not persisting means a code can
 * never be recovered from a disk image or a backup. Keyed by the secret's hash, so even a heap dump
 * does not hand out usable codes.
 */
export class JoinCodes {
  private live = new Map<string, { expires: number; name: string | null }>();
  /** Recently consumed hashes, so a second use says "used" rather than a vaguer "unknown". */
  private used = new Map<string, number>();

  constructor(private readonly opts: { ttlMs?: number; now?: () => number } = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private ttl(): number { return this.opts.ttlMs ?? JOIN_TTL_MS; }

  mint(p: { fp: string; urls: string[]; name?: string | null }): { code: string; expires_at: number } {
    this.prune();
    const secret = crypto.randomBytes(18).toString("base64url");
    const expires_at = this.now() + this.ttl();
    this.live.set(sha256(secret), { expires: expires_at, name: p.name ?? null });
    return { code: encodeJoinCode({ secret, fp: p.fp, urls: p.urls }), expires_at };
  }

  /** Single use: a valid code is deleted by the call that accepts it, before anything else happens. */
  consume(secret: string): JoinConsume {
    const h = sha256(String(secret ?? ""));
    const entry = this.live.get(h);
    if (!entry) return { ok: false, reason: this.used.has(h) ? "used" : "unknown" };
    this.live.delete(h);
    if (entry.expires <= this.now()) return { ok: false, reason: "expired" };
    this.used.set(h, entry.expires);
    return { ok: true, name: entry.name };
  }

  pending(): number { this.prune(); return this.live.size; }

  private prune(): void {
    const now = this.now();
    for (const [h, e] of this.live) if (e.expires <= now) this.live.delete(h);
    for (const [h, exp] of this.used) if (exp <= now) this.used.delete(h);
  }
}

// ───────────────────────────── host credentials ─────────────────────────────

/** A host id is public (it shows on the Desk); the token is the secret. */
export function mintHostCredential(): { host_id: string; token: string } {
  return {
    host_id: "h_" + crypto.randomBytes(6).toString("hex"),
    token: crypto.randomBytes(32).toString("base64url"),
  };
}

export function hashToken(token: string): string {
  return sha256(String(token));
}

/**
 * Compare a presented token against a stored hash in constant time. Hashing first makes both sides
 * the same length whatever was presented, so `timingSafeEqual` never throws and the length of the
 * real token never leaks either.
 */
export function tokenMatches(presented: string | null | undefined, storedHash: string | null | undefined): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashToken(presented), "hex");
  const b = Buffer.from(String(storedHash), "hex");
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

export type HostRecord = { host_id: string; name: string; token_hash: string; created_at: number; revoked_at?: number | null };

export function hostlinkDir(): string {
  return process.env.CHRONOS_HOSTLINK_DIR || inRepo("hostlink");
}

/**
 * Joined hosts and their token hashes, kept in `<data>/hostlink/hosts.json` (mode 600).
 *
 * INTERIM: Phase 1 adds the `hosts` table (`token_hash`, `cert_fp`, `status`, …). This file exists
 * only so a host that joined keeps working across a brain deploy before that table lands.
 * TODO(hosts-p1): upsert into `hosts` and read `token_hash` from there; import this file once, then
 * delete it.
 */
export class HostCredStore {
  constructor(readonly file = path.join(hostlinkDir(), "hosts.json")) {}

  list(): HostRecord[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v.filter((r) => r && typeof r.host_id === "string" && typeof r.token_hash === "string") : [];
    } catch {
      return [];
    }
  }

  get(hostId: string): HostRecord | null {
    return this.list().find((r) => r.host_id === hostId && !r.revoked_at) ?? null;
  }

  add(r: HostRecord): void {
    this.write([...this.list().filter((x) => x.host_id !== r.host_id), r]);
  }

  revoke(hostId: string, at = Date.now()): boolean {
    const all = this.list();
    const r = all.find((x) => x.host_id === hostId && !x.revoked_at);
    if (!r) return false;
    r.revoked_at = at;
    this.write(all);
    return true;
  }

  verify(hostId: string, token: string): HostRecord | null {
    const r = this.get(hostId);
    // Hash compare runs even for an unknown id (against a dummy), so "no such host" and "wrong token"
    // take the same time.
    const ok = tokenMatches(token, r?.token_hash ?? "0".repeat(64));
    return r && ok ? r : null;
  }

  private write(rows: HostRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }
}

// ───────────────────────────── the brain's TLS certificate ─────────────────────────────

/**
 * Why openssl and not a library: Node can parse X.509 (`crypto.X509Certificate`) but cannot issue
 * one, and nothing in node_modules does (no `selfsigned`/`node-forge`). Pulling in node-forge — a
 * pure-JS crypto stack — to write one certificate every ten years is a poor trade. `egress-ca.ts`
 * already issues its CA this way: key from node:crypto, certificate from `/usr/bin/openssl` (LibreSSL,
 * present on every Mac; absolute path because launchd's PATH may lack it). No openssl means no LAN
 * listener — the tunnel path still works — which is the same fail-closed shape egress uses.
 */
export const OPENSSL = process.env.CHRONOS_OPENSSL || "/usr/bin/openssl";
const CERT_DAYS = 3650;

export type BrainCert = { keyPem: string; certPem: string; fingerprint: string; keyFile: string; certFile: string };

export const brainKeyFile = (dir = hostlinkDir()) => path.join(dir, "brain-key.pem");
export const brainCertFile = (dir = hostlinkDir()) => path.join(dir, "brain-cert.pem");

let certCache: BrainCert | null = null;

/**
 * Load or create the brain's self-signed cert. Rotating it (deleting the files) breaks every pinned
 * host until it re-joins — deliberately: a changed cert is indistinguishable from an impostor.
 */
export function ensureBrainCert(dir = hostlinkDir()): BrainCert | null {
  if (certCache && certCache.keyFile === brainKeyFile(dir)) return certCache;
  const keyFile = brainKeyFile(dir), certFile = brainCertFile(dir);
  try {
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      if (!fs.existsSync(OPENSSL)) {
        console.warn(`[hostlink] ${OPENSSL} not found — no brain TLS cert, so no LAN host listener (the tunnel path still works)`);
        return null;
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      execFileSync(OPENSSL, ["req", "-x509", "-new", "-key", keyFile, "-sha256", "-days", String(CERT_DAYS), "-subj", "/CN=chronos-brain", "-out", certFile], {
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      fs.chmodSync(certFile, 0o644);
      console.log(`[hostlink] issued brain TLS cert at ${certFile}`);
    }
    try { if (fs.statSync(keyFile).mode & 0o077) fs.chmodSync(keyFile, 0o600); } catch {}
    const keyPem = fs.readFileSync(keyFile, "utf8");
    const certPem = fs.readFileSync(certFile, "utf8");
    certCache = { keyPem, certPem, fingerprint: fingerprintOfPem(certPem), keyFile, certFile };
    return certCache;
  } catch (e: any) {
    console.warn(`[hostlink] cannot establish brain TLS cert in ${dir}: ${e?.message ?? e}`);
    return null;
  }
}

/** Test-only: forget the cached cert (tests point CHRONOS_HOSTLINK_DIR at a tmp dir). */
export function resetBrainCertCache(): void { certCache = null; }
