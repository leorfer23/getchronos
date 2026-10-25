/**
 * A terminal's media: the files the operator dropped on it and the images the agent looked at, wrote
 * or captured — the screenshot it took of the page it just fixed, the mockup you handed it.
 *
 * The companion rail shows them as a strip of thumbnails, because "what did it see?" is a question
 * the scrollback answers badly: a screenshot is a path in a line of output, and the bytes are on disk.
 *
 * Where they come from:
 *   · the session's drop dir (src/drops.ts) — everything there, image or not: the operator put it there.
 *   · the Focus feed — any image path in what was typed (a Finder drop on a local terminal types the
 *     file's REAL path rather than copying it, see desk.html __deskDrop), what the agent said, or a
 *     tool call (Read/Write of a .png, `screencapture x.png`, an MCP screenshot with a filePath).
 *
 * Only files that exist on THIS disk are listed, and the file route serves only what this list
 * contains — the list is the allowlist, so the route can never become "read any path". A terminal on
 * another computer (HOSTS.md) has its files over there: it lists nothing rather than guessing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DROP_ROOT, sessionDropDir } from "./drops.js";
import { LOCAL_HOST_ID } from "./hosts/index.js";
import type { FocusEvent } from "./focus.js";
import type { Session } from "./types.js";

// Raster images only. An SVG is a document that can carry script, and the Desk opens a thumbnail's
// bytes as a same-origin blob — so it is a plain file here, never a picture.
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp"];
const IMG_RE = new RegExp(`\\.(?:${IMG_EXT.join("|")})$`, "i");
const EXT = IMG_EXT.join("|");
// A path in free text: absolute or ~-rooted, ending in an image extension. Quoted first (shq() quotes
// a dropped path with spaces), then bare.
const QUOTED_RE = new RegExp(`(['"])((?:~|/)[^'"\\n]*?\\.(?:${EXT}))\\1`, "gi");
const BARE_RE = new RegExp(`(?:^|[\\s(=:,])((?:~|/)[^\\s'"\`<>()]*?\\.(?:${EXT}))(?=$|[\\s'"\`.,;:)\\]])`, "gim");

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", bmp: "image/bmp",
};

const MAX_MEDIA = 30;
const MAX_BYTES = 25 * 1024 * 1024;

export interface MediaItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
  image: boolean;
  /** "drop": the operator handed it over. "agent": it showed up in what the agent did or said. */
  source: "drop" | "agent";
}

const isImage = (p: string) => IMG_RE.test(p);
export const mediaMime = (p: string): string =>
  MIME[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";

const expand = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

/** Image paths a feed mentions, each tagged with who brought it in. Pure — no disk. */
export function mediaPathsFromFeed(events: FocusEvent[] | null | undefined): { path: string; source: MediaItem["source"] }[] {
  const out = new Map<string, MediaItem["source"]>();
  for (const e of events || []) {
    if (!e || e.kind === "think") continue;
    const text = String(e.text ?? "");
    if (!text) continue;
    const source = e.kind === "user" ? "drop" : "agent";
    const found: string[] = [];
    for (const m of text.matchAll(QUOTED_RE)) found.push(m[2]);
    for (const m of text.matchAll(BARE_RE)) found.push(m[1]);
    for (const raw of found) {
      const p = path.normalize(expand(raw.trim()));
      if (!path.isAbsolute(p) || !isImage(p)) continue;
      // First sighting decides who brought it: a drop the agent then Reads is still your drop.
      if (!out.has(p)) out.set(p, source);
    }
  }
  return [...out].map(([p, source]) => ({ path: p, source }));
}

function stat(p: string): fs.Stats | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0 && st.size <= MAX_BYTES ? st : null;
  } catch {
    return null;
  }
}

/** Newest first, capped. Files that are gone, empty or too big are simply not media any more. */
export function sessionMedia(
  s: Pick<Session, "id" | "host_id">,
  events: FocusEvent[],
  root = DROP_ROOT,
): MediaItem[] {
  if (s.host_id && s.host_id !== LOCAL_HOST_ID) return [];
  const items = new Map<string, MediaItem>();
  const add = (p: string, source: MediaItem["source"]) => {
    let real: string;
    try { real = fs.realpathSync(p); } catch { return; }
    if (items.has(real)) return;
    const st = stat(real);
    if (!st) return;
    items.set(real, { path: real, name: path.basename(real), size: st.size, mtime: st.mtimeMs, image: isImage(real), source });
  };
  const dir = sessionDropDir(s.id, root);
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) if (!n.startsWith(".")) add(path.join(dir, n), "drop");
  for (const m of mediaPathsFromFeed(events)) add(m.path, m.source);
  return [...items.values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_MEDIA);
}

/** The listed item a request names, or null — the only way the file route finds a path to read. */
export function findMedia(list: MediaItem[], requested: string): MediaItem | null {
  if (!requested) return null;
  let real: string;
  try { real = fs.realpathSync(path.resolve(String(requested))); } catch { return null; }
  return list.find((m) => m.path === real) ?? null;
}
