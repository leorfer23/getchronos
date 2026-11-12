// Is ffmpeg actually usable? whisper-server --convert shells out to it for every non-WAV upload, and
// "installed" is not "working": a brew upgrade of a dependency (x265, …) leaves the binary in place
// but dyld aborts it at load. So run it, don't just stat it. Shared by install:launchd and the daemon.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

// The one whisper-server's launchd PATH finds first: Homebrew's, on Apple Silicon (/opt/homebrew) or
// Intel (/usr/local). CHRONOS_FFMPEG overrides (tests, other prefixes). Neither there → the Apple
// Silicon path, so the "not installed" answer names where `brew install ffmpeg` will put it.
const BREW_FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
export const ffmpegBin = () => process.env.CHRONOS_FFMPEG || BREW_FFMPEG.find((p) => fs.existsSync(p)) || BREW_FFMPEG[0];

// null = healthy; otherwise one line saying what's wrong.
export function ffmpegProblem(bin = ffmpegBin()) {
  const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 5000 });
  if (r.error?.code === "ENOENT") return `ffmpeg not installed at ${bin} (brew install ffmpeg)`;
  if (r.error) return `ffmpeg broken: ${r.error.message}`;
  if (r.status === 0) return null;
  const out = `${r.stderr || ""}\n${r.stdout || ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const why = out.find((l) => /dyld|Library not loaded/i.test(l)) || out[0] || (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`);
  return `ffmpeg broken: ${why.slice(0, 300)} (${bin} -version → ${r.signal || "exit " + r.status})`;
}
