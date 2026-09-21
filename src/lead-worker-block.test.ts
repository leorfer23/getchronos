/**
 * What a Lead's WORKER is told about its Lead (LEADS.md) — the block terminal.ts folds into its
 * system prompt, ahead of FOCUS_CONTRACT.
 *
 * It exists because the worker side of a Lead was invisible from inside the worker: it did not know
 * it had one, its only way to report was to stop and be scraped, and `mc ask-robert` went over its
 * Lead's head. Everything asserted here is a sentence a real agent has to be able to act on.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { leadWorkerBlock } from "./terminal.js";
import { agentBlock } from "./agent-defs.js";

beforeEach(() => db.exec("DELETE FROM sessions; DELETE FROM workspaces;"));

let n = 0;
const mkWs = () => workspaces.create({ slug: `lwb${++n}`, name: "Acme", config_dir: "/tmp/lwb" + n });

test("a worker of a live Lead is told whose it is, that goal, and the three commands", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, role: "lead", goal: "ship the flyway rollback", cwd: "/tmp" });
  const worker = sessions.create({ workspace_id: ws.id, role: "worker", cwd: "/tmp", lead_id: lead.id } as any);

  const block = leadWorkerBlock(worker);
  assert.match(block, new RegExp(`Lead \`${lead.id.slice(0, 8)}\``), "which Lead, by id8");
  assert.match(block, /ship the flyway rollback/, "and what that Lead is trying to do");
  assert.match(block, /one slice of that goal/, "its brief is a slice, not the goal");
  assert.match(block, /mc report/);
  assert.match(block, /BEFORE you stop/, "the whole point: report, then stop");
  assert.match(block, /mc ask-lead/);
  assert.match(block, /never message anyone outside Chronos/i);
  // Short enough to sit ahead of FOCUS_CONTRACT in every worker of every Lead.
  assert.ok(block.split("\n").filter((l) => l.trim()).length <= 10, `${block.split("\n").length} lines`);
  // The editor's notes are notes, not instructions to the model.
  assert.ok(!block.includes("<!--"));
  assert.ok(!/\{\{/.test(block), "every placeholder is filled, or the throw in interpolate fires");
});

test("every other terminal gets nothing — no Lead, an ended Lead, or a Lead that is no longer one", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, role: "lead", goal: "ship X", cwd: "/tmp" });
  assert.equal(leadWorkerBlock({ lead_id: null }), "", "a terminal the operator opened");
  assert.equal(leadWorkerBlock({ lead_id: "no-such-session" }), "");
  assert.equal(leadWorkerBlock({ lead_id: lead.id }).length > 0, true);
  sessions.end(lead.id);
  assert.equal(leadWorkerBlock({ lead_id: lead.id }), "", "an orphan is told nothing it cannot act on");
  // A Lead itself: its own lead_id is null (a Lead may not open a Lead), so it never gets this block.
  assert.equal(leadWorkerBlock(sessions.get(lead.id)!), "");
});

test("a Lead with no goal still produces a usable block rather than an empty sentence", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, role: "lead", cwd: "/tmp" } as any);
  const worker = sessions.create({ workspace_id: ws.id, role: "worker", cwd: "/tmp", lead_id: lead.id } as any);
  assert.match(leadWorkerBlock(worker), /goal is: \(no goal set\)/);
});

test("agentBlock reads agents/_blocks, fills what the closed var list cannot, and still catches a typo", () => {
  const out = agentBlock("lead-worker", { lead_id8: "abcdef01", lead_goal: "ship X" });
  assert.match(out, /abcdef01/);
  assert.match(out, /ship X/);
  assert.throws(() => agentBlock("no-such-block"), /agents\/_blocks\/no-such-block\.md/);
  // An unfilled placeholder is loud, not a literal `{{lead_goal}}` shipped to a live agent.
  assert.throws(() => agentBlock("lead-worker"), /unknown placeholder \{\{lead_id8\}\}/);
});

test("terminal.ts folds it in ahead of the reporting contract, and exports the Lead's id to the worker", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/terminal.ts"), "utf8");
  // Persona (a Lead) → the Lead block (a worker) → FOCUS_CONTRACT: who you are before how you report.
  assert.match(src, /\[row\.role === "lead" \? agentPrompt\("lead"\) : null, leadBlock, FOCUS_CONTRACT, ctx, rel\]/);
  // Backends with no system-prompt channel (cursor) get it in the seed, or their workers would be
  // the only ones never told they have a Lead.
  assert.match(src, /const pre = \[leadBlock, FOCUS_CONTRACT, ctx\]\.filter\(Boolean\)\.join\("\\n\\n"\);/);
  // An id, not a credential: `mc` reads it only to know it has a Lead to ask.
  assert.match(src, /MC_LEAD_ID: row\.lead_id/);
});

test("`mc` routes a worker's ask-robert to its Lead off that env var, and --robert goes over its head", () => {
  const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
  assert.match(mc, /const toLead = \(asLead \|\| !!process\.env\.MC_LEAD_ID\) && !opt\.robert;/);
  assert.match(mc, /\.\.\.\(toLead \? \{ route: "lead" \} : \{\}\)/);
});
