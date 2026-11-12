/**
 * Pairing: how a browser gets signed in without anyone copying the admin token.
 *
 * `npm run desk` (scripts/open-desk.mjs) reads the token from the checkout — it runs as the operator,
 * in their terminal — and trades it for a one-time code (POST /pair). It opens
 * `/desk#pair=<code>`; static/pair.js takes the code out of the address bar before anything else runs
 * and redeems it (POST /pair/redeem), which hands back the token exactly once. The phone's QR code is
 * the same code in an https link (PR C).
 *
 * Why this shape:
 *  - The code rides in the URL's fragment, which a browser never sends to a server, and pair.js
 *    replaces the history entry at once, so it is in no log, no Referer and no back button.
 *  - Single use, five minutes, 192 random bits, in memory only: a code seen after the browser used
 *    it is worthless, and a restart forgets every code.
 *  - Minting needs the operator's own credential — the admin token itself, from this Mac. A Robert's
 *    derived credential is refused (it would make a Robert able to mint the operator's token), and so
 *    is any request a host link replayed (`forwardedHost`).
 *  - Redeeming needs nothing but the code (that is the point), so it is rate limited per caller and
 *    every failure — unknown, expired, already used, malformed — is the same 410 with the same words.
 */
import crypto from "node:crypto";
import express from "express";
import { CONFIG } from "./config.js";
import { robertIdentity, tokenOk } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";

export const PAIR_TTL_MS = 5 * 60_000;
/** Outstanding codes kept at once; minting past it drops the oldest. Minting is operator-only, so this is hygiene, not defense. */
const MAX_CODES = 20;

export const PAIR_GONE = "this sign-in link has expired or was already used — run `npm run desk` again";

export class PairCodes {
  private codes = new Map<string, number>(); // code → expires at (ms)
  constructor(private ttlMs = PAIR_TTL_MS, private now: () => number = Date.now) {}

  mint(): { code: string; expiresAt: number } {
    this.prune();
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value as string);
    const code = crypto.randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** True once per live code. The code is gone after the first look, used or not. */
  redeem(code: unknown): boolean {
    if (typeof code !== "string" || code.length > 200) return false;
    const exp = this.codes.get(code);
    this.codes.delete(code);
    this.prune();
    return exp !== undefined && exp > this.now();
  }

  get size(): number {
    return this.codes.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp <= t) this.codes.delete(c);
  }
}

/** Fixed-window counter per caller: `limit` tries a minute. Bounded: past 1000 callers the oldest windows go. */
export class RateLimit {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private limit = 10, private windowMs = 60_000, private now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || t - cur.start >= this.windowMs) {
      if (this.hits.size >= 1000) for (const [k, v] of this.hits) if (t - v.start >= this.windowMs || this.hits.size >= 1000) this.hits.delete(k);
      this.hits.set(key, { start: t, n: 1 });
      return true;
    }
    cur.n++;
    return cur.n <= this.limit;
  }
}

/**
 * Who is redeeming, for the rate limit. Through a tunnel (Tailscale serve, cloudflared) every request
 * arrives from 127.0.0.1, so the proxy's client header splits callers when there is one; a forged one
 * buys an attacker a fresh window of ten guesses at a 192-bit code — nothing.
 */
function callerKey(req: express.Request): string {
  const fwd = String(req.get("cf-connecting-ip") ?? req.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return `${req.socket?.remoteAddress ?? "?"}|${fwd.slice(0, 64)}`;
}

export const pairCodes = new PairCodes();

export function pairRoutes(o: { codes?: PairCodes; limiter?: RateLimit; forwarded?: (req: express.Request) => string | null } = {}): express.Router {
  const codes = o.codes ?? pairCodes;
  const limiter = o.limiter ?? new RateLimit();
  const forwarded = o.forwarded ?? forwardedHost;
  const r = express.Router();

  r.post("/pair", (req, res) => {
    if (forwarded(req) !== null) return res.status(403).json({ error: "a sign-in link can't be made through another computer's link" });
    const got = req.get("x-mc-admin");
    if (!tokenOk(got, CONFIG.adminToken)) {
      const why = robertIdentity(got) ? "a Robert can't make a sign-in link — only you can (npm run desk)" : "admin token required (x-mc-admin)";
      return res.status(403).json({ error: why });
    }
    const { code, expiresAt } = codes.mint();
    res.set("Cache-Control", "no-store");
    res.status(201).json({ code, expires_at: new Date(expiresAt).toISOString() });
  });

  r.post("/pair/redeem", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (forwarded(req) !== null) return res.status(410).json({ error: PAIR_GONE });
    if (!limiter.allow(callerKey(req))) return res.status(429).json({ error: "too many tries — wait a minute, then run `npm run desk` again" });
    if (!codes.redeem(req.body?.code)) return res.status(410).json({ error: PAIR_GONE });
    res.json({ token: CONFIG.adminToken });
  });

  return r;
}
