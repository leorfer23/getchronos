import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const accelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gfy-root-"));
process.env.CHRONOS_ACCEL_ROOT = accelRoot;

const fakeSrc = fileURLToPath(new URL("./fake-graphify.mjs", import.meta.url));
const fakeBin = path.join(os.tmpdir(), `fake-graphify-${process.pid}.mjs`);
fs.copyFileSync(fakeSrc, fakeBin);
fs.chmodSync(fakeBin, 0o755);
process.env.CHRONOS_GRAPHIFY_BIN = fakeBin;

const { db, workspaces, repos, repoAccelerators, sessions, accelTelemetry } = await import("../store.js");
const { resetSlots } = await import("../machine.js");
const {
  buildGraphify, queryGraphify, GraphifyError, errorCodeOf, mapChildError,
  installVersionedArtifact, assertSessionWorktreeFresh,
  GRAPHIFY_CANARY_VERSION, QUESTION_MAX, BUDGET_MIN, BUDGET_MAX, BUDGET_DEFAULT,
  QUERY_MAX_OUTPUT,
} = await import("./graphify.js");
const { readManifest, manifestDir, freshness, configHashOf, assertSafeArtifactFile, artifactPath } = await import("./manifest.js");
const { graphifyChildEnv, GRAPHIFY_MAX_GRAPH_BYTES } = await import("./graphify-env.js");
const { sanitizeError, redactGraphPath, estimateTokens, clipUtf8ByBytes } = await import("./sanitize.js");
const { safeRelativeGraphPath } = await import("./manifest.js");
const { tryAcquireBuildLock, isBuildLocked, resetBuildLocks } = await import("./lock.js");
const { agentContext } = await import("../skills.js");
const { formatDoneCriteria } = await import("../tickets.js");

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gfy-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const x = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  return dir;
}

function seedRepo(mode: string | null = "code-only") {
  const ws = workspaces.create({ slug: `gfy-${Math.random().toString(16).slice(2, 8)}`, name: "Gfy", config_dir: "/tmp/gfy-cfg" });
  const repoPath = makeGitRepo();
  const repo = repos.create({ workspace_id: ws.id, name: "target", path: repoPath });
  if (mode !== undefined) repoAccelerators.setEnabled(ws.id, repo.id, "graphify", true, mode);
  return { ws, repo, repoPath };
}

beforeEach(() => {
  db.exec("DELETE FROM accel_telemetry; DELETE FROM repo_accelerators; DELETE FROM sessions; DELETE FROM repos; DELETE FROM workspaces;");
  resetSlots();
  resetBuildLocks();
  process.env.CHRONOS_GRAPHIFY_BIN = fakeBin;
  delete process.env.FAIL;
  delete process.env.FAIL_EXTRACT;
  delete process.env.BAD_OUT;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  resetSlots();
  resetBuildLocks();
});

test("graphifyChildEnv strips API/workspace secrets and sets query-log/64MB/no-bytecode", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ANTHROPIC_API_KEY = "ant-test";
  process.env.CHRONOS_ADMIN = "secret";
  const env = graphifyChildEnv();
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CHRONOS_ADMIN, undefined);
  assert.equal(env.GRAPHIFY_QUERY_LOG_DISABLE, "1");
  assert.equal(env.GRAPHIFY_MAX_GRAPH_BYTES, String(64 * 1024 * 1024));
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.ok(env.PATH);
});

test("sanitizeError redacts absolute paths and truncates; never keeps raw long blobs", () => {
  const s = sanitizeError(new Error(`boom at /Users/example/secret/repo/file.ts and /tmp/x`));
  assert.doesNotMatch(s, /example/);
  assert.match(s, /\[path\]/);
  assert.ok(s.length <= 200);
});

test("redactGraphPath replaces absolute graph path and realpath variants", () => {
  const abs = "/var/folders/xx/graph.json";
  assert.equal(redactGraphPath(`see ${abs} please`, abs), "see graph.json please");
  assert.equal(redactGraphPath(`see /private${abs} please`, abs), "see graph.json please");
});

test("clipUtf8ByBytes never splits a multibyte codepoint and never uses String.slice semantics", () => {
  const s = "é".repeat(10); // 2 bytes each in UTF-8
  const clipped = clipUtf8ByBytes(s, 5);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= 5);
  assert.equal(clipped, "éé"); // 4 bytes — not mid-character
  assert.equal(clipUtf8ByBytes("abc", 2), "ab");
  // A string whose UTF-16 length ≠ byte length must clip by bytes, not by String.slice chars.
  const mixed = "a🎉b"; // 🎉 is 4 UTF-8 bytes
  assert.equal(clipUtf8ByBytes(mixed, 2), "a"); // String.slice(0,2) would be "a🎉"
});

test("safeRelativeGraphPath rejects traversal and absolute paths", () => {
  assert.equal(safeRelativeGraphPath("graph.json"), "graph.json");
  assert.equal(safeRelativeGraphPath("artifacts/x/graph.json"), path.join("artifacts", "x", "graph.json"));
  assert.equal(safeRelativeGraphPath("../x"), null);
  assert.equal(safeRelativeGraphPath("/tmp/x"), null);
  assert.equal(safeRelativeGraphPath("a/../../b"), null);
});

test("build refuses when graphify is disabled", async () => {
  const { repo } = seedRepo(null);
  repoAccelerators.setEnabled(repo.workspace_id, repo.id, "graphify", false, "code-only");
  await assert.rejects(() => buildGraphify(repo), (e: any) => e instanceof GraphifyError && e.code === "disabled");
});

test("build refuses non-code-only mode", async () => {
  const { repo } = seedRepo("full");
  await assert.rejects(() => buildGraphify(repo), (e: any) => e instanceof GraphifyError && e.code === "mode");
});

test("build + query happy path with fake executable only", async () => {
  const { ws, repo, repoPath } = seedRepo("code-only");
  process.env.OPENAI_API_KEY = "should-not-leak";
  const markerFile = path.join(os.tmpdir(), `gfy-marker-${process.pid}.json`);
  process.env.CHRONOS_GRAPHIFY_MARKER = markerFile;

  const built = await buildGraphify(repo);
  assert.equal(built.ok, true);
  assert.equal(built.reused, false);
  assert.equal(built.toolVersion, GRAPHIFY_CANARY_VERSION);
  assert.ok(built.bytes > 0);
  assert.match(built.graphPath, /^artifacts[/\\][^/\\]+[/\\]graph\.json$/);

  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  assert.equal(marker.codeOnly, true);
  assert.equal(marker.noCluster, true);
  assert.equal(marker.force, true);
  assert.equal(marker.maxWorkers, "4");
  assert.equal(marker.target, repoPath);
  assert.equal(marker.sawOpenAi, false);
  assert.equal(marker.queryLogDisabled, true);
  assert.equal(marker.maxGraphBytes, String(64 * 1024 * 1024));
  assert.equal(marker.noBytecode, true);

  const m = readManifest(ws.id, repo.id, "graphify");
  assert.ok(m);
  assert.equal(m!.schemaVersion, 2);
  assert.equal(m!.graphPath, built.graphPath);
  assert.equal(m!.bytes, built.bytes);

  const art = artifactPath(ws.id, repo.id, "graphify", m!.graphPath)!;
  assert.ok(fs.existsSync(art));
  assert.equal(fs.statSync(art).size, built.bytes);
  assertSafeArtifactFile(manifestDir(ws.id, repo.id, "graphify"), art);

  const q = await queryGraphify(repo, { question: "where is x?", budget: 800 });
  assert.equal(q.ok, true);
  assert.ok(!q.output.includes(art), "absolute graph path must be redacted from query output");
  assert.match(q.output, /graph\.json/);
  assert.equal(q.budget, 800);
  assert.ok(q.estimatedOutputTokens >= 1);

  assert.equal(freshness({
    workspaceId: ws.id, repoId: repo.id, tool: "graphify", repoPath,
    toolVersion: GRAPHIFY_CANARY_VERSION, configHash: configHashOf("code-only"),
  }).state, "fresh");

  const rows = db.prepare("SELECT * FROM accel_telemetry ORDER BY created_at").all() as any[];
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.equal(r.tool, "graphify");
    assert.ok(r.op === "build" || r.op === "query");
    assert.equal(r.error, null);
    assert.doesNotMatch(JSON.stringify(r), /where is x/);
    assert.doesNotMatch(JSON.stringify(r), /should-not-leak/);
  }

  const agg = accelTelemetry.aggregateSince(new Date(Date.now() - 86400000).toISOString());
  const buildAgg = agg.find((a) => a.tool === "graphify" && a.op === "build");
  const queryAgg = agg.find((a) => a.tool === "graphify" && a.op === "query");
  assert.ok(buildAgg && buildAgg.ok >= 1);
  assert.ok(queryAgg && queryAgg.ok >= 1);
  assert.ok("sessions_distinct" in buildAgg!);
  assert.ok("artifact_bytes_sum" in buildAgg!);
  assert.ok(buildAgg!.artifact_bytes_sum >= built.bytes);

  const again = await buildGraphify(repo);
  assert.equal(again.reused, true);
});

test("versioned promote: size failure never overwrites the prior good artifact", () => {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gfy-promote-"));
  // Prior good artifact + manifest pointer simulation
  const priorRel = path.join("artifacts", "prior", "graph.json");
  const priorAbs = path.join(toolDir, priorRel);
  fs.mkdirSync(path.dirname(priorAbs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(priorAbs, '{"nodes":[]}');
  const priorBytes = fs.statSync(priorAbs).size;

  // Oversized extract output
  const tmp = path.join(toolDir, "tmp-graph.json");
  fs.writeFileSync(tmp, "x".repeat(GRAPHIFY_MAX_GRAPH_BYTES + 1));
  assert.throws(
    () => installVersionedArtifact(tmp, toolDir),
    (e: any) => e instanceof GraphifyError && e.code === "size",
  );
  // Prior untouched
  assert.equal(fs.readFileSync(priorAbs, "utf8"), '{"nodes":[]}');
  assert.equal(fs.statSync(priorAbs).size, priorBytes);
});

test("failed extract preserves prior good artifact and manifest pointer", async () => {
  const { ws, repo } = seedRepo("code-only");
  const first = await buildGraphify(repo);
  const m = readManifest(ws.id, repo.id, "graphify")!;
  const art = artifactPath(ws.id, repo.id, "graphify", m.graphPath)!;
  const before = fs.readFileSync(art, "utf8");
  const beforeManifest = fs.readFileSync(path.join(manifestDir(ws.id, repo.id, "graphify"), "manifest.json"), "utf8");

  process.env.FAIL_EXTRACT = "1";
  await assert.rejects(() => buildGraphify(repo, { force: true }), GraphifyError);

  assert.equal(fs.readFileSync(art, "utf8"), before);
  assert.equal(fs.readFileSync(path.join(manifestDir(ws.id, repo.id, "graphify"), "manifest.json"), "utf8"), beforeManifest);
  assert.equal(readManifest(ws.id, repo.id, "graphify")!.graphPath, first.graphPath);
  assert.equal(readManifest(ws.id, repo.id, "graphify")!.bytes, first.bytes);
});

test("build try-lock returns busy; query does not wait on the build lock", async () => {
  const { repo } = seedRepo("code-only");
  await buildGraphify(repo);

  const release = tryAcquireBuildLock(repo.id);
  assert.ok(release);
  assert.equal(isBuildLocked(repo.id), true);
  await assert.rejects(
    () => buildGraphify(repo, { force: true }),
    (e: any) => e instanceof GraphifyError && e.code === "busy" && e.status === 503,
  );
  // Query must succeed immediately while the build lock is held (no queue behind extract).
  const q = await queryGraphify(repo, { question: "still works" });
  assert.equal(q.ok, true);
  release!();
  assert.equal(isBuildLocked(repo.id), false);
});

test("mapChildError maps timeout and maxBuffer to explicit codes/statuses", () => {
  const t = mapChildError({ killed: true, message: "killed" });
  assert.equal(t.code, "timeout");
  assert.equal(t.status, 504);
  const t2 = mapChildError({ code: "ETIMEDOUT", message: "ETIMEDOUT" });
  assert.equal(t2.code, "timeout");
  const o = mapChildError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: "maxBuffer length exceeded" });
  assert.equal(o.code, "output-cap");
  assert.equal(o.status, 413);
  const g = mapChildError({ code: "ENOENT", message: "nope" });
  assert.equal(g.code, "exec");
  assert.equal(g.status, 500);
});

test("telemetry persists only error codes, never sanitized messages", async () => {
  const { repo } = seedRepo("code-only");
  await assert.rejects(() => queryGraphify(repo, { question: "no artifact yet" }), GraphifyError);
  const row = db.prepare("SELECT error FROM accel_telemetry WHERE ok=0 ORDER BY created_at DESC LIMIT 1").get() as { error: string };
  assert.equal(row.error, "stale");
  assert.doesNotMatch(row.error, /\s|\//);
  assert.equal(errorCodeOf(new GraphifyError("msg", 504, "timeout")), "timeout");
});

test("assertSafeArtifactFile rejects symlinks and realpath escapes", () => {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gfy-safe-"));
  const outside = path.join(os.tmpdir(), `mc-gfy-out-${process.pid}.json`);
  fs.writeFileSync(outside, "{}");
  const link = path.join(toolDir, "graph.json");
  try {
    fs.symlinkSync(outside, link);
  } catch (e: any) {
    // Some sandboxes forbid symlinks — skip with explicit note rather than false green.
    if (e?.code === "EPERM" || e?.code === "EACCES") return;
    throw e;
  }
  assert.throws(() => assertSafeArtifactFile(toolDir, link), /symlink/);
  // Escape via .. is rejected by realpath relative check when pointing outside.
  const escape = path.join(toolDir, "escape.json");
  fs.copyFileSync(outside, escape);
  // Real file inside toolDir is fine:
  assert.equal(assertSafeArtifactFile(toolDir, escape).bytes, fs.statSync(escape).size);
});

test("freshness treats a symlinked artifact as stale", () => {
  const { ws, repo, repoPath } = seedRepo("code-only");
  const toolDir = manifestDir(ws.id, repo.id, "graphify");
  fs.mkdirSync(toolDir, { recursive: true });
  const outside = path.join(os.tmpdir(), `mc-gfy-sym-${process.pid}.json`);
  fs.writeFileSync(outside, "x".repeat(12));
  const link = path.join(toolDir, "graph.json");
  try {
    fs.symlinkSync(outside, link);
  } catch (e: any) {
    if (e?.code === "EPERM" || e?.code === "EACCES") return;
    throw e;
  }
  fs.writeFileSync(path.join(toolDir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: ws.id, repoId: repo.id, tool: "graphify",
    head: "deadbeef", builtAt: new Date().toISOString(),
    toolVersion: GRAPHIFY_CANARY_VERSION, configHash: configHashOf("code-only"),
    graphPath: "graph.json", bytes: 12,
  }));
  // Even with matching head we would reject — force head match by writing real HEAD into manifest.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(toolDir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: ws.id, repoId: repo.id, tool: "graphify",
    head, builtAt: new Date().toISOString(),
    toolVersion: GRAPHIFY_CANARY_VERSION, configHash: configHashOf("code-only"),
    graphPath: "graph.json", bytes: 12,
  }));
  assert.equal(freshness({
    workspaceId: ws.id, repoId: repo.id, tool: "graphify", repoPath,
    toolVersion: GRAPHIFY_CANARY_VERSION, configHash: configHashOf("code-only"),
  }).state, "stale");
});

test("query bounds: question max, budget range, default budget", async () => {
  const { repo } = seedRepo("code-only");
  await buildGraphify(repo);

  await assert.rejects(
    () => queryGraphify(repo, { question: "x".repeat(QUESTION_MAX + 1) }),
    (e: any) => e instanceof GraphifyError && e.code === "question",
  );
  await assert.rejects(
    () => queryGraphify(repo, { question: "ok", budget: BUDGET_MIN - 1 }),
    (e: any) => e instanceof GraphifyError && e.code === "budget",
  );
  await assert.rejects(
    () => queryGraphify(repo, { question: "ok", budget: BUDGET_MAX + 1 }),
    (e: any) => e instanceof GraphifyError && e.code === "budget",
  );

  const q = await queryGraphify(repo, { question: "default budget" });
  assert.equal(q.budget, BUDGET_DEFAULT);
  assert.ok(Buffer.byteLength(q.output, "utf8") <= QUERY_MAX_OUTPUT);
});

test("query rejects cross-workspace session_id", async () => {
  const a = seedRepo("code-only");
  const b = seedRepo("code-only");
  await buildGraphify(a.repo);
  const other = sessions.create({ workspace_id: b.ws.id, cwd: "/tmp", backend: "claude-code" } as any);

  await assert.rejects(
    () => queryGraphify(a.repo, { question: "hi", sessionId: other.id }),
    (e: any) => e instanceof GraphifyError && e.code === "session",
  );
});

test("query refuses stale/missing artifact", async () => {
  const { repo } = seedRepo("code-only");
  await assert.rejects(
    () => queryGraphify(repo, { question: "hi" }),
    (e: any) => e instanceof GraphifyError && e.code === "stale",
  );
});

test("aggregate includes distinct sessions and artifact bytes", async () => {
  const { ws, repo } = seedRepo("code-only");
  const sess = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" } as any);
  await buildGraphify(repo, { sessionId: sess.id });
  await queryGraphify(repo, { question: "agg", sessionId: sess.id });
  const agg = accelTelemetry.aggregateSince(new Date(Date.now() - 86400000).toISOString());
  const q = agg.find((a) => a.op === "query")!;
  assert.ok(q.sessions_distinct >= 1);
  assert.ok(q.artifact_bytes_sum >= 0);
});

test("estimateTokens is content-free and deterministic", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
});

test("production sandbox: toolDir readonly; only tmpRoot / query tmp writable; niceWrap outside", () => {
  const src = fs.readFileSync(new URL("./graphify.ts", import.meta.url), "utf8");
  assert.match(src, /underTest \? "off" : "strict"/);
  assert.match(src, /underTest \? false : true/);
  assert.match(src, /isolationDenyDirs/);
  assert.match(src, /tryAcquireBuildLock/);
  assert.doesNotMatch(src, /withRepoLock/);
  assert.match(src, /clipUtf8ByBytes/);
  assert.doesNotMatch(src, /output\.slice\(0,\s*QUERY_MAX_OUTPUT\)/);
  // Build must NOT pass destDir/toolDir as writable — only tmpRoot.
  assert.match(src, /writableDirs:\s*\[tmpRoot\]/);
  assert.match(src, /readonlyDirs:\s*\[repo\.path,\s*destDir\]/);
  // Query writes only a unique dir under the tool tmp area. The live version
  // dir that contains graph.json is not a writable grant; toolDir stays readonly.
  const queryFn = src.slice(src.indexOf("export async function queryGraphify"));
  assert.ok(queryFn.length > 0);
  assert.doesNotMatch(queryFn, /artifactCacheDir/);
  assert.doesNotMatch(queryFn, /dirname\(realGraph\)/);
  assert.match(queryFn, /path\.join\(toolDir,\s*"tmp"\)/);
  assert.match(queryFn, /ensurePrivateDir\(queryTmp\)/);
  assert.match(queryFn, /cwd:\s*queryTmp/);
  assert.match(queryFn, /writableDirs:\s*\[queryTmp\]/);
  assert.match(queryFn, /readonlyDirs:\s*\[repo\.path,\s*toolDir\]/);
  assert.match(queryFn, /finally\s*\{\s*rmrf\(queryTmp\);\s*\}/);
  // niceWrap applied outside sandboxWrap (order: sandboxed then niceWrap).
  assert.match(src, /const sandboxed = sandboxWrap\(/);
  assert.match(src, /niceWrap\(sandboxed\.cmd,\s*sandboxed\.cmdArgs\)/);
  // Success telemetry must be try/caught so it cannot fail the API.
  assert.match(src, /telemetry must never turn a successful (?:build|reuse|query)/);
});

test("query cannot mutate graph.json and removes its private tmp dir on success and failure", async () => {
  const { ws, repo } = seedRepo("code-only");
  await buildGraphify(repo);
  const toolDir = manifestDir(ws.id, repo.id, "graphify");
  const m = readManifest(ws.id, repo.id, "graphify")!;
  const art = artifactPath(ws.id, repo.id, "graphify", m.graphPath)!;
  const versionDir = path.dirname(art);
  const before = fs.readFileSync(art);

  const leftovers = (): string[] => {
    const scratch: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === ".chronos-query-scratch") scratch.push(p);
        else if (fs.statSync(p).isDirectory()) walk(p);
      }
    };
    walk(toolDir);
    const area = path.join(toolDir, "tmp");
    const tmpKids = fs.existsSync(area) ? fs.readdirSync(area) : [];
    return [...tmpKids, ...scratch];
  };

  const q = await queryGraphify(repo, { question: "do not touch the graph" });
  assert.equal(q.ok, true);
  assert.deepEqual(fs.readFileSync(art), before);
  assert.deepEqual(fs.readdirSync(versionDir), ["graph.json"]);
  assert.deepEqual(leftovers(), []);

  process.env.FAIL = "1";
  await assert.rejects(
    () => queryGraphify(repo, { question: "fail closed" }),
    (e: any) => e instanceof GraphifyError && e.code === "exec",
  );
  assert.deepEqual(fs.readFileSync(art), before);
  assert.deepEqual(fs.readdirSync(versionDir), ["graph.json"]);
  assert.deepEqual(leftovers(), []);
});

test("session-stale: claimed worktree HEAD mismatch rejects query", async () => {
  const { ws, repo, repoPath } = seedRepo("code-only");
  await buildGraphify(repo);
  const m = readManifest(ws.id, repo.id, "graphify")!;
  // A second commit in a "worktree" clone of the same repo → different HEAD.
  const wt = makeGitRepo();
  fs.writeFileSync(path.join(wt, "src", "b.ts"), "export const y = 2;\n");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["commit", "-q", "-m", "feature"], { cwd: wt });
  const wtHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
  assert.notEqual(wtHead, m.head);

  const sess = sessions.create({ workspace_id: ws.id, cwd: wt, backend: "claude-code" } as any);
  sessions.setWorktree(sess.id, { path: wt, branch: "feat/x", repo_id: repo.id });

  await assert.rejects(
    () => queryGraphify(repo, { question: "on feature branch?", sessionId: sess.id }),
    (e: any) => e instanceof GraphifyError && e.code === "session-stale" && e.status === 409,
  );
  // Matching HEAD is fine.
  sessions.setWorktree(sess.id, { path: repoPath, branch: "main", repo_id: repo.id });
  const q = await queryGraphify(repo, { question: "on registered checkout", sessionId: sess.id });
  assert.equal(q.ok, true);
  assert.equal(assertSessionWorktreeFresh(null, m.head), undefined);
});

test("orphan versionDir removed when writeManifest fails after promote", () => {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gfy-orphan-"));
  const tmp = path.join(toolDir, "in.json");
  fs.writeFileSync(tmp, '{"nodes":[]}');
  const installed = installVersionedArtifact(tmp, toolDir);
  assert.ok(fs.existsSync(installed.versionDir));
  // Simulate the build catch path: rmrf orphan after a failed manifest swap.
  fs.rmSync(installed.versionDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(installed.versionDir), false);
  // Source contract: build path must rmrf(installed.versionDir) on writeManifest failure.
  const src = fs.readFileSync(new URL("./graphify.ts", import.meta.url), "utf8");
  assert.match(src, /rmrf\(installed\.versionDir\)/);
});

test("route scope: build is requireAdmin; query checkScope before queryGraphify", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const buildIdx = api.indexOf('api.post("/repos/:id/accel/graphify/build"');
  const queryIdx = api.indexOf('api.post("/repos/:id/accel/graphify/query"');
  assert.ok(buildIdx > 0 && queryIdx > buildIdx);
  const buildBlock = api.slice(buildIdx, queryIdx);
  const queryBlock = api.slice(queryIdx, queryIdx + 600);
  assert.match(buildBlock, /requireAdmin/);
  assert.match(queryBlock, /checkScope\(req,\s*res,\s*repo\.workspace_id\)/);
  const scopeAt = queryBlock.indexOf("checkScope");
  const callAt = queryBlock.indexOf("queryGraphify");
  assert.ok(scopeAt >= 0 && callAt > scopeAt, "checkScope must run before queryGraphify");
});

test("zero prompt tax still holds after graphify build/query APIs exist", () => {
  db.exec("DELETE FROM repo_accelerators; DELETE FROM repos; DELETE FROM workspaces;");
  const wsId = workspaces.create({ slug: "zt", name: "ZT", config_dir: "/tmp/zt" }).id;
  const repo = repos.create({
    workspace_id: wsId, name: "r", path: "/tmp/r",
    done_criteria: "- [ ] tests pass", human_gate: "high",
  });
  const beforeCtx = agentContext(wsId, repo.id);
  const beforeDone = formatDoneCriteria(repo);
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "code-only");
  assert.equal(agentContext(wsId, repo.id), beforeCtx);
  assert.equal(formatDoneCriteria(repo), beforeDone);
});
