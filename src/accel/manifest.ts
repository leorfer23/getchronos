import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AcceleratorTool } from "../types.js";

export const SCHEMA_VERSION = 2;

export interface AccelManifest {
  schemaVersion: number;
  workspaceId: string;
  repoId: string;
  tool: AcceleratorTool;
  head: string;
  builtAt: string;
  toolVersion: string | null;
  configHash: string | null;
  /** Relative to the tool's artifact dir. Must be traversal-safe (no `..`, no absolute). */
  graphPath: string;
  bytes: number;
}

export type Freshness = "fresh" | "stale" | "missing";

/**
 * Private root for every accelerator artifact — deliberately OUTSIDE any git checkout, including
 * Chronos's own. It used to resolve under the daemon's checkout via `inRepo()`, which put it inside
 * the Chronos repo's own tree for every repo EXCEPT put it literally inside the Chronos checkout's
 * own working directory when the target repo WAS Chronos — a manifest for Chronos-the-repo would
 * have landed inside Chronos-the-repo. `~/.chronos/accelerators` has no relationship to any repo's
 * working tree, so that can't happen for any repo, including this one. `CHRONOS_ACCEL_ROOT` exists
 * only so tests can point it at a throwaway dir instead of the operator's real home.
 */
export const ACCEL_ROOT = process.env.CHRONOS_ACCEL_ROOT || path.join(os.homedir(), ".chronos", "accelerators");

export function manifestDir(workspaceId: string, repoId: string, tool: AcceleratorTool): string {
  return path.join(ACCEL_ROOT, workspaceId, repoId, tool);
}

function manifestPath(workspaceId: string, repoId: string, tool: AcceleratorTool): string {
  return path.join(manifestDir(workspaceId, repoId, tool), "manifest.json");
}

/** Absolute path of the graph artifact for a manifest, or null if the relative path is unsafe. */
export function artifactPath(workspaceId: string, repoId: string, tool: AcceleratorTool, graphPath: string): string | null {
  const safe = safeRelativeGraphPath(graphPath);
  if (!safe) return null;
  return path.join(manifestDir(workspaceId, repoId, tool), safe);
}

/**
 * Reject symlinks and anything whose realpath escapes the private tool dir. Returns byte size of
 * the regular file at `absPath` when it is safe.
 */
export function assertSafeArtifactFile(toolDir: string, absPath: string): { bytes: number; real: string } {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(absPath);
  } catch {
    throw new Error("artifact missing");
  }
  if (lst.isSymbolicLink()) throw new Error("artifact is a symlink");
  if (!lst.isFile()) throw new Error("artifact is not a regular file");
  let real: string;
  let toolReal: string;
  try {
    real = fs.realpathSync(absPath);
    toolReal = fs.realpathSync(toolDir);
  } catch {
    throw new Error("artifact realpath failed");
  }
  const rel = path.relative(toolReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("artifact realpath escaped tool dir");
  }
  return { bytes: lst.size, real };
}

/**
 * Accept only a simple relative path (e.g. `graph.json`). Reject absolute paths, `..` segments,
 * NUL, and anything that normalizes outside the artifact dir.
 */
export function safeRelativeGraphPath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.includes("\0")) return null;
  if (path.isAbsolute(raw)) return null;
  const parts = raw.split(/[/\\]+/).filter((p) => p && p !== ".");
  if (!parts.length) return null;
  if (parts.some((p) => p === ".." || p === "~")) return null;
  const norm = path.normalize(parts.join(path.sep));
  if (path.isAbsolute(norm) || norm.startsWith("..") || norm.includes(`..${path.sep}`)) return null;
  return norm;
}

// mkdirSync's `mode` is masked by umask at creation time, so a shared umask of 022 would leave this
// world-readable despite the mode we ask for — chmod every level we own, explicitly, same pattern as
// the admin token in config.ts. Never touches anything above ACCEL_ROOT itself.
function ensureDirChain(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let cur = dir;
  for (;;) {
    try { fs.chmodSync(cur, 0o700); } catch {}
    if (cur === ACCEL_ROOT || cur === path.dirname(cur)) break;
    cur = path.dirname(cur);
  }
}

export function readManifest(workspaceId: string, repoId: string, tool: AcceleratorTool): AccelManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(workspaceId, repoId, tool), "utf8")) as AccelManifest;
  } catch {
    return null;
  }
}

/** Atomic write: temp file beside the target, then rename. Mode 0600. */
export function writeManifestAtomic(m: AccelManifest): AccelManifest {
  const dir = manifestDir(m.workspaceId, m.repoId, m.tool);
  ensureDirChain(dir);
  const file = manifestPath(m.workspaceId, m.repoId, m.tool);
  const tmp = path.join(dir, `.manifest.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(m, null, 2);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return m;
}

export function writeManifest(params: {
  workspaceId: string;
  repoId: string;
  tool: AcceleratorTool;
  head: string;
  toolVersion: string | null;
  configHash: string | null;
  graphPath: string;
  bytes: number;
}): AccelManifest {
  const graphPath = safeRelativeGraphPath(params.graphPath);
  if (!graphPath) throw new Error(`unsafe graphPath: ${params.graphPath}`);
  const m: AccelManifest = {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: params.workspaceId,
    repoId: params.repoId,
    tool: params.tool,
    head: params.head,
    builtAt: new Date().toISOString(),
    toolVersion: params.toolVersion,
    configHash: params.configHash,
    graphPath,
    bytes: params.bytes,
  };
  return writeManifestAtomic(m);
}

/** sha256 of whatever config knobs affect a build (today: just `mode`) — short and non-cryptographic use. */
export function configHashOf(mode: string | null | undefined): string {
  return crypto.createHash("sha256").update(mode ?? "").digest("hex").slice(0, 16);
}

/**
 * null on any failure (not a repo, git missing, detached weirdness) — callers treat that as unknown,
 * never as a crash. stderr is piped and dropped rather than inherited: a non-repo path is an expected
 * outcome here (every disabled/never-built repo hits this), not a warning worth printing to the
 * daemon's own console on every status check.
 */
export function currentHead(repoPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

// A manifest file living at the RIGHT path is not proof it belongs there — it could have been
// copied from another workspace/repo's directory, or written by a schema version this build doesn't
// understand. Every identity field must match the identity being asked about, exactly, before any
// HEAD/version/config comparison runs at all.
function identityMatches(
  m: AccelManifest,
  id: { workspaceId: string; repoId: string; tool: AcceleratorTool },
): boolean {
  return (
    m.schemaVersion === SCHEMA_VERSION &&
    m.workspaceId === id.workspaceId &&
    m.repoId === id.repoId &&
    m.tool === id.tool &&
    !!safeRelativeGraphPath(m.graphPath) &&
    typeof m.bytes === "number" && m.bytes >= 0
  );
}

/**
 * Fresh means the manifest's identity matches exactly, AND its HEAD, tool version, AND config hash
 * all still match — any one of them moving invalidates it. A HEAD match alone used to mean "fresh"
 * even after a graphify upgrade, a mode flip (code-only → full), or a manifest that was never this
 * repo's own to begin with; those were silent staleness/integrity bugs waiting to ship real
 * integration on top of them.
 */
export function freshness(params: {
  workspaceId: string;
  repoId: string;
  tool: AcceleratorTool;
  repoPath: string;
  toolVersion: string | null;
  configHash: string | null;
}): { state: Freshness; manifestHead: string | null; currentHead: string | null } {
  const m = readManifest(params.workspaceId, params.repoId, params.tool);
  const head = currentHead(params.repoPath);
  if (!m) return { state: "missing", manifestHead: null, currentHead: head };
  if (!identityMatches(m, params)) return { state: "stale", manifestHead: null, currentHead: head };
  if (!head || m.head !== head) return { state: "stale", manifestHead: m.head, currentHead: head };
  if (m.toolVersion !== params.toolVersion) return { state: "stale", manifestHead: m.head, currentHead: head };
  if (m.configHash !== params.configHash) return { state: "stale", manifestHead: m.head, currentHead: head };
  // Artifact must still exist at the declared relative path with matching size, and must not be a
  // symlink or realpath escape from the private tool dir.
  const art = artifactPath(params.workspaceId, params.repoId, params.tool, m.graphPath);
  if (!art) return { state: "stale", manifestHead: m.head, currentHead: head };
  try {
    const { bytes } = assertSafeArtifactFile(manifestDir(params.workspaceId, params.repoId, params.tool), art);
    if (bytes !== m.bytes) return { state: "stale", manifestHead: m.head, currentHead: head };
  } catch {
    return { state: "stale", manifestHead: m.head, currentHead: head };
  }
  return { state: "fresh", manifestHead: m.head, currentHead: head };
}
