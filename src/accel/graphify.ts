import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoAccelerators } from "../store/accelerators.js";
import { workspaces } from "../store/workspaces.js";
import { sessions } from "../store/sessions.js";
import { accelTelemetry } from "../store/accel-telemetry.js";
import { acquireSlot, beatSlot, releaseSlot, niceWrap } from "../machine.js";
import { sandboxWrap } from "../sandbox.js";
import type { Repo, Workspace } from "../types.js";
import {
  ACCEL_ROOT,
  artifactPath,
  assertSafeArtifactFile,
  configHashOf,
  currentHead,
  freshness,
  manifestDir,
  readManifest,
  safeRelativeGraphPath,
  writeManifest,
} from "./manifest.js";
import { detectGraphify, versionOf } from "./detect.js";
import { resolveTrustedBin, parseToolVersion } from "./resolve-bin.js";
import { graphifyChildEnv, GRAPHIFY_MAX_GRAPH_BYTES } from "./graphify-env.js";
import { tryAcquireBuildLock } from "./lock.js";
import { clipUtf8ByBytes, estimateTokens, redactGraphPath, sanitizeError } from "./sanitize.js";

const execFileAsync = promisify(execFile);

export const GRAPHIFY_CANARY_VERSION = "0.9.64";
export const GRAPHIFY_CANARY_MODE = "code-only";
export const QUESTION_MAX = 1000;
export const BUDGET_DEFAULT = 800;
export const BUDGET_MIN = 100;
export const BUDGET_MAX = 2000;
export const QUERY_TIMEOUT_MS = 30_000;
export const QUERY_MAX_OUTPUT = 64 * 1024;
export const BUILD_MAX_WORKERS = 4;
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
export const GRAPH_REL = "graph.json";

export class GraphifyError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "GraphifyError";
  }
}

/** Telemetry may only persist a short code/class — never a sanitized message body. */
export function errorCodeOf(e: unknown): string {
  if (e instanceof GraphifyError && e.code) return e.code;
  return "error";
}

function requireCanary(repo: Repo, _ws: Workspace): { version: string; mode: string; bin: string } {
  const row = repoAccelerators.get(repo.id, "graphify");
  if (!row?.enabled) throw new GraphifyError("graphify is not enabled for this repo", 400, "disabled");
  if (row.mode !== GRAPHIFY_CANARY_MODE) {
    throw new GraphifyError(
      `graphify canary requires mode ${GRAPHIFY_CANARY_MODE} (got ${row.mode ?? "null"})`,
      400,
      "mode",
    );
  }
  let bin: string;
  try {
    bin = resolveTrustedBin("graphify");
  } catch (e: any) {
    throw new GraphifyError(e?.message ?? "graphify not found", 400, "version");
  }
  const probed = versionOf(bin, ["--version"], graphifyChildEnv());
  const version = parseToolVersion(probed.version);
  if (!probed.installed || version !== GRAPHIFY_CANARY_VERSION) {
    throw new GraphifyError(
      `graphify canary requires exact version ${GRAPHIFY_CANARY_VERSION} (got ${version ?? "missing"})`,
      400,
      "version",
    );
  }
  return { version, mode: GRAPHIFY_CANARY_MODE, bin };
}

function validateSession(workspaceId: string, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s || s.workspace_id !== workspaceId) {
    throw new GraphifyError("session_id must belong to the same workspace as the repo", 400, "session");
  }
  return s.id;
}

function rmrf(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

/**
 * Install extract output into a unique versioned dir under the tool root, validate size/symlink/
 * realpath, THEN return the relative graphPath. Does NOT touch the prior artifact or the manifest —
 * the caller atomically swaps the manifest pointer only after this returns. If size/manifest fails
 * later, the prior good artifact remains reachable via the old manifest.
 */
export function installVersionedArtifact(tmpGraph: string, toolDir: string): { bytes: number; graphPath: string; versionDir: string } {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(tmpGraph);
  } catch {
    throw new GraphifyError("graphify extract produced no graph.json", 500, "missing-artifact");
  }
  if (lst.isSymbolicLink()) throw new GraphifyError("graph artifact must not be a symlink", 400, "symlink");
  if (!lst.isFile()) throw new GraphifyError("graph artifact is not a regular file", 500, "missing-artifact");
  if (lst.size > GRAPHIFY_MAX_GRAPH_BYTES) {
    throw new GraphifyError(`graph artifact exceeds ${GRAPHIFY_MAX_GRAPH_BYTES} bytes`, 400, "size");
  }

  const buildId = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const graphPath = safeRelativeGraphPath(path.join("artifacts", buildId, GRAPH_REL));
  if (!graphPath) throw new GraphifyError("internal: unsafe versioned graph path", 500);

  const versionDir = path.join(toolDir, "artifacts", buildId);
  ensurePrivateDir(versionDir);
  const dest = path.join(versionDir, GRAPH_REL);
  const staging = path.join(versionDir, `.graph.${process.pid}.tmp`);
  try {
    fs.copyFileSync(tmpGraph, staging);
    try { fs.chmodSync(staging, 0o600); } catch {}
    fs.renameSync(staging, dest);
    try { fs.chmodSync(dest, 0o600); } catch {}
    const { bytes } = assertSafeArtifactFile(toolDir, dest);
    if (bytes > GRAPHIFY_MAX_GRAPH_BYTES) {
      throw new GraphifyError(`graph artifact exceeds ${GRAPHIFY_MAX_GRAPH_BYTES} bytes`, 400, "size");
    }
    return { bytes, graphPath, versionDir };
  } catch (e) {
    rmrf(versionDir);
    if (e instanceof GraphifyError) throw e;
    throw new GraphifyError(sanitizeError(e), 500, "promote");
  }
}

/** Exported for regression tests — maps child_process failures to timeout/output-cap/exec. */
export function mapChildError(e: any, redact: string[] = []): GraphifyError {
  const code = e?.code;
  // Node marks timed-out execFile children with killed=true; some versions also set ETIMEDOUT.
  if (e?.killed || code === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(String(e?.message ?? ""))) {
    return new GraphifyError("graphify child timed out", 504, "timeout");
  }
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(String(e?.message ?? ""))) {
    return new GraphifyError("graphify child output exceeded cap", 413, "output-cap");
  }
  return new GraphifyError(sanitizeError(e?.message ?? e, redact), 500, "exec");
}

async function runSandboxed(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    repoPath: string;
    workspaceId: string;
    /** Only these dirs (plus cwd) are writable. Never the whole toolDir. */
    writableDirs: string[];
    /** Write-denied but readable — registered checkout + private toolDir. */
    readonlyDirs: string[];
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const denyDirs = workspaces.isolationDenyDirs(opts.workspaceId);
  // Production: strict + egress locked + no secret grants. Under CHRONOS_TEST the outer agent
  // sandbox forbids nested sandbox-exec (`sandbox_apply: Operation not permitted`), so we keep the
  // same args/env/binary resolution and skip Seatbelt — covered by the source contract test.
  // niceWrap OUTSIDE sandboxWrap so the CPU-heavy child cannot starve Desk (same order as runner).
  const underTest = process.env.CHRONOS_TEST === "1";
  const sandboxed = sandboxWrap(
    underTest ? "off" : "strict",
    opts.cwd,
    opts.writableDirs,
    opts.cwd, // configDir: never the toolDir (that would re-open it for writes)
    denyDirs,
    bin,
    args,
    underTest ? false : true,
    opts.readonlyDirs,
    [],
  );
  const { cmd, cmdArgs } = niceWrap(sandboxed.cmd, sandboxed.cmdArgs);
  try {
    const r = await execFileAsync(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: graphifyChildEnv(),
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer,
      encoding: "utf8",
      killSignal: "SIGKILL",
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e: any) {
    const err = mapChildError(e, [opts.repoPath, ...opts.writableDirs, ...opts.readonlyDirs]);
    (err as any).stdout = String(e?.stdout ?? "");
    (err as any).stderr = String(e?.stderr ?? "");
    throw err;
  }
}

/** If the session claimed a worktree, its HEAD must match the artifact's registered-checkout HEAD. */
export function assertSessionWorktreeFresh(sessionId: string | null, manifestHead: string): void {
  if (!sessionId) return;
  const s = sessions.get(sessionId);
  if (!s?.worktree_path) return;
  const wtHead = currentHead(s.worktree_path);
  if (!wtHead || wtHead !== manifestHead) {
    throw new GraphifyError(
      "session worktree HEAD does not match graphify artifact HEAD",
      409,
      "session-stale",
    );
  }
}

export interface BuildResult {
  ok: true;
  head: string;
  toolVersion: string;
  bytes: number;
  graphPath: string;
  durationMs: number;
  reused: boolean;
}

export async function buildGraphify(repo: Repo, opts: {
  sessionId?: string | null;
  force?: boolean;
} = {}): Promise<BuildResult> {
  const ws = workspaces.get(repo.workspace_id);
  if (!ws) throw new GraphifyError("workspace not found", 404);
  const sessionId = validateSession(repo.workspace_id, opts.sessionId);
  const started = Date.now();

  const releaseLock = tryAcquireBuildLock(repo.id);
  if (!releaseLock) {
    throw new GraphifyError("graphify build already in progress for this repo", 503, "busy");
  }

  let slotId: string | null = null;
  let beat: NodeJS.Timeout | null = null;
  const redact = [repo.path, ACCEL_ROOT];
  try {
    const { version, mode, bin } = requireCanary(repo, ws);
    const head = currentHead(repo.path);
    if (!head) throw new GraphifyError("could not read repo HEAD", 400, "head");

    const fresh = freshness({
      workspaceId: ws.id,
      repoId: repo.id,
      tool: "graphify",
      repoPath: repo.path,
      toolVersion: version,
      configHash: configHashOf(mode),
    });
    if (!opts.force && fresh.state === "fresh") {
      const m = readManifest(ws.id, repo.id, "graphify")!;
      const durationMs = Date.now() - started;
      try {
        accelTelemetry.record({
          workspace_id: ws.id, repo_id: repo.id, session_id: sessionId,
          tool: "graphify", op: "build", ok: true, duration_ms: durationMs,
          budget: null, input_bytes: 0, output_bytes: 0, estimated_output_tokens: 0,
          artifact_bytes: m.bytes, head, tool_version: version, error: null,
        });
      } catch { /* telemetry must never turn a successful reuse into an API failure */ }
      return {
        ok: true, head, toolVersion: version, bytes: m.bytes,
        graphPath: m.graphPath, durationMs, reused: true,
      };
    }

    const grant = await acquireSlot({
      session_id: sessionId,
      label: `graphify build ${repo.name}`.slice(0, 80),
    }, 55_000);
    if (!grant.granted) {
      throw new GraphifyError("no heavy slot available for graphify build", 503, "busy");
    }
    slotId = grant.slot_id;
    beat = setInterval(() => { if (slotId) beatSlot(slotId); }, 30_000);
    beat.unref?.();

    const destDir = manifestDir(ws.id, repo.id, "graphify");
    ensurePrivateDir(destDir);
    const tmpRoot = path.join(destDir, `.tmp-build-${process.pid}-${Date.now()}`);
    ensurePrivateDir(tmpRoot);
    const priorManifest = readManifest(ws.id, repo.id, "graphify");
    const priorArt = priorManifest
      ? artifactPath(ws.id, repo.id, "graphify", priorManifest.graphPath)
      : null;

    try {
      const args = [
        "extract", repo.path,
        "--code-only",
        "--no-cluster",
        "--force",
        "--max-workers", String(BUILD_MAX_WORKERS),
        "--out", tmpRoot,
      ];
      // Child may write ONLY tmpRoot. toolDir (destDir) is readonly so the child cannot clobber
      // prior manifest/artifacts; parent promotes after the child exits.
      await runSandboxed(bin, args, {
        cwd: tmpRoot,
        repoPath: repo.path,
        workspaceId: ws.id,
        writableDirs: [tmpRoot],
        readonlyDirs: [repo.path, destDir],
        timeoutMs: BUILD_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });

      const tmpGraph = path.join(tmpRoot, "graphify-out", "graph.json");
      // Validate + install into a NEW versioned dir. Prior artifact stays put until the manifest
      // pointer swaps atomically below — a size/manifest failure leaves the last-good build intact.
      const installed = installVersionedArtifact(tmpGraph, destDir);
      try {
        writeManifest({
          workspaceId: ws.id,
          repoId: repo.id,
          tool: "graphify",
          head,
          toolVersion: version,
          configHash: configHashOf(mode),
          graphPath: installed.graphPath,
          bytes: installed.bytes,
        });
      } catch (e) {
        // Promote succeeded but manifest swap failed — drop the orphan; prior remains reachable.
        rmrf(installed.versionDir);
        throw e;
      }

      const durationMs = Date.now() - started;
      try {
        accelTelemetry.record({
          workspace_id: ws.id, repo_id: repo.id, session_id: sessionId,
          tool: "graphify", op: "build", ok: true, duration_ms: durationMs,
          budget: null, input_bytes: 0, output_bytes: 0, estimated_output_tokens: 0,
          artifact_bytes: installed.bytes, head, tool_version: version, error: null,
        });
      } catch { /* telemetry must never turn a successful build into an API failure */ }
      return {
        ok: true, head, toolVersion: version, bytes: installed.bytes,
        graphPath: installed.graphPath, durationMs, reused: false,
      };
    } catch (e) {
      // Prior good artifact + manifest are untouched (versioned install never overwrote them).
      if (priorManifest && priorArt) {
        try { assertSafeArtifactFile(destDir, priorArt); } catch { /* prior already gone */ }
      }
      throw e;
    } finally {
      rmrf(tmpRoot);
    }
  } catch (e) {
    const durationMs = Date.now() - started;
    try {
      accelTelemetry.record({
        workspace_id: repo.workspace_id, repo_id: repo.id, session_id: sessionId,
        tool: "graphify", op: "build", ok: false, duration_ms: durationMs,
        budget: null, input_bytes: 0, output_bytes: 0, estimated_output_tokens: 0,
        artifact_bytes: null, head: currentHead(repo.path),
        tool_version: parseToolVersion(detectGraphify(ws.config_dir).version),
        error: errorCodeOf(e),
      });
    } catch { /* telemetry must never mask the real error */ }
    if (e instanceof GraphifyError) throw e;
    throw new GraphifyError(sanitizeError(e, redact), 500, "build");
  } finally {
    if (beat) clearInterval(beat);
    if (slotId) releaseSlot(slotId);
    releaseLock();
  }
}

export interface QueryResult {
  ok: true;
  output: string;
  durationMs: number;
  budget: number;
  inputBytes: number;
  outputBytes: number;
  estimatedOutputTokens: number;
  artifactBytes: number;
  head: string;
  toolVersion: string;
}

export async function queryGraphify(repo: Repo, opts: {
  question: string;
  budget?: number;
  sessionId?: string | null;
}): Promise<QueryResult> {
  const ws = workspaces.get(repo.workspace_id);
  if (!ws) throw new GraphifyError("workspace not found", 404);
  const sessionId = validateSession(repo.workspace_id, opts.sessionId);
  const started = Date.now();
  const question = String(opts.question ?? "");
  const inputBytes = Buffer.byteLength(question, "utf8");
  const redact = [repo.path, ACCEL_ROOT, question];

  // No repo build-lock: freshness is checked immediately so a long extract never queues queries.
  try {
    if (!question || question.length > QUESTION_MAX) {
      throw new GraphifyError(`question must be 1..${QUESTION_MAX} characters`, 400, "question");
    }
    const budget = opts.budget ?? BUDGET_DEFAULT;
    if (!Number.isInteger(budget) || budget < BUDGET_MIN || budget > BUDGET_MAX) {
      throw new GraphifyError(`budget must be an integer in ${BUDGET_MIN}..${BUDGET_MAX}`, 400, "budget");
    }

    const { version, mode, bin } = requireCanary(repo, ws);
    const fresh = freshness({
      workspaceId: ws.id,
      repoId: repo.id,
      tool: "graphify",
      repoPath: repo.path,
      toolVersion: version,
      configHash: configHashOf(mode),
    });
    if (fresh.state !== "fresh") {
      throw new GraphifyError(`graphify artifact is ${fresh.state}; run build first`, 409, "stale");
    }
    const m = readManifest(ws.id, repo.id, "graphify")!;
    // Feature-branch terminals must not silently receive a main-checkout graph.
    assertSessionWorktreeFresh(sessionId, m.head);
    const toolDir = manifestDir(ws.id, repo.id, "graphify");
    const absGraph = artifactPath(ws.id, repo.id, "graphify", m.graphPath);
    if (!absGraph) {
      throw new GraphifyError("graphify artifact missing on disk", 409, "missing-artifact");
    }
    let realGraph: string;
    try {
      ({ real: realGraph } = assertSafeArtifactFile(toolDir, absGraph));
    } catch {
      throw new GraphifyError("graphify artifact missing or unsafe on disk", 409, "missing-artifact");
    }
    // Query may write only a private dir under the tool tmp area. The live artifact
    // version directory (graph.json) stays inside toolDir, which is readonly — a
    // query stamp beside the graph is fail-silent in Graphify and must not be granted.
    const queryTmpArea = path.join(toolDir, "tmp");
    ensurePrivateDir(queryTmpArea);
    const queryTmp = path.join(
      queryTmpArea,
      `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`,
    );
    ensurePrivateDir(queryTmp);

    const args = [
      "query", question,
      "--budget", String(budget),
      "--graph", realGraph,
    ];
    let stdout = "";
    try {
      ({ stdout } = await runSandboxed(bin, args, {
        cwd: queryTmp,
        repoPath: repo.path,
        workspaceId: ws.id,
        writableDirs: [queryTmp],
        readonlyDirs: [repo.path, toolDir],
        timeoutMs: QUERY_TIMEOUT_MS,
        maxBuffer: QUERY_MAX_OUTPUT,
      }));
    } finally {
      rmrf(queryTmp);
    }

    // maxBuffer already caps the child; clip by UTF-8 bytes (never String.slice) as a belt.
    let output = clipUtf8ByBytes(redactGraphPath(stdout, realGraph), QUERY_MAX_OUTPUT);
    output = redactGraphPath(output, absGraph);
    const outputBytes = Buffer.byteLength(output, "utf8");
    const estimatedOutputTokens = estimateTokens(outputBytes);
    const durationMs = Date.now() - started;

    try {
      accelTelemetry.record({
        workspace_id: ws.id, repo_id: repo.id, session_id: sessionId,
        tool: "graphify", op: "query", ok: true, duration_ms: durationMs,
        budget, input_bytes: inputBytes, output_bytes: outputBytes,
        estimated_output_tokens: estimatedOutputTokens,
        artifact_bytes: m.bytes, head: m.head, tool_version: version, error: null,
      });
    } catch { /* telemetry must never turn a successful query into an API failure */ }

    return {
      ok: true,
      output,
      durationMs,
      budget,
      inputBytes,
      outputBytes,
      estimatedOutputTokens,
      artifactBytes: m.bytes,
      head: m.head,
      toolVersion: version,
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    try {
      accelTelemetry.record({
        workspace_id: repo.workspace_id, repo_id: repo.id, session_id: sessionId,
        tool: "graphify", op: "query", ok: false, duration_ms: durationMs,
        budget: opts.budget ?? BUDGET_DEFAULT, input_bytes: inputBytes, output_bytes: 0,
        estimated_output_tokens: 0, artifact_bytes: null,
        head: currentHead(repo.path),
        tool_version: parseToolVersion(detectGraphify(ws.config_dir).version),
        error: errorCodeOf(e),
      });
    } catch { /* ignore */ }
    if (e instanceof GraphifyError) throw e;
    throw new GraphifyError(sanitizeError(e, redact), 500, "query");
  }
}
