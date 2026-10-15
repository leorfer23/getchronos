import fs from "node:fs";
import dns from "node:dns/promises";
import { isBlockedIp } from "./net-guard.js";
import { inRepo } from "./repo-root.js";

// Credential broker: the daemon makes the outbound HTTPS call and injects the auth header
// SERVER-SIDE, so high-value tokens (GitHub PAT, Telegram, …) never enter a sandbox's env — with
// unrestricted egress, anything an agent can read it can exfiltrate in one curl; what it can't
// read, it can't leak. Agents call POST /api/broker/:slug with their workspace token and choose
// only method + path + body; the HOST and the secret come from the operator's broker file. Same
// shape as qm's broker credentials (allowedMethods / allowedPathPrefixes / header injection).
//
// File: CHRONOS_BROKER_FILE (default ~/chronos/.broker.json, 0600, sandbox-denied like the admin
// token). A JSON array of credentials:
//   [{ "slug": "github", "host": "api.github.com",
//      "header": "Authorization", "scheme": "Bearer",
//      "secret_env": "CHRONOS_GH_PAT",            // or "secret": "<value>" inline
//      "allow_methods": ["GET"],
//      "allow_path_prefixes": ["/repos/", "/user"],
//      "workspaces": ["personal"],                 // omitted = any workspace token
//      "intercept": true }]                        // also inject transparently at the egress proxy
// The secret is resolved at call time (secret_env reads the daemon env, i.e. .secrets) and is
// never returned by any endpoint.

export interface BrokerCred {
  slug: string;
  host: string;
  header: string;
  scheme?: string; // header value = `${scheme} ${secret}`; omitted/empty = raw secret
  secret?: string;
  secret_env?: string;
  allow_methods: string[];
  allow_path_prefixes: string[];
  workspaces?: string[]; // workspace SLUGS allowed to use this cred; omitted = all
  // Opt this credential into transparent injection at the egress proxy (src/egress-mitm.ts): the
  // workspace proxy terminates TLS for `host` and adds the header itself, so `git push` and plain
  // curl get the credential without ever holding it. Off by default — it costs certificate pinning
  // on that host and lets the daemon see its plaintext, which is a per-host decision, not a global.
  intercept?: boolean;
  insecure_http?: boolean; // tests only — rejected outside CHRONOS_TEST
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;

export function defaultBrokerFile(): string {
  return process.env.CHRONOS_BROKER_FILE || inRepo(".broker.json");
}

// Read + validate the broker file. Invalid entries are dropped LOUDLY (console.error) rather than
// failing the whole file — one typo must not take down the other creds. Missing file = no creds.
// Warn-once state: this loads on every request, so a bad file must not print per call — an agent
// looping the endpoint would flood the daemon log.
const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(msg);
}

export function loadBrokerCreds(file = defaultBrokerFile()): BrokerCred[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  // The whole point is that agents can't read these; a group/other-readable file quietly undoes it.
  try {
    const mode = fs.statSync(file).mode & 0o077;
    if (mode) warnOnce(`mode:${file}`, `[broker] ${file} is group/other-readable (chmod 600 it)`);
  } catch {}
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    warnOnce(`json:${file}:${raw.length}`, `[broker] ${file} is not valid JSON: ${e?.message ?? e}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnOnce(`arr:${file}`, `[broker] ${file} must be a JSON array of credentials`);
    return [];
  }
  const out: BrokerCred[] = [];
  for (const c of parsed as BrokerCred[]) {
    const why = validateCred(c);
    if (why) {
      warnOnce(`bad:${(c as any)?.slug}:${why}`, `[broker] dropping cred ${JSON.stringify((c as any)?.slug ?? "?")}: ${why}`);
      continue;
    }
    // Default-open is the wrong default for something that spends credentials: an unscoped cred is
    // usable by every workspace token, including low-trust ones added later. Still honoured (an
    // operator may genuinely want it), but never silently.
    if (!c.workspaces)
      warnOnce(`open:${c.slug}`, `[broker] cred "${c.slug}" has no "workspaces" list — every workspace token can spend it`);
    out.push(c);
  }
  return out;
}

export function validateCred(c: BrokerCred): string | null {
  if (!c || typeof c !== "object") return "not an object";
  if (typeof c.slug !== "string" || !SLUG_RE.test(c.slug)) return "slug must match [a-z0-9-]";
  if (typeof c.host !== "string" || !HOST_RE.test(c.host) || c.host.includes("..")) return "invalid host";
  if (typeof c.header !== "string" || !HEADER_RE.test(c.header)) return "invalid header name";
  if (!!c.secret === !!c.secret_env) return "exactly one of secret / secret_env required";
  if (!Array.isArray(c.allow_methods) || !c.allow_methods.length) return "allow_methods required";
  if (c.allow_methods.some((m) => !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(m))) return "bad method in allow_methods";
  if (!Array.isArray(c.allow_path_prefixes) || !c.allow_path_prefixes.length) return "allow_path_prefixes required";
  if (c.allow_path_prefixes.some((p) => typeof p !== "string" || !p.startsWith("/"))) return "path prefixes must start with /";
  if (c.intercept !== undefined && typeof c.intercept !== "boolean") return "intercept must be a boolean";
  // Interception is TLS termination; there is nothing to terminate on a plaintext origin.
  if (c.intercept && c.insecure_http) return "intercept requires https";
  if (c.insecure_http && process.env.CHRONOS_TEST !== "1") return "insecure_http is test-only";
  return null;
}

export function findCred(creds: BrokerCred[], slug: string): BrokerCred | undefined {
  return creds.find((c) => c.slug === slug);
}

// null = admin caller (no workspace) — always allowed; the admin can read the file anyway.
export function wsAllowed(cred: BrokerCred, wsSlug: string | null): boolean {
  if (!cred.workspaces || wsSlug === null) return true;
  return cred.workspaces.includes(wsSlug);
}

export type TargetCheck = { ok: false; error: string } | { ok: true; target: string };

// Method + path gate. The path is the ONE part of the target an agent controls, so the rule is:
// VALIDATE EXACTLY WHAT WILL BE SENT. The URL is composed once against the credential's own origin,
// the host of that composed URL must still be the credential's host, and the wire request uses the
// composed pathname+search — never the raw string. That closes the class of bypass where the gate
// and the upstream disagree about parsing: `/\user/repos` puts "user" in the AUTHORITY position
// under WHATWG rules (backslash == slash for special schemes), so gating a relative-parse while
// sending the raw path let one arbitrary segment be prepended to an allowed path.
export function credAllows(cred: BrokerCred, method: string, reqPath: string): TargetCheck {
  const m = String(method || "").toUpperCase();
  if (!cred.allow_methods.includes(m)) return { ok: false, error: `method ${m} not allowed` };
  if (typeof reqPath !== "string" || !reqPath.startsWith("/")) return { ok: false, error: "path must start with /" };
  if (reqPath.length > 2000) return { ok: false, error: "path too long" };
  if (!/^[\x21-\x7e]+$/.test(reqPath)) return { ok: false, error: "path contains whitespace or non-ASCII" };
  if (reqPath.includes("\\")) return { ok: false, error: "backslash not allowed in path" };
  if (/^[/\\]{2}/.test(reqPath)) return { ok: false, error: "protocol-relative path not allowed" };
  // Encoded dot/slash/backslash escapes are refused outright rather than trusting every upstream to
  // decode them the way we did — including %25, which is how %252e survives one decode as %2e.
  if (/%(25|2e|2f|5c)/i.test(reqPath)) return { ok: false, error: "encoded dot/slash escapes not allowed" };

  const origin = `${cred.insecure_http ? "http" : "https"}://${cred.host}`;
  let u: URL;
  try {
    u = new URL(reqPath, origin);
  } catch {
    return { ok: false, error: "unparseable path" };
  }
  if (u.host.toLowerCase() !== cred.host.toLowerCase()) return { ok: false, error: "path must not change host" };
  let pathname: string;
  try {
    pathname = decodeURIComponent(u.pathname);
  } catch {
    return { ok: false, error: "unparseable path" };
  }
  if (pathname.includes("..")) return { ok: false, error: "path traversal not allowed" };
  // Segment-boundary match: an operator writing "/user" means that endpoint and its children, NOT
  // the whole "/users/*" tree a bare startsWith would also grant.
  const ok = cred.allow_path_prefixes.some((p) => {
    const bare = p.replace(/\/+$/, "");
    return pathname === bare || pathname.startsWith(`${bare}/`);
  });
  if (!ok) return { ok: false, error: "path not in allowlist" };
  return { ok: true, target: `${u.pathname}${u.search}` };
}

export function resolveSecret(cred: BrokerCred, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cred.secret) return cred.secret;
  const v = cred.secret_env ? env[cred.secret_env] : undefined;
  return v || null;
}

// A secret containing CR/LF/NUL cannot go into a header — and the failure is worse than useless:
// undici throws an "invalid header value" error that QUOTES the value, i.e. the token, and that
// message flows back to the sandboxed caller. Every injection path checks this BEFORE building the
// header, and every error message names only the env var to fix.
export function secretUnsafe(secret: string): boolean {
  return !/^[\x20-\x7e\t]+$/.test(secret);
}

export interface BrokerResult {
  status: number;
  content_type: string | null;
  body: string;
  truncated: boolean;
}

const RESPONSE_CAP = 512 * 1024;
const TIMEOUT_MS = 30_000;

// The outbound call. SSRF floor: even though the host is operator-configured, resolve it and
// refuse internal/metadata addresses (a compromised broker file should not become a pivot into
// localhost:7777 or 169.254.169.254). Redirects are NOT followed — a redirect would re-target the
// injected header at an address the allowlist never saw; the 3xx is returned to the caller as-is.
export async function brokerCall(
  cred: BrokerCred,
  method: string,
  reqPath: string,
  body: string | undefined,
  contentType: string | undefined,
): Promise<BrokerResult> {
  const secret = resolveSecret(cred);
  if (!secret) throw new Error(`secret for ${cred.slug} unresolved (is ${cred.secret_env ?? "secret"} set?)`);
  if (secretUnsafe(secret))
    throw new Error(`secret for ${cred.slug} contains control characters (check ${cred.secret_env ?? "the inline secret"})`);
  const hostname = cred.host.replace(/:\d+$/, "");
  if (!cred.insecure_http) {
    const addrs = await dns.lookup(hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`cannot resolve ${hostname}`);
    if (addrs.some((a) => isBlockedIp(a.address))) throw new Error(`${hostname} resolves to a blocked address`);
  }
  const proto = cred.insecure_http ? "http" : "https";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      [cred.header]: cred.scheme ? `${cred.scheme} ${secret}` : secret,
    };
    if (contentType) headers["content-type"] = contentType;
    const m = method.toUpperCase();
    const resp = await fetch(`${proto}://${cred.host}${reqPath}`, {
      method: m,
      headers,
      // fetch rejects GET/HEAD with a body; drop it rather than 502ing on a client mistake.
      body: body === undefined || m === "GET" || m === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: controller.signal,
    });
    // Stream with a hard cap: `resp.text()` would buffer the WHOLE upstream response into daemon
    // memory before truncating, so the cap would protect the caller but not the process.
    let text = "";
    let truncated = false;
    if (resp.body) {
      const reader = (resp.body as any).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > RESPONSE_CAP) {
          truncated = true;
          text = text.slice(0, RESPONSE_CAP);
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    return { status: resp.status, content_type: resp.headers.get("content-type"), body: text, truncated };
  } finally {
    clearTimeout(timer);
  }
}
