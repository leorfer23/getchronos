/**
 * The sandbox side of running the default profile on the operator's own CLI homes (parity-env.ts), with
 * real `sandbox-exec` against a fixture HOME:
 *  - a workspace on a client's profile cannot read his ~/.claude.json (every MCP server he has, any
 *    credential written into one), claude's backups of it, or his ~/.codex (his ChatGPT login);
 *  - his own profile still can — including a walled client account routed onto it (profile-route.ts);
 *  - strict mode lets claude write ~/.claude.json the way it does: a lock and a temp file beside it,
 *    renamed over the file (granting the file alone made `claude mcp add-json` fail, claude 2.1.322).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// HOME first: sandbox.ts and config.ts read it once, at import.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-home-sbx-")));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const put = (f: string, body = "x") => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const ownConfig = path.join(home, ".claude.json");
const backup = path.join(home, ".claude", "backups", ".claude.json.backup.1");
const codexAuth = path.join(home, ".codex", "auth.json");
for (const f of [ownConfig, backup, codexAuth]) put(f, "{}");
const cwd = path.join(home, "work");
fs.mkdirSync(cwd);
fs.mkdirSync(path.join(home, ".claude-acme"));

const { buildProfile, claudeJsonSiblingsRule, sandboxAvailable } = await import("./sandbox.js");
const { workspaces } = await import("./store.js");
const canSandbox = sandboxAvailable();

function canRead(profile: string, file: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", file], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

test("a client workspace is denied the operator's own CLI homes; his own profile keeps them", { skip: !canSandbox }, () => {
  const t = Date.now();
  const client = workspaces.create({ slug: `sbx-client-${t}`, name: "Client", config_dir: path.join(home, ".claude-acme") } as any);
  const mine = workspaces.create({ slug: `sbx-mine-${t}`, name: "Mine", config_dir: path.join(home, ".claude") } as any);
  const clientDeny = workspaces.isolationDenyDirs(client.id);
  for (const p of [ownConfig, path.join(home, ".claude", "backups"), path.join(home, ".codex")]) assert.ok(clientDeny.includes(p), `client deny list lacks ${p}`);
  assert.ok(!workspaces.isolationDenyDirs(mine.id).includes(ownConfig), "never denied to his own profile's workspaces");

  const asClient = buildProfile("guard", cwd, [], path.join(home, ".claude-acme"), clientDeny)!;
  for (const f of [ownConfig, backup, codexAuth]) assert.equal(canRead(asClient, f), false, `a client agent read ${f}`);
  const asMine = buildProfile("guard", cwd, [], path.join(home, ".claude"), workspaces.isolationDenyDirs(mine.id))!;
  for (const f of [ownConfig, backup, codexAuth]) assert.equal(canRead(asMine, f), true, `his own agent could not read ${f}`);
  // A walled client account handed to his profile runs ON his profile: it needs his config to start.
  const routed = buildProfile("guard", cwd, [], path.join(home, ".claude"), clientDeny)!;
  assert.equal(canRead(routed, ownConfig), true);
});

/** True when the profile lets `script` run to the end — every write in it allowed. */
function canRun(profile: string, script: string): boolean {
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

test("strict: only the operator's own profile writes ~/.claude.json — a client profile is refused the file, claude's lock and its temp file", { skip: !canSandbox }, () => {
  const t = Date.now();
  const acme = path.join(home, ".claude-acme");
  const client = workspaces.create({ slug: `sbx-strict-client-${t}`, name: "Client", config_dir: acme } as any);
  const mine = workspaces.create({ slug: `sbx-strict-mine-${t}`, name: "Mine", config_dir: path.join(home, ".claude") } as any);
  const before = fs.readFileSync(ownConfig, "utf8");
  // The fixture home sits under the temp dir, which strict grants wholesale: only the explicit denies
  // can be what refuses these — the same denies that hold for a home anywhere else.
  for (const mode of ["strict", "guard"] as const) {
    const asClient = buildProfile(mode, cwd, [], acme, workspaces.isolationDenyDirs(client.id))!;
    assert.ok(!asClient.includes(claudeJsonSiblingsRule(home)), `${mode}: no siblings grant for a client profile`);
    assert.equal(canRun(asClient, `printf x >> "${ownConfig}"`), false, `${mode}: a client agent wrote the operator's ~/.claude.json`);
    assert.equal(canRun(asClient, `mkdir "${ownConfig}.lock"`), false, `${mode}: a client agent took claude's lock on it`);
    assert.equal(canRun(asClient, `printf x > "${ownConfig}.123.tmp"`), false, `${mode}: a client agent wrote beside it`);
    assert.equal(canRun(asClient, `printf x > "${cwd}/ok-${mode}" && printf x > "${acme}/ok-${mode}"`), true, `${mode}: its own places stay writable`);
  }
  assert.equal(fs.readFileSync(ownConfig, "utf8"), before);
  assert.equal(fs.existsSync(`${ownConfig}.lock`), false);
  // A client's strict profile also no longer writes into another profile's history under ~/.claude.
  const projects = path.join(home, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true });
  assert.equal(canRun(buildProfile("strict", cwd, [], acme, workspaces.isolationDenyDirs(client.id))!, `printf x > "${projects}/x.jsonl"`), false);
  // The operator's own profile: claude's lock + temp + rename goes through.
  const asMine = buildProfile("strict", cwd, [], path.join(home, ".claude"), workspaces.isolationDenyDirs(mine.id))!;
  assert.equal(canRun(asMine, `mkdir "${ownConfig}.lock" && printf '{"ok":1}' > "${ownConfig}.9.tmp" && mv "${ownConfig}.9.tmp" "${ownConfig}" && rmdir "${ownConfig}.lock"`), true);
  assert.equal(fs.readFileSync(ownConfig, "utf8"), '{"ok":1}');
  fs.writeFileSync(ownConfig, before);
});

test("strict: claude's lock + temp + rename on ~/.claude.json goes through; the file alone would not", { skip: !canSandbox }, () => {
  const strict = buildProfile("strict", cwd, [], path.join(home, ".claude"), [])!;
  assert.ok(strict.includes(claudeJsonSiblingsRule(home)), "the strict profile grants the siblings");
  // The rule on its own, under a write-nothing profile — so the fixture living under the temp dir
  // (which strict mode grants wholesale) cannot be what lets the write through.
  const base = '(version 1)(allow default)(deny file-write* (subpath "/"))(allow file-write* (subpath "/dev"))';
  const write = `mkdir "${ownConfig}.lock" && printf '{}' > "${ownConfig}.tmp.1" && mv "${ownConfig}.tmp.1" "${ownConfig}" && rmdir "${ownConfig}.lock"`;
  const run = (profile: string) => {
    try {
      execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", write], { stdio: ["ignore", "ignore", "ignore"], timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(run(`${base}(allow file-write* (literal "${ownConfig}"))`), false, "the file alone is not enough for claude's write");
  fs.rmSync(`${ownConfig}.lock`, { recursive: true, force: true });
  assert.equal(run(base + claudeJsonSiblingsRule(home)), true);
  assert.equal(fs.readFileSync(ownConfig, "utf8"), "{}");
  // …and the prefix grants nothing else in the home.
  const elsewhere = path.join(home, "elsewhere.json");
  try {
    execFileSync("/usr/bin/sandbox-exec", ["-p", base + claudeJsonSiblingsRule(home), "/bin/sh", "-c", `printf x > "${elsewhere}"`], { stdio: "ignore", timeout: 8000 });
  } catch {}
  assert.equal(fs.existsSync(elsewhere), false);
});
