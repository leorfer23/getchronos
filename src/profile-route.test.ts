import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlternates, routeConfigDir, routeProfileForHost } from "./profile-route.js";

const profiles = { claude: "/h/.claude", "claude-leo.osn92": "/h/.claude-leo.osn92", "claude-b": "/h/.claude-b", "claude-acme": "/h/.claude-acme" };
const alternates = parseAlternates("claude=claude-leo.osn92,claude-b;bogus=claude-b;claude-acme=", profiles);
const walled = (dirs: string[]) => (d: string) => (dirs.includes(d) ? { window: "weekly", resetsAt: "2026-09-30T17:00:00.000Z" } : null);
const exists = () => true;

test("parseAlternates: names resolve through profiles; unknown bases and empty groups drop", () => {
  assert.deepEqual([...alternates.entries()], [["/h/.claude", ["/h/.claude-leo.osn92", "/h/.claude-b"]]]);
});

test("pinned profile with room stays put", () => {
  assert.deepEqual(routeConfigDir("/h/.claude", null, 0, { alternates, wallOf: walled([]), exists }), { dir: "/h/.claude", reason: null });
});

test("walled pinned profile moves to the first sibling with room", () => {
  const r = routeConfigDir("/h/.claude", null, 0, { alternates, wallOf: walled(["/h/.claude"]), exists });
  assert.equal(r.dir, "/h/.claude-leo.osn92");
  assert.match(r.reason!, /\.claude at its weekly limit until 2026-09-30T17:00:00\.000Z → \.claude-leo\.osn92/);
});

test("walled sibling and missing dirs are skipped", () => {
  const r = routeConfigDir("/h/.claude", null, 0, { alternates, wallOf: walled(["/h/.claude", "/h/.claude-leo.osn92"]), exists });
  assert.equal(r.dir, "/h/.claude-b");
  const gone = routeConfigDir("/h/.claude", null, 0, { alternates, wallOf: walled(["/h/.claude"]), exists: (d) => d !== "/h/.claude-leo.osn92" });
  assert.equal(gone.dir, "/h/.claude-b");
});

test("everything walled → pinned (the wall failover takes over)", () => {
  const r = routeConfigDir("/h/.claude", null, 0, { alternates, wallOf: walled(["/h/.claude", "/h/.claude-leo.osn92", "/h/.claude-b"]), exists });
  assert.deepEqual(r, { dir: "/h/.claude", reason: null });
});

test("a profile with no alternates never leaves its account", () => {
  assert.equal(routeConfigDir("/h/.claude-acme", null, 0, { alternates, wallOf: walled(["/h/.claude-acme"]), exists }).dir, "/h/.claude-acme");
});

// A remote host: the wall is read on the brain, the sibling must be one the host reports having.
const onHost = (host: Array<{ name: string; exists: boolean }>, walledDirs: string[]) =>
  routeProfileForHost("/h/.claude", "claude", null, host, 0, { alternates, wallOf: walled(walledDirs), profiles });

test("host: pinned with room stays put, whatever the host has", () => {
  assert.deepEqual(onHost([{ name: "claude-leo.osn92", exists: true }], []), { dir: "/h/.claude", reason: null, profile: "claude", note: null });
});

test("host: walled pinned moves to a sibling the host reports — sent as its NAME, dir stays the brain's", () => {
  const r = onHost([{ name: "claude", exists: true }, { name: "claude-leo.osn92", exists: true }], ["/h/.claude"]);
  assert.equal(r.profile, "claude-leo.osn92");
  assert.equal(r.dir, "/h/.claude-leo.osn92", "the usage meter reads this account by its brain dir");
  assert.match(r.reason!, /\.claude at its weekly limit .* → \.claude-leo\.osn92/);
  assert.equal(r.note, null);
});

test("host: a sibling the host lacks (or reports but has not set up) is skipped for the next it has", () => {
  const r = onHost([{ name: "claude-leo.osn92", exists: false }, { name: "claude-b", exists: true }], ["/h/.claude"]);
  assert.equal(r.profile, "claude-b");
  assert.equal(r.dir, "/h/.claude-b");
});

test("host: no sibling there → the pinned profile, as before, with a note saying why", () => {
  const r = onHost([{ name: "claude", exists: true }], ["/h/.claude"]);
  assert.equal(r.profile, "claude");
  assert.equal(r.dir, "/h/.claude");
  assert.equal(r.reason, null);
  assert.match(r.note!, /\.claude is walled but claude-leo\.osn92 is not set up on that host → staying on claude/);
  // A host that never reported anything is not assumed to have anything.
  assert.equal(onHost([], ["/h/.claude"]).profile, "claude");
});

test("host: every sibling walled too → pinned, no note (nothing better existed anywhere)", () => {
  const r = onHost([{ name: "claude-leo.osn92", exists: true }, { name: "claude-b", exists: true }], ["/h/.claude", "/h/.claude-leo.osn92", "/h/.claude-b"]);
  assert.deepEqual(r, { dir: "/h/.claude", reason: null, profile: "claude", note: null });
});

test("host: the pinned name is passed through untouched when nothing moves", () => {
  const r = routeProfileForHost("/h/.claude-acme", "claude-acme", null, [{ name: "claude", exists: true }], 0, { alternates, wallOf: walled(["/h/.claude-acme"]), profiles });
  assert.deepEqual(r, { dir: "/h/.claude-acme", reason: null, profile: "claude-acme", note: null });
});
