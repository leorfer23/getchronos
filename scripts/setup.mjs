#!/usr/bin/env node
// `npm run setup` — from a fresh clone to the Desk, signed in, in one command. Safe to run again: a
// running Chronos is reused, a built app is kept, nothing that works is touched.
//
//   1. checks node, the packages and git (bin/host-core.mjs, the same checks `chronos host` runs)
//   2. starts Chronos so it survives a restart (macOS: scripts/install-launchd.mjs, daemon only) — or,
//      with --foreground, waits for you to run `npm start` yourself
//   3. asks Chronos which agent CLIs are installed and signed in, the way its agents will run them
//      (GET /api/setup/status, src/setup-check.ts) — offers to install the missing ones and sign in
//   4. tries each signed-in CLI with one tiny real prompt, all at once (POST /api/setup/smoke/:id)
//   5. prints a checklist: ✓ or ✗ per line, and one command to paste under every ✗ — then, quietly, the
//      optional extras this Mac doesn't have yet, one line each (GET /api/setup/optional)
//   6. opens the Desk: the Chronos app when this Mac can build it, else the browser, signed in
//
// Flags:
//   --yes               install missing CLIs and start sign-ins without asking (agents, scripts)
//   --json              end with a machine-readable report on stdout (everything else goes to stderr)
//   --foreground        install nothing that starts at login; you run `npm start` (and the browser Desk)
//   --no-smoke          skip the test prompts
//   --no-open           don't open the Desk (and don't build the app)
//   --no-app            open the Desk in the browser instead of building the Chronos app
//   --no-install        never install or sign in; just check
//   --replace-existing  take over from a Chronos that was set up from another folder on this Mac
//
// Exit: 0 = Chronos is running and at least one agent CLI is ready; 2 = not ready only because there was
// no terminal to ask in (run again with --yes); 1 = anything else.
//
// No agent jargon on screen: people see "Chronos", "the Desk", "signed in". Lines a person must act on
// start with "HUMAN STEP:" so an agent running this knows what to hand back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { preflight, shellPath } from "../bin/host-core.mjs";
import { DeskError, REPO_DIR, mintDeskUrl, openInBrowser, readToken } from "./open-desk.mjs";

export const DAEMON_LABEL = "sh.chronos.daemon";
export const APP_LABEL = "sh.chronos.app";

/** A failure with the one command that fixes it. */
export class SetupError extends Error {
  constructor(message, fix = null, code = 1) {
    super(message);
    this.fix = fix;
    this.code = code;
  }
}

const FLAGS = ["yes", "json", "foreground", "no-smoke", "no-open", "no-app", "no-install", "replace-existing", "help"];

/**
 * argv → options. `npm run setup --yes` (no `--`) hands npm the flag, which npm exposes as
 * npm_config_yes=true; the positive flags are read from there too, so both spellings work.
 */
export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const has = (f) => argv.includes(`--${f}`) || (!f.startsWith("no-") && env[`npm_config_${f.replace(/-/g, "_")}`] === "true");
  const unknown = argv.filter((a) => a.startsWith("--") && !FLAGS.includes(a.slice(2)));
  return {
    yes: has("yes"),
    json: has("json"),
    foreground: has("foreground"),
    smoke: !has("no-smoke"),
    open: !has("no-open"),
    app: !has("no-app"),
    install: !has("no-install"),
    replaceExisting: has("replace-existing"),
    help: has("help") || argv.includes("-h"),
    unknown,
  };
}

// ───────────────────────────── the world (injectable) ─────────────────────────────

/** Run a command; never throws. `inherit` hands it this terminal (an interactive sign-in). */
export function defaultRun(cmd, args, o = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: o.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ code: null, stdout: "", stderr: String(e?.message ?? e) });
    }
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    const timer = o.timeoutMs ? setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, o.timeoutMs) : null;
    child.on("error", (e) => { if (timer) clearTimeout(timer); finish({ code: null, stdout: out, stderr: err || e.message }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); finish({ code, stdout: out, stderr: err }); });
  });
}

function defaultAsk(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(!/^\s*n/i.test(a)); });
  });
}

export function realDeps(env = process.env) {
  return {
    env,
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 501,
    repoDir: REPO_DIR,
    node: process.execPath,
    run: defaultRun,
    fetch: globalThis.fetch,
    ask: defaultAsk,
    interactive: !!process.stdin.isTTY,
    out: process.stdout,
    err: process.stderr,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    openUrl: (url) => openInBrowser(url),
    preflight: (repoDir) => preflight({ pkgRoot: repoDir }),
  };
}

// ───────────────────────────── small pieces ─────────────────────────────

const same = (a, b) => {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return !!a && !!b && real(a) === real(b);
};
const quote = (p, home) => shellPath(p, home);

/** Which checkout a loaded LaunchAgent runs, from `launchctl print` (its working directory, else a `…/dist/index.js` argument). */
export function launchdOwner(printOut) {
  const wd = /^\s*working directory = (.+)$/m.exec(printOut)?.[1]?.trim();
  if (wd) return wd;
  const arg = /^\s*(\/\S+)\/dist\/index\.js\s*$/m.exec(printOut)?.[1];
  return arg ?? null;
}

/** Is dist/ missing or older than the newest file under src/? launchd runs dist/index.js, so a stale build is old code. */
export function distStale(repoDir) {
  let built;
  try { built = fs.statSync(path.join(repoDir, "dist", "index.js")).mtimeMs; } catch { return true; }
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(p)) return true; } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && fs.statSync(p).mtimeMs > built) return true;
    }
    return false;
  };
  try { return walk(path.join(repoDir, "src")); } catch { return true; }
}

/** Ask the daemon on `port` who it is: "ours" (takes this folder's key), "other" (a Chronos from elsewhere), "foreign" (not Chronos), "down". */
export async function probeDaemon({ port, token, fetchImpl }) {
  let r;
  try {
    r = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { headers: token ? { "x-mc-admin": token } : {}, signal: AbortSignal.timeout(3000) });
  } catch {
    return "down";
  }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!j || j.ok !== true) return "foreign";
  // Public liveness is { ok: true }; the operator's own token also gets the rollup (api.ts /health).
  return token && ("operational" in j || "deploy" in j) ? "ours" : "other";
}

/** A spinner on a terminal, one plain line otherwise. `stop()` clears it. */
function spinner(stream, text, now) {
  if (!stream.isTTY) {
    stream.write(`  … ${text}\n`);
    return { stop() {} };
  }
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const t0 = now();
  let i = 0;
  const draw = () => stream.write(`\r\x1b[2K  ${frames[i++ % frames.length]} ${text} ${((now() - t0) / 1000).toFixed(1)} s`);
  draw();
  const timer = setInterval(draw, 100);
  return { stop() { clearInterval(timer); stream.write("\r\x1b[2K"); } };
}

// ───────────────────────────── the steps ─────────────────────────────

/**
 * Chronos running on `port`, from this folder. Reuses one that already answers with this folder's key;
 * refuses a Chronos from another folder (on the port, or the one launchd starts at login) unless
 * --replace-existing — a second clone must never quietly take over the first one's daemon.
 */
export async function ensureDaemon(ctx) {
  const { d, opts, port } = ctx;
  const say = ctx.say;
  const probe = () => probeDaemon({ port, token: readToken(d.env, d.repoDir), fetchImpl: d.fetch });
  const state = await probe();
  if (state === "ours") return { how: "reused" };
  if (state === "other") throw new SetupError(`Another Chronos is already running on port ${port}, set up from a different folder.`, `CHRONOS_PORT=${port + 1} npm run setup`);
  if (state === "foreign") throw new SetupError(`Port ${port} is taken by another program.`, `CHRONOS_PORT=${port + 1} npm run setup`);

  if (opts.foreground || d.platform !== "darwin") {
    say(`  Start Chronos in a second terminal, in this folder:  npm start`);
    const waitMs = d.interactive ? 180_000 : 15_000;
    if (await waitHealthy(ctx, waitMs, "Waiting for Chronos to start")) return { how: "foreground" };
    throw new SetupError("Chronos didn't start.", `cd ${quote(d.repoDir, d.home)} && npm start`);
  }

  // At login, launchd starts one Chronos per Mac. If it is another folder's, stop and say so.
  const loaded = await d.run("/bin/launchctl", ["print", `gui/${d.uid}/${DAEMON_LABEL}`]);
  const owner = loaded.code === 0 ? launchdOwner(loaded.stdout) : null;
  if (owner && !same(owner, d.repoDir) && !opts.replaceExisting) {
    throw new SetupError(`Chronos from ${owner} already starts at login on this Mac — not replacing it.`, `cd ${quote(owner, d.home)} && npm run setup   # or here: npm run setup -- --replace-existing`);
  }
  const env = { ...d.env, CHRONOS_PORT: String(port), CHRONOS_LOG_DIR: d.env.CHRONOS_LOG_DIR ?? d.repoDir };
  if (distStale(d.repoDir)) {
    const s = spinner(ctx.stream, "Building Chronos", d.now);
    const b = await d.run(d.node, [path.join(d.repoDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: d.repoDir, env, timeoutMs: 600_000 });
    s.stop();
    if (!fs.existsSync(path.join(d.repoDir, "dist", "index.js"))) throw new SetupError(`Building Chronos failed: ${lastLine(b.stdout + b.stderr)}`, "npm run build");
  }
  const s = spinner(ctx.stream, "Starting Chronos", d.now);
  const r = await d.run(d.node, [path.join(d.repoDir, "scripts", "install-launchd.mjs")], { cwd: d.repoDir, env, timeoutMs: 60_000 });
  s.stop();
  if (r.code !== 0) throw new SetupError(`Couldn't set Chronos to start at login: ${lastLine(r.stderr || r.stdout)}`, `npm start   # runs it in this terminal instead`);
  if (await waitHealthy(ctx, 60_000, "Waiting for Chronos to answer")) return { how: "launchd" };
  throw new SetupError("Chronos was started but isn't answering.", `tail -20 ${quote(path.join(env.CHRONOS_LOG_DIR, "chronos.err.log"), d.home)}`);
}

async function waitHealthy(ctx, ms, text) {
  const { d, port } = ctx;
  const s = spinner(ctx.stream, text, d.now);
  const until = d.now() + ms;
  try {
    while (d.now() < until) {
      const st = await probeDaemon({ port, token: readToken(d.env, d.repoDir), fetchImpl: d.fetch });
      if (st === "ours") return true;
      if (st === "other" || st === "foreign") return false;
      await d.sleep(250);
    }
    return false;
  } finally {
    s.stop();
  }
}

const lastLine = (s) => String(s ?? "").trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "";

/** The daemon's API with this folder's key. */
async function api(ctx, method, p, timeoutMs = 30_000) {
  const r = await ctx.d.fetch(`http://127.0.0.1:${ctx.port}/api${p}`, {
    method,
    headers: { "x-mc-admin": readToken(ctx.d.env, ctx.d.repoDir) ?? "", "content-type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  // A Chronos that answers but has no setup routes is an older build of this folder still running.
  if (r.status === 404 && p.startsWith("/setup/")) {
    throw new SetupError("The Chronos running here is an older version, from before these checks — restart it to load this one.", ctx.d.platform === "darwin" ? "npm run build && launchctl kickstart -k gui/$(id -u)/sh.chronos.daemon" : "stop it, then: npm start");
  }
  if (!r.ok) throw new SetupError(`Chronos answered ${r.status} to ${p}${j?.error ? `: ${j.error}` : ""}`, "npm run setup");
  return j;
}

const APP_NAME = { claude: "Claude", codex: "ChatGPT", "cursor-agent": "Cursor", grok: "Grok" };

/** What setup offers to do: install claude when missing, any other CLI whose desktop app is here; sign in to claude, codex and whatever it installs. */
export function planActions(clis) {
  const install = clis.filter((c) => !c.installed && c.can_install && (c.id === "claude" || c.app));
  const signIn = clis.filter((c) => c.installed && c.loggedIn === false && (c.id === "claude" || c.id === "codex"));
  return { install, signIn };
}

const HUMAN_SIGN_IN = {
  claude: 'a Claude page opens in your browser — sign in with your Claude account and click "Authorize"',
  codex: "a ChatGPT page opens in your browser — sign in with your ChatGPT account and allow Codex",
  "cursor-agent": "a Cursor page opens in your browser — sign in and confirm the login",
  grok: "a grok.com page opens in your browser — sign in and approve the CLI",
  opencode: "follow the provider sign-in that opens in your browser",
};

/** Install what is missing, then sign in — after one yes (or --yes). Returns what was skipped for want of a terminal. */
async function installAndSignIn(ctx, status) {
  const { d, opts, say } = ctx;
  if (!opts.install) return { skipped: false };
  let { install, signIn } = planActions(status.clis);
  if (!install.length && !signIn.length) return { skipped: false };
  const names = [...new Set([...install, ...signIn].map((c) => c.label))];
  const lines = [
    ...install.map((c) => `install ${c.label}${c.app ? ` — you use ${APP_NAME[c.id] ?? c.label}; it runs on the same subscription` : ""}`),
    `sign you in to ${names.join(" and ")} in your browser`,
  ];
  if (!opts.yes) {
    if (!d.interactive) {
      say(`  Not installing or signing in: there's no terminal to ask in. To do it: npm run setup -- --yes`);
      return { skipped: true };
    }
    say(`  To finish, setup can:\n${lines.map((l) => `    • ${l}`).join("\n")}`);
    if (!(await d.ask("  Go ahead? [Y/n] "))) return { skipped: false };
  }
  for (const c of install) {
    const s = spinner(ctx.stream, `Installing ${c.label}`, d.now);
    const r = await api(ctx, "POST", `/setup/install/${c.id}`, 300_000).catch((e) => ({ ok: false, log_tail: e.message }));
    s.stop();
    say(r.ok ? `  ✓ installed ${c.label}` : `  ✗ installing ${c.label} failed:\n${String(r.log_tail ?? "").split("\n").slice(-3).map((l) => `      ${l}`).join("\n")}`);
  }
  if (install.length) {
    const fresh = await api(ctx, "GET", "/setup/status?fresh=1");
    signIn = fresh.clis.filter((c) => c.installed && c.loggedIn === false && (c.id === "claude" || c.id === "codex" || install.some((i) => i.id === c.id)));
  }
  for (const c of signIn) {
    if (d.interactive) {
      // In the terminal: the CLI's own sign-in, which can take a pasted code if the browser can't call back.
      ctx.human(`Sign in to ${c.label}: ${HUMAN_SIGN_IN[c.id]}.`);
      const bin = c.path ? path.dirname(c.path.replace(/^~(?=\/)/, d.home)) : null;
      await d.run("/bin/sh", ["-c", c.login], { inherit: true, env: { ...d.env, PATH: [bin, d.env.PATH].filter(Boolean).join(":") } });
    } else {
      ctx.human(`Sign in to ${c.label}: ${HUMAN_SIGN_IN[c.id]}. Setup waits up to 3 minutes.`);
      const s = spinner(ctx.stream, `Waiting for the ${c.label} sign-in`, d.now);
      const r = await api(ctx, "POST", `/setup/login/${c.id}`, 200_000).catch((e) => ({ ok: false, message: e.message }));
      s.stop();
      if (!r.ok) say(`  ✗ ${c.label} sign-in didn't finish: ${r.message ?? ""}`);
    }
  }
  return { skipped: false };
}

/** Lines for the agent CLIs: one per CLI that is here or should be, plus one for the optional rest. */
export function cliChecks(clis, smokes) {
  const checks = [];
  const optional = [];
  for (const c of clis) {
    const ver = c.version ? ` ${c.version}` : "";
    const sm = smokes[c.id];
    if (!c.installed) {
      if (c.id === "claude" || c.app) checks.push({ id: c.id, ok: false, ready: false, line: `${c.label} — not installed${c.app ? ` (you have the ${APP_NAME[c.id]} app; it runs on the same subscription)` : ""}`, fix: c.install });
      else optional.push(c.label);
      continue;
    }
    if (c.loggedIn === false) { checks.push({ id: c.id, ok: false, ready: false, line: `${c.label}${ver} — not signed in`, fix: c.login }); continue; }
    if (sm && !sm.ok) { checks.push({ id: c.id, ok: false, ready: false, line: `${c.label}${ver} — a test prompt failed: ${sm.error ?? "no answer"}`, fix: c.try }); continue; }
    const who = c.authDetail ?? (c.loggedIn ? "signed in" : "installed");
    checks.push({ id: c.id, ok: true, ready: true, line: `${c.label}${ver} — ${who}${sm ? `, answered in ${(sm.ms / 1000).toFixed(1)} s` : ""}`, fix: null });
  }
  if (optional.length) checks.push({ id: "optional", ok: true, ready: false, info: true, line: `Also works with ${optional.join(", ").replace(/, ([^,]*)$/, " and $1")} — not installed, optional`, fix: null });
  return checks;
}

/** The native Desk: build it when the source or its target changed, start-at-login once, open it. */
export async function ensureApp(ctx) {
  const { d, port } = ctx;
  const tools = await d.run("/usr/bin/xcode-select", ["-p"]);
  const swiftc = tools.code === 0 ? await d.run("/usr/bin/xcrun", ["--find", "swiftc"]) : tools;
  if (tools.code !== 0 || swiftc.code !== 0) return { ok: false, why: "this Mac has no developer tools to build it with", fix: "xcode-select --install   # then: npm run setup" };
  const bundle = path.join(d.home, ".mc", "mc-app.app");
  const plist = path.join(bundle, "Contents", "Info.plist");
  const key = async (k) => { const r = await d.run("/usr/bin/plutil", ["-extract", k, "raw", "-o", "-", plist]); return r.code === 0 ? r.stdout.trim() : null; };
  const stateDir = d.env.CHRONOS_HOME || d.repoDir;
  const src = path.join(d.repoDir, "desktop", "app.swift");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(src)).digest("hex").slice(0, 16);
  const built = fs.existsSync(path.join(bundle, "Contents", "MacOS", "mc-app"));
  const stamped = built ? await key("ChronosHome") : null;
  if (stamped && !same(stamped, stateDir) && !ctx.opts.replaceExisting) {
    return { ok: false, why: `the Chronos app on this Mac belongs to ${stamped}`, fix: "npm run setup -- --replace-existing" };
  }
  const fresh = built && stamped && (await key("ChronosSource")) === hash && (await key("ChronosURL")) === `http://localhost:${port}`;
  if (!fresh) {
    const s = spinner(ctx.stream, "Building the Chronos app (first time only)", d.now);
    const r = await d.run("/bin/bash", [path.join(d.repoDir, "scripts", "build-app.sh")], { cwd: d.repoDir, env: { ...d.env, CHRONOS_PORT: String(port) }, timeoutMs: 600_000 });
    s.stop();
    if (r.code !== 0) return { ok: false, why: `building it failed (${lastLine(r.stderr || r.stdout)})`, fix: "bash scripts/build-app.sh" };
  }
  const agent = path.join(d.home, "Library", "LaunchAgents", `${APP_LABEL}.plist`);
  if (!fs.existsSync(agent)) {
    // Bootstrapping it starts it (RunAtLoad) — that is the opening.
    const r = await d.run(d.node, [path.join(d.repoDir, "scripts", "install-launchd.mjs"), "--only", APP_LABEL], { cwd: d.repoDir, env: { ...d.env, CHRONOS_PORT: String(port), CHRONOS_LOG_DIR: d.env.CHRONOS_LOG_DIR ?? d.repoDir }, timeoutMs: 60_000 });
    if (r.code === 0) return { ok: true, built: !fresh };
  }
  const o = await d.run("/usr/bin/open", [bundle]);
  return o.code === 0 ? { ok: true, built: !fresh } : { ok: false, why: `it didn't open (${lastLine(o.stderr)})`, fix: `open ${quote(bundle, d.home)}` };
}

// ── PARITY ────────────────────────────────────────────────────────────────────────────────────────────
// "Same tools as your own Claude / ChatGPT" (GET /api/setup/parity, src/parity.ts): do the agents get
// the person's own MCP servers, plugins and logins? Informational — it never fails setup, and an older
// daemon without the route (or any error) prints nothing.
async function parityCheck(ctx) {
  let report;
  try {
    report = await api(ctx, "GET", "/setup/parity", 15_000);
  } catch {
    return null;
  }
  const lines = Array.isArray(report?.lines) ? report.lines.map(String) : [];
  if (!lines.length) return null;
  const [head, ...rest] = lines;
  const detail = rest.map((l) => l.trim()).filter(Boolean);
  return { id: "parity", ok: report.ok !== false, info: report.ok !== false ? false : true, line: [head, ...detail].join("\n      "), fix: null };
}

// ── OPTIONAL ──────────────────────────────────────────────────────────────────────────────────────────
// What this Mac could add (GET /api/setup/optional, src/setup-optional.ts): a nicer voice, speech-to-text,
// Telegram, the phone… None is needed to start. Informational like parity: it never fails setup, and an
// older daemon without the route (or any error) prints nothing.
async function optionalExtras(ctx) {
  let r;
  try {
    r = await api(ctx, "GET", "/setup/optional", 15_000);
  } catch {
    return null;
  }
  const items = (Array.isArray(r?.items) ? r.items : [])
    .filter((i) => i && typeof i.id === "string" && typeof i.label === "string" && typeof i.how === "string")
    .map((i) => ({ id: i.id, label: i.label, status: i.status, how: i.how, ...(i.default ? { default: i.default } : {}), ...(i.note ? { note: i.note } : {}) }));
  if (!items.length) return null;
  return { on: items.filter((i) => i.status === "on").length, total: items.length, items };
}

/** One line per extra that isn't on, with its one command or where to turn it on; nothing when all are on. */
export function optionalLines(o) {
  const todo = (o?.items ?? []).filter((i) => i.status !== "on");
  if (!todo.length) return [];
  return [`Optional — ${o.on} of ${o.total} on; none is needed to start:`, ...todo.map((i) => `  · ${i.label} — ${i.how}`)];
}

/** The whole run. Returns the exit code and the report --json prints; never calls process.exit. */
export async function runSetup(opts, d = realDeps()) {
  const t0 = d.now();
  const stream = opts.json ? d.err : d.out;
  const say = (s) => stream.write(s + "\n");
  const humanSteps = [];
  const port = Number(d.env.CHRONOS_PORT ?? 7777);
  const ctx = { d, opts, port, stream, say, human: (s) => { humanSteps.push(s); say(`HUMAN STEP: ${s}`); } };
  const checks = [];
  const add = (c) => { checks.push(c); say(`  ${c.info ? "·" : c.ok ? "✓" : "✗"} ${c.line}${c.fix ? `\n      ${c.fix}` : ""}`); };
  let daemon = { ok: false, how: null };
  let desk = { opened: null, reopen: "npm run desk" };
  let skipped = false;
  let optional = null;
  let exitCode = 1;

  say("Setting up Chronos");
  try {
    const pre = d.preflight(d.repoDir);
    if (pre.some((c) => !c.ok && c.level === "error")) {
      for (const c of pre.filter((c) => !c.ok)) add({ id: `prereq:${c.id}`, ok: false, line: `${c.label} — ${c.detail}`, fix: c.fix ?? null });
      throw new SetupError("Fix the line above, then run npm run setup again.", null);
    }
    add({ id: "prereqs", ok: true, line: `Node ${process.versions.node}, its packages and git`, fix: null });

    daemon = { ok: true, ...(await ensureDaemon(ctx)) };
    add({ id: "daemon", ok: true, line: `Chronos is running — http://localhost:${port}${daemon.how === "launchd" ? ", and starts again when you log in" : daemon.how === "foreground" ? " (in your other terminal; it stops when that closes)" : ""}`, fix: null });

    let status = await api(ctx, "GET", "/setup/status?fresh=1");
    ({ skipped } = await installAndSignIn(ctx, status));
    status = await api(ctx, "GET", "/setup/status?fresh=1");

    const smokes = {};
    if (opts.smoke) {
      const ids = status.clis.filter((c) => c.installed && c.loggedIn !== false).map((c) => c.id);
      if (ids.length) {
        const s = spinner(stream, `Trying ${ids.length === 1 ? "it" : `all ${ids.length}`} with a test prompt`, d.now);
        await Promise.all(ids.map(async (id) => { smokes[id] = await api(ctx, "POST", `/setup/smoke/${id}`, 90_000).catch((e) => ({ ok: false, ms: 0, error: e.message })); }));
        s.stop();
      }
    }
    for (const c of cliChecks(status.clis, smokes)) add(c);
    const parity = await parityCheck(ctx);
    if (parity) add(parity);

    const ready = checks.some((c) => c.ready);
    if (!ready) add({ id: "agents", ok: false, line: "No agent CLI is ready yet — Chronos needs at least one to do any work", fix: skipped ? "npm run setup -- --yes" : checks.find((c) => !c.ok && c.fix && c.id !== "error")?.fix ?? "npm run setup" });
    exitCode = ready ? 0 : skipped ? 2 : 1;

    optional = await optionalExtras(ctx);
    for (const l of optionalLines(optional)) say(`  ${l}`);

    // Last: the Desk itself.
    if (opts.open) {
      let appWhy = null;
      if (d.platform === "darwin" && !opts.foreground && opts.app) {
        const a = await ensureApp(ctx);
        if (a.ok) {
          desk = { opened: "app", reopen: "Chronos is in your Applications folder" };
          add({ id: "desk", ok: true, line: "The Chronos app — opening it now", fix: null });
        } else appWhy = a;
      }
      if (!desk.opened) {
        try {
          const { url } = await mintDeskUrl({ port, token: readToken(d.env, d.repoDir), fetchImpl: d.fetch });
          const opened = d.openUrl(url);
          desk = { opened: opened ? "browser" : null, reopen: "npm run desk" };
          add({ id: "desk", ok: true, line: opened ? "The Desk — opening it in your browser, signed in" : `The Desk — open this link (works once, for 5 minutes): ${url}`, fix: null });
        } catch (e) {
          if (!(e instanceof DeskError)) throw e;
          add({ id: "desk", ok: false, line: e.message, fix: e.fix });
        }
        if (appWhy) say(`  · For the Chronos app instead of a browser tab (${appWhy.why}): ${appWhy.fix}`);
      }
    }
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    add({ id: "error", ok: false, line: e.message, fix: e.fix });
    exitCode = e.code;
  }

  const secs = ((d.now() - t0) / 1000).toFixed(1);
  const tail = exitCode === 0 ? `${desk.opened === "app" ? "Chronos is in your Applications folder" : "Open the Desk any time: npm run desk"}.` : exitCode === 2 ? "Run it again with --yes to finish: npm run setup -- --yes" : "Fix the ✗ lines above, then run npm run setup again.";
  say(`Done in ${secs} s. ${tail}`);
  const report = {
    ok: exitCode === 0,
    exit: exitCode,
    elapsed_ms: d.now() - t0,
    daemon: { ok: daemon.ok, how: daemon.how, url: `http://localhost:${port}` },
    checks: checks.map((c) => ({ id: c.id, ok: c.ok, ...(c.info ? { info: true } : {}), line: c.line, fix: c.fix ?? null })),
    human_steps: humanSteps,
    optional,
    desk,
  };
  if (opts.json) d.out.write(JSON.stringify(report, null, 2) + "\n");
  return { exitCode, report };
}

const USAGE = `npm run setup [-- flags]   start Chronos, check your agent CLIs, open the Desk
  --yes  --json  --foreground  --no-smoke  --no-open  --no-app  --no-install  --replace-existing`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opts = parseArgs();
  if (opts.help) { console.log(USAGE); process.exit(0); }
  if (opts.unknown.length) { console.error(`Unknown: ${opts.unknown.join(" ")}\n${USAGE}`); process.exit(2); }
  const { exitCode } = await runSetup(opts);
  process.exit(exitCode);
}
