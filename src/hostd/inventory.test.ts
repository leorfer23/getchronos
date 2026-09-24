import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildHello, checklist, formatChecklist, hostDeny, hostRoots, sampleHostVitals, scanCheckouts, which } from "./inventory.js";
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
  assert.match(text, /✗ node ≥ 22/);
  assert.match(text, /✗ gh — not found\n    → brew install gh/);
  assert.match(text, /✗ credential file is private — mode 644\n    → chmod 600/);
  assert.match(text, /✗ joined a brain — no\n    → npm run host -- join/);
  assert.match(text, /✓ grok \(optional\)/, "a missing agent CLI is fine while another one exists");
});
