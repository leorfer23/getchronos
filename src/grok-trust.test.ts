import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGrokTrustedCwd, grokHome } from "./grok-trust.js";

const home = (toml?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-grok-trust-"));
  if (toml !== undefined) fs.writeFileSync(path.join(dir, "trusted_folders.toml"), toml);
  return dir;
};
const read = (dir: string) => fs.readFileSync(path.join(dir, "trusted_folders.toml"), "utf8");
const existing = `[folders."/Users/x/Documents/Presence"]\ntrusted = true\ndecided_at = 1784219585\n`;

test("a folder grok has never seen gets its trust block before the spawn, existing blocks kept", () => {
  const dir = home(existing);
  const before = Math.floor(Date.now() / 1000);
  assert.equal(ensureGrokTrustedCwd("/Users/x/Documents/GitHub/personal", dir), "added");
  const out = read(dir);
  assert.ok(out.startsWith(existing), "the folders already trusted survive byte for byte");
  const m = out.match(/\n\[folders\."\/Users\/x\/Documents\/GitHub\/personal"\]\ntrusted = true\ndecided_at = (\d+)\n$/);
  assert.ok(m, `block appended in grok's own format, got:\n${out}`);
  assert.ok(Number(m![1]) >= before);
});

test("an already-trusted folder is left untouched", () => {
  const dir = home(existing);
  assert.equal(ensureGrokTrustedCwd("/Users/x/Documents/Presence", dir), "already");
  assert.equal(read(dir), existing);
});

test("a folder once declined keeps its other keys and flips to trusted", () => {
  const dir = home(`${existing}\n[folders."/repo"]\ntrusted = false\ndecided_at = 1\nnote = "keep me"\n\n[folders."/other"]\ntrusted = true\ndecided_at = 2\n`);
  assert.equal(ensureGrokTrustedCwd("/repo", dir), "added");
  const out = read(dir);
  assert.match(out, /\[folders\."\/repo"\]\ntrusted = true\ndecided_at = \d{10,}\nnote = "keep me"\n\n\[folders\."\/other"\]\ntrusted = true\ndecided_at = 2\n$/);
  assert.ok(out.startsWith(existing));
  assert.doesNotMatch(out, /decided_at = 1\n/);
});

test("a file without a trailing newline still gets the header on its own line", () => {
  const dir = home(existing.trimEnd());
  assert.equal(ensureGrokTrustedCwd("/repo", dir), "added");
  assert.match(read(dir), /decided_at = 1784219585\n\n\[folders\."\/repo"\]\ntrusted = true\n/);
});

test("quotes and backslashes in the path are escaped as a TOML basic string", () => {
  const dir = home("");
  assert.equal(ensureGrokTrustedCwd('/tmp/we"ird\\dir', dir), "added");
  assert.match(read(dir), /^\[folders\."\/tmp\/we\\"ird\\\\dir"\]\n/);
  assert.equal(ensureGrokTrustedCwd('/tmp/we"ird\\dir', dir), "already");
});

test("a home with no trust file yet (grok never ran) is not invented", () => {
  const dir = home();
  assert.equal(ensureGrokTrustedCwd("/repo", dir), "skipped");
  assert.equal(fs.existsSync(path.join(dir, "trusted_folders.toml")), false);
});

test("the file's mode is preserved across the rewrite", () => {
  const dir = home(existing);
  fs.chmodSync(path.join(dir, "trusted_folders.toml"), 0o644);
  ensureGrokTrustedCwd("/repo", dir);
  assert.equal(fs.statSync(path.join(dir, "trusted_folders.toml")).mode & 0o777, 0o644);
});

test("GROK_HOME overrides the default ~/.grok", () => {
  assert.equal(grokHome({ GROK_HOME: "/x/grok" }), "/x/grok");
  assert.equal(grokHome({}), path.join(os.homedir(), ".grok"));
});
