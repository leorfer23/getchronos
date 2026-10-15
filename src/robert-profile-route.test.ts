/**
 * Robert follows the same sibling-account routing as terminals and jobs (profile-route.ts): when the
 * workspace's Claude login is walled, his warm managers run on the sibling instead of dropping to
 * grok → cursor ("⚠️ engine degradado: cursor (primary en cooldown)" with a second login idle).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { db, workspaces } from "./store.js";
import { _resetUsage, noteClaudeStatusline } from "./usage-meter.js";
import { webProfileDir } from "./telegram/agent.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "robert-route-"));
const main = path.join(root, ".claude"), alt = path.join(root, ".claude-alt");
fs.mkdirSync(main); fs.mkdirSync(alt);
const saved = CONFIG.profileAlternates;

beforeEach(() => {
  db.exec("DELETE FROM workspaces;");
  _resetUsage();
  (CONFIG as any).profileAlternates = `${main}=${alt}`;
});
after(() => {
  (CONFIG as any).profileAlternates = saved;
  fs.rmSync(root, { recursive: true, force: true });
});

const wall = (dir: string, pct: number) => {
  const reset = Math.floor((Date.now() + 2 * 86_400_000) / 1000);
  noteClaudeStatusline(dir, { five_hour: { used_percentage: 0, resets_at: reset }, seven_day: { used_percentage: pct, resets_at: reset } });
};

test("a walled workspace account hands Robert to its sibling login", () => {
  const ws = workspaces.create({ slug: "rr1", name: "RR", config_dir: main });
  assert.equal(webProfileDir(ws.id), main, "no reading = room: stays on its own account");
  wall(main, 100);
  assert.equal(webProfileDir(ws.id), alt);
});

test("both walled, or no sibling configured → the pinned account", () => {
  const ws = workspaces.create({ slug: "rr2", name: "RR", config_dir: main });
  wall(main, 100); wall(alt, 100);
  assert.equal(webProfileDir(ws.id), main);
  (CONFIG as any).profileAlternates = "";
  _resetUsage(); wall(main, 100);
  assert.equal(webProfileDir(ws.id), main, "a workspace with no alternates never leaves its account");
});

test("the warm managers recycle on an account move and key their cooldown by account", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/telegram/agent.ts"), "utf8");
  assert.equal((src.match(/m\.profileDir !== dir/g) ?? []).length, 3, "web, Telegram-per-workspace, Telegram");
  assert.match(src, /key: acctKey\(`web:\$\{key\}`, m\)/);
  assert.match(src, /const tgKey = acctKey\(/);
});
