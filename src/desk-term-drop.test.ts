/**
 * Dropping a file on a terminal: Finder → the stage → the agent gets an absolute PATH.
 *
 * The disk side — where a drop is written, and why there — and the page's drop code, lifted out of
 * static/desk.html (no build step) and run against stubs. The routes are drop-routes.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DROP_ROOT, MAX_DROP_BYTES, saveDrop, sessionDropDir } from "./drops.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

const sid = `drop-test-${process.pid}`;

test("a drop lands outside every repo and outside ~/chronos, so any terminal can read it", () => {
  // Inside a repo it would be `git add -A`'d into someone's commit; under ~/chronos it would sit in
  // the chronos repo, which is a denied root for every other workspace's sandbox.
  assert.equal(DROP_ROOT, path.join(os.homedir(), ".mc", "drops"));
  assert.ok(sessionDropDir("abc").startsWith(DROP_ROOT + path.sep));
  // One dir per session: a drop belongs to the terminal it was dropped on, not to the whole Mac.
  assert.equal(sessionDropDir("abc"), path.join(DROP_ROOT, "abc"));
  // A session id is a path segment here — nothing in it may walk out of the drop root.
  assert.equal(sessionDropDir("../../etc"), path.join(DROP_ROOT, "_etc"));
  assert.equal(sessionDropDir(".."), path.join(DROP_ROOT, "_"));
});

test("the original filename survives, and a second drop of it does not overwrite the first", () => {
  const a = saveDrop({ sessionId: sid, buffer: Buffer.from("one"), filename: "Screen Shot.png", mime: "image/png" });
  const b = saveDrop({ sessionId: sid, buffer: Buffer.from("two"), filename: "Screen Shot.png", mime: "image/png" });
  assert.equal(a.name, "Screen Shot.png");
  assert.equal(b.name, "Screen Shot-2.png");
  assert.equal(fs.readFileSync(a.path, "utf8"), "one");
  assert.equal(fs.readFileSync(b.path, "utf8"), "two");
  assert.deepEqual([a.size, a.mime], [3, "image/png"]);
  assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
});

test("a filename cannot walk out of the drop dir, and any mime is accepted", () => {
  const d = saveDrop({ sessionId: sid, buffer: Buffer.from("x"), filename: "../../../../etc/passwd", mime: "" });
  assert.equal(path.dirname(d.path), sessionDropDir(sid));
  assert.equal(d.name, "passwd");
  // Not an attachment the daemon interprets — it is a file the agent opens itself.
  assert.equal(saveDrop({ sessionId: sid, buffer: Buffer.from("x"), filename: "dump.sqlite" }).mime, "application/octet-stream");
  assert.throws(() => saveDrop({ sessionId: sid, buffer: Buffer.alloc(0), filename: "empty" }), /empty file/);
  assert.throws(
    () => saveDrop({ sessionId: sid, buffer: Buffer.alloc(MAX_DROP_BYTES + 1), filename: "huge.bin" }),
    /too large/,
  );
  fs.rmSync(sessionDropDir(sid), { recursive: true, force: true });
});

// The shell quoting is the one piece of real logic on the page; run the shipped line rather than
// reading it, the way desk-voice.test.ts runs its two pure pieces.
test("shq leaves a plain path alone and survives spaces and quotes", () => {
  const at = html.indexOf("const shq = (p) =>");
  assert.ok(at > 0, "shq is a one-liner in static/desk.html");
  const expr = html.slice(at, html.indexOf("\n", at)).replace("const shq = ", "").replace(/;$/, "");
  const shq = new Function("return " + expr)() as (p: string) => string;
  assert.equal(shq("/Users/x/a-b_c.2.png"), "/Users/x/a-b_c.2.png");
  assert.equal(shq("/Users/x/Screen Shot.png"), "'/Users/x/Screen Shot.png'");
  assert.equal(shq("/tmp/it's here.txt"), "'/tmp/it'\\''s here.txt'");
  assert.equal(shq("/tmp/$(rm -rf ~).txt"), "'/tmp/$(rm -rf ~).txt'");
});

// The drop section is plain page code with a handful of globals; run the SHIPPED text against stubs
// (the way the shq test below runs its one-liner) so what is asserted is behaviour, not spelling.
function dropSection(opts: { host_id: string | null; files?: unknown[]; uris?: string; types?: string[]; target?: string }) {
  const start = html.indexOf("// ── dropping a file on a terminal");
  const end = html.indexOf("// ⌘V with an image on the clipboard");
  assert.ok(start > 0 && end > start);
  const listeners: Record<string, (e: any) => void> = {};
  const fetches: { url: string; init: any }[] = [];
  const toasts: string[] = [];
  const say = { value: "", selectionStart: 0, selectionEnd: 0, dispatchEvent() {}, focus() {} };
  const stage = { contains: (t: any) => t?.inStage === true, classList: { toggle() {}, remove() {} } };
  const session = { id: "s1", host_id: opts.host_id };
  const env = {
    S: { active: "s1" },
    byId: (id: string) => (id === "s1" ? session : undefined),
    hostOf: (s: any) => (s.host_id && s.host_id !== "local" ? { id: s.host_id } : null),
    say,
    toast: (m: string) => toasts.push(m),
    TOKEN: "tok",
    qs: () => stage,
    window: {} as any,
    document: { addEventListener: (k: string, fn: any) => { listeners[k] = fn; } },
    fetch: async (url: string, init: any) => {
      fetches.push({ url, init });
      const body = url.endsWith("/drop-path") ? { paths: ["/Users/op2/.mc/drops/s1/google-services.json"] } : { path: "/Users/op2/.mc/drops/s1/up.json" };
      return { ok: true, json: async () => body };
    },
  };
  const run = new Function(...Object.keys(env), html.slice(start, end));
  run(...Object.values(env));
  const target = { inStage: true, closest: (sel: string) => (opts.target && sel.includes(opts.target) ? {} : null) };
  const dt = {
    types: opts.types ?? ["Files"],
    files: opts.files ?? [],
    getData: (t: string) => (t === "text/uri-list" ? opts.uris ?? "" : ""),
  };
  let prevented = false;
  listeners.drop({ target, dataTransfer: dt, preventDefault: () => { prevented = true; } });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { fetches, toasts, say, settle, prevented: () => prevented, window: env.window };
}

test("a real path is typed as-is into a terminal on this Mac, never into one on another computer", async () => {
  const uris = "file:///Users/operator/Downloads/google-services.json";
  // This Mac: the file is right there, nothing to upload.
  const local = dropSection({ host_id: null, types: ["text/uri-list"], uris });
  await local.settle();
  assert.equal(local.prevented(), true);
  assert.equal(local.fetches.length, 0);
  assert.equal(local.say.value, "/Users/operator/Downloads/google-services.json ");
  // The M2: the brain reads its own file and ships the bytes; the path typed is one over THERE.
  const remote = dropSection({ host_id: "h_m2", types: ["text/uri-list"], uris, target: "textarea" });
  await remote.settle();
  assert.equal(remote.prevented(), true, "a file URL over the composer is still ours, not WebKit's to insert");
  assert.equal(remote.fetches.length, 1);
  assert.equal(remote.fetches[0].url, "/api/sessions/s1/drop-path");
  assert.deepEqual(JSON.parse(remote.fetches[0].init.body), { paths: ["/Users/operator/Downloads/google-services.json"] });
  assert.equal(remote.fetches[0].init.headers["x-mc-admin"], "tok");
  assert.equal(remote.say.value, "/Users/op2/.mc/drops/s1/google-services.json ");
  assert.doesNotMatch(remote.say.value, /operator/);
});

test("the native door and File.path take the same care on a remote terminal", async () => {
  const d = dropSection({ host_id: "h_m2", files: [] });
  await d.window.__deskDrop(["/Users/operator/Desktop/a b.png"]);
  assert.equal(d.fetches[0].url, "/api/sessions/s1/drop-path");
  assert.doesNotMatch(d.say.value, /operator/);
  // A File that carries a real path (Electron-style) goes the same way.
  const f = dropSection({ host_id: "h_m2", files: [{ name: "x.json", size: 10, type: "application/json", path: "/Users/operator/x.json" }] });
  await f.settle();
  assert.equal(f.fetches[0].url, "/api/sessions/s1/drop-path");
});

test("a dropped File is uploaded with its own type, and a plain link over the composer is left to the browser", async () => {
  const d = dropSection({ host_id: "h_m2", files: [{ name: "google-services.json", size: 10, type: "application/json" }] });
  await d.settle();
  assert.equal(d.fetches[0].url, "/api/sessions/s1/drop?filename=google-services.json");
  assert.equal(d.fetches[0].init.headers["content-type"], "application/json");
  assert.equal(d.say.value, "/Users/op2/.mc/drops/s1/up.json ");
  // An http link dragged onto the composer: that is a URL being pasted, not a file.
  const link = dropSection({ host_id: "h_m2", types: ["text/uri-list"], uris: "https://example.com/x", target: "textarea" });
  await link.settle();
  assert.equal(link.prevented(), false);
  assert.equal(link.fetches.length, 0);
});

test("file URIs become paths; other hosts, file references and web links do not", () => {
  const at = html.indexOf("function fileUrlPaths(dt) {");
  const src = html.slice(at, html.indexOf("\n}\n", at) + 2);
  const fileUrlPaths = new Function(src + "; return fileUrlPaths;")() as (dt: unknown) => string[];
  const dt = (s: string) => ({ getData: (t: string) => (t === "text/uri-list" ? s : "") });
  assert.deepEqual(
    fileUrlPaths(dt("# comment\r\nfile:///Users/x/Screen%20Shot.png\r\nfile://localhost/tmp/dir/\r\nhttps://example.com/a\r\nfile://server/share/x\r\nfile:///.file/id=6571367.2")),
    ["/Users/x/Screen Shot.png", "/tmp/dir"],
  );
  assert.deepEqual(fileUrlPaths(dt("")), []);
  assert.deepEqual(fileUrlPaths({ getData: () => { throw new Error("protected"); } }), []);
});

