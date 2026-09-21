/**
 * Desk right-click → Promote to Lead (terminal.ts promoteToLead). A Lead's persona and credential only
 * exist from spawn, so promotion is: row → role=lead, then reopen under the same id. What is asserted
 * here is the part that decides whether that reopened pty is really a Lead.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { leadPromotionError, promotionSeed, resumeOpts } from "./terminal.js";

beforeEach(() => db.exec("DELETE FROM sessions; DELETE FROM workspaces;"));

let n = 0;
const mkWs = () => workspaces.create({ slug: `lpr${++n}`, name: "Acme", config_dir: "/tmp/lpr" + n });

test("only a plain terminal in a workspace may be promoted — no nesting, no second promotion", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, role: "lead", goal: "g", cwd: "/tmp" });
  const worker = sessions.create({ workspace_id: ws.id, role: "worker", cwd: "/tmp", lead_id: lead.id } as any);
  const plain = sessions.create({ workspace_id: ws.id, cwd: "/tmp" });
  const homeless = sessions.create({ cwd: "/tmp" });
  assert.equal(leadPromotionError(plain), null);
  assert.match(leadPromotionError(lead)!, /already a Lead/);
  assert.match(leadPromotionError(worker)!, /no nesting/);
  assert.match(leadPromotionError(homeless)!, /workspace/);
});

test("a promoted row reopens as a Lead with a fresh credential, under the same id", () => {
  const ws = mkWs();
  const s = sessions.create({ workspace_id: ws.id, goal: "ship X", cwd: "/tmp" });
  assert.equal(sessions.leadToken(s.id), null, "a plain terminal has no credential");
  sessions.end(s.id);
  sessions.setRole(s.id, "lead");
  const opts = resumeOpts(sessions.get(s.id)!);
  assert.equal(opts.resumeId, s.id);
  assert.equal(opts.role, "lead", "openSession reads the persona + MC_LEAD_TOKEN off this role");
  sessions.revive(s.id);
  assert.match(sessions.leadToken(s.id) ?? "", /^[0-9a-f]{32}$/, "revive mints the Lead's token");
  assert.equal((sessions.get(s.id) as any).lead_token, undefined, "and it never rides the row out");
});

test("the promoted agent is told what changed; a CLI with no system-prompt channel gets the persona inline", () => {
  const sys = promotionSeed("ship X", true);
  assert.match(sys, /promoted you to LEAD for this goal: ship X/);
  assert.match(sys, /in your system prompt/);
  assert.match(sys, /mc session new/);
  const inline = promotionSeed(null, false);
  assert.ok(inline.length > sys.length, "the Lead persona is folded into the seed");
  assert.match(inline, /for the work in this conversation/);
});
