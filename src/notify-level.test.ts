import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * PER-26: ~50 alert types shared one Telegram chat with Robert's own voice, so his proactive briefs
 * read as machine noise. `info` notices still land on the board — they just stop interrupting.
 *
 * These are source-level assertions on purpose: the routing decision IS the classification of each
 * call site, and that is what regresses. A future notify() that pings the phone for "hygiene ran"
 * is the bug, and no runtime test of the transport would catch it.
 */

const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");

test("info notices are dropped before the wire, but still reach the board", () => {
  const src = read("telegram/api.ts");
  const boardIdx = src.indexOf("postToBoard");
  const gateIdx = src.indexOf('opts?.level === "info"');
  assert.ok(gateIdx > 0, "the info gate must exist");
  assert.ok(boardIdx < gateIdx, "the board post must happen BEFORE the info return — info is quiet, not lost");
  assert.ok(src.indexOf("sendMessage", gateIdx) > gateIdx, "the Telegram send must sit after the gate");
});

test("the default is action, so an unclassified call site stays loud", () => {
  const src = read("telegram/api.ts");
  // The gate fires only on an EXPLICIT "info". Anything else — including undefined — falls through
  // to the send. Forgetting to classify must never silence a blocker.
  assert.match(src, /opts\?\.level === "info"/);
  assert.ok(!/level\s*\?\?\s*"info"/.test(src), "info must never be the fallback");
});

test("CHRONOS_NOTIFY_ALL restores the old firehose", () => {
  const src = read("telegram/api.ts");
  assert.match(src, /CHRONOS_NOTIFY_ALL/);
  assert.match(src, /NOTIFY_ALL/);
});

// The classification itself. If someone re-promotes one of these to the phone, that is a decision
// worth making on purpose — this test makes them do it on purpose.
const INFO_SITES: Array<[string, string]> = [
  ["delivery.ts", "PR merged"],
  ["delivery.ts", "post-merge ran"],
  ["delivery.ts", "dispatched auto-fix"],
  ["autoplan.ts", "auto-planning"],
  ["autoplan.ts", "scout panel on"],
  ["autoplan.ts", "grading"],
  ["autoplan.ts", "AI reviewing"],
  ["hygiene.ts", "🧹 <b>Memory</b>"], // the stow nudge — the compaction narration left with the job (dream pass)
  ["burn-guard.ts", "Burn rate normal"],
  ["monitor.ts", "Idle terminal"],
  ["monitor.ts", "Weekly reports"],
  ["self-deploy.ts", "Chronos deployed"],
];

for (const [file, needle] of INFO_SITES) {
  test(`${file}: "${needle}" does not interrupt him`, () => {
    const line = read(file).split("\n").find((l) => l.includes(needle) && /notify/.test(l));
    assert.ok(line, `no notify line containing "${needle}" in ${file}`);
    assert.match(line!, /notifyInfo\(/, `"${needle}" should be narration, not an interruption`);
  });
}

// The other half of the contract: these MUST keep reaching the phone.
const ACTION_SITES: Array<[string, string]> = [
  ["monitor.ts", "still waiting"], // an ask is blocking a worker
  ["monitor.ts", "Daily budget hit"],
  ["monitor.ts", "DB backup failed"],
  ["monitor.ts", "Stuck run"],
  ["merge-gate.ts", "merge gate held the PR"],
  ["merge-gate.ts", "gave no verdict"],
  ["delivery.ts", "CI still failing"],
  ["delivery.ts", "PR closed without merge"],
  ["self-deploy.ts", "Self-deploy blocked"],
  ["self-deploy.ts", "Chronos is stale"],
];

for (const [file, needle] of ACTION_SITES) {
  test(`${file}: "${needle}" still reaches him`, () => {
    const line = read(file).split("\n").find((l) => l.includes(needle) && /notify/.test(l));
    assert.ok(line, `no notify line containing "${needle}" in ${file}`);
    assert.ok(!/notifyInfo\(/.test(line!), `"${needle}" needs a human — it must not be downgraded`);
  });
}

test("Robert's proactive brief is signed, so his voice is findable in the stream", () => {
  const src = read("heartbeat.ts");
  assert.match(src, /👔 <b>Robert<\/b>/, "the hourly brief must be attributed to him, not to the system");
});
