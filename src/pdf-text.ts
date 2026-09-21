import { extractText, getDocumentProxy } from "unpdf";

// Text layer of a PDF, pure JS (pdf.js via unpdf) — no poppler/brew on the machine.
// Returns "" for scanned PDFs (no text layer); callers fall back to vision Read.
// Token math is the whole point: a vision-read page costs ~1-2k tokens, the same
// page as extracted text is ~5-10x cheaper.

const EXTRACT_TIMEOUT_MS = 15_000; // hostile/huge PDFs must not wedge an upload

export async function pdfText(buffer: Buffer | Uint8Array): Promise<string> {
  const work = (async () => {
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    try {
      const { text } = await extractText(doc, { mergePages: true });
      return String(text ?? "").trim();
    } finally {
      // unpdf's serverless pdf.js build exposes destroy() only on some versions
      await (doc as any).destroy?.().catch?.(() => {});
    }
  })();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("pdf text extraction timed out")), EXTRACT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
    work.catch(() => {}); // a post-timeout rejection must not surface as unhandled
  }
}
