/**
 * HTTP doors for a file the operator drops on a Desk terminal (src/drops.ts is the disk side).
 * Handlers, not inline routes, so the tests drive the code that actually serves the request — the
 * same shape as inbox-routes.ts / artifact-routes.ts.
 *
 *  POST /sessions/:id/drop        raw bytes in (any content-type), `{path,name,size,mime}` out
 *  POST /sessions/:id/drop-path   `{paths:[…]}` — files on the BRAIN's disk, copied the same way
 *
 * Both end in `deliverDrop`, which is the one place that knows a terminal on another computer
 * (HOSTS.md) reads files from ITS disk: the bytes go over the host link and the host writes them
 * into its own ~/.mc/drops/<session>, so the path that comes back is a path over there.
 *
 * Admin-gated with the inline check /input uses, and deliberately NOT open to a Lead: a Lead types
 * words it composed itself, whereas a drop writes bytes to a path it then hands another agent — and
 * /drop-path reads any file the daemon's user can. Only the operator at the Desk drops files.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { tokenOk } from "./authz.js";
import { sessions } from "./store.js";
import { findHost, LOCAL_HOST_ID } from "./hosts/index.js";
import { RemoteHost } from "./hosts/remote.js";
import { saveDrop, MAX_DROP_BYTES, type Drop } from "./drops.js";
import type { Session } from "./types.js";

type Req = express.Request;
type Res = express.Response;

/** Largest drop forwarded to a remote host: it travels base64 in one control frame (cap 24 MB). */
export const REMOTE_DROP_MAX = 16 * 1024 * 1024;

/**
 * How many files one /drop-path takes. A Finder multi-select is a handful; a hundred is a script,
 * and every one of them is a read of the brain's disk plus (remote) a 16 MB frame over the link.
 */
export const DROP_PATHS_MAX = 20;

/** Where the Express app mounts the byte route — the app-level pre-parser below needs the full URL. */
const DROP_URL = "/api/sessions/:id/drop";

/**
 * The app's body parsers, in the one order that lets a drop keep its bytes.
 *
 * The app-wide express.json() used to be the first thing on the app, and it eats any body whose
 * content-type it recognises — `application/json`, which is exactly what the Desk sends for a
 * dropped `google-services.json` (it forwards `File.type`). body-parser then marks the request as
 * read, the route's own express.raw() skips it, and the handler sees `{}` → "empty file". /agent/
 * attach hit the same wall and worked around it by making the page lie (`text/plain`); a drop can't
 * do that, because the mime is what the remote host records. So the drop route gets its raw parser
 * on the APP, ahead of express.json(), and the roles invert: raw marks the request read, json skips.
 * `type: () => true` — every content-type is bytes here, including none at all.
 */
export function mountBodyParsers(app: express.Express): void {
  app.post(DROP_URL, express.raw({ type: () => true, limit: MAX_DROP_BYTES }));
  // 16mb: ticket attachment base64 uploads; normal JSON stays small.
  app.use(express.json({ limit: "16mb" }));
}

export class DropError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const isRemote = (s: Pick<Session, "host_id">): boolean => !!s.host_id && s.host_id !== LOCAL_HOST_ID;

/** The per-file cap for a terminal: the link's frame for another computer, the disk cap for this one. */
export const dropCap = (s: Pick<Session, "host_id">): number => (isRemote(s) ? REMOTE_DROP_MAX : MAX_DROP_BYTES);

/**
 * One file into one terminal's drop dir, wherever that terminal runs. Throws DropError with the
 * status the route should answer; the byte route and the path route share it so the remote-forward
 * rules (host online, frame cap, base64) live in exactly one place.
 */
export async function deliverDrop(s: Session, f: { buffer: Buffer; filename: string; mime: string }): Promise<Drop> {
  if (isRemote(s)) {
    const h = findHost(s.host_id!);
    if (!(h instanceof RemoteHost) || !h.online) throw new DropError(409, "this terminal's host is offline");
    if (!f.buffer?.length) throw new DropError(400, "empty file");
    // One control frame carries it (base64, ×4/3) and the link caps a frame at 24 MB.
    if (f.buffer.length > REMOTE_DROP_MAX)
      throw new DropError(413, `a file dropped on a terminal on another host is capped at ${REMOTE_DROP_MAX / 1024 / 1024}MB`);
    try {
      return await h.drop({ session_id: s.id, filename: f.filename, mime: f.mime, b64: f.buffer.toString("base64") });
    } catch (e: any) {
      throw new DropError(400, String(e?.message ?? e));
    }
  }
  try {
    return saveDrop({ sessionId: s.id, buffer: f.buffer, filename: f.filename, mime: f.mime });
  } catch (e: any) {
    throw new DropError(400, String(e?.message ?? e));
  }
}

/** The admin check and the row, or a response already written. */
function gate(req: Req, res: Res): Session | null {
  if (!tokenOk(req.get("x-mc-admin"), CONFIG.adminToken)) {
    res.status(403).json({ error: "dropping a file on a terminal is admin-gated (x-mc-admin)" });
    return null;
  }
  const s = sessions.get(req.params.id);
  if (!s) { res.status(404).json({ error: "not found" }); return null; }
  return s;
}

const fail = (res: Res, e: unknown) =>
  e instanceof DropError ? res.status(e.status).json({ error: e.message }) : res.status(500).json({ error: String((e as any)?.message ?? e) });

/**
 * POST /sessions/:id/drop — a File the page read out of a drag or a paste, as raw bytes. Raw body
 * rather than multipart because a Blob needs no encoding to send that way; see mountBodyParsers for
 * why the bytes survive whatever content-type they arrive with.
 */
export async function dropRoute(req: Req, res: Res): Promise<void> {
  const s = gate(req, res);
  if (!s) return;
  // Belt and braces: if anything ever parses this body before the pre-parser does, say so instead
  // of writing a zero-byte "empty file" the operator can't explain.
  if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: "expected the file's raw bytes" }); return; }
  try {
    const d = await deliverDrop(s, {
      buffer: req.body,
      filename: String(req.get("x-filename") || req.query.filename || "drop"),
      mime: String(req.get("content-type") || ""),
    });
    res.status(201).json(d);
  } catch (e) {
    fail(res, e);
  }
}

/**
 * POST /sessions/:id/drop-path {paths} — files named by their path on THIS Mac (the brain), for a
 * terminal on ANOTHER one.
 *
 * The Desk runs on the brain. When it knows a dropped file's real path (the native wrapper's
 * __deskDrop, a `File.path`, a file:// URI off the drag) it types that path in verbatim — right for a
 * terminal here, and exactly wrong for one on the M2, where `/Users/<brain user>/Downloads/x.json`
 * does not exist. A page cannot read a file by path, so the daemon does: same caps, same delivery.
 * Every path is checked before any byte moves, so a bad one in a multi-drop sends nothing at all
 * rather than half the selection.
 */
export async function dropPathRoute(req: Req, res: Res): Promise<void> {
  const s = gate(req, res);
  if (!s) return;
  const raw = req.body?.paths;
  if (!Array.isArray(raw) || !raw.length || raw.some((p) => typeof p !== "string" || !p)) {
    res.status(400).json({ error: "paths: a non-empty list of absolute paths" });
    return;
  }
  if (raw.length > DROP_PATHS_MAX) { res.status(400).json({ error: `at most ${DROP_PATHS_MAX} files per drop` }); return; }
  const cap = dropCap(s);
  const files: string[] = [];
  for (const p of raw as string[]) {
    if (!path.isAbsolute(p)) { res.status(400).json({ error: `${p}: not an absolute path` }); return; }
    // stat, not lstat: a Finder alias-by-symlink is still the file the operator meant. What must
    // not get through is a folder (an agent wants a file; a tree would need a tar) or a device/fifo
    // (a read that never ends).
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { res.status(404).json({ error: `${p}: no such file on this Mac` }); return; }
    if (!st.isFile()) { res.status(400).json({ error: `${p}: not a regular file — drop files, not folders` }); return; }
    if (st.size > cap) { res.status(413).json({ error: `${path.basename(p)}: max ${cap / 1024 / 1024}MB for this terminal` }); return; }
    files.push(p);
  }
  const out: Drop[] = [];
  try {
    // deliverDrop re-checks the size on the bytes it actually read: a file still being written
    // between the stat and the read is capped all the same.
    for (const p of files) {
      let buffer: Buffer;
      try { buffer = fs.readFileSync(p); } catch (e: any) { throw new DropError(400, `${p}: ${e?.code ?? e?.message ?? e}`); }
      out.push(await deliverDrop(s, { buffer, filename: path.basename(p), mime: "" }));
    }
  } catch (e) {
    return void fail(res, e);
  }
  res.status(201).json({ drops: out, paths: out.map((d) => d.path) });
}
