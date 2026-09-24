import fs from "node:fs";
import path from "node:path";

/**
 * Pre-accept claude's "Do you trust the files in this folder?" dialog for `cwd` in the profile at
 * `configDir`.
 *
 * A Desk terminal is opened in a folder the daemon chose — a repo, or the workspace's landing dir
 * (`default_dir`, a symlink farm nobody ever opened by hand). Interactive claude asks the trust
 * question on the first visit to any folder, and a terminal seeded with a first prompt has no one
 * to answer it: the pty sat on the dialog and died within seconds (globex, 2026-09-04). Acme and
 * GFM only worked because the operator had once opened their landing dirs himself.
 *
 * Trust is per profile per folder and lives in `<configDir>/.claude.json` under `projects[cwd]`.
 * Writing it before the spawn is exactly what tapping "Yes" would have done; the daemon already
 * decided this folder is the workspace's own. A profile with no `.claude.json` yet is left alone —
 * that is a brand-new login, which is interactive anyway.
 */
export function ensureTrustedCwd(configDir: string, cwd: string): "already" | "added" | "skipped" {
  const file = path.join(configDir, ".claude.json");
  let state: any;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return "skipped"; }
  if (!state || typeof state !== "object" || Array.isArray(state)) return "skipped";
  const projects = (state.projects && typeof state.projects === "object") ? state.projects : (state.projects = {});
  const keys = trustKeys(cwd);
  const trusted = (k: string) => { const c = projects[k]; return !!c && typeof c === "object" && c.hasTrustDialogAccepted === true; };
  if (keys.every(trusted)) return "already";
  for (const k of keys) {
    const cur = projects[k];
    projects[k] = {
      allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      ...(cur && typeof cur === "object" ? cur : {}),
      hasTrustDialogAccepted: true,
    };
  }
  // Atomic replace: claude rewrites this file itself, and a half-written one would lose the login.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return "added";
}

/**
 * The folder as the CLI will name it: its own `getcwd()`, which on macOS is the path with the case
 * the disk actually has. APFS is case-insensitive, so `~/Documents/GitHub/x` opens a folder that is
 * really `~/Documents/Github/x` — and a trust entry written under the first spelling is invisible to
 * a CLI that looks up the second (the M5 host, 2026-09-24: pre-trusted, then asked anyway, twice).
 * `fs.realpathSync` keeps whatever case it was given; `.native` asks the OS. Both spellings are
 * written when they differ, so a caller that compares against the given path still finds its key.
 */
export function trustKeys(cwd: string): string[] {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch {}
  return real === cwd ? [cwd] : [cwd, real];
}
