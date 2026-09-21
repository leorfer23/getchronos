import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, tickets } from "./store.js";
import { bus } from "./bus.js";
import { pdfText } from "./pdf-text.js";
import type { TicketAttachment } from "./types.js";
import { inRepo } from "./repo-root.js";

// Operator screenshots / evidence files for ticket validation.
// Files live under ~/chronos/attachments/<workspace_id>/<ticket_id>/<id>.<ext>
// DB row is the index; path on disk is source of truth for agents (Read tool).

export const ATTACH_ROOT =
  process.env.CHRONOS_ATTACHMENTS ?? inRepo("attachments");

const MAX_BYTES = 12 * 1024 * 1024; // 12MB per file
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const now = () => new Date().toISOString();

// Schema bootstrap (also mirrored in store migrations for existing DBs).
db.exec(`
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  caption TEXT,
  source TEXT NOT NULL DEFAULT 'upload',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_ticket ON ticket_attachments(ticket_id);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  text_path TEXT,
  created_at TEXT NOT NULL
);
`);

function extOf(filename: string, mime: string): string {
  const fromName = path.extname(filename || "").toLowerCase().replace(/^\./, "");
  if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[mime] || "bin";
}

function normalizeMime(mime: string, filename: string): string {
  let m = (mime || "").toLowerCase().split(";")[0].trim();
  if (m === "image/jpg") m = "image/jpeg";
  if (!m || m === "application/octet-stream") {
    const e = path.extname(filename || "").toLowerCase();
    if (e === ".png") return "image/png";
    if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
    if (e === ".webp") return "image/webp";
    if (e === ".gif") return "image/gif";
    if (e === ".heic") return "image/heic";
    if (e === ".heif") return "image/heif";
  }
  return m;
}

function absPath(a: TicketAttachment): string {
  return path.join(ATTACH_ROOT, a.workspace_id, a.ticket_id, a.stored_name);
}

function decorate(row: TicketAttachment): TicketAttachment {
  const p = absPath(row);
  return {
    ...row,
    path: p,
    url: `/api/attachments/${row.id}/file`,
  };
}

export function listAttachments(ticketId: string): TicketAttachment[] {
  const rows = db
    .prepare(
      "SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC",
    )
    .all(ticketId) as TicketAttachment[];
  return rows.map(decorate);
}

export function getAttachment(id: string): TicketAttachment | undefined {
  const row = db
    .prepare("SELECT * FROM ticket_attachments WHERE id = ?")
    .get(id) as TicketAttachment | undefined;
  return row ? decorate(row) : undefined;
}

export function countAttachments(ticketId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) c FROM ticket_attachments WHERE ticket_id = ?")
      .get(ticketId) as { c: number }
  ).c;
}

export interface SaveAttachmentInput {
  ticketId: string;
  buffer: Buffer;
  filename: string;
  mime?: string;
  caption?: string | null;
  source?: string;
}

export function saveAttachment(input: SaveAttachmentInput): TicketAttachment {
  const t = tickets.get(input.ticketId);
  if (!t) throw new Error("ticket not found");
  if (!input.buffer?.length) throw new Error("empty file");
  if (input.buffer.length > MAX_BYTES)
    throw new Error(`file too large (max ${MAX_BYTES / 1024 / 1024}MB)`);

  const mime = normalizeMime(input.mime || "", input.filename);
  if (!ALLOWED.has(mime)) {
    throw new Error(
      `unsupported type ${mime || "(unknown)"} — use png/jpeg/webp/gif`,
    );
  }

  const id = randomUUID();
  const ext = extOf(input.filename, mime);
  const stored_name = `${id}.${ext}`;
  const dir = path.join(ATTACH_ROOT, t.workspace_id, t.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, stored_name);
  fs.writeFileSync(filePath, input.buffer, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}

  const filename =
    (input.filename || `screenshot.${ext}`).replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) ||
    `screenshot.${ext}`;

  db.prepare(
    `INSERT INTO ticket_attachments
      (id, ticket_id, workspace_id, filename, stored_name, mime, size, caption, source, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    t.id,
    t.workspace_id,
    filename,
    stored_name,
    mime,
    input.buffer.length,
    input.caption?.trim() || null,
    input.source || "upload",
    now(),
  );

  const row = getAttachment(id)!;
  bus.publish({
    topic: "ticket.updated",
    ticket_id: t.id,
    actor: input.source === "telegram" ? "telegram" : "human",
  });
  return row;
}

export function removeAttachment(id: string): boolean {
  const a = getAttachment(id);
  if (!a) return false;
  try {
    if (a.path && fs.existsSync(a.path)) fs.unlinkSync(a.path);
  } catch {
    /* ignore */
  }
  db.prepare("DELETE FROM ticket_attachments WHERE id = ?").run(id);
  bus.publish({ topic: "ticket.updated", ticket_id: a.ticket_id });
  return true;
}

// ── Chat attachments ────────────────────────────────────────────────────────
// Files dropped into a mission-ui chat composer so the agent can Read them from
// disk: images, PDFs, plain-text documents. No DB row — the absolute path rides
// inside the chat message itself, so history and --resume sessions carry it for
// free. Stored under ATTACH_ROOT/chat/<thread>/, which every sandbox mode can
// read (guard/strict are allow-default on reads and this root is in no deny list).

const CHAT_TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "log", "yml", "yaml", "xml", "html", "toml", "ini",
]);

export interface ChatFile {
  path: string;
  filename: string;
  mime: string;
  size: number;
  /** Sidecar with the PDF's extracted text layer — ~5-10x cheaper to Read than
   *  vision-reading the PDF. Absent for non-PDFs and scanned PDFs (no text layer). */
  text_path?: string;
}

// Images resolve through the ticket-attachment map; everything else is pdf or text-ish.
function chatMime(mime: string, filename: string): string {
  const m = normalizeMime(mime || "", filename);
  if (ALLOWED.has(m)) return m;
  const ext = path.extname(filename || "").toLowerCase().replace(/^\./, "");
  if (m === "application/pdf" || ext === "pdf") return "application/pdf";
  if (m.startsWith("text/") || m === "application/json" || CHAT_TEXT_EXTS.has(ext)) return "text/plain";
  throw new Error(
    `unsupported type ${m || "(unknown)"} — use images, pdf, or plain text (txt/md/csv/json…)`,
  );
}

export async function saveChatFile(input: {
  thread: string;
  buffer: Buffer;
  filename: string;
  mime?: string;
}): Promise<ChatFile> {
  if (!input.buffer?.length) throw new Error("empty file");
  if (input.buffer.length > MAX_BYTES)
    throw new Error(`file too large (max ${MAX_BYTES / 1024 / 1024}MB)`);
  const thread =
    (input.thread || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
  const filename =
    (input.filename || "").replace(/[^\w.\- ()[\]]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 180) || "file";
  const mime = chatMime(input.mime || "", filename);
  const dir = path.join(ATTACH_ROOT, "chat", thread);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${randomUUID().slice(0, 8)}-${filename}`);
  fs.writeFileSync(filePath, input.buffer, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
  const out: ChatFile = { path: filePath, filename, mime, size: input.buffer.length };
  // PDFs get their text layer extracted next to them, so agents Read cheap text
  // instead of vision-reading pages. Best-effort: a scanned/broken PDF just ships
  // without the sidecar and the agent falls back to Read on the PDF itself.
  if (mime === "application/pdf") {
    try {
      const text = await pdfText(input.buffer);
      if (text) {
        const textPath = filePath + ".txt";
        fs.writeFileSync(textPath, text, { mode: 0o600 });
        out.text_path = textPath;
      }
    } catch {}
  }
  return out;
}

/** Markdown block injected into build/review agent goals so they can Read images. */
export function formatAttachmentsBlock(ticketId: string): string {
  const list = listAttachments(ticketId);
  if (!list.length) return "";
  const lines = list.map((a, i) => {
    const cap = a.caption ? ` — ${a.caption.replace(/\n/g, " ").slice(0, 120)}` : "";
    return `${i + 1}. \`${a.path}\` (${a.filename}, ${a.mime})${cap}`;
  });
  return (
    `\n## Attachments (screenshots / evidence)\n` +
    `These files are on disk for this ticket. Use the Read tool (vision) to inspect images when validating UI or acceptance criteria.\n` +
    lines.join("\n") +
    `\n`
  );
}

/** Pull ticket KEY from free text (caption / message). */
export function extractTicketKey(text: string): string | null {
  if (!text) return null;
  const m = text.match(/\b([A-Z]{2,6}-\d+)\b/);
  return m ? m[1] : null;
}

// ── Desk chat attachments ───────────────────────────────────────────────────
// Screenshots pasted (⌘V) or files dragged from Finder into Robert's chat on the Desk. Unlike the
// `chat/<thread>/` files above — whose absolute path rides inside the message text and is never
// looked up again — these have to resolve by id long after the turn: the chat log redraws its
// thumbnails from `chat_messages.attachments` on every reload, and an <img> can only ask for
// `/api/attachments/chat/<id>`. So this one keeps a row, exactly like ticket_attachments does, and
// the path on disk stays the source of truth for the agent's Read tool.
// Laid out by month (`chat/<yyyy-mm>/<id>.<ext>`) rather than by thread: a Desk chat has no thread
// to name (one log, N conversations), and a month is what makes the directory hand-prunable.

export interface ChatAttachment {
  id: string;
  /** Absolute, for the model's Read tool. */
  path: string;
  /** Admin-gated route the Desk fetches the bytes from. */
  url: string;
  mime: string;
  name: string;
  size: number;
  /** PDFs with a text layer: the cheap sidecar (see saveChatFile). */
  text_path?: string;
}

interface ChatAttachmentRow {
  id: string;
  rel_path: string;
  name: string;
  mime: string;
  size: number;
  text_path: string | null;
  created_at: string;
}

// What the bytes actually ARE, for the handful of types this accepts. The Content-Type a browser
// puts on a drop is whatever the OS guessed from the extension, so a `.png` that is really a zip
// passed chatMime(), landed in an <img> that never paints, and came back from Read as an empty
// file. A signature that matches beats the declaration. Text has no signature, which is why the
// no-signature case is checked against the bytes instead (isTextish).
function sniffMime(b: Buffer): string | null {
  const at = (i: number, n: number) => b.subarray(i, i + n).toString("latin1");
  if (b.length >= 8 && at(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (at(0, 6) === "GIF87a" || at(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && at(0, 4) === "RIFF" && at(8, 4) === "WEBP") return "image/webp";
  // HEIC/HEIF are ISO-BMFF containers: `....ftyp<brand>`. The brand says which one (an iPhone
  // screenshot arrives as heic; Preview's "HEIF" export as mif1).
  if (b.length >= 12 && at(4, 4) === "ftyp") {
    const brand = at(8, 4);
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs)$/.test(brand)) return "image/heic";
    if (/^(mif1|msf1)$/.test(brand)) return "image/heif";
  }
  if (b.length >= 5 && at(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

// A NUL byte in the first pages is the cheap "this is not a document" test. Without it any binary
// whose magic this file does not know (a .zip, a .mov) is accepted as text/plain, stored, and then
// handed to the model as something to Read.
const isTextish = (b: Buffer): boolean => !b.subarray(0, 4096).includes(0);

const chatAttachRel = (row: ChatAttachmentRow): string => row.rel_path;

function decorateChat(row: ChatAttachmentRow): ChatAttachment {
  return {
    id: row.id,
    path: path.join(ATTACH_ROOT, chatAttachRel(row)),
    url: `/api/attachments/chat/${row.id}`,
    mime: row.mime,
    name: row.name,
    size: row.size,
    ...(row.text_path ? { text_path: path.join(ATTACH_ROOT, row.text_path) } : {}),
  };
}

export function getChatAttachment(id: string): ChatAttachment | undefined {
  const row = db
    .prepare("SELECT * FROM chat_attachments WHERE id = ?")
    .get(id) as ChatAttachmentRow | undefined;
  return row ? decorateChat(row) : undefined;
}

export async function saveChatAttachment(input: {
  buffer: Buffer;
  filename: string;
  mime?: string;
}): Promise<ChatAttachment> {
  if (!input.buffer?.length) throw new Error("empty file");
  if (input.buffer.length > MAX_BYTES)
    throw new Error(`file too large (max ${MAX_BYTES / 1024 / 1024}MB)`);
  const name =
    (input.filename || "").replace(/[^\w.\- ()[\]]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 180) || "file";
  const sniffed = sniffMime(input.buffer);
  // chatMime() decides what this SURFACE accepts (images / pdf / text) and throws with the list for
  // anything else; the sniff decides what the bytes are. Both have to agree before it is stored.
  const claimed = chatMime(input.mime || "", name);
  const mime = sniffed ?? claimed;
  if (sniffed) {
    // Named .png, actually a PDF: store it as the PDF it is (the Desk chips it, the model Reads it)
    // rather than as a broken image — but run it back through chatMime so an unaccepted type that
    // happens to have a signature still cannot get in.
    chatMime(mime, name);
  } else if (!isTextish(input.buffer)) {
    throw new Error("unsupported type — use images, pdf, or plain text (txt/md/csv/json…)");
  } else if (mime !== "text/plain") {
    // No signature but claimed to be an image: it is not one.
    throw new Error(`not a ${mime} — the file's bytes say otherwise`);
  }

  const id = randomUUID();
  const ext = mime === "application/pdf" ? "pdf" : mime === "text/plain" ? "txt" : extOf(name, mime);
  const month = new Date().toISOString().slice(0, 7); // yyyy-mm: hand-prunable, and a Desk chat has no thread to file under
  const rel = path.join("chat", month, `${id}.${ext}`);
  const abs = path.join(ATTACH_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, input.buffer, { mode: 0o600 });
  try { fs.chmodSync(abs, 0o600); } catch {}

  // Same deal as saveChatFile: a PDF gets its text layer next to it, ~5-10x cheaper to Read than
  // vision-reading the pages. A scanned PDF has no layer and just ships without the sidecar.
  let textRel: string | null = null;
  if (mime === "application/pdf") {
    try {
      const text = await pdfText(input.buffer);
      if (text) {
        textRel = rel + ".txt";
        fs.writeFileSync(path.join(ATTACH_ROOT, textRel), text, { mode: 0o600 });
      }
    } catch {}
  }

  db.prepare(
    `INSERT INTO chat_attachments (id, rel_path, name, mime, size, text_path, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, rel, name, mime, input.buffer.length, textRel, now());
  return getChatAttachment(id)!;
}

/**
 * The attachment lines appended to a chat turn's prompt — NOT to the stored `you`, which stays the
 * words the operator typed (the Desk redraws thumbnails from the row's `attachments`, so a path in
 * the bubble would be noise the operator has to read past forever).
 *
 * Text, not content blocks, on purpose: Robert's turn is written to a warm `claude -p` process as a
 * single text block (WarmManager.write), and a turn that fails over to another provider is re-sent
 * as the same text (withProviderFallback's primaryOn). A path works on every backend, claude-code
 * reads images natively through its Read tool, and nothing has to be base64'd into the prompt twice.
 */
export function chatAttachmentsBlock(list: ChatAttachment[]): string {
  if (!list.length) return "";
  const lines = list.map(
    (a) =>
      `[attached: ${a.path} (${a.mime}, ${a.name})]` +
      // A scanned PDF ships without a sidecar — say nothing rather than point at a path that is
      // not there, or the model reports the file as empty instead of vision-reading it.
      (a.text_path ? ` text layer: ${a.text_path}` : ""),
  );
  return (
    `\n\nThe operator attached ${list.length === 1 ? "this file" : "these files"} to this message — open ${list.length === 1 ? "it" : "each of them"} with your Read tool before answering.\n` +
    lines.join("\n")
  );
}
