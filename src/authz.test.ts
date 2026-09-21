import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { db, sessions, workspaces } from "./store.js";
import { callerScope, checkScope, leadMayType, leadScope, tokenOk } from "./authz.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

// Minimal req/res fakes — enough surface for callerScope/checkScope, no need for a real server.
function fakeReq(headers: Record<string, string> = {}): any {
  return { get: (h: string) => headers[h.toLowerCase()] };
}
function fakeRes(): any {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

test("tokenOk requires matching length and bytes, rejects empty", () => {
  assert.equal(tokenOk("abc", "abc"), true);
  assert.equal(tokenOk("abc", "abd"), false);
  assert.equal(tokenOk("ab", "abc"), false);
  assert.equal(tokenOk(undefined, "abc"), false);
  assert.equal(tokenOk("abc", ""), false);
});

test("callerScope: admin token wins even if a workspace token is also sent", () => {
  const scope = callerScope(fakeReq({ "x-mc-admin": CONFIG.adminToken, "x-mc-workspace-token": "garbage" }));
  assert.deepEqual(scope, { ws: null });
});

test("callerScope: no headers at all stays unrestricted (back-compat for dashboard/manual CLI)", () => {
  assert.deepEqual(callerScope(fakeReq()), { ws: null });
});

test("callerScope: valid workspace token resolves to its own workspace id", () => {
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const scope = callerScope(fakeReq({ "x-mc-workspace-token": w.token }));
  assert.deepEqual(scope, { ws: w.id });
});

test("callerScope: unknown workspace token is invalid (null)", () => {
  assert.equal(callerScope(fakeReq({ "x-mc-workspace-token": "nope" })), null);
});

test("checkScope: 401s an invalid token and returns false", () => {
  const res = fakeRes();
  const ok = checkScope(fakeReq({ "x-mc-workspace-token": "nope" }), res, "some-ws-id");
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
});

test("checkScope: 404s when the resource belongs to a different workspace", () => {
  const mine = workspaces.create({ slug: "mine", name: "Mine", config_dir: "/tmp/mine" });
  const other = workspaces.create({ slug: "other", name: "Other", config_dir: "/tmp/other" });
  const res = fakeRes();
  const ok = checkScope(fakeReq({ "x-mc-workspace-token": mine.token }), res, other.id);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 404);
});

test("checkScope: passes when the token owns the resource's workspace", () => {
  const mine = workspaces.create({ slug: "mine2", name: "Mine2", config_dir: "/tmp/mine2" });
  const res = fakeRes();
  const ok = checkScope(fakeReq({ "x-mc-workspace-token": mine.token }), res, mine.id);
  assert.equal(ok, true);
  assert.equal(res.body, undefined);
});

test("checkScope: unrestricted caller (no token) passes regardless of owner", () => {
  const res = fakeRes();
  assert.equal(checkScope(fakeReq(), res, "any-workspace-id"), true);
});

test("checkScope: a resource with no known owner (undefined) is never blocked", () => {
  const mine = workspaces.create({ slug: "mine3", name: "Mine3", config_dir: "/tmp/mine3" });
  const res = fakeRes();
  assert.equal(checkScope(fakeReq({ "x-mc-workspace-token": mine.token }), res, undefined), true);
});

// ─────────────────────────── leadScope (LEADS.md) ───────────────────────────

test("leadScope: no x-mc-lead header → null", () => {
  assert.equal(leadScope(fakeReq()), null);
});

test("leadScope: unknown token → null", () => {
  assert.equal(leadScope(fakeReq({ "x-mc-lead": "nope" })), null);
});

test("leadScope: a live lead session's token resolves to its workspace and id", () => {
  const w = workspaces.create({ slug: "acme-lead", name: "Acme", config_dir: "/tmp/acme-lead" });
  const lead = sessions.create({ workspace_id: w.id, role: "lead", cwd: "/tmp" });
  const tok = sessions.leadToken(lead.id);
  assert.ok(tok, "sessions.create must mint a lead_token for role=lead");
  assert.equal((lead as any).lead_token, undefined, "the token never rides a row out of the store");
  assert.equal((sessions.get(lead.id) as any).lead_token, undefined);
  assert.equal((sessions.list({ status: "live" }).find((x) => x.id === lead.id) as any).lead_token, undefined);
  assert.deepEqual(leadScope(fakeReq({ "x-mc-lead": tok! })), { ws: w.id, leadId: lead.id });
});

test("leadScope: a worker's token (role != lead) never resolves, even if forged into the column", () => {
  const w = workspaces.create({ slug: "acme-worker", name: "Acme", config_dir: "/tmp/acme-worker" });
  const worker = sessions.create({ workspace_id: w.id, role: "worker", cwd: "/tmp" });
  assert.equal(sessions.leadToken(worker.id), null, "only role=lead gets a lead_token at create");
  db.prepare("UPDATE sessions SET lead_token=? WHERE id=?").run("forged", worker.id);
  assert.equal(leadScope(fakeReq({ "x-mc-lead": "forged" })), null);
});

test("leadScope: an ended lead's token no longer resolves — sessions.end clears it", () => {
  const w = workspaces.create({ slug: "acme-ended", name: "Acme", config_dir: "/tmp/acme-ended" });
  const lead = sessions.create({ workspace_id: w.id, role: "lead", cwd: "/tmp" });
  const tok = sessions.leadToken(lead.id)!;
  sessions.end(lead.id);
  assert.equal(sessions.leadToken(lead.id), null);
  assert.equal(leadScope(fakeReq({ "x-mc-lead": tok })), null);
  // A reopened Lead gets a fresh credential, never the burned one.
  sessions.revive(lead.id);
  const again = sessions.leadToken(lead.id);
  assert.ok(again && again !== tok);
  assert.deepEqual(leadScope(fakeReq({ "x-mc-lead": again! })), { ws: w.id, leadId: lead.id });
});

// ─────────────────── leadMayType: a Lead types into ITS OWN workers only ───────────────────

test("leadMayType: its own worker yes; another Lead's worker, an operator's terminal and itself no", () => {
  const w = workspaces.create({ slug: "two-leads", name: "Acme", config_dir: "/tmp/two-leads" });
  const a = sessions.create({ workspace_id: w.id, role: "lead", cwd: "/tmp" });
  const b = sessions.create({ workspace_id: w.id, role: "lead", cwd: "/tmp" });
  const scope = { ws: w.id, leadId: a.id };
  const mine = sessions.create({ workspace_id: w.id, role: "worker", cwd: "/tmp", lead_id: a.id });
  const theirs = sessions.create({ workspace_id: w.id, role: "worker", cwd: "/tmp", lead_id: b.id });
  // Opened by the operator at the wall: same workspace, nobody's worker. This is what the old
  // workspace-wide rule let a Lead type into.
  const operators = sessions.create({ workspace_id: w.id, role: "human", cwd: "/tmp" });

  assert.equal(leadMayType(scope, mine), true);
  assert.equal(leadMayType(scope, theirs), false, "Lead A may not type into Lead B's worker");
  assert.equal(leadMayType(scope, operators), false, "nor into a terminal the operator opened");
  assert.equal(leadMayType(scope, a), false, "nor into itself");
  assert.equal(leadMayType(scope, b), false, "nor into the other Lead");
  // And the string that used to be the linkage buys nothing.
  const impostor = sessions.create({
    workspace_id: w.id, role: "worker", cwd: "/tmp", created_by: `lead:${a.id.slice(0, 8)}`,
  });
  assert.equal(leadMayType(scope, impostor), false, "created_by is a label, not a credential");
});

test("leadMayType: a worker of this Lead in ANOTHER workspace is still refused", () => {
  const home = workspaces.create({ slug: "home-ws", name: "Home", config_dir: "/tmp/home-ws" });
  const other = workspaces.create({ slug: "other-ws", name: "Other", config_dir: "/tmp/other-ws" });
  const lead = sessions.create({ workspace_id: home.id, role: "lead", cwd: "/tmp" });
  // Should be impossible (POST /sessions forces the Lead's workspace); the second wall is here in
  // case a row ever crosses by another route.
  const stray = sessions.create({ workspace_id: other.id, role: "worker", cwd: "/tmp", lead_id: lead.id });
  assert.equal(leadMayType({ ws: home.id, leadId: lead.id }, stray), false);
});
