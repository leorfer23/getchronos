/**
 * The menu bar item's install/uninstall/refresh (menubar.ts) with an injected runner — no launchctl
 * runs here, ever — plus one REAL compile of desktop/hostbar.swift with swiftc (skipped when the
 * command-line tools are absent) whose `--render` proves the drawing code runs, not just parses.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOSTBAR_LABEL, buildHostbar, installMenubar, menubarPaths, menubarState, refreshMenubar, uninstallMenubar, type MenubarDeps } from "./menubar.js";
import { defaultRunner, type RunResult, type Runner } from "./update.js";
import { uninstall } from "../../bin/host-core.mjs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { startForwarder } from "./forwarder.js";
import { buildStatus, type WorkSource } from "./status.js";

const execFileP = promisify(execFile);

const REPO = process.cwd();
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hostbar-")));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A fake Mac: xcode-select/xcrun answer, "swiftc" writes its -o file, launchctl is only recorded. */
function world(o: { noTools?: boolean; swiftcFails?: boolean; bootstrapFails?: boolean; pid?: number } = {}) {
  const dir = path.join(tmpRoot, `w${++n}`);
  const home = path.join(dir, "home");
  const d: MenubarDeps = { run: null as unknown as Runner, hostHome: path.join(home, ".chronos-host"), pkgRoot: REPO, launchAgentsDir: path.join(home, "Library", "LaunchAgents"), uid: 501, home };
  const calls: string[] = [];
  d.run = async (cmd, args) => {
    const line = [path.basename(cmd), ...args.map((a) => (a.startsWith(dir) ? a.slice(dir.length + 1) : a.startsWith(REPO) ? `<repo>/${path.relative(REPO, a)}` : a))].join(" ");
    calls.push(line);
    if (cmd.endsWith("xcode-select")) return o.noTools ? { code: 2, stdout: "", stderr: "xcode-select: error: unable to get active developer directory" } : ok("/Library/Developer/CommandLineTools\n");
    if (cmd.endsWith("xcrun") && args[0] === "--find") return ok("/Library/Developer/CommandLineTools/usr/bin/swiftc\n");
    if (cmd.endsWith("xcrun") && args[0] === "swiftc") {
      if (o.swiftcFails) return { code: 1, stdout: "", stderr: "hostbar.swift:1:1: error: nope" };
      fs.writeFileSync(args[args.indexOf("-o") + 1], "#!fake binary");
      return ok();
    }
    if (cmd === "/bin/launchctl" && args[0] === "bootstrap" && o.bootstrapFails) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    if (cmd === "/bin/launchctl" && args[0] === "print") return o.pid ? ok(`gui/501/${HOSTBAR_LABEL} = {\n\tstate = running\n\tpid = ${o.pid}\n}`) : { code: 113, stdout: "", stderr: "Could not find service" };
    return ok();
  };
  return { d, calls, p: menubarPaths(d) };
}

test("install: compile to <bin>.next → rename → render the plist → bootout (a reinstall) → bootstrap", async () => {
  const { d, calls, p } = world();
  const r = await installMenubar(d);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls, [
    "xcode-select -p",
    "xcrun --find swiftc",
    "xcrun swiftc -O <repo>/desktop/hostbar.swift -o home/.chronos-host/bin/chronos-hostbar.next",
    `launchctl bootout gui/501/${HOSTBAR_LABEL}`,
    "launchctl bootstrap gui/501 home/Library/LaunchAgents/sh.chronos.hostbar.plist",
  ]);
  assert.equal(fs.readFileSync(p.bin, "utf8"), "#!fake binary");
  assert.equal(fs.existsSync(`${p.bin}.next`), false);
  const plist = fs.readFileSync(p.plist, "utf8");
  assert.ok(!/__[A-Z_]+__/.test(plist), "every placeholder filled");
  assert.match(plist, new RegExp(`<string>${HOSTBAR_LABEL}</string>`));
  assert.match(plist, new RegExp(`<string>${p.bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/, "a UI item starts at login");
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/, "restarted after a crash, not after Quit");
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.ok(!/TOKEN|SECRET/i.test(plist.replace(/<!--[\s\S]*?-->/g, "")), "nothing secret in a world-readable plist");
});

test("install without the command-line tools: one clear error + the fix; nothing written, nothing loaded", async () => {
  const { d, calls, p } = world({ noTools: true });
  const r = await installMenubar(d);
  assert.equal(r.ok, false);
  assert.match(r.error!, /swiftc not found/);
  assert.equal(r.fix, "xcode-select --install");
  assert.deepEqual(calls, ["xcode-select -p"], "the /usr/bin/swiftc shim (it pops a dialog) is never run");
  assert.equal(fs.existsSync(p.plist), false);
  assert.equal(fs.existsSync(p.bin), false);
});

test("a failed compile leaves the installed binary as it was and loads nothing", async () => {
  const { d, calls, p } = world({ swiftcFails: true });
  fs.mkdirSync(path.dirname(p.bin), { recursive: true });
  fs.writeFileSync(p.bin, "old build");
  const r = await installMenubar(d);
  assert.equal(r.ok, false);
  assert.match(r.error!, /swiftc failed: .*error: nope/);
  assert.equal(fs.readFileSync(p.bin, "utf8"), "old build");
  assert.equal(fs.existsSync(`${p.bin}.next`), false);
  assert.ok(!calls.some((c) => c.startsWith("launchctl")));
});

test("bootstrap failing says so, with the command to run", async () => {
  const { d } = world({ bootstrapFails: true });
  const r = await installMenubar(d);
  assert.equal(r.ok, false);
  assert.match(r.error!, /bootstrap failed: Bootstrap failed: 5/);
  assert.match(r.fix!, /^launchctl bootstrap gui\/501 ".*sh\.chronos\.hostbar\.plist"$/);
});

test("status: installed = the plist; running = launchd's pid", async () => {
  const a = world();
  assert.deepEqual(await menubarState(a.d), { installed: false, pid: null });
  assert.deepEqual(a.calls, [], "not installed: launchd is not even asked");
  const b = world({ pid: 4242 });
  await installMenubar(b.d);
  assert.deepEqual(await menubarState(b.d), { installed: true, pid: 4242 });
  const c = world();
  await installMenubar(c.d);
  assert.deepEqual(await menubarState(c.d), { installed: true, pid: null }, "quit: installed, not running");
});

test("uninstall: bootout, then the plist and the binary go", async () => {
  const { d, calls, p } = world();
  await installMenubar(d);
  calls.length = 0;
  const done = await uninstallMenubar(d);
  assert.deepEqual(calls, [`launchctl bootout gui/501/${HOSTBAR_LABEL}`]);
  assert.equal(fs.existsSync(p.plist), false);
  assert.equal(fs.existsSync(p.bin), false);
  assert.equal(done.length, 3);
});

test("`host uninstall` takes the menu bar item with it", async () => {
  const { d, p } = world();
  await installMenubar(d);
  const ran: string[] = [];
  const r = uninstall({ home: d.home, hostHome: d.hostHome, uid: 501, launchAgentsDir: d.launchAgentsDir, run: (cmd: string, args: string[]) => { ran.push([cmd, ...args].join(" ")); return ""; } });
  assert.ok(ran.includes(`/bin/launchctl bootout gui/501/${HOSTBAR_LABEL}`));
  assert.equal(fs.existsSync(p.plist), false);
  assert.equal(fs.existsSync(p.bin), false);
  assert.ok(r.done.some((l) => /menu bar/.test(l)));
});

test("after an update: rebuild + kickstart only when installed; a failed rebuild is reported, never thrown", async () => {
  const a = world();
  assert.equal(await refreshMenubar(a.d), "not installed — skipped");
  assert.deepEqual(a.calls, []);

  const b = world();
  await installMenubar(b.d);
  b.calls.length = 0;
  assert.equal(await refreshMenubar(b.d), "rebuilt and restarted");
  assert.deepEqual(b.calls.slice(-1), [`launchctl kickstart -k gui/501/${HOSTBAR_LABEL}`]);

  const c = world();
  await installMenubar(c.d);
  const broken = world({ swiftcFails: true });
  const d = { ...c.d, run: broken.d.run };
  assert.match(await refreshMenubar(d), /^rebuild failed \(swiftc failed: .*\) — the old item keeps running$/);
  assert.ok(!broken.calls.some((x) => x.includes("kickstart")), "no restart onto nothing new");
  const throwing = { ...c.d, run: async () => { throw new Error("spawn EACCES"); } };
  assert.match(await refreshMenubar(throwing), /^rebuild failed \(spawn EACCES\)$/);
});

// ───────────── the real thing ─────────────

const hasTools = (() => {
  if (process.platform !== "darwin") return false;
  try { execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("desktop/hostbar.swift compiles with swiftc -O, draws every look, and reads the real status", { skip: hasTools ? false : "no Xcode command-line tools on this machine", timeout: 300_000 }, async () => {
  const dir = path.join(tmpRoot, "real");
  const d: MenubarDeps = { run: defaultRunner, hostHome: dir, pkgRoot: REPO, launchAgentsDir: path.join(dir, "LaunchAgents"), uid: 501, home: dir };
  const r = await buildHostbar(d);
  assert.ok(r.ok, r.ok ? "" : `${r.error}`);
  const bin = menubarPaths(d).bin;
  assert.ok(fs.statSync(bin).mode & 0o100, "an executable");
  // --render exits before NSApplication starts: no menu bar item appears, nothing polls.
  const out = path.join(dir, "png");
  execFileSync(bin, ["--render", out], { timeout: 60_000 });
  const files = fs.readdirSync(out).sort();
  for (const look of ["working", "idle", "alert", "down"]) {
    for (const bar of ["light", "dark"]) for (const s of [1, 2]) assert.ok(files.includes(`${look}-${bar}@${s}x.png`), `${look}-${bar}@${s}x.png`);
  }
  assert.equal(fs.existsSync(path.join(dir, "LaunchAgents")), false, "building loads nothing");

  // --print: one poll against the REAL forwarder serving the REAL status shape, found through the port
  // in .secrets — the Swift decoder and the TypeScript encoder agree, state by state.
  const now = Date.now();
  let link: "online" | "offline" = "online";
  let work: WorkSource[] = [
    { kind: "terminal", id: "4f3a9c21-aaaa", cwd: "/x/.chronos-worktrees/app/GAL-1", backend: "claude-code", startedAt: now - 12 * 60_000, lastOut: now },
    { kind: "run", id: "9a8b7c6d-bbbb", cwd: "/x/api", backend: "codex", startedAt: now - 3 * 3600_000, lastOut: now - 60_000 },
  ];
  const srv = await startForwarder({ api: async () => ({ status: 500, headers: {}, body: null }) }, {
    port: 0,
    status: () => buildStatus({ hostId: "h_m2", name: "m2", link: { state: link, since: now - 120_000, url: null, lastError: "wss://brain/host: ECONNREFUSED" }, version: "0.1.0", commit: null, work }),
  });
  const print = async () => (await execFileP(bin, ["--print"], { env: { ...process.env, CHRONOS_HOST_HOME: dir }, timeout: 30_000 })).stdout;
  try {
    fs.writeFileSync(path.join(dir, ".secrets"), `CHRONOS_HOST_ID=h_m2\nCHRONOS_HOST_MC_PORT=${(srv.address() as { port: number }).port}\n`);
    assert.equal(await print(), [
      "title: working 1", "tooltip: m2 · connected · 1 working of 2", "m2 · connected", "---",
      "●  app — claude-code · 12m", "○  api — codex · 3h", "",
    ].join("\n"));
    work = [];
    assert.match(await print(), /^title: idle\ntooltip: m2 · connected · nothing running\nm2 · connected\n---\nNothing running\n$/);
    link = "offline";
    assert.match(await print(), /^title: alert\ntooltip: m2 · reconnecting — wss:\/\/brain\/host: ECONNREFUSED\nm2 · reconnecting · 2m\n  wss:\/\/brain\/host: ECONNREFUSED\n/);
  } finally {
    srv.close();
  }
  assert.match(await print(), /^title: down – \(dimmed\)\n.*\nChronos host · not running\n  Nothing answers on 127\.0\.0\.1:\d+\n$/, "host gone");
});
