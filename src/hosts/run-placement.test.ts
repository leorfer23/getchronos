/**
 * Where a headless run goes (src/hosts/run-placement.ts, HOSTS.md phase 5) — against the in-memory
 * store and a registered RemoteHost on a stub link (no socket, no spawn). And the pure place() rules
 * phase 5 added: a run needs a host that runs procs; an egress lock needs a host that runs the proxy;
 * a brokered workspace never leaves the brain; a GitHub-shipping kind needs gh there.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const { CONFIG } = await import("../config.js");
const { db, hosts, jobs, repoCheckouts, repos, runs, workspaces } = await import("../store.js");
const { createTicket, ticketBranch } = await import("../tickets.js");
const { registerHost } = await import("./index.js");
const { RemoteHost } = await import("./remote.js");
const { placeRun, placeTicketWork, BRAIN_ONLY_KINDS } = await import("./run-placement.js");
const { place } = await import("./placement.js");
const { worktreeRootFor } = await import("../worktree-core.js");
const { PROTOCOL_VERSION } = await import("../hostlink/wire.js");
type HostCandidate = import("./placement.js").HostCandidate;
type PlaceRequest = import("./placement.js").PlaceRequest;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-placement-"));
const ws = workspaces.create({ slug: "rp", name: "RP", config_dir: path.join(tmp, ".claude-rp"), sandbox_mode: "off" } as any);
const repoPath = path.join(tmp, "web");
fs.mkdirSync(repoPath);
const repo = repos.create({ workspace_id: ws.id, name: "web", path: repoPath, default_branch: "main", git_remote: "git@github.com:acme/web.git" } as any);

let online = true;
const port = { isOnline: () => online, sendControl: () => true, request: async () => { throw new Error("no requests"); } };
hosts.create({ id: "h_m2", name: "m2", token_hash: "x".repeat(64), status: "online" });
repoCheckouts.upsert({ repo_id: repo.id, host_id: "h_m2", path: "/Users/other/code/web" });
const m2 = new RemoteHost("h_m2", port);
registerHost(m2);
const hello = (caps: Record<string, unknown> = {}) => m2.setOnline({
  proto: PROTOCOL_VERSION, version: "0.1.0", host_id: "h_m2", name: "m2", platform: "darwin", arch: "arm64",
  capabilities: { clis: [{ name: "claude", path: "/opt/homebrew/bin/claude", version: null }], node: process.version, sandbox: true, procs: true, egress: true, ...caps },
  profiles: [{ name: "claude-rp", dir: "/Users/other/.claude-rp", exists: true }], checkouts: [], deny: [], live: [],
} as any);
const idle = () => m2.setVitals({ at: Date.now(), cpu: 1, ram: 10, gpu: 0, loadPerCore: 0.05, pressure: 1, swapPct: 0, ncpu: 12, load1: 0.6, swapUsedMb: 0, swapTotalMb: 0 });

let n = 0;
const mkJob = (over: Record<string, unknown> = {}) =>
  jobs.create({ name: `job${n++}`, goal: "do the thing", workspace_id: ws.id, backend: "mock", cwd: repoPath, sandbox: "off", retry_max: 0, ...over } as any);

const reserve = CONFIG.placement.brainReserve;
const mode = CONFIG.placement.mode;
beforeEach(() => {
  online = true;
  hello();
  idle();
  // The brain's own load is whatever the test machine's is: a full reserve makes the host the pick.
  CONFIG.placement.brainReserve = 100;
  CONFIG.placement.mode = mode;
  workspaces.update(ws.id, { placement: null } as any);
});
process.on("exit", () => { CONFIG.placement.brainReserve = reserve; });

test("a job in a workspace repo's checkout goes to the host with room — and says why", () => {
  const r = placeRun(mkJob());
  assert.ok(!("error" in r));
  assert.equal(r.host_id, "h_m2");
  assert.match(r.reason ?? "", /most headroom|only computer that can run it/);
});

test("the brain-only kinds stay, each with its reason", () => {
  for (const [kind, why] of Object.entries(BRAIN_ONLY_KINDS)) {
    const r = placeRun(mkJob({ name: `${kind}rp` }));
    assert.equal((r as any).host_id, "local", kind);
    assert.equal((r as any).reason, why);
  }
  // A rate-limit stand-in is judged by what it stands in for.
  assert.equal((placeRun(mkJob({ name: "fallback:dream:rp" })) as any).host_id, "local");
});

test("what a host could not do stays on the brain: another dir, a brain file in the goal, brain add-dirs", async () => {
  const sub = path.join(repoPath, "pkg");
  fs.mkdirSync(sub, { recursive: true });
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "rp-other-"));
  assert.match((placeRun(mkJob({ cwd: sub })) as any).reason, /no repo a host could find/);
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Sub dir" } as any);
  assert.match((placeRun(mkJob({ cwd: sub, ticket_id: t.id })) as any).reason, /starts in a directory on the brain/);
  assert.match((placeRun(mkJob({ goal: `Read ${os.homedir()}/chronos/tickets/rp/RP-1.md` })) as any).reason, /reads a file only the brain has/);
  assert.equal((placeRun(mkJob({ goal: `Read ${repoPath}/.mc/tickets/RP-1.md` })) as any).host_id, "h_m2", "a repo path is translatable");
  // spawn-guard already strips arbitrary add-dirs; the workspace's ticket-files dir is the brain dir it allows.
  const { ensureWsTicketsDir } = await import("../sandbox.js");
  assert.match((placeRun(mkJob({ add_dirs: [ensureWsTicketsDir(ws.slug)] })) as any).reason, /granted brain directories/);
  void other;
  assert.match((placeRun(mkJob({ workspace_id: null })) as any).reason, /unscoped/);
});

test("kill switches: the workspace's own placement=brain, and CHRONOS_PLACEMENT", () => {
  workspaces.update(ws.id, { placement: "brain" } as any);
  assert.match((placeRun(mkJob()) as any).reason, /placement=brain/);
  workspaces.update(ws.id, { placement: null } as any);
  for (const m of ["local", "pinned"] as const) {
    CONFIG.placement.mode = m;
    const r = placeRun(mkJob());
    assert.equal((r as any).host_id, "local", m);
    assert.match((r as any).reason, new RegExp(`CHRONOS_PLACEMENT=${m}`));
  }
});

test("a host that runs no procs (protocol 1.2), is offline or full: the brain takes the run — never refused", () => {
  hello({ procs: false });
  assert.equal((placeRun(mkJob()) as any).host_id, "local");
  hello();
  online = false;
  assert.equal((placeRun(mkJob()) as any).host_id, "local");
  online = true;
  m2.setVitals({ at: Date.now(), cpu: 99, ram: 97, gpu: 0, loadPerCore: 9, pressure: 4, swapPct: 99, ncpu: 12, load1: 108, swapUsedMb: 9000, swapTotalMb: 9000 });
  const r = placeRun(mkJob());
  assert.equal((r as any).host_id, "local", "never past a host's own admission");
  assert.match((r as any).reason, /m2/, "the reason names the host it passed over");
});

test("sticky: a job pinned to a host's worktree goes there or is refused; a resume follows its transcript", () => {
  const pinned = mkJob({ host_id: "h_m2", cwd: "/Users/other/code/.chronos-worktrees/web/mc-rp-1" });
  assert.equal((placeRun(pinned) as any).host_id, "h_m2");
  online = false;
  const refused = placeRun(pinned);
  assert.match((refused as any).error, /cannot move \(its worktree is on that computer\) — m2: offline/);
  online = true;

  const prior = runs.create(mkJob().id, "test");
  runs.patch(prior.id, { session_id: "sess-on-m2", host_id: "h_m2", status: "paused" } as any);
  assert.equal((placeRun(mkJob(), { resumeSession: "sess-on-m2" }) as any).host_id, "h_m2");
  const local = runs.create(mkJob().id, "test");
  runs.patch(local.id, { session_id: "sess-on-brain", status: "paused" } as any);
  assert.equal((placeRun(mkJob(), { resumeSession: "sess-on-brain" }) as any).host_id, "local", "a brain transcript resumes on the brain");
});

test("ticket work: sticky to where the worktree is; else a fresh placement; attachments keep it home", () => {
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "Sticky work" } as any);
  const job = { name: `ticket:${t.key}`, backend: "mock", workspace_id: ws.id, sandbox: "off" as const };
  assert.equal((placeTicketWork(job, t, repo) as any).host_id, "h_m2", "nowhere yet: most headroom");
  // A worktree on the brain's disk pins it to the brain.
  const wt = path.join(worktreeRootFor(repoPath), ticketBranch(t.key).replace(/\//g, "-"));
  fs.mkdirSync(wt, { recursive: true });
  assert.equal((placeTicketWork(job, t, repo) as any).host_id, "local");
  fs.rmSync(wt, { recursive: true, force: true });
  // A build job pinned to m2 is the record that its worktree is there.
  jobs.create({ name: `ticket:${t.key}`, goal: "g", workspace_id: ws.id, ticket_id: t.id, backend: "mock", cwd: "/Users/other/code/.chronos-worktrees/web/x", host_id: "h_m2", sandbox: "off" } as any);
  CONFIG.placement.mode = "local";
  assert.equal((placeTicketWork(job, t, repo) as any).host_id, "h_m2", "sticky wins over the kill switch: never strand a worktree");
  CONFIG.placement.mode = mode;
  const t2 = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "With screenshot" } as any);
  assert.match((placeTicketWork({ ...job, name: `ticket:${t2.key}` }, t2, repo, `1. \`${os.homedir()}/chronos/attachments/${t2.key}/a.png\``) as any).reason, /only the brain has/);
  db.prepare("DELETE FROM jobs WHERE ticket_id = ?").run(t.id);
});

// ───────────────────────────── the pure rules phase 5 added to place() ─────────────────────────────

const cand = (over: Partial<HostCandidate> = {}): HostCandidate => ({
  id: "m2", name: "m2", is_brain: false, online: true, status: "online", deny: [], veto: [], platform: "darwin", sandbox: true,
  clis: ["claude", "gh"], profiles: [{ name: "claude-acme", exists: true }], checkouts: ["r"], auto_clone: false,
  load: { load1: 0.5, ncpu: 10, loadPerCore: 0.05, swapUsedMb: 0, swapTotalMb: 0, pressureLevel: 1 }, ram_pct: 10, procs: true, egress: true, ...over,
});
const brainCand: HostCandidate = { ...cand({ id: "local", name: "local", is_brain: true, procs: false, egress: false }), clis: [], profiles: [], checkouts: [] };
const req = (needs: Partial<PlaceRequest["needs"]> = {}): PlaceRequest => ({
  workspace: { id: "w", slug: "acme" }, backend: "claude-code", backend_kind: "local", profile: "claude-acme",
  repo: { id: "r", name: "web", git_remote: "git@x:y/web.git" }, needs: { sandbox: "guard", egress_locked: false, ...needs },
  pinned: null, sticky: null, opened_by: "agent", fresh: true,
});
const where = (r: PlaceRequest, h: HostCandidate) => {
  const p = place({ req: r, hosts: [brainCand, h], cfg: CONFIG.machine, reserve: 100, mode: "auto" });
  return p.ok ? p.host_id : "refused";
};

test("place(): runs need procs, an egress lock needs the host's proxy, brokered never leaves, gh when shipping", () => {
  assert.equal(where(req({ procs: true }), cand()), "m2");
  assert.equal(where(req({ procs: true }), cand({ procs: false })), "local");
  assert.equal(where(req({ egress_locked: true }), cand()), "m2", "phase 5: a host that runs the proxy takes a locked workspace");
  assert.equal(where(req({ egress_locked: true }), cand({ egress: false })), "local");
  assert.equal(where(req({ brokered: true }), cand()), "local");
  assert.equal(where(req({ gh: true }), cand({ clis: ["claude"] })), "local");
  assert.equal(where(req({ gh: true }), cand()), "m2");
});
