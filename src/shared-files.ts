/**
 * The file shelf (`mc file put|get|ls|rm`): how a file gets from one computer to another.
 *
 * Every computer's `mc` already reaches the brain — directly on the brain's Mac, through the loopback
 * forwarder on a host (HOSTS.md → `mc` on a host) — so the brain is the one place both ends can see.
 * A file is PUT there in chunks from wherever it lives, and GOT from wherever it is wanted. Nothing new
 * crosses the host link: a chunk is an ordinary JSON `mc` request.
 *
 * Who reads and writes the disk is the design:
 *
 *  - **The caller's own `mc` reads the source and writes the destination**, inside that agent's sandbox.
 *    The daemon never opens a path a request named — `/sessions/:id/drop-path` does, and is admin-only
 *    for exactly that reason.
 *  - **The shelf itself is sealed** (config.ts → sandbox.sealed): one workspace's agent must not read
 *    another's file off the brain's disk, and "workspace scoping is a security boundary" (CLAUDE.md #4)
 *    is only true if the API is the only door.
 *
 * Disk, not the database: one directory per file (`<root>/<id>/{meta.json,data}`). A row would say
 * what the directory already does, and the bytes received so far are whatever `data` weighs — a
 * daemon restart mid-upload loses nothing, the sender resumes at that offset.
 *
 * A shelf, not an archive: a file leaves `TTL_DAYS` after it landed, so nobody has to remember to
 * clean up a 2 GB screen recording.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MB = 1024 * 1024;
const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);

export const filesRoot = (): string => process.env.CHRONOS_FILES || path.join(os.homedir(), ".mc", "files");
/**
 * What `mc` is told to send per request. Small on purpose: a chunk rides base64 inside one control
 * frame on the socket every terminal of that host shares, so a fat one stalls their screens.
 */
export const CHUNK_BYTES = MB;
/** The most one chunk request may carry or ask for (the JSON body cap is 16 MB, base64 is ×4/3). */
export const MAX_CHUNK_BYTES = 8 * MB;
export const maxFileBytes = (): number => num(process.env.CHRONOS_FILES_MAX_MB, 2048) * MB;
/** Everything one workspace may keep on the shelf at once. */
export const quotaBytes = (): number => num(process.env.CHRONOS_FILES_QUOTA_MB, 10240) * MB;
export const ttlMs = (): number => num(process.env.CHRONOS_FILES_TTL_DAYS, 7) * 86_400_000;
/** An upload nobody finished: its sender died, or gave up. */
const STALE_UPLOAD_MS = 86_400_000;

export type SharedFile = {
  id: string;
  /** null = the operator's own (put with no workspace): only the admin scope sees it. */
  workspace_id: string | null;
  name: string;
  size: number;
  /** Bytes on disk so far — equal to `size` once ready. */
  received: number;
  status: "uploading" | "ready";
  sha256: string | null;
  note: string | null;
  /** Which computer it came from, by the operator's name for it. */
  from_host: string;
  by: string | null;
  created_at: number;
  expires_at: number | null;
};
type Meta = Omit<SharedFile, "received">;

export class FileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dirOf = (id: string) => path.join(filesRoot(), id);
const dataOf = (id: string) => path.join(dirOf(id), "data");

// The name is what `mc file get` creates on the other computer, so it survives — minus anything
// that could walk out of the destination dir or confuse a shell (drops.ts keeps the same rule).
export function safeName(raw: string): string {
  return (
    path.basename(String(raw || "").replace(/\\/g, "/"))
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\s]+/, "")
      .slice(0, 180) || "file"
  );
}

function writeMeta(m: Meta): void {
  const tmp = path.join(dirOf(m.id), "meta.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dirOf(m.id), "meta.json"));
}

/** One file by its full id, or null. The id is a path segment: anything that is not a uuid is refused. */
export function getFile(id: string): SharedFile | null {
  if (!ID.test(String(id))) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dirOf(id), "meta.json"), "utf8")) as Meta;
    let received = 0;
    try { received = fs.statSync(dataOf(id)).size; } catch {}
    return { ...m, received };
  } catch {
    return null;
  }
}

/** Newest first. `ws` undefined = every workspace (the admin scope); a string or null = exactly that owner. */
export function listFiles(ws?: string | null): SharedFile[] {
  let ids: string[] = [];
  try { ids = fs.readdirSync(filesRoot()); } catch {}
  return ids
    .map((id) => getFile(id))
    .filter((f): f is SharedFile => !!f && (ws === undefined || f.workspace_id === ws))
    .sort((a, b) => b.created_at - a.created_at);
}

/**
 * What a caller typed: a full id, the start of one (`mc file ls` prints 8), or a file's name (the
 * newest ready one wins). Only ever looks inside `ws`, so a ref cannot probe another workspace.
 */
export function resolveFile(ref: string, ws?: string | null): SharedFile | null {
  const r = String(ref || "").trim();
  if (!r) return null;
  const all = listFiles(ws);
  const exact = all.find((f) => f.id === r);
  if (exact) return exact;
  if (/^[0-9a-f-]{4,36}$/.test(r)) {
    const byPrefix = all.filter((f) => f.id.startsWith(r));
    if (byPrefix.length === 1) return byPrefix[0];
  }
  return all.find((f) => f.status === "ready" && f.name === r) ?? null;
}

export function removeFile(id: string): void {
  if (ID.test(String(id))) fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/** Expired files and abandoned uploads leave. Cheap (one readdir), so it runs on every put and ls. */
export function sweepFiles(now = Date.now()): number {
  let n = 0;
  for (const f of listFiles()) {
    const gone = f.status === "ready" ? f.expires_at != null && f.expires_at <= now : f.created_at + STALE_UPLOAD_MS <= now;
    if (gone) { removeFile(f.id); n++; }
  }
  return n;
}

export function beginUpload(input: {
  workspaceId: string | null;
  name: string;
  size: number;
  note?: string | null;
  fromHost: string;
  by?: string | null;
}): SharedFile {
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new FileError(400, "empty file");
  if (size > maxFileBytes()) throw new FileError(413, `file too large (max ${Math.round(maxFileBytes() / MB)} MB)`);
  sweepFiles();
  const held = listFiles(input.workspaceId).reduce((a, f) => a + f.size, 0);
  if (held + size > quotaBytes())
    throw new FileError(413, `the shelf is full (${Math.round(held / MB)} of ${Math.round(quotaBytes() / MB)} MB) — \`mc file rm\` something first`);
  const m: Meta = {
    id: crypto.randomUUID(),
    workspace_id: input.workspaceId,
    name: safeName(input.name),
    size,
    status: "uploading",
    sha256: null,
    note: input.note ? String(input.note).slice(0, 500) : null,
    from_host: input.fromHost,
    by: input.by ? String(input.by).slice(0, 60) : null,
    created_at: Date.now(),
    expires_at: null,
  };
  fs.mkdirSync(dirOf(m.id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dataOf(m.id), "", { mode: 0o600 });
  writeMeta(m);
  return { ...m, received: 0 };
}

/**
 * Bytes at `offset`. Append-only: the offset must be where the file ends — except a chunk that is
 * already there (the sender retried one whose answer was lost), which is acknowledged and not
 * written twice.
 */
export function appendChunk(id: string, offset: number, bytes: Buffer): SharedFile {
  const f = getFile(id);
  if (!f) throw new FileError(404, "not found");
  if (f.status !== "uploading") throw new FileError(409, "this file is already complete");
  if (!bytes.length) throw new FileError(400, "empty chunk");
  if (bytes.length > MAX_CHUNK_BYTES) throw new FileError(413, `chunk over ${MAX_CHUNK_BYTES / MB} MB`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FileError(400, "bad offset");
  if (offset + bytes.length <= f.received) return f;
  if (offset !== f.received) throw new FileError(409, `expected offset ${f.received}, got ${offset}`);
  if (offset + bytes.length > f.size) throw new FileError(400, `more bytes than the ${f.size} declared`);
  fs.appendFileSync(dataOf(id), bytes);
  return { ...f, received: f.received + bytes.length };
}

const hashFile = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });

/** Every byte is in: check the count and (when the sender gave one) the hash, then it is on the shelf. */
export async function completeUpload(id: string, sha256?: string | null): Promise<SharedFile> {
  const f = getFile(id);
  if (!f) throw new FileError(404, "not found");
  if (f.status === "ready") return f;
  if (f.received !== f.size) throw new FileError(409, `incomplete: ${f.received} of ${f.size} bytes`);
  const sum = await hashFile(dataOf(id));
  if (sha256 && sha256.toLowerCase() !== sum) {
    removeFile(id);
    throw new FileError(422, "checksum mismatch — the bytes that arrived are not the bytes that were sent; put it again");
  }
  const { received: _received, ...m } = f;
  writeMeta({ ...m, status: "ready", sha256: sum, expires_at: Date.now() + ttlMs() });
  return getFile(id)!;
}

export function readChunk(id: string, offset: number, length: number): { bytes: Buffer; eof: boolean } {
  const f = getFile(id);
  if (!f) throw new FileError(404, "not found");
  if (f.status !== "ready") throw new FileError(409, "still uploading");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > f.size) throw new FileError(400, "bad offset");
  const want = Math.min(Math.max(1, Math.floor(length) || CHUNK_BYTES), MAX_CHUNK_BYTES, f.size - offset);
  const bytes = Buffer.alloc(want);
  const fd = fs.openSync(dataOf(id), "r");
  try {
    const n = fs.readSync(fd, bytes, 0, want, offset);
    return { bytes: bytes.subarray(0, n), eof: offset + n >= f.size };
  } finally {
    fs.closeSync(fd);
  }
}
