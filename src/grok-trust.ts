import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pre-accept grok's "Do you trust this folder?" dialog for `cwd`.
 *
 * Same failure claude-trust.ts fixes for claude, one CLI later: interactive grok asks the trust
 * question on its first visit to any folder and creates no session until it is answered. A Desk
 * terminal seeded with a first prompt types that prompt into the dialog instead — the pager reads
 * the keystrokes as its answer and quits. Every grok terminal Robert opened in the Personal landing
 * dir died in ~3s this way (2026-09-13, 22:20 and 22:29 UTC): "startup interactive" → no
 * "session created" → "pager quit". The operator's own terminal in the same folder sat on the
 * dialog for eight minutes until he tapped Yes, which is the moment the folder appeared in
 * trusted_folders.toml — and the next seeded spawn (22:53) lived.
 *
 * Trust is per folder, one xAI account, in `$GROK_HOME/trusted_folders.toml` (default ~/.grok):
 *
 *   [folders."/abs/path"]
 *   trusted = true
 *   decided_at = <unix seconds>
 *
 * Writing the block before the spawn is exactly what tapping Yes would have done; the daemon already
 * decided this folder is the workspace's own. A home with no trust file yet is left alone — grok has
 * never run for this account, which is interactive anyway.
 */
export function grokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_HOME || path.join(os.homedir(), ".grok");
}

const tomlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function ensureGrokTrustedCwd(cwd: string, home: string = grokHome()): "already" | "added" | "skipped" {
  const file = path.join(home, "trusted_folders.toml");
  let text: string;
  let mode = 0o600;
  try {
    text = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    return "skipped";
  }
  const header = `[folders.${tomlString(cwd)}]`;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  const entry = ["trusted = true", `decided_at = ${Math.floor(Date.now() / 1000)}`];
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    const block = lines.slice(start + 1, end);
    if (block.some((l) => /^\s*trusted\s*=\s*true\s*(#.*)?$/.test(l))) return "already";
    const kept = block.filter((l) => !/^\s*(trusted|decided_at)\s*=/.test(l));
    lines.splice(start + 1, end - start - 1, ...entry, ...kept);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(header, ...entry, "");
  }
  // Atomic replace: grok rewrites this file itself, and a half-written one would drop every folder.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join("\n"), { mode });
  fs.renameSync(tmp, file);
  return "added";
}
