/**
 * `mc` commands that used to break from a terminal on another computer (HOSTS.md → "`mc` on a host"):
 *
 *  - `mc pdf` sends the file's bytes when the path is not the brain's to read;
 *  - `mc job new` pins the job to the host it came from, or refuses — never the brain's $HOME;
 *
 * scripts/mc runs for real against a stub API; hostJobPin against the in-memory store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hosts, jobs, repoCheckouts, repos, workspaces } from "./store.js";
import { hostJobPin } from "./hosts/job-cwd.js";

const MC = path.join(import.meta.dirname, "..", "scripts", "mc");

type Hit = { method: string; url: string; body: any };
/** A stub API: `answer` decides each reply; every request is recorded. */
async function stub(answer: (h: Hit) => [number, unknown]) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      const h = { method: req.method ?? "", url: req.url ?? "", body: d ? JSON.parse(d) : null };
      hits.push(h);
      const [status, body] = answer(h);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const run = (args: string[], env: Record<string, string> = {}, cwd?: string) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(process.execPath, [MC, ...args], {
        cwd,
        env: { ...process.env, MC_API: `http://127.0.0.1:${port}/api`, MC_WORKSPACE: "ws-1", MC_WORKSPACE_TOKEN: "tok-1", MC_HOST_ID: "", ...env },
      }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code) || 1 : 0, stdout, stderr })));
  return { hits, run, close: () => server.close() };
}

const pdf = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mc-pdf-")), "doc.pdf");
  fs.writeFileSync(f, "%PDF-1.4 stand-in bytes");
  return f;
};

test("mc pdf: a path the brain cannot find is sent as bytes", async () => {
  const f = pdf();
  const api = await stub((h) => (h.body?.path ? [404, { error: "not found" }] : [200, { text: "hello from bytes", chars: 16, empty: false }]));
  const r = await api.run(["pdf", f]);
  api.close();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "hello from bytes");
  assert.equal(api.hits.length, 2);
  assert.equal(api.hits[0].body.path, f, "the brain's own disk is tried first");
  assert.equal(Buffer.from(api.hits[1].body.b64, "base64").toString(), "%PDF-1.4 stand-in bytes");
  assert.equal(api.hits[1].body.path, undefined, "no host path travels with the bytes");
});

test("mc pdf: on a host it sends the bytes straight away; other errors are not retried", async () => {
  const f = pdf();
  const api = await stub(() => [200, { text: "t", chars: 1, empty: false }]);
  const r = await api.run(["pdf", f], { MC_HOST_ID: "h_m2" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(api.hits.length, 1);
  assert.ok(api.hits[0].body.b64);
  api.close();

  const bad = await stub(() => [400, { error: "not a pdf" }]);
  const r2 = await bad.run(["pdf", f]);
  bad.close();
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /not a pdf/);
  assert.equal(bad.hits.length, 1);
});

test("mc job new: a refusal from another computer is shown, not swapped for the brain's $HOME", async () => {
  const api = await stub(() => [400, { error: "this terminal runs on m2, so its job runs there too, but /x is not one of this workspace's checkouts on m2" }]);
  const r = await api.run(["job", "new", "--name", "n", "--goal", "g"]);
  api.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /runs on m2/);
  assert.equal(api.hits.filter((h) => h.url === "/api/jobs").length, 1, "no second POST without the cwd");

  // Even a "cwd rejected" is not retried without it when this terminal says it is on a host.
  const api2 = await stub(() => [400, { error: "cwd rejected: /x is outside" }]);
  const r2 = await api2.run(["job", "new", "--name", "n", "--goal", "g"], { MC_HOST_ID: "h_m2" });
  api2.close();
  assert.equal(r2.code, 1);
  assert.equal(api2.hits.length, 1);

  // On the brain the old default stays (it says so).
  let n = 0;
  const api3 = await stub(() => (n++ === 0 ? [400, { error: "cwd rejected: /x is outside" }] : [201, { id: "abcdef1234", name: "n", cwd: "/home", sandbox: "guard" }]));
  const r3 = await api3.run(["job", "new", "--name", "n", "--goal", "g"]);
  api3.close();
  assert.equal(r3.code, 0, r3.stderr);
  assert.equal(api3.hits.length, 2);
  assert.equal(api3.hits[1].body.cwd, undefined);
});

test("hostJobPin: a host's own checkout, a folder in it or its worktree pins; anything else is refused", () => {
  const ws = workspaces.create({ slug: "jp-" + randomUUID().slice(0, 6), name: "JP", config_dir: "/tmp/jp" } as any);
  const other = workspaces.create({ slug: "jo-" + randomUUID().slice(0, 6), name: "JO", config_dir: "/tmp/jo" } as any);
  hosts.create({ id: "h_cedar", name: "cedar", token_hash: "y".repeat(64), status: "online" });
  const r = repos.create({ workspace_id: ws.id, name: "app", path: "/brain/app", git_remote: "https://github.com/acme/app" } as any);
  const o = repos.create({ workspace_id: other.id, name: "secret", path: "/brain/secret", git_remote: "https://github.com/acme/secret" } as any);
  repoCheckouts.upsert({ repo_id: r.id, host_id: "h_cedar", path: "/Users/op/src/app" });
  repoCheckouts.upsert({ repo_id: o.id, host_id: "h_cedar", path: "/Users/op/src/secret" });

  for (const cwd of ["/Users/op/src/app", "/Users/op/src/app/pkg/", "/Users/op/src/.chronos-worktrees/app/op-fix-x"]) {
    const pin = hostJobPin("h_cedar", ws.id, cwd);
    assert.ok(pin.ok, `${cwd}: ${JSON.stringify(pin)}`);
    assert.equal(pin.ok && pin.host_id, "h_cedar");
  }
  for (const cwd of ["/Users/op", "/Users/op/src/app/../secret", "/Users/op/src/secret", "/Users/op/src/apple", "relative"]) {
    const pin = hostJobPin("h_cedar", ws.id, cwd);
    assert.equal(pin.ok, false, cwd);
    assert.match((pin as any).error, /runs on cedar/);
  }
  assert.equal(hostJobPin("h_cedar", null, "/Users/op/src/app").ok, false, "no workspace, no pin");

  const pin = hostJobPin("h_cedar", ws.id, "/Users/op/src/app/");
  assert.ok(pin.ok);
  const job = jobs.create({ name: "pinned", goal: "g", workspace_id: ws.id, cwd: pin.ok ? pin.cwd : "", host_id: "h_cedar" } as any);
  assert.equal(job.host_id, "h_cedar");
  assert.equal(job.cwd, "/Users/op/src/app", "kept as the host's path — never re-judged against this disk");
});
