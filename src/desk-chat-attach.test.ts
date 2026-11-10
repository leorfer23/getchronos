/**
 * Screenshots and files in Robert's chat on the Desk.
 *
 * ⌘V a screenshot or drag a file off Finder onto the `#chat` aside and it uploads on the spot, sits
 * in a strip above the composer, and rides the next line you send. Pinned here: the store, which
 * decides what is accepted and where it lands on disk, and what Robert is actually told (absolute
 * paths, not base64 — see chatAttachmentsBlock for why). The routes' admin gate is route-guards.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  saveChatAttachment,
  getChatAttachment,
  chatAttachmentsBlock,
  ATTACH_ROOT,
} from "./attachments.js";

// 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const rm = (p?: string) => { try { if (p) fs.unlinkSync(p); } catch {} };

test("a pasted screenshot lands under chat/<yyyy-mm>/<id>.<ext> and resolves back by id", async () => {
  const a = await saveChatAttachment({ buffer: PNG, filename: "Screenshot 2026-09-16.png", mime: "image/png" });
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(a.path, path.join(ATTACH_ROOT, "chat", month, `${a.id}.png`));
  assert.ok(fs.existsSync(a.path));
  assert.equal(a.mime, "image/png");
  assert.equal(a.size, PNG.length);
  assert.equal(a.name, "Screenshot 2026-09-16.png");
  // The Desk's <img> asks for this; the row is what makes a reload able to find the bytes again.
  assert.equal(a.url, `/api/attachments/chat/${a.id}`);
  assert.deepEqual(getChatAttachment(a.id), a);
  assert.equal(getChatAttachment("nope"), undefined);
  rm(a.path);
});

test("the bytes decide the type, not the name the OS guessed", async () => {
  // A PDF dragged out of a folder where someone had renamed it: stored as the PDF it is, so the
  // Desk chips it instead of putting it in an <img> that never paints.
  const mislabelled = await saveChatAttachment({
    buffer: Buffer.from("%PDF-1.4 not really an image"),
    filename: "diagram.png",
    mime: "image/png",
  });
  assert.equal(mislabelled.mime, "application/pdf");
  assert.ok(mislabelled.path.endsWith(".pdf"));
  rm(mislabelled.path); rm(mislabelled.text_path);

  // A text file is the one accepted thing with no signature — the bytes still have to look like text.
  const txt = await saveChatAttachment({ buffer: Buffer.from("col_a,col_b\n1,2\n"), filename: "rows.csv", mime: "text/csv" });
  assert.equal(txt.mime, "text/plain");
  rm(txt.path);

  // A binary this surface does not take, wearing an accepted content-type.
  await assert.rejects(
    () => saveChatAttachment({ buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]), filename: "bundle.png", mime: "image/png" }),
    /unsupported type|bytes say otherwise/i,
  );
  // Text bytes claiming to be an image: no signature to back it up.
  await assert.rejects(
    () => saveChatAttachment({ buffer: Buffer.from("hello"), filename: "shot.png", mime: "image/png" }),
    /bytes say otherwise/i,
  );
  await assert.rejects(
    () => saveChatAttachment({ buffer: Buffer.alloc(0), filename: "a.png", mime: "image/png" }),
    /empty/i,
  );
  await assert.rejects(
    () => saveChatAttachment({ buffer: Buffer.alloc(13 * 1024 * 1024, 1), filename: "big.txt", mime: "text/plain" }),
    /too large/i,
  );
});

test("what Robert is told is one path per file and an instruction to Read it", () => {
  const block = chatAttachmentsBlock([
    { id: "1", path: "/chronos/attachments/chat/2026-09/1.png", url: "/api/attachments/chat/1", mime: "image/png", name: "shot.png", size: 10 },
    { id: "2", path: "/chronos/attachments/chat/2026-09/2.pdf", url: "/api/attachments/chat/2", mime: "application/pdf", name: "factura.pdf", size: 20, text_path: "/chronos/attachments/chat/2026-09/2.pdf.txt" },
  ]);
  assert.match(block, /open each of them with your Read tool/);
  assert.match(block, /\[attached: \/chronos\/attachments\/chat\/2026-09\/1\.png \(image\/png, shot\.png\)\]/);
  // A PDF with an extracted text layer names it — reading the sidecar is ~5-10x cheaper than the pages.
  assert.match(block, /\[attached: [^\]]*2\.pdf \(application\/pdf, factura\.pdf\)\] text layer: [^\n]*2\.pdf\.txt/);
  // A scanned PDF has no sidecar, and must not be pointed at one that is not there.
  assert.doesNotMatch(
    chatAttachmentsBlock([{ id: "3", path: "/p/3.pdf", url: "/u", mime: "application/pdf", name: "scan.pdf", size: 1 }]),
    /text layer/,
  );
  assert.equal(chatAttachmentsBlock([]), "");
});

