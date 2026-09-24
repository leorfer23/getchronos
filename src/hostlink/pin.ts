/**
 * How a host decides whether it may talk to a brain URL, and how it pins the brain's cert.
 *
 * Two transports, two trust roots (HOSTS.md → Transport):
 *  - **LAN (direct)**: the brain's own self-signed cert, pinned by the fingerprint from the join
 *    code. Public CAs are irrelevant here — no CA will ever sign `192.168.1.20`.
 *  - **Tunnel**: Cloudflare terminates TLS with a real certificate, so the ordinary CA check applies
 *    and the brain's fingerprint does not (the host never sees the brain's cert on that path).
 *
 * Which one a URL gets is decided by its hostname, not by a flag an operator could forget: an IP
 * literal or a LAN-only name (`localhost`, `*.local`, `*.lan`, `*.home.arpa`, `*.internal`) cannot
 * have a public certificate, so it is pinned; any other name is a public name and gets CA
 * verification. Plain `ws://` is refused unless the host is loopback — keystrokes and tokens cross
 * this link, and "it's only the LAN" is how credentials end up in a coffee-shop packet capture.
 */
import tls from "node:tls";
import net from "node:net";
import { fpEqual, normalizeFp } from "./join.js";

export type UrlKind =
  | { ok: true; kind: "pinned" | "ca" | "loopback-plain"; url: URL }
  | { ok: false; reason: string };

const LAN_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal"];

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function classifyBrainUrl(raw: string): UrlKind {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a URL: ${raw}` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol === "ws:") {
    if (isLoopbackHost(host)) return { ok: true, kind: "loopback-plain", url };
    return { ok: false, reason: `refusing plain ws:// to ${host} — only wss:// is allowed off this machine` };
  }
  if (url.protocol !== "wss:") return { ok: false, reason: `unsupported scheme ${url.protocol} (want wss://)` };
  const lanOnly = net.isIP(host) !== 0 || isLoopbackHost(host) || LAN_SUFFIXES.some((s) => host.endsWith(s));
  return { ok: true, kind: lanOnly ? "pinned" : "ca", url };
}

/**
 * Fetch the certificate a TLS endpoint presents, WITHOUT sending a byte of application data. The
 * handshake completes with verification off (we are about to verify by hand), and the socket is
 * closed before anything — no join code, no token — could be written to it.
 */
export function fetchPeerCert(url: URL, timeoutMs = 10_000): Promise<{ pem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 443);
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`TLS handshake with ${host}:${port} timed out`)); }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = sock.getPeerCertificate(true);
      sock.destroy();
      if (!cert?.raw) return reject(new Error(`${host}:${port} presented no certificate`));
      const b64 = cert.raw.toString("base64").replace(/(.{64})/g, "$1\n");
      resolve({ pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, fingerprint: normalizeFp(cert.fingerprint256) });
    });
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * TLS options that accept exactly one certificate. `ca` makes the chain check pass only for that
 * self-signed cert; `checkServerIdentity` (which Node calls only after the chain check passed)
 * re-checks the fingerprint and ignores the hostname — an IP literal has no name to match. Together
 * they hold even if the brain's answer changed between `fetchPeerCert` and this connection.
 */
export function pinnedTlsOptions(pem: string, fp: string): Pick<tls.ConnectionOptions, "ca" | "checkServerIdentity" | "rejectUnauthorized"> {
  return {
    ca: [pem],
    rejectUnauthorized: true,
    checkServerIdentity: (_host, cert) =>
      fpEqual(cert.fingerprint256, fp) ? undefined : new Error(`brain certificate fingerprint ${normalizeFp(cert.fingerprint256).slice(0, 16)}… does not match the pinned one`),
  };
}

/** Fetch + compare in one step; throws a message an operator can act on. */
export async function pinBrain(url: URL, fp: string): Promise<{ pem: string }> {
  if (!normalizeFp(fp)) throw new Error("no brain certificate fingerprint to pin against — re-join with a fresh code");
  const got = await fetchPeerCert(url);
  if (!fpEqual(got.fingerprint, fp)) {
    throw new Error(
      `brain certificate fingerprint mismatch at ${url.host}: expected ${normalizeFp(fp).slice(0, 16)}…, got ${got.fingerprint.slice(0, 16)}… — refusing to connect (possible impostor, or the brain's cert was rotated: re-join)`,
    );
  }
  return { pem: got.pem };
}
