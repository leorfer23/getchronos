/**
 * `GET /api/setup/optional`: the upgrades this Mac does not have yet, each with what it adds, what
 * stands in for it today and the one thing to do to get it.
 *
 * Chronos was built on one Mac that had everything — a neural voice, two whisper servers, a paid
 * transcription key, Telegram, a Cloudflare tunnel, grok and cursor logged in. A new user has a plain
 * Mac and one agent CLI, and every one of those is optional: Robert speaks with macOS `say`, Mac
 * notifications stand in for Telegram, a walled terminal waits instead of failing over. What was
 * missing was a place that says so, per item, instead of a log line or a feature that silently does
 * nothing. Setup (PR A's `npm run setup`) and the Desk's welcome read this list; it is also the one
 * answer to "what else can I turn on?".
 *
 *   status "on"      — set up and in use
 *          "default" — not set up; a free default covers the feature (named in `default`)
 *          "off"     — not set up; the feature it adds is not there
 *
 * Never a secret in the answer: whether a key or token is present, never its value. Every probe is
 * cheap — files, PATH, and loopback health checks with a short timeout — and never a model call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { calendars } from "./store.js";
import { setting } from "./settings.js";
import { cloudHasKey } from "./transcribe-cloud.js";
import { finalUrl, transcribeIsLocal, transcribeUrl } from "./transcribe.js";
import { deskBase } from "./artifacts.js";
import { fallbackChain, failoverUsable } from "./terminal-failover.js";
import { findEngine, INSTALL_HINT as BROWSER_INSTALL } from "./resources/browser-engine.js";
import { resolveFffMcp, rtkAvailable } from "./efficiency-tools.js";
import {
  CODE_ROOT, KOKORO_INSTALL, WHISPER_INSTALL, WHISPER_INSTALL_ACCURATE, appleSilicon, findBin, logDir, whisperInstalled, whisperState,
} from "./voice-setup.js";

export type OptionalStatus = "on" | "off" | "default";
export type OptionalItem = {
  id: string;
  label: string;
  /** What it adds, and what it costs when it costs anything. */
  why: string;
  status: OptionalStatus;
  /** The one thing to do to turn it on (a command, or where to click). */
  how: string;
  /** With status "default": what stands in for it today. */
  default?: string;
  /** A live fact worth reading next to the status ("installed but not answering — see …"). */
  note?: string;
};

/** Engine state as the probes found it. "custom" = the operator pointed it somewhere else (an env URL). */
type Engine = "up" | "down" | "missing" | "custom" | "off";

/** What the probes found — plain facts, so the list itself is a pure function a test can drive. */
export type OptionalFacts = {
  appleSilicon: boolean;
  /** Kokoro (CHRONOS_TTS_URL): answering, installed but not answering, not installed, or switched off. */
  voice: "up" | "down" | "missing" | "off";
  uv: boolean;
  hearing: Engine;
  hearingFinal: Engine;
  cloudKey: boolean;
  finalEngine: string;
  telegram: boolean;
  desktopNotify: boolean;
  phone: boolean;
  calendars: number;
  failoverChain: string[];
  failoverReady: string[];
  gh: "ready" | "logged-out" | "missing";
  fff: boolean;
  rtk: boolean;
  browser: boolean;
  logDir: string;
  phoneGuide: boolean;
};

const said = (cmd: string) => `In the Chronos folder: ${cmd}`;

export function optionalUpgrades(f: OptionalFacts): OptionalItem[] {
  const items: OptionalItem[] = [];
  const hears = f.hearing === "up" || f.hearing === "custom";

  items.push({
    id: "voice",
    label: "A nicer voice for Robert (Kokoro — local, free)",
    why: "Robert already speaks with the Mac's own voice. Kokoro is a neural voice that runs on this Mac: nothing leaves it, nothing is billed.",
    status: f.voice === "up" ? "on" : "default",
    default: "the Mac's built-in voice (macOS say)",
    how: !f.appleSilicon ? "Needs an Apple Silicon Mac — the built-in voice stays." : f.uv ? said(KOKORO_INSTALL) : `Install uv (brew install uv), then ${said(KOKORO_INSTALL).replace(/^I/, "i")}`,
    ...(f.voice === "off" ? { note: "switched off (CHRONOS_TTS_URL=off)" } : f.voice === "down" ? { note: `installed but not answering — see ${path.join(f.logDir, "tts.err.log")}` } : {}),
  });

  items.push({
    id: "hearing",
    label: "Talk to Robert: speech-to-text (whisper.cpp — local, free)",
    why: "The mic on the Desk and the phone, and voice calls with Robert, need it. It runs on this Mac — audio is never sent anywhere. About 470 MB.",
    status: hears ? "on" : "off",
    how: said(WHISPER_INSTALL),
    ...(f.hearing === "down" ? { note: `installed but not answering — see ${path.join(f.logDir, "whisper.err.log")}` } : {}),
    ...(f.hearing === "custom" ? { note: "using your own CHRONOS_TRANSCRIBE_URL" } : {}),
  });

  items.push({
    id: "hearing-accurate",
    label: "Sharper hearing for whole sentences (a larger local model)",
    why: "Finished sentences go to whisper's large-v3-turbo model: about half the word errors of the small one, for ~1 s instead of ~0.4 s. Local and free; 1.5 GB more.",
    status: f.hearingFinal === "up" || f.hearingFinal === "custom" ? "on" : hears ? "default" : "off",
    default: "the small model hears whole sentences too",
    how: said(WHISPER_INSTALL_ACCURATE),
    ...(f.hearingFinal === "down" ? { note: `installed but not answering — see ${path.join(f.logDir, "whisper-final.err.log")}` } : {}),
    ...(f.hearingFinal === "off" ? { note: "switched off (CHRONOS_TRANSCRIBE_FINAL_URL=off)" } : {}),
  });

  const cloudOn = f.cloudKey && f.finalEngine === "cloud";
  items.push({
    id: "hearing-cloud",
    label: "Best transcription on calls (ElevenLabs — paid key)",
    why: "Each finished sentence of a call is sent to ElevenLabs: fewer mistakes on names and mixed languages. The audio leaves the Mac, and it is billed per hour of audio. Live words and one-word answers stay local.",
    status: cloudOn ? "on" : hears ? "default" : "off",
    default: "local whisper",
    how: f.cloudKey
      ? "⚙ Settings → Voice → Engine for what you said: cloud"
      : "Put ELEVENLABS_API_KEY=… in .secrets, restart Chronos, then ⚙ Settings → Voice → Engine for what you said: cloud",
    ...(f.cloudKey && !cloudOn ? { note: "the key is set; the engine is not switched to cloud" } : {}),
  });

  items.push({
    id: "telegram",
    label: "Telegram: alerts and Robert from anywhere",
    why: "Questions, stuck work and the morning digest reach your phone as Telegram messages, and you can answer Robert from there.",
    status: f.telegram ? "on" : f.desktopNotify ? "default" : "off",
    default: "Mac notifications (and phone push once your phone is paired)",
    how: "Make a bot with @BotFather, put CHRONOS_TG_TOKEN=… in .secrets, restart, send /start to your bot and add the CHRONOS_TG_CHAT_ID it replies with",
  });

  items.push({
    id: "phone",
    label: "Your phone (Robert and the Desk over HTTPS)",
    why: "The phone app needs a secure address for this Mac: push notifications, the mic and Add to Home Screen only work over HTTPS.",
    status: f.phone ? "on" : "off",
    how: f.phoneGuide ? "docs/guide/phone.md (Tailscale: a few minutes, no domain needed)" : "CONFIGURATION.md §4 (a Cloudflare tunnel)",
  });

  items.push({
    id: "calendar",
    label: "Your calendar on the Desk",
    why: "Your agenda next to the work, and a reminder before each meeting.",
    status: f.calendars > 0 ? "on" : "off",
    how: 'POST /api/calendars {"name":"Work","ics_url":"<your calendar\'s private ICS link>"} — Google, iCloud and Outlook all give one',
  });

  const ready = f.failoverReady;
  items.push({
    id: "failover",
    label: "A stand-in when a terminal hits its usage limit",
    why: "A terminal out of credits carries on in another agent CLI you already pay for, instead of waiting for the reset.",
    status: ready.length ? "on" : "off",
    how: `Install and sign in to another agent CLI (Codex, Cursor, Grok, opencode), then list it in ⚙ Settings → Failover (now: ${f.failoverChain.join(", ") || "none"})`,
    ...(ready.length ? { note: `ready: ${ready.join(", ")}` } : {}),
  });

  items.push({
    id: "github",
    label: "GitHub CLI: pull requests and CI",
    why: "Agents open pull requests and read CI through gh. Without it, repos set to deliver as a PR cannot open one.",
    status: f.gh === "ready" ? "on" : "off",
    how: f.gh === "missing" ? "brew install gh && gh auth login" : "gh auth login",
  });

  items.push({
    id: "browser",
    label: "A browser agents can drive (mc browser)",
    why: "Agents check pages they build and read sites with a shared headless Chrome — never your own Chrome profile.",
    status: f.browser ? "on" : "off",
    how: BROWSER_INSTALL,
  });

  items.push({
    id: "fff",
    label: "Faster code search for agents (fff)",
    why: "A search MCP server agents use instead of grep: fewer tool calls on big repos. Free.",
    status: f.fff ? "on" : "off",
    how: "brew install dmtrKovalenko/fff/fff-mcp, then restart Chronos",
  });

  items.push({
    id: "rtk",
    label: "Smaller shell output for agents (RTK — fewer tokens)",
    why: "Compresses what commands print before the agent reads it, so the same work uses fewer tokens. Free.",
    status: f.rtk ? "on" : "off",
    how: "brew install rtk, then restart Chronos",
  });

  return items;
}

/** GET → 2xx within the timeout. Loopback only here; a refusal or a timeout is just "not up". */
async function answers(url: string, timeoutMs = 800): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** The engine behind a whisper inference URL, by its /health. */
const health = (inferenceUrl: string) => inferenceUrl.replace(/\/inference\/?$/, "") + "/health";

/** What this Mac has, right now. Every probe in parallel; the slowest is a refused or timed-out loopback GET. */
export async function probeOptional(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<OptionalFacts> {
  const ttsUrl = (env.CHRONOS_TTS_URL ?? "http://127.0.0.1:7779").trim();
  const ws = whisperState(home, env);
  const fin = finalUrl();
  const localFinal = transcribeIsLocal() && fin != null && !env.CHRONOS_TRANSCRIBE_FINAL_URL;
  const [voiceUp, hearUp, finalUp] = await Promise.all([
    ttsUrl && ttsUrl !== "off" ? answers(ttsUrl.replace(/\/+$/, "") + "/health") : Promise.resolve(false),
    transcribeIsLocal() ? answers(health(transcribeUrl())) : Promise.resolve(false),
    localFinal ? answers(health(fin!)) : Promise.resolve(false),
  ]);
  const ghBin = findBin("gh", env);
  const ghHosts = path.join(env.GH_CONFIG_DIR || path.join(home, ".config", "gh"), "hosts.yml");
  const chain = fallbackChain(undefined, setting<string[]>("failover.backends"));
  return {
    appleSilicon: appleSilicon(),
    voice: !ttsUrl || ttsUrl === "off" ? "off" : voiceUp ? "up" : fs.existsSync(path.join(home, ".mc", "tts", "venv", "bin", "python")) ? "down" : "missing",
    uv: !!findBin("uv", { ...env, PATH: `${env.PATH ?? ""}${path.delimiter}${path.join(home, ".local", "bin")}` }),
    hearing: !transcribeIsLocal() ? "custom" : hearUp ? "up" : whisperInstalled(ws) ? "down" : "missing",
    hearingFinal: fin == null ? (env.CHRONOS_TRANSCRIBE_FINAL_URL ? "off" : "missing") : !localFinal ? "custom" : finalUp ? "up" : ws.finalAgent ? "down" : "missing",
    cloudKey: cloudHasKey(),
    finalEngine: String(setting("voice.final_engine")),
    telegram: !!CONFIG.telegram.token,
    desktopNotify: CONFIG.desktopNotify,
    phone: deskBase(env).startsWith("https://") || fs.existsSync(path.join(home, "Library", "LaunchAgents", "sh.chronos.cloudflared.plist")),
    calendars: calendars.list().length,
    failoverChain: chain,
    failoverReady: chain.filter((b) => failoverUsable(b, null)),
    gh: !ghBin ? "missing" : fs.existsSync(ghHosts) || env.GH_TOKEN || env.GITHUB_TOKEN ? "ready" : "logged-out",
    // The same lookups the daemon wires them with (src/efficiency-tools.ts), so "on" means "in use".
    fff: !!resolveFffMcp(),
    rtk: rtkAvailable(),
    browser: !!findEngine({ home, platform: process.platform, explicit: env.CHRONOS_BROWSER_PATH?.trim() || null }).found,
    logDir: logDir(env),
    phoneGuide: fs.existsSync(path.join(CODE_ROOT, "docs", "guide", "phone.md")),
  };
}
