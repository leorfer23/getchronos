/**
 * The brain's menu bar item: scripts/brainbar.mjs install/uninstall/refresh sequenced with an injected
 * runner (no launchctl runs here, ever), the CLI's --dry-run, and one REAL compile of
 * desktop/hostbar.swift whose `--brain --print` reads a real GET /api/hosts/bar (skipped without the
 * command-line tools). Host mode's own compile/print test is src/hostd/menubar.test.ts, unchanged.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
// @ts-ignore — plain .mjs (it runs before `npm run build`); tests are outside tsc's include anyway.
import * as bb from "../scripts/brainbar.mjs";
import { db, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import { barRoutes, type ActivityFn } from "./hostlink/bar.js";

const execFileP = promisify(execFile);
const REPO = process.cwd();
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brainbar-")));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
type RunResult = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A fake brain Mac: the tools answer, "swiftc" writes its -o file, launchctl is only recorded. */
function world(o: { noTools?: boolean; swiftcFails?: boolean; bootstrapFails?: boolean; pid?: number } = {}) {
  const dir = path.join(tmpRoot, `w${++n}`);
  const home = path.join(dir, "home");
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([path.basename(cmd), ...args.map((a) => (a.startsWith(dir) ? a.slice(dir.length + 1) : a.startsWith(REPO) ? `<repo>/${path.relative(REPO, a)}` : a))].join(" "));
    if (cmd.endsWith("xcode-select")) return o.noTools ? { code: 2, stdout: "", stderr: "unable to get active developer directory" } : ok("/Library/Developer/CommandLineTools\n");
    if (cmd.endsWith("xcrun") && args[0] === "--find") return ok("/x/swiftc\n");
    if (cmd.endsWith("xcrun") && args[0] === "swiftc") {
      if (o.swiftcFails) return { code: 1, stdout: "", stderr: "hostbar.swift:1:1: error: nope" };
      fs.writeFileSync(args[args.indexOf("-o") + 1], "#!fake binary");
      return ok();
    }
    if (cmd === "/bin/launchctl" && args[0] === "bootstrap" && o.bootstrapFails) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    if (cmd === "/bin/launchctl" && args[0] === "print") return o.pid ? ok(`gui/501/${bb.BRAINBAR_LABEL} = {\n\tpid = ${o.pid}\n}`) : { code: 113, stdout: "", stderr: "Could not find service" };
    return ok();
  };
  const d = bb.brainbarDeps({ run, home, repoDir: REPO, uid: 501, logDir: path.join(home, "chronos"), port: "7777" });
  return { d, calls, p: bb.brainbarPaths(d), dir };
}

test("install: compile → rename → plist → plutil → bootout (a reinstall) → bootstrap, into ~/.mc and sh.chronos.brainbar", async () => {
  const { d, calls, p } = world();
  assert.deepEqual(await bb.installBrainbar(d), { ok: true });
  assert.deepEqual(calls, [
    "xcode-select -p",
    "xcrun --find swiftc",
    "xcrun swiftc -O <repo>/desktop/hostbar.swift -o home/.mc/bin/chronos-hostbar.next",
    "plutil -lint home/Library/LaunchAgents/sh.chronos.brainbar.plist",
    "launchctl bootout gui/501/sh.chronos.brainbar",
    "launchctl bootstrap gui/501 home/Library/LaunchAgents/sh.chronos.brainbar.plist",
  ]);
  assert.equal(fs.readFileSync(p.bin, "utf8"), "#!fake binary");
  const plist = fs.readFileSync(p.plist, "utf8");
  assert.ok(!/__[A-Z_]+__/.test(plist), "every placeholder filled");
  assert.match(plist, /<string>sh\.chronos\.brainbar<\/string>/);
  assert.match(plist, /<array>\s*<string>[^<]*\/\.mc\/bin\/chronos-hostbar<\/string>\s*<string>--brain<\/string>\s*<\/array>/, "the same binary, in brain mode");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/, "restarted after a crash, not after Quit");
  assert.match(plist, /<key>CHRONOS_REPO<\/key>\s*<string>[^<]+<\/string>/);
  assert.match(plist, /<key>CHRONOS_PORT<\/key>\s*<string>7777<\/string>/);
  assert.ok(!/TOKEN|SECRET/i.test(plist.replace(/<!--[\s\S]*?-->/g, "")), "nothing secret in a world-readable plist");
  assert.ok(!/<!--(?:(?!-->)[\s\S])*--(?!>)/.test(plist), "no `--` inside an XML comment (plutil rejects it)");
});

test("without the command-line tools: one error + the fix; nothing written, nothing loaded", async () => {
  const { d, calls, p } = world({ noTools: true });
  const r = await bb.installBrainbar(d);
  assert.equal(r.ok, false);
  assert.equal(r.fix, "xcode-select --install");
  assert.deepEqual(calls, ["xcode-select -p"]);
  assert.equal(fs.existsSync(p.plist), false);
});

test("a failed compile keeps the old binary and loads nothing; a failed bootstrap names the command", async () => {
  const a = world({ swiftcFails: true });
  fs.mkdirSync(path.dirname(a.p.bin), { recursive: true });
  fs.writeFileSync(a.p.bin, "old build");
  const r = await bb.installBrainbar(a.d);
  assert.match(r.error, /swiftc failed: .*error: nope/);
  assert.equal(fs.readFileSync(a.p.bin, "utf8"), "old build");
  assert.ok(!a.calls.some((c) => c.startsWith("launchctl")));
  const b = world({ bootstrapFails: true });
  const r2 = await bb.installBrainbar(b.d);
  assert.match(r2.error, /bootstrap failed: Bootstrap failed: 5/);
  assert.match(r2.fix, /^launchctl bootstrap gui\/501 ".*sh\.chronos\.brainbar\.plist"$/);
});

test("status, uninstall", async () => {
  const a = world();
  assert.deepEqual(await bb.brainbarState(a.d), { installed: false, pid: null });
  assert.deepEqual(a.calls, [], "not installed: launchd is not even asked");
  const b = world({ pid: 777 });
  await bb.installBrainbar(b.d);
  assert.deepEqual(await bb.brainbarState(b.d), { installed: true, pid: 777 });
  b.calls.length = 0;
  const done = await bb.uninstallBrainbar(b.d);
  assert.deepEqual(b.calls, ["launchctl bootout gui/501/sh.chronos.brainbar"]);
  assert.equal(fs.existsSync(b.p.plist), false);
  assert.equal(fs.existsSync(b.p.bin), false);
  assert.equal(done.length, 3);
});

test("refresh (npm run deploy): nothing unless installed; rebuild + kickstart only when the Swift is newer; never throws", async () => {
  const a = world();
  assert.equal(await bb.refreshBrainbar(a.d), "not installed — skipped");
  assert.deepEqual(a.calls, [], "a brain without the item: deploy does not touch it");

  const b = world();
  await bb.installBrainbar(b.d);
  b.calls.length = 0;
  const future = Date.now() / 1000 + 3600;
  fs.utimesSync(b.p.bin, future, future);
  assert.equal(await bb.refreshBrainbar(b.d), "up to date — skipped");
  assert.deepEqual(b.calls, []);
  fs.utimesSync(b.p.bin, 1, 1);
  assert.equal(await bb.refreshBrainbar(b.d), "rebuilt and restarted");
  assert.deepEqual(b.calls.slice(-1), ["launchctl kickstart -k gui/501/sh.chronos.brainbar"]);

  const c = world();
  await bb.installBrainbar(c.d);
  fs.utimesSync(c.p.bin, 1, 1);
  assert.match(await bb.refreshBrainbar({ ...c.d, run: async () => { throw new Error("spawn EACCES"); } }), /^rebuild failed \(spawn EACCES\)$/);
});

test("the CLI's --dry-run prints the steps and the plist, and writes nothing", async () => {
  const home = path.join(tmpRoot, "dry");
  fs.mkdirSync(home);
  const { stdout } = await execFileP(process.execPath, [path.join(REPO, "scripts/brainbar.mjs"), "install", "--dry-run"], { env: { ...process.env, HOME: home, CHRONOS_PORT: "7799" } });
  assert.match(stdout, /xcrun swiftc -O .*desktop\/hostbar\.swift -o .*\/\.mc\/bin\/chronos-hostbar\.next/);
  assert.match(stdout, /launchctl bootstrap gui\/\d+ .*sh\.chronos\.brainbar\.plist/);
  assert.match(stdout, /<key>CHRONOS_PORT<\/key>\s*<string>7799<\/string>/);
  assert.deepEqual(fs.readdirSync(home), [], "nothing written");
});

// ───────────── the real thing ─────────────

const hasTools = (() => {
  if (process.platform !== "darwin") return false;
  try { execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }); return true; } catch { return false; }
})();

beforeEach(() => {
  db.exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM workspaces;");
  db.exec("DELETE FROM hosts WHERE id != 'local'; UPDATE hosts SET name = 'studio' WHERE id = 'local';");
});

test("hostbar.swift --brain: compiles, and --print reads the real /api/hosts/bar state by state (token file, re-read on reject)", { skip: hasTools ? false : "no Xcode command-line tools on this machine", timeout: 300_000 }, async () => {
  const { d, dir } = world();
  const b = await bb.buildBrainbar({ ...d, run: bb.defaultRunner });
  assert.ok(b.ok, b.error);
  const bin = b.bin as string;

  // The fleet: this Mac with 10 terminals (1 working), m2 connected and working, m5 offline with a live one.
  const now = Date.now();
  db.prepare("INSERT INTO hosts (id,name,platform,status,token_hash,last_seen_at,created_at) VALUES ('h_m2','m2','darwin','online','x',NULL,?),('h_m5','m5','darwin','online','y',?,?)")
    .run(new Date().toISOString(), new Date(now - 7 * 60_000).toISOString(), new Date().toISOString());
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const mk = (host: string, goal: string | null, cwd: string, minsAgo: number) => {
    const s = sessions.create({ workspace_id: w.id, cwd, backend: "claude-code" } as any);
    db.prepare("UPDATE sessions SET host_id = ?, status = 'live', goal = ?, created_at = ? WHERE id = ?").run(host, goal, new Date(now - minsAgo * 60_000).toISOString(), s.id);
    return s.id;
  };
  const working = [mk(LOCAL_HOST_ID, "open the rollback PR", "/Users/leo/src/app", 12), mk("h_m2", null, "/Users/m2/work/dbt", 65)];
  for (let i = 0; i < 9; i++) mk(LOCAL_HOST_ID, `chore ${i}`, "/Users/leo/src/docs", 20 + i);
  mk("h_m5", "sweep logs", "/Users/m5/api", 3);
  let links = ["h_m2", "h_m5"];
  const activity: ActivityFn = (id) => working.includes(id) ? { live: true, quiet: false, last_out: now } : { live: true, quiet: true, last_out: now - 60_000 };

  const TOKEN = "brainbar-test-token";
  const seen: string[] = [];
  let rejectNext = 0;
  const app = express();
  app.use((req, _res, next) => { seen.push(req.get("x-mc-admin") ?? "<none>"); next(); });
  const gate: express.RequestHandler = (req, res, next) => {
    if (rejectNext > 0) { rejectNext--; return void res.status(403).end(); }
    return req.get("x-mc-admin") === TOKEN ? next() : void res.status(403).end();
  };
  app.use("/api", barRoutes(gate, { link: () => ({ list: () => links.map((host_id) => ({ host_id, connected_at: now - 60_000 })) }) as any, activity }));
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const mcHome = path.join(dir, "mc");
  fs.mkdirSync(mcHome, { recursive: true });
  const env = { ...process.env, CHRONOS_PORT: String(port), CHRONOS_MC_HOME: mcHome, CHRONOS_REPO: path.join(dir, "no-repo"), CHRONOS_ADMIN_TOKEN: "" };
  const print = async () => (await execFileP(bin, ["--brain", "--print"], { env, timeout: 30_000 })).stdout;
  try {
    // No token file: the daemon refuses, the item says so (and tried the file again before giving up).
    assert.match(await print(), /^title: down – \(dimmed\)\ntooltip: Chronos daemon refused the admin token\nChronos · admin token refused\n  Tried .*\/mc\/\.admin-token, .*\/no-repo\/\.admin-token\n$/);
    assert.deepEqual(seen.splice(0), ["<none>", "<none>"], "one retry after re-reading, then stop");

    fs.writeFileSync(path.join(mcHome, ".admin-token"), `${TOKEN}\n`);
    rejectNext = 1; // a rotation: the first try is rejected, the re-read token then works
    links = ["h_m2"];
    const out = await print();
    assert.deepEqual(seen.splice(0), [TOKEN, TOKEN]);
    const lines = out.split("\n");
    assert.equal(lines[0], "title: alert 2", "m5 is offline with live work: badge; the count is what the brain sees working");
    assert.equal(lines[1], "tooltip: m5 offline with work on it · 2 working elsewhere");
    assert.equal(lines[2], "This Mac · 1 working");
    assert.equal(lines[3], "●  open the rollback PR — claude-code · 12m");
    assert.equal(lines.filter((l) => l.startsWith("○  chore")).length, 7, "8 rows per computer…");
    assert.ok(lines.includes("  +2 more"), "…then +N more");
    assert.ok(lines.includes("m2 · connected · 1 working"));
    assert.ok(lines.includes("●  dbt — claude-code · 1h 5m"), "no title: the repo folder");
    assert.ok(lines.includes("m5 · offline · 7m · 0 working"));
    assert.ok(lines.includes("○  sweep logs — claude-code · 3m"));
    assert.ok(!out.includes(TOKEN), "the token is never printed");

    links = ["h_m2", "h_m5"];
    assert.match(await print(), /^title: working 2\ntooltip: Chronos · 2 working of 12\n/);
    working.length = 0;
    assert.match(await print(), /^title: idle\ntooltip: Chronos · 0 working of 12\n/);
    db.exec("DELETE FROM sessions");
    assert.match(await print(), /^title: idle\ntooltip: Chronos · nothing running\nThis Mac · nothing running\n---\nm2 · connected · nothing running\n---\nm5 · connected · nothing running\n$/);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  assert.match(await print(), /^title: down – \(dimmed\)\ntooltip: Chronos daemon is not answering on 127\.0\.0\.1:\d+\nChronos · daemon not answering\n/, "daemon gone");
  // --render still draws every look (the drawing code is shared with host mode).
  const png = path.join(dir, "png");
  execFileSync(bin, ["--brain", "--render", png], { timeout: 60_000 });
  assert.equal(fs.readdirSync(png).length, 16);
});
