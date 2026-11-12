/**
 * `npm run setup` (scripts/setup.mjs), `npm run desk` (scripts/open-desk.mjs) and install.sh, end to end
 * against a fake world: every command goes through an injected runner and every daemon call through a
 * fake fetch, so no launchctl, no build, no browser and no real daemon is ever touched — the LaunchAgent
 * labels on this machine belong to the operator's live Chronos. install.sh runs for real in bash, against
 * a throwaway git repo, with fake `node` and `npm` first on PATH.
 *
 * Plus one REAL build of the Chronos app (slow suite, Xcode tools required) into a temp HOME, with the
 * session-wide registration skipped, proving the bundle carries its checkout and port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
// @ts-ignore — plain .mjs scripts, no types
import { APP_LABEL, SetupError, cliChecks, ensureApp, ensureDaemon, launchdOwner, parseArgs, planActions, runSetup } from "../scripts/setup.mjs";
// @ts-ignore
import { DeskError, mintDeskUrl, openInBrowser, readToken } from "../scripts/open-desk.mjs";

const REPO = process.cwd();
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-cli-")));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => { const d = path.join(tmpRoot, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** A checkout-shaped directory: src/, a built dist/ (newer than src unless `stale`), desktop/app.swift, a token. */
function fakeRepo(o: { stale?: boolean } = {}) {
  const repo = fresh("repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export {};\n");
  fs.mkdirSync(path.join(repo, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(repo, "desktop", "app.swift"), "print(1)\n");
  fs.writeFileSync(path.join(repo, ".admin-token"), "tok-a\n");
  if (!o.stale) {
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "dist", "index.js"), "");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(repo, "dist", "index.js"), later, later);
  }
  return repo;
}

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
type Answer = { code: number | null; stdout?: string; stderr?: string };

/** The injected world. `answer` decides each command; health flips up when `up()` says so. */
function world(o: { repo?: string; home?: string; platform?: string; up?: () => boolean; answer?: (c: Call) => Answer | undefined; status?: () => unknown; interactive?: boolean; token?: string; healthBody?: (mine: boolean) => unknown } = {}) {
  const calls: Call[] = [];
  const api: string[] = [];
  let clock = 0;
  let out = "", err = "";
  const opened: string[] = [];
  const repo = o.repo ?? fakeRepo();
  const home = o.home ?? fresh("home");
  const d = {
    env: { PATH: process.env.PATH ?? "", CHRONOS_PORT: "7911" } as Record<string, string>,
    platform: o.platform ?? "darwin",
    home,
    uid: 501,
    repoDir: repo,
    node: "/fake/node",
    interactive: o.interactive ?? false,
    run: async (cmd: string, args: string[], ro: { env?: Record<string, string> } = {}) => {
      const c = { cmd, args, env: ro.env };
      calls.push(c);
      const a = o.answer?.(c);
      return { code: a?.code ?? 0, stdout: a?.stdout ?? "", stderr: a?.stderr ?? "" };
    },
    fetch: async (url: string, init: any = {}) => {
      const u = new URL(url);
      const p = u.pathname + u.search;
      const method = init.method ?? "GET";
      api.push(`${method} ${p}`);
      if (!(o.up?.() ?? true)) throw new TypeError("fetch failed");
      const res = (status: number, body: unknown) => ({ status, ok: status < 300, json: async () => body });
      const mine = (init.headers ?? {})["x-mc-admin"] === (o.token ?? "tok-a");
      if (p === "/api/health") return res(200, o.healthBody ? o.healthBody(mine) : mine ? { ok: true, operational: {} } : { ok: true });
      if (!mine) return res(403, { error: "admin token required (x-mc-admin)" });
      if (p.startsWith("/api/setup/status")) return res(200, o.status?.() ?? { daemon: { ok: true }, projects: 0, clis: [] });
      if (p.startsWith("/api/setup/smoke/")) return res(200, { ok: true, ms: 2300, reply: "OK" });
      if (p.startsWith("/api/setup/install/")) return res(200, { ok: true, log_tail: "installed" });
      if (p.startsWith("/api/setup/login/")) return res(200, { ok: true });
      if (p === "/api/pair") return res(201, { code: "AbCdEfGhIjKlMnOpQrStUvWxYz012345", expires_at: new Date().toISOString() });
      return res(404, { error: "not found" });
    },
    ask: async () => true,
    out: { isTTY: false, write: (s: string) => { out += s; } },
    err: { isTTY: false, write: (s: string) => { err += s; } },
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    openUrl: (url: string) => { opened.push(url); return true; },
    preflight: () => [{ id: "node", ok: true, level: "error", label: "node 22–26", detail: "v24" }],
  };
  return { d, calls, api, opened, repo, home, out: () => out, err: () => err, tick: (ms: number) => { clock += ms; } };
}
const ctxOf = (w: ReturnType<typeof world>, opts: Record<string, unknown> = {}) => ({ d: w.d, opts: { ...parseArgs([], {}), ...opts }, port: 7911, stream: w.d.out, say: (s: string) => w.d.out.write(s + "\n"), human: () => {} });
const line = (c: Call) => [c.cmd, ...c.args].join(" ");

// ───────────── flags ─────────────

test("flags: both `npm run setup -- --yes` and `npm run setup --yes` (npm_config_yes) work; negatives need the --", () => {
  assert.deepEqual(
    (({ yes, json, foreground, smoke, open, app, install, replaceExisting }) => ({ yes, json, foreground, smoke, open, app, install, replaceExisting }))(parseArgs(["--yes", "--json", "--no-smoke", "--no-open"], {})),
    { yes: true, json: true, foreground: false, smoke: false, open: false, app: true, install: true, replaceExisting: false },
  );
  const viaNpm = parseArgs([], { npm_config_yes: "true", npm_config_json: "true", npm_config_foreground: "true", npm_config_open: "false" });
  assert.deepEqual([viaNpm.yes, viaNpm.json, viaNpm.foreground, viaNpm.open], [true, true, true, true]);
  assert.deepEqual(parseArgs(["--yes", "--bogus"], {}).unknown, ["--bogus"]);
});

// ───────────── the daemon ─────────────

const PRINT_OTHER = `gui/501/sh.chronos.daemon = {\n\tactive count = 1\n\tpath = /Users/operator/Library/LaunchAgents/sh.chronos.daemon.plist\n\tstate = running\n\tprogram = /opt/homebrew/opt/node/bin/node\n\targuments = {\n\t\t/opt/homebrew/opt/node/bin/node\n\t\t/Users/operator/chronos/dist/index.js\n\t}\n\n\tworking directory = /Users/operator/chronos\n}`;

test("launchdOwner reads which checkout the loaded LaunchAgent runs", () => {
  assert.equal(launchdOwner(PRINT_OTHER), "/Users/operator/chronos");
  assert.equal(launchdOwner(PRINT_OTHER.replace(/\n\tworking directory.*\n/, "\n")), "/Users/operator/chronos");
  assert.equal(launchdOwner("gui/501/x = {\n\tstate = waiting\n}"), null);
});

test("a Chronos another folder set up to start at login is never replaced — unless --replace-existing", async () => {
  let up = false;
  const w = world({ up: () => up, answer: (c) => (c.cmd === "/bin/launchctl" ? { code: 0, stdout: PRINT_OTHER } : c.args[0]?.endsWith("install-launchd.mjs") ? ((up = true), { code: 0 }) : undefined) });
  await assert.rejects(ensureDaemon(ctxOf(w)), (e: any) => e instanceof SetupError && /Chronos from \/Users\/operator\/chronos already starts at login/.test(e.message) && /--replace-existing/.test(e.fix));
  assert.deepEqual(w.calls.map(line), ["/bin/launchctl print gui/501/sh.chronos.daemon"], "it only looked");

  const w2 = world({ up: () => up, answer: (c) => (c.cmd === "/bin/launchctl" ? { code: 0, stdout: PRINT_OTHER } : c.args[0]?.endsWith("install-launchd.mjs") ? ((up = true), { code: 0 }) : undefined) });
  assert.deepEqual(await ensureDaemon(ctxOf(w2, { replaceExisting: true })), { how: "launchd" });
});

test("not running yet: build when dist is stale, then the daemon-only LaunchAgent with this port — and nothing else touches launchctl", async () => {
  let up = false;
  const repo = fakeRepo({ stale: true });
  const w = world({
    repo,
    up: () => up,
    answer: (c) => {
      if (c.cmd === "/bin/launchctl") return { code: 113, stderr: "Could not find service" };
      if (c.args[0]?.endsWith("/tsc")) { fs.mkdirSync(path.join(repo, "dist"), { recursive: true }); fs.writeFileSync(path.join(repo, "dist", "index.js"), ""); return { code: 0 }; }
      if (c.args[0]?.endsWith("install-launchd.mjs")) { up = true; return { code: 0 }; }
    },
  });
  assert.deepEqual(await ensureDaemon(ctxOf(w)), { how: "launchd" });
  assert.deepEqual(w.calls.map((c) => [c.cmd, ...c.args].map((a) => a.replace(repo, "<repo>")).join(" ")), [
    "/bin/launchctl print gui/501/sh.chronos.daemon",
    "/fake/node <repo>/node_modules/typescript/bin/tsc -p tsconfig.json",
    "/fake/node <repo>/scripts/install-launchd.mjs",
  ]);
  const inst = w.calls[2];
  assert.equal(inst.args.length, 1, "daemon only: no --all, no --only");
  assert.equal(inst.env!.CHRONOS_PORT, "7911");
  assert.equal(inst.env!.CHRONOS_LOG_DIR, repo, "logs beside the code, not a ~/chronos made up for them");
  assert.ok(!w.calls.some((c) => c.args.some((a) => /bootout|bootstrap|kickstart/.test(a))));
});

test("already running from this folder: reused, nothing run; another Chronos or another program on the port: stop and say so", async () => {
  const w = world();
  assert.deepEqual(await ensureDaemon(ctxOf(w)), { how: "reused" });
  assert.equal(w.calls.length, 0);
  await assert.rejects(ensureDaemon(ctxOf(world({ token: "someone-else" }))), (e: any) => /Another Chronos is already running on port 7911/.test(e.message) && e.fix === "CHRONOS_PORT=7912 npm run setup");
  await assert.rejects(ensureDaemon(ctxOf(world({ healthBody: () => ({ hello: "nginx" }) }))), (e: any) => /Port 7911 is taken by another program/.test(e.message));
});

test("--foreground (and anything not a Mac): no launchctl at all — it waits for `npm start`, then carries on", async () => {
  for (const [opts, platform] of [[{ foreground: true }, "darwin"], [{}, "linux"]] as const) {
    let polls = 0;
    const w = world({ platform, up: () => ++polls > 6 });
    assert.deepEqual(await ensureDaemon(ctxOf(w, opts)), { how: "foreground" });
    assert.equal(w.calls.length, 0, `${platform}: nothing run`);
    assert.match(w.out(), /npm start/);
  }
  const never = world({ up: () => false, platform: "linux" });
  await assert.rejects(ensureDaemon(ctxOf(never)), (e: any) => /didn't start/.test(e.message) && /npm start/.test(e.fix));
});

// ───────────── the app ─────────────

function appWorld(o: { tools?: boolean; bundle?: Record<string, string> | null; agent?: boolean; buildFails?: boolean } = {}) {
  const repo = fakeRepo();
  const home = fresh("apphome");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "desktop", "app.swift"))).digest("hex").slice(0, 16);
  if (o.bundle) {
    fs.mkdirSync(path.join(home, ".mc", "mc-app.app", "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(home, ".mc", "mc-app.app", "Contents", "MacOS", "mc-app"), "");
  }
  if (o.agent) { fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true }); fs.writeFileSync(path.join(home, "Library", "LaunchAgents", `${APP_LABEL}.plist`), "<plist/>"); }
  const keys = { ChronosHome: repo, ChronosSource: hash, ChronosURL: "http://localhost:7911", ...(o.bundle ?? {}) } as Record<string, string>;
  const w = world({
    repo, home,
    answer: (c) => {
      if (c.cmd === "/usr/bin/xcode-select") return { code: o.tools === false ? 2 : 0, stdout: "/Library/Developer/CommandLineTools\n" };
      if (c.cmd === "/usr/bin/xcrun") return { code: 0, stdout: "/x/swiftc\n" };
      if (c.cmd === "/usr/bin/plutil") return keys[c.args[1]] ? { code: 0, stdout: keys[c.args[1]] + "\n" } : { code: 1 };
      if (c.args[0]?.endsWith("build-app.sh")) return { code: o.buildFails ? 1 : 0, stderr: o.buildFails ? "app.swift:3:1: error: nope" : "" };
    },
  });
  return { ...w, hash };
}

test("the app: no developer tools → the browser, with the one command that gets the app later", async () => {
  const w = appWorld({ tools: false });
  const r = await ensureApp(ctxOf(w));
  assert.equal(r.ok, false);
  assert.match(r.fix, /^xcode-select --install/);
  assert.deepEqual(w.calls.map(line), ["/usr/bin/xcode-select -p"], "the /usr/bin/swiftc shim (it pops a dialog) is never run");
});

test("the app: first time → build it for this checkout and port, then the start-at-login agent (which opens it)", async () => {
  const w = appWorld({ bundle: null });
  assert.deepEqual(await ensureApp(ctxOf(w)), { ok: true, built: true });
  const ran = w.calls.map((c) => [c.cmd, ...c.args].map((a) => a.replace(w.repo, "<repo>")).join(" "));
  assert.deepEqual(ran, ["/usr/bin/xcode-select -p", "/usr/bin/xcrun --find swiftc", "/bin/bash <repo>/scripts/build-app.sh", `/fake/node <repo>/scripts/install-launchd.mjs --only ${APP_LABEL}`]);
  assert.equal(w.calls[2].env!.CHRONOS_PORT, "7911", "the bundle is stamped with this port");
  assert.ok(!ran.some((l) => l.startsWith("/usr/bin/open")), "RunAtLoad opens it — no second window");
});

test("the app: already built for this checkout and source → just opened, not rebuilt; built for another checkout → left alone", async () => {
  const w = appWorld({ bundle: {}, agent: true });
  assert.deepEqual(await ensureApp(ctxOf(w)), { ok: true, built: false });
  assert.ok(!w.calls.some((c) => c.args[0]?.endsWith("build-app.sh")));
  assert.equal(line(w.calls.at(-1)!), `/usr/bin/open ${path.join(w.home, ".mc", "mc-app.app")}`);

  const stale = appWorld({ bundle: { ChronosSource: "0000000000000000" }, agent: true });
  assert.deepEqual(await ensureApp(ctxOf(stale)), { ok: true, built: true }, "app.swift changed → rebuilt");

  const theirs = appWorld({ bundle: { ChronosHome: "/Users/operator/chronos" }, agent: true });
  const r = await ensureApp(ctxOf(theirs));
  assert.equal(r.ok, false);
  assert.match(r.why, /belongs to \/Users\/operator\/chronos/);
  assert.ok(!theirs.calls.some((c) => c.args[0]?.endsWith("build-app.sh") || c.cmd === "/usr/bin/open"));

  const broken = appWorld({ bundle: null, buildFails: true });
  const b = await ensureApp(ctxOf(broken));
  assert.equal(b.ok, false);
  assert.match(b.why, /building it failed \(app\.swift:3:1: error: nope\)/);
});

// ───────────── the whole run ─────────────

const cli = (id: string, o: Record<string, unknown> = {}) => ({
  id, label: ({ claude: "Claude Code", codex: "Codex (ChatGPT)", "cursor-agent": "Cursor", grok: "Grok", opencode: "opencode" } as Record<string, string>)[id], backend: id,
  installed: true, version: "1.0.0", path: `~/.local/bin/${id}`, loggedIn: true, authDetail: null, app: false, can_install: false,
  install: `install-${id}`, login: `login-${id}`, try: `try-${id}`, ...o,
});
const status = (clis: unknown[]) => ({ daemon: { ok: true, version: "0.1.0", port: 7911 }, projects: 0, clis });

test("checklist: every ✗ carries one command; the optional CLIs share one line", () => {
  const checks = cliChecks([
    cli("claude", { installed: false, version: null, loggedIn: null, can_install: true }),
    cli("codex", { loggedIn: false }),
    cli("cursor-agent", { authDetail: "Cursor account" }),
    cli("grok", { installed: false, loggedIn: null }),
    cli("opencode", { loggedIn: null, authDetail: "free models, no sign-in needed" }),
  ], { "cursor-agent": { ok: false, ms: 900, error: "rate limited" }, opencode: { ok: true, ms: 3100 } });
  assert.deepEqual(checks.map((c: any) => [c.ok, c.line, c.fix]), [
    [false, "Claude Code — not installed", "install-claude"],
    [false, "Codex (ChatGPT) 1.0.0 — not signed in", "login-codex"],
    [false, "Cursor 1.0.0 — a test prompt failed: rate limited", "try-cursor-agent"],
    [true, "opencode 1.0.0 — free models, no sign-in needed, answered in 3.1 s", null],
    [true, "Also works with Grok — not installed, optional", null],
  ]);
  assert.ok(checks.filter((c: any) => !c.ok).every((c: any) => c.fix));
});

test("planActions: install Claude Code when missing and anything whose app is here; sign in to Claude Code and Codex", () => {
  const p = planActions([cli("claude", { installed: false, can_install: true }), cli("codex", { loggedIn: false }), cli("cursor-agent", { installed: false, can_install: true, app: true }), cli("grok", { installed: false, can_install: true }), cli("opencode", { loggedIn: false })]);
  assert.deepEqual(p.install.map((c: any) => c.id), ["claude", "cursor-agent"]);
  assert.deepEqual(p.signIn.map((c: any) => c.id), ["codex"]);
});

test("run: one CLI ready → exit 0, the Desk opened signed in, and a --json report on stdout only", async () => {
  const w = world({ platform: "linux", status: () => status([cli("claude", { installed: false, loggedIn: null, can_install: true, version: null }), cli("codex", { authDetail: "ChatGPT account" })]) });
  const { exitCode, report } = await runSetup({ ...parseArgs(["--json"], {}) }, w.d);
  assert.equal(exitCode, 0);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((c: any) => [c.id, c.ok]), [["prereqs", true], ["daemon", true], ["claude", false], ["codex", true], ["desk", true]]);
  assert.equal(report.checks.find((c: any) => c.id === "claude").fix, "install-claude");
  assert.deepEqual(report.desk, { opened: "browser", reopen: "npm run desk" });
  assert.deepEqual(w.opened, ["http://localhost:7911/desk#pair=AbCdEfGhIjKlMnOpQrStUvWxYz012345"]);
  assert.deepEqual(JSON.parse(w.out()), report, "stdout is the report and nothing else");
  assert.match(w.err(), /Not installing or signing in: there's no terminal to ask in\. To do it: npm run setup -- --yes/);
  assert.ok(w.api.includes("POST /api/setup/smoke/codex") && !w.api.some((a) => a.includes("/setup/install/")), "no terminal, no --yes: nothing installed");
});

test("run: nothing ready only because there was no terminal to ask → exit 2 and the exact flag", async () => {
  const w = world({ platform: "linux", status: () => status([cli("claude", { installed: false, loggedIn: null, can_install: true, version: null })]) });
  const { exitCode, report } = await runSetup(parseArgs(["--no-open"], {}), w.d);
  assert.equal(exitCode, 2);
  assert.equal(report.checks.at(-1).fix, "npm run setup -- --yes");
  assert.match(w.out(), /Run it again with --yes to finish: npm run setup -- --yes\n$/);
});

test("run --yes with no terminal: installs, then a HUMAN STEP for the browser sign-in, waits on it, and re-checks", async () => {
  let signedIn = false, installed = false;
  const w = world({
    platform: "linux",
    status: () => status([cli("claude", installed ? { loggedIn: signedIn } : { installed: false, loggedIn: null, can_install: true, version: null })]),
  });
  const fetch0 = w.d.fetch;
  w.d.fetch = async (url: string, init: any = {}) => {
    if (url.includes("/setup/install/claude")) installed = true;
    if (url.includes("/setup/login/claude")) signedIn = true;
    return fetch0(url, init);
  };
  const { exitCode, report } = await runSetup(parseArgs(["--yes", "--no-open"], {}), w.d);
  assert.equal(exitCode, 0);
  assert.deepEqual(w.api.filter((a) => /install|login/.test(a)), ["POST /api/setup/install/claude", "POST /api/setup/login/claude"]);
  assert.equal(report.human_steps.length, 1);
  assert.match(report.human_steps[0], /^Sign in to Claude Code: a Claude page opens in your browser — .*click "Authorize"\. Setup waits up to 3 minutes\.$/);
  assert.match(w.out(), /^HUMAN STEP: Sign in to Claude Code/m);
});

test("run with a terminal: asks once, and the sign-in runs right here with the profile dir in the command", async () => {
  const asked: string[] = [];
  const w = world({ platform: "linux", interactive: true, status: () => status([cli("claude", { loggedIn: false, login: 'CLAUDE_CONFIG_DIR="$HOME/.claude" claude auth login' })]) });
  w.d.ask = async (q: string) => { asked.push(q); return true; };
  await runSetup(parseArgs(["--no-open", "--no-smoke"], {}), w.d);
  assert.equal(asked.length, 1);
  assert.match(w.out(), /sign you in to Claude Code in your browser/);
  const signIn = w.calls.find((c) => c.cmd === "/bin/sh")!;
  assert.deepEqual(signIn.args, ["-c", 'CLAUDE_CONFIG_DIR="$HOME/.claude" claude auth login']);
  assert.ok(signIn.env!.PATH.startsWith(path.join(w.home, ".local/bin") + ":"), "a CLI installed a minute ago is found");
});

test("run: a missing prerequisite stops before anything else, exit 1", async () => {
  const w = world();
  w.d.preflight = () => [{ id: "node", ok: false, level: "error", label: "node 22–26", detail: "v20.1.0", fix: "brew install node@24" }];
  const { exitCode, report } = await runSetup(parseArgs([], {}), w.d);
  assert.equal(exitCode, 1);
  assert.equal(report.checks[0].fix, "brew install node@24");
  assert.deepEqual(w.api, []);
});

test("run: an older Chronos still running here (no setup routes) is named, with how to restart it", async () => {
  const w = world();
  const f0 = w.d.fetch;
  w.d.fetch = async (url: string, init: any = {}) => (url.includes("/api/setup/") ? { status: 404, ok: false, json: async () => ({ error: "not found" }) } : f0(url, init));
  const { exitCode, report } = await runSetup(parseArgs(["--no-open"], {}), w.d);
  assert.equal(exitCode, 1);
  const err = report.checks.find((c: any) => c.id === "error");
  assert.match(err.line, /older version/);
  assert.equal(err.fix, "npm run build && launchctl kickstart -k gui/$(id -u)/sh.chronos.daemon");
  assert.equal(w.calls.length, 0, "it says how; it does not restart anything itself");
});

// ───────────── npm run desk ─────────────

test("npm run desk: a one-time link, or the reason there isn't one and the command that fixes it", async () => {
  const repo = fakeRepo();
  assert.equal(readToken({ CHRONOS_ADMIN_TOKEN: "env-tok" }, repo), "env-tok");
  assert.equal(readToken({}, repo), "tok-a");
  assert.equal(readToken({ CHRONOS_HOME: fresh("empty-state") }, repo), null);
  await assert.rejects(mintDeskUrl({ port: 7911, token: null }), (e: any) => e instanceof DeskError && e.fix === "npm run setup");
  await assert.rejects(mintDeskUrl({ port: 7911, token: "t", fetchImpl: async () => { throw new TypeError("fetch failed"); } }), (e: any) => /isn't running on port 7911/.test(e.message));
  await assert.rejects(mintDeskUrl({ port: 7911, token: "t", fetchImpl: async () => ({ status: 403, json: async () => ({}) }) }), (e: any) => /different folder/.test(e.message) && e.fix === "CHRONOS_PORT=7912 npm run setup");
  const seen: any[] = [];
  const r = await mintDeskUrl({ port: 7911, token: "t", fetchImpl: async (u: string, i: any) => { seen.push([u, i.headers["x-mc-admin"]]); return { status: 201, json: async () => ({ code: "C0DE", expires_at: "2026-11-11T00:05:00.000Z" }) }; } });
  assert.deepEqual(r, { url: "http://localhost:7911/desk#pair=C0DE", expiresAt: "2026-11-11T00:05:00.000Z" });
  assert.deepEqual(seen, [["http://localhost:7911/api/pair", "t"]], "the token goes in a header to the daemon, never into the link");
  const spawned: unknown[] = [];
  const fake = (cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return { on() {}, unref() {} }; };
  assert.equal(openInBrowser("http://x/desk#pair=C", { platform: "darwin", spawnImpl: fake }), true);
  assert.equal(openInBrowser("http://x/desk#pair=C", { platform: "win32", spawnImpl: fake }), false);
  assert.deepEqual(spawned, [["open", "http://x/desk#pair=C"]]);
});

// ───────────── install.sh, for real, in bash ─────────────

function installWorld() {
  const root = fresh("install");
  const src = path.join(root, "src-repo");
  const fakebin = path.join(root, "fakebin");
  const npmLog = path.join(root, "npm.log");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(fakebin, { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), '{\n  "name": "getchronos",\n  "version": "0.1.0"\n}\n');
  fs.writeFileSync(path.join(src, "package-lock.json"), '{"lockfileVersion": 3}\n');
  fs.writeFileSync(path.join(src, "README.md"), "hi\n");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).toString();
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(fakebin, "node"), "#!/bin/sh\n[ \"$1\" = -v ] && echo \"${FAKE_NODE_VERSION:-v24.1.0}\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(fakebin, "npm"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(npmLog)}\n[ "$1" = ci ] && mkdir -p node_modules\nexit 0\n`, { mode: 0o755 });
  const dest = path.join(root, "chronos");
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [path.join(REPO, "install.sh"), ...args], {
      env: { PATH: `${fakebin}:/usr/bin:/bin`, HOME: root, CHRONOS_DIR: dest, CHRONOS_REPO_URL: `file://${src}`, CHRONOS_PORT: "1", ...env },
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  // Async when something in THIS process must answer the script (a fake Chronos on a port): spawnSync
  // would block the event loop the server needs.
  const runAsync = (args: string[] = [], extra: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("bash", [path.join(REPO, "install.sh"), ...args], {
        env: { PATH: `${fakebin}:/usr/bin:/bin`, HOME: root, CHRONOS_DIR: dest, CHRONOS_REPO_URL: `file://${src}`, CHRONOS_PORT: "1", ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (code) => resolve({ code, out }));
    });
  const npm = () => (fs.existsSync(npmLog) ? fs.readFileSync(npmLog, "utf8").trim().split("\n") : []);
  return { root, src, dest, run, runAsync, npm, git };
}

test("install.sh: a fresh Mac clones, installs packages and hands its flags to setup; a second run skips the packages", () => {
  const w = installWorld();
  const first = w.run(["--yes", "--json"]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /✓ downloaded Chronos/);
  assert.deepEqual(w.npm(), ["ci --no-audit --no-fund --no-update-notifier --loglevel=error", "run --silent setup -- --yes --json"]);
  const second = w.run();
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /✓ updated .*\n.*✓ packages already installed/s);
  assert.deepEqual(w.npm().slice(2), ["run --silent setup --"], "no second npm ci");
});

test("install.sh: never touches a folder that isn't Chronos, local changes, another branch — or a running Chronos", async () => {
  const w = installWorld();
  assert.equal(w.run().code, 0);
  fs.appendFileSync(path.join(w.dest, "README.md"), "my notes\n");
  const dirty = w.run();
  assert.equal(dirty.code, 1);
  assert.match(dirty.out, /has local changes — not updating it/);
  assert.match(dirty.out, /--force-update/);
  const forced = w.run(["--force-update", "--no-open"]);
  assert.equal(forced.code, 0, forced.out);
  assert.equal(w.npm().at(-1), "run --silent setup -- --no-open", "--force-update is the installer's, not setup's");
  w.git(w.dest, "checkout", "-q", "README.md");
  w.git(w.dest, "checkout", "-q", "-b", "my-feature");
  const branch = w.run();
  assert.equal(branch.code, 1);
  assert.match(branch.out, /is on branch my-feature, not main/);
  w.git(w.dest, "checkout", "-q", "main");

  // A running Chronos: no pull under it, even with a newer commit waiting.
  fs.writeFileSync(path.join(w.src, "NEW.md"), "x\n");
  w.git(w.src, "add", "-A");
  w.git(w.src, "commit", "-q", "-m", "newer");
  const srv = http.createServer((_q, r) => r.end('{"ok":true}'));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const port = String((srv.address() as net.AddressInfo).port);
    const running = await w.runAsync([], { CHRONOS_PORT: port });
    assert.equal(running.code, 0, running.out);
    assert.match(running.out, /Chronos is already running — leaving .* as it is/);
    assert.equal(fs.existsSync(path.join(w.dest, "NEW.md")), false, "not pulled");
  } finally {
    srv.close();
  }

  const other = fresh("not-chronos");
  fs.writeFileSync(path.join(other, "notes.txt"), "mine\n");
  const r = w.run([], { CHRONOS_DIR: other });
  assert.equal(r.code, 1);
  assert.match(r.out, /isn't a Chronos folder — not touching it/);
  assert.deepEqual(fs.readdirSync(other), ["notes.txt"]);
});

test("install.sh: node outside 22–26 stops with the exact fix", () => {
  const w = installWorld();
  const r = w.run([], { FAKE_NODE_VERSION: "v20.11.1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /Chronos needs Node 22–26 \(you have: v20\.11\.1\)/);
  assert.match(r.out, /nvm install 24/, "no brew on this PATH: the nvm route");
  assert.equal(fs.existsSync(w.dest), false, "nothing cloned");
});

// ───────────── the real app build (slow suite) ─────────────

const hasTools = (() => {
  if (process.platform !== "darwin") return false;
  try { execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("build-app.sh stamps the checkout and port into the bundle, and app.swift opens that Desk with that token", { skip: !hasTools ? "no Xcode command-line tools on this machine" : process.env.CHRONOS_TEST_SLOW ? false : "slow suite: npm run test:all", timeout: 600_000 }, () => {
  const home = fresh("apphome-real");
  // A scratch HOME, ad-hoc signing and no session-wide registration: this build is invisible outside it.
  execFileSync("bash", [path.join(REPO, "scripts", "build-app.sh")], { env: { ...process.env, HOME: home, CHRONOS_PORT: "7999", CHRONOS_APP_NO_REGISTER: "1", MC_APP_SIGN_ID: "none-for-a-test" }, stdio: "pipe", timeout: 600_000 });
  const bundle = path.join(home, ".mc", "mc-app.app");
  const key = (k: string) => execFileSync("/usr/bin/plutil", ["-extract", k, "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")]).toString().trim();
  assert.equal(key("ChronosHome"), REPO);
  assert.equal(key("ChronosURL"), "http://localhost:7999");
  assert.equal(key("ChronosSource"), crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, "desktop", "app.swift"))).digest("hex").slice(0, 16));
  assert.ok(fs.existsSync(path.join(home, "Applications", "Chronos.app", "Contents", "MacOS", "mc-app")), "the copy Spotlight can find");
  // --print-config exits before any window: where the token is read from (never the token) and the page.
  const exe = path.join(bundle, "Contents", "MacOS", "mc-app");
  const env = { ...process.env, HOME: home };
  delete (env as Record<string, string | undefined>).CHRONOS_HOME;
  assert.equal(execFileSync(exe, ["--print-config"], { env }).toString(), `token_file=${path.join(REPO, ".admin-token")}\ntarget=http://localhost:7999/desk\n`);
  assert.equal(execFileSync(exe, ["--print-config", "/phone"], { env: { ...env, CHRONOS_HOME: "/tmp/acme" } }).toString(), "token_file=/tmp/acme/.admin-token\ntarget=http://localhost:7999/phone\n");
});
