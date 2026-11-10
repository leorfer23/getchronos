/**
 * The daemon's own secret files, beside the code, are denied to every agent — Robert included.
 *
 * Guard mode is `(allow default)` with a cwd re-grant, and Robert's fleet-wide process runs with
 * cwd = the daemon's checkout (`~/chronos`). So a daemon secret that sits beside the code is readable
 * from inside his sandbox UNLESS it is in `CONFIG.sandbox.secrets`. This pins the files that must be
 * on that list, by actually running `sandbox-exec` with the exact guard profile Robert is spawned
 * under and trying to read each one. A real read here (not a mock) is the only thing that catches a
 * file slipping off the list — `.vapid.json` and `.push-subscriptions.json` had, until this test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, sandboxAvailable } from "./sandbox.js";
import { CONFIG } from "./config.js";
import { inRepo } from "./repo-root.js";

const canSandbox = sandboxAvailable();
const home = os.homedir();

// Robert's guard profile at its widest: cwd = the daemon's checkout itself (the fleet-wide process's
// cwd, and the worst case for a project Robert — a repo-less workspace landing in the checkout). Every
// file beside the code is under this re-granted cwd, so only the secrets deny keeps it out.
function robertProfile(): string {
  const profile = buildProfile("guard", inRepo(), [], path.join(home, ".claude"), []);
  assert.ok(profile, "guard profile should build on a machine with sandbox-exec");
  return profile!;
}

/** True when the profile lets a read of `file` through. Uses a real file so a deny is the only reason it fails. */
function canRead(profile: string, file: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", file], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

test("the daemon's secret files beside the code are on the deny list", () => {
  // These must be denied to Robert and every guard agent. `.vapid.json` = the push SIGNING private key;
  // `.push-subscriptions.json` = every device endpoint; `.oss-names.local` = the real client names.
  const mustDeny = [".admin-token", ".secrets", "chronos.db", ".vapid.json", ".push-subscriptions.json", ".oss-names.local", ".broker.json"];
  const denied = new Set(CONFIG.sandbox.secrets.map((p) => path.resolve(p)));
  for (const f of mustDeny) {
    assert.ok(denied.has(path.resolve(inRepo(f))), `${f} must be in CONFIG.sandbox.secrets (a daemon secret readable from Robert's cwd otherwise)`);
  }
});

test("Robert's guard sandbox actually refuses to read them (real sandbox-exec)", { skip: !canSandbox }, () => {
  const profile = robertProfile();
  // A control: an ordinary file beside the code IS readable under the cwd re-grant — proving the
  // profile allows by default, so a deny below is the deny list working, not the sandbox refusing all.
  const control = path.join(fs.mkdtempSync(path.join(inRepo(), ".sbtest-")), "ordinary.txt");
  fs.writeFileSync(control, "readable");
  // Stand-ins at the exact denied paths (only where the real file is absent — never clobber a real one),
  // so the deny is exercised against a real file at the real path on any machine.
  const created: string[] = [];
  const targets = [".vapid.json", ".push-subscriptions.json", ".oss-names.local", ".secrets"].map((f) => inRepo(f));
  try {
    assert.equal(canRead(profile, control), true, "the guard profile allows an ordinary file under cwd — else this test proves nothing");
    for (const real of targets) {
      if (!fs.existsSync(real)) { fs.writeFileSync(real, "stand-in secret", { mode: 0o600 }); created.push(real); }
      assert.equal(canRead(profile, real), false, `Robert's sandbox must refuse ${path.basename(real)}`);
    }
  } finally {
    for (const f of created) fs.rmSync(f, { force: true });
    fs.rmSync(path.dirname(control), { recursive: true, force: true });
  }
});
