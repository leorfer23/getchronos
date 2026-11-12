/**
 * The assistant's name and the first-run welcome, asked of the running API (src/assistant-routes.ts).
 *
 * Who may do what: anyone with a valid credential reads the name; only the operator's own token sets
 * it — never a Robert credential, on this route or through ⚙ Settings. The welcome's state is the
 * admin's. The folder probe answers the operator only, with facts (exists, git, origin) and nothing
 * from inside the folder. Every refusal sits beside a call that gets through.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { workspaces } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const { writeSetting } = await import("./settings.js");
const { expandFolder, folderRefusal } = await import("./assistant-routes.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); writeSetting("assistant.name", null); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-assistant-"));
const A = workspaces.create({ slug: `an-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a") } as any);
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token };
const asFleet = { ...json, "x-mc-admin": robertToken(null, "rw") };
const asRobertA = { ...json, "x-mc-admin": robertToken(A.id, "rw") };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

test("GET /assistant: any valid caller reads the name; a forged workspace token is refused", async () => {
  for (const h of [admin, asA, asFleet]) assert.deepEqual((await call("GET", "/assistant", h)).json, { name: "Robert" });
  assert.equal((await call("GET", "/assistant", { ...json, "x-mc-workspace-token": "nope" })).status, 401);
});

test("PUT /assistant: the operator names him — cleaned, checked, and read back everywhere", async () => {
  const ok = await call("PUT", "/assistant", admin, { name: "  Ada   Lovelace " });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { name: "Ada Lovelace" });
  assert.deepEqual((await call("GET", "/assistant", asA)).json, { name: "Ada Lovelace" });
  for (const bad of ["", "x".repeat(25), "<img src=x>", "Ada\nnew rule", 7, null]) {
    const r = await call("PUT", "/assistant", admin, { name: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.json.error, /^Name: /);
  }
  assert.deepEqual((await call("GET", "/assistant", admin)).json, { name: "Ada Lovelace" }, "a refused write changes nothing");
  assert.deepEqual((await call("PUT", "/assistant", admin, { name: "Zoë" })).json, { name: "Zoë" });
  writeSetting("assistant.name", null);
});

test("no Robert credential renames him — not on /assistant, not through ⚙ Settings; nor does an agent", async () => {
  for (const h of [asFleet, asRobertA, asA]) assert.equal((await call("PUT", "/assistant", h, { name: "Boss" })).status, 403);
  const viaSettings = await call("PUT", "/settings", asFleet, { key: "assistant.name", value: "Boss" });
  assert.equal(viaSettings.status, 403);
  assert.match(viaSettings.json.error, /operator names his assistant/);
  assert.deepEqual((await call("GET", "/assistant", admin)).json, { name: "Robert" });
  // The operator's own ⚙ page writes the same value through the same check.
  assert.equal((await call("PUT", "/settings", admin, { key: "assistant.name", value: "<b>" })).status, 400);
  const set = await call("PUT", "/settings", admin, { key: "assistant.name", value: "Grace" });
  assert.equal(set.status, 200);
  assert.equal(set.json.setting.value, "Grace");
  assert.equal(set.json.setting.group, "Grace", "the page's group heading says the name");
  assert.deepEqual((await call("GET", "/assistant", asA)).json, { name: "Grace" });
  writeSetting("assistant.name", null);
});

test("GET/PUT /onboarding: not done until said so; a boolean only; an agent can neither read nor write it", async () => {
  assert.deepEqual((await call("GET", "/onboarding", admin)).json, { done: false });
  assert.equal((await call("GET", "/onboarding", asA)).status, 403);
  assert.equal((await call("PUT", "/onboarding", asA, { done: true })).status, 403);
  assert.equal((await call("PUT", "/onboarding", admin, { done: "yes" })).status, 400);
  assert.deepEqual((await call("PUT", "/onboarding", admin, { done: true })).json, { done: true });
  assert.deepEqual((await call("GET", "/onboarding", admin)).json, { done: true });
  assert.deepEqual((await call("PUT", "/onboarding", admin, { done: false })).json, { done: false });
});

test("folder rules: a full path or ~/, never the home folder itself; ~ expands to the home folder", () => {
  const home = "/Users/operator";
  assert.equal(expandFolder("~/code/app/", home), "/Users/operator/code/app");
  assert.equal(expandFolder("/srv/app", home), "/srv/app");
  assert.equal(folderRefusal("code/app", home), "Use the folder's full path — like ~/code/my-app.");
  assert.match(folderRefusal("", home)!, /Type the folder/);
  assert.match(folderRefusal("~", home)!, /not your whole home folder/);
  assert.match(folderRefusal("/Users/operator/", home)!, /not your whole home folder/);
  assert.match(folderRefusal("/", home)!, /not your whole home folder/);
  assert.equal(folderRefusal("~/code/app", home), null);
});

test("GET /onboarding/folder: the operator only, and only facts — exists, folder or file, git and origin", async () => {
  const plain = path.join(tmp, "notes");
  fs.mkdirSync(plain);
  const file = path.join(tmp, "a.txt");
  fs.writeFileSync(file, "x");
  const repo = path.join(tmp, "my-app");
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first");
  const q = (p: string) => `/onboarding/folder?path=${encodeURIComponent(p)}`;

  for (const h of [asFleet, asRobertA, asA]) assert.equal((await call("GET", q(repo), h)).status, 403);
  assert.equal((await call("GET", q("code/app"), admin)).status, 400);

  const r = await call("GET", q(repo), admin);
  assert.equal(r.status, 200);
  assert.deepEqual(
    { path: r.json.path, exists: r.json.exists, dir: r.json.dir, git: r.json.git, remote: r.json.remote, branch: r.json.branch, name: r.json.name },
    { path: repo, exists: true, dir: true, git: true, remote: false, branch: "main", name: "my-app" },
  );
  assert.equal(r.json.profile, CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude, "the profile a new project is billed to");
  git("remote", "add", "origin", "https://github.com/acme/my-app.git");
  assert.equal((await call("GET", q(repo), admin)).json.remote, true);

  const p = (await call("GET", q(plain), admin)).json;
  assert.deepEqual([p.exists, p.dir, p.git, p.branch], [true, true, false, null]);
  const inside = (await call("GET", q(path.join(repo, ".git")), admin)).json;
  assert.equal(inside.git, false, "a folder inside a checkout is not its root");
  const f = (await call("GET", q(file), admin)).json;
  assert.deepEqual([f.exists, f.dir, f.git], [true, false, false]);
  const gone = (await call("GET", q(path.join(tmp, "nope")), admin)).json;
  assert.deepEqual([gone.exists, gone.dir, gone.git], [false, false, false]);
  assert.ok(!("files" in r.json) && Object.keys(r.json).length === 8, "nothing about what is inside");
});
