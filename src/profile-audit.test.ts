/**
 * The profile audit finds what one project's CLI gets from another's outside any sandbox rule —
 * a linked skills dir, a client's plugin marketplace in a second profile, a secret exported to
 * every shell, one credential file for two projects — and reports names, never values.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditProfiles, type AuditInput } from "./profile-audit.js";

let home: string;
const dir = (...p: string[]) => { const d = path.join(home, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (rel: string, body: string) => { dir(path.dirname(rel)); fs.writeFileSync(path.join(home, rel), body); };
const input = (extra: Partial<AuditInput> = {}): AuditInput => ({
  home,
  profileDirs: [".claude", ".claude-acme", ".claude-globex", ".claude-second"].map((p) => path.join(home, p)).filter((p) => fs.existsSync(p)),
  workspaces: [
    { slug: "personal", config_dir: null },
    { slug: "acme", config_dir: path.join(home, ".claude-acme") },
    { slug: "globex", config_dir: path.join(home, ".claude-globex") },
  ],
  sharedMarketplaces: ["claude-plugins-official"],
  ...extra,
});

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-audit-")));
  dir(".claude", "skills", "acme-db");
  dir(".claude-acme");
  dir(".claude-globex");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

test("a clean machine has no findings", () => {
  dir(".claude-acme", "skills");
  assert.deepEqual(auditProfiles(input()), []);
});

test("a project's skills dir linked to another profile's is found; a real dir of chosen links is not", () => {
  fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(home, ".claude-globex", "skills"));
  dir(".claude-acme", "skills");
  fs.symlinkSync(path.join(home, ".claude", "skills", "acme-db"), path.join(home, ".claude-acme", "skills", "acme-db"));
  const f = auditProfiles(input());
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "shared-dir");
  assert.equal(f[0].path, path.join(home, ".claude-globex", "skills"));
  assert.deepEqual(f[0].workspaces.sort(), ["globex", "personal"]);
});

test("a profile no project runs on may mirror the default one", () => {
  dir(".claude-second");
  fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(home, ".claude-second", "skills"));
  assert.deepEqual(auditProfiles(input()), []);
});

test("two projects on one profile share its dirs without a finding", () => {
  fs.symlinkSync(path.join(home, ".claude", "skills"), path.join(home, ".claude-acme", "skills"));
  const ws = [{ slug: "personal", config_dir: null }, { slug: "side", config_dir: path.join(home, ".claude") }, { slug: "acme", config_dir: path.join(home, ".claude-acme") }];
  assert.equal(auditProfiles(input({ workspaces: ws })).filter((f) => f.check === "shared-dir").length, 1);
  const same = [{ slug: "a", config_dir: path.join(home, ".claude-acme") }, { slug: "b", config_dir: path.join(home, ".claude-acme") }];
  fs.unlinkSync(path.join(home, ".claude-acme", "skills"));
  assert.deepEqual(auditProfiles(input({ workspaces: same })), []);
});

test("a third-party marketplace in two projects' profiles is found; the official one and a linked plugins dir are not", () => {
  const market = (p: string, names: string[]) => write(path.join(p, "plugins", "known_marketplaces.json"), JSON.stringify(Object.fromEntries(names.map((n) => [n, {}]))));
  market(".claude", ["claude-plugins-official"]);
  market(".claude-acme", ["claude-plugins-official", "acme-tools"]);
  market(".claude-globex", ["claude-plugins-official", "acme-tools", "globex-only"]);
  dir(".claude-second");
  fs.symlinkSync(path.join(home, ".claude", "plugins"), path.join(home, ".claude-second", "plugins"));
  const f = auditProfiles(input());
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "shared-marketplace");
  assert.match(f[0].detail, /"acme-tools"/);
  assert.deepEqual(f[0].workspaces.sort(), ["acme", "globex"]);
  assert.deepEqual(auditProfiles(input({ sharedMarketplaces: ["claude-plugins-official", "acme-tools"] })), []);
});

test("a top-level secret export is found by name and line, never by value; scoped and plain ones are not", () => {
  write(".zshrc", [
    "export PATH=\"$HOME/bin:$PATH\"",
    "export ACME_API_KEY=sk-live-do-not-print",
    "acme() {",
    "  export ACME_TOKEN=also-secret",
    "  ACME_SECRET=inline command acme \"$@\"",
    "}",
    "# export OLD_TOKEN=commented",
  ].join("\n"));
  const f = auditProfiles(input());
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "shell-export");
  assert.equal(f[0].path, `${path.join(home, ".zshrc")}:2`);
  assert.match(f[0].detail, /ACME_API_KEY/);
  assert.ok(!JSON.stringify(f).includes("do-not-print"));
});

test("one credential file with two projects' sections is found; one project's alone is not", () => {
  write(".aws/credentials", "[default]\naws_access_key_id=AKIAEXAMPLE\n[acme]\naws_secret_access_key=shh\n[acme-prod-session]\n");
  write(".aws/config", "[profile acme-prod]\nregion=us-east-1\n[profile globex-data]\nregion=us-east-1\n[profile acmecorp]\n");
  const f = auditProfiles(input());
  assert.equal(f.length, 1);
  assert.equal(f[0].check, "mixed-store");
  assert.equal(f[0].path, path.join(home, ".aws", "config"));
  assert.deepEqual(f[0].workspaces.sort(), ["acme", "globex"]);
  assert.ok(!JSON.stringify(f).includes("AKIAEXAMPLE") && !JSON.stringify(f).includes("shh"));
});

test("a project's profile that runs something in ~/.claude its sandbox hides is found; the shared part is not", () => {
  write(".claude/hooks/guard.sh", "#!/bin/sh\n");
  write(".claude/launch-mcp.sh", "#!/bin/sh\n");
  write(".claude/RULES.md", "rules");
  write(".claude-acme/settings.json", JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/guard.sh" }] }] },
    claudeMdExcludes: ["~/.claude/RULES.md"],
  }));
  write(".claude-acme/.claude.json", JSON.stringify({ mcpServers: { chrome: { command: `${home}/.claude/launch-mcp.sh`, env: { TOKEN: "never-printed" } } } }));
  fs.symlinkSync(path.join(home, ".claude", "skills", "acme-db"), path.join(dir(".claude-acme", "skills"), "acme-db"));
  const f = auditProfiles(input()).filter((x) => x.check === "walled-claude-path");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].path, path.join(home, ".claude", "launch-mcp.sh"));
  assert.deepEqual(f[0].workspaces, ["acme"]);
  assert.match(f[0].detail, /\.claude\.json → mcpServers\.chrome\.command/);
  assert.match(f[0].fix, /CHRONOS_CLAUDE_SHARED_EXTRA/);
  assert.ok(!JSON.stringify(f).includes("never-printed"));
  // Shared by the operator → no longer a finding.
  assert.deepEqual(auditProfiles(input({ claudeShared: ["launch-mcp.sh"] })).filter((x) => x.check === "walled-claude-path"), []);
});

test("a link from a project's profile into a walled part of ~/.claude is found; the default profile is never judged", () => {
  write(".claude/plugins/installed_plugins.json", "{}");
  fs.symlinkSync(path.join(home, ".claude", "plugins"), path.join(home, ".claude-globex", "plugins"));
  write(".claude/settings.json", JSON.stringify({ statusLine: { command: "~/.claude/statusline.sh" } }));
  const f = auditProfiles(input()).filter((x) => x.check === "walled-claude-path");
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].path, path.join(home, ".claude", "plugins"));
  assert.match(f[0].detail, /the link plugins/);
  assert.deepEqual(f[0].workspaces, ["globex"]);
});
