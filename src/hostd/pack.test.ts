/**
 * What `npm pack` would publish as `getchronos` (HOSTS.md → Distribution). The package is an
 * allowlist (`files`), and this repo is also a live daemon checkout that holds the brain's TLS key,
 * `.secrets`, the database and attachments beside the code. The test plants decoys of each inside the
 * allowlisted directories and asserts none of them — nor a test file — would ship, and that what a
 * host needs at runtime does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { npmCliFor } from "./update.js";

const REPO = process.cwd();

test("npm pack: bin, dist, the plist template, mc and its skill — never secrets, keys, databases or tests", () => {
  const tag = `decoy-${process.pid}`;
  const madeDist = !fs.existsSync(path.join(REPO, "dist"));
  const decoys = [
    path.join("bin", ".secrets"),
    path.join("bin", `${tag}.pem`),
    path.join("skills", "mission-control", `${tag}.pem`),
    path.join("dist", tag, "chronos.db"),
    path.join("dist", tag, "thing.test.js"),
    path.join("dist", tag, "thing.eval.js"),
    path.join("dist", tag, ".secrets.local"),
    path.join("dist", tag, "ok.js"),
  ];
  try {
    for (const d of decoys) {
      fs.mkdirSync(path.join(REPO, path.dirname(d)), { recursive: true });
      fs.writeFileSync(path.join(REPO, d), "decoy");
    }
    const npm = npmCliFor();
    // --ignore-scripts: prepack would run a full tsc build; the allowlist is what is under test.
    const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
    const out = npm ? execFileSync(process.execPath, [npm, ...args], { cwd: REPO, encoding: "utf8" }) : execFileSync("npm", args, { cwd: REPO, encoding: "utf8" });
    const [info] = JSON.parse(out);
    const files: string[] = info.files.map((f: { path: string }) => f.path);
    assert.equal(info.name, "getchronos");
    for (const need of ["package.json", "bin/getchronos.mjs", "bin/host-core.mjs", "launchd/sh.chronos.host.plist.template", "launchd/sh.chronos.hostbar.plist.template", "desktop/hostbar.swift", "scripts/mc", "scripts/fix-node-pty-perms.mjs", "skills/mission-control/SKILL.md", `dist/${tag}/ok.js`]) {
      assert.ok(files.includes(need), `ships ${need}`);
    }
    // desktop/ ships exactly one file: the menu bar item's source, compiled on the host (menubar.ts).
    const bad = files.filter((f) => f !== "desktop/hostbar.swift").filter((f) =>
      /(^|\/)\.secrets/.test(f) || /\.pem$/.test(f) || /\.db(-wal|-shm)?$/.test(f) || /\.(test|eval)\.(js|ts|mjs)$/.test(f) ||
      /^(hostlink|attachments|notes|tickets|secrets|backups|sessions|src|evals|static|agents|relay|desktop|local)\//.test(f) || /^\.admin-token$/.test(f));
    assert.deepEqual(bad, [], "nothing private and no tests in the tarball");
  } finally {
    for (const d of decoys) fs.rmSync(path.join(REPO, d), { force: true });
    fs.rmSync(path.join(REPO, "dist", tag), { recursive: true, force: true });
    if (madeDist) fs.rmSync(path.join(REPO, "dist"), { recursive: true, force: true });
  }
});

test("package.json: getchronos with its bin, a node range the preflight agrees with, and a prepack build", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.name, "getchronos");
  assert.deepEqual(pkg.bin, { getchronos: "./bin/getchronos.mjs" });
  assert.equal(pkg.engines.node, ">=22 <27");
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.private, true, "kept private until the operator decides to publish (HOSTS.md → Publishing)");
  assert.match(fs.readFileSync(path.join(REPO, "bin", "getchronos.mjs"), "utf8"), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(path.join(REPO, "bin", "getchronos.mjs")).mode & 0o100, "the bin is executable");
});
