#!/usr/bin/env node
/**
 * `getchronos` — the one command a computer needs (HOSTS.md → Setup).
 *
 *   getchronos host join <brain-url> <code> [--no-launchd]   join a brain, install the LaunchAgent
 *   getchronos host run                                      what the LaunchAgent runs
 *   getchronos host status | doctor                          link state · the setup checklist
 *   getchronos host update                                   update this host to the latest by hand
 *   getchronos host uninstall [--purge]                      remove the LaunchAgent (and ~/.chronos-host)
 *
 * From a clone this is `npm run host -- <cmd>`; from npm it is `npx getchronos host <cmd>`.
 *
 * This file stays dependency-free and runs the preflight (host-core.mjs) BEFORE loading anything
 * else: the failures it catches — a node outside the supported range, a half-finished `npm ci`, a git
 * that cannot fetch over https — are exactly the ones that otherwise crash with a stack trace about
 * a module nobody asked for. Only then does it load the host: `dist/` when built (the npm package),
 * else `src/` through tsx in this same process (a clone), so launchd's signals reach the host itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatChecks, installKind, preflight, uninstall } from "./host-core.mjs";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostHome = process.env.CHRONOS_HOST_HOME || path.join(os.homedir(), ".chronos-host");

const USAGE = `usage: getchronos host <command>

  join <brain-url> <code> [--no-launchd]   join a brain (the Desk → Computers → + Add gives you this line)
  run                                      connect and stay connected (what the LaunchAgent runs)
  status                                   this host's credential and live link state
  doctor                                   the setup checklist
  update                                   update this host now (the Desk's Update button does the same)
  uninstall [--purge]                      stop + remove the LaunchAgent; --purge also deletes ${hostHome}`;

/**
 * Which failed checks stop a command. `run` is what launchd restarts forever: it refuses only what
 * would crash anyway (missing or unloadable modules). A node outside the tested range or a broken git
 * is logged loudly but does not take a working host down after a `brew upgrade`.
 */
const BLOCKING = {
  join: () => true,
  update: () => true,
  run: (c) => c.id === "deps" || c.id.startsWith("native:"),
  status: (c) => c.id === "deps",
  doctor: (c) => c.id === "deps",
};

function appDirFor(kind) {
  return kind === "npm" ? path.join(hostHome, "app") : pkgRoot;
}

async function delegate(args) {
  // index.ts reads process.argv.slice(2) and exits when its command is done.
  const dist = path.join(pkgRoot, "dist", "hostd", "index.js");
  if (fs.existsSync(dist)) {
    process.argv = [process.execPath, dist, ...args];
    await import(pathToFileURL(dist).href);
    return;
  }
  const src = path.join(pkgRoot, "src", "hostd", "index.ts");
  const { register } = await import(import.meta.resolve("tsx/esm/api"));
  register();
  process.argv = [process.execPath, src, ...args];
  await import(pathToFileURL(src).href);
}

async function main(argv) {
  const [scope, cmd, ...rest] = argv;
  if (scope === "--version" || scope === "-v") {
    console.log(JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version);
    return 0;
  }
  if (scope !== "host" || !cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return scope && scope !== "help" && scope !== "--help" && cmd !== "help" && cmd !== "--help" ? 2 : 0;
  }
  const kind = installKind(pkgRoot, hostHome);
  if (cmd === "uninstall") {
    const r = uninstall({ hostHome, purge: rest.includes("--purge") });
    for (const d of r.done) console.log(`✓ ${d}`);
    if (r.left.length) console.log("left in place:");
    for (const l of r.left) console.log(`  · ${l}`);
    return 0;
  }
  const checks = preflight({ pkgRoot, appDir: appDirFor(kind) });
  if (cmd === "preflight") {
    // Internal: `update` runs the candidate's own preflight, under this node, before swapping it in.
    if (rest.includes("--json")) console.log(JSON.stringify(checks));
    else console.log(formatChecks(checks));
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  const blocks = BLOCKING[cmd];
  if (!blocks) {
    console.error(`unknown command: host ${cmd}\n\n${USAGE}`);
    return 2;
  }
  const failed = checks.filter((c) => !c.ok);
  const fatal = failed.filter(blocks);
  // doctor prints these same checks at the top of its own checklist; everything else says them here.
  if (failed.length && (cmd !== "doctor" || fatal.length)) console.error(formatChecks(cmd === "doctor" ? checks : failed));
  if (fatal.length) {
    console.error(`✗ host ${cmd}: fix the ${fatal.length === 1 ? "line" : "lines"} above first (each "fix:" is one command to paste)`);
    return 1;
  }
  await delegate([cmd, ...rest]);
  return null; // the host entry exits by itself
}

main(process.argv.slice(2)).then(
  (code) => { if (code != null) process.exit(code); },
  (e) => { console.error(`✗ ${e?.stack ?? e}`); process.exit(1); },
);
