/**
 * Screenshots and files in Robert's chat on the Desk.
 *
 * ⌘V a screenshot or drag a file off Finder onto the `#chat` aside and it uploads on the spot, sits
 * in a strip above the composer, and rides the next line you send. Two halves are pinned here:
 *
 *  - the store + the turn, which decide what is accepted, where it lands on disk, and what Robert
 *    is actually told (absolute paths, not base64 — see chatAttachmentsBlock for why);
 *  - the client, which lives entirely in static/desk.html and has no build step, so a regex over
 *    the file is the only thing that notices a behaviour going missing.
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

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");

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

test("Desk chat head has a model picker wired to GET/POST /agent/model", () => {
  assert.match(html, /id="chat-model"/);
  assert.match(html, /loadRobertModel/);
  assert.match(html, /api\("\/agent\/model"\)/);
  assert.match(html, /api\("\/agent\/model", \{ method: "POST", body: JSON\.stringify\(\{ model \}\) \}/);
  assert.match(api, /api\.get\("\/agent\/model", requireAdmin/);
  assert.match(api, /api\.post\("\/agent\/model", requireAdmin, validate\(AgentModelSchema\)/);
});

test("the endpoints: upload is admin-gated raw bytes, the file comes back by id", () => {
  assert.match(api, /api\.post\(\s*"\/agent\/attach",\s*requireAdmin,\s*express\.raw\(\{ type: \(\) => true, limit: "15mb" \}\)/);
  assert.match(api, /api\.get\("\/attachments\/chat\/:id", requireAdmin,/);
  // The app-level express.json() reads a JSON body before the raw parser can, so the bytes never
  // arrive: say that, instead of storing nothing and calling the file empty.
  assert.match(api, /if \(!Buffer\.isBuffer\(req\.body\)\) return res\.status\(400\)/);
  assert.match(html, /f\.type === "application\/json" \? "text\/plain" : f\.type/);
  // A screenshot of the operator's screen is not something a workspace token may pull back out.
  assert.doesNotMatch(api, /api\.get\("\/attachments\/chat\/:id", \(req/);
});

test("the turn: paths go to the model, the stored line stays the words you typed", () => {
  // Ids in, paths rebuilt from our own rows — a client cannot name a path to be Read.
  assert.match(api, /\.map\(\(a\) => getChatAttachment\(a\.id\)\)/);
  assert.match(api, /const prompt = text \+ chatAttachmentsBlock\(files\);/);
  assert.match(api, /await askManagerWeb\(prompt,/);
  // `you` is the clean text; the display JSON rides beside it, on the row and on both bus events.
  assert.match(api, /const row = chat\.add\(text, reply \|\| "", "web", ws, steps, shown\);/);
  assert.match(api, /topic: "agent\.asked", you: text,[^\n]*\.\.\.\(shown\.length \? \{ attachments: shown \} : \{\}\)/);
  assert.match(api, /\.\.\.\(shown\.length \? \{ attachments: shown \} : \{\}\),/);
});

test("paste and drop both reach the same upload, and a drop anywhere else is swallowed", () => {
  assert.match(html, /input0\.addEventListener\("paste", \(e\) => \{\s*const files = \[\.\.\.\(e\.clipboardData\?\.files \|\| \[\]\)\];/);
  assert.match(html, /fetch\("\/api\/agent\/attach\?filename=" \+ encodeURIComponent\(f\.name \|\| "file"\)/);
  assert.match(html, /if \(f\.size > ATT_MAX\)/);
  // The document-level swallow: a file dropped on an element that does not preventDefault navigates
  // the WKWebView to file:// and the Desk is gone until it is relaunched.
  assert.match(html, /document\.addEventListener\("drop", \(e\) => \{[\s\S]{0,200}e\.preventDefault\(\);/);
  assert.match(html, /const overChat = \(e\) => chatIsOpen\(\) && !!e\.target\?\.closest\?\.\("#chat"\);/);
  assert.match(html, /if \(here\) attQueue\(\[\.\.\.\(e\.dataTransfer\?\.files \|\| \[\]\)\]\);/);
  // ⌘V then ⏎ must not outrun the upload and send the line without its screenshot.
  assert.match(html, /await attChain; \/\/ whatever is still uploading belongs to this line/);
  assert.match(html, /if \(!text && !ATT\.list\.length && !ATT\.busy\) return now \? stopTurn\(\) : undefined;/);
  // Dashed accent border while something is over the chat, and a counter (not a boolean) for it.
  assert.match(html, /\.chat\.dropping \{ outline:2px dashed var\(--accent\)/);
  assert.match(html, /let dragN = 0;/);
});

test("the strip is what is staged, and it empties into the line you send", () => {
  assert.match(html, /id="chat-att"/);
  assert.match(html, /\.chat-att\[hidden\] \{ display:none; \}/);
  assert.match(html, /host\.hidden = !ATT\.list\.length;/);
  assert.match(html, /b\.onclick = \(\) => \{ ATT\.list\.splice\(Number\(b\.dataset\.drop\), 1\); renderAtt\(\); \}/);
  // Taken at send time, so a queued turn cannot pick up what was pasted while it waited.
  assert.match(html, /const atts = ATT\.list; ATT\.list = \[\]; renderAtt\(\);/);
  assert.match(html, /queueAsk\(text \|\| "Look at the attachments\.", now, false, atts\)/);
  assert.match(html, /OV\.queue\.push\(\{ text, bub, atts \}\)/);
  assert.match(html, /if \(item\.atts\?\.length\) body\.attachments = item\.atts\.map\(\(a\) => \(\{ id: a\.id \}\)\);/);
  // The project the router could not guess: the files go in again with the re-sent line.
  assert.match(html, /OV\.queue\.push\(\{ text, bub, ws: c\.ws, picked: true, atts \}\)/);
});

test("thumbnails ride the bubble — live, from another surface, and after a reload", () => {
  assert.match(html, /attBubble\(ovLine\("you", e\.you, e\.ws \?\? null\), e\.attachments\)/);
  assert.match(html, /atts = m\.attachments \? JSON\.parse\(m\.attachments\) : null/);
  assert.match(html, /attBubble\(ovLine\("you", m\.you, ws\), atts\)/);
  // Admin-gated file route: an <img src> cannot carry the token, so each thumbnail is a blob this
  // page fetched with it — and a just-uploaded file is drawn from the bytes it already has.
  assert.match(html, /fetch\("\/api\/attachments\/chat\/" \+ encodeURIComponent\(id\), \{ headers: TOKEN \? \{ "x-mc-admin": TOKEN \} : \{\} \}\)/);
  assert.match(html, /if \(isImg\(a\.mime\)\) ATT_URL\.set\(a\.id, URL\.createObjectURL\(f\)\);/);
  // Click opens it. An image's chip is pointed straight at its blob once the thumbnail lands, so
  // that click is a plain navigation; only a non-image goes through the fetch-then-open path.
  assert.match(html, /if \(a\) \{ a\.href = u; a\.target = "_blank"; a\.rel = "noopener"; \}/);
  assert.match(html, /attSrc\(a\.dataset\.open\)\s*\.then\(\(u\) => \{ a\.href = u;[^\n]*window\.open\(u, "_blank"\); \}\)/);
});
