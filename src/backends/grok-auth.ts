/**
 * Is grok signed in on this machine? One answer for every caller — the setup check (`GET /api/setup/status`),
 * the failover chain (`backendReady`), a host's inventory and `grokBackend.checkAuth` — read from grok's
 * own credentials file, never a spawn: `backendReady` runs inside a wall, on the daemon's event loop.
 *
 * What grok itself does (grok 1.0.70, checked against isolated homes with crafted auth files):
 *   - `grok login` writes `~/.grok/auth.json`: one entry per sign-in, each with an access token (`key`)
 *     that lasts about 6 hours (`expires_at`) and a `refresh_token`.
 *   - Before a request grok refreshes an expired access token with the refresh token and rewrites the
 *     file — so a session whose access token ran out an hour ago still works on the next call.
 *   - `grok models` answers its "You are logged in" / "You are not authenticated" line from the access
 *     token's expiry alone, BEFORE that refresh: on a Mac idle for more than 6 hours it said "not
 *     authenticated" while the very same run refreshed the token and the next one said "logged in".
 *     That is why reading its words called a working grok signed out.
 *   - An entry with no refresh token and an expired access token gets "the stored login needs a new
 *     sign-in"; no entries (or no file) is signed out.
 *
 * So: signed in = some entry carries an access token AND (a refresh token OR an unexpired access token).
 * Only presence and the expiry are read — never a token's value. The one thing a file cannot tell is a
 * refresh token the server has revoked; the setup's test prompt (POST /api/setup/smoke/grok) catches that.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** grok's home: GROK_HOME (tests, a host's own override), else ~/.grok. */
export const grokHome = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string => env.GROK_HOME || path.join(home, ".grok");

type Entry = { refresh: boolean; expiresAt: number };

/** auth.json text → its sign-ins (nothing secret kept). Not JSON, or not grok's shape → none. */
export function grokEntries(text: string): Entry[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return [];
  const out: Entry[] = [];
  for (const v of Object.values(j as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    if (typeof e.key !== "string" || !e.key) continue;
    const exp = typeof e.expires_at === "string" ? Date.parse(e.expires_at) : NaN;
    out.push({ refresh: typeof e.refresh_token === "string" && e.refresh_token.length > 0, expiresAt: Number.isFinite(exp) ? exp : 0 });
  }
  return out;
}

export const signedInFrom = (entries: Entry[], now = Date.now()): boolean => entries.some((e) => e.refresh || e.expiresAt > now);

// Parsed once per file version: a stat per call, a read only when grok rewrote the file.
let cache: { file: string; mtimeMs: number; size: number; entries: Entry[] } | null = null;

/** Signed in here, by grok's own rule (above). Cheap: one stat, and a ~2 KB read when the file changed. */
export function grokSignedIn(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), now = Date.now()): boolean {
  const file = path.join(grokHome(env, home), "auth.json");
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return false; }
  if (!cache || cache.file !== file || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, entries: grokEntries(text) };
  }
  return signedInFrom(cache.entries, now);
}
