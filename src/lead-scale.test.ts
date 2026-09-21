/**
 * Lead scale (LEADS.md Scale): per-Lead worker budget, cost rollup, adopt, orphan say-text.
 * Seat-cap cases never spawn a pty — openSession throws in the prologue (same as terminal-admission).
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { setLoadProbe, type MachineLoad } from "./machine.js";
import { db, leadEvents, leadSlices, sessions, workspaces } from "./store.js";
import { openSession } from "./terminal.js";
import { adoptLead, leadCostRollup, leadWorkerRows, sessionCostView } from "./api.js";
import { driveSay, orphanLeadLine, resetRobertDriveState } from "./robert-drive.js";

const QUIET: MachineLoad = {
  load1: 1.2, ncpu: 12, loadPerCore: 0.1, swapUsedMb: 100, swapTotalMb: 13312, pressureLevel: 1,
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-lead-scale-"));
let wsId: string;
const wsCapWas = CONFIG.maxSessionsPerWorkspace;
const leadCapWas = CONFIG.leadDrive.maxWorkers;

beforeEach(() => {
  for (const t of ["lead_events", "lead_slices", "sessions", "workspaces"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  wsId = workspaces.create({
    slug: "ls-" + randomUUID().slice(0, 8),
    name: "Scale",
    config_dir: tmp,
    sandbox_mode: "off",
  } as any).id;
  CONFIG.maxSessionsPerWorkspace = wsCapWas;
  CONFIG.leadDrive.maxWorkers = leadCapWas;
  setLoadProbe(() => QUIET);
  resetRobertDriveState();
});
after(() => {
  setLoadProbe(null);
  CONFIG.maxSessionsPerWorkspace = wsCapWas;
  CONFIG.leadDrive.maxWorkers = leadCapWas;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkLead = () =>
  sessions.create({ workspace_id: wsId, role: "lead", goal: "ship X", cwd: tmp, backend: "mock" });
const mkWorker = (leadId: string, over: Record<string, unknown> = {}) =>
  sessions.create({
    workspace_id: wsId, role: "worker", goal: "slice", cwd: tmp, backend: "mock",
    lead_id: leadId, ...over,
  } as any);

describe("1. per-Lead worker budget vs workspace seat cap", () => {
  test("a worker of a Lead is refused by maxWorkers, even when the workspace still has seats", async () => {
    const lead = mkLead();
    CONFIG.maxSessionsPerWorkspace = 20;
    CONFIG.leadDrive.maxWorkers = 2;
    mkWorker(lead.id);
    mkWorker(lead.id);
    await assert.rejects(
      () =>
        openSession({
          workspace_id: wsId,
          backend: "mock",
          created_by: `lead:${lead.id.slice(0, 8)}`,
          lead_id: lead.id,
          goal: "too many",
          cwd: tmp,
        } as any),
      /lead worker cap reached \(2\/2\)/,
    );
  });

  test("workers with lead_id do not consume workspace seats; the Lead itself does", async () => {
    CONFIG.maxSessionsPerWorkspace = 1;
    CONFIG.leadDrive.maxWorkers = 10;
    const lead = mkLead(); // occupies the one workspace seat
    mkWorker(lead.id);
    mkWorker(lead.id);
    mkWorker(lead.id);
    // Another non-worker (a Lead / operator terminal) still hits the workspace cap.
    await assert.rejects(
      () =>
        openSession({
          workspace_id: wsId,
          backend: "mock",
          created_by: "operator",
          goal: "another seat",
          cwd: tmp,
          role: "lead",
        } as any),
      /workspace session cap reached \(1\/1\)/,
    );
    // A worker open with the workspace full is NOT refused for the workspace reason — it is
    // refused only if the Lead's own cap is full. With maxWorkers=0 that is immediate.
    CONFIG.leadDrive.maxWorkers = 0;
    await assert.rejects(
      () =>
        openSession({
          workspace_id: wsId,
          backend: "mock",
          created_by: `lead:${lead.id.slice(0, 8)}`,
          lead_id: lead.id,
          goal: "worker past workspace",
          cwd: tmp,
        } as any),
      /lead worker cap reached \(3\/0\)|lead worker cap reached \(0\/0\)|lead worker cap reached/,
    );
  });
});

describe("2. mc session new signing", () => {
  test("scripts/mc signs agent:<MC_SESSION id8> when MC_AGENT_NAME is unset", () => {
    const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
    assert.match(mc, /agent:\$\{process\.env\.MC_SESSION\.slice\(0, 8\)\}/);
    assert.match(mc, /Without MC_AGENT_NAME, a bare `mc session new` used to sign "operator"/);
  });
});

describe("3. cost rollup", () => {
  test("sessionCostView / leadCostRollup / leadWorkerRows expose cost fields", () => {
    const lead = mkLead();
    const w = mkWorker(lead.id);
    db.prepare("UPDATE sessions SET cost_usd=1.25, tokens_in=100, tokens_out=50, turns=3 WHERE id=?").run(lead.id);
    db.prepare("UPDATE sessions SET cost_usd=0.75, tokens_in=40, tokens_out=20, turns=1, status='ended', ended_at=? WHERE id=?")
      .run(new Date().toISOString(), w.id);
    const view = sessionCostView(sessions.get(lead.id)!);
    assert.equal(view.cost_usd, 1.25);
    assert.equal(view.tokens_in, 100);
    const rows = leadWorkerRows(lead.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost_usd, 0.75);
    const roll = leadCostRollup(lead.id);
    // Ended worker is not in live rollup workers count, but lead cost is included.
    assert.equal(roll.workers, 0);
    assert.equal(roll.cost_usd, 1.25);
    // Live worker contributes too.
    const live = mkWorker(lead.id);
    db.prepare("UPDATE sessions SET cost_usd=2, tokens_in=10, tokens_out=5, turns=2 WHERE id=?").run(live.id);
    const roll2 = leadCostRollup(lead.id);
    assert.equal(roll2.workers, 1);
    assert.equal(roll2.cost_usd, 3.25);
  });
});

describe("4. adopt", () => {
  test("adopt moves live workers, board and inbox from an ended Lead", () => {
    const old = mkLead();
    const neu = mkLead();
    const live = mkWorker(old.id, { goal: "still going" });
    const done = mkWorker(old.id, { goal: "finished" });
    sessions.end(done.id);
    leadSlices.add(old.id, "migration");
    leadSlices.add(old.id, "rollback");
    leadSlices.add(neu.id, "already mine");
    leadEvents.add({ lead_id: old.id, session_id: live.id, kind: "turn", key: "k-adopt-1", payload: { id8: live.id.slice(0, 8) } });
    sessions.end(old.id);

    const out = adoptLead(neu.id, old.id);
    assert.equal(out.workers, 1);
    assert.equal(out.slices, 2);
    assert.equal(out.events, 1);
    assert.equal(sessions.get(live.id)!.lead_id, neu.id);
    assert.equal(sessions.get(done.id)!.lead_id, old.id, "ended workers stay on the old Lead");
    assert.deepEqual(leadSlices.list(neu.id).map((s) => s.title), ["already mine", "migration", "rollback"]);
    assert.equal(leadSlices.list(old.id).length, 0);
    assert.equal(leadEvents.recent(neu.id, { all: true }).length, 1);
    assert.equal(leadEvents.recent(old.id, { all: true }).length, 0);
  });

  test("/leads/me/adopt is leadGate-scoped and refuses a live target", () => {
    const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
    const at = api.indexOf('api.post("/leads/me/adopt"');
    assert.ok(at > 0);
    const body = api.slice(at, at + 900);
    assert.ok(body.includes("leadGate(req, res)"));
    assert.ok(body.includes("that Lead is still live"));
    assert.ok(body.includes("lead.adopted"));
  });
});

describe("5. orphan stop context for Robert", () => {
  test("orphanLeadLine / driveSay name the dead Lead's goal and board", () => {
    const lead = mkLead();
    leadSlices.add(lead.id, "a");
    leadSlices.add(lead.id, "b");
    leadSlices.patch(lead.id, 1, { status: "done" });
    const worker = mkWorker(lead.id);
    sessions.end(lead.id);
    const line = orphanLeadLine(worker);
    assert.ok(line);
    assert.match(line!, /ORPHAN/);
    assert.match(line!, new RegExp(lead.id.slice(0, 8)));
    assert.match(line!, /ship X/);
    assert.match(line!, /board 1\/2/);
    assert.match(line!, /mc lead adopt/);

    const say = driveSay(
      worker,
      "turn",
      { line: "waiting" },
      { result: null, said: "need a hand" },
      "Scale",
    );
    assert.match(say, /ORPHAN/);
    assert.match(say, /board 1\/2/);
    assert.match(say, /IT LAST SAID: need a hand/);

    // Live Lead → no orphan line.
    const live = mkLead();
    const w2 = mkWorker(live.id);
    assert.equal(orphanLeadLine(w2), null);
  });
});
