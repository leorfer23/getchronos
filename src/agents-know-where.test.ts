/**
 * Agents know which computer they are on (HOSTS.md → "Agents know where they are"): the MC_HOST_* env
 * the brain gives every agent, the one prompt block a terminal on another computer gets, the repo
 * paths a host terminal is shown, and the loopback links a remote terminal's Focus feed carries.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-know-where-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { hosts, repoCheckouts, repos, workspaces } = await import("./store.js");
const { hostEnv, mcEnv, onHostBlock } = await import("./terminal.js");
const { reposOnHost } = await import("./hosts/workdir.js");
const { snapshotFocus, tagHostEvents, tagLoopbackLinks } = await import("./focus.js");

hosts.create({ id: "h_m2", name: "m2", status: "online", token_hash: "x".repeat(64) });

test("the brain's agents are told they are on the brain, by the name the operator gave it", () => {
  assert.deepEqual(hostEnv(), { MC_HOST_ID: "local", MC_HOST_NAME: "local", MC_HOST_BRAIN: "1" });
  hosts.update("local", { name: "atlas" });
  try {
    const env = mcEnv(null, null, null);
    assert.equal(env.MC_HOST_ID, "local");
    assert.equal(env.MC_HOST_NAME, "atlas");
    assert.equal(env.MC_HOST_BRAIN, "1");
  } finally {
    hosts.update("local", { name: "local" });
  }
});

test("a remote agent's env names its host (the host re-stamps it too — hostd/host-self-env.test.ts)", () => {
  const env = mcEnv(null, null, null, "h_m2");
  assert.deepEqual([env.MC_HOST_ID, env.MC_HOST_NAME, env.MC_HOST_BRAIN], ["h_m2", "m2", "0"]);
  assert.equal(hostEnv("h_gone").MC_HOST_NAME, "h_gone", "an unknown host falls back to its id");
});

test("only a terminal on another computer gets the on-host block, and it is short", () => {
  assert.equal(onHostBlock("local"), "");
  assert.equal(onHostBlock(""), "");
  const b = onHostBlock("h_m2");
  assert.match(b, /You are on m2, not the operator's main Mac/);
  assert.match(b, /localhost/);
  assert.match(b, /mc artifact put/);
  assert.match(b, /mc clip/);
  assert.match(b, /mc whoami/);
  assert.ok(!b.includes("<!--") && !b.includes("{{"), "editor notes stripped, placeholders filled");
  assert.ok(b.split("\n").filter((l) => l.trim()).length <= 4, b);
});

test("reposOnHost: a host terminal sees ITS checkout, or none — never the brain's path", () => {
  const ws = workspaces.create({ slug: "kw", name: "KW", config_dir: path.join(tmp, ".claude-kw"), sandbox_mode: "off" } as any);
  const web = repos.create({ workspace_id: ws.id, name: "web", path: path.join(tmp, "web"), default_branch: "main", git_remote: "git@github.com:acme/web.git" } as any);
  const api = repos.create({ workspace_id: ws.id, name: "api", path: path.join(tmp, "api"), default_branch: "main", git_remote: "git@github.com:acme/api.git" } as any);
  repoCheckouts.upsert({ repo_id: web.id, host_id: "h_m2", path: "/Users/op/code/web" });
  const seen = reposOnHost(repos.list(ws.id), "h_m2");
  const by = Object.fromEntries(seen.map((r) => [r.name, r]));
  assert.equal(by.web.host_path, "/Users/op/code/web");
  assert.equal(by.web.path, web.path, "path stays the brain's");
  assert.equal(by.api.host_path, null, "not checked out on m2");
  assert.equal(reposOnHost([api], "local")[0].host_path, api.path, "on the brain, its own checkout");
});

test("tagLoopbackLinks: a loopback link from m2 becomes text that says where it lives", () => {
  assert.equal(tagLoopbackLinks("dev server up at http://localhost:5173", "m2"), "dev server up at localhost:5173 (on m2)");
  assert.equal(tagLoopbackLinks("see http://127.0.0.1:8080/admin?x=1.", "m2"), "see 127.0.0.1:8080/admin?x=1 (on m2).");
  assert.equal(tagLoopbackLinks("(https://localhost:3000/a) and http://0.0.0.0:4000", "m5"), "(localhost:3000/a (on m5)) and 0.0.0.0:4000 (on m5)");
  assert.equal(tagLoopbackLinks("http://[::1]:9000/", "m2"), "[::1]:9000/ (on m2)");
  const once = tagLoopbackLinks("http://localhost:5173", "m2");
  assert.equal(tagLoopbackLinks(once, "m2"), once, "idempotent");
  assert.equal(tagLoopbackLinks("http://localhost:5173 (on m2)", "m2"), "localhost:5173 (on m2)", "an agent that already said where is not tagged twice");
  for (const keep of ["https://github.com/o/r/pull/1", "http://localhost.example.com/x", "http://mylocalhost:3000"]) {
    assert.equal(tagLoopbackLinks(keep, "m2"), keep);
  }
  assert.equal(tagLoopbackLinks("http://localhost:5173", null), "http://localhost:5173", "the brain's own terminals are untouched");
});

test("a remote terminal's Focus feed is tagged; its thinking is not touched", () => {
  const evs = tagHostEvents([
    { seq: 1, kind: "say", text: "open http://localhost:5173" },
    { seq: 2, kind: "think", text: "maybe http://localhost:5173" },
  ], "m2");
  assert.equal(evs[0].text, "open localhost:5173 (on m2)");
  assert.equal(evs[1].text, "maybe http://localhost:5173");

  // End to end through the mirror a host streams a claude transcript into.
  const mirror = path.join(tmp, "mirror.jsonl");
  const rec = { type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "Preview: http://localhost:5173/login" }] } };
  fs.writeFileSync(mirror, JSON.stringify(rec) + "\n");
  const base = { sessionId: "s1", backend: "claude-code", cwd: tmp, configDir: tmp, sinceMs: 0, transcriptFile: mirror };
  const remote = snapshotFocus({ ...base, hostName: "m2" }).map((e) => e.text).join("\n");
  assert.match(remote, /localhost:5173\/login \(on m2\)/);
  assert.doesNotMatch(remote, /http:\/\/localhost/);
  assert.match(snapshotFocus(base).map((e) => e.text).join("\n"), /http:\/\/localhost:5173\/login/, "no host name, no rewrite");
});
