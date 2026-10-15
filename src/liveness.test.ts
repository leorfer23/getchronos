import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declaredWait, hasRecentWrite, lastTerminalOutputMs, stallVerdict, walkableCheckout } from "./liveness.js";
import type { Session } from "./types.js";

const cfg = { inspectCount: 3, pauseResurfaceMs: 240 * 60_000 };
const NONE = { events: false, ptyChurn: false, worktreeWrite: false };
const base = { quietMs: 22 * 60_000, escalations: 0, declaredWait: null, sinceSurfacedMs: null, cfg };

test("stallVerdict: recent events mean alive — nothing to overlay, no count", () => {
  const v = stallVerdict({ ...base, evidence: { ...NONE, events: true }, escalations: 4 });
  assert.equal(v.action, "alive");
  assert.equal(v.evidence, "events");
  assert.equal(v.escalations, 0);
  assert.equal(v.label, null);
  assert.equal(v.surface, false);
});

test("stallVerdict: pty churn defers with a label naming the evidence, never alarms", () => {
  const v = stallVerdict({ ...base, evidence: { ...NONE, ptyChurn: true } });
  assert.equal(v.action, "defer");
  assert.equal(v.evidence, "pty");
  assert.equal(v.label, "quiet 22m, terminal active");
  assert.equal(v.surface, false);
  assert.equal(v.demandInspection, false);
});

test("stallVerdict: worktree writes defer too, and pty wins when both are present", () => {
  const w = stallVerdict({ ...base, evidence: { ...NONE, worktreeWrite: true } });
  assert.equal(w.action, "defer");
  assert.equal(w.evidence, "worktree");
  assert.equal(w.label, "quiet 22m, still writing files");

  const both = stallVerdict({ ...base, evidence: { events: false, ptyChurn: true, worktreeWrite: true } });
  assert.equal(both.evidence, "pty"); // first hit wins — the cheaper probe
});

test("stallVerdict: any evidence clears an escalation count built up by earlier sweeps", () => {
  assert.equal(stallVerdict({ ...base, evidence: { ...NONE, ptyChurn: true }, escalations: 2 }).escalations, 0);
  assert.equal(stallVerdict({ ...base, evidence: { ...NONE, worktreeWrite: true }, escalations: 2 }).escalations, 0);
});

test("stallVerdict: no evidence escalates and counts, surfacing only the first check", () => {
  const first = stallVerdict({ ...base, evidence: NONE });
  assert.equal(first.action, "escalate");
  assert.equal(first.escalations, 1);
  assert.equal(first.surface, true);
  assert.equal(first.demandInspection, false);
  assert.equal(first.label, "quiet 22m, no liveness evidence");

  const second = stallVerdict({ ...base, evidence: NONE, escalations: 1 });
  assert.equal(second.escalations, 2);
  assert.equal(second.surface, false); // overlay stays fresh, the operator isn't told twice
});

test("stallVerdict: demand_inspection at the count, said once, then latched", () => {
  const third = stallVerdict({ ...base, evidence: NONE, escalations: 2 });
  assert.equal(third.escalations, 3);
  assert.equal(third.demandInspection, true);
  assert.equal(third.surface, true);
  assert.equal(third.label, "quiet 22m, no files written, no terminal output for 3 checks — needs a look");

  const fourth = stallVerdict({ ...base, evidence: NONE, escalations: 3 });
  assert.equal(fourth.demandInspection, true); // still needs a look
  assert.equal(fourth.surface, false); // but it is not said again
});

test("stallVerdict: a declared wait never escalates and resurfaces on the long cadence", () => {
  const never = stallVerdict({ ...base, evidence: NONE, declaredWait: "your review", escalations: 2 });
  assert.equal(never.action, "wait");
  assert.equal(never.escalations, 0);
  assert.equal(never.demandInspection, false);
  assert.equal(never.label, "quiet 22m, waiting on your review");
  assert.equal(never.surface, true); // never surfaced before

  const recent = stallVerdict({ ...base, evidence: NONE, declaredWait: "your review", sinceSurfacedMs: 60 * 60_000 });
  assert.equal(recent.surface, false); // an hour in, well inside the 4h cadence

  const overdue = stallVerdict({ ...base, evidence: NONE, declaredWait: "your review", sinceSurfacedMs: 241 * 60_000 });
  assert.equal(overdue.surface, true);
});

test("declaredWait: an open ask names the question, a held ticket names the operator", () => {
  assert.deepEqual(declaredWait({ openAskQuestion: "which env?" }), { on: "an answer: “which env?”", reason: "question" });
  assert.deepEqual(declaredWait({ ticketStatus: "review" }), { on: "your review", reason: "review" });
  assert.deepEqual(declaredWait({ ticketStatus: "planned" }), { on: "your approve/continue on the plan", reason: "approval" });
  assert.equal(declaredWait({ ticketStatus: "in_progress" }), null);
  assert.equal(declaredWait({}), null);
  // The ask wins over the ticket: it is the more specific thing someone owes.
  assert.equal(declaredWait({ openAskQuestion: "which env?", ticketStatus: "review" })?.reason, "question");
  assert.match(declaredWait({ openAskQuestion: "q".repeat(200) })!.on, /…”$/);
});

function tmpTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-liveness-"));
  fs.mkdirSync(path.join(root, "src", "deep", "deeper"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  return root;
}

// Everything the tree already holds, aged well before the quiet window under test.
function ageTree(root: string, ms: number) {
  const t = new Date(Date.now() - ms);
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      fs.utimesSync(p, t, t);
    }
  };
  walk(root);
}

test("hasRecentWrite: a file written inside the window is evidence, an old tree is not", () => {
  const root = tmpTree();
  const bounds = { prune: ["node_modules", ".git"], maxDepth: 6, timeoutMs: 2000 };
  fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
  ageTree(root, 60 * 60_000);
  const since = Date.now() - 20 * 60_000;
  assert.equal(hasRecentWrite(root, since, bounds), false);

  fs.writeFileSync(path.join(root, "src", "b.ts"), "x");
  assert.equal(hasRecentWrite(root, since, bounds), true);
});

test("hasRecentWrite: pruned directories are not evidence", () => {
  const root = tmpTree();
  ageTree(root, 60 * 60_000);
  const since = Date.now() - 20 * 60_000;
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "x");
  // The write bumps node_modules/pkg's mtime, but pruning stops the walk at node_modules itself.
  assert.equal(hasRecentWrite(root, since, { prune: ["node_modules"], maxDepth: 6, timeoutMs: 2000 }), false);
  assert.equal(hasRecentWrite(root, since, { prune: [], maxDepth: 6, timeoutMs: 2000 }), true);
});

test("hasRecentWrite: the depth bound stops the walk", () => {
  const root = tmpTree();
  ageTree(root, 60 * 60_000);
  const since = Date.now() - 20 * 60_000;
  fs.writeFileSync(path.join(root, "src", "deep", "deeper", "x.ts"), "x");
  // maxDepth 1 reaches src/deep's entries; it never looks inside src/deep/deeper, and deep's own
  // mtime did not move (the write was two levels down).
  assert.equal(hasRecentWrite(root, since, { prune: [], maxDepth: 1, timeoutMs: 2000 }), false);
  assert.equal(hasRecentWrite(root, since, { prune: [], maxDepth: 3, timeoutMs: 2000 }), true);
});

test("hasRecentWrite: a blown deadline or a missing tree reads as no evidence, never as alive", () => {
  const root = tmpTree();
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "x");
  const since = Date.now() - 20 * 60_000;
  const bounds = { prune: [], maxDepth: 6, timeoutMs: 1 };
  // Injected clock: the deadline is already 10s in the past, so the walk gives up before reading.
  assert.equal(hasRecentWrite(root, since, bounds, Date.now() - 10_000), false);
  assert.equal(hasRecentWrite(root, since, { ...bounds, timeoutMs: 2000 }), true);
  assert.equal(hasRecentWrite(path.join(root, "nope"), since, { ...bounds, timeoutMs: 2000 }), false);
});

test("walkableCheckout: only a real checkout, never a bare home directory", () => {
  const root = tmpTree();
  assert.equal(walkableCheckout(root), null); // no .git — not a checkout we will walk
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere"); // worktree shape
  assert.equal(walkableCheckout(root), path.resolve(root));
  assert.equal(walkableCheckout(os.homedir()), null);
  assert.equal(walkableCheckout("/"), null);
  assert.equal(walkableCheckout(null), null);
});

const sess = (o: Partial<Session>): Session =>
  ({ id: "s1", ticket_id: null, cwd: "/tmp/x", worktree_path: null, ...o }) as Session;

test("lastTerminalOutputMs: newest output across the terminals on this run's ticket or checkout", () => {
  const rows = [
    sess({ id: "a", ticket_id: "T1" }),
    sess({ id: "b", cwd: "/wt/mc-T1" }),
    sess({ id: "c", ticket_id: "OTHER", cwd: "/elsewhere" }),
    sess({ id: "d", cwd: "/repo", worktree_path: "/wt/mc-T1" }),
  ];
  const out: Record<string, number | null> = { a: 100, b: 300, c: 999_999, d: null };
  const probe = { live: () => rows, activity: (id: string) => ({ last_out: out[id] ?? null }) };

  assert.equal(lastTerminalOutputMs({ ticketId: "T1", cwd: "/wt/mc-T1" }, probe), 300);
  assert.equal(lastTerminalOutputMs({ ticketId: "T1", cwd: null }, probe), 100);
  assert.equal(lastTerminalOutputMs({ ticketId: null, cwd: null }, probe), null); // nothing to match on
  assert.equal(lastTerminalOutputMs({ ticketId: "NONE", cwd: "/nowhere" }, probe), null);
});
