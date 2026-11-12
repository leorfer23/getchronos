/**
 * The owner gate: a request that came in through Tailscale gets past only if Tailscale says it is the
 * operator's own account. Mounted first on the whole app (pages, static files, /api) and on every
 * WebSocket upgrade — nothing in the daemon runs for a refused request.
 *
 * Why it exists. `tailscale serve` (phone-access.ts) proxies https://<machine>.<tailnet>.ts.net to
 * http://127.0.0.1:<port>, so every request a phone makes arrives on loopback — exactly like a local
 * agent's. And a tailnet is not one person: a company tailnet holds colleagues, shared nodes and
 * tagged servers. Without this gate any of them could open the serve URL and get what a tokenless
 * local caller gets, which in the default CHRONOS_TOKENLESS=log mode is most of the API (authz.ts
 * callerScope: no token on loopback = unrestricted) — reads across every workspace, and POST /jobs or
 * POST /sessions, i.e. an agent with permission prompts off.
 *
 * How it decides (phoneGateVerdict):
 *  - Not from Tailscale at all (a local process, the Cloudflare tunnel) → untouched.
 *  - From Tailscale = any of: Tailscale's identity header, its Funnel marker, its info header, a
 *    `*.ts.net` Host / X-Forwarded-Host (serve keeps the browser's Host), or an X-Forwarded-For
 *    address in Tailscale's ranges (100.64.0.0/10, fd7a:115c:a1e0::/48 — serve always sets it).
 *  - Funnel (public internet) → refused. Chronos never turns Funnel on; someone else did.
 *  - No identity → refused. Serve sends none for tagged devices (tailscale.com/kb/1312/serve); a
 *    tagged node has no person behind it to compare with the owner, and "a server in the company
 *    tailnet" is exactly who must not get in.
 *  - Identity ≠ the owner recorded when the operator turned phone access on → refused. No owner
 *    recorded yet → refused too (fail closed until the Desk's Phone dialog has run once).
 *
 * Why a forged header is harmless. Serve deletes any Tailscale-User-* / Tailscale-Funnel-Request /
 * Tailscale-Headers-Info a client sent and writes its own (tailscale ipnlocal/serve.go), so through
 * Tailscale the header is the truth. A process ON this Mac can send whatever it likes — and that only
 * ever makes it MORE restricted: this gate only refuses, and nothing downstream reads these headers or
 * X-Forwarded-* (there is no `trust proxy`; authz.ts decides on tokens alone). Forging the owner's login
 * gets a local caller exactly what it gets with no header at all; forging anything else gets a 403.
 * The gate grants nothing — a phone that is the owner still needs the admin token for everything
 * that needs it (pairing hands it over once; static/pair.js).
 */
import type express from "express";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { kv } from "./store.js";

/** kv key of the owner's Tailscale login (the LoginName from `tailscale status --json`). */
export const PHONE_OWNER_KEY = "phone.tailscale.owner";

let ownerCache: string | null | undefined; // undefined = not read from kv yet
/** The owner recorded when the operator turned phone access on, or null. */
export function phoneOwner(): string | null {
  if (ownerCache === undefined) ownerCache = kv.get(PHONE_OWNER_KEY) || null;
  return ownerCache;
}
export function setPhoneOwner(login: string | null): void {
  if (login) kv.set(PHONE_OWNER_KEY, login);
  else kv.del(PHONE_OWNER_KEY);
  ownerCache = login || null;
}

export type GateRefusal = "funnel" | "anonymous" | "not-enabled" | "stranger";
export type GateVerdict = { ok: true } | { ok: false; reason: GateRefusal };

const isTsNetHost = (v: string | undefined): boolean => {
  if (!v) return false;
  // "host:443", "[v6]:443", a trailing dot — reduce to the bare lowercase name.
  const host = v.trim().toLowerCase().replace(/^\[([^\]]*)\](:\d+)?$/, "$1").replace(/:\d+$/, "").replace(/\.$/, "");
  return host === "ts.net" || host.endsWith(".ts.net");
};

/** An address Tailscale hands out: 100.64.0.0/10 (CGNAT) or fd7a:115c:a1e0::/48 (its ULA). */
export function isTailscaleAddr(raw: string): boolean {
  const a = raw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/.test(a);
}
const forwardedFromTailnet = (xff: string | undefined): boolean => !!xff && xff.split(",").some((p) => isTailscaleAddr(p));

/**
 * RFC 2047 "Q" words (`=?utf-8?q?...?=`) → text. Serve Q-encodes a login with non-ASCII characters
 * (encTailscaleHeaderValue); ASCII logins arrive as they are. Only UTF-8 Q words decode; anything
 * else is null, which never matches an owner.
 */
export function decodeQWords(v: string): string | null {
  const words = v.trim().split(/\s+/);
  const bytes: number[] = [];
  for (const w of words) {
    const m = /^=\?utf-8\?q\?([^?]*)\?=$/i.exec(w);
    if (!m) return null;
    const s = m[1];
    for (let i = 0; i < s.length; i++) {
      const hex = s.slice(i + 1, i + 3);
      if (s[i] === "_") bytes.push(0x20);
      else if (s[i] === "=" && /^[0-9a-f]{2}$/i.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
      else bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Is the login serve sent this owner's? Byte-for-byte for an ASCII owner (nearly everyone: emails,
 * `name@github`) — no decoding path at all, so nothing can be smuggled in through one. Only an owner
 * with non-ASCII characters compares against the decoded header. (Tailscale leaves an ASCII value
 * that merely looks like a Q word unescaped, so in that one case a different account would need a
 * login name that is itself the Q encoding of the owner's — not a valid email address.)
 */
export function loginMatches(header: string, owner: string): boolean {
  if (header === owner) return true;
  if (/^[\x20-\x7e]*$/.test(owner)) return false;
  return decodeQWords(header) === owner;
}

/** Pure: may this request through? `get` reads a request header (case-insensitive), `owner` the recorded login. */
export function phoneGateVerdict(get: (name: string) => string | undefined, owner: string | null): GateVerdict {
  const login = get("tailscale-user-login");
  const funnel = get("tailscale-funnel-request") !== undefined;
  const viaTailscale = login !== undefined || funnel || get("tailscale-headers-info") !== undefined
    || isTsNetHost(get("host")) || isTsNetHost(get("x-forwarded-host")) || forwardedFromTailnet(get("x-forwarded-for"));
  if (!viaTailscale) return { ok: true };
  if (funnel) return { ok: false, reason: "funnel" };
  if (!login) return { ok: false, reason: "anonymous" };
  if (!owner) return { ok: false, reason: "not-enabled" };
  return loginMatches(login, owner) ? { ok: true } : { ok: false, reason: "stranger" };
}

/** What the refused caller reads. Nothing about the owner — not even that one is set, beyond "not you". */
export const REFUSAL_TEXT: Record<GateRefusal, string> = {
  funnel: "This Chronos is not shared on the public internet.",
  anonymous: "This Chronos only answers its owner, and Tailscale didn't say who you are (requests from tagged devices carry no identity). Open it from a phone or computer signed in to the owner's Tailscale account.",
  "not-enabled": "Phone access over Tailscale isn't turned on for this Chronos yet. On the Mac, open the Desk → ⋯ → Phone.",
  stranger: "This Chronos only answers its owner. You're signed in to Tailscale with a different account — sign in with the owner's account on this device.",
};

// One log line per reason a minute: a busy stranger must not fill the log. No login in it — whoever
// knocked is a person on someone's tailnet, and the daemon log is not the place for their address.
const lastLogged = new Map<GateRefusal, number>();
function note(reason: GateRefusal, method: string, path: string): void {
  const now = Date.now();
  if (now - (lastLogged.get(reason) ?? 0) < 60_000) return;
  lastLogged.set(reason, now);
  console.warn(`[phone] refused a request that came through Tailscale (${reason}): ${method} ${path.split("?")[0].slice(0, 120)}`);
}

/** Express: the first middleware on the app — before the body parsers, the API, the pages. */
export function phoneOwnerGate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const v = phoneGateVerdict((n) => req.get(n), phoneOwner());
  if (v.ok) return next();
  note(v.reason, req.method, req.originalUrl || req.url);
  res.status(403).set("Cache-Control", "no-store");
  if ((req.originalUrl || req.url).startsWith("/api/")) res.json({ error: REFUSAL_TEXT[v.reason] });
  else res.type("text/plain; charset=utf-8").send(REFUSAL_TEXT[v.reason]);
}

/** The same rule for WebSocket upgrades (/ws, /term, the /host door), which never touch Express. False = refused and closed. */
export function phoneUpgradeGate(req: http.IncomingMessage, socket: Duplex): boolean {
  const get = (n: string) => {
    const h = req.headers[n.toLowerCase()];
    return Array.isArray(h) ? h.join(", ") : h;
  };
  const v = phoneGateVerdict(get, phoneOwner());
  if (v.ok) return true;
  note(v.reason, "UPGRADE", req.url ?? "");
  const body = REFUSAL_TEXT[v.reason];
  try {
    socket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  } catch {}
  socket.destroy();
  return false;
}
