import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOIN_TTL_MS, JoinCodes, OPENSSL, decodeJoinCode, encodeJoinCode, ensureBrainCert, fingerprintOfPem, fpEqual,
  hashToken, mintHostCredential, normalizeFp, resetBrainCertCache, tokenMatches,
} from "./join.js";
import { classifyBrainUrl, isLoopbackHost } from "./pin.js";

const FP = "ab".repeat(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hostlink-join-"));

// ───────────────────────────── codes ─────────────────────────────

test("a join code carries the secret, the fingerprint and the URL hints", () => {
  const code = encodeJoinCode({ secret: "s".repeat(24), fp: FP.toUpperCase().match(/../g)!.join(":"), urls: ["wss://10.0.0.2:7779/host"] });
  assert.match(code, /^CHR1-[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeJoinCode(code), { secret: "s".repeat(24), fp: FP, urls: ["wss://10.0.0.2:7779/host"] });
});

test("garbage, a foreign prefix, a short secret or a malformed fingerprint do not decode", () => {
  assert.equal(decodeJoinCode("hello"), null);
  assert.equal(decodeJoinCode("CHR1-!!!"), null);
  assert.equal(decodeJoinCode("XYZ-" + Buffer.from('{"s":"aaaaaaaaaaaaaaaaaaaa"}').toString("base64url")), null);
  assert.equal(decodeJoinCode(encodeJoinCode({ secret: "short", fp: FP, urls: [] })), null);
  assert.equal(decodeJoinCode("CHR1-" + Buffer.from(JSON.stringify({ s: "a".repeat(20), fp: "nothex", u: [] })).toString("base64url")), null);
  // No fingerprint is allowed (tunnel-only brain); non-string URLs are dropped.
  const p = decodeJoinCode("CHR1-" + Buffer.from(JSON.stringify({ s: "a".repeat(20), fp: "", u: ["wss://x/host", 5] })).toString("base64url"));
  assert.deepEqual(p, { secret: "a".repeat(20), fp: "", urls: ["wss://x/host"] });
});

test("codes are single use", () => {
  const codes = new JoinCodes();
  const { code } = codes.mint({ fp: FP, urls: [], name: "m2" });
  const secret = decodeJoinCode(code)!.secret;
  assert.deepEqual(codes.consume(secret), { ok: true, name: "m2" });
  assert.deepEqual(codes.consume(secret), { ok: false, reason: "used" });
});

test("codes expire after the TTL (15 minutes by default)", () => {
  let now = 1_000_000;
  const codes = new JoinCodes({ now: () => now });
  const { code, expires_at } = codes.mint({ fp: FP, urls: [] });
  assert.equal(expires_at, now + JOIN_TTL_MS);
  now += JOIN_TTL_MS;
  assert.deepEqual(codes.consume(decodeJoinCode(code)!.secret), { ok: false, reason: "expired" });
});

test("an unknown secret is refused and expired codes are pruned", () => {
  let now = 0;
  const codes = new JoinCodes({ ttlMs: 10, now: () => now });
  codes.mint({ fp: FP, urls: [] });
  assert.equal(codes.pending(), 1);
  now = 11;
  assert.equal(codes.pending(), 0);
  assert.deepEqual(codes.consume("nope-nope-nope-nope"), { ok: false, reason: "unknown" });
});

test("the brain never stores a code in the clear", () => {
  const codes = new JoinCodes();
  const { code } = codes.mint({ fp: FP, urls: [] });
  const secret = decodeJoinCode(code)!.secret;
  assert.ok(!JSON.stringify([...(codes as any).live.keys()]).includes(secret));
});

// ───────────────────────────── credentials ─────────────────────────────

test("a host credential is 32 random bytes; only its hash matches", () => {
  const c = mintHostCredential();
  assert.match(c.host_id, /^h_[0-9a-f]{12}$/);
  assert.equal(Buffer.from(c.token, "base64url").length, 32);
  const h = hashToken(c.token);
  assert.equal(tokenMatches(c.token, h), true);
  assert.equal(tokenMatches(c.token + "x", h), false);
  assert.equal(tokenMatches("", h), false);
  assert.equal(tokenMatches(c.token, ""), false);
  assert.equal(tokenMatches(c.token, "zz"), false);
});

// ───────────────────────────── fingerprints + cert ─────────────────────────────

test("fingerprints normalize and compare in either notation", () => {
  const colon = FP.toUpperCase().match(/../g)!.join(":");
  assert.equal(normalizeFp(colon), FP);
  assert.equal(fpEqual(colon, FP), true);
  assert.equal(fpEqual(FP, "cd".repeat(32)), false);
  assert.equal(fpEqual("", ""), false, "two empty pins never match");
});

test("the brain cert is made once, key at 600, and its fingerprint is stable", { skip: !fs.existsSync(OPENSSL) && "no openssl" }, () => {
  const dir = tmp();
  resetBrainCertCache();
  const a = ensureBrainCert(dir)!;
  assert.ok(a, "cert issued");
  assert.equal(fs.statSync(a.keyFile).mode & 0o777, 0o600);
  assert.equal(a.fingerprint, fingerprintOfPem(a.certPem));
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  resetBrainCertCache();
  const b = ensureBrainCert(dir)!;
  assert.equal(b.fingerprint, a.fingerprint, "reloaded, not re-issued");
  resetBrainCertCache();
});

// ───────────────────────────── URL policy ─────────────────────────────

test("LAN names and IPs are pinned, public names use CA trust, plain ws only on loopback", () => {
  const k = (u: string) => { const r = classifyBrainUrl(u); return r.ok ? r.kind : "refused"; };
  assert.equal(k("wss://192.168.1.20:7779/host"), "pinned");
  assert.equal(k("wss://[fe80::1]:7779/host"), "pinned");
  assert.equal(k("wss://brain.local:7779/host"), "pinned");
  assert.equal(k("wss://brain.lan:7779/host"), "pinned");
  assert.equal(k("wss://localhost:7779/host"), "pinned");
  assert.equal(k("wss://desk.example.com/host"), "ca");
  assert.equal(k("ws://127.0.0.1:7777/host"), "loopback-plain");
  assert.equal(k("ws://localhost:7777/host"), "loopback-plain");
  assert.equal(k("ws://192.168.1.20:7779/host"), "refused");
  assert.equal(k("ws://desk.example.com/host"), "refused");
  assert.equal(k("https://desk.example.com/host"), "refused");
  assert.equal(k("not a url"), "refused");
  assert.equal(isLoopbackHost("127.9.9.9"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("10.0.0.1"), false);
});
