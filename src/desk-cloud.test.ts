/**
 * Cloud Desk terminals (src/desk-cloud.ts): opening one is a dispatched job/run, not a spawned
 * process. `cursor-cloud` IS registered on main (PR1, #26 — a real CloudBackend module), so
 * openCloudSession() now reaches dispatch(), which synchronously invokes the executor
 * (CLAUDE.md gotcha #1). Every test that gets that far stubs the executor via setExecutor()
 * (CLAUDE.md gotcha #2 — never call the real execute()/launch a real cloud agent), exactly like
 * dispatcher.test.ts does. Repo resolution, state mapping and the repo-visibility cache need no
 * registry or executor at all and are exercised directly.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, jobs, repos, runs, sessions, workspaces, workspaceVars } from "./store.js";
import { dispatch, setExecutor } from "./dispatcher.js";
import { createTicket } from "./tickets.js";
import type { Job, RunStatus } from "./types.js";
import {
  cloudRunFor,
  cloudSessionState,
  cloudVisibleRepos,
  followUpCloudSession,
  openCloudSession,
  repoVisibleTo,
  resolveCloudRepo,
  wantsCloudBackend,
} from "./desk-cloud.js";

// A scripted executor: no process, no network, resolves every dispatched run as an immediate
// success (or whatever `outcome` says) — see dispatcher.test.ts's `program()` for the same idiom.
function stubExecutor(outcome: RunStatus = "success") {
  setExecutor(async (_job: Job, runId: string) => {
    runs.patch(runId, { status: outcome, started_at: new Date().toISOString(), ended_at: new Date().toISOString() });
    return outcome;
  });
}

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM repos; DELETE FROM workspaces;");
});
afterEach(() => {
  setExecutor(null);
});

function mkWs(over: Partial<Parameters<typeof workspaces.create>[0]> = {}) {
  return workspaces.create({ slug: `ws${Math.random().toString(36).slice(2)}`, name: "Test WS", config_dir: "/tmp/cfg", ...over });
}
// checkCwd/allowedRoots (spawn-guard.ts) require the repo path to actually exist on disk and be
// realpath-resolvable, or jobs.create()'s sanitizeCwd silently drops it — a fake "/tmp/app" would
// make every dispatch()-reaching test below fail with an unrelated cwd error.
function mkRepo(wsId: string, over: Partial<Parameters<typeof repos.create>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-cloud-repo-"));
  return repos.create({ workspace_id: wsId, name: "app", path: dir, delivery: "pr", git_remote: "https://github.com/acme/app", ...over });
}

test("wantsCloudBackend routes on the name (and on kind, for any future cloud backend)", () => {
  assert.equal(wantsCloudBackend("cursor-cloud"), true);
  assert.equal(wantsCloudBackend("claude-code"), false);
  assert.equal(wantsCloudBackend(undefined), false);
});

test("resolveCloudRepo refuses a repo with no GitHub remote", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id, { git_remote: null });
  assert.throws(() => resolveCloudRepo({ workspace_id: ws.id, repo_id: repo.id }), /no GitHub remote/);
});

test("resolveCloudRepo refuses a delivery=commit repo", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id, { delivery: "commit" });
  assert.throws(() => resolveCloudRepo({ workspace_id: ws.id, repo_id: repo.id }), /delivery=pr/);
});

test("resolveCloudRepo resolves via repo_id, ticket_id, or cwd path, and accepts a valid repo", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  assert.equal(resolveCloudRepo({ workspace_id: ws.id, repo_id: repo.id }).id, repo.id);
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "T" } as any);
  assert.equal(resolveCloudRepo({ workspace_id: ws.id, ticket_id: t.id }).id, repo.id);
  assert.equal(resolveCloudRepo({ workspace_id: ws.id, cwd: repo.path }).id, repo.id);
});

test("resolveCloudRepo refuses with no workspace or no matching repo", () => {
  assert.throws(() => resolveCloudRepo({}), /needs a workspace/);
  const ws = mkWs();
  assert.throws(() => resolveCloudRepo({ workspace_id: ws.id }), /needs a repo/);
});

test("openCloudSession fails closed for a backend name that isn't registered at all", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const before = { sessions: sessions.list().length, jobs: (db.prepare("SELECT COUNT(*) c FROM jobs").get() as any).c };
  return assert.rejects(
    // desk-cloud.ts is called directly here (bypassing the api.ts wantsCloudBackend() routing gate)
    // to exercise its OWN hasBackend() guard — the one that matters if it is ever reached with a
    // name that resolves to nothing, e.g. a future typo'd cloud backend.
    () => openCloudSession({ backend: "cursor-cloud-typo", workspace_id: ws.id, repo_id: repo.id, cwd: repo.path, role: "human" } as any),
    /cursor-cloud backend not available/,
  ).then(() => {
    assert.equal(sessions.list().length, before.sessions, "no session row left behind");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM jobs").get() as any).c, before.jobs, "no job row left behind");
  });
});

test("openCloudSession honors the workspace backend allow-list even before it reaches the registry", () => {
  const ws = mkWs({ backends: ["claude-code"] }); // cursor-cloud explicitly NOT allowed here
  const repo = mkRepo(ws.id);
  return assert.rejects(
    () => openCloudSession({ backend: "cursor-cloud", workspace_id: ws.id, repo_id: repo.id, cwd: repo.path, role: "human" } as any),
    /may not run `cursor-cloud`/,
  );
});

test("openCloudSession refuses to open as a Lead — no mc on the VM", () => {
  const ws = mkWs();
  return assert.rejects(
    () => openCloudSession({ backend: "cursor-cloud", workspace_id: ws.id, role: "lead" } as any),
    /can't drive workers/,
  );
});

test("openCloudSession opens a real cloud terminal end to end: session + job + run, linked, no pid", async () => {
  stubExecutor("success");
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const row = await openCloudSession({ backend: "cursor-cloud", workspace_id: ws.id, repo_id: repo.id, cwd: repo.path, role: "human", goal: "ship it" } as any);
  assert.equal(row.pid, null);
  assert.equal(row.backend, "cursor-cloud");
  assert.equal(row.status, "live");
  const job = jobs.list().find((j) => j.workspace_id === ws.id);
  assert.ok(job, "a job was dispatched for this terminal");
  // jobs.create() realpath's cwd (spawn-guard.ts sanitizeCwd) — compare resolved, not raw.
  assert.equal(job!.cwd, fs.realpathSync(repo.path));
  // cloudRunFor() itself is gated on cloud_agent_id (set by the REAL runner at launch, not by this
  // stub executor) — check the underlying session<->run link directly, via the same runs.bySession()
  // cloudRunFor uses once that id is there.
  const run = runs.bySession(row.id);
  assert.ok(run, "the run is linked back to the session");
  assert.equal(run!.job_id, job!.id);
  assert.equal(cloudRunFor(row), null, "cloudRunFor stays null until the runner sets cloud_agent_id");
});

test("dispatch(): a ticketless job resolves its repo via cwd, so cursor-cloud is not wrongly refused", () => {
  stubExecutor("success");
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const job = jobs.create({ name: "ticketless-cloud", goal: "g", workspace_id: ws.id, cwd: repo.path, backend: "cursor-cloud" });
  assert.equal(job.ticket_id, null, "no ticket — this is exactly the Desk repo-picker case");
  const r = dispatch(job.id, "test");
  assert.ok("run_id" in r, `expected a dispatched run, got ${JSON.stringify(r)}`);
});

test("dispatch(): a ticketless job whose cwd matches no repo is still refused (fail closed holds)", () => {
  const ws = mkWs();
  const job = jobs.create({ name: "nowhere", goal: "g", workspace_id: ws.id, cwd: "/tmp/not-a-registered-repo", backend: "cursor-cloud" });
  const r = dispatch(job.id, "test");
  assert.deepEqual(r, { error: "cursor-cloud refused: needs a GitHub repo and none was resolvable for this job — Phase 1 is GitHub-only" });
});

test("cloudSessionState maps run status to the Desk's working/blocked/done buckets", () => {
  const mk = (status: any) => ({ status, id: "r1" } as any);
  assert.equal(cloudSessionState(null), "working");
  assert.equal(cloudSessionState(mk("queued")), "working");
  assert.equal(cloudSessionState(mk("running")), "working");
  assert.equal(cloudSessionState(mk("paused")), "working");
  assert.equal(cloudSessionState(mk("success")), "done");
  for (const s of ["failed", "timeout", "killed", "blocked", "rate_limited", "interrupted"])
    assert.equal(cloudSessionState(mk(s)), "blocked", s);
});

test("a cloud session carries no pid, and cloudRunFor finds its run by the session link — not a pty", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const row = sessions.create({ workspace_id: ws.id, repo_id: repo.id, backend: "cursor-cloud", cwd: repo.path });
  assert.equal(row.pid, null);
  assert.equal(cloudRunFor(row), null, "no run linked yet");
  sessions.setCloud(row.id, { cloud_agent_id: "bc-test", cloud_url: "https://cursor.com/agents/bc-test" });
  const job = jobs.create({ name: "j", goal: "g", workspace_id: ws.id, cwd: repo.path, backend: "cursor-cloud" });
  const run = runs.create(job.id, "test");
  runs.patch(run.id, { session_id: row.id, status: "running" });
  const reloaded = sessions.get(row.id)!;
  assert.equal(reloaded.cloud_agent_id, "bc-test");
  const found = cloudRunFor(reloaded);
  assert.equal(found?.id, run.id);
  assert.equal(cloudSessionState(found), "working");
});

test("followUpCloudSession errors cleanly when the session has no cloud run yet", () => {
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const row = sessions.create({ workspace_id: ws.id, repo_id: repo.id, backend: "cursor-cloud", cwd: repo.path });
  sessions.setCloud(row.id, { cloud_agent_id: "bc-test" });
  const r = followUpCloudSession(sessions.get(row.id)!, "keep going");
  assert.deepEqual(r, { error: "no cloud run on this terminal yet" });
});

test("followUpCloudSession dispatches a new run on the same job, threaded as a resume", () => {
  stubExecutor("success");
  const ws = mkWs();
  const repo = mkRepo(ws.id);
  const row = sessions.create({ workspace_id: ws.id, repo_id: repo.id, backend: "cursor-cloud", cwd: repo.path });
  sessions.setCloud(row.id, { cloud_agent_id: "bc-test" });
  const job = jobs.create({ name: "j", goal: "g", workspace_id: ws.id, cwd: repo.path, backend: "cursor-cloud" });
  const firstRun = runs.create(job.id, "test");
  runs.patch(firstRun.id, { session_id: row.id, status: "success" });
  const r = followUpCloudSession(sessions.get(row.id)!, "keep going");
  assert.ok(!("error" in r), `expected a follow-up run, got ${JSON.stringify(r)}`);
  const newRun = runs.get((r as any).run_id)!;
  assert.equal(newRun.job_id, job.id, "same job — a follow-up, not a fresh launch");
  assert.equal(newRun.resume_session, row.id, "threaded as a resume of this session");
  assert.equal(newRun.session_id, row.id, "still findable by cloudRunFor after the follow-up");
});

test("cloudVisibleRepos never hits the network with no CURSOR_API_KEY configured", async () => {
  const ws = mkWs();
  let calls = 0;
  const stub: any = async () => { calls++; return { ok: true, json: async () => ({ repositories: [] }) }; };
  const { repos: list, error } = await cloudVisibleRepos(ws.id, stub);
  assert.equal(list, null);
  assert.equal(error, null);
  assert.equal(calls, 0);
});

test("cloudVisibleRepos caches so the picker cannot exceed Cursor's 1 req/min limit", async () => {
  const ws = mkWs();
  workspaceVars.set(ws.id, "CURSOR_API_KEY", "crsr_test", null);
  let calls = 0;
  const stub: any = async () => { calls++; return { ok: true, json: async () => ({ repositories: [{ fullName: "acme/app" }] }) }; };
  const first = await cloudVisibleRepos(ws.id, stub);
  assert.equal(calls, 1);
  assert.equal(first.repos?.length, 1);
  // Same minute, same workspace: served from cache, no second call.
  const second = await cloudVisibleRepos(ws.id, stub);
  assert.equal(calls, 1, "cache absorbed the second call");
  assert.deepEqual(second.repos, first.repos);
});

test("cloudVisibleRepos reads Cursor's live {items: [{url}]} shape, so the picker can see the repo", async () => {
  const ws = mkWs();
  workspaceVars.set(ws.id, "CURSOR_API_KEY", "crsr_test", null);
  const stub: any = async () => ({ ok: true, json: async () => ({ items: [{ url: "https://github.com/leorfer23/getchronos" }] }) });
  const { repos: list, error } = await cloudVisibleRepos(ws.id, stub);
  assert.equal(error, null);
  assert.equal(list?.length, 1);
  assert.equal(repoVisibleTo(list, "https://github.com/leorfer23/getchronos.git"), true);
});

test("cloudVisibleRepos surfaces a fetch failure without throwing, and still caches it", async () => {
  const ws = mkWs();
  workspaceVars.set(ws.id, "CURSOR_API_KEY", "crsr_test", null);
  let calls = 0;
  const stub: any = async () => { calls++; return { ok: false, status: 429 }; };
  const r = await cloudVisibleRepos(ws.id, stub);
  assert.equal(r.repos, null);
  assert.match(r.error || "", /429/);
  await cloudVisibleRepos(ws.id, stub);
  assert.equal(calls, 1, "the failure itself is cached, not retried on every picker render");
});

test("repoVisibleTo matches a repo's remote against Cursor's visible-repo list, and fails closed", () => {
  assert.equal(repoVisibleTo(null, "https://github.com/acme/app"), false);
  assert.equal(repoVisibleTo([], "https://github.com/acme/app"), false);
  assert.equal(repoVisibleTo([{ fullName: "acme/app" }], "https://github.com/acme/app"), true);
  assert.equal(repoVisibleTo([{ fullName: "acme/app" }], "https://github.com/acme/app.git"), true);
  assert.equal(repoVisibleTo([{ url: "https://github.com/acme/app" }], "git@github.com:acme/app.git" as any), false); // ssh form not normalized — documents the current gap
  assert.equal(repoVisibleTo([{ fullName: "acme/OTHER" }], "https://github.com/acme/app"), false);
});
