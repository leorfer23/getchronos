/**
 * `GET /__host/status` (status.ts) — what the menu bar item reads. The endpoint is loopback-only and
 * unauthenticated, so the properties under test are the allowlist: an exact set of keys, no token or
 * env value anywhere in the bytes, no workspace name or title, and a repo shown by folder only.
 * Plus the "working" rule and the port discovery the Swift item mirrors.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ACTIVE_MS, buildStatus, isHostStatus, linkView, mcPortCandidates, redact, repoFolder, secretsPort, workItem, type WorkSource } from "./status.js";
import { startForwarder } from "./forwarder.js";

const NOW = 1_800_000_000_000;
const TOKEN = "hosttok_" + "s3cr3t".repeat(6);

const src = (over: Partial<WorkSource> = {}): WorkSource => ({
  kind: "terminal", id: "4f3a9c21-7d1e-4b6a-9f00-123456789abc", cwd: "/Users/op/Documents/GitHub/app",
  backend: "claude-code", startedAt: NOW - 12 * 60_000, lastOut: NOW - 1000, ...over,
});

const status = (work: WorkSource[] = [src()], state: Parameters<typeof linkView>[0] = "online", lastError: string | null = null) =>
  buildStatus({
    hostId: "h_m2", name: "m2",
    link: { state, since: NOW - 60_000, url: "wss://brain.example.com/host", lastError },
    version: "0.1.0", commit: "b".repeat(40), work, home: "/Users/op",
  }, NOW);

test("shape: exactly these keys, top level and per work item", () => {
  const s = status();
  assert.deepEqual(Object.keys(s).sort(), [
    "active", "at", "commit", "host_id", "last_error", "link", "name", "reason", "since", "state", "url", "version", "work",
  ]);
  assert.deepEqual(Object.keys(s.work[0]).sort(), ["active", "backend", "id", "kind", "last_output_at", "repo", "started_at"]);
  assert.deepEqual(s.work[0], {
    kind: "terminal", id: "4f3a9c21", repo: "app", backend: "claude-code",
    started_at: NOW - 12 * 60_000, last_output_at: NOW - 1000, active: true,
  });
  assert.equal(s.commit, "bbbbbbbbbbbb", "a short commit");
  assert.equal(s.link, "online");
  assert.equal(s.reason, null);
  assert.equal(s.active, 1);
});

test("active = output within ACTIVE_MS; the count is active items only; active rows first, then oldest", () => {
  const s = status([
    src({ id: "idle-old", lastOut: NOW - ACTIVE_MS, startedAt: NOW - 3_600_000 }),
    src({ id: "busy-new", lastOut: NOW - ACTIVE_MS + 1, startedAt: NOW - 60_000, kind: "run" }),
    src({ id: "busy-old", lastOut: NOW, startedAt: NOW - 600_000 }),
  ]);
  assert.deepEqual(s.work.map((w) => [w.id, w.active]), [["busy-old", true], ["busy-new", true], ["idle-old", false]]);
  assert.equal(s.active, 2);
  assert.equal(workItem(src({ lastOut: NOW - 5000 }), NOW, undefined, 3000).active, false, "the window is a parameter");
  assert.equal(status([]).active, 0);
});

test("a worktree reports its repo, never its branch (a ticket key carries the workspace prefix)", () => {
  assert.equal(repoFolder("/Users/op/Documents/GitHub/.chronos-worktrees/app/GAL-12-fix-login"), "app");
  assert.equal(repoFolder("/Users/op/Documents/GitHub/.chronos-worktrees/app/mc/GAL-12"), "app");
  assert.equal(repoFolder("/Users/op/Documents/GitHub/app/"), "app");
  assert.equal(repoFolder("/Users/op", "/Users/op"), null, "the home dir is not a repo");
  assert.equal(repoFolder(""), null);
});

test("no secrets, no env, no workspace names — in the bytes the forwarder actually serves", async () => {
  process.env.CHRONOS_HOST_TOKEN_TEST_DECOY = TOKEN;
  // A workspace-shaped cwd leaf and a URL with credentials in it: neither may come out whole.
  const work = [src({ cwd: "/Users/op/code/.chronos-worktrees/api/ACME-7-secret-client-thing" }), src({ kind: "run", id: "r".repeat(36) })];
  const srv = await startForwarder({ api: async () => ({ status: 500, headers: {}, body: null }) }, {
    port: 0,
    status: () => status(work, "offline", `wss://user:${TOKEN}@brain.example.com/host?token=${TOKEN}: ECONNREFUSED`),
  });
  try {
    const port = (srv.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/__host/status" }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      }).on("error", reject);
    });
    assert.ok(!body.includes(TOKEN), "no token, not even inside an error string");
    assert.ok(!/s3cr3t/.test(body));
    assert.ok(!/ACME|secret-client/i.test(body), "a worktree's branch (ticket key) never appears");
    assert.ok(!/workspace|slug|title|env|token/i.test(body), `no such keys: ${body}`);
    const j = JSON.parse(body);
    assert.equal(j.link, "reconnecting");
    assert.equal(j.reason, "wss://brain.example.com/host ECONNREFUSED");
    assert.deepEqual(j.work.map((w: any) => w.repo), ["api", "app"]);
    assert.ok(isHostStatus(j));
  } finally {
    delete process.env.CHRONOS_HOST_TOKEN_TEST_DECOY;
    srv.close();
  }
});

test("the forwarder listens on loopback only", async () => {
  const srv = await startForwarder({ api: async () => ({ status: 500, headers: {}, body: null }) }, { port: 0, status: () => status() });
  try {
    assert.equal((srv.address() as { address: string }).address, "127.0.0.1");
  } finally {
    srv.close();
  }
});

test("link view: five internal states, three a person reads; a reason whenever it is not online", () => {
  assert.equal(linkView("online"), "online");
  assert.equal(linkView("connecting"), "reconnecting");
  assert.equal(linkView("offline"), "reconnecting", "offline + a scheduled retry is still trying");
  assert.equal(linkView("stopped"), "offline", "the brain refused the credential for good");
  assert.equal(linkView("idle"), "offline");
  assert.equal(status([], "stopped", "closed 4401 revoked").reason, "closed 4401 revoked");
  assert.equal(status([], "idle").reason, "not connected yet");
  assert.equal(status([], "connecting").reason, "connecting");
});

test("redact: userinfo and query strings go, the rest stays", () => {
  assert.equal(redact("wss://a:b@h.example/host?x=1 boom"), "wss://h.example/host boom");
  assert.equal(redact("https://tok@github.com/o/r.git#frag"), "https://github.com/o/r.git");
  assert.equal(redact(null), null);
});

test("port discovery (mirrored in hostbar.swift): an explicit port is the only one, else 7777 then 7787–7796", () => {
  assert.deepEqual(mcPortCandidates("7790"), [7790]);
  assert.deepEqual(mcPortCandidates(""), [7777, 7787, 7788, 7789, 7790, 7791, 7792, 7793, 7794, 7795, 7796]);
  assert.deepEqual(mcPortCandidates(null), mcPortCandidates(""));
  assert.deepEqual(mcPortCandidates("nope"), mcPortCandidates(""), "garbage falls back to the scan");
  assert.equal(secretsPort("CHRONOS_HOST_ID=h1\nCHRONOS_HOST_MC_PORT=7791\n"), "7791");
  assert.equal(secretsPort('export CHRONOS_HOST_MC_PORT="7792"'), "7792");
  assert.equal(secretsPort("# CHRONOS_HOST_MC_PORT=7793\nCHRONOS_HOST_TOKEN=x"), null, "a comment is not a setting");
  assert.equal(isHostStatus({ ok: true }), false, "a Chronos daemon on 7777 answers without a host_id");
  assert.equal(isHostStatus({ host_id: "" }), false);
  assert.equal(isHostStatus({ host_id: "h_m2" }), true);
});
