/**
 * update.ts sequencing with an injected command runner: nothing here runs git, npm or launchctl. The
 * property under test is the one the first hosts needed — the running version is untouched until
 * the candidate has installed AND passed its own preflight, and every failure leaves it running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { envWithNode, installForJoin, launchdPid, npmCliFor, runUpdate, type RunResult, type Runner, type UpdateDeps } from "./update.js";
import type { UpdateStatus } from "../hostlink/wire.js";

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-update-")));
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A git-installed app dir: `<home>/.chronos-host/app` with a marker saying which version it is. */
function gitApp() {
  const home = tmp();
  const app = path.join(home, ".chronos-host", "app");
  fs.mkdirSync(path.join(app, ".git"), { recursive: true });
  fs.writeFileSync(path.join(app, "VERSION"), "old");
  return { home, app };
}

/**
 * A fake world: `git clone` creates the candidate dir with a bin, `npm ci` / `npm install` succeed
 * (or fail on demand), preflight passes (or fails). Every call is recorded in order.
 */
function fakeRunner(o: { failAt?: RegExp; missing?: boolean; npmLayout?: boolean } = {}) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args, opts = {}) => {
    const line = [path.basename(cmd), ...args.map((a) => (a.includes("/") ? path.basename(a) : a))].join(" ");
    calls.push(line);
    if (o.failAt?.test(line)) return { code: 1, stdout: "", stderr: `boom: ${line}\nnpm ERR! the last line` };
    if (cmd === "git" && args[2] === "remote" && args[3] === "get-url") return ok("https://github.com/leorfer23/getchronos\n");
    if (cmd === "git" && args[2] === "cat-file") return o.missing ? { code: 128, stdout: "", stderr: "" } : ok();
    if (cmd === "git" && args[0] === "clone") {
      const next = args[args.length - 1];
      fs.mkdirSync(path.join(next, "bin"), { recursive: true });
      fs.writeFileSync(path.join(next, "bin", "getchronos.mjs"), "");
      fs.writeFileSync(path.join(next, "VERSION"), "new");
      return ok();
    }
    if (args.includes("install") && opts.cwd) {
      const pkg = path.join(opts.cwd, "node_modules", "getchronos");
      fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "bin", "getchronos.mjs"), "");
      fs.writeFileSync(path.join(opts.cwd, "VERSION"), "new");
      return ok();
    }
    return ok();
  };
  return { run, calls };
}

function deps(over: Partial<UpdateDeps> & Pick<UpdateDeps, "run" | "install">): { d: UpdateDeps; reports: Array<Omit<UpdateStatus, "t" | "id">>; restarts: { n: number }; plists: string[] } {
  const reports: Array<Omit<UpdateStatus, "t" | "id">> = [];
  const restarts = { n: 0 };
  const plists: string[] = [];
  return {
    reports, restarts, plists,
    d: {
      report: (s) => reports.push(s),
      restart: async () => { restarts.n++; },
      rewritePlist: (dir) => plists.push(dir),
      current: { version: "0.1.0", commit: SHA_OLD },
      npmCli: "/fake/npm-cli.js",
      execPath: "/fake/bin/node",
      ...over,
    },
  };
}

test("git update: fetch → stage a clone at the brain's commit → npm ci with this node → preflight → swap → plist → restart", async () => {
  const { app } = gitApp();
  const { run, calls } = fakeRunner();
  const { d, reports, restarts, plists } = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  const r = await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d);
  assert.equal(r, "restarting");
  assert.deepEqual(calls, [
    "git -C app remote get-url origin",
    "git -C app fetch --quiet origin",
    `git -C app cat-file -e ${SHA_NEW}^{commit}`,
    "git clone --quiet --no-checkout app app.next",
    `git -C app.next checkout --quiet --detach ${SHA_NEW}`,
    "git -C app.next remote set-url origin getchronos",
    "node npm-cli.js ci --no-audit --no-fund",
    "node getchronos.mjs host preflight",
  ]);
  assert.equal(fs.readFileSync(path.join(app, "VERSION"), "utf8"), "new", "the new version is in place");
  assert.equal(fs.readFileSync(path.join(`${app}.prev`, "VERSION"), "utf8"), "old", "the old one is kept beside it");
  assert.equal(fs.existsSync(`${app}.next`), false);
  assert.deepEqual(plists, [app]);
  assert.equal(restarts.n, 1);
  assert.deepEqual(reports.map((x) => x.state).slice(-1), ["restarting"]);
  assert.ok(reports.some((x) => x.step === "npm ci"));
});

test("git update: npm ci fails → the candidate is deleted, the app is untouched, nothing restarts, the brain hears why", async () => {
  const { app } = gitApp();
  const { run } = fakeRunner({ failAt: /npm-cli\.js ci/ });
  const { d, reports, restarts } = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d), "failed");
  assert.equal(fs.readFileSync(path.join(app, "VERSION"), "utf8"), "old");
  assert.equal(fs.existsSync(`${app}.next`), false);
  assert.equal(fs.existsSync(`${app}.prev`), false);
  assert.equal(restarts.n, 0);
  const last = reports[reports.length - 1];
  assert.equal(last.state, "failed");
  assert.match(last.error!, /npm ci failed: .*the last line — still running the old version$/);
});

test("git update: a candidate that fails its own preflight is never swapped in", async () => {
  const { app } = gitApp();
  const { run } = fakeRunner({ failAt: /host preflight/ });
  const { d, restarts } = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d), "failed");
  assert.equal(fs.readFileSync(path.join(app, "VERSION"), "utf8"), "old");
  assert.equal(restarts.n, 0);
});

test("git update: a commit that is not on origin says to push it from the brain", async () => {
  const { app } = gitApp();
  const { run, calls } = fakeRunner({ missing: true, failAt: new RegExp(`fetch --quiet origin ${SHA_NEW}`) });
  const { d, reports } = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d), "failed");
  assert.match(reports[reports.length - 1].error!, /commit bbbbbbbbbbbb is not on https:\/\/github.com\/leorfer23\/getchronos — push it from the brain/);
  assert.ok(!calls.some((c) => c.startsWith("git clone")));
});

test("already on the target → current, nothing runs; a dev checkout or a brain without a commit is refused", async () => {
  const { app } = gitApp();
  const { run, calls } = fakeRunner();
  const a = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_OLD }, a.d), "current");
  assert.deepEqual(calls, []);
  const b = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: null }, b.d), "failed");
  assert.match(b.reports[0].error!, /no commit to update to/);
  const c = deps({ run, install: { kind: "dev", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, c.d), "failed");
  assert.match(c.reports[0].error!, /developer checkout/);
  assert.deepEqual(calls, []);
});

test("a failed restart after the swap says exactly what to run by hand", async () => {
  const { app } = gitApp();
  const { run } = fakeRunner();
  const { d, reports } = deps({ run, install: { kind: "git", pkgRoot: app, appDir: app }, restart: async () => { throw new Error("Operation not permitted"); } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d), "failed");
  assert.match(reports[reports.length - 1].error!, /launchctl kickstart -k gui\/\$\(id -u\)\/sh\.chronos\.host/);
});

test("afterSwap (the menu bar rebuild) runs after the swap, before the restart — and its failure never fails the update", async () => {
  const { app } = gitApp();
  const { run } = fakeRunner();
  const order: string[] = [];
  const { d } = deps({
    run, install: { kind: "git", pkgRoot: app, appDir: app },
    afterSwap: async (dir) => { order.push(`after:${fs.readFileSync(path.join(dir, "VERSION"), "utf8")}`); throw new Error("swiftc exploded"); },
    restart: async () => { order.push("restart"); },
  });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, d), "restarting");
  assert.deepEqual(order, ["after:new", "restart"], "it sees the NEW code, then the host restarts anyway");
});

test("one update at a time", async () => {
  const { app } = gitApp();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { run: base } = fakeRunner();
  const slow: Runner = async (c, a, o) => { if (a.includes("ci")) await gate; return base(c, a, o); };
  const first = deps({ run: slow, install: { kind: "git", pkgRoot: app, appDir: app } });
  const p = runUpdate({ version: "0.1.0", commit: SHA_NEW }, first.d);
  await new Promise((r) => setTimeout(r, 10));
  const second = deps({ run: slow, install: { kind: "git", pkgRoot: app, appDir: app } });
  assert.equal(await runUpdate({ version: "0.1.0", commit: SHA_NEW }, second.d), "failed");
  assert.match(second.reports[0].error!, /already running/);
  release();
  assert.equal(await p, "restarting");
});

test("npm update: install getchronos@<version> into a fresh dir, preflight it, swap", async () => {
  const home = tmp();
  const app = path.join(home, ".chronos-host", "app");
  fs.mkdirSync(path.join(app, "node_modules", "getchronos"), { recursive: true });
  fs.writeFileSync(path.join(app, "VERSION"), "old");
  const { run, calls } = fakeRunner();
  const { d, restarts } = deps({ run, install: { kind: "npm", pkgRoot: path.join(app, "node_modules", "getchronos"), appDir: app }, current: { version: "0.1.0", commit: null }, packageSpec: (v) => `getchronos@${v}` });
  assert.equal(await runUpdate({ version: "0.2.0", commit: null }, d), "restarting");
  assert.deepEqual(calls, ["node npm-cli.js install --no-audit --no-fund --save-exact getchronos@0.2.0", "node getchronos.mjs host preflight"]);
  assert.equal(fs.readFileSync(path.join(app, "VERSION"), "utf8"), "new");
  assert.equal(restarts.n, 1);
  // Same version → current; a non-version is refused before anything runs.
  const same = deps({ run, install: { kind: "npm", pkgRoot: app, appDir: app }, current: { version: "0.2.0", commit: null } });
  assert.equal(await runUpdate({ version: "0.2.0", commit: null }, same.d), "current");
  const bad = deps({ run, install: { kind: "npm", pkgRoot: app, appDir: app }, current: { version: "0.2.0", commit: null } });
  assert.equal(await runUpdate({ version: "latest; rm -rf /", commit: null }, bad.d), "failed");
});

test("first install from npx: the same version lands in <hostHome>/app and the stable entry is returned", async () => {
  const home = tmp();
  const hh = path.join(home, ".chronos-host");
  const { run, calls } = fakeRunner();
  process.env.CHRONOS_HOST_PACKAGE_SPEC = "";
  const entry = await installForJoin("0.1.0", { hostHome: hh, run, execPath: "/fake/bin/node", npmCli: "/fake/npm-cli.js" });
  assert.equal(entry, path.join(hh, "app", "node_modules", "getchronos", "bin", "getchronos.mjs"));
  assert.ok(fs.existsSync(entry));
  assert.deepEqual(calls[0], "node npm-cli.js install --no-audit --no-fund --save-exact getchronos@0.1.0");
  assert.equal(fs.existsSync(path.join(hh, "app.prev")), false, "nothing to move aside on a first install");
  // And a failed one throws the reason, without the "still running the old version" tail.
  const { run: bad } = fakeRunner({ failAt: /install/ });
  await assert.rejects(installForJoin("0.1.0", { hostHome: path.join(home, "h2"), run: bad, execPath: "/n", npmCli: "/x/npm-cli.js" }), (e: Error) => /npm install getchronos@0\.1\.0 failed/.test(e.message) && !/old version/.test(e.message));
});

test("npm runs under THIS node: npm-cli.js beside it, and PATH puts its dir first", () => {
  const root = tmp();
  const node = path.join(root, "bin", "node");
  const cli = path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(node, "");
  fs.writeFileSync(cli, "");
  assert.equal(npmCliFor(node, { PATH: "" }), cli);
  assert.equal(npmCliFor(node, { PATH: "", npm_execpath: "/elsewhere/npm-cli.js" }), cli, "a npm_execpath that does not exist is skipped");
  assert.equal(npmCliFor(path.join(tmp(), "bin", "node"), { PATH: "" }), null);
  assert.equal(envWithNode(node, { PATH: `/opt/homebrew/bin:${path.dirname(node)}` }).PATH, `${path.dirname(node)}:/opt/homebrew/bin`);
});

test("launchdPid reads launchctl print; not loaded = null", async () => {
  const run: Runner = async (_c, a) => (a[1].endsWith("sh.chronos.host") ? ok("gui/501/sh.chronos.host = {\n\tstate = running\n\tpid = 4242\n}") : { code: 113, stdout: "", stderr: "" });
  assert.equal(await launchdPid(run, 501), 4242);
  assert.equal(await launchdPid(async () => ({ code: 113, stdout: "", stderr: "Could not find service" }), 501), null);
});
