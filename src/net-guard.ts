// Shared "is this IP internal/non-routable" check — used to stop SSRF (calendar.ts) and as a
// network deny-list floor for the egress proxy (egress.ts), independent of any allowlist config.
// ponytail: literal range checks, not a full CIDR library — covers the ranges that matter
// (loopback, RFC1918, link-local/cloud metadata, CGNAT, multicast/reserved). Upgrade to a real
// IP-range lib if more exotic ranges ever need blocking.
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true; // link-local + unique-local
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10 || a >= 224) return true; // this-net, loopback, RFC1918 /8, multicast+reserved
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 /12
  if (a === 192 && b === 168) return true; // RFC1918 /16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
