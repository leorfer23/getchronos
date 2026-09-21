import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  saveAttachment,
  saveChatFile,
  listAttachments,
  getAttachment,
  removeAttachment,
  formatAttachmentsBlock,
  extractTicketKey,
  ATTACH_ROOT,
} from "./attachments.js";
import { workspaces, tickets as ticketStore, db } from "./store.js";
import { randomUUID } from "node:crypto";

// Minimal 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function seedTicket(): string {
  let ws = workspaces.list()[0];
  if (!ws) {
    ws = workspaces.create({
      slug: `att-${randomUUID().slice(0, 8)}`,
      name: "Attach Test",
      kind: "personal",
      config_dir: path.join(ATTACH_ROOT, "_cfg"),
    });
  }
  const id = randomUUID();
  const key = `ATT-${Math.floor(Math.random() * 9000 + 1000)}`;
  const filePath = path.join(ATTACH_ROOT, "_tickets", `${key}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nid: ${key}\n---\n`);
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO tickets (id,workspace_id,repo_id,key,slug,title,status,priority,backend,model,assignee,file_path,external_system,external_id,external_url,tags,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    ws.id,
    null,
    key,
    "attach-test",
    "Attachment test",
    "backlog",
    "P2",
    null,
    null,
    "agent",
    filePath,
    null,
    null,
    null,
    null,
    ts,
    ts,
  );
  assert.ok(ticketStore.get(id));
  return id;
}

test("extractTicketKey", () => {
  assert.equal(extractTicketKey("PER-4 before"), "PER-4");
  assert.equal(extractTicketKey("see ACM-18 after fix"), "ACM-18");
  assert.equal(extractTicketKey("no key here"), null);
});

test("save list get remove attachment", () => {
  const ticketId = seedTicket();
  const a = saveAttachment({
    ticketId,
    buffer: PNG,
    filename: "shot.png",
    mime: "image/png",
    caption: "before",
    source: "upload",
  });
  assert.ok(a.id);
  assert.equal(a.mime, "image/png");
  assert.ok(a.path && fs.existsSync(a.path));
  assert.ok(a.url?.includes(a.id));

  const list = listAttachments(ticketId);
  assert.ok(list.some((x) => x.id === a.id));

  const got = getAttachment(a.id);
  assert.equal(got?.caption, "before");

  const block = formatAttachmentsBlock(ticketId);
  assert.match(block, /Attachments/);
  assert.match(block, /before|shot/);

  assert.equal(removeAttachment(a.id), true);
  assert.equal(getAttachment(a.id), undefined);
});

test("rejects non-image", () => {
  const ticketId = seedTicket();
  assert.throws(
    () =>
      saveAttachment({
        ticketId,
        buffer: Buffer.from("hello"),
        filename: "x.txt",
        mime: "text/plain",
      }),
    /unsupported/i,
  );
});

// Minimal one-page PDF WITH a real text layer (correct xref offsets — pdf.js parses it).
function miniPdf(text: string): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) { offsets[i] = body.length; body += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefPos = body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  body += xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("saveChatFile: pdf, text, image land under chat/<thread>; path traversal is neutralized", async () => {
  const pdf = await saveChatFile({
    thread: "ada",
    buffer: Buffer.from("%PDF-1.4 fake"),
    filename: "factura agosto.pdf",
    mime: "application/pdf",
  });
  assert.equal(pdf.mime, "application/pdf");
  assert.ok(pdf.path.startsWith(path.join(ATTACH_ROOT, "chat", "ada") + path.sep));
  assert.ok(pdf.path.endsWith("factura agosto.pdf"));
  assert.ok(fs.existsSync(pdf.path));
  // Unparseable pdf → upload still succeeds, just no text sidecar.
  assert.equal(pdf.text_path, undefined);

  const txt = await saveChatFile({
    thread: "../../etc",
    buffer: Buffer.from("notes"),
    filename: "../../../etc/passwd.md",
    mime: "",
  });
  // Hostile thread/filename collapse to safe segments inside the chat root.
  assert.ok(txt.path.startsWith(path.join(ATTACH_ROOT, "chat") + path.sep));
  assert.ok(!txt.path.includes(".."));
  assert.equal(txt.mime, "text/plain");

  const img = await saveChatFile({
    thread: "robert",
    buffer: PNG,
    filename: "pantalla.png",
    mime: "image/png",
  });
  assert.equal(img.mime, "image/png");
  assert.equal(img.text_path, undefined);

  for (const f of [pdf, txt, img]) fs.unlinkSync(f.path);
});

test("saveChatFile: a real PDF gets a cheap text sidecar next to it", async () => {
  const f = await saveChatFile({
    thread: "robert",
    buffer: miniPdf("hola chronos"),
    filename: "doc.pdf",
    mime: "application/pdf",
  });
  assert.ok(f.text_path, "expected extracted-text sidecar");
  assert.equal(f.text_path, f.path + ".txt");
  assert.match(fs.readFileSync(f.text_path!, "utf8"), /hola chronos/);
  fs.unlinkSync(f.path); fs.unlinkSync(f.text_path!);
});

test("saveChatFile: rejects binaries it cannot read and empty buffers", async () => {
  await assert.rejects(
    () => saveChatFile({ thread: "robert", buffer: Buffer.from("MZ"), filename: "tool.exe", mime: "application/octet-stream" }),
    /unsupported/i,
  );
  await assert.rejects(
    () => saveChatFile({ thread: "robert", buffer: Buffer.alloc(0), filename: "a.pdf", mime: "application/pdf" }),
    /empty/i,
  );
});
