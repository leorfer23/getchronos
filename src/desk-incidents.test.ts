import { test } from "node:test";
import assert from "node:assert/strict";
import { EARLY_DEATH_MS, INCIDENT_THROTTLE_MS, earlyDeathPost, evidenceLines, isEarlyDeath, reportEarlyDeath, resetIncidentThrottle } from "./desk-incidents.js";
import { board } from "./store.js";

const sess = (o: Partial<any> = {}): any => ({
  id: "0a22b516-0000-4000-8000-000000000000", backend: "grok", model: null, cwd: "/Users/x/Documents/GitHub/personal",
  created_by: "robert", goal: "Grok · Personal", spawn_goal: "Grok · Personal", workspace_id: null, ...o,
});

test("an early death is a seeded terminal that nobody killed, no goal ticked, gone inside the window", () => {
  assert.equal(isEarlyDeath({ aliveMs: 3_000, seeded: true, killed: false, goalDone: false }), true);
  assert.equal(isEarlyDeath({ aliveMs: 3_000, seeded: false, killed: false, goalDone: false }), false, "a bare chat closed at once is not an incident");
  assert.equal(isEarlyDeath({ aliveMs: 3_000, seeded: true, killed: true, goalDone: false }), false, "the operator or Robert closing it is not an incident");
  assert.equal(isEarlyDeath({ aliveMs: 3_000, seeded: true, killed: false, goalDone: true }), false, "a one-liner that ticked its goal and left is fine");
  assert.equal(isEarlyDeath({ aliveMs: EARLY_DEATH_MS, seeded: true, killed: false, goalDone: false }), false);
});

test("evidence is the last lines that say something", () => {
  assert.deepEqual(evidenceLines(["", "  ", "a ", "", "b", "", ""], 5), ["a", "b"]);
  assert.deepEqual(evidenceLines(Array.from({ length: 30 }, (_, i) => `l${i}`)).length, 12);
});

test("the post names the terminal, who opened it, the goal, the screen, and the fix path", () => {
  const p = earlyDeathPost(sess(), 3_200, ["Do you trust the files in this folder?", "  Yes / No", ""]);
  assert.match(p, /^@robert 🧯 \*\*Terminal died 3s after spawn\*\* — `0a22b516` grok · opened by robert · `\/Users\/x\/Documents\/GitHub\/personal`/);
  assert.match(p, /Goal: Grok · Personal/);
  assert.match(p, /```\nDo you trust the files in this folder\?\n  Yes \/ No\n```/);
  assert.match(p, /~\/\.grok\/logs\/unified\.jsonl/);
  assert.match(p, /chronos-hotfix-deploy/);
  assert.match(earlyDeathPost(sess({ backend: "claude-code", model: "opus" }), 9_000, []), /claude-code\/opus[\s\S]*\(blank — the CLI produced no output\)[\s\S]*~\/\.claude\/projects/);
});

test("it lands on the board tagged @robert once per backend+folder per window, and is logged every time", () => {
  resetIncidentThrottle();
  const before = board.feed(200).length;
  const t0 = 1_000_000;
  assert.equal(reportEarlyDeath(sess(), 3_000, ["x"], t0), "posted");
  assert.equal(reportEarlyDeath(sess({ id: "e6a84a46-0000-4000-8000-000000000000" }), 3_500, ["y"], t0 + 60_000), "throttled");
  assert.equal(reportEarlyDeath(sess({ cwd: "/elsewhere" }), 3_500, ["z"], t0 + 60_000), "posted", "another folder is another incident");
  assert.equal(reportEarlyDeath(sess(), 3_000, ["x"], t0 + INCIDENT_THROTTLE_MS), "posted");
  const posts = board.feed(200);
  assert.equal(posts.length - before, 3);
  const mine = posts.find((p) => p.body.includes("`0a22b516`"))!;
  assert.equal(mine.author, "chronos");
  assert.deepEqual(JSON.parse(mine.mentions || "[]"), ["robert"]);
});
