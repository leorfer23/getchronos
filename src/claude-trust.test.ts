import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTrustedCwd } from "./claude-trust.js";

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
