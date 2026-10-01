import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildHello, checklist, cliAuth, cursorAuthFrom, formatChecklist, hostDeny, hostRoots, sampleHostVitals, scanCheckouts, which } from "./inventory.js";
import { PROTOCOL_VERSION, checkCompat } from "../hostlink/wire.js";

test("roots: comma or colon separated, ~ expanded; deny: comma separated", () => {
  const home = os.homedir();
  assert.deepEqual(hostRoots("~/a, /b:~/c"), [path.join(home, "a"), "/b", path.join(home, "c")]);
  assert.deepEqual(hostRoots(""), []);
  assert.deepEqual(hostDeny("galley, gfm,,"), ["galley", "gfm"]);
  assert.deepEqual(hostDeny(""), []);
});

test("which finds an executable on the given PATH and ignores non-executables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-which-"));
  fs.writeFileSync(path.join(dir, "fakecli"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "notexec"), "x", { mode: 0o644 });
  assert.equal(which("fakecli", dir), path.join(dir, "fakecli"));
  assert.equal(which("notexec", dir), null);
  assert.equal(which("definitely-not-a-cli-zzz", dir), null);
});

test("checkouts: direct children that are git repos, with their origin; dotdirs and plain dirs skipped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inv-roots-"));
  const mk = (name: string, origin?: string) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    execFileSync("git", ["init", "-q"], { cwd: d });
    if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: d });
    return fs.realpathSync(d);
  };
  const a = mk("alpha", "git@github.com:x/alpha.git");
  const b = mk("beta");
  fs.mkdirSync(path.join(root, "plain"));
  mk(".hidden", "git@github.com:x/hidden.git");
  const got = (await scanCheckouts([root, path.join(root, "missing")])).sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(got, [{ path: a, remote_url: "git@github.com:x/alpha.git" }, { path: b, remote_url: null }]);
});

test("checkouts: one grouping level deep (~/GitHub/<client>/<repo>), never inside a checkout or node_modules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inv-group-"));
  const mk = (rel: string, origin: string) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: d });
    return fs.realpathSync(d);
  };
  const p = mk("Personal/presence", "git@github.com:x/presence.git");
  const m = mk("Medialab/airflow", "git@github.com:x/airflow.git");
  const top = mk("toplevel", "git@github.com:x/top.git");
  mk("toplevel/vendored", "git@github.com:x/vendored.git"); // inside a checkout: not a separate repo here
  mk("Personal/node_modules/pkg", "git@github.com:x/pkg.git");
  mk("Deep/a/b", "git@github.com:x/deep.git"); // two levels of grouping: out of reach on purpose
  const got = (await scanCheckouts([root])).map((c) => c.path).sort();
  assert.deepEqual(got, [m, p, top].sort());
});

test("hello is protocol-current and names this machine's platform", async () => {
  const prev = process.env.CHRONOS_HOST_ROOTS;
  process.env.CHRONOS_HOST_ROOTS = fs.mkdtempSync(path.join(os.tmpdir(), "inv-empty-")); // never scan the real ~/Documents
  const h = await buildHello("h_test", "m2").finally(() => { if (prev === undefined) delete process.env.CHRONOS_HOST_ROOTS; else process.env.CHRONOS_HOST_ROOTS = prev; });
  assert.equal(h.t, "hello");
  assert.deepEqual(checkCompat(h.proto), { ok: true });
  assert.equal(h.proto, PROTOCOL_VERSION);
  assert.equal(h.platform, process.platform);
  assert.ok(h.profiles.some((p) => p.name === "claude"), "the default profile is always reported");
  assert.deepEqual(h.live, []);
  assert.ok(Array.isArray(h.capabilities.clis) && h.capabilities.clis.some((c) => c.name === "git"));
});

test("vitals reuse the machine governor's readings", async () => {
  const v = await sampleHostVitals();
  assert.equal(typeof v.loadPerCore, "number");
  assert.ok(v.at > 0);
});

test("doctor checklist: a joined host with tools is all green; missing pieces say how to fix", () => {
  const base = {
    node: "v22.3.0",
    clis: [
      { name: "git", path: "/usr/bin/git", version: "git 2.4" },
      { name: "gh", path: "/opt/homebrew/bin/gh", version: "gh 2.5" },
      { name: "claude", path: "/opt/homebrew/bin/claude", version: "2.0" },
      { name: "grok", path: null, version: null },
    ],
    profiles: [{ name: "claude", dir: os.tmpdir(), exists: true }],
    checkouts: [],
    roots: [os.tmpdir()],
    secretsMode: 0o100600,
    joined: { id: "h_1", brains: ["wss://10.0.0.2:7779/host"], fp: "ab" },
    plistInstalled: true,
  };
  const ok = checklist(base);
  assert.ok(ok.every((c) => c.ok), formatChecklist(ok));
  const bad = checklist({ ...base, node: "v20.1.0", secretsMode: 0o100644, joined: { id: null, brains: [], fp: null }, plistInstalled: false, clis: base.clis.map((c) => (c.name === "gh" ? { ...c, path: null } : c)) });
  const text = formatChecklist(bad);
  assert.match(text, /✗ node 22–26/);
  assert.match(text, /✗ gh — not found\n    → brew install gh/);
  assert.match(text, /✗ credential file is private — mode 644\n    → chmod 600/);
  assert.match(text, /✗ joined a brain — no\n    → paste the command from Desk → Computers → \+ Add/);
  assert.match(text, /→ brew install node@24 .*"\$HOME\/\.zprofile"/, "the node fix is the preflight's, with $HOME");
  assert.match(text, /✓ grok \(optional\)/, "a missing agent CLI is fine while another one exists");
});

test("cli auth: grok by its auth file; cursor-agent by key or `status` wording, a locked keychain is unknown", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "inv-auth-"));
  assert.equal(await cliAuth("grok", "/x/grok", {}, home), "no");
  fs.mkdirSync(path.join(home, ".grok"));
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), "{}");
  assert.equal(await cliAuth("grok", "/x/grok", {}, home), "yes");
  assert.equal(await cliAuth("cursor-agent", "/nonexistent/cursor-agent", { CURSOR_API_KEY: "k" }, home), "yes");
  assert.equal(await cliAuth("claude", "/x/claude", {}, home), undefined);
  assert.equal(await cliAuth("opencode", "/x/opencode", {}, home), undefined);
  assert.equal(cursorAuthFrom("\x1b[33mNot logged in\x1b[0m"), "no");
  assert.equal(cursorAuthFrom("Error: Your macOS login keychain is locked.\nRun security unlock-keychain"), "unknown");
  assert.equal(cursorAuthFrom("✓ Logged in as someone@example.com"), "yes");
  assert.equal(cursorAuthFrom(""), "unknown");
});

// ───────────── protocol 1.5: inventory stays true ─────────────

import crypto from "node:crypto";
import { claudeKeychainServices, ghAuth, ghAuthFrom, ghDirsToProbe, profileAuth, profiles, profilesWithAuth, SEC_NOT_FOUND } from "./inventory.js";
import type { Runner } from "./update.js";

test("profiles are re-discovered on every call: a profile added after start shows up, a removed one goes", () => {
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "inv-prof-"));
  const prev = process.env.CHRONOS_PROFILES;
  try {
    process.env.CHRONOS_PROFILES = `ztest-late=${extra}`;
    const got = profiles().find((p) => p.name === "ztest-late");
    assert.deepEqual(got, { name: "ztest-late", dir: extra, exists: true });
    delete process.env.CHRONOS_PROFILES;
    assert.equal(profiles().some((p) => p.name === "ztest-late"), false);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_PROFILES; else process.env.CHRONOS_PROFILES = prev;
    profiles();
  }
});

test("claude keychain service: sha256(dir)[:8] suffix; the default dir also checks the unsuffixed item", () => {
  const home = "/Users/op";
  const h = (d: string) => crypto.createHash("sha256").update(d).digest("hex").slice(0, 8);
  assert.deepEqual(claudeKeychainServices("/Users/op/.claude-acme", home), [`Claude Code-credentials-${h("/Users/op/.claude-acme")}`]);
  assert.deepEqual(claudeKeychainServices("/Users/op/.claude", home), [`Claude Code-credentials-${h("/Users/op/.claude")}`, "Claude Code-credentials"]);
});

/** A fake `security`: list-keychains answers per `reachable`; find-generic-password by the service's presence. */
function fakeSecurity(o: { reachable: boolean; present: string[]; other?: number }): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "list-keychains") return { code: 0, stdout: o.reachable ? '    "/Users/op/Library/Keychains/login.keychain-db"\n' : '    "/Library/Keychains/System.keychain"\n', stderr: "" };
    const name = args[args.indexOf("-s") + 1];
    if (o.other != null) return { code: o.other, stdout: "", stderr: "User interaction is not allowed." };
    return o.present.includes(name) ? { code: 0, stdout: 'keychain: "login.keychain-db"\n', stderr: "" } : { code: SEC_NOT_FOUND, stdout: "", stderr: "The specified item could not be found in the keychain." };
  };
  return { run, calls };
}

test("profile auth: keychain item exists → yes, missing → no, unreachable or odd exit → unknown; never reads the secret", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "inv-kc-"));
  const dir = path.join(home, ".claude-acme");
  fs.mkdirSync(dir);
  const [svc] = claudeKeychainServices(dir, home);
  const yes = fakeSecurity({ reachable: true, present: [svc] });
  assert.equal(await profileAuth(dir, { run: yes.run, platform: "darwin", home }), "yes");
  for (const c of yes.calls) assert.ok(!c.includes("-w") && !c.includes("-g"), "existence only: no -w / -g");
  assert.equal(await profileAuth(dir, { run: fakeSecurity({ reachable: true, present: [] }).run, platform: "darwin", home }), "no");
  assert.equal(await profileAuth(dir, { run: fakeSecurity({ reachable: false, present: [] }).run, platform: "darwin", home }), "unknown", "no login keychain in the search list (ssh) is not a no");
  assert.equal(await profileAuth(dir, { run: fakeSecurity({ reachable: true, present: [], other: 36 }).run, platform: "darwin", home }), "unknown", "locked keychain");
  assert.equal(await profileAuth(dir, { run: fakeSecurity({ reachable: true, present: [] }).run, platform: "linux", home }), "unknown");
  assert.equal(await profileAuth(path.join(home, ".claude-missing"), { run: yes.run, platform: "darwin", home }), "no");
  // The default dir: a login made without CLAUDE_CONFIG_DIR sits in the unsuffixed item.
  const def = path.join(home, ".claude");
  fs.mkdirSync(def);
  assert.equal(await profileAuth(def, { run: fakeSecurity({ reachable: true, present: ["Claude Code-credentials"] }).run, platform: "darwin", home }), "yes");
  // A credentials file in the dir (claude without a keychain) counts without asking `security`.
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
  const none = fakeSecurity({ reachable: false, present: [] });
  assert.equal(await profileAuth(dir, { run: none.run, platform: "darwin", home }), "yes");
  assert.equal(none.calls.length, 0);
});

test("profilesWithAuth checks the keychain once for reachability and reports auth per profile", async () => {
  const f = fakeSecurity({ reachable: false, present: [] });
  const list = await profilesWithAuth(f.run, "darwin");
  assert.ok(list.length >= 1);
  assert.ok(list.every((p) => p.auth === (p.exists ? (fs.existsSync(path.join(p.dir, ".credentials.json")) ? "yes" : "unknown") : "no")));
  assert.equal(f.calls.filter((c) => c[1] === "list-keychains").length, 1);
});

test("gh auth status parsing: account, not logged in, invalid token, keyring/network trouble is unknown", () => {
  assert.deepEqual(ghAuthFrom(0, "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Active account: true\n  - Token: gho_****"), { auth: "yes", account: "octo", detail: null });
  assert.deepEqual(ghAuthFrom(0, "github.com\n  ✓ Logged in to github.com as octo (oauth_token)\n"), { auth: "yes", account: "octo", detail: null });
  assert.equal(ghAuthFrom(1, "You are not logged into any GitHub hosts. To log in, run: gh auth login").auth, "no");
  const bad = ghAuthFrom(1, "github.com\n  X Failed to log in to github.com account octo (keyring)\n  - The token in keyring is invalid.\n");
  assert.equal(bad.auth, "no");
  assert.equal(bad.detail, "token invalid");
  assert.equal(ghAuthFrom(1, "X Timeout trying to log in to github.com account octo").auth, "unknown");
  assert.equal(ghAuthFrom(1, "failed to read token from keyring: user interaction is not allowed").auth, "unknown");
  assert.equal(ghAuthFrom(1, "").auth, "unknown");
});

test("gh auth: one `gh auth status` per dir with GH_CONFIG_DIR expanded; the default dir unsets it", async () => {
  const seen: Array<string | undefined> = [];
  const run: Runner = async (_cmd, args, opts) => {
    assert.deepEqual(args, ["auth", "status"]);
    seen.push(opts?.env?.GH_CONFIG_DIR);
    return opts?.env?.GH_CONFIG_DIR?.endsWith("gh-acme") ? { code: 0, stdout: "✓ Logged in to github.com account acme-bot (keyring)", stderr: "" } : { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
  };
  const dirs = ghDirsToProbe([{ dir: "~/.config/gh-acme", workspaces: ["acme"] }, { dir: "~/.config/gh-acme", workspaces: ["acme2"] }]);
  assert.deepEqual(dirs, [{ dir: "default", workspaces: [] }, { dir: "~/.config/gh-acme", workspaces: ["acme", "acme2"] }]);
  const got = await ghAuth(dirs, run, "/x/gh");
  assert.deepEqual(seen, [undefined, path.join(os.homedir(), ".config/gh-acme")]);
  assert.deepEqual(got.map((g) => [g.dir, g.auth, g.account]), [["default", "no", null], ["~/.config/gh-acme", "yes", "acme-bot"]]);
  assert.deepEqual(await ghAuth(dirs, run, null), [], "no gh: nothing to report (the CLI line says it is missing)");
});

test("doctor checklist: a logged-out profile is ✗ with the login line; unknown is ✓ and says why; gh logins are listed", () => {
  const checks = checklist({
    node: "v22.3.0", clis: [], checkouts: [], roots: [], secretsMode: 0o100600, joined: { id: "h_1", brains: ["x"], fp: null }, plistInstalled: true,
    profiles: [
      { name: "claude", dir: "/Users/op/.claude", exists: true, auth: "yes" },
      { name: "claude-acme", dir: "/Users/op/.claude-acme", exists: true, auth: "no" },
      { name: "claude-cedar", dir: "/Users/op/.claude-cedar", exists: true, auth: "unknown" },
    ],
    gh: [{ dir: "default", workspaces: [], auth: "yes", account: "op" }, { dir: "~/.config/gh-acme", workspaces: ["acme"], auth: "no", detail: "not logged in" }],
  });
  const text = formatChecklist(checks);
  assert.match(text, /✓ profile claude — \/Users\/op\/\.claude \(logged in\)/);
  assert.match(text, /✗ profile claude-acme — \/Users\/op\/\.claude-acme \(not logged in\)\n    → log in: CLAUDE_CONFIG_DIR=\/Users\/op\/\.claude-acme claude/);
  assert.match(text, /✓ profile claude-cedar — .*login unknown/);
  assert.match(text, /✓ gh default — logged in as op/);
  assert.match(text, /✗ gh ~\/\.config\/gh-acme \(acme\) — not logged in\n    → GH_CONFIG_DIR=~\/\.config\/gh-acme gh auth login/);
});
