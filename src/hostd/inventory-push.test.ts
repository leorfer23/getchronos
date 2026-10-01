import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InventoryPusher, inventoryKey, speaksInventory, type GhDirs } from "./inventory-push.js";
import type { HostToBrain, Inventory } from "../hostlink/wire.js";

type Frame = Extract<HostToBrain, { t: "inventory" }>;
const inv = (over: Partial<Inventory> = {}): Inventory => ({
  clis: [{ name: "claude", path: "/opt/homebrew/bin/claude", version: "2.0" }],
  profiles: [{ name: "claude", dir: "/Users/op/.claude", exists: true, auth: "yes" }],
  checkouts: [{ path: "/Users/op/GitHub/web", remote_url: "git@github.com:acme/web.git" }],
  gh: [{ dir: "default", workspaces: [], auth: "yes", account: "op" }],
  ...over,
});
const until = async (ok: () => boolean, ms = 2000) => {
  for (let t = 0; t < ms && !ok(); t += 10) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out");
};

function rig(o: { everyMs?: number; watch?: { home: string; roots: string[] } } = {}) {
  let current = inv();
  const sent: Frame[] = [];
  const asked: Array<GhDirs | null> = [];
  const p = new InventoryPusher({
    collect: async (gh) => { asked.push(gh); return current; },
    send: (f) => { sent.push(f); return true; },
    everyMs: o.everyMs ?? 60_000,
    debounceMs: 10,
    recheckMs: 60_000,
    watch: o.watch ?? null,
  });
  return { p, sent, asked, set: (i: Inventory) => { current = i; } };
}

test("only a 1.5+ brain is pushed to", () => {
  assert.equal(speaksInventory("1.5"), true);
  assert.equal(speaksInventory("1.12"), true);
  assert.equal(speaksInventory("2.0"), true);
  assert.equal(speaksInventory("1.4"), false);
  assert.equal(speaksInventory(undefined), false);
});

test("the key ignores order but not content", () => {
  const a = inv({ checkouts: [{ path: "/a", remote_url: null }, { path: "/b", remote_url: null }] });
  const b = inv({ checkouts: [{ path: "/b", remote_url: null }, { path: "/a", remote_url: null }] });
  assert.equal(inventoryKey(a), inventoryKey(b));
  assert.notEqual(inventoryKey(a), inventoryKey(inv({ profiles: [{ name: "claude", dir: "/Users/op/.claude", exists: true, auth: "no" }] })));
});

test("push sends only on change, only while online with a 1.5 brain; hello's inventory is the baseline", async () => {
  const r = rig();
  await r.p.push("periodic");
  assert.equal(r.sent.length, 0, "not online yet");
  r.p.online("1.4");
  await r.p.push("periodic");
  assert.equal(r.sent.length, 0, "an older brain would not know the frame");
  r.p.online("1.5");
  const i = inv();
  r.p.baseline({ capabilities: { clis: i.clis, node: "v22", sandbox: true }, profiles: i.profiles, checkouts: i.checkouts });
  await r.p.push("periodic");
  // hello carries no gh, so the first look (with gh) is new to the brain.
  assert.equal(r.sent.length, 1);
  await r.p.push("periodic");
  assert.equal(r.sent.length, 1, "nothing changed: nothing sent");
  r.set(inv({ profiles: [...i.profiles, { name: "claude-acme", dir: "/Users/op/.claude-acme", exists: true, auth: "yes" }] }));
  await r.p.push("profiles");
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].t, "inventory");
  assert.equal(r.sent[1].reason, "profiles");
  assert.ok(r.sent[1].profiles.some((p) => p.name === "claude-acme"));
  r.p.offline();
  r.set(inv());
  await r.p.push("periodic");
  assert.equal(r.sent.length, 2, "offline: nothing sent");
  await r.p.push("forced", true);
  assert.equal(r.sent.length, 2);
});

test("the brain's gh dirs are probed on arrival and on every look after; the same dirs again are free", async () => {
  const r = rig();
  r.p.online("1.5");
  const dirs = [{ dir: "~/.config/gh-acme", workspaces: ["acme"] }];
  r.p.setGhDirs(dirs);
  await until(() => r.asked.length === 1);
  assert.deepEqual(r.asked[0], dirs);
  r.p.setGhDirs([{ dir: "~/.config/gh-acme", workspaces: ["acme"] }]);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.asked.length, 1, "unchanged dirs: no new look");
  r.p.setGhDirs("garbage");
  await until(() => r.asked.length === 2);
  assert.deepEqual(r.asked[1], []);
  assert.deepEqual(r.p.gh, []);
});

test("snapshot (the Refresh rpc) is returned, not sent, and becomes the baseline", async () => {
  const r = rig();
  r.p.online("1.5");
  const got = await r.p.snapshot();
  assert.deepEqual(got, inv());
  await r.p.push("periodic");
  assert.equal(r.sent.length, 0, "the brain already applied what the rpc returned");
});

test("periodic: the timer looks again on its own", async () => {
  const r = rig({ everyMs: 20 });
  r.p.online("1.5");
  r.p.start();
  try {
    await until(() => r.sent.length === 1);
    r.set(inv({ checkouts: [] }));
    await until(() => r.sent.length === 2);
    assert.deepEqual(r.sent[1].checkouts, []);
    assert.equal(r.sent[1].reason, "periodic");
  } finally {
    r.p.stop();
  }
});

test("a new ~/.claude-* directory triggers a look soon, without waiting for the timer", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "invp-home-"));
  const r = rig({ watch: { home, roots: [] } });
  r.p.online("1.5");
  await r.p.push("periodic");
  const before = r.asked.length;
  r.p.start();
  try {
    await new Promise((res) => setTimeout(res, 50));
    fs.mkdirSync(path.join(home, "unrelated"));
    fs.mkdirSync(path.join(home, ".claude-acme"));
    await until(() => r.asked.length > before);
  } finally {
    r.p.stop();
  }
});
