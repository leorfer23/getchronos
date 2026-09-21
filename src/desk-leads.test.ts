/**
 * GET /desk's Lead fields (LEADS.md Desk spec): a worker carries the live Lead that opened it,
 * a Lead carries its live worker count. No pty — the store is the whole surface under test.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { deskLeadFields, spawnLeadFields } from "./api.js";
import { OpenSessionSchema } from "./validation.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

let n = 0;
const mkWs = () => workspaces.create({ slug: `leads${++n}`, name: "Leads", config_dir: "/tmp/leads" + n });

test("a worker gets its live Lead's id; the Lead gets its live worker count", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship X", role: "lead" } as any);
  const worker = sessions.create({
    workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "worker task",
    created_by: `lead:${lead.id.slice(0, 8)}`, lead_id: lead.id,
  } as any);
  const bystander = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "unrelated" } as any);

  const live = sessions.list({ status: "live" });
  const fields = deskLeadFields(live, live);

  assert.deepEqual(fields.get(worker.id), { lead_id: lead.id, workers: 0, board: null });
  assert.deepEqual(fields.get(lead.id), { lead_id: null, workers: 1, board: null });
  assert.deepEqual(fields.get(bystander.id), { lead_id: null, workers: 0, board: null });
});

test("a worker of a Lead that has since ended gets no lead_id — an orphan, not a ghost link", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship X", role: "lead" } as any);
  const worker = sessions.create({
    workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "worker task",
    created_by: `lead:${lead.id.slice(0, 8)}`, lead_id: lead.id,
  } as any);
  sessions.end(lead.id);

  const live = sessions.list({ status: "live" }); // lead is gone; worker remains
  const fields = deskLeadFields([worker], live);
  assert.deepEqual(fields.get(worker.id), { lead_id: null, workers: 0, board: null });
});

test("a terminal that merely SAYS it is a Lead's worker gets no lead_id — created_by is a label, not a key", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship X", role: "lead" } as any);
  // The old linkage, self-asserted by `mc` from MC_AGENT_NAME — now cosmetic. No x-mc-lead header at
  // spawn means no lead_id, so this row is nobody's worker.
  const impostor = sessions.create({
    workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "not really a worker",
    created_by: `lead:${lead.id.slice(0, 8)}`,
  } as any);

  const live = sessions.list({ status: "live" });
  const fields = deskLeadFields(live, live);
  assert.deepEqual(fields.get(impostor.id), { lead_id: null, workers: 0, board: null });
  assert.deepEqual(fields.get(lead.id), { lead_id: null, workers: 0, board: null }, "and it does not count against the Lead");
});

test("a Lead with no live workers reports workers: 0, not undefined", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship X", role: "lead" } as any);
  const live = sessions.list({ status: "live" });
  const fields = deskLeadFields(live, live);
  assert.deepEqual(fields.get(lead.id), { lead_id: null, workers: 0, board: null });
});

// ──────────── POST /sessions: lead_id comes from the credential, never from the body ────────────

test("spawnLeadFields stamps the Lead's id and workspace from its scope, and nulls lead_id without one", () => {
  const ws = mkWs();
  const lead = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "ship X", role: "lead" } as any);
  assert.deepEqual(spawnLeadFields({ ws: ws.id, leadId: lead.id }), { lead_id: lead.id, workspace_id: ws.id });
  // No x-mc-lead → an explicit null, not "leave whatever was there": spread last over the request
  // body, this is what overwrites anything a caller tried to sneak in.
  assert.deepEqual(spawnLeadFields(null), { lead_id: null });
});

test("the request body can never carry lead_id: the schema drops it, and the route spreads the credential last", () => {
  const parsed = OpenSessionSchema.parse({ cwd: "/tmp", role: "worker", lead_id: "some-other-lead", goal: "sneak in" } as any);
  assert.equal("lead_id" in parsed, false, "zod strips it before it can reach openSession");
  assert.equal((parsed as any).goal, "sneak in", "…while the rest of the body is untouched");
  // The order matters as much as the schema: spawnLeadFields LAST, after ...req.body.
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const call = api.slice(api.indexOf("const s = await openSession({"));
  assert.ok(
    call.indexOf("...(req.body || {})") < call.indexOf("...spawnLeadFields(lead)"),
    "spawnLeadFields must be spread after the body, or a body value would win",
  );
});
