import fs from "node:fs";
import path from "node:path";

/** Strip absolute paths and truncate — for API error messages only; never persist this. */
export function sanitizeError(err: unknown, extraRedact: string[] = []): string {
  let msg = err instanceof Error ? err.message : String(err ?? "unknown error");
  for (const s of extraRedact) {
    if (s && s.length >= 3) msg = msg.split(s).join("[redacted]");
  }
  // Absolute POSIX / Windows paths → [path]
  msg = msg.replace(/(?:\/(?:Users|home|tmp|var|private|opt|usr)\/[^\s:'"]+|\/[A-Za-z0-9._-]{2,}(?:\/[A-Za-z0-9._-]+)+)/g, "[path]");
  msg = msg.replace(/[A-Za-z]:\\[^\s'"]+/g, "[path]");
  msg = msg.replace(/\s+/g, " ").trim();
  return msg.slice(0, 200) || "error";
}

export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

/** Clip a string to at most `maxBytes` UTF-8 bytes without splitting a multibyte code unit. */
export function clipUtf8ByBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Walk back over continuation bytes (10xxxxxx) so we don't cut mid-codepoint.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Replace every occurrence of an absolute graph path (and realpath variants) in tool output. */
export function redactGraphPath(output: string, absGraphPath: string): string {
  if (!absGraphPath) return output;
  const variants = new Set<string>([absGraphPath]);
  try { variants.add(path.resolve(absGraphPath)); } catch { /* ignore */ }
  try { variants.add(fs.realpathSync(absGraphPath)); } catch { /* ignore */ }
  // macOS often surfaces both /var/... and /private/var/...
  for (const v of [...variants]) {
    if (v.startsWith("/var/")) variants.add("/private" + v);
    if (v.startsWith("/private/var/")) variants.add(v.slice("/private".length));
  }
  // Longer paths first so replacing `/var/...` does not mangle `/private/var/...` into `/privategraph.json`.
  let out = output;
  for (const v of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join("graph.json");
  }
  return out;
}
