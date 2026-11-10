/**
 * The client half of a spoken alert (static/voice-alerts.js), run in a vm the way desk-scope.js is,
 * plus the Desk's wiring read as text: an alert is reported "done" only after its audio played to the
 * end, never when it is queued — a failed render or playback reports nothing, so the phone gets it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const posts: Array<{ path: string; body: any }> = [];
const timers: Array<() => void> = [];
const ctx: any = {
  window: {},
  setInterval: (fn: () => void) => { timers.push(fn); return timers.length; },
  clearInterval: () => { timers.length = 0; },
  Promise,
  encodeURIComponent,
};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/voice-alerts.js"), "utf8"), ctx);
const VA = ctx.window.VoiceAlerts.create({
  client: "desk-1", surface: "desk", lang: () => "es", lock: () => null,
  // The vm has its own Object.prototype: copy what it posts into this realm before comparing.
  post: (p: string, body: unknown) => { posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return Promise.resolve(); },
});
const ev = (over: Record<string, unknown> = {}) => ({ topic: "alert.raised", alert_id: "a1", workspace_id: "w", session_id: "s", kind: "decide", say: "In Acme, the task stopped.", lang: "es", client: "desk-1", ...over });

test("presence: one ping when the call starts, one every 20s while up, one live:false on hang-up", () => {
  posts.length = 0;
  VA.presence(true);
  assert.deepEqual(posts[0], { path: "/api/voice/presence", body: { client: "desk-1", surface: "desk", live: true, lang: "es", lock: null } });
  timers[0]();
  assert.equal(posts.length, 2);
  VA.presence(false);
  assert.equal(posts.at(-1)!.body.live, false);
  assert.equal(timers.length, 0, "no more pings after hang-up");
});

test("take: only an alert.raised meant for THIS call, only while the call is live", () => {
  assert.ok(VA.take(ev(), true));
  assert.equal(VA.take(ev(), false), null, "no live call");
  assert.equal(VA.take(ev({ client: "desk-2" }), true), null, "the daemon picked another call");
  assert.equal(VA.take(ev({ say: "" }), true), null);
  assert.equal(VA.take({ ...ev(), topic: "agent.push" }, true), null);
});

test("started and done are each reported once — and nothing is reported until the page calls them", () => {
  posts.length = 0;
  const a = VA.take(ev(), true);
  assert.equal(posts.length, 0, "taking it (queueing it) reports nothing");
  a.started(); a.started();
  a.done(); a.done();
  assert.deepEqual(posts.map((p) => [p.path, p.body.stage]), [["/api/alerts/a1/spoken", "started"], ["/api/alerts/a1/spoken", "done"]]);
  assert.equal(posts[0].body.client, "desk-1");
});

test("the Desk reports an alert only from vcPlay: started when audio begins, done only when it ended", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
  const vcAlert = /function vcAlert\(e\) \{[\s\S]*?\n\}/.exec(html)![0];
  assert.doesNotMatch(vcAlert, /\/spoken|fetch\(/, "queueing an alert must not tell the daemon it was spoken");
  const vcPlay = /async function vcPlay\(\) \{[\s\S]*?\n\}/.exec(html)![0];
  assert.match(vcPlay, /const blob = await item\.blob;\n\s+if \(VC\.playing !== item\) return;[\s\S]*if \(blob && VC\.on\) \{/, "a null render never reaches the confirmation");
  assert.match(vcPlay, /a\.onended = \(\) => done\(true\); a\.onerror = \(\) => done\(false\);/, "an audio error is not an end");
  assert.match(vcPlay, /a\.play\(\)\.then\(\(\) => item\.alert\?\.started\(\), \(\) => done\(false\)\)/, "started only once playback began");
  assert.match(vcPlay, /if \(VC\.playing !== item\) return;\n\s+if \(ended\) item\.alert\?\.done\(\);/, "done only after a full play, never after a skip");
  assert.match(html, /<script src="\/voice-alerts\.js"><\/script>/);
});
