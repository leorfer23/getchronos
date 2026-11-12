/**
 * Is the voice stack installed on THIS Mac — and, when it is not, the one command that installs it.
 *
 * Robert speaks out of the box (macOS `say`, src/speak.ts) but hears only through a local whisper.cpp
 * server, and nothing on a fresh Mac runs one. Before this module a new user's first press of the mic
 * got "transcription engine not reachable at http://127.0.0.1:7778/inference — is sh.chronos.whisper
 * running?", and a call logged that line every ~700 ms (one per partial). Telling "never installed"
 * apart from "installed but down" is what lets the first one say what to run, once, and the second keep
 * pointing at the log.
 *
 * A leaf on purpose (node builtins + repo-root only): src/transcribe.ts and src/setup-optional.ts both
 * read it, and neither may pull the store or the config into the other.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./repo-root.js";

/** The checkout the scripts live in (src/ or dist/ sits one level under it). Not CHRONOS_HOME: that moves the state, not the code. */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Homebrew's bin directories: Apple Silicon's prefix first, then Intel's. */
export const BREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** First executable `name` on PATH or in a Homebrew bin (launchd's PATH misses both), else null. */
export function findBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const d of [...(env.PATH ?? "").split(path.delimiter), ...BREW_BINS]) {
    if (!d) continue;
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}

/** The local engines' ports. CHRONOS_WHISPER_PORT / _FINAL_PORT move them, here and in install:launchd alike. */
export const whisperPort = (env: NodeJS.ProcessEnv = process.env): string => env.CHRONOS_WHISPER_PORT?.trim() || "7778";
export const whisperFinalPort = (env: NodeJS.ProcessEnv = process.env): string => env.CHRONOS_WHISPER_FINAL_PORT?.trim() || "7781";

/** Where install:launchd points the agents' logs (CHRONOS_LOG_DIR, else beside the state — the same place the monitor rotates them). */
export const logDir = (env: NodeJS.ProcessEnv = process.env): string => env.CHRONOS_LOG_DIR?.trim() || REPO_ROOT;

export type WhisperState = {
  /** whisper-server, or null when whisper.cpp is not installed. */
  server: string | null;
  /** ggml model files in ~/.cache/whisper. */
  models: string[];
  /** The launchd agents install:launchd writes: the fast engine, and the larger one for finished sentences. */
  agent: boolean;
  finalAgent: boolean;
};

/** Files only — never runs anything, so it is cheap enough to ask on every refused connection. */
export function whisperState(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): WhisperState {
  let models: string[] = [];
  try {
    models = fs.readdirSync(path.join(home, ".cache", "whisper")).filter((f) => f.endsWith(".bin")).sort();
  } catch {}
  const agents = path.join(home, "Library", "LaunchAgents");
  return {
    server: findBin("whisper-server", env),
    models,
    agent: fs.existsSync(path.join(agents, "sh.chronos.whisper.plist")),
    finalAgent: fs.existsSync(path.join(agents, "sh.chronos.whisper-final.plist")),
  };
}

/** Installed = the server, a model, and the agent that keeps it running. Anything less never answers on its own. */
export const whisperInstalled = (s: WhisperState): boolean => !!s.server && s.models.length > 0 && s.agent;

/** The one command, run from the Chronos folder (scripts/install-whisper.sh): Homebrew's whisper.cpp + ffmpeg, the small model, the agent. */
export const WHISPER_INSTALL = "bash scripts/install-whisper.sh";
/** …plus the larger model for finished sentences (sh.chronos.whisper-final). */
export const WHISPER_INSTALL_ACCURATE = "bash scripts/install-whisper.sh --accurate";
/** Robert's neural voice (Kokoro on MLX, Apple Silicon); `say` is the voice without it. */
export const KOKORO_INSTALL = "bash scripts/install-tts.sh";

/**
 * What a user is told when the mic is pressed on a Mac that cannot hear yet. Short on purpose: the
 * pages show the first ~100 characters of an error, and this has to survive that whole.
 */
export const HEARING_NOT_SET_UP = `Speech-to-text isn't set up on this Mac yet. Run: ${WHISPER_INSTALL}`;

/** Kokoro needs MLX, which is Apple Silicon only. */
export const appleSilicon = (platform: string = process.platform, arch: string = process.arch): boolean => platform === "darwin" && arch === "arm64";
