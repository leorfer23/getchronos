/**
 * Services (src/services.ts + service-routes.ts) with real ptys, real git and the real store.
 *
 * The supervisor: the switch starts and stops a process group; an exit is restarted by policy with a
 * backoff, and a crash loop is left down and raised once; a process that ignores SIGTERM is killed;
 * boot starts what is on, resets what is off and stops a copy the previous daemon left running (same
 * pid AND start time); deploy moves a clean checkout to its ref and refuses a dirty one.
 *
 * The routes: the workspace boundary (CLAUDE.md gotcha #4) — a workspace token reads only its own
 * services and can never define or switch one (that would be a way out of the agent sandbox), and env
 * values never come back out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import express from "express";

const { workspaces, services } = await import("./store.js");
const svc = await import("./services.js");
const routes = await import("./service-routes.js");
const { CONFIG } = await import("./config.js");
import type { Service } from "./store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svc-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const alarms: Array<{ name: string; why: string }> = [];
const sup = new svc.Supervisor({
  ...svc.systemSupervisorDeps(),
  logDir: () => path.join(tmp, "logs"),
  publish: () => {},
  alarm: (s, why) => alarms.push({ name: s.name, why }),
  stopGraceMs: 400,
  backoff: () => 30,
  maxRestarts: 2,
  stableMs: 10_000,
  cooldownMs: 60_000,
});
svc.setServiceSupervisorForTest(sup);
after(() => { sup.shutdownSync(); svc.setServiceSupervisorForTest(null); });

const t0 = Date.now();
const A = workspaces.create({ slug: `sva-${t0}`, name: "A", config_dir: "/tmp/sva" });
const B = workspaces.create({ slug: `svb-${t0}`, name: "B", config_dir: "/tmp/svb" });
let n = 0;
const mk = (command: string, extra: Partial<Parameters<typeof services.create>[0]> = {}): Service =>
  services.create({ workspace_id: A.id, name: `s${++n}`, command, cwd: tmp, ...extra });

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const out = (id: string) => sup.output(id, 0).data;

test("start runs the command in a pty and captures its output; stop ends its process group", async () => {
  const s = mk(`echo hello-$MC_SERVICE; sleep 30 & wait`);
  const on = await sup.start(s.id);
  assert.equal(on.status, "running");
  assert.equal(on.enabled, 1);
  assert.ok(on.pid && alive(on.pid));
  await waitFor(() => out(s.id).includes(`hello-${s.name}`), 5000, "output");
  const off = await sup.stop(s.id);
  assert.equal(off.status, "stopped");
  assert.equal(off.enabled, 0);
  assert.equal(off.pid, null);
  await waitFor(() => !alive(on.pid!), 2000, "process gone");
  assert.equal(sup.isLive(s.id), false);
  await sup.flushLogs();
  const log = fs.readFileSync(sup.logFile(s.id), "utf8");
  assert.match(log, new RegExp(`hello-${s.name}`));
  assert.match(log, /chronos: stopping/);
});

test("a crashing service is restarted with backoff, then left crashed and raised once", async () => {
  const s = mk(`echo boom; exit 3`);
  await sup.start(s.id);
  const done = await waitFor(() => { const r = services.get(s.id)!; return r.status === "crashed" ? r : null; }, 5000, "crashed");
  assert.equal(done.restarts, 2);
  assert.equal(done.last_exit_code, 3);
  assert.match(done.last_error ?? "", /crash loop: 2 restarts/);
  assert.equal(done.enabled, 1, "still switched on — the next boot gives it a fresh chance");
  assert.equal(alarms.filter((a) => a.name === s.name).length, 1);
  assert.equal((out(s.id).match(/boom/g) ?? []).length, 3, "first run + 2 restarts");
});

test("after a crash loop it is tried again on a cool-down, and raised only the first time", async () => {
  const quick = new svc.Supervisor({ ...sup.deps, cooldownMs: 250 });
  const s = mk(`echo again; exit 1`);
  await quick.start(s.id);
  // The first crash loop (3 runs: first + 2 restarts) leaves it crashed with the next try on the row.
  const down = await waitFor(() => { const r = services.get(s.id)!; return r.status === "crashed" ? r : null; }, 3000, "crashed");
  assert.ok(down.next_start_at, "the next try is on the row");
  assert.equal(alarms.filter((a) => a.name === s.name).length, 1);
  // The cool-down retry runs a fresh streak, which crash-loops again — quietly.
  await waitFor(() => (quick.output(s.id, 0).data.match(/crash loop/g) ?? []).length >= 2, 5000, "second crash loop");
  assert.match(quick.output(s.id, 0).data, /trying again after a crash loop/);
  assert.equal(alarms.filter((a) => a.name === s.name).length, 1, "the repeat stays quiet");
  await quick.stop(s.id);
  assert.equal(services.get(s.id)!.next_start_at, null);
  const n = (quick.output(s.id, 0).data.match(/again\r?\n/g) ?? []).length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((quick.output(s.id, 0).data.match(/again\r?\n/g) ?? []).length, n, "switched off: no more tries");
});

test("on-failure leaves a clean exit down without an alarm; never leaves a failure crashed", async () => {
  const ok = mk(`exit 0`, { restart: "on-failure" });
  await sup.start(ok.id);
  const r1 = await waitFor(() => { const r = services.get(ok.id)!; return r.status === "exited" ? r : null; }, 3000, "exited");
  assert.equal(r1.last_exit_code, 0);
  assert.equal(r1.restarts, 0);
  const bad = mk(`exit 7`, { restart: "never" });
  await sup.start(bad.id);
  const r2 = await waitFor(() => { const r = services.get(bad.id)!; return r.status === "crashed" ? r : null; }, 3000, "crashed");
  assert.equal(r2.last_exit_code, 7);
  assert.equal(alarms.filter((a) => a.name === ok.name).length, 0);
  assert.equal(alarms.filter((a) => a.name === bad.name).length, 1);
});

test("restart replaces the process; a definition change applies on the next start", async () => {
  const s = mk(`echo v1; sleep 30 & wait`);
  const a = await sup.start(s.id);
  await waitFor(() => out(s.id).includes("v1"));
  services.update(s.id, { command: `echo v2; sleep 30 & wait` });
  const b = await sup.restart(s.id);
  assert.notEqual(a.pid, b.pid);
  assert.equal(b.status, "running");
  await waitFor(() => out(s.id).includes("v2"), 5000, "v2");
  await waitFor(() => !alive(a.pid!), 2000, "old process gone");
  await sup.stop(s.id);
});

test("a process that ignores SIGTERM is SIGKILLed after the grace", async () => {
  const s = mk(`trap '' TERM; echo armed; while :; do sleep 0.05; done`);
  const on = await sup.start(s.id);
  await waitFor(() => out(s.id).includes("armed"));
  const t = Date.now();
  const off = await sup.stop(s.id);
  assert.equal(off.status, "stopped");
  assert.ok(Date.now() - t >= 350, "waited for the grace");
  assert.match(out(s.id), /SIGKILL/);
  await waitFor(() => !alive(on.pid!), 2000, "killed");
});

test("a missing cwd is crashed with a reason, not a thrown spawn", async () => {
  const s = mk(`true`, { cwd: path.join(tmp, "nope") });
  const r = await sup.start(s.id);
  assert.equal(r.status, "crashed");
  assert.match(r.last_error ?? "", /cwd not found/);
});

test("boot starts what is on, resets what is off, and stops a copy the previous daemon left running", async () => {
  const on = mk(`echo booted; sleep 30 & wait`);
  services.setRuntime(on.id, { enabled: 1, status: "running", pid: 999_999, started_at: new Date().toISOString() });
  const off = mk(`true`);
  services.setRuntime(off.id, { enabled: 0, status: "running", pid: 999_998, started_at: new Date().toISOString() });
  // A leftover: its own process group, like a pty child, recorded on the row with its start time.
  const left = cpSpawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const gone = new Promise<void>((r) => left.on("exit", () => r()));
  const stale = mk(`true`);
  services.setRuntime(stale.id, { enabled: 0, status: "running", pid: left.pid!, started_at: new Date().toISOString() });
  // Earlier tests left crashed rows still switched on, and boot would (rightly) give those a fresh
  // start: switch them off so this test's world is the three rows above.
  for (const r of services.list(A.id)) if (![on.id, off.id, stale.id].includes(r.id)) services.setRuntime(r.id, { enabled: 0 });

  await sup.boot();
  const r1 = services.get(on.id)!;
  assert.equal(r1.status, "running");
  assert.notEqual(r1.pid, 999_999);
  assert.ok(alive(r1.pid!));
  assert.equal(services.get(off.id)!.status, "stopped");
  assert.equal(services.get(off.id)!.pid, null);
  await Promise.race([gone, new Promise((_, rej) => setTimeout(() => rej(new Error("leftover not stopped")), 3000))]);
  assert.equal(services.get(stale.id)!.status, "stopped");
  await sup.stop(on.id);
});

test("boot never signals a pid whose start time does not match the row (a recycled pid)", async () => {
  const other = cpSpawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  after(() => { try { process.kill(other.pid!, "SIGKILL"); } catch { /* gone */ } });
  const s = mk(`true`);
  services.setRuntime(s.id, { enabled: 0, status: "running", pid: other.pid!, started_at: new Date(Date.now() - 3600_000).toISOString() });
  for (const r of services.list(A.id)) if (r.id !== s.id) services.setRuntime(r.id, { enabled: 0 });
  await sup.boot();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(alive(other.pid!), "an unrelated process with that pid is left alone");
});

test("deploy checks the ref out in a clean checkout and restarts; a dirty tree is refused", async () => {
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: "pipe" }).toString().trim();
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");
  const work = path.join(tmp, "work");
  fs.mkdirSync(origin);
  g(origin, "init", "--bare");
  g(tmp, "clone", origin, seed);
  fs.writeFileSync(path.join(seed, "app.sh"), "echo app-v1\nsleep 30 & wait\n");
  g(seed, "add", ".");
  g(seed, "commit", "-m", "v1");
  g(seed, "push", "origin", "HEAD:main");
  g(tmp, "clone", origin, work);
  const s = mk(`bash app.sh`, { cwd: work, ref: "main" });
  await sup.start(s.id);
  await waitFor(() => out(s.id).includes("app-v1"));
  fs.writeFileSync(path.join(seed, "app.sh"), "echo app-v2\nsleep 30 & wait\n");
  g(seed, "commit", "-am", "v2");
  g(seed, "push", "origin", "HEAD:main");
  const want = g(seed, "rev-parse", "HEAD");
  const r = await sup.deploy(s.id);
  assert.equal(r.to, want);
  assert.notEqual(r.from, r.to);
  assert.equal(r.restarted, true);
  await waitFor(() => out(s.id).includes("app-v2"), 5000, "v2 running");
  assert.match(out(s.id), /deployed main/);

  fs.appendFileSync(path.join(work, "app.sh"), "# local edit\n");
  await assert.rejects(sup.deploy(s.id), (e: any) => e instanceof svc.ServiceError && e.status === 409 && /uncommitted/.test(e.message));
  assert.equal(g(work, "rev-parse", "HEAD"), want, "a refused deploy moves nothing");
  await sup.stop(s.id);

  const noRef = mk(`true`, { cwd: work });
  await assert.rejects(sup.deploy(noRef.id), /no ref to deploy/);
});

test("a service whose row is gone (workspace deleted) is stopped by reconcile", async () => {
  const W = workspaces.create({ slug: `svw-${t0}`, name: "W", config_dir: "/tmp/svw" });
  const s = services.create({ workspace_id: W.id, name: "orphan", command: "sleep 30 & wait", cwd: tmp });
  const on = await sup.start(s.id);
  assert.ok(sup.isLive(s.id));
  workspaces.remove(W.id);
  assert.equal(services.get(s.id), undefined, "the FK cascade took the row");
  assert.equal(await sup.reconcile(), 1);
  assert.equal(sup.isLive(s.id), false);
  await waitFor(() => !alive(on.pid!), 2000, "process gone");
});

test("backoff doubles from 1s and stops at a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 7, 20].map(svc.backoffMs), [1000, 2000, 4000, 8000, 60_000, 60_000]);
  assert.ok(svc.REF_RE.test("lf/feat/x-1"));
  assert.ok(!svc.REF_RE.test("--upload-pack=x"));
  assert.ok(!svc.REF_RE.test("main..evil"));
});

// ───────────────────────── routes ─────────────────────────

const app = express();
app.use(express.json());
const api = express.Router();
routes.mountServiceRoutes(api);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => server.close());

async function call(method: string, p: string, opts: { token?: string; admin?: boolean; body?: unknown } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { "x-mc-workspace-token": opts.token } : {}),
      ...(opts.admin ? { "x-mc-admin": CONFIG.adminToken } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: await r.json() as any };
}

test("routes: the operator defines a service; env values never come back", async () => {
  const r = await call("POST", "/services", { admin: true, body: { workspace: A.slug, name: "bot", command: "sleep 30", cwd: tmp, env: { BOT_TOKEN: "s3cret" } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.env_keys, ["BOT_TOKEN"]);
  assert.equal(r.body.env, undefined);
  assert.ok(!JSON.stringify(r.body).includes("s3cret"));
  const dup = await call("POST", "/services", { admin: true, body: { workspace: A.slug, name: "bot", command: "x", cwd: tmp } });
  assert.equal(dup.status, 409);
  const rel = await call("POST", "/services", { admin: true, body: { workspace: A.slug, name: "rel", command: "x", cwd: "relative/dir" } });
  assert.equal(rel.status, 400);
  const mcvar = await call("POST", "/services", { admin: true, body: { workspace: A.slug, name: "mcv", command: "x", cwd: tmp, env: { MC_WORKSPACE: "x" } } });
  assert.equal(mcvar.status, 400);
  const p = await call("PATCH", `/services/bot?workspace=${A.slug}`, { admin: true, body: { env: { BOT_TOKEN: null, OTHER: "1" } } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.env_keys, ["OTHER"]);
});

test("routes: a workspace token reads only its own services and can never switch one", async () => {
  const mine = services.byName(A.id, "bot")!;
  const theirs = services.create({ workspace_id: B.id, name: "theirs", command: "true", cwd: tmp });
  const list = await call("GET", "/services", { token: A.token! });
  assert.equal(list.status, 200);
  assert.ok(list.body.every((s: any) => s.workspace_id === A.id));
  assert.ok(list.body.some((s: any) => s.id === mine.id));
  assert.equal((await call("GET", `/services/${theirs.id}`, { token: A.token! })).status, 404);
  assert.equal((await call("GET", `/services/${theirs.id}/logs`, { token: A.token! })).status, 404);
  assert.equal((await call("GET", `/services?workspace=${B.slug}`, { token: A.token! })).status, 404);
  for (const action of ["start", "stop", "restart", "deploy"]) {
    assert.equal((await call("POST", `/services/${mine.id}/${action}`, { token: A.token! })).status, 403, action);
  }
  assert.equal((await call("PATCH", `/services/${mine.id}`, { token: A.token!, body: { command: "evil" } })).status, 403);
  assert.equal((await call("DELETE", `/services/${mine.id}`, { token: A.token! })).status, 403);
  assert.equal((await call("POST", "/services", { token: A.token!, body: { workspace: A.slug, name: "x", command: "x", cwd: tmp } })).status, 403);
  assert.equal(services.get(mine.id)!.command, "sleep 30");
});

test("routes: start, logs, stop and delete by name", async () => {
  const s = await call("POST", `/services/bot/start?workspace=${A.slug}`, { admin: true });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, "running");
  assert.equal(s.body.live, true);
  const logs = await call("GET", `/services/${s.body.id}/logs?tail=4000`, { token: A.token! });
  assert.equal(logs.status, 200);
  assert.match(logs.body.data, /chronos: started/);
  const more = await call("GET", `/services/${s.body.id}/logs?from=${logs.body.to}`, { admin: true });
  assert.equal(more.body.from, logs.body.to);
  const stop = await call("POST", `/services/${s.body.id}/stop`, { admin: true });
  assert.equal(stop.body.status, "stopped");
  const del = await call("DELETE", `/services/${s.body.id}`, { admin: true });
  assert.equal(del.status, 200);
  assert.equal(services.get(s.body.id), undefined);
});
