import { tg, send, esc, TOKEN } from "./api.js";
import { tickets as ticketStore, kv } from "../store.js";
import {
  saveAttachment,
  extractTicketKey,
  countAttachments,
} from "../attachments.js";
import { appendNote } from "../tickets.js";
import { deliverToActiveExec } from "./agent.js";

// Telegram photos / image documents → ticket attachments (validation screenshots).

const MAX_BYTES = 12 * 1024 * 1024;
const pinKey = (chatId: number) => `tg.attachTicket.${chatId}`;

export function getAttachTicketId(chatId: number): string | undefined {
  const v = kv.get(pinKey(chatId));
  return v || undefined;
}

export function setAttachTicketId(chatId: number, ticketId: string | null) {
  if (!ticketId) kv.set(pinKey(chatId), "");
  else kv.set(pinKey(chatId), ticketId);
}

function resolveTicket(chatId: number, caption: string, workspaceId?: string) {
  const key = extractTicketKey(caption || "");
  if (key) {
    const scoped = ticketStore.list(
      workspaceId ? { workspace_id: workspaceId } : {},
    );
    const hit =
      scoped.find((t) => t.key === key) ||
      ticketStore.list({}).find((t) => t.key === key);
    if (hit) {
      setAttachTicketId(chatId, hit.id);
      return hit;
    }
  }
  const pinned = getAttachTicketId(chatId);
  if (pinned) {
    const t = ticketStore.get(pinned);
    if (t) return t;
  }
  return null;
}

async function downloadTelegramFile(
  fileId: string,
): Promise<{ buf: Buffer; pathHint: string }> {
  const fileRes: any = await tg("getFile", { file_id: fileId });
  const filePath = fileRes?.result?.file_path as string | undefined;
  if (!filePath) throw new Error("couldn't resolve file");
  const r = await fetch(
    `https://api.telegram.org/file/bot${TOKEN}/${filePath}`,
  );
  if (!r.ok) throw new Error("download failed");
  const ab = await r.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) throw new Error("file too large (max 12MB)");
  return { buf: Buffer.from(ab), pathHint: filePath };
}

export type TgPhotoSize = {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
};
export type TgDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

/** Handle photo or image document. Returns true if this message was consumed. */
export async function handleMedia(
  chatId: number,
  msg: {
    message_id: number;
    caption?: string;
    photo?: TgPhotoSize[];
    document?: TgDocument;
  },
  workspaceId?: string,
): Promise<boolean> {
  const caption = (msg.caption || "").trim();
  let fileId: string | undefined;
  let filename = "screenshot.jpg";
  let mime = "image/jpeg";

  if (msg.photo?.length) {
    const best = [...msg.photo].sort(
      (a, b) =>
        (b.file_size ?? b.width ?? 0) - (a.file_size ?? a.width ?? 0),
    )[0];
    fileId = best?.file_id;
    filename = "photo.jpg";
    mime = "image/jpeg";
  } else if (msg.document) {
    const mt = (msg.document.mime_type || "").toLowerCase();
    if (!mt.startsWith("image/")) return false;
    fileId = msg.document.file_id;
    filename = msg.document.file_name || "image.bin";
    mime = mt;
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      await send(
        chatId,
        "image too large (max 12MB)",
        undefined,
        msg.message_id,
      );
      return true;
    }
  } else {
    return false;
  }

  if (!fileId) return false;

  const ticket = resolveTicket(chatId, caption, workspaceId);
  if (!ticket) {
    await send(
      chatId,
      "📸 Got an image, but no ticket target.\n" +
        "• Caption with a key: <code>PER-4 before fix</code>\n" +
        "• Or tell me: <i>attach next screenshots to PER-4</i>, then resend\n",
      undefined,
      msg.message_id,
    );
    if (caption && !extractTicketKey(caption)) {
      void deliverToActiveExec(chatId, caption, msg.message_id);
    }
    return true;
  }

  try {
    const { buf, pathHint } = await downloadTelegramFile(fileId);
    const hintExt = pathHint.split(".").pop();
    if (hintExt && hintExt.length <= 5 && filename === "photo.jpg") {
      filename = `photo.${hintExt}`;
      if (hintExt === "png") mime = "image/png";
      if (hintExt === "webp") mime = "image/webp";
    }

    const cleanCap = caption
      .replace(new RegExp(`\\b${ticket.key}\\b`, "i"), "")
      .replace(/^\s*[-:]\s*/, "")
      .trim();

    const att = saveAttachment({
      ticketId: ticket.id,
      buffer: buf,
      filename,
      mime,
      caption: cleanCap || null,
      source: "telegram",
    });

    try {
      appendNote(
        ticket.id,
        `Screenshot attached via Telegram: ${att.filename}${cleanCap ? ` (${cleanCap})` : ""}`,
        "telegram",
      );
    } catch {
      /* best-effort */
    }

    const n = countAttachments(ticket.id);
    await send(
      chatId,
      `📎 Saved to <b>${esc(ticket.key)}</b> · ${esc(att.filename)}` +
        (cleanCap ? `\n<i>${esc(cleanCap)}</i>` : "") +
        `\n<i>${n} attachment${n === 1 ? "" : "s"} on ticket</i>`,
      undefined,
      msg.message_id,
    );
  } catch (e: any) {
    await send(
      chatId,
      "⚠️ " + esc(String(e?.message ?? e)),
      undefined,
      msg.message_id,
    );
  }
  return true;
}

/** Text-only: "attach next to PER-4" / "pin attachments to PER-4". */
export function tryPinAttachTarget(
  chatId: number,
  text: string,
  workspaceId?: string,
): string | null {
  const m = text.match(
    /(?:attach\s+next(?:\s+(?:photos?|screenshots?|images?))?\s+to|pin\s+attachments?\s+to|screenshots?\s+for)\s+([A-Z]{2,6}-\d+)/i,
  );
  if (!m) return null;
  const key = m[1].toUpperCase();
  const list = ticketStore.list(
    workspaceId ? { workspace_id: workspaceId } : {},
  );
  const hit =
    list.find((t) => t.key === key) ||
    ticketStore.list({}).find((t) => t.key === key);
  if (!hit) return `No ticket ${key}`;
  setAttachTicketId(chatId, hit.id);
  return `Next photos will attach to ${hit.key} until you change target.`;
}
