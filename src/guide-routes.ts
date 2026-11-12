/**
 * The guide — `docs/guide/*.md`, readable inside the daemon at `/guide` (static/guide.html).
 *
 *   GET /guide              the page; it renders the index (docs/guide/README.md)
 *   GET /guide/<name>       the page; it renders docs/guide/<name>.md
 *   GET /guide/<name>.md    that file's markdown, as text — what the page fetches ("index.md" = README.md)
 *
 * Public, like the docs in the repo: no token, and nothing here reads anything but the guide folder.
 * The one property that matters is that `<name>` can never name a file outside it. Two walls, both
 * required: the name must be `[a-z0-9-]+` (no dot, no slash, no percent — so no `..`, no encoded
 * separator, no absolute path), AND it must be one of the files actually listed in docs/guide. The
 * path is then built from the listing's own entry, never from the request.
 *
 * The page is served verbatim (serveHtml-style: no-store, nothing templated), and it renders the
 * markdown through the vendored DOMPurify, so a doc can never put script on the daemon's origin.
 * The markdown goes out as text/plain with nosniff, so a browser never treats it as HTML either.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/ under tsx, dist/ under launchd: the repo root is one up from either. */
const ROOT = path.join(here, "..");
export const GUIDE_DIR = path.join(ROOT, "docs", "guide");
const PAGE = path.join(ROOT, "static", "guide.html");

const NAME = /^[a-z0-9-]+$/;

/**
 * The guide's pages: name → file name. README.md is the index ("index"); every other page is its
 * lowercase file stem. A file whose stem is not a valid name is simply not served.
 */
export function guidePages(dir = GUIDE_DIR): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const stem = f.slice(0, -3);
    if (stem === "README") out.set("index", f);
    else if (NAME.test(stem)) out.set(stem, f);
  }
  return out;
}

/** The file for a requested name, or null — the only door from a request to a path. */
export function guideFile(name: string, dir = GUIDE_DIR): string | null {
  if (typeof name !== "string" || !NAME.test(name)) return null;
  const f = guidePages(dir).get(name);
  return f ? path.join(dir, f) : null;
}

export function guideRoutes(opts: { dir?: string; page?: string } = {}): express.Router {
  const dir = opts.dir ?? GUIDE_DIR;
  const page = opts.page ?? PAGE;
  const r = express.Router();
  const notFound = (res: express.Response) =>
    res.status(404).set("Cache-Control", "no-store").type("text").send("No such guide page. The index is at /guide.");
  const sendPage = (res: express.Response) => {
    if (!fs.existsSync(page)) return res.status(503).type("text").send("Guide UI missing from static/guide.html.");
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.type("html").sendFile(page);
  };

  r.get(["/guide", "/guide/"], (_req, res) => sendPage(res));
  r.get("/guide/:file", (req, res) => {
    const file = String(req.params.file || "");
    const md = /^(.+)\.md$/.exec(file);
    const f = guideFile(md ? md[1] : file, dir);
    if (!f) return notFound(res);
    if (!md) return sendPage(res);
    res.set({ "Cache-Control": "no-store, must-revalidate", "X-Content-Type-Options": "nosniff" });
    res.type("text/plain; charset=utf-8").send(fs.readFileSync(f, "utf8"));
  });
  return r;
}
