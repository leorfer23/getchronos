/**
 * Lead powers over ITS OWN workers (LEADS.md Powers): worktree remove, close-done, reopen scope,
 * worklog write, and the three surfaces that stay closed.
 *
 * Real git repos for worktree cases (same fixture style as worktree-remove.test.ts). No pty.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db, repos, sessions, workspaces } from "./store.js";
import { ensureSessionWorktree, removeWorktreeAs } from "./worktrees.js";
import { closeDoneSessions, leadGate } from "./api.js";
import { leadMayType } from "./authz.js";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let tmp: string;
let repoPath: string;
let wsId: string;
let repoId: string;

function makeRepo(): string {
  const p = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(p, ["init", "-q", "-b", "main"]);
  git(p, ["config", "user.email", "t@t.t"]);
  git(p, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(p, "README.md"), "hello\n");
  git(p, ["add", "-A"]);
  git(p, ["commit", "-qm", "init"]);
  return fs.realpathSync(p);
}

beforeEach(() => {
  for (const t of ["sessions", "repos", "workspaces", "lead_events", "lead_slices"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-powers-"));
  repoPath = makeRepo();
  wsId = workspaces.create({ slug: "lp-" + randomUUID().slice(0, 8), name: "T", config_dir: "/tmp/lp" } as any).id;
  repoId = repos.create({ workspace_id: wsId, name: "t-repo", path: repoPath, default_branch: "main" } as any).id;
});

const mkLead = () => sessions.create({ workspace_id: wsId, role: "lead", goal: "ship X", cwd: repoPath, backend: "mock" });
const mkWorker = (leadId: string, over: Record<string, unknown> = {}) =>
  sessions.create({
    workspace_id: wsId, role: "worker", goal: "open the PR", cwd: repoPath, backend: "mock",
    lead_id: leadId, ...over,
  } as any);

async function claimFor(s: { id: string }) {
  const wt = (await ensureSessionWorktree(repos.get(repoId)!, sessions.get(s.id)!))!;
  sessions.setWorktree(s.id, { path: wt.path, branch: wt.branch, repo_id: repoId });
  return wt;
}

describe("Lead removeWorktreeAs — own workers only", () => {
  test("Lead removes a clean tree its worker claimed (busy still applies while the worker is in it)", async () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id);
    const wt = await claimFor(worker);
    // Live worker standing in the tree → same 409 Robert gets. Ownership is recognised; busy is not waived.
    const busy = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
    );
    assert.equal(busy.status, 409);
    assert.match(String(busy.body.error), /working in there/);
    // After the worker ends, the Lead may remove the clean claim.
    sessions.end(worker.id);
    const out = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
    );
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(out.removed?.by, `lead:${lead.id.slice(0, 8)}`);
    assert.equal(out.removed?.session_id, worker.id);
    assert.equal(sessions.get(worker.id)!.worktree_path, null);
  });

  test("Lead removes an ENDED worker's clean tree too", async () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id);
    const wt = await claimFor(worker);
    sessions.end(worker.id);
    const out = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
    );
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(fs.existsSync(wt.path), false);
  });

  test("Lead force on a worker's dirty tree → 403 naming the loss; tree stays", async () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id);
    const wt = await claimFor(worker);
    sessions.end(worker.id); // not busy
    fs.writeFileSync(path.join(wt.path, "wip.txt"), "hour of work\n");
    const out = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
      { force: true },
    );
    assert.equal(out.status, 403);
    assert.match(out.body.error, /a lead may not force-remove a worker's worktree/);
    assert.match(out.body.error, /uncommitted/);
    assert.match(out.body.error, /mc ask-robert/);
    assert.equal(fs.existsSync(wt.path), true);
    assert.equal(fs.readFileSync(path.join(wt.path, "wip.txt"), "utf8"), "hour of work\n");
  });

  test("Lead without force still gets 409 on dirty / busy — same refusals as Robert", async () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id);
    const wt = await claimFor(worker);
    fs.writeFileSync(path.join(wt.path, "wip.txt"), "x\n");
    // End first so busy is not the reason — then dirty 409.
    sessions.end(worker.id);
    const dirty = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
    );
    assert.equal(dirty.status, 409);
    assert.match(String(dirty.body.error), /uncommitted/);
    assert.equal(fs.existsSync(wt.path), true);

    // Revive as live in the tree → busy 409 (Lead must not pass owner).
    db.prepare("UPDATE sessions SET status='live', ended_at=NULL WHERE id=?").run(worker.id);
    fs.unlinkSync(path.join(wt.path, "wip.txt"));
    const busy = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: lead.id } },
      wt.path,
    );
    assert.equal(busy.status, 409);
    assert.match(String(busy.body.error), /working in there/);
    assert.equal(fs.existsSync(wt.path), true);
  });

  test("another Lead's worker tree → 403; tree stays", async () => {
    const a = mkLead();
    const b = mkLead();
    const theirs = mkWorker(b.id);
    const wt = await claimFor(theirs);
    sessions.end(theirs.id);
    const out = await removeWorktreeAs(
      { admin: false, scope: { ws: wsId }, lead: { ws: wsId, leadId: a.id } },
      wt.path,
    );
    assert.equal(out.status, 403);
    assert.equal(fs.existsSync(wt.path), true);
  });
});

describe("closeDoneSessions — Lead scope", () => {
  test("filter keeps only that Lead's done workers; others stay live", () => {
    const lead = mkLead();
    const other = mkLead();
    const mine = mkWorker(lead.id, { goal: "mine" });
    const theirs = mkWorker(other.id, { goal: "theirs" });
    const bystander = sessions.create({ workspace_id: wsId, role: "worker", goal: "ops", cwd: repoPath, backend: "mock" });
    sessions.setGoal(mine.id, { goal_done: true });
    sessions.setGoal(theirs.id, { goal_done: true });
    sessions.setGoal(bystander.id, { goal_done: true });
    // No live pty — killSession is a no-op on a row with no process; it still ends the row.
    const closed = closeDoneSessions((s) => s.lead_id === lead.id);
    assert.deepEqual(closed, [mine.id]);
    assert.equal(sessions.get(mine.id)!.status, "ended");
    assert.equal(sessions.get(theirs.id)!.status, "live");
    assert.equal(sessions.get(bystander.id)!.status, "live");
  });

  test("a done Lead with a live worker is NOT closed; the worker is never orphaned", () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id, { goal: "still building" });
    sessions.setGoal(lead.id, { goal_done: true });
    const closed = closeDoneSessions();
    assert.deepEqual(closed, []);
    assert.equal(sessions.get(lead.id)!.status, "live");
    assert.equal(sessions.get(worker.id)!.status, "live");
  });

  test("once the last worker is done, the same sweep closes worker then Lead", () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id, { goal: "done too" });
    sessions.setGoal(lead.id, { goal_done: true });
    sessions.setGoal(worker.id, { goal_done: true });
    const closed = closeDoneSessions();
    assert.deepEqual(closed, [worker.id, lead.id], "workers must be killed before their Lead");
    assert.equal(sessions.get(lead.id)!.status, "ended");
    assert.equal(sessions.get(worker.id)!.status, "ended");
  });

  test("an ENDED worker does not hold its done Lead open", () => {
    const lead = mkLead();
    const worker = mkWorker(lead.id);
    sessions.end(worker.id);
    sessions.setGoal(lead.id, { goal_done: true });
    assert.deepEqual(closeDoneSessions(), [lead.id]);
    assert.equal(sessions.get(lead.id)!.status, "ended");
  });

  test("another Lead's live worker does not hold THIS done Lead open", () => {
    const lead = mkLead();
    const other = mkLead();
    mkWorker(other.id, { goal: "theirs" });
    sessions.setGoal(lead.id, { goal_done: true });
    assert.deepEqual(closeDoneSessions(), [lead.id]);
    assert.equal(sessions.get(other.id)!.status, "live");
  });
});

describe("reopen ownership", () => {
  test("Lead may type/reopen only its worker; another Lead is refused; lead_id survives end+revive", () => {
    const a = mkLead();
    const b = mkLead();
    const mine = mkWorker(a.id);
    const theirs = mkWorker(b.id);
    const scopeA = { ws: wsId, leadId: a.id };
    const scopeB = { ws: wsId, leadId: b.id };
    assert.equal(leadMayType(scopeA, mine), true);
    assert.equal(leadMayType(scopeA, theirs), false);
    assert.equal(leadMayType(scopeB, mine), false);

    sessions.end(mine.id);
    const revived = sessions.revive(mine.id)!;
    assert.equal(revived.lead_id, a.id, "revive must keep lead_id so the pty gets leadWorkerBlock + MC_LEAD_ID");
    assert.equal(leadMayType(scopeA, revived), true);
    assert.equal(leadMayType(scopeB, revived), false);
  });
});

describe("surfaces that stay closed to a Lead", () => {
  test("vars write, /desk/close-done, /sessions/:id/drop stay admin-only (no leadScope)", () => {
    const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
    // vars write
    const varsAt = api.indexOf('api.post("/workspaces/:id/vars"');
    assert.ok(varsAt > 0);
    const varsBody = api.slice(varsAt, varsAt + 400);
    assert.match(varsBody, /requireAdmin/);
    assert.doesNotMatch(varsBody, /leadScope|leadGate/);
    // whole-wall close-done
    const deskAt = api.indexOf('api.post("/desk/close-done"');
    assert.ok(deskAt > 0);
    const deskBody = api.slice(deskAt, deskAt + 350);
    assert.match(deskBody, /requireAdmin/);
    assert.doesNotMatch(deskBody, /leadGate/);
    // drop
    const dropAt = api.indexOf('"/sessions/:id/drop"');
    assert.ok(dropAt > 0);
    const dropBody = api.slice(dropAt, api.indexOf('"/sessions/:id/worktree"', dropAt));
    assert.match(dropBody, /x-mc-admin/);
    assert.doesNotMatch(dropBody, /leadScope|leadGate/);
  });

  test("/leads/me/close-done is leadGate-scoped; worklog POST accepts a Lead in its workspace", () => {
    const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
    const closeAt = api.indexOf('api.post("/leads/me/close-done"');
    assert.ok(closeAt > 0, "missing /leads/me/close-done");
    const closeBody = api.slice(closeAt, closeAt + 900);
    assert.ok(closeBody.includes("leadGate(req, res)"));
    assert.ok(closeBody.includes("lead.leadId") || closeBody.includes("lead_id === lead.leadId"));

    const wlAt = api.indexOf('api.post("/workspaces/:id/worklog"');
    assert.ok(wlAt > 0);
    const wlBody = api.slice(wlAt, wlAt + 1200);
    assert.ok(wlBody.includes("leadScope(req)") || wlBody.includes("x-mc-lead"));
    assert.ok(wlBody.includes('lead:${lead.leadId.slice(0, 8)}') || wlBody.includes("lead:${lead.leadId.slice(0, 8)}"));
    assert.ok(wlBody.includes("lead.ws !== req.params.id") || wlBody.includes("lead.ws !=="));
  });

  test("mc worktree rm / worklog / session reopen / lead close-done send x-mc-lead", () => {
    const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
    assert.match(mc, /MC_LEAD_TOKEN \? \{ "x-mc-lead": process\.env\.MC_LEAD_TOKEN \}/);
    assert.match(mc, /close-done/);
    assert.match(mc, /rm_worktrees/);
    assert.match(mc, /handHeaders\(\)/); // session reopen
    assert.ok(mc.includes('"/workspaces/" + w.id + "/worklog"') && mc.includes("MC_LEAD_TOKEN"));
  });
});

test("leadGate still resolves a live Lead for the new close-done door", () => {
  const lead = mkLead();
  const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { return this; } };
  assert.deepEqual(leadGate({ get: (h: string) => (h.toLowerCase() === "x-mc-lead" ? sessions.leadToken(lead.id) : undefined) } as any, res), {
    ws: wsId,
    leadId: lead.id,
  });
});
