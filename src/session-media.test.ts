/**
 * The companion's Media strip: what a terminal was handed and what the agent saw. The list is also
 * the file route's allowlist, so most of this is about what does NOT get in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMedia, mediaMime, mediaPathsFromFeed, sessionMedia } from "./session-media.js";
import { describeTool } from "./focus.js";
import type { FocusEvent } from "./focus.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-media-")));
const drops = path.join(tmp, "drops");
const ev = (seq: number, kind: FocusEvent["kind"], text: string): FocusEvent => ({ seq, kind, text });
const write = (p: string, body = "x", mtime?: number) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
};

test("image paths come out of reads, writes, commands, quoted drops and narration — never out of thinking", () => {
  const got = mediaPathsFromFeed([
    ev(1, "user", "look at '/Users/op/Desktop/Screen Shot 1.png' please"),
    ev(2, "act", "Read /Users/op/Desktop/Screen Shot 1.png"),
    ev(3, "act", "run screencapture -x /tmp/shot.jpg && echo ok"),
    ev(4, "act", "mcp__chrome__take_screenshot → /tmp/page.webp"),
    ev(5, "say", "Saved the before/after to ~/shots/after.png."),
    ev(6, "think", "maybe /tmp/secret.png"),
    ev(7, "act", "Write /repo/src/icon.svg"),
    ev(8, "act", "Read /repo/notes.md"),
    ev(9, "act", "Read relative/thing.png"),
  ]);
  assert.deepEqual(got, [
    { path: "/Users/op/Desktop/Screen Shot 1.png", source: "drop" },
    { path: "/tmp/shot.jpg", source: "agent" },
    { path: "/tmp/page.webp", source: "agent" },
    { path: path.join(os.homedir(), "shots/after.png"), source: "agent" },
  ]);
});

test("a terminal's media: every drop plus feed images that exist, newest first; the list is the file route's allowlist", () => {
  const s = { id: "sess-1", host_id: null };
  const dropDir = path.join(drops, "sess-1");
  write(path.join(dropDir, "data.json"), "{}", 1_000_000);
  write(path.join(dropDir, ".DS_Store"), "x", 4_000_000);
  const seen = write(path.join(tmp, "seen.png"), "png", 3_000_000);
  write(path.join(tmp, "empty.png"), "");
  write(path.join(tmp, "unmentioned.png"), "png");
  const list = sessionMedia(s, [
    ev(1, "act", `Read ${seen}`),
    ev(2, "act", `Read ${path.join(tmp, "empty.png")}`),
    ev(3, "act", `Read ${path.join(tmp, "gone.png")}`),
  ], drops);
  assert.deepEqual(list.map((m) => [m.name, m.image, m.source]), [["seen.png", true, "agent"], ["data.json", false, "drop"]]);
  assert.equal(findMedia(list, seen)?.name, "seen.png");
  assert.equal(findMedia(list, path.join(tmp, "unmentioned.png")), null, "a real image the session never mentioned is not served");
  assert.equal(findMedia(list, path.join(dropDir, "..", "..", "seen.png"))?.name, "seen.png", "a path is compared after resolving it");
  assert.equal(findMedia(list, "/etc/passwd"), null);
  assert.equal(findMedia(list, ""), null);
});

test("a symlink named in the feed is listed as its target, and only if that target is an image", () => {
  const s = { id: "sess-2", host_id: null };
  const secret = write(path.join(tmp, "secret.txt"), "nope");
  const link = path.join(tmp, "looks.png");
  fs.symlinkSync(secret, link);
  const list = sessionMedia(s, [ev(1, "act", `Read ${link}`)], drops);
  assert.equal(list.length, 1);
  assert.equal(list[0].path, secret);
  assert.equal(list[0].image, false, "served as a download, never as an inline picture");
});

test("a terminal on another computer lists nothing: its files are on its own disk", () => {
  const p = write(path.join(tmp, "remote.png"), "png");
  assert.deepEqual(sessionMedia({ id: "sess-3", host_id: "m2" }, [ev(1, "act", `Read ${p}`)], drops), []);
});

test("mime by extension, and a screenshot tool's saved path survives into the feed", () => {
  assert.equal(mediaMime("/a/b.JPG"), "image/jpeg");
  assert.equal(mediaMime("/a/b.svg"), "application/octet-stream");
  assert.equal(describeTool("mcp__chrome__take_screenshot", { filePath: "/tmp/p.png" }), "mcp__chrome__take_screenshot → /tmp/p.png");
  assert.equal(describeTool("mcp__chrome__take_screenshot", {}), "mcp__chrome__take_screenshot");
});

test("the Desk draws a Media section in the rail and refreshes it after a drop", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  assert.match(html, /<div class="comp-media" id="comp-media" hidden>/);
  assert.match(html, /compPins\(s\); compMedia\(s\);/);
  assert.match(html, /window\.deskMediaDropped\?\.\(id\);\s*toast\("dropped → "/);
  assert.match(html, /window\.deskMediaDropped = \(id\) => \{ if \(id === C\.id\) setTimeout\(\(\) => compMediaLoad\(id, true\), 1500\); \};/);
  assert.match(html, /"\/api\/sessions\/" \+ id \+ "\/media\/file\?path=" \+ encodeURIComponent\(m\.path\), \{ headers: \{ "x-mc-admin": TOKEN \} \}/);
});
