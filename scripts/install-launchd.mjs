#!/usr/bin/env node
// Render launchd/*.plist.template for THIS machine and (re)load the agents.
//
// Why a generator instead of committed plists: a plist needs absolute paths, and home dir,
// checkout location, uid and node binary all differ per Mac. Committing one machine's values
// meant the other machine silently ran the wrong node / wrote logs to a nonexistent path.
//
// Usage:
//   npm run install:launchd            # daemon only
//   npm run install:launchd -- --all   # daemon + whisper + overlay + cloudflared (skips ones not set up)
//   npm run install:launchd -- --print # render to stdout, install nothing

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const printOnly = argv.includes("--print");
const all = argv.includes("--all");

const home = os.homedir();
const uid = process.getuid();
const repoDir = path.resolve(import.meta.dirname, "..");
const nodeBin = process.execPath; // the node running THIS script — same one npm/deps were built for
const logDir = process.env.CHRONOS_LOG_DIR ?? path.join(home, "chronos");
const port = process.env.CHRONOS_PORT ?? "7777";
const agentDir = path.join(home, "Library", "LaunchAgents");
const templateDir = path.join(repoDir, "launchd");

const subs = {
  __HOME__: home,
  __USER__: os.userInfo().username,
  __REPO_DIR__: repoDir,
  __NODE_BIN__: nodeBin,
  __NODE_DIR__: path.dirname(nodeBin),
  __LOG_DIR__: logDir,
  __PORT__: port,
};

// Only the daemon is mandatory. whisper needs a downloaded model, overlay needs the mc CLI —
// installing an agent whose program does not exist just gets launchd into a crash-restart loop,
// so each optional agent states its precondition and is skipped when unmet.
const AGENTS = [
  { label: "sh.chronos.daemon", required: true },
  {
    label: "sh.chronos.whisper",
    // Newest model in ~/.cache/whisper wins; the template's __WHISPER_MODEL__ takes its filename.
    precondition: () => {
      const dir = path.join(home, ".cache", "whisper");
      const models = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).sort() : [];
      if (!models.length) return "no model in ~/.cache/whisper (see README → Voice)";
      if (!fs.existsSync("/opt/homebrew/bin/whisper-server")) return "whisper-server not installed (brew install whisper-cpp)";
      subs.__WHISPER_MODEL__ = models[models.length - 1];
      return null;
    },
  },
  {
    // The Desk itself at login — the surface, not a satellite. Needs the .app bundle rather than a
    // bare binary: that is where the Dock icon and the name "Chronos" come from.
    label: "sh.chronos.app",
    precondition: () =>
      fs.existsSync(path.join(home, ".mc", "mc-app.app"))
        ? null
        : "~/.mc/mc-app.app not installed (scripts/build-app.sh)",
  },
  {
    label: "sh.chronos.overlay",
    precondition: () =>
      fs.existsSync(path.join(home, ".mc", "bin", "mc-overlay")) ? null : "~/.mc/bin/mc-overlay not installed",
  },
  {
    // Opens WhatsApp at login so scheduled sends find it running with a window (see desktop/README.md).
    label: "sh.chronos.whatsapp",
    precondition: () =>
      fs.existsSync(path.join(home, ".mc", "wapp.app")) ? null : "~/.mc/wapp.app not installed (scripts/build-wapp.sh)",
  },
  {
    // Cloudflare Tunnel for Desk/Phone. Token is created in Zero Trust and saved locally — see
    // CONFIGURATION.md §4. Skipped until both the binary and the token file exist.
    label: "sh.chronos.cloudflared",
    precondition: () => {
      const bin = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((p) => fs.existsSync(p));
      if (!bin) return "cloudflared not installed (brew install cloudflared)";
      const token = path.join(home, ".cloudflared", "chronos-desk.token");
      if (!fs.existsSync(token)) return "no ~/.cloudflared/chronos-desk.token (CONFIGURATION.md §4)";
      subs.__CLOUDFLARED_BIN__ = bin;
      return null;
    },
  },
];

function render(label) {
  const tpl = fs.readFileSync(path.join(templateDir, `${label}.plist.template`), "utf8");
  let out = tpl;
  for (const [k, v] of Object.entries(subs)) out = out.replaceAll(k, v);
  const missing = [...new Set(out.match(/__[A-Z_]+__/g) ?? [])];
  if (missing.length) throw new Error(`${label}: unresolved placeholder(s) ${missing.join(", ")}`);
  return out;
}

fs.mkdirSync(logDir, { recursive: true });
if (!printOnly) fs.mkdirSync(agentDir, { recursive: true });

for (const agent of AGENTS) {
  if (!agent.required && !all) continue;
  if (agent.precondition) {
    const why = agent.precondition();
    if (why) {
      console.log(`[launchd] skip ${agent.label} — ${why}`);
      continue;
    }
  }

  if (agent.prepare && !printOnly) agent.prepare();

  const xml = render(agent.label);
  if (printOnly) {
    console.log(`\n===== ${agent.label} =====\n${xml}`);
    continue;
  }

  const dest = path.join(agentDir, `${agent.label}.plist`);
  fs.writeFileSync(dest, xml);
  execFileSync("plutil", ["-lint", dest], { stdio: "pipe" });

  // bootout first so a rewritten plist is actually re-read; a not-loaded agent errors here,
  // which is the normal first-install path, hence the ignored failure.
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${agent.label}`], { stdio: "pipe" });
  } catch {}
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, dest], { stdio: "inherit" });
  console.log(`[launchd] loaded ${agent.label} → ${dest}`);
}

if (!printOnly) {
  console.log(
    `\n[launchd] node=${nodeBin}\n[launchd] repo=${repoDir}\n[launchd] logs=${logDir}\n` +
      `[launchd] check: curl -s localhost:${port}/api/health`,
  );
}
