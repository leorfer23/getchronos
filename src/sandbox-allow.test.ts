/**
 * Per-workspace credential grants.
 *
 * `workspaceSandboxAllow` is the whole boundary: its output goes straight into an
 * `(allow file-write* ...)` rule that runs AFTER the global secrets deny. A bad value here does not
 * fail loudly — it silently widens the sandbox for every agent in that workspace. So most of these
 * are about what it must REFUSE.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, workspaceSandboxAllow } from "./sandbox.js";

const home = fs.realpathSync(os.homedir());

describe("workspaceSandboxAllow", () => {
  test("accepts an existing dir under $HOME, and expands ~", () => {
    const dir = fs.mkdtempSync(path.join(home, ".sandbox-allow-test-"));
    try {
      assert.deepEqual(workspaceSandboxAllow(JSON.stringify([dir])), [fs.realpathSync(dir)]);
      const tilde = "~/" + path.relative(home, dir);
      assert.deepEqual(workspaceSandboxAllow(JSON.stringify([tilde])), [fs.realpathSync(dir)]);
    } finally {
      fs.rmdirSync(dir);
    }
  });

  test("refuses anything outside $HOME, including via ..", () => {
    // The one that matters: a path that escapes $HOME would re-grant write access to system dirs
    // on top of a deny that everything else in the profile depends on.
    for (const bad of ["/etc", "/", "/usr/local", `${home}/../../etc`, "/private/etc"]) {
      assert.deepEqual(workspaceSandboxAllow(JSON.stringify([bad])), [], `must refuse ${bad}`);
    }
  });

  test("refuses $HOME itself — that would re-grant every secret at once", () => {
    assert.deepEqual(workspaceSandboxAllow(JSON.stringify([home])), []);
    assert.deepEqual(workspaceSandboxAllow(JSON.stringify(["~"])), []);
    assert.deepEqual(workspaceSandboxAllow(JSON.stringify(["~/"])), []);
  });

  test("refuses a path that does not exist", () => {
    // A name nothing occupies yet is either a typo or a slot something could later be created in,
    // at a path the sandbox has already been told to trust.
    assert.deepEqual(workspaceSandboxAllow(JSON.stringify([`${home}/definitely-not-here-9f3a`])), []);
  });

  test("is empty for every workspace that has not been given one", () => {
    assert.deepEqual(workspaceSandboxAllow(null), []);
    assert.deepEqual(workspaceSandboxAllow(undefined), []);
    assert.deepEqual(workspaceSandboxAllow(""), []);
  });

  test("survives junk instead of throwing — one typo must not stop a terminal spawning", () => {
    assert.deepEqual(workspaceSandboxAllow("not json"), []);
    assert.deepEqual(workspaceSandboxAllow('{"not":"an array"}'), []);
    assert.deepEqual(workspaceSandboxAllow(JSON.stringify([42, null, "", "   "])), []);
  });

  test("keeps the good entries and drops only the bad ones", () => {
    const dir = fs.mkdtempSync(path.join(home, ".sandbox-allow-test-"));
    try {
      const out = workspaceSandboxAllow(JSON.stringify(["/etc", dir, `${home}/nope-4b2c`]));
      assert.deepEqual(out, [fs.realpathSync(dir)]);
    } finally {
      fs.rmdirSync(dir);
    }
  });
});

describe("the profile the grant produces", () => {
  const gcloud = `${home}/.config/gcloud`;

  test("guard: the allow comes AFTER the secrets deny, or it does nothing", () => {
    // SBPL takes the LAST matching rule. An allow emitted before the deny is not a weaker grant —
    // it is no grant at all, and the symptom is an agent that still cannot run bq with the feature
    // apparently switched on.
    const profile = buildProfile("guard", "/tmp/x", [], `${home}/.claude`, [], false, [], [gcloud])!;
    const denyAt = profile.lastIndexOf(`(deny file-write*`);
    const allowAt = profile.lastIndexOf(`(allow file-write*`);
    assert.ok(profile.includes(gcloud), "the granted path must appear in the profile");
    assert.ok(allowAt > denyAt, "the re-grant must be the last word on that path");
  });

  test("strict: the same ordering holds", () => {
    const profile = buildProfile("strict", "/tmp/x", [], `${home}/.claude`, [], false, [], [gcloud])!;
    const denyAt = profile.lastIndexOf(`(deny file-write*`);
    const allowAt = profile.lastIndexOf(`(allow file-write*`);
    assert.ok(allowAt > denyAt);
  });

  test("granting nothing leaves the deny standing — the default for every workspace", () => {
    const profile = buildProfile("guard", "/tmp/x", [], `${home}/.claude`, [], false, [], [])!;
    const denyAt = profile.lastIndexOf("(deny file-write*");
    const allowAt = profile.lastIndexOf("(allow file-write*");
    assert.ok(denyAt > allowAt, "with no grant, a secrets deny must be the last word");
  });
});
