/**
 * The impure half of placement (src/hosts/candidates.ts): where a terminal's work already lives
 * (stickyFor), and what the brain knows about each computer (placementCandidates) — against the
 * in-memory store and a stub link, no socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";
const { hosts, repos, sessions, workspaces } = await import("../store.js");
const { createTicket, ticketBranch } = await import("../tickets.js");
const { registerHost } = await import("./index.js");
const { RemoteHost, VITALS_STALE_MS } = await import("./remote.js");
const { placementCandidates, placeRequest, stickyFor } = await import("./candidates.js");
const { worktreeRootFor } = await import("../worktree-core.js");
const { PROTOCOL_VERSION } = await import("../hostlink/wire.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "placement-cand-"));
const ws = workspaces.create({ slug: "cand", name: "Cand", config_dir: path.join(tmp, ".claude-cand"), sandbox_mode: "off" } as any);
const repoPath = path.join(tmp, "web");
fs.mkdirSync(repoPath);
const repo = repos.create({ workspace_id: ws.id, name: "web", path: repoPath, default_branch: "main", git_remote: "git@github.com:acme/web.git" } as any);

let online = true;
const port = { isOnline: () => online, sendControl: () => true, request: async () => { throw new Error("no requests"); } };
hosts.create({ id: "h_m2", name: "m2", token_hash: "x".repeat(64), status: "online" });
const m2 = new RemoteHost("h_m2", port);
registerHost(m2);
m2.setOnline({
  proto: PROTOCOL_VERSION, version: "0.1.0", host_id: "h_m2", name: "m2-hostname", platform: "darwin", arch: "arm64",
  capabilities: { clis: [{ name: "claude", path: "/opt/homebrew/bin/claude", version: null }, { name: "grok", path: null, version: null }], node: process.version, sandbox: true, auto_clone: true },
  profiles: [{ name: "claude-cand", dir: "/Users/x/.claude-cand", exists: true }], checkouts: [], deny: ["globex"], live: [],
} as any);
// Joined but never connected this boot: a candidate that can only ever say "offline".
hosts.create({ id: "h_m5", name: "m5", token_hash: "y".repeat(64), status: "offline" });
// Revoked: no token, not a computer any more.
hosts.create({ id: "h_old", name: "old", token_hash: null, status: "disabled" });

test("candidates: the brain first, then every joined host — reported capabilities, veto, and fresh vitals only", () => {
  const now = Date.now();
  m2.setVitals({ at: 0, cpu: 3, ram: 41, gpu: 0, loadPerCore: 0.3, pressure: 1, swapPct: 12, ncpu: 12, load1: 3.6, swapUsedMb: 480, swapTotalMb: 4000 }, now);
  const c = placementCandidates(now);
  assert.deepEqual(c.map((h) => h.id), ["local", "h_m2", "h_m5"], "revoked hosts are not candidates");
  const [brain, h2, h5] = c;
  assert.equal(brain.is_brain, true);
  assert.equal(h2.name, "m2", "the operator's name for it, as the Desk shows");
  assert.equal(h2.online, true);
  assert.deepEqual(h2.clis, ["claude"], "only CLIs it actually found");
  assert.deepEqual(h2.veto, ["globex"]);
  assert.equal(h2.auto_clone, true);
  assert.deepEqual(h2.load, { load1: 3.6, ncpu: 12, loadPerCore: 0.3, swapUsedMb: 480, swapTotalMb: 4000, pressureLevel: 1 });
  assert.equal(h2.ram_pct, 41);
  assert.equal(h5.online, false);
  assert.equal(h5.load, null);
  // Vitals the brain received too long ago are not a reading.
  assert.equal(placementCandidates(now + VITALS_STALE_MS + 1)[1].load, null);
});

test("sticky: a reopen stays on its row's host; a stand-in on the walled terminal's", () => {
  const row = sessions.create({ workspace_id: ws.id, backend: "claude-code", cwd: "/Users/x/web", host_id: "h_m2" } as any);
  assert.deepEqual(stickyFor({ resumeId: row.id }), { host_id: "h_m2", why: "its CLI transcript is on that computer", fresh: false });
  assert.deepEqual(stickyFor({ replaces: row.id, host_id: "h_m2" }), { host_id: "h_m2", why: "it stands in for a terminal whose files are there", fresh: false });
  assert.equal(stickyFor({ agentSessionId: "never-seen", resumeAgent: true })!.host_id, "local", "a headless run's transcript is on the brain");
});

test("sticky: a ticket goes where its worktree is — the brain's if it exists here, else the host that last worked it", () => {
  const t = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "fix the thing" } as any);
  assert.equal(stickyFor({ ticket_id: t.id, workspace_id: ws.id }), null, "no worktree anywhere yet: free to place");

  const worked = sessions.create({ workspace_id: ws.id, ticket_id: t.id, backend: "claude-code", cwd: "/Users/x/wt", host_id: "h_m2" } as any);
  assert.deepEqual(stickyFor({ ticket_id: t.id }), { host_id: "h_m2", why: `${t.key}'s worktree is on that computer`, fresh: true });

  // A worktree for it on the brain's own disk wins: that is a directory we can see.
  const wt = path.join(worktreeRootFor(repoPath), ticketBranch(t.key).replace(/\//g, "-"));
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(stickyFor({ ticket_id: t.id })!.host_id, "local");
  fs.rmSync(wt, { recursive: true, force: true });

  // A host that was removed took the worktree with it.
  sessions.end(worked.id);
  const gone = createTicket({ workspace_id: ws.id, repo_id: repo.id, title: "other" } as any);
  sessions.create({ workspace_id: ws.id, ticket_id: gone.id, backend: "claude-code", cwd: "/x", host_id: "h_old" } as any);
  assert.equal(stickyFor({ ticket_id: gone.id }), null);
});

test("sticky: a brain directory keeps it local — unless it was pinned, which wins as it did in phase 3", () => {
  assert.deepEqual(stickyFor({ cwd: "/tmp" }), { host_id: "local", why: "it was asked to start in a directory on the brain", fresh: true });
  assert.equal(stickyFor({ cwd: "/tmp", host_id: "h_m2" }), null);
});

test("the request: profile by name, repo by remote, operator vs agent, stand-ins exempt", () => {
  const r = placeRequest({ workspace_id: ws.id, repo_id: repo.id, backend: "claude-code" }, "robert");
  assert.deepEqual(r.workspace, { id: ws.id, slug: "cand" });
  assert.equal(r.profile, "claude-cand");
  assert.deepEqual(r.repo, { id: repo.id, name: "web", git_remote: "git@github.com:acme/web.git" });
  assert.equal(r.opened_by, "agent");
  assert.equal(r.fresh, true);
  assert.equal(placeRequest({ workspace_id: ws.id }, "operator").opened_by, "operator");
  assert.equal(placeRequest({ workspace_id: ws.id }, "").opened_by, "operator");
  assert.equal(placeRequest({ workspace_id: ws.id, replaces: "x" }, "failover").exempt_admission, true);
});

test("a remote host's governor is real: its own numbers, its own core count, its own heavy slots", () => {
  m2.setVitals({ at: 0, cpu: 99, ram: 92, gpu: 0, loadPerCore: 3.1, pressure: 2, swapPct: 95, ncpu: 12, load1: 37.2, swapUsedMb: 3800, swapTotalMb: 4000 });
  const v = m2.vitals();
  assert.equal(v.load.ncpu, 12);
  assert.equal(v.admission.ok, false);
  assert.match((v.admission as any).reason, /^load 37\.2 on 12 cores, memory pressure warning \(swap 95% used\)/);
  assert.equal(m2.slots.size(), 2, "ncpu/6 of THAT machine");
  online = false;
  assert.match((m2.vitals().admission as any).reason, /offline/);
  online = true;
});
