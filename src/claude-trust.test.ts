import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAddDirs, claudeTrustTargets, ensureBypassAccepted, ensureTrustedCwd, ensureTrustedDirs, gitRootOf, repoRootDenied } from "./claude-trust.js";

const profile = (state?: unknown) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-trust-"));
  if (state !== undefined) fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(state));
  return dir;
};
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));

test("a folder the profile has never seen gets trusted before the spawn, everything else in the file kept", () => {
  const dir = profile({ oauthAccount: { email: "me@x" }, projects: { "/other": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] } } });
  assert.equal(ensureTrustedCwd(dir, "/Users/x/Documents/GitHub/globex"), "added");
  const s = read(dir);
  assert.equal(s.oauthAccount.email, "me@x", "the login survives");
  assert.deepEqual(s.projects["/other"], { hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
  const p = s.projects["/Users/x/Documents/GitHub/globex"];
  assert.equal(p.hasTrustDialogAccepted, true);
  assert.deepEqual(p.allowedTools, []);
  assert.deepEqual(p.mcpServers, {});
});

test("an already-trusted folder is left untouched", () => {
  const dir = profile({ projects: { "/repo": { hasTrustDialogAccepted: true, lastCost: 1.5 } } });
  const before = fs.readFileSync(path.join(dir, ".claude.json"), "utf8");
  assert.equal(ensureTrustedCwd(dir, "/repo"), "already");
  assert.equal(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"), before);
});

test("a folder the profile knows but never trusted keeps its settings and gains the flag", () => {
  const dir = profile({ projects: { "/repo": { hasTrustDialogAccepted: false, allowedTools: ["Read"], lastCost: 2 } } });
  assert.equal(ensureTrustedCwd(dir, "/repo"), "added");
  assert.deepEqual(read(dir).projects["/repo"], { allowedTools: ["Read"], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, lastCost: 2 });
});

test("a profile with no state file yet (a login that never happened) is not invented", () => {
  const dir = profile();
  assert.equal(ensureTrustedCwd(dir, "/repo"), "skipped");
  assert.equal(fs.existsSync(path.join(dir, ".claude.json")), false);
});

test("a corrupt state file is left for claude to deal with, not overwritten", () => {
  const dir = profile();
  fs.writeFileSync(path.join(dir, ".claude.json"), "{not json");
  assert.equal(ensureTrustedCwd(dir, "/repo"), "skipped");
  assert.equal(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"), "{not json");
});

// The M5 host (2026-09-24): the disk says `Github`, the scan said `GitHub`, APFS opened both, and the
// trust entry under `GitHub` was invisible to claude, whose getcwd() returns `Github`.
test("trust is written under the on-disk case too, on a case-insensitive disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trust-case-"));
  const real = path.join(root, "Github", "repo");
  fs.mkdirSync(real, { recursive: true });
  const asked = path.join(root, "GitHub", "repo");
  if (!fs.existsSync(asked)) return t.skip("case-sensitive filesystem");
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "trust-cfg-"));
  fs.writeFileSync(path.join(cfg, ".claude.json"), "{}");
  assert.equal(ensureTrustedCwd(cfg, asked), "added");
  const projects = JSON.parse(fs.readFileSync(path.join(cfg, ".claude.json"), "utf8")).projects;
  const onDisk = fs.realpathSync.native(asked);
  assert.ok(onDisk.includes("/Github/"), onDisk);
  assert.equal(projects[asked].hasTrustDialogAccepted, true);
  assert.equal(projects[onDisk].hasTrustDialogAccepted, true);
  assert.equal(ensureTrustedCwd(cfg, asked), "already");
});

test("bypass-permissions warning: pre-accepted once, other settings kept, junk left alone", () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "bypass-"));
  assert.equal(ensureBypassAccepted(cfg), "added"); // no settings.json yet: a logged-in profile dir is enough
  const f = path.join(cfg, "settings.json");
  fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: [] }, model: "x" }));
  assert.equal(ensureBypassAccepted(cfg), "added");
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(s, { hooks: { Stop: [] }, model: "x", skipDangerousModePermissionPrompt: true });
  assert.equal(ensureBypassAccepted(cfg), "already");
  fs.writeFileSync(f, "not json");
  assert.equal(ensureBypassAccepted(cfg), "skipped");
  assert.equal(fs.readFileSync(f, "utf8"), "not json");
  assert.equal(ensureBypassAccepted(path.join(cfg, "missing")), "skipped");
});

// Claude Code 2.1.326 (2026-11-17): every --add-dir with no trust record got an "Adding a new
// directory" dialog at startup, defaulting to "No, exit", and every seeded Desk terminal sat on it.
test("every added folder is trusted in one write, alongside the cwd", () => {
  const dir = profile({ projects: { "/repo": { hasTrustDialogAccepted: true } } });
  assert.equal(ensureTrustedDirs(dir, ["/repo", "/wt/repo", "/Downloads/Acme"]), "added");
  const p = read(dir).projects;
  for (const k of ["/repo", "/wt/repo", "/Downloads/Acme"]) assert.equal(p[k].hasTrustDialogAccepted, true, k);
  assert.equal(ensureTrustedDirs(dir, ["/repo", "/wt/repo", "/Downloads/Acme"]), "already");
});

test("a terminal's own drop dir is trusted through the drops root, not one record per terminal", () => {
  assert.deepEqual(
    claudeTrustTargets("/repo", ["/wt/repo", "/h/.mc/drops/1b62c18e", "/h/.mc/drops/acdaa98e", "/h/.mc/dropsy"], "/h/.mc/drops"),
    ["/repo", "/wt/repo", "/h/.mc/drops", "/h/.mc/dropsy"],
  );
});

test("the tickets folder stays out of claude's --add-dir list, the rest keep their order", () => {
  assert.deepEqual(claudeAddDirs(["/wt/repo", "/h/chronos/tickets/acme", "/h/.mc/drops/x"], ["/h/chronos/tickets/acme/"]), ["/wt/repo", "/h/.mc/drops/x"]);
  assert.deepEqual(claudeAddDirs(["/wt/repo"], [null, undefined]), ["/wt/repo"]);
});

test("a folder whose git root the sandbox denies leaves claude's --add-dir list; its own repo stays", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-trust-root-"));
  const other = path.join(home, "Grid Leo");             // another workspace's repo…
  const nested = path.join(other, "shareout-app");       // …with this workspace's folder inside it
  const own = path.join(home, "own-repo");
  const plain = path.join(home, "Downloads", "Personal"); // no repo at all
  for (const d of [path.join(other, ".git"), nested, path.join(own, ".git"), plain]) fs.mkdirSync(d, { recursive: true });
  assert.equal(gitRootOf(nested), other);
  assert.equal(gitRootOf(own), own);
  assert.equal(gitRootOf(plain), null);
  assert.equal(repoRootDenied(nested, [other]), true);
  assert.equal(repoRootDenied(nested, [home]), true, "denied through a parent of the root");
  assert.equal(repoRootDenied(nested, []), false, "no sandbox, nothing to drop");
  assert.equal(repoRootDenied(own, [other]), false);
  assert.equal(repoRootDenied(own, [own]), false, "a repo that is its own root is not this case");
  assert.equal(repoRootDenied(plain, [home]), false);
  assert.deepEqual(claudeAddDirs([own, nested, plain], [], [other]), [own, plain]);
  assert.deepEqual(claudeAddDirs([own, nested, plain], []), [own, nested, plain], "unchanged without denies");
});
