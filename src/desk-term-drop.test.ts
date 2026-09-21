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
  assert.match(api, /api\.post\(\s*"\/sessions\/:id\/drop",\s*express\.raw\(\{ type: \(\) => true, limit: MAX_DROP_BYTES \}\)/);
  assert.match(api, /if \(!tokenOk\(req\.get\("x-mc-admin"\), CONFIG\.adminToken\)\)\s*\n\s*return res\.status\(403\)/);
  assert.match(api, /saveDrop\(\{\s*sessionId: s\.id,\s*buffer: req\.body as Buffer,/);
  // A Lead may type into a worker (/input); it may not write bytes to a path it then hands one.
  assert.doesNotMatch(api.slice(api.indexOf('"/sessions/:id/drop"'), api.indexOf('"/sessions/:id/worktree"')), /leadScope/);
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
  // A host that knows the real path (the native wrapper's hook, or file.path) skips the upload.
  assert.match(html, /window\.__deskDrop = \(paths\) =>/);
  assert.match(html, /const real = list\.map\(\(f\) => f\.path\)\.filter\(\(p\) => typeof p === "string" && p\);/);
  assert.match(html, /if \(real\.length === list\.length\) return window\.__deskDrop\(real\);/);
  assert.match(html, /toast\("dropped → " \+ \(out\.length > 1 \? out\.length \+ " files" : out\[0\]\)\)/);
});

test("the path goes in as a word: quoted if it needs it, space after it, never an Enter", () => {
  assert.match(html, /const shq = \(p\) => \(\/\^\[\\w@%\+=:,\.\/-\]\+\$\/\.test\(p\) \? p : "'" \+ p\.replace\(\/'\/g, "'\\\\''"\) \+ "'"\);/);
  assert.match(html, /input\(id, \{ text: text \+ " ", enter: false \}\);/);
  assert.match(html, /insertDropped\(id, out\.map\(shq\)\.join\(" "\)\);/);
  // Focus mode: the composer is the same door, at the caret.
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
  // preventDefault loads file:// in the webview and the Desk is gone until a relaunch.
  assert.match(html, /document\.addEventListener\("dragover", \(e\) => \{\s*\n\s*if \(!hasFiles\(e\)\) return;\s*\n\s*e\.preventDefault\(\);/);
  assert.match(html, /document\.addEventListener\("drop", \(e\) => \{\s*\n\s*if \(!hasFiles\(e\)\) return;\s*\n\s*e\.preventDefault\(\);/);
  assert.match(html, /if \(overStage\(e\)\) dropFiles\(e\.dataTransfer\?\.files\);/);
  // A text drag inside the page carries no "Files" and is left entirely alone.
  assert.match(html, /const hasFiles = \(e\) => \[\.\.\.\(e\.dataTransfer\?\.types \|\| \[\]\)\]\.includes\("Files"\);/);
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
