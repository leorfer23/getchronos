// Is ffmpeg actually usable? whisper-server --convert shells out to it for every non-WAV upload, and
// "installed" is not "working": a brew upgrade of a dependency (x265, …) leaves the binary in place
// but dyld aborts it at load. So run it, don't just stat it. Shared by install:launchd and the daemon.
import { spawnSync } from "node:child_process";

// The one whisper-server's launchd PATH finds first. CHRONOS_FFMPEG overrides (tests, other prefixes).
export const ffmpegBin = () => process.env.CHRONOS_FFMPEG || "/opt/homebrew/bin/ffmpeg";

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
