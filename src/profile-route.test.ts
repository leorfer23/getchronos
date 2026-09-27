import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlternates, routeConfigDir } from "./profile-route.js";

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
