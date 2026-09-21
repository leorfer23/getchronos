/** Robert's tool calls → the steps the Desk shows under his reply. */
import test from "node:test";
import assert from "node:assert/strict";
import { humanizeStep, normalizeCommand } from "./robert-steps.js";

const AT = "2026-09-15T21:00:00.000Z";
const h = (d: string) => humanizeStep(d, AT)!;

test("normalizeCommand strips the plumbing in front of the move", () => {
  assert.equal(normalizeCommand("cd /tmp && CHRONOS_ADMIN=xyz ~/.mc/bin/mc session list"), "mc session list");
  assert.equal(normalizeCommand("/Users/x/.mc/bin/mc desk digest"), "mc desk digest");
});

test("terminal moves read as sentences with the terminal attached", () => {
  assert.deepEqual(h('run ~/.mc/bin/mc session send b891d5f6 "rebase on main and push"'), {
    at: AT, icon: "⌨️", text: "Told it: “rebase on main and push”", sid: "b891d5f6", kind: "act",
  });
  assert.equal(h("run mc session key b891d5f6 down,enter").text, "Picked an option (down enter)");
  assert.equal(h("run mc session done b891d5f6").icon, "✅");
  assert.equal(h("run mc session kill b891d5f6").kind, "act");
  const look = h("run mc session focus b891d5f6-1234-4000-8000-000000000000");
  assert.equal(look.kind, "read");
  assert.equal(look.sid, "b891d5f6");
  assert.match(h('run mc session new --goal "fix the 3am DAG" --ws cedar').text, /Opened a terminal: “fix the 3am DAG”/);
  assert.equal(h("run mc desk digest").text, "Scanned the Desk");
});

test("API calls: a mutation is an action, a GET is a look, long ids shortened", () => {
  const post = h('run curl -s -X POST -H "x-mc-admin: $CHRONOS_ADMIN" http://localhost:7777/api/sessions/b891d5f6-1234-4000-8000-000000000000/input -d \'{"text":"y"}\'');
  assert.equal(post.kind, "act");
  assert.equal(post.text, "POST /sessions/b891d5f6/input");
  assert.equal(post.sid, "b891d5f6");
  const get = h("run curl -s http://localhost:7777/api/desk");
  assert.equal(get.kind, "read");
  assert.equal(get.text, "Read /desk");
});

test("files, searches, engine warnings and anything else still become a readable step", () => {
  assert.equal(h("Read /Users/dev/chronos/notes/atlas/brief.md").text, "Read brief.md");
  assert.equal(h("search flyway").icon, "🔎");
  assert.equal(h("⚠️ engine degradado: cursor (grok también falló)").kind, "warn");
  assert.match(h("run ls -la /tmp").text, /^Ran ls -la \/tmp/);
  assert.equal(humanizeStep("   "), null);
});

test("nothing that looks like a credential reaches a step", () => {
  const s = h('run FOO_TOKEN=abc123secret python3 x.py -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh" sk-ant-api03-aaaaaaaaaaaaaaaaaaaa');
  assert.doesNotMatch(s.text, /abc123secret|eyJhbGci|sk-ant-api03-a/);
  assert.match(h('run mc session send b891d5f6 "use key ghp_abcdefghijklmnopqrstuvwxyz"').text, /•••/);
});
