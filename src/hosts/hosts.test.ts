import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import readline from "node:readline";
import { hostById, hostFor, LOCAL_HOST_ID } from "./index.js";
import { localHost } from "./local.js";

test("hostFor: a row with no host, or host 'local', is the brain", () => {
  assert.equal(hostFor(null), localHost);
  assert.equal(hostFor(undefined), localHost);
  assert.equal(hostFor({}), localHost);
  assert.equal(hostFor({ host_id: null }), localHost);
  assert.equal(hostFor({ host_id: "local" }), localHost);
  assert.equal(hostById(LOCAL_HOST_ID).id, "local");
});

test("hostFor: an unknown host throws instead of quietly running it here", () => {
  assert.throws(() => hostFor({ host_id: "m2" }), /unknown host `m2`/);
  assert.throws(() => hostById("m5"), /not connected to this brain/);
});

const node = process.execPath;

test("LocalHost.spawnProcess: stdout lines, exit code, and listLive while it runs", async () => {
  const h = await localHost.spawnProcess({
    id: "run-a", cmd: node, args: ["-e", "console.log('one'); console.log('two'); setTimeout(() => process.exit(3), 100)"],
    cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, stdin: false,
  });
  assert.equal(h.stdin, null, "no stdin pipe unless asked for");
  assert.ok(h.pid);
  assert.deepEqual((await localHost.listLive()).find((l) => l.id === "run-a")?.kind, "proc");
  const lines: string[] = [];
  readline.createInterface({ input: h.stdout }).on("line", (l) => lines.push(l));
  const code = await new Promise<number | null>((r) => h.onClose((c) => r(c)));
  assert.equal(code, 3);
  assert.deepEqual(lines, ["one", "two"]);
  assert.equal((await localHost.listLive()).find((l) => l.id === "run-a"), undefined, "forgotten once it exits");
});

test("LocalHost.spawnProcess: stdin steer pipe reaches the child", async () => {
  const h = await localHost.spawnProcess({
    id: "run-b", cmd: node, args: ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
    cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, stdin: true,
  });
  const lines: string[] = [];
  readline.createInterface({ input: h.stdout }).on("line", (l) => lines.push(l));
  h.stdin!.write("steer\n");
  h.stdin!.end();
  await new Promise<void>((r) => h.onClose(() => r()));
  assert.deepEqual(lines, ["steer"]);
});

test("LocalHost.spawnProcess: a spawn failure reaches onError even when subscribed after the await", async () => {
  // The failure is emitted on the next tick after spawn. Before the seam, runner.ts wired 'error'
  // synchronously; now it awaits first, so the handle must hold the error until someone listens.
  const h = await localHost.spawnProcess({
    id: "run-c", cmd: "/nonexistent/chronos-no-such-binary", args: [],
    cwd: os.tmpdir(), env: {}, stdin: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  const err = await new Promise<Error>((r) => h.onError(r));
  assert.match(String(err), /ENOENT/);
});

test("LocalHost.signal: kills by pid, and throws for a pid that is not there", async () => {
  const h = await localHost.spawnProcess({
    id: "run-d", cmd: node, args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, stdin: false,
  });
  const closed = new Promise<NodeJS.Signals | null>((r) => h.onClose((_c, s) => r(s)));
  localHost.signal(h.pid!, "SIGTERM");
  assert.equal(await closed, "SIGTERM");
  assert.throws(() => localHost.signal(h.pid!, "SIGTERM"), /ESRCH/);
});

test("LocalHost.spawnPty: the handle is a working pty — output, size, exit", async () => {
  const t = await localHost.spawnPty({
    id: "sess-a", cmd: node, args: ["-e", "process.stdout.write(process.stdout.columns + 'x' + process.stdout.rows); setTimeout(() => {}, 200)"],
    cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" }, cols: 90, rows: 20,
  });
  assert.equal(t.cols, 90);
  assert.equal(t.rows, 20);
  assert.equal((await localHost.listLive()).find((l) => l.id === "sess-a")?.pid, t.pid);
  let out = "";
  t.onData((d) => { out += d; });
  const exit = await new Promise<number>((r) => t.onExit((e) => r(e.exitCode)));
  assert.equal(exit, 0);
  assert.match(out, /90x20/);
  assert.equal((await localHost.listLive()).find((l) => l.id === "sess-a"), undefined);
});

test("LocalHost.vitals and slots read the machine governor", () => {
  const v = localHost.vitals();
  assert.ok(v.load.ncpu >= 1);
  assert.ok("ok" in v.admission);
  assert.ok(Array.isArray(v.samples.history));
  assert.ok(localHost.slots.size() >= 1);
  assert.equal(localHost.slots.waiting(), 0);
  assert.deepEqual(localHost.slots.holders(), []);
});
