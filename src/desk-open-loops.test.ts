/**
 * Open loops (⏰ in the Desk bar): everything still open that the rail does not show as a live terminal
 * asking — work parked on a condition (`mc when`), booked note follow-ups, unanswered questions, and
 * what runs on a clock. Leo, 2026-10-30: "super important to me to see what things are still open and
 * need follow-ups".
 *
 * Pinned here because desk.html has no build step: the page is read as text, and the two helpers that
 * decide order and wording run in a vm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the bar carries a ⏰ with a count, L opens it, and ? lists the key", () => {
  assert.match(html, /<button class="icon" id="btn-loops" title="Open loops[^"]*">⏰<\/button><span class="fab-unread loops-n" id="loops-n" hidden><\/span>/);
  assert.match(html, /if \(k === "l"\) \{ e\.preventDefault\(\); return openLoops\(\); \}/);
  assert.match(html, /<div><kbd>L<\/kbd><span>open loops:/);
  // The count is what needs following up: parked work, follow-ups, unanswered questions — not the clock.
  assert.match(html, /const n = LOOPS\.waits\.length \+ loopFollowUps\(\)\.length \+ LOOPS\.asks\.length;/);
});

test("it reads the routes those features already serve, through the page's one door (the client lock)", () => {
  assert.match(html, /api\("\/continuations"\)\.catch\(\(\) => null\)/);
  assert.match(html, /api\("\/asks\?status=open"\)\.catch\(\(\) => null\)/);
  assert.match(html, /api\("\/jobs\?kind=operator"\)\.catch\(\(\) => null\)/);
  // Follow-ups come off the notes the page already holds.
  assert.match(html, /const loopFollowUps = \(\) => S\.jots\.filter\(\(j\) => j\.status === "open" && j\.follow_up_at && !j\.followed_up_at\);/);
  // Kept current: a minute's poll (parked work moves on the daemon's clock) and every ask event.
  assert.match(html, /setInterval\(\(\) => \{ if \(!document\.hidden\) loopsLoad\(\); \}, 60000\);/);
  assert.match(html, /if \(e\.topic === "ask\.created" \|\| e\.topic === "ask\.answered"\) loopsSoon\(\);/);
  // Above AskCard's early return for those topics, or the count would never move on them.
  assert.ok(html.indexOf('if (e.topic === "ask.created" || e.topic === "ask.answered") loopsSoon();') < html.indexOf("if (AskCard.TOPICS.includes(e.topic)) return;"));
});

test("parked work: fire it now, or cancel it — and cancel takes a second click", () => {
  assert.match(html, /api\("\/continuations\/" \+ b\.dataset\.lfire \+ "\/fire", \{ method: "POST"/);
  assert.match(html, /api\("\/continuations\/" \+ b\.dataset\.lcancel \+ "\/cancel", \{ method: "POST"/);
  assert.match(html, /if \(LOOPS\.arm !== "x" \+ b\.dataset\.lcancel \|\| Date\.now\(\) - LOOPS\.armT > 3000\)/);
  // An unanswered question is answerable from the list, through the same door as everywhere else.
  assert.match(html, /api\("\/asks\/" \+ id \+ "\/answer", \{ method: "POST", body: JSON\.stringify\(\{ answer: text, by: "operator" \}\) \}\)/);
});

// The order and the words, run for real.
function helpers() {
  const src = ["spanWord", "loopWhen", "waitNext"].map((name) => {
    const m = html.match(new RegExp(`(const ${name} = [\\s\\S]*?;\\n)(?=const |function |//)`)) || html.match(new RegExp(`(function ${name}\\([\\s\\S]*?\\n\\})`));
    assert.ok(m, `${name} is in the page`);
    return m![1];
  }).join("\n");
  const ctx: Record<string, unknown> = { TermCompanion: { hhmm: (t: number) => new Date(t).toISOString().slice(11, 16) } };
  vm.runInNewContext(src + "\nthis.out = { spanWord, loopWhen, waitNext };", ctx);
  return (ctx as any).out as { spanWord: (m: number) => string; loopWhen: (x: string | number) => string; waitNext: (c: any) => number };
}

test("each loop says when it next moves, and the list is soonest first", () => {
  const { spanWord, loopWhen, waitNext } = helpers();
  assert.equal(spanWord(5), "5m");
  assert.equal(spanWord(180), "3h");
  assert.equal(spanWord(3 * 1440), "3d");
  assert.match(loopWhen(Date.now() + 2 * 3600_000), / · in 2h$/);
  assert.match(loopWhen(Date.now() - 40 * 60_000), / · 40m ago$/);
  assert.equal(loopWhen(""), "");
  // An `at` moves at its time; anything else at its next check; a row with neither goes last.
  const at = { kind: "at", target: "2026-11-02T12:00:00.000Z" };
  const check = { kind: "check", next_check_at: "2026-10-31T09:00:00.000Z" };
  assert.ok(waitNext(check) < waitNext(at));
  assert.equal(waitNext({ kind: "manual" }), Infinity);
});
