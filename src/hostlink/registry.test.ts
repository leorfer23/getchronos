import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { db, hosts, repoCheckouts, repos, workspaces, sessions, LOCAL_HOST_ID } from "../store.js";
import { HostRegistry, normalizeGitRemote, parsePolicy } from "./registry.js";
import { BrainLink, hostJoinCommand, hostRepoUrl, hostRoutes, DEFAULT_HOST_REPO_URL } from "./brain-link.js";
import { JoinCodes, hashToken, mintHostCredential } from "./join.js";
import { PROTOCOL_VERSION, type Hello } from "./wire.js";
import { profileNameOf, remoteAdmission } from "./view.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM repos; DELETE FROM workspaces;");
  db.exec("DELETE FROM hosts WHERE id != 'local'; UPDATE hosts SET policy_json = NULL, name = 'local' WHERE id = 'local';");
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hostlink-reg-"));
// mintJoin makes the brain cert on first use: keep it out of the checkout.
process.env.CHRONOS_HOSTLINK_DIR = tmp();
const hello = (id: string, over: Partial<Hello> = {}): Hello => ({
  t: "hello", proto: PROTOCOL_VERSION, version: "0.2.0", host_id: id, name: "Alices-MacBook", platform: "darwin", arch: "arm64",
  capabilities: { clis: [{ name: "claude", path: "/opt/homebrew/bin/claude", version: "2.0.0" }, { name: "gh", path: null, version: null }], node: "v22.1.0", sandbox: true },
  profiles: [{ name: "claude-acme", dir: "/Users/a/.claude-acme", exists: true }],
  checkouts: [], deny: ["globex"], live: [], ...over,
});

function joinOne(reg: HostRegistry, name = "m2") {
  const c = mintHostCredential();
  reg.add({ host_id: c.host_id, name, token_hash: hashToken(c.token), cert_fp: "ab".repeat(32) });
  return c;
}

// ───────────────────────────── git remotes ─────────────────────────────

test("git remotes: ssh, scp, https, trailing .git and slashes all name one repo", () => {
  const same = [
    "git@github.com:Acme/Widgets.git",
    "git@github.com:acme/widgets",
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://github.com/acme/widgets/",
    "https://user:tok@github.com/acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets",
    "git+https://github.com/acme/widgets.git",
    "  https://GitHub.com/acme/widgets.git  ",
  ];
  for (const u of same) assert.equal(normalizeGitRemote(u), "github.com/acme/widgets", u);
  assert.equal(normalizeGitRemote("git@git.corp.example:Team/Repo.git"), "git.corp.example/Team/Repo", "self-hosted keeps path case");
  assert.equal(normalizeGitRemote("https://gitlab.com/group/sub/repo.git"), "gitlab.com/group/sub/repo", "subgroups keep every segment");
  assert.notEqual(normalizeGitRemote("git@github.com:acme/widgets"), normalizeGitRemote("git@github.com:acme/widgets-2"));
  for (const bad of [null, undefined, "", "/Users/a/src/widgets", "not a url", "https://github.com/"]) assert.equal(normalizeGitRemote(bad as any), null, String(bad));
});

// ───────────────────────────── registry ─────────────────────────────

test("join stores only a hash; verify is by id + token; a disabled or revoked host is refused", () => {
  const reg = new HostRegistry();
  const c = joinOne(reg);
  const row = hosts.get(c.host_id)!;
  assert.equal(row.status, "offline");
  assert.equal(row.platform, "unknown");
  assert.ok(!JSON.stringify(row).includes(c.token));
  assert.equal(reg.verify(c.host_id, c.token)?.id, c.host_id);
  assert.equal(reg.verify(c.host_id, "wrong"), null);
  assert.equal(reg.verify("h_nobody", c.token), null);
  assert.equal(reg.verify(LOCAL_HOST_ID, c.token), null, "nobody logs in as the brain");
  hosts.update(c.host_id, { status: "disabled" });
  assert.equal(reg.verify(c.host_id, c.token), null, "paused from the Desk");
  hosts.update(c.host_id, { status: "offline" });
  assert.equal(reg.revoke(c.host_id), true);
  assert.equal(reg.verify(c.host_id, c.token), null);
  assert.deepEqual([hosts.get(c.host_id)!.status, hosts.get(c.host_id)!.token_hash], ["disabled", null]);
  assert.equal(reg.revoke(c.host_id), false, "already revoked");
  assert.equal(reg.revoke(LOCAL_HOST_ID), false);
});

test("hello records capabilities and goes online; link down goes offline; draining survives both", () => {
  const reg = new HostRegistry();
  const c = joinOne(reg);
  reg.hello(c.host_id, hello(c.host_id));
  let row = hosts.get(c.host_id)!;
  assert.equal(row.status, "online");
  assert.equal(row.name, "m2", "hello never renames: the operator's name stands");
  assert.equal(row.platform, "darwin");
  assert.ok(row.last_seen_at);
  const caps = JSON.parse(row.capabilities_json!);
  assert.equal(caps.hostname, "Alices-MacBook");
  assert.deepEqual(caps.veto, ["globex"]);
  assert.equal(caps.version, "0.2.0");
  assert.equal(caps.clis.length, 2);
  assert.equal(caps.profiles[0].name, "claude-acme");

  reg.offline(c.host_id);
  assert.equal(hosts.get(c.host_id)!.status, "offline");

  hosts.update(c.host_id, { status: "draining" });
  reg.hello(c.host_id, hello(c.host_id));
  assert.equal(hosts.get(c.host_id)!.status, "draining", "the operator's drain outlives a reconnect");
  reg.offline(c.host_id);
  row = hosts.get(c.host_id)!;
  assert.equal(row.status, "draining", "…and a disconnect");
});

test("boot: no remote host is online before its link says hello", () => {
  const reg = new HostRegistry();
  const a = joinOne(reg, "a"), b = joinOne(reg, "b");
  reg.hello(a.host_id, hello(a.host_id));
  hosts.update(b.host_id, { status: "draining" });
  reg.bootReconcile();
  assert.equal(hosts.get(a.host_id)!.status, "offline");
  assert.equal(hosts.get(b.host_id)!.status, "draining");
  assert.equal(hosts.get(LOCAL_HOST_ID)!.status, "online");
});

test("hello's checkouts become repo_checkouts, matched by normalized remote across workspaces", () => {
  const reg = new HostRegistry();
  const c = joinOne(reg);
  const w1 = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/.claude-acme" });
  const w2 = workspaces.create({ slug: "side", name: "Side", config_dir: "/tmp/.claude" });
  const r1 = repos.create({ workspace_id: w1.id, name: "widgets", path: "/brain/widgets", git_remote: "git@github.com:acme/widgets.git" });
  const r2 = repos.create({ workspace_id: w2.id, name: "widgets", path: "/brain/widgets", git_remote: "https://github.com/acme/widgets" });
  const r3 = repos.create({ workspace_id: w1.id, name: "api", path: "/brain/api", git_remote: "https://github.com/acme/api.git" });
  reg.hello(c.host_id, hello(c.host_id, {
    checkouts: [
      { path: "/Users/a/src/widgets", remote_url: "https://github.com/Acme/widgets.git" },
      { path: "/Users/a/src/widgets-copy", remote_url: "git@github.com:acme/widgets" },
      { path: "/Users/a/src/other", remote_url: "https://github.com/else/other" },
      { path: "/Users/a/src/noremote", remote_url: null },
    ],
  }));
  const mine = repoCheckouts.forHost(c.host_id).map((x) => [x.repo_id, x.path]).sort();
  assert.deepEqual(mine, [[r1.id, "/Users/a/src/widgets"], [r2.id, "/Users/a/src/widgets"]].sort());
  assert.ok(repoCheckouts.get(r1.id, c.host_id)!.scanned_at);
  assert.equal(repoCheckouts.get(r1.id, LOCAL_HOST_ID)!.path, "/brain/widgets", "the brain's own checkout is untouched");
  assert.equal(repoCheckouts.get(r3.id, c.host_id), undefined);

  // The next hello is the whole list: a checkout the host stopped reporting is gone.
  reg.hello(c.host_id, hello(c.host_id, { checkouts: [{ path: "/Users/a/src/api", remote_url: "git@github.com:acme/api.git" }] }));
  assert.deepEqual(repoCheckouts.forHost(c.host_id).map((x) => x.repo_id), [r3.id]);
  assert.throws(() => repoCheckouts.replaceForHost(LOCAL_HOST_ID, []), /mirror repos\.path/);
});

test("Phase 2's hosts.json moves into the table once, revoked stays revoked, and the file stays", () => {
  const dir = tmp();
  const file = path.join(dir, "hosts.json");
  const a = mintHostCredential(), b = mintHostCredential();
  fs.writeFileSync(file, JSON.stringify([
    { host_id: a.host_id, name: "m2", token_hash: hashToken(a.token), created_at: Date.parse("2026-09-20T10:00:00Z") },
    { host_id: b.host_id, name: "old", token_hash: hashToken(b.token), created_at: 1, revoked_at: 2 },
    { host_id: "local", name: "evil", token_hash: hashToken("x"), created_at: 1 },
    { nonsense: true },
  ]));
  const reg = new HostRegistry();
  assert.equal(reg.importLegacy(file), 2);
  assert.equal(reg.verify(a.host_id, a.token)?.name, "m2", "an imported host keeps working with its old token");
  assert.equal(hosts.get(a.host_id)!.created_at, "2026-09-20T10:00:00.000Z");
  assert.deepEqual([hosts.get(b.host_id)!.status, hosts.get(b.host_id)!.token_hash], ["disabled", null]);
  assert.equal(hosts.get(LOCAL_HOST_ID)!.token_hash, null, "a file can never give the brain a token");
  assert.equal(reg.importLegacy(file), 0, "second boot imports nothing");
  assert.ok(fs.existsSync(file));
  assert.equal(reg.importLegacy(path.join(dir, "missing.json")), 0);
  fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.equal(reg.importLegacy(path.join(dir, "bad.json")), 0);
});

test("small readers: policy JSON, profile names, remote admission", () => {
  assert.deepEqual(parsePolicy(null), { deny: [] });
  assert.deepEqual(parsePolicy("{bad"), { deny: [] });
  assert.deepEqual(parsePolicy('{"deny":["a",3,"b"]}'), { deny: ["a", "b"] });
  assert.equal(profileNameOf("/Users/a/.claude-acme"), "claude-acme");
  assert.equal(profileNameOf(null), null);
  const v = { at: 1, cpu: 10, ram: 50, gpu: null, loadPerCore: 0.2, pressure: 1 as const, swapPct: 5 };
  assert.deepEqual(remoteAdmission(v, { enabled: true, maxLoadPerCore: 1.5, maxSwapUsedPct: 70 } as any), { ok: true });
  assert.equal(remoteAdmission({ ...v, pressure: 4 }, { enabled: true, maxLoadPerCore: 1.5, maxSwapUsedPct: 70 } as any).ok, false);
  assert.equal(remoteAdmission(null, { enabled: true, maxLoadPerCore: 1.5, maxSwapUsedPct: 70 } as any).ok, false);
});

// ───────────────────────────── the join command ─────────────────────────────

test("the join command clones (or updates) the repo, installs, and joins — no build step", () => {
  const cmd = hostJoinCommand("wss://192.168.1.20:7779/host", "CHR1-abc_DEF-1", "https://github.com/leorfer23/getchronos");
  assert.equal(
    cmd,
    "{ [ -d ~/.chronos-host/app/.git ] && git -C ~/.chronos-host/app pull --ff-only || git clone https://github.com/leorfer23/getchronos ~/.chronos-host/app; } && cd ~/.chronos-host/app && npm ci && npm run host -- join wss://192.168.1.20:7779/host CHR1-abc_DEF-1",
  );
  assert.match(hostJoinCommand("wss://x/host", "a'b;rm -rf ~", "r"), /join wss:\/\/x\/host 'a'\\''b;rm -rf ~'$/, "anything odd is single-quoted");
  // `npm run host` really is the tsx entry the command relies on.
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.scripts.host, "tsx src/hostd/index.ts");
  assert.ok(pkg.devDependencies.tsx, "npm ci installs tsx (a devDependency) by default");
  assert.equal(hostRepoUrl({ CHRONOS_HOST_REPO_URL: "https://git.example/me/fork" } as any), "https://git.example/me/fork");
  assert.equal(hostRepoUrl({} as any), DEFAULT_HOST_REPO_URL, "package.json's repository, normalized");
});

test("a join code's commands: LAN only with the listener up, tunnel only with a public URL", () => {
  const none = new BrainLink({ creds: new HostRegistry(), codes: new JoinCodes(), publicUrls: () => [] });
  const m0 = none.mintJoin();
  assert.deepEqual(m0.commands, { lan: null, tunnel: null });
  const tun = new BrainLink({ creds: new HostRegistry(), codes: new JoinCodes(), publicUrls: () => ["wss://desk.example.com/host"] });
  const m1 = tun.mintJoin({ name: "m5" });
  assert.equal(m1.commands.lan, null);
  assert.match(m1.commands.tunnel!, /npm run host -- join wss:\/\/desk\.example\.com\/host CHR1-/);
  assert.equal(m1.command, m1.commands.tunnel);
});

// ───────────────────────────── the admin API ─────────────────────────────

async function serve(link: BrainLink) {
  const app = express();
  app.use(express.json());
  app.use("/api", hostRoutes((req, res, next) => (req.get("x-mc-admin") === "adm" ? next() : res.status(403).end()), () => link));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const call = async (method: string, p: string, body?: unknown, admin = "adm") => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { "x-mc-admin": admin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: r.status === 403 ? null : await r.json() };
  };
  return { call, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test("GET /api/hosts: every computer, the brain first, no token hash anywhere, checklist per workspace", async () => {
  const reg = new HostRegistry();
  const link = new BrainLink({ creds: reg, codes: new JoinCodes(), publicUrls: () => [] });
  const c = joinOne(reg);
  const gone = joinOne(reg, "gone");
  reg.revoke(gone.host_id);
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/Users/a/.claude-acme" });
  const g = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/Users/a/.claude-globex" });
  const r = repos.create({ workspace_id: w.id, name: "widgets", path: "/brain/widgets", git_remote: "git@github.com:acme/widgets.git" });
  reg.hello(c.host_id, hello(c.host_id, { checkouts: [{ path: "/Users/a/src/widgets", remote_url: "https://github.com/acme/widgets" }] }));
  hosts.update(c.host_id, { policy_json: JSON.stringify({ deny: [] }) });
  const s = sessions.create({ workspace_id: w.id, cwd: "/tmp" } as any);
  db.prepare("UPDATE sessions SET host_id = ?, status = 'live' WHERE id = ?").run(c.host_id, s.id);

  const api = await serve(link);
  try {
    assert.equal((await api.call("GET", "/hosts", undefined, "nope")).status, 403);
    const { status, body } = await api.call("GET", "/hosts");
    assert.equal(status, 200);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("token_hash") && !raw.includes(hosts.get(c.host_id)!.token_hash!), "no token hash, by key or by value");
    assert.ok(!raw.includes("cert_fp"));
    assert.deepEqual(body.hosts.map((h: any) => h.id), [LOCAL_HOST_ID, c.host_id], "revoked hosts are not computers any more");
    const [local, m2] = body.hosts;
    assert.equal(local.is_brain, true);
    assert.equal(local.connected, true);
    assert.ok(Array.isArray(local.vitals.history));
    assert.equal(m2.connected, false, "no live link in this test");
    assert.equal(m2.status, "online", "the column; `connected` is the link");
    assert.equal(m2.version, "0.2.0");
    assert.equal(m2.live_sessions, 1);
    assert.deepEqual(m2.admission, { ok: false, reason: "offline" });
    assert.deepEqual(m2.checklist.clis, [{ name: "claude", ok: true, version: "2.0.0" }, { name: "gh", ok: false, version: null }]);
    assert.deepEqual(m2.checklist.veto, ["globex"]);
    const acme = m2.checklist.workspaces.find((x: any) => x.id === w.id);
    assert.deepEqual(acme, { id: w.id, slug: "acme", name: "Acme", allowed: true, denied_by: null, profile: { name: "claude-acme", ok: true }, repos: [{ id: r.id, name: "widgets", path: "/Users/a/src/widgets" }] });
    const globex = m2.checklist.workspaces.find((x: any) => x.id === g.id);
    assert.equal(globex.allowed, false);
    assert.equal(globex.denied_by, "veto");
    assert.deepEqual(globex.profile, { name: "claude-globex", ok: false });
  } finally {
    await api.close();
  }
});

test("PATCH /api/hosts/:id: validated; policy, name, drain, enable, disable; the brain can't be drained", async () => {
  const reg = new HostRegistry();
  const link = new BrainLink({ creds: reg, codes: new JoinCodes(), publicUrls: () => [] });
  const c = joinOne(reg);
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/a" });
  const api = await serve(link);
  const id = c.host_id;
  try {
    for (const bad of [{}, { status: "offline" }, { status: "banana" }, { name: "" }, { name: "x;rm" }, { policy: { deny: "acme" } }, { policy: { deny: [], extra: 1 } }, { token_hash: "x" }, { reserve: { cpu: -1 } }]) {
      const r = await api.call("PATCH", `/hosts/${id}`, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.body.error, /invalid request body/);
    }
    assert.equal((await api.call("PATCH", `/hosts/${id}`, { policy: { deny: ["nope"] } })).status, 400, "unknown workspace");
    assert.equal((await api.call("PATCH", "/hosts/h_nobody", { name: "x" })).status, 404);
    assert.equal((await api.call("PATCH", `/hosts/${id}`, { name: "x" }, "wrong")).status, 403);

    let r = await api.call("PATCH", `/hosts/${id}`, { name: "Studio M2", policy: { deny: [w.id, "acme", w.id] }, reserve: { ram_gb: 4 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, "Studio M2");
    assert.deepEqual(r.body.policy, { deny: [w.id, "acme"] });
    assert.deepEqual(JSON.parse(hosts.get(id)!.policy_json!), { deny: [w.id, "acme"] }, "the contract shape: {deny:[…]}");
    assert.deepEqual(r.body.reserve, { ram_gb: 4 });
    assert.equal(r.body.checklist.workspaces[0].denied_by, "policy");

    r = await api.call("PATCH", `/hosts/${id}`, { status: "draining" });
    assert.equal(r.body.status, "draining");
    r = await api.call("PATCH", `/hosts/${id}`, { status: "online" });
    assert.equal(r.body.status, "offline", "enabled, but the column waits for the link");
    r = await api.call("PATCH", `/hosts/${id}`, { status: "disabled" });
    assert.equal(r.body.status, "disabled");
    assert.equal(reg.verify(id, c.token), null, "disabled refuses the token");
    await api.call("PATCH", `/hosts/${id}`, { status: "online" });
    assert.equal(reg.verify(id, c.token)?.id, id, "…and enabling takes it back, unlike a revoke");

    assert.equal((await api.call("PATCH", `/hosts/${LOCAL_HOST_ID}`, { status: "draining" })).status, 400);
    r = await api.call("PATCH", `/hosts/${LOCAL_HOST_ID}`, { name: "M3 Pro" });
    assert.equal(r.body.name, "M3 Pro");
    assert.equal(r.body.is_brain, true);

    assert.equal((await api.call("DELETE", `/hosts/${LOCAL_HOST_ID}`)).status, 400);
    assert.deepEqual((await api.call("DELETE", `/hosts/${id}`)).body, { revoked: true });
    assert.equal((await api.call("PATCH", `/hosts/${id}`, { status: "online" })).status, 404, "a revoked host is gone for good");
  } finally {
    await api.close();
  }
});
