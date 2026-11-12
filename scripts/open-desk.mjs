#!/usr/bin/env node
// `npm run desk` — open the Desk in your browser, already signed in.
//
// The admin token never goes into a URL: this reads it from the checkout (it runs as you, in your
// terminal), trades it with the daemon for a one-time code (POST /api/pair, src/pair.ts) and opens
// /desk#pair=<code>. The page redeems the code and keeps the token (static/pair.js). The code works
// once, for five minutes, so the link printed below is safe to leave in your scrollback.
//
//   npm run desk                 open it
//   npm run desk -- --no-open    just print the link (another browser, another profile)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The daemon's port: CHRONOS_PORT, as the daemon reads it (src/config.ts). */
export const portFrom = (env = process.env) => Number(env.CHRONOS_PORT ?? 7777);

/**
 * The admin token the daemon of this checkout uses: CHRONOS_ADMIN_TOKEN, else `.admin-token` beside the
 * code (or in CHRONOS_HOME) — the same lookup as src/config.ts. Null when the daemon never ran here.
 */
export function readToken(env = process.env, repoDir = REPO_DIR) {
  if (env.CHRONOS_ADMIN_TOKEN) return env.CHRONOS_ADMIN_TOKEN;
  try {
    return fs.readFileSync(path.join(env.CHRONOS_HOME || repoDir, ".admin-token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** A failure the person can act on: `message` says what is wrong, `fix` is the one command to run. */
export class DeskError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

/**
 * Ask the daemon for a one-time sign-in link. Throws DeskError when it is not running, or is a Chronos
 * from another folder (it refuses this folder's token).
 */
export async function mintDeskUrl({ port = portFrom(), token = readToken(), page = "/desk", fetchImpl = fetch } = {}) {
  if (!token) throw new DeskError("Chronos hasn't run from this folder yet, so there is no key to sign in with.", "npm run setup");
  const base = `http://localhost:${port}`;
  let r;
  try {
    r = await fetchImpl(`${base}/api/pair`, { method: "POST", headers: { "x-mc-admin": token, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
  } catch {
    throw new DeskError(`Chronos isn't running on port ${port}.`, "npm run setup");
  }
  if (r.status === 403) {
    throw new DeskError(`The Chronos on port ${port} was started from a different folder, so it doesn't take this folder's key.`, `CHRONOS_PORT=${port + 1} npm run setup`);
  }
  if (r.status === 404) throw new DeskError(`The Chronos on port ${port} is an older version without sign-in links — restart it from this folder.`, "npm run setup");
  if (r.status !== 201) throw new DeskError(`Chronos answered ${r.status} when asked for a sign-in link.`, "npm run setup");
  const { code, expires_at } = await r.json();
  return { url: `${base}${page}#pair=${code}`, expiresAt: expires_at };
}

/** Open a URL in the default browser. False when there is no opener (a server without a desktop). */
export function openInBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const cmd = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!cmd) return false;
  try {
    const child = spawnImpl(cmd, [url], { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

async function main(argv = process.argv.slice(2)) {
  const noOpen = argv.includes("--no-open");
  try {
    const { url } = await mintDeskUrl();
    const opened = !noOpen && openInBrowser(url);
    console.log(opened
      ? `Opening the Desk, signed in. If it didn't open, use this link (it works once, for 5 minutes):\n  ${url}`
      : `Open this link to get to the Desk, signed in (it works once, for 5 minutes):\n  ${url}`);
  } catch (e) {
    if (!(e instanceof DeskError)) throw e;
    console.error(`${e.message}\n  ${e.fix}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
