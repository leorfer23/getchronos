import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installClaudeHooks } from "./term-hooks.js";
import {
  _resetUsage,
  noteClaudeStatusline,
  noteClaudeStreamEvent,
  parseGrokBilling,
  setUsageNotifier,
  usageSnapshot,
} from "./usage-meter.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const inHours = (h: number) => Math.floor((NOW + h * 3600_000) / 1000);
const noGrok = { grokLog: "/nonexistent/unified.jsonl" };
let sent: string[] = [];

beforeEach(() => {
  _resetUsage();
  sent = [];
  setUsageNotifier((t) => sent.push(t));
});

test("statusLine rate_limits land per profile, in percent", () => {
  noteClaudeStatusline("/Users/x/.claude-atlas", {
    five_hour: { used_percentage: 34.24, resets_at: inHours(2) },
    seven_day: { used_percentage: 71, resets_at: inHours(50) },
  }, NOW);
  const m = usageSnapshot(NOW, noGrok).meters.find((x) => x.scope === ".claude-atlas")!;
  assert.equal(m.cli, "claude");
  assert.deepEqual(m.windows.map((w) => [w.name, w.usedPct]), [["5h", 34.2], ["week", 71]]);
  assert.equal(m.source, "statusline");
});

test("stream-json unifiedWindows utilization is a fraction", () => {
  noteClaudeStreamEvent("/Users/x/.claude-cedar", {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.13, resetsAt: inHours(1) }, seven_day: { utilization: 0.73, resetsAt: inHours(40) } } },
  }, NOW);
  noteClaudeStreamEvent("/Users/x/.claude-cedar", { type: "assistant" }, NOW);
  const m = usageSnapshot(NOW, noGrok).meters.find((x) => x.scope === ".claude-cedar")!;
  assert.deepEqual(m.windows.map((w) => w.usedPct), [13, 73]);
});

test("an overage event without unifiedWindows changes nothing", () => {
  noteClaudeStreamEvent("/p/.claude", { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "overage" } }, NOW);
  const m = usageSnapshot(NOW, noGrok).meters.find((x) => x.cli === "claude")!;
  assert.equal(m.windows.length, 0);
  assert.match(m.note!, /no reading/);
});

test("alerts once at 80%, once more at 95%, again next window", () => {
  const rl = (p: number, reset = inHours(2)) => ({ five_hour: { used_percentage: p, resets_at: reset } });
  noteClaudeStatusline("/p/.claude-gfm", rl(79), NOW);
  assert.equal(sent.length, 0);
  noteClaudeStatusline("/p/.claude-gfm", rl(81), NOW);
  noteClaudeStatusline("/p/.claude-gfm", rl(85), NOW);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude \(gfm\) at 81%<\/b> of its 5-hour limit/);
  noteClaudeStatusline("/p/.claude-gfm", rl(96), NOW);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /🔴/);
  noteClaudeStatusline("/p/.claude-gfm", rl(97, inHours(7)), NOW);
  assert.equal(sent.length, 3, "a new window period alerts again — straight to crit, one message");
});

test("a window whose reset has passed drops out of the snapshot", () => {
  noteClaudeStatusline("/p/.claude", { five_hour: { used_percentage: 90, resets_at: inHours(-1) }, seven_day: { used_percentage: 20, resets_at: inHours(30) } }, NOW);
  const m = usageSnapshot(NOW, noGrok).meters.find((x) => x.cli === "claude")!;
  assert.deepEqual(m.windows.map((w) => w.name), ["week"]);
});

test("grok: newest billing line wins; cursor is unmeasured, never 0", () => {
  const line = (p: number, ts: string) => JSON.stringify({ ts, msg: "billing: fetched credits config", ctx: { config: { creditUsagePercent: p, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-24T14:07:14Z" } }, subscriptionTier: "SuperGrok" } });
  const tail = [line(4, "2026-09-18T09:00:00Z"), '{"msg":"other"}', line(6, "2026-09-18T11:58:08Z"), "{partial"].join("\n");
  const g = parseGrokBilling(tail)!;
  assert.deepEqual(g.windows, [{ name: "week", usedPct: 6, resetsAt: "2026-09-24T14:07:14Z" }]);
  assert.equal(g.at, "2026-09-18T11:58:08Z");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-grok-"));
  const log = path.join(dir, "unified.jsonl");
  fs.writeFileSync(log, tail + "\n" + line(88, "2026-09-18T11:59:00Z") + "\n");
  const snap = usageSnapshot(NOW, { grokLog: log });
  assert.equal(snap.meters.find((m) => m.cli === "grok")!.windows[0].usedPct, 88);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Grok at 88%<\/b> of its weekly limit/);
  const cursor = snap.meters.find((m) => m.cli === "cursor")!;
  assert.equal(cursor.windows.length, 0);
  assert.ok(cursor.note);
});

test("installClaudeHooks adds our statusLine, never replaces the operator's", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "usage-prof-"));
  installClaudeHooks(a);
  const s1 = JSON.parse(fs.readFileSync(path.join(a, "settings.json"), "utf8"));
  assert.match(s1.statusLine.command, /\.mc\/bin\/mc" statusline claude/);
  assert.equal(installClaudeHooks(a), "noop");

  const b = fs.mkdtempSync(path.join(os.tmpdir(), "usage-prof-"));
  fs.writeFileSync(path.join(b, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "~/my-line.sh" } }));
  installClaudeHooks(b);
  const s2 = JSON.parse(fs.readFileSync(path.join(b, "settings.json"), "utf8"));
  assert.equal(s2.statusLine.command, "~/my-line.sh");
});
