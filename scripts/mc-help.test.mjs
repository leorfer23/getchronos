/**
 * `mc session new --help` must print usage and NEVER open a terminal.
 *
 * Regression: parse() used to swallow `--help` as an ignored option, then
 * `session new` POSTed /sessions with no goal → blank card on the Desk.
 * Robert's workaround was "never run mc session new --help" (memory-robert.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
// Anything that actually hits the API would fail hard against this port.
const env = { ...process.env, MC_API: "http://127.0.0.1:1/api" };

function run(...args) {
  return spawnSync(process.execPath, [mc, ...args], { env, encoding: "utf8" });
}

for (const args of [
  ["session", "new", "--help"],
  ["session", "new", "-h"],
  ["--help"],
  ["session", "new", "--backend", "grok", "--help"],
]) {
  test(`mc ${args.join(" ")} prints usage and does not spawn`, () => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /mc session new/);
    assert.doesNotMatch(
      `${r.stdout}${r.stderr}`,
      /spawned session|ECONNREFUSED|fetch failed|connect/i,
    );
  });
}
