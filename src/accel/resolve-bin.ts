import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Resolve a tool name to a trusted absolute path. Never returns a bare name for spawn — that would
 * re-consult PATH inside a sandbox with a stripped env and either ENOENT or pick up a different
 * binary than the one we just version-checked. Tests override via `CHRONOS_GRAPHIFY_BIN`.
 */
/**
 * Same resolution order detect + execute share: env override → `which` → ~/.local/bin →
 * Homebrew /usr/local. Detect must use this so launchd (thin PATH) does not report "missing"
 * while builds that fall back to ~/.local/bin still work.
 */
export function resolveTrustedBin(name: string, envKey?: string): string {
  const key = envKey ?? (name === "graphify" ? "CHRONOS_GRAPHIFY_BIN" : `CHRONOS_${name.toUpperCase().replace(/-/g, "_")}_BIN`);
  const override = process.env[key]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(`${key} must be an absolute path`);
    }
    return assertTrustedFile(override);
  }
  let found: string | null = null;
  try {
    found = execFileSync("which", [name], { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    found = null;
  }
  if (!found) {
    const candidates = [
      path.join(os.homedir(), ".local", "bin", name),
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
    ];
    found = candidates.find((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    }) ?? null;
  }
  if (!found) throw new Error(`${name} not found on PATH`);
  if (!path.isAbsolute(found)) throw new Error(`${name} resolved to a non-absolute path: ${found}`);
  return assertTrustedFile(found);
}

/** Like resolveTrustedBin but returns null instead of throwing — for status probes. */
export function tryResolveTrustedBin(name: string, envKey?: string): string | null {
  try {
    return resolveTrustedBin(name, envKey);
  } catch {
    return null;
  }
}

function assertTrustedFile(p: string): string {
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    throw new Error(`binary not found: ${p}`);
  }
  if (!path.isAbsolute(real)) throw new Error(`binary path must be absolute: ${real}`);
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    throw new Error(`binary not readable: ${real}`);
  }
  if (!st.isFile()) throw new Error(`binary is not a regular file: ${real}`);
  // Reject world-writable binaries — a PATH plant an unprivileged peer could replace mid-flight.
  if ((st.mode & 0o002) !== 0) throw new Error(`binary is world-writable: ${real}`);
  return real;
}

/** Pull a semver like 0.9.64 out of `graphify 0.9.64` / bare `0.9.64`. */
export function parseToolVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}
