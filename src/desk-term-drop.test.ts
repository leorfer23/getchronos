/**
 * Dropping a file on a terminal: Finder → the stage → the agent gets an absolute PATH.
 *
 * Half of this lives in static/desk.html, which has no build step, so those assertions read the
 * shipped file. The other half is the disk side — where a drop is written, and why there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DROP_ROOT, MAX_DROP_BYTES, saveDrop, sessionDropDir } from "./drops.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const css = html.slice(0, html.indexOf("</style>"));
const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
const routes = fs.readFileSync(path.join(process.cwd(), "src/drop-routes.ts"), "utf8");
const terminal = fs.readFileSync(path.join(process.cwd(), "src/terminal.ts"), "utf8");

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

test("the endpoint is admin-gated like /input, takes raw bytes, and returns the path", () => {
  assert.match(api, /api\.post\("\/sessions\/:id\/drop", express\.raw\(\{ type: \(\) => true, limit: MAX_DROP_BYTES \}\), dropRoutes\.dropRoute\);/);
  assert.match(api, /api\.post\("\/sessions\/:id\/drop-path", dropRoutes\.dropPathRoute\);/);
  assert.match(routes, /if \(!tokenOk\(req\.get\("x-mc-admin"\), CONFIG\.adminToken\)\) \{\s*\n\s*res\.status\(403\)/);
  assert.match(routes, /saveDrop\(\{ sessionId: s\.id, buffer: f\.buffer,/);
  // A Lead may type into a worker (/input); it may not write bytes to a path it then hands one.
  assert.doesNotMatch(routes, /leadScope|leadGate/);
});

test("the app parses a drop as raw bytes BEFORE express.json can eat a dropped .json", () => {
  // express.json() used to be first on the app: a dropped google-services.json (content-type
  // application/json) was parsed as JSON, the route's own raw parser skipped it, and the drop
  // answered "empty file". mountBodyParsers puts the raw parser for this one route first.
  assert.doesNotMatch(api, /app\.use\(express\.json\(/, "express.json is mounted by mountBodyParsers, nowhere else");
  const mount = api.indexOf("dropRoutes.mountBodyParsers(app);");
  assert.ok(mount > 0 && mount < api.indexOf('app.use("/api", api);'));
  assert.match(routes, /app\.post\(DROP_URL, express\.raw\(\{ type: \(\) => true, limit: MAX_DROP_BYTES \}\)\);\s*\n(\s*\/\/[^\n]*\n)*\s*app\.use\(express\.json\(\{ limit: "16mb" \}\)\);/);
  assert.match(routes, /const DROP_URL = "\/api\/sessions\/:id\/drop";/);
});

test("the terminal is spawned already trusting its own drop dir — both walls", () => {
  // Without the grant, claude asks permission to Read a path outside its cwd, and the whole point
  // of a drop is that the path just works.
  assert.match(terminal, /repoDirs\.push\(ensureDropDir\(row\.id\)\);/);
  assert.match(terminal, /import \{ ensureDropDir \} from "\.\/drops\.js";/);
});

test("the page uploads because the web never gives it a real path, and prefers one when it does", () => {
  assert.match(html, /fetch\("\/api\/sessions\/" \+ id \+ "\/drop\?filename=" \+ encodeURIComponent\(f\.name \|\| "drop"\)/);
  assert.match(html, /"x-mc-admin": TOKEN/);
  // A host that knows the real path (the native wrapper's hook, or file.path) skips the upload…
  assert.match(html, /window\.__deskDrop = async \(paths\) =>/);
  assert.match(html, /const real = list\.map\(\(f\) => f\.path\)\.filter\(\(p\) => typeof p === "string" && p\);/);
  assert.match(html, /if \(real\.length === list\.length\) return window\.__deskDrop\(real\);/);
  // …but only for a terminal on this Mac. One on another computer gets the daemon to read it here.
  assert.match(html, /if \(!onOtherHost\(id\)\) return landed\(id, list\);/);
  assert.match(html, /fetch\("\/api\/sessions\/" \+ id \+ "\/drop-path", \{/);
  assert.match(html, /const onOtherHost = \(id\) => \{ const s = byId\(id\); return !!\(s && hostOf\(s\)\); \};/);
  assert.match(html, /toast\("dropped → " \+ \(out\.length > 1 \? out\.length \+ " files" : out\[0\]\)\)/);
  // The per-file cap follows the terminal: a remote drop travels in one 16 MB frame.
  assert.match(html, /const REMOTE_DROP_MAX = 16 \* 1024 \* 1024;/);
  assert.match(html, /const max = onOtherHost\(id\) \? REMOTE_DROP_MAX : DROP_MAX;/);
});

test("the path goes in as a word: quoted if it needs it, space after it, never an Enter", () => {
  assert.match(html, /const shq = \(p\) => \(\/\^\[\\w@%\+=:,\.\/-\]\+\$\/\.test\(p\) \? p : "'" \+ p\.replace\(\/'\/g, "'\\\\''"\) \+ "'"\);/);
  assert.doesNotMatch(html, /input\(id, \{ text: text \+ " ", enter: false \}\);/, "both modes drop into the composer");
  assert.match(html, /insertDropped\(id, out\.map\(shq\)\.join\(" "\)\);/);
  // Both modes: the composer is the door, at the caret.
  assert.match(html, /say\.value = pre \+ ins \+ say\.value\.slice\(end\);/);
  assert.match(html, /say\.selectionStart = say\.selectionEnd = pre\.length \+ ins\.length;/);
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

test("every file drop on the page is swallowed — an unhandled one navigates the WKWebView away", () => {
  // static/app.html learned this the hard way: a file dropped on an element that does not
  // preventDefault loads file:// in the webview and the Desk is gone until a relaunch. Over an
  // editable element it is worse: WebKit types the file's LOCAL path into it — how a terminal on
  // the M2 got a /Users/<brain>/… path it could not open. Capture phase, so the Desk sees the drag
  // before any element under the pointer does.
  assert.match(html, /document\.addEventListener\("dragover", \(e\) => \{\s*\n\s*if \(!isFileDrag\(e\)\) return;\s*\n\s*e\.preventDefault\(\);[\s\S]*?\n\}, true\);/);
  assert.match(html, /document\.addEventListener\("drop", \(e\) => \{\s*\n\s*if \(!isFileDrag\(e\)\) return;[\s\S]*?e\.preventDefault\(\);[\s\S]*?\n\}, true\);/);
  assert.match(html, /if \(files\.length\) dropFiles\(files\);\s*\n\s*else if \(paths\.length\) window\.__deskDrop\(paths\);/);
  // A Finder drag counts whether WebKit presents it as Files or as file URLs; a text drag inside
  // the page carries none of these and is left entirely alone.
  assert.match(html, /const FILE_DRAG_TYPES = \["Files", "text\/uri-list", "public\.file-url"\];/);
  // The chat's own listeners keep the strict check: they only ever take real File objects.
  assert.match(html, /const hasFiles = \(e\) => \[\.\.\.\(e\.dataTransfer\?\.types \|\| \[\]\)\]\.includes\("Files"\);/);
  // Backstop: WebKit's own drop insertion announces itself as a cancellable beforeinput.
  assert.match(html, /document\.addEventListener\("beforeinput", \(e\) => \{\s*\n\s*if \(e\.inputType !== "insertFromDrop" \|\| !overStage\(e\)\) return;/);
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
      const body = url.endsWith("/drop-path") ? { paths: ["/Users/leorfer/.mc/drops/s1/google-services.json"] } : { path: "/Users/leorfer/.mc/drops/s1/up.json" };
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
  const uris = "file:///Users/leonelfernandez/Downloads/google-services.json";
  // This Mac: the file is right there, nothing to upload.
  const local = dropSection({ host_id: null, types: ["text/uri-list"], uris });
  await local.settle();
  assert.equal(local.prevented(), true);
  assert.equal(local.fetches.length, 0);
  assert.equal(local.say.value, "/Users/leonelfernandez/Downloads/google-services.json ");
  // The M2: the brain reads its own file and ships the bytes; the path typed is one over THERE.
  const remote = dropSection({ host_id: "h_m2", types: ["text/uri-list"], uris, target: "textarea" });
  await remote.settle();
  assert.equal(remote.prevented(), true, "a file URL over the composer is still ours, not WebKit's to insert");
  assert.equal(remote.fetches.length, 1);
  assert.equal(remote.fetches[0].url, "/api/sessions/s1/drop-path");
  assert.deepEqual(JSON.parse(remote.fetches[0].init.body), { paths: ["/Users/leonelfernandez/Downloads/google-services.json"] });
  assert.equal(remote.fetches[0].init.headers["x-mc-admin"], "tok");
  assert.equal(remote.say.value, "/Users/leorfer/.mc/drops/s1/google-services.json ");
  assert.doesNotMatch(remote.say.value, /leonelfernandez/);
});

test("the native door and File.path take the same care on a remote terminal", async () => {
  const d = dropSection({ host_id: "h_m2", files: [] });
  await d.window.__deskDrop(["/Users/leonelfernandez/Desktop/a b.png"]);
  assert.equal(d.fetches[0].url, "/api/sessions/s1/drop-path");
  assert.doesNotMatch(d.say.value, /leonelfernandez/);
  // A File that carries a real path (Electron-style) goes the same way.
  const f = dropSection({ host_id: "h_m2", files: [{ name: "x.json", size: 10, type: "application/json", path: "/Users/leonelfernandez/x.json" }] });
  await f.settle();
  assert.equal(f.fetches[0].url, "/api/sessions/s1/drop-path");
});

test("a dropped File is uploaded with its own type, and a plain link over the composer is left to the browser", async () => {
  const d = dropSection({ host_id: "h_m2", files: [{ name: "google-services.json", size: 10, type: "application/json" }] });
  await d.settle();
  assert.equal(d.fetches[0].url, "/api/sessions/s1/drop?filename=google-services.json");
  assert.equal(d.fetches[0].init.headers["content-type"], "application/json");
  assert.equal(d.say.value, "/Users/leorfer/.mc/drops/s1/up.json ");
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

test("dragging over the stage outlines it, and only the stage", () => {
  assert.match(css, /\.stage\.dropping \{ outline:2px dashed var\(--accent\)/);
  assert.match(html, /stageEl\.classList\.toggle\("dropping", overStage\(e\)\);/);
  assert.match(html, /const dropOff = \(\) => \{ dragDepth = 0; stageEl\.classList\.remove\("dropping"\); \};/);
});

test("an image paste takes the same road, and listens in capture so xterm cannot eat it", () => {
  // xterm's own paste handler calls stopPropagation(), so a bubbling listener never hears ⌘V while
  // a terminal has focus — which is exactly when an image paste needs to be turned into a path.
  assert.match(html, /document\.addEventListener\("paste", \(e\) => \{[\s\S]*?dropFiles\(files\);\s*\n\}, true\);/);
  assert.match(html, /const files = \[\.\.\.\(e\.clipboardData\?\.files \|\| \[\]\)\];\s*\n\s*\/\/[^\n]*\n\s*if \(!files\.length \|\| !S\.active \|\| e\.target\?\.closest\?\.\("#chat"\)\) return;/);
});
