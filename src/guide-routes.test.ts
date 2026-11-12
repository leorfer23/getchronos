/**
 * The guide (src/guide-routes.ts + static/guide.html) over real HTTP. What is under test: `/guide/<name>`
 * only ever reaches a file that is listed in docs/guide — no traversal, no encoded separator, no file
 * outside the folder — and the page's own link rewriting, lifted out of guide.html and run. Plus one
 * docs contract: every relative link in a guide page points at a file that exists.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import express from "express";
import { guideRoutes, guideFile, guidePages, GUIDE_DIR } from "./guide-routes.js";

const app = express();
app.use(guideRoutes());
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

/** A raw GET — the path goes on the wire exactly as written (fetch would normalize `..`). */
function get(p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("/guide and /guide/<name> serve the page, uncached", async () => {
  for (const p of ["/guide", "/guide/", "/guide/why-chronos", "/guide/jobs"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(String(r.headers["content-type"]), /text\/html/, p);
    assert.match(String(r.headers["cache-control"]), /no-store/, p);
    assert.match(r.body, /id="guide-lib"/, p);
  }
});

test("/guide/<name>.md is the markdown as plain text, nosniff; index.md is the README", async () => {
  const r = await get("/guide/why-chronos.md");
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /^text\/plain/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["cache-control"]), /no-store/);
  assert.equal(r.body, fs.readFileSync(path.join(GUIDE_DIR, "why-chronos.md"), "utf8"));
  const idx = await get("/guide/index.md");
  assert.equal(idx.status, 200);
  assert.equal(idx.body, fs.readFileSync(path.join(GUIDE_DIR, "README.md"), "utf8"));
});

test("nothing outside docs/guide is reachable", async () => {
  const bad = [
    "/guide/../package.json", "/guide/..%2Fpackage.json", "/guide/..%2F..%2F.admin-token",
    "/guide/%2e%2e", "/guide/%2e%2e%2fREADME.md", "/guide/..", "/guide/.secrets", "/guide/README",
    "/guide/README.md", "/guide/Jobs", "/guide/jobs.md.md", "/guide/jobs%00", "/guide/nope", "/guide/nope.md",
    "/guide/%2Fetc%2Fpasswd", "/guide/jobs.txt", "/guide/why_chronos",
  ];
  for (const p of bad) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    assert.doesNotMatch(r.body, /"name":\s*"getchronos"|CHRONOS_|id="guide-lib"/, p);
  }
  // Express resolves "/guide/../package.json" to "/package.json" before routing — not ours at all.
  // The helper refuses the same names on its own, whatever the router does.
  for (const n of ["..", "../package", "README", "a/b", "a.b", "", "%2e%2e", "JOBS"]) assert.equal(guideFile(n), null, n);
});

test("a page must be in the listing, not just exist under the name", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "guide-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# i");
  fs.writeFileSync(path.join(dir, "ok-page.md"), "# ok");
  fs.writeFileSync(path.join(dir, "Upper.md"), "# no");
  fs.writeFileSync(path.join(dir, "notes.txt"), "no");
  assert.deepEqual([...guidePages(dir).keys()].sort(), ["index", "ok-page"]);
  assert.equal(guideFile("ok-page", dir), path.join(dir, "ok-page.md"));
  assert.equal(guideFile("upper", dir), null);
  assert.equal(guideFile("notes", dir), null);
  assert.deepEqual([...guidePages(path.join(dir, "missing")).keys()], []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The page's pure helpers, run as the browser would.
const html = fs.readFileSync(path.join(GUIDE_DIR, "..", "..", "static", "guide.html"), "utf8");
const lib = /<script id="guide-lib">([\s\S]*?)<\/script>/.exec(html)![1];
const ctx: any = {};
vm.runInNewContext(lib + "\nthis.guideName = guideName; this.guideHref = guideHref;", ctx);

test("guideName reads the page name off the path", () => {
  assert.equal(ctx.guideName("/guide"), "index");
  assert.equal(ctx.guideName("/guide/"), "index");
  assert.equal(ctx.guideName("/guide/jobs"), "jobs");
  assert.equal(ctx.guideName("/guide/../x"), null);
  assert.equal(ctx.guideName("/desk"), null);
  assert.equal(ctx.guideName("/guide.html"), "index");
});

test("guideHref turns repo-relative links into guide routes or GitHub links", () => {
  const gh = "https://github.com/leorfer23/getchronos/blob/main/";
  assert.equal(ctx.guideHref("jobs.md"), "/guide/jobs");
  assert.equal(ctx.guideHref("./jobs.md#the-daily-job-check"), "/guide/jobs#the-daily-job-check");
  assert.equal(ctx.guideHref("README.md"), "/guide");
  assert.equal(ctx.guideHref("../../HOSTS.md#setup"), gh + "HOSTS.md#setup");
  assert.equal(ctx.guideHref("../../skills/mission-control/SKILL.md"), gh + "skills/mission-control/SKILL.md");
  assert.equal(ctx.guideHref("img/x.png"), gh + "docs/guide/img/x.png");
  for (const keep of ["https://example.com/a", "/desk", "#top", "mailto:x@example.com"]) assert.equal(ctx.guideHref(keep), keep);
});

test("every relative link in the guide points at a file that exists", () => {
  const root = path.join(GUIDE_DIR, "..", "..");
  for (const f of fs.readdirSync(GUIDE_DIR).filter((x) => x.endsWith(".md"))) {
    const md = fs.readFileSync(path.join(GUIDE_DIR, f), "utf8");
    for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^[a-z]+:|^#|^\//i.test(href)) continue;
      const target = path.normalize(path.join(GUIDE_DIR, href.split("#")[0]));
      assert.ok(target.startsWith(root), `${f}: ${href} leaves the repo`);
      // phone.md is written by the phone-access change; until it lands the link is the only miss allowed.
      if (path.basename(target) === "phone.md" && path.dirname(target) === GUIDE_DIR) continue;
      assert.ok(fs.existsSync(target), `${f}: ${href} → missing ${path.relative(root, target)}`);
    }
  }
});
