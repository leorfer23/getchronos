import { test } from "node:test";
import assert from "node:assert/strict";
import { pdfText } from "./pdf-text.js";

// Same minimal-PDF builder as attachments.test.ts — one page, real text layer, valid xref.
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

test("pdfText: extracts the text layer", async () => {
  assert.equal(await pdfText(miniPdf("hola chronos")), "hola chronos");
});

test("pdfText: scanned-style PDF (no text ops) → empty string, not an error", async () => {
  assert.equal(await pdfText(miniPdf("")), "");
});

test("pdfText: garbage bytes reject", async () => {
  await assert.rejects(() => pdfText(Buffer.from("not a pdf at all")));
});
