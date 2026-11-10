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

test("detectTool routes to the right detector per tool name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-cfg-"));
  assert.equal(detectTool("graphify", dir).tool, "graphify");
  assert.equal(detectTool("ast-grep", dir).tool, "ast-grep");
  assert.equal(detectTool("repomix", dir).tool, "repomix");
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


test("detectGraphify probes the resolved CLI with --version and graphify-mcp with --help, both without provider secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-accel-fake-"));
  const cli = path.join(dir, "graphify"), mcp = path.join(dir, "graphify-mcp");
  // Each fake answers only the probe it is meant to get, and only when the secret is NOT in its env.
  fs.writeFileSync(cli, `#!${process.execPath}\nif (process.env.OPENAI_API_KEY || !process.argv.includes("--version")) process.exit(1);\nconsole.log("graphify 1.2.3");\n`, { mode: 0o755 });
  fs.writeFileSync(mcp, `#!${process.execPath}\nif (process.env.OPENAI_API_KEY || !process.argv.includes("--help")) process.exit(1);\nconsole.log("usage: graphify-mcp");\n`, { mode: 0o755 });
  const saved = { cli: process.env.CHRONOS_GRAPHIFY_BIN, mcp: process.env.CHRONOS_GRAPHIFY_MCP_BIN, key: process.env.OPENAI_API_KEY };
  process.env.CHRONOS_GRAPHIFY_BIN = cli;
  process.env.CHRONOS_GRAPHIFY_MCP_BIN = mcp;
  process.env.OPENAI_API_KEY = "planted-provider-secret";
  try {
    const s = detectGraphify(null);
    assert.equal(s.installed, true);
    assert.equal(s.version, "1.2.3");
    assert.match(s.detail!, /graphify-mcp present/);
  } finally {
    for (const [k, v] of [["CHRONOS_GRAPHIFY_BIN", saved.cli], ["CHRONOS_GRAPHIFY_MCP_BIN", saved.mcp], ["OPENAI_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
