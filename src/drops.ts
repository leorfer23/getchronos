import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Files the operator drags from Finder onto a terminal on the Desk, or pastes into one as an image.
// The browser never hands a page a dropped file's real path (nor does the WKWebView the Desk runs
// in), so the bytes come to the daemon, land on disk here, and the ABSOLUTE PATH is what gets typed
// into the pty — an agent wants a path it can Read, not an upload.
//
// Where they land is the whole design, and the two obvious places are both wrong:
//
//  - **Not inside a repo** (not the session's cwd, not a `.mc-drops/` beside it). The daemon runs
//    `git add -A` in its own checkout and agents commit in theirs; a screenshot dropped to ask
//    "why does this look wrong" would end up in someone's commit.
//  - **Not under ~/chronos** (where `attachments/` and `tickets/` live). ~/chronos is the chronos
//    workspace's own repo, so it is in every OTHER workspace's `isolationDenyDirs` — a Globex
//    terminal under `guard` gets `file-read*` denied on it. Ticket files work around that with an
//    explicit per-workspace re-grant (`wsTicketsDir`); a drop must work for every terminal, not
//    just the ones whose workspace was re-granted.
//
// `~/.mc` is the neutral path the daemon already uses for exactly this reason — `installMcCli()`
// puts the `mc` binary in `~/.mc/bin` so every sandboxed agent can run it. It is in no deny list
// (`CONFIG.sandbox.secrets`, `projectDirs`, `isolationDenyDirs`) and reads are allow-default under
// both `guard` and `strict`, so every terminal can read it as it stands.
//
// One directory per session rather than one shared pile: a drop is meant for the terminal it was
// dropped on, and workspace scoping is a security boundary everywhere else in this codebase. The
// session's own dir is also what `terminal.ts` grants as an `--add-dir`, so the agent Reads it
// without a permission dance.
export const DROP_ROOT = process.env.CHRONOS_DROPS ?? path.join(os.homedir(), ".mc", "drops");

/**
 * Where a terminal's drops live. Granted per session at spawn (see terminal.ts).
 *
 * The id becomes a path segment, so it is reduced to word characters — a row id is a uuid, but a
 * segment of ".." would put the drop root's PARENT one `path.join` away, and that is not a bug
 * worth leaving for whoever next passes an id in from a request.
 */
export const sessionDropDir = (sessionId: string, root = DROP_ROOT) =>
  path.join(root, String(sessionId).replace(/[^\w-]+/g, "_").slice(0, 80) || "session");

// 25MB. Bigger than the 12MB chat/attachment cap because this is a plain "read this file" hand-off
// — a CSV export or a screen recording is a normal thing to drop, and nothing re-encodes it.
export const MAX_DROP_BYTES = 25 * 1024 * 1024;

export interface Drop {
  path: string;
  name: string;
  size: number;
  mime: string;
}

// Agents work better with meaningful names ("staging-500s.png" beats a uuid), so the original name
// survives — minus anything that could walk out of the drop dir or confuse a shell.
function safeName(raw: string): string {
  const base = path.basename(String(raw || "")).replace(/[/\\]/g, "_");
  return (
    base
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\s]+/, "")
      .slice(0, 180) || "drop"
  );
}

// Dropping the same screenshot twice must not silently overwrite the first — the operator may
// already have told the agent to read it. `shot.png` → `shot-2.png` → `shot-3.png`.
function freeName(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Write one dropped file for a session and return the path to type into its terminal.
 *
 * Any mime: this is not an attachment the daemon interprets, it is a file the agent will open with
 * its own tools. Filtering by type here would only mean "the Desk refuses to hand you a .zip".
 */
/** Make the dir exist at spawn: cursor also maps add-dirs to `--add-dir`, and a missing path there is untested. */
// `root`: a `chronos host` (HOSTS.md phase 3) keeps its drops under ITS home, the same `~/.mc/drops`.
export function ensureDropDir(sessionId: string, root = DROP_ROOT): string {
  const dir = sessionDropDir(sessionId, root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function saveDrop(input: {
  sessionId: string;
  buffer: Buffer;
  filename: string;
  mime?: string;
  root?: string;
}): Drop {
  if (!input.buffer?.length) throw new Error("empty file");
  if (input.buffer.length > MAX_DROP_BYTES)
    throw new Error(`file too large (max ${MAX_DROP_BYTES / 1024 / 1024}MB)`);
  const dir = ensureDropDir(input.sessionId, input.root);
  const name = freeName(dir, safeName(input.filename));
  const filePath = path.join(dir, name);
  // 0o600 like every other operator file the daemon writes: the drop may be a screenshot of a
  // dashboard, and only the agents this Mac spawns as this user have any business reading it.
  fs.writeFileSync(filePath, input.buffer, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return {
    path: filePath,
    name,
    size: input.buffer.length,
    mime: (input.mime || "").toLowerCase().split(";")[0].trim() || "application/octet-stream",
  };
}
