#!/usr/bin/env node
// Render launchd/*.plist.template for THIS machine and (re)load the agents.
//
// Why a generator instead of committed plists: a plist needs absolute paths, and home dir,
// checkout location, uid and node binary all differ per Mac. Committing one machine's values
// meant the other machine silently ran the wrong node / wrote logs to a nonexistent path.
//
// Usage:
//   npm run install:launchd            # daemon only
//   npm run install:launchd -- --all   # daemon + whisper + cloudflared (skips ones not set up)
//   npm run install:launchd -- --print # render to stdout, install nothing
//   npm run install:launchd -- --only sh.chronos.tts   # that one agent, nothing else restarted

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ffmpegProblem } from "../bin/ffmpeg-check.mjs";
import { pickWhisperModel, pickFinalModel } from "./whisper-models.mjs";

const argv = process.argv.slice(2);
const printOnly = argv.includes("--print");
const all = argv.includes("--all");
// --only <label>: install that one agent and touch nothing else — the daemon included, which every
// other mode bootouts and reloads (a restart of every terminal's supervisor).
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

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

// Only the daemon is mandatory. whisper needs a downloaded model, the app needs its bundle —
// installing an agent whose program does not exist just gets launchd into a crash-restart loop,
// so each optional agent states its precondition and is skipped when unmet.
const whisperModels = () => {
  const dir = path.join(home, ".cache", "whisper");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).sort() : [];
};
// Homebrew's whisper-server: /opt/homebrew on Apple Silicon, /usr/local on Intel. Its bin dir also goes
// first on the agent's PATH, because --convert runs the ffmpeg that sits beside it.
const whisperServer = () => {
  const bin = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"].find((p) => fs.existsSync(p));
  if (bin) {
    subs.__WHISPER_BIN__ = bin;
    subs.__BREW_BIN__ = path.dirname(bin);
  }
  return bin;
};
const WHISPER_MISSING = "whisper-server not installed (bash scripts/install-whisper.sh)";

const AGENTS = [
  { label: "sh.chronos.daemon", required: true },
  {
    label: "sh.chronos.whisper",
    // A multilingual model from ~/.cache/whisper (CHRONOS_WHISPER_MODEL names one by file); the
    // template's __WHISPER_MODEL__ takes its filename. It used to be the alphabetically LAST file, which
    // would pick an English-only *.en model if one sorted last. small first: a conversation pays for every
    // second. Measured on synthetic es/en/mixed speech (load avg ~30–100): small ~0.3–0.4 s per sentence,
    // 19% word errors on mixed Spanish-English; large-v3-turbo ~1.2–1.4 s, 7%. For accuracy over speed:
    // CHRONOS_WHISPER_MODEL=ggml-large-v3-turbo.bin.
    precondition: () => {
      const models = whisperModels();
      if (!models.length) return "no model in ~/.cache/whisper (bash scripts/install-whisper.sh fetches one)";
      if (!whisperServer()) return WHISPER_MISSING;
      // CHRONOS_WHISPER_PORT moves it; the daemon reads the same variable (src/voice-setup.ts).
      const port = process.env.CHRONOS_WHISPER_PORT ?? "7778";
      if (!/^\d{2,5}$/.test(port)) return `CHRONOS_WHISPER_PORT=${port} is not a port`;
      subs.__WHISPER_PORT__ = port;
      // The template runs --convert (webm/mp4/ogg → wav via ffmpeg): a missing or dyld-broken ffmpeg
      // fails every phone upload, so run it rather than trusting the file is there.
      const ff = ffmpegProblem();
      if (ff) return `${ff} — whisper-server --convert needs a working ffmpeg (brew reinstall ffmpeg)`;
      subs.__WHISPER_MODEL__ = pickWhisperModel(models, process.env.CHRONOS_WHISPER_MODEL);
      return null;
    },
  },
  {
    // The second engine: finished sentences go to a larger model on its own port, so the fast one
    // stays free for the live words and a sentence never queues behind a preview (src/transcribe.ts).
    // Skipped when no larger model is downloaded — the daemon then keeps finals on the fast engine.
    // CHRONOS_WHISPER_FINAL_MODEL names the file; CHRONOS_WHISPER_FINAL_PORT moves the port (the
    // daemon reads the same variable, so put it in .secrets).
    label: "sh.chronos.whisper-final",
    precondition: () => {
      const models = whisperModels();
      if (!whisperServer()) return WHISPER_MISSING;
      const fast = pickWhisperModel(models, process.env.CHRONOS_WHISPER_MODEL);
      const model = pickFinalModel(models, fast, process.env.CHRONOS_WHISPER_FINAL_MODEL);
      if (!model) {
        return process.env.CHRONOS_WHISPER_FINAL_MODEL
          ? `CHRONOS_WHISPER_FINAL_MODEL=${process.env.CHRONOS_WHISPER_FINAL_MODEL} is not in ~/.cache/whisper (or is the fast engine's own model)`
          : "no larger multilingual model in ~/.cache/whisper (ggml-large-v3-turbo.bin) — finished sentences stay on the fast engine";
      }
      const ff = ffmpegProblem();
      if (ff) return `${ff} — whisper-server --convert needs a working ffmpeg (brew reinstall ffmpeg)`;
      const port = process.env.CHRONOS_WHISPER_FINAL_PORT ?? "7781";
      if (!/^\d{2,5}$/.test(port)) return `CHRONOS_WHISPER_FINAL_PORT=${port} is not a port`;
      subs.__WHISPER_FINAL_MODEL__ = model;
      subs.__WHISPER_FINAL_PORT__ = port;
      return null;
    },
  },
  {
    // Robert's local neural voice (scripts/tts-server.py, Kokoro on MLX). Installed by
    // scripts/install-tts.sh, which also fetches the model; /api/speak falls back to `say` without it.
    label: "sh.chronos.tts",
    precondition: () => {
      const py = path.join(home, ".mc", "tts", "venv", "bin", "python");
      if (!fs.existsSync(py)) return "no ~/.mc/tts/venv (bash scripts/install-tts.sh)";
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

if (only && !AGENTS.some((a) => a.label === only)) {
  console.error(`[launchd] no agent ${only} — one of: ${AGENTS.map((a) => a.label).join(", ")}`);
  process.exit(1);
}
for (const agent of AGENTS) {
  if (only ? agent.label !== only : !agent.required && !all) continue;
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
