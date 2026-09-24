#!/usr/bin/env node
/**
 * `chronos host` — a Mac that runs agents for a brain elsewhere (HOSTS.md).
 *
 *   npm run host -- join <brain-url> <code>   exchange a join code for a credential + LaunchAgent
 *   npm run host -- run                       connect and stay connected (what the LaunchAgent runs)
 *   npm run host -- status                    this host's credential and live link state
 *   npm run host -- doctor                    the setup checklist, locally
 *   npm run host -- update                    update this host now (the Desk's Update does the same)
 *
 * `npm run host` and `npx getchronos host` both enter through bin/getchronos.mjs, which runs the
 * dependency-free preflight before this file (and its imports) are loaded at all.
 *
 * Phase 2: the link, hello/vitals/capabilities, and the loopback `mc` forwarder. Phase 3: terminals
 * (terminals.ts) — PTYs spawned from a SpawnSpec, kept alive across link drops. Headless runs on a
 * host are Phase 5; the dispatch table answers those frames with an error.
 */
import "./env.js"; // FIRST: loads ~/.chronos-host/.secrets before config.ts evaluates
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { HOST_HOME, HOST_SECRETS } from "./env.js";
import { HOST_LABEL, join } from "./join.js";
import { HostLink } from "./link.js";
import { startForwarder } from "./forwarder.js";
import { buildHello, checklist, formatChecklist, hostRoots, probeClis, profiles, sampleHostVitals, scanCheckouts } from "./inventory.js";
import { VITALS_EVERY_MS } from "../machine.js";
import { CONFIG } from "../config.js";
import { REPO_ROOT } from "../repo-root.js";
import { HostTerminals } from "./terminals.js";
import { hostBackends } from "./backends.js";
import { hostDeny, hostBuild, chronosVersion } from "./inventory.js";
import { spawn } from "node:child_process";
import { decodeJoinCode } from "../hostlink/join.js";
import { checkGit, checkDeps, shellPath } from "../../bin/host-core.mjs";
import { defaultRunner, detectInstall, installForJoin, kickstart, launchdPid, npmCliFor, runUpdate } from "./update.js";
import { writeHostPlist } from "./join.js";
import type { UpdateFrame, UpdateStatus, UpdateTarget } from "../hostlink/wire.js";

const env = (k: string) => (process.env[k] ?? "").trim();
const brains = () => env("CHRONOS_HOST_BRAINS").split(",").map((s) => s.trim()).filter(Boolean);
const mcPort = () => Number(env("CHRONOS_HOST_MC_PORT") || 7777);
/**
 * Ports the forwarder tries, in order. An explicit CHRONOS_HOST_MC_PORT is the only one. Otherwise
 * 7777 first (what `mc` defaults to), then a small fixed range: a Mac that also runs its own Chronos
 * daemon already owns 7777, and an agent's MC_API pointing at THAT daemon talks to the wrong brain
 * (first contact, 2026-09-24: `mc state done` → 404 from a months-old local install). Fixed, not
 * random, so `status` can find the process again.
 */
const mcPortCandidates = () => (env("CHRONOS_HOST_MC_PORT") ? [mcPort()] : [7777, ...Array.from({ length: 10 }, (_, i) => 7787 + i)]);
const plistPath = () => path.join(process.env.HOME ?? "", "Library", "LaunchAgents", `${HOST_LABEL}.plist`);
const secretsMode = () => { try { return fs.statSync(HOST_SECRETS).mode; } catch { return null; } };

async function cmdJoin(args: string[]): Promise<number> {
  const noLaunchd = args.includes("--no-launchd");
  const [url, code] = args.filter((a) => !a.startsWith("--"));
  if (!url || !code) {
    console.error("usage: npm run host -- join <brain-url> <code> [--no-launchd]");
    return 2;
  }
  // `npx getchronos host join` runs from npm's cache, which npm prunes at will: install this same
  // version into ~/.chronos-host/app first and hand the join to that copy, so the LaunchAgent points
  // at a path that stays (HOSTS.md → Setup; update.ts installForJoin).
  const inst = detectInstall(REPO_ROOT, HOST_HOME);
  if (inst.kind === "ephemeral") {
    if (!decodeJoinCode(code)) { console.error("✗ join failed: that is not a Chronos join code (expected CHR1-…)"); return 1; }
    console.log(`installing getchronos ${chronosVersion()} into ${HOST_HOME}/app (npx's copy is temporary)…`);
    let entry: string;
    try {
      entry = await installForJoin(chronosVersion(), { hostHome: HOST_HOME, log: (s) => console.log(s) });
    } catch (e: any) {
      console.error(`✗ install failed: ${e?.message ?? e}`);
      return 1;
    }
    return await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [entry, "host", "join", ...args], { stdio: "inherit" });
      child.on("exit", (c) => resolve(c ?? 1));
      child.on("error", (e) => { console.error(`✗ ${e.message}`); resolve(1); });
    });
  }
  try {
    const r = await join({ url, code, hostHome: HOST_HOME, noLaunchd });
    // The token itself is never printed: it is in the 600 file and nowhere else.
    console.log(`✓ joined as ${r.host_id}`);
    console.log(`  credential → ${r.secretsFile} (mode 600)`);
    console.log(`  brains     → ${r.brains.join(", ")}`);
    console.log(r.plistFile ? `  LaunchAgent → ${r.plistFile} (loaded; starts at login)` : `  LaunchAgent skipped — run it yourself: node ${shellPath(path.join(REPO_ROOT, "bin", "getchronos.mjs"))} host run`);
    return 0;
  } catch (e: any) {
    console.error(`✗ join failed: ${e?.message ?? e}`);
    return 1;
  }
}

async function cmdRun(): Promise<number> {
  const id = env("CHRONOS_HOST_ID"), token = env("CHRONOS_HOST_TOKEN");
  if (!id || !token || !brains().length) {
    console.error(`[host] not joined — ${HOST_SECRETS} has no CHRONOS_HOST_ID/TOKEN/BRAINS. Run: npm run host -- join <brain-url> <code>`);
    return 1;
  }
  const mode = secretsMode();
  if (mode != null && mode & 0o077) console.warn(`[host] ${HOST_SECRETS} is readable by others (mode ${(mode & 0o777).toString(8)}) — chmod 600 it`);
  // PTYs live in this process, not in the link: a dropped link must not take a terminal with it.
  const terminals = new HostTerminals({
    root: REPO_ROOT,
    profiles: () => CONFIG.profiles,
    checkouts: () => scanCheckouts(),
    deny: () => hostDeny(),
    autoClone: env("CHRONOS_HOST_AUTO_CLONE") === "1",
    cloneRoot: () => hostRoots()[0] ?? null,
    backends: hostBackends(),
    mcPort: mcPort(),
  });
  const cf = env("CF_ACCESS_CLIENT_ID") && env("CF_ACCESS_CLIENT_SECRET") ? { id: env("CF_ACCESS_CLIENT_ID"), secret: env("CF_ACCESS_CLIENT_SECRET") } : null;
  const link = new HostLink({
    brains: brains(),
    hostId: id,
    token,
    fp: env("CHRONOS_HOST_CERT_FP") || null,
    cfAccess: cf,
    hello: async () => ({ ...(await buildHello(id)), live: terminals.live() }),
    terminals,
    vitals: sampleHostVitals,
    vitalsMs: VITALS_EVERY_MS,
    rpc: {
      inventory: async () => ({ clis: await probeClis(), profiles: profiles(), checkouts: await scanCheckouts() }),
      doctor: () => runDoctor(),
      drop: (a) => terminals.drop(a as Parameters<HostTerminals["drop"]>[0]),
      worktree: (a) => terminals.claimWorktree(a as Parameters<HostTerminals["claimWorktree"]>[0]),
    },
  });
  link.on("online", () => console.log(`[host] ${id} online via ${link.url}`));
  // The brain's policy for this host: an extra veto next to CHRONOS_HOST_DENY, never a loosening.
  link.on("policy", (f: { deny?: unknown }) => terminals.setPolicy(f?.deny));
  link.on("offline", (why: string) => console.log(`[host] link down (${why}) — reconnecting`));
  // Phase 6: the brain asks for an update (Desk → Computers → Update). Only when launchd runs this
  // process: a restart is how the new code starts, and a host run by hand cannot restart itself.
  link.on("update", (f: UpdateFrame) => {
    const report = (s: Omit<UpdateStatus, "t" | "id">) => {
      if (s.state !== "running") console.log(`[host] update ${f.id}: ${s.state}${s.error ? ` — ${s.error}` : ""}`);
      link.sendControl({ t: "update_status", id: f.id, ...s });
    };
    void (async () => {
      if ((await launchdPid().catch(() => null)) !== process.pid) {
        return report({ state: "failed", error: `this host was started by hand, not by its LaunchAgent — update it there: npm run host -- update` });
      }
      await updateTo(f.target, report, () => kickstart());
    })().catch((e) => report({ state: "failed", error: String(e?.message ?? e) }));
  });
  let fwd: Awaited<ReturnType<typeof startForwarder>> | null = null;
  for (const port of mcPortCandidates()) {
    try {
      fwd = await startForwarder(link, {
        port,
        status: () => ({ host_id: id, state: link.state, url: link.url, since: link.since, last_error: link.lastError }),
      });
      // Agents opened from now on point MC_API at the port that actually bound.
      terminals.setMcPort(port);
      console.log(`[host] mc forwarder on 127.0.0.1:${port}${port !== 7777 && !env("CHRONOS_HOST_MC_PORT") ? " (7777 is taken on this Mac)" : ""}`);
      break;
    } catch (e: any) {
      console.warn(`[host] mc forwarder could not bind 127.0.0.1:${port} (${e?.message ?? e})`);
    }
  }
  if (!fwd) console.warn("[host] no mc forwarder — agents on this host cannot reach the brain; set CHRONOS_HOST_MC_PORT to a free port");
  link.start();
  const stop = async () => {
    // A host that stops takes its agents with it (they are its children); the brain revives them
    // with --resume on this host when it comes back (HOSTS.md → Reconnect and restarts).
    terminals.killAll();
    await link.stop();
    fwd?.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<number>(() => {}); // run forever
}

/** Update this install to `target` and restart through `restart` (update.ts has the sequence). */
async function updateTo(target: UpdateTarget, report: (s: Omit<UpdateStatus, "t" | "id">) => void, restart: () => Promise<void>) {
  const inst = detectInstall(REPO_ROOT, HOST_HOME);
  const build = await hostBuild();
  return runUpdate(target, {
    run: defaultRunner,
    report,
    install: inst,
    current: { version: chronosVersion(), commit: build.commit },
    restart,
    rewritePlist: (appDir) => {
      if (fs.existsSync(plistPath())) writeHostPlist({ hostHome: HOST_HOME, pkgRoot: inst.kind === "npm" ? path.join(appDir, "node_modules", "getchronos") : appDir });
    },
  });
}

/**
 * `host update` by hand: to the tip of the clone's upstream branch, or npm's latest version. What
 * the Desk's button does, minus the brain — for a host whose brain is away, or to try it first.
 */
async function cmdUpdate(): Promise<number> {
  const inst = detectInstall(REPO_ROOT, HOST_HOME);
  let target: UpdateTarget;
  if (inst.kind === "git") {
    const f = await defaultRunner("git", ["-C", inst.appDir, "fetch", "--quiet", "origin"], { timeoutMs: 300_000 });
    if (f.code !== 0) { console.error(`✗ git fetch failed: ${f.stderr.trim()}`); return 1; }
    const up = await defaultRunner("git", ["-C", inst.appDir, "rev-parse", "origin/HEAD"]);
    const sha = up.code === 0 ? up.stdout.trim() : (await defaultRunner("git", ["-C", inst.appDir, "rev-parse", "origin/main"])).stdout.trim();
    target = { version: chronosVersion(), commit: sha || null };
  } else if (inst.kind === "npm") {
    const npm = npmCliFor();
    const v = npm ? await defaultRunner(process.execPath, [npm, "view", "getchronos", "version"]) : null;
    if (!v || v.code !== 0) { console.error(`✗ could not ask npm for the latest getchronos: ${v?.stderr.trim() || "no npm next to this node"}`); return 1; }
    target = { version: v.stdout.trim(), commit: null };
  } else {
    console.error(`✗ this copy runs from ${inst.pkgRoot} (${inst.kind}) — only ~/.chronos-host/app updates itself`);
    return 1;
  }
  const loaded = (await launchdPid().catch(() => null)) != null;
  const r = await updateTo(target, (s) => console.log(s.state === "running" ? `  · ${s.step}` : `${s.state === "failed" ? "✗" : "✓"} ${s.state}${s.error ? ` — ${s.error}` : ""}`), async () => {
    if (loaded) await kickstart();
    else console.log(`  the LaunchAgent is not loaded — start the host with: node ${shellPath(path.join(inst.appDir, "bin", "getchronos.mjs"))} host run`);
  });
  return r === "failed" ? 1 : 0;
}

async function runDoctor(): Promise<{ ok: boolean; text: string }> {
  const [clis, checkouts] = await Promise.all([probeClis(), scanCheckouts()]);
  // The preflight's own checks first (bin/host-core.mjs): a broken git or a half-installed tree is
  // what actually stopped the first hosts, and the brain's `doctor` rpc sees the same lines.
  const inst = detectInstall(REPO_ROOT, HOST_HOME);
  const pre = [...checkDeps(inst.pkgRoot, { appDir: inst.appDir }), checkGit()].map((c) => ({ ok: c.ok, label: c.label, detail: c.detail, hint: c.fix }));
  const build = await hostBuild();
  // A developer's own checkout runs fine; it is only never updated from the Desk.
  const installed = { ok: true, label: "installed", detail: `${build.install}${build.install === "dev" ? " (updates by hand)" : ""} — chronos ${chronosVersion()}${build.commit ? ` @ ${build.commit.slice(0, 12)}` : ""} (${inst.pkgRoot})` };
  const checks = [installed, ...pre, ...checklist({
    node: process.version,
    clis,
    profiles: profiles(),
    checkouts,
    roots: hostRoots(),
    secretsMode: secretsMode(),
    joined: { id: env("CHRONOS_HOST_ID") || null, brains: brains(), fp: env("CHRONOS_HOST_CERT_FP") || null },
    plistInstalled: fs.existsSync(plistPath()),
  })];
  return { ok: checks.every((c) => c.ok), text: formatChecklist(checks) };
}

function statusOn(port: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/__host/status", timeout: 2000 }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** The first candidate port that answers as a host forwarder (a Chronos daemon on 7777 does not). */
async function localStatus(): Promise<Record<string, unknown> | null> {
  for (const port of mcPortCandidates()) {
    const s = await statusOn(port);
    if (s && s.host_id) return s;
  }
  return null;
}

async function cmdStatus(): Promise<number> {
  const id = env("CHRONOS_HOST_ID");
  console.log(`host id   ${id || "(not joined)"}`);
  const b = await hostBuild();
  console.log(`version   chronos ${chronosVersion()}${b.commit ? ` @ ${b.commit.slice(0, 12)}` : ""} (${b.install} install)`);
  console.log(`brains    ${brains().join(", ") || "(none)"}`);
  const fp = env("CHRONOS_HOST_CERT_FP");
  console.log(`cert pin  ${fp ? fp.slice(0, 16) + "…" : "(none — tunnel only)"}`);
  console.log(`deny      ${env("CHRONOS_HOST_DENY") || "(none)"}`);
  console.log(`agent     ${fs.existsSync(plistPath()) ? plistPath() : "(no LaunchAgent)"}`);
  const s = await localStatus();
  if (!s) console.log(`link      host process not running (no forwarder on 127.0.0.1:${mcPortCandidates().join("/")})`);
  else console.log(`link      ${s.state}${s.url ? ` via ${s.url}` : ""} since ${new Date(Number(s.since)).toLocaleString()}${s.last_error ? ` — last error: ${s.last_error}` : ""}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "join": return cmdJoin(rest);
    case "run": return cmdRun();
    case "status": return cmdStatus();
    case "update": return cmdUpdate();
    case "doctor": {
      const r = await runDoctor();
      console.log(r.text);
      return r.ok ? 0 : 1;
    }
    default:
      console.log("usage: npm run host -- <join <brain-url> <code> | run | status | doctor | update>  (uninstall: bin/getchronos.mjs host uninstall)");
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
