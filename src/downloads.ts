/**
 * The operator's Downloads, one folder per workspace: where an agent puts a file he will send or share
 * (an xlsx, a csv, a pdf, a zip, an html export, a chart). He kept asking for it — "put it in
 * Downloads" — so it is the default for every terminal and every headless run that can write.
 *
 * ~/Downloads itself is shared by every workspace, so one flat folder would hand one client's files to
 * another client's agents. Each workspace gets `~/Downloads/<Workspace name>/` instead: granted to its
 * own agents (terminal.ts / runner.ts add it like the tickets dir and pass its path as MC_DOWNLOADS) and
 * denied to every other workspace's (store/workspaces.ts isolationDenyDirs). This module is the pure
 * half: the root, the folder name, and which workspace gets which folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ~/Downloads, resolved (Seatbelt matches real paths). `CHRONOS_DOWNLOADS_DIR` wins; a test run that
 * did not pick one gets a per-process temp dir — tests create workspaces by the hundred, and none of
 * their folders belongs in the real Downloads of whoever runs the suite.
 */
export function downloadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const underTest = env.CHRONOS_TEST === "1" || env.NODE_TEST_CONTEXT != null;
  const dir = env.CHRONOS_DOWNLOADS_DIR
    || (underTest ? path.join(os.tmpdir(), `chronos-test-downloads-${process.pid}`) : path.join(os.homedir(), "Downloads"));
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * A workspace name as one folder name: no slash, backslash, colon or control character, no leading dot
 * (hidden) or dash, no trailing dot or space, at most 80 characters and 120 bytes (APFS caps a name at
 * 255, and a disambiguating suffix may follow). "" when nothing is left.
 */
export function folderName(name: string | null | undefined): string {
  const clean = String(name ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, "-")
    .replace(/^[\s.-]+/, "");
  // By code point, so an emoji is never cut in half.
  const chars = Array.from(clean).slice(0, 80);
  while (chars.length && Buffer.byteLength(chars.join("")) > 120) chars.pop();
  return chars.join("").replace(/[\s.]+$/, "");
}

/**
 * The key two names collide on. APFS (and Seatbelt on it) treats names as one folder by case and
 * Unicode form, full folding included: "Straße" and "STRASSE" are one directory. This folds at least as
 * much — compatibility forms too — so two names it keeps apart are never one folder on disk.
 */
const same = (folder: string) => folder.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");

export type FolderRow = { id: string; slug: string; name: string };

/**
 * Which folder each workspace gets. `rows` = every workspace, oldest first; `held` = every folder a
 * workspace was ever given (store/workspaces.ts ensureDownloadsDir), deleted workspaces included. Two
 * workspaces never share a folder — a shared one would be granted to both:
 *  - a folder someone holds stays theirs: a rename gives a new folder and the old one stays walled from
 *    everyone else, and a newcomer named like it gets another;
 *  - otherwise the name, else "<name> (<slug>)", else "<name> (<id>)" — the first one that is free;
 *  - oldest first, so a newer workspace with the same name never takes an older one's folder.
 */
export function assignFolders(rows: FolderRow[], held: Record<string, string[]> = {}): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [id, list] of Object.entries(held)) for (const f of list) if (!owner.has(same(f))) owner.set(same(f), id);
  const out = new Map<string, string>();
  for (const w of rows) {
    const base = folderName(w.name) || folderName(w.slug) || w.id;
    const cands = [base, `${base} (${folderName(w.slug) || w.id})`, `${base} (${w.id})`];
    const pick = cands.find((c) => owner.get(same(c)) === w.id) ?? cands.find((c) => !owner.has(same(c))) ?? w.id;
    owner.set(same(pick), w.id);
    out.set(w.id, pick);
  }
  return out;
}

/** The standing line for a headless run that has a Downloads folder (runner.ts): where its files go. */
export const HEADLESS_DELIVER =
  "Files for the operator — anything he will send or share (xlsx, csv, pdf, zip, an html export, a chart png) — go in " +
  "$MC_DOWNLOADS, his Downloads folder for this workspace. A reply to someone is a draft where they asked. " +
  "Your final message names each file by its full path, and each draft.";
