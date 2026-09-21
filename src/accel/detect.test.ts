import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { versionOf, detectGraphify, detectTool } from "./detect.js";
import { tryResolveTrustedBin, parseToolVersion } from "./resolve-bin.js";
import { graphifyChildEnv } from "./graphify-env.js";

test("versionOf: a real, always-present binary reports installed with a version line", () => {
  // `node` is guaranteed present — this is the test runner. Proves the happy path without mocking
  // child_process.
  const v = versionOf(process.execPath, ["--version"]);
  assert.equal(v.installed, true);
  assert.ok(v.version && v.version.startsWith("v"), `expected a version string, got ${v.version}`);
});

test("versionOf: a nonexistent binary is 'not installed', never a thrown error", () => {
  const v = versionOf("definitely-not-a-real-binary-xyz-123");
  assert.deepEqual(v, { installed: false, version: null });
});

test("versionOf: a binary that exits non-zero on --version is also 'not installed'", () => {
  // `false` exits 1 unconditionally on darwin/linux.
  const v = versionOf("false");
  assert.deepEqual(v, { installed: false, version: null });
});

// Detect and execute share tryResolveTrustedBin (PATH + ~/.local/bin + Homebrew). Compare against
// that same probe — not a bare `versionOf("graphify")` which misses the launchd fallback path.
const cliBin = tryResolveTrustedBin("graphify");
const cliProbe = cliBin
  ? { installed: true, version: parseToolVersion(versionOf(cliBin).version) }
  : { installed: false, version: null };

test("detectGraphify: a skill file present never flips `installed` — that stays tied to the CLI probe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-cfg-"));
  fs.mkdirSync(path.join(dir, "skills", "graphify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "graphify", "SKILL.md"), "# graphify");
  const s = detectGraphify(dir);
  assert.equal(s.installed, cliProbe.installed);
  assert.equal(s.version, cliProbe.version);
  assert.match(s.detail!, /skill file present/);
});

test("detectGraphify: no config_dir at all still reports via the skill-detail branch, never crashes", () => {
  const s = detectGraphify(null);
  assert.equal(s.installed, cliProbe.installed);
  assert.match(s.detail!, /no config_dir/);
});

test("detectGraphify: config_dir without the skill notes that in detail, `installed` still tied to the CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-cfg-"));
  const s = detectGraphify(dir);
  assert.equal(s.installed, cliProbe.installed);
  assert.match(s.detail!, /skill file not found/);
});

test("detectGraphify: installed reflects the trusted-bin probe, not the skill file", () => {
  const s = detectGraphify(null);
  assert.equal(s.installed, cliProbe.installed);
  assert.equal(s.version, cliProbe.version);
});

test("detectGraphify uses tryResolveTrustedBin (PATH + ~/.local/bin fallbacks), same as execution", () => {
  const src = fs.readFileSync(new URL("./detect.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function detectGraphify"));
  assert.match(fn, /tryResolveTrustedBin\(\s*"graphify"\s*\)/);
  assert.match(fn, /tryResolveTrustedBin\(\s*"graphify-mcp"\s*\)/);
});

test("detectTool routes to the right detector per tool name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-cfg-"));
  assert.equal(detectTool("graphify", dir).tool, "graphify");
  assert.equal(detectTool("ast-grep", dir).tool, "ast-grep");
  assert.equal(detectTool("repomix", dir).tool, "repomix");
});

test("detectGraphify probes graphify-mcp via --help (it has no --version)", () => {
  const src = fs.readFileSync(new URL("./detect.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function detectGraphify"));
  assert.match(fn, /versionOf\(\s*mcpBin\s*,\s*\["--help"\]\s*,\s*graphifyChildEnv\(\)\s*\)/);
  assert.doesNotMatch(fn, /versionOf\(\s*"graphify-mcp"\s*\)/);
});

test("versionOf probe with graphifyChildEnv cannot observe a planted provider secret", () => {
  const key = "OPENAI_API_KEY";
  const prior = process.env[key];
  process.env[key] = "planted-provider-secret";
  const script = path.join(os.tmpdir(), `mc-versionof-env-${process.pid}.mjs`);
  // The child reports presence only. It must never write the secret to stdout.
  fs.writeFileSync(script, 'process.stdout.write(process.env.OPENAI_API_KEY ? "seen\\n" : "hidden\\n");\n');
  try {
    const probed = versionOf(process.execPath, [script], graphifyChildEnv());
    assert.equal(probed.installed, true);
    assert.equal(probed.version, "hidden");
  } finally {
    fs.rmSync(script, { force: true });
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

test("Graphify version/help probes pass graphifyChildEnv; ast-grep and repomix do not", () => {
  const detect = fs.readFileSync(new URL("./detect.ts", import.meta.url), "utf8");
  const graphify = fs.readFileSync(new URL("./graphify.ts", import.meta.url), "utf8");
  const detectFn = detect.slice(detect.indexOf("export function detectGraphify"));
  const canary = graphify.slice(graphify.indexOf("function requireCanary"), graphify.indexOf("function validateSession"));
  const astFn = detect.slice(detect.indexOf("export function detectAstGrep"), detect.indexOf("export function detectRepomix"));
  const repomixFn = detect.slice(detect.indexOf("export function detectRepomix"), detect.indexOf("export function detectGraphify"));
  assert.match(detectFn, /versionOf\(\s*cliBin\s*,\s*\["--version"\]\s*,\s*graphifyChildEnv\(\)\s*\)/);
  assert.match(detectFn, /versionOf\(\s*mcpBin\s*,\s*\["--help"\]\s*,\s*graphifyChildEnv\(\)\s*\)/);
  assert.match(canary, /versionOf\(\s*bin\s*,\s*\["--version"\]\s*,\s*graphifyChildEnv\(\)\s*\)/);
  assert.match(astFn, /versionOf\("ast-grep"\)/);
  assert.match(repomixFn, /versionOf\("repomix"\)/);
  assert.doesNotMatch(astFn, /graphifyChildEnv/);
  assert.doesNotMatch(repomixFn, /graphifyChildEnv/);
});
