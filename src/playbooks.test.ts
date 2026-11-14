/**
 * Playbooks (src/playbooks.ts): the line format, the workspace walls, drafting a chain from what a
 * terminal ran, and a run's life — ONE OK that names the head SHA and every gate, a stop when the PR
 * head moves after it, a stop-and-ask on the first failure, never a re-run of its own, never a step
 * outside its workspace. Real store (in-memory DB); GitHub, the terminal, the service supervisor and
 * the operator's phone are seams (setPlaybookDeps), so nothing real is read, typed, deployed or sent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { workspaces, repos, services, sessions, asks, playbooks, playbookRuns } = await import("./store.js");
const P = await import("./playbooks.js");
const { clearPrOwnershipCache } = await import("./pr-ownership.js");
import type { PlaybookStep } from "./store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-playbooks-"));
after(() => { P.setPlaybookDeps(null); fs.rmSync(tmp, { recursive: true, force: true }); });
const t0 = Date.now();
const A = workspaces.create({ slug: `pba-${t0}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `pbb-${t0}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const repoA = repos.create({ workspace_id: A.id, name: "app", path: path.join(tmp, "a", "app"), git_remote: "https://github.com/acme/app" } as any);
const repoB = repos.create({ workspace_id: B.id, name: "core", path: path.join(tmp, "b", "core"), git_remote: "https://github.com/initech/core" } as any);
const botA = services.create({ workspace_id: A.id, name: "bot", command: "./run.sh", cwd: repoA.path, ref: "main" });
services.create({ workspace_id: B.id, name: "tps", command: "./run.sh", cwd: repoB.path });
clearPrOwnershipCache();

const PR = "https://github.com/acme/app/pull/12";
const PR_B = "https://github.com/initech/core/pull/7";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

// ── the seams: GitHub's view of the PR, the terminal, the supervisor, the operator's phone ──
const heads: Record<string, { state: string; head: string | null; number: number | null; draft: boolean }> = {
  [PR]: { state: "OPEN", head: SHA1, number: 12, draft: false },
  [PR_B]: { state: "OPEN", head: SHA1, number: 7, draft: false },
};
const opened: any[] = [];
const told: Array<[string, string]> = [];
const carried: Array<[string, string]> = [];
const notified: any[] = [];
const cards: Array<[string, any]> = [];
let serviceFails: string | null = null;
P.setPlaybookDeps({
  readPr: async (_ws, url) => {
    const h = heads[url];
    if (!h) throw new Error("no such PR");
    return { ...h };
  },
  open: async (a) => {
    opened.push(a);
    return sessions.create({ workspace_id: a.workspace_id, cwd: tmp, goal: a.goal, created_by: a.created_by } as any);
  },
  tell: async (sid, text) => { told.push([sid, text]); return null; },
  service: async (svc, action) => {
    carried.push([svc.id, action]);
    if (serviceFails) throw new Error(serviceFails);
    return `${action} ${svc.name}: ok`;
  },
  notifyAsk: (a) => { notified.push(a); },
  card: (sid, c) => { cards.push([sid, c]); },
});

const CHAIN = [
  "[merge] gh pr merge {{pr}} --squash --match-head-commit {{sha}}",
  `cd ${repoA.path} && make release`,
  "rclone copy dist/tool.zip remote:releases",
  "mc service deploy bot",
  "[publish] agent: rebuild the data page and republish it",
  "message slack @requester: It is live — two lines on what changed.",
].join("\n");

let n = 0;
function chainPlaybook(text = CHAIN) {
  const p = P.parseSteps(text);
  assert.deepEqual(p.errors, []);
  const steps = P.normalizeSteps(p.steps);
  assert.deepEqual(P.validateSteps(A, steps), [], "the chain passes its workspace's walls");
  return playbooks.create({ workspace_id: A.id, name: `release-${++n}`, steps, reviewed: true });
}

async function okd(pb = chainPlaybook(), o: { from?: number } = {}) {
  heads[PR] = { state: "OPEN", head: SHA1, number: 12, draft: false };
  const c = await P.createRun(pb, { pr: PR, by: "robert", from: o.from ?? null });
  assert.ok(c.ok, JSON.stringify(c));
  const run = c.run;
  const ok = await P.okRun(run, { sha: run.head_sha, gates: P.pendingGates(run).map((s) => s.idx), surface: "desk" });
  assert.ok(ok.ok, JSON.stringify(ok));
  return ok.run;
}
const reload = (id: string) => playbookRuns.get(id)!;

// ───────────────────────────── the line format ─────────────────────────────

test("the line format: gates by tag and by command, a continued line, the final draft — and back", () => {
  const text = [
    "# release",
    "[merge] gh pr merge {{pr}} --squash",
    "npm publish",
    "cat > notes.txt <<'EOF'",
    "  first line",
    "  EOF",
    "[release] agent: upload the zip to the share",
    "mc service restart bot",
    "message email ops@example.com: It is live.",
  ].join("\n");
  const { steps, errors } = P.parseSteps(text);
  assert.deepEqual(errors, []);
  const norm = P.normalizeSteps(steps);
  assert.deepEqual(norm.map((s) => [s.kind, s.gate]), [
    ["shell", "merge"], ["shell", "publish"], ["shell", null], ["agent", "release"], ["mc", "deploy"], ["message", null],
  ]);
  assert.equal(norm[2].run, "cat > notes.txt <<'EOF'\nfirst line\nEOF", "an indented line continues the step above");
  assert.deepEqual([norm[5].channel, norm[5].to, norm[5].run], ["email", "ops@example.com", "It is live."]);
  assert.deepEqual(P.parseSteps(P.formatSteps(norm)).steps, norm, "what it writes, it reads back the same");
  assert.equal(P.serviceAction(norm[4])?.name, "bot");
  assert.equal(P.stepLabel({ kind: "shell", run: "cd /x/y && make release", gate: null }), "make release");
});

test("the line format names what it cannot read", () => {
  const { errors } = P.parseSteps("[ship] make it\n[merge] message slack a: b\nmessage slack no colon here\n[deploy]   ");
  assert.equal(errors.length, 4, errors.join(" | "));
  assert.match(errors[0], /line 1: \[ship\] is not a gate/);
  assert.match(errors[1], /never a gate/);
  assert.match(errors[2], /message slack\|email <to>: <text>/);
  assert.match(errors[3], /empty step/);
});

// ───────────────────────────── the walls ─────────────────────────────

test("a step never reaches outside its workspace: a cd elsewhere, another workspace's path, service or --workspace, a merge of a named PR", () => {
  const bad: PlaybookStep[] = [
    { kind: "shell", run: `cd ${path.join(tmp, "elsewhere")} && make`, gate: null },
    { kind: "shell", run: `cat ${repoB.path}/notes.txt`, gate: null },
    { kind: "mc", run: "mc service deploy tps", gate: null },
    { kind: "mc", run: `mc memo list --workspace ${B.slug}`, gate: null },
    { kind: "shell", run: "gh pr merge 7 --repo initech/core --squash", gate: null },
    { kind: "mc", run: "mc service add x --command y", gate: null },
    { kind: "agent", run: "merge the PR", gate: "merge" },
    { kind: "shell", run: "echo {{token}}", gate: null },
  ];
  const errors = P.validateSteps(A, P.normalizeSteps(bad));
  const has = (re: RegExp) => assert.ok(errors.some((e) => re.test(e)), `${re} in:\n${errors.join("\n")}`);
  has(/step 1: `cd .*elsewhere` is outside this workspace's repos and services/);
  has(/step 2: .*core.* belongs to another workspace/);
  has(/step 3: this workspace has no service named 'tps'/);
  has(new RegExp(`step 4: --workspace ${B.slug} is not this workspace`));
  has(/step 5: a merge step merges the run's PR/);
  has(/step 6: a playbook deploys or restarts one of this workspace's services/);
  has(/step 7: a merge is the command itself/);
  has(/step 8: \{\{token\}\} is not a template/);
  // A message is the last step, and there is one at most.
  const msgs = P.validateSteps(A, [
    { kind: "message", run: "hi", to: "x", channel: "slack", gate: null },
    { kind: "shell", run: "make", gate: null },
    { kind: "message", run: "hi", to: "", channel: "slack", gate: null },
  ]);
  assert.ok(msgs.some((e) => /one message step at most/.test(e)) && msgs.some((e) => /the last one/.test(e)) && msgs.some((e) => /who is the draft for/.test(e)), msgs.join("\n"));
  // The same steps are fine in the workspace they belong to.
  assert.deepEqual(P.validateSteps(B, P.normalizeSteps([{ kind: "mc", run: "mc service deploy tps", gate: null }, { kind: "shell", run: `cd ${repoB.path} && make`, gate: null }])), []);
});

// ───────────────────────────── save from session ─────────────────────────────

function transcript(calls: Array<{ name?: string; input: any; error?: boolean }>): string {
  const out: string[] = [];
  calls.forEach((c, i) => {
    const id = `tu_${i}`;
    const ts = new Date(Date.UTC(2026, 10, 12, 18, 0, i)).toISOString();
    out.push(JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name: c.name ?? "Bash", input: c.input }] } }));
    out.push(JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, content: c.error ? "Exit code 1\nboom" : "ok", ...(c.error ? { is_error: true } : {}) }] } }));
  });
  return out.join("\n");
}
const CHAIN_TRANSCRIPT = (repoPath: string) => transcript([
  { input: { command: "npm test" } }, // the work that made the PR: before the first merge
  { name: "Edit", input: { file_path: "/x/app.ts" } },
  { input: { command: "git status && git log --oneline -3" } },
  { input: { command: `gh pr merge 12 --repo acme/app --squash --match-head-commit ${SHA1} 2>&1 | tail -3; gh pr view 12 --json state` } },
  { input: { command: 'mc outcome --shipped "merged #12"' } },
  { input: { command: "ls dist" } },
  { input: { command: `cd ${repoPath} && make release 2>&1 | tail -3` } },
  { input: { command: "rclone copy dist/tool.zip remote:releases --bad-flag" }, error: true },
  { input: { command: "rclone copy dist/tool.zip remote:releases" } },
  { input: { command: "mc service deploy bot" } },
  { name: "Artifact", input: { action: "publish", url: "https://claude.ai/artifact/abc123", file_path: "/tmp/page.html" } },
  { name: "mcp__slack__slack_send_message_draft", input: { channel_id: "C123", message: "first try" } },
  // The same chain again, for another PR: folded, not repeated.
  { input: { command: `gh pr merge 13 --repo acme/app --squash --match-head-commit ${SHA2}` } },
  { input: { command: `cd ${repoPath} && make release` } },
  { input: { command: "mc service deploy bot" } },
  { name: "mcp__slack__slack_send_message_draft", input: { channel_id: "C123", message: "It is live." } },
]);

test("save from session: what a terminal ran becomes the chain — from its first merge, templated, folded, its last draft at the end", () => {
  const calls = P.readCalls(CHAIN_TRANSCRIPT(repoA.path), "claude-code");
  assert.equal(calls.filter((c) => !c.ok).length, 1, "the failed call is marked");
  const d = P.draftSteps(calls);
  assert.deepEqual(d.steps.map((s) => [s.kind, s.gate, s.run]), [
    ["shell", "merge", "gh pr merge {{pr}} --squash --match-head-commit {{sha}}"],
    ["shell", null, `cd ${repoA.path} && make release`],
    ["shell", "release", "rclone copy dist/tool.zip remote:releases"],
    ["mc", "deploy", "mc service deploy bot"],
    ["agent", "publish", "Republish the claude.ai page https://claude.ai/artifact/abc123 with the rebuilt data (the Artifact tool, publish to that url)"],
    ["message", null, "It is live."],
  ]);
  assert.equal(d.steps[5].to, "C123");
  assert.deepEqual(d.target, { pr_url: PR, sha: SHA1 });
  assert.ok(d.notes.some((x) => /left out 1 call that failed/.test(x)), d.notes.join(" | "));
  assert.ok(d.notes.some((x) => /started at the first merge — left out 1 earlier step$/.test(x)), d.notes.join(" | "));
  assert.ok(d.notes.some((x) => /merges of other PRs \(#13\)/.test(x)), d.notes.join(" | "));
  assert.deepEqual(P.validateSteps(A, d.steps), [], "a draft from its own workspace's terminal passes the walls");
  // --since: only what it ran after a moment.
  const late = P.draftSteps(calls, { since: Date.UTC(2026, 10, 12, 18, 0, 13) });
  assert.deepEqual(late.steps.map((s) => s.run), [`cd ${repoA.path} && make release`, "mc service deploy bot", "It is live."]);
});

test("a command that only looks, or keeps Chronos' books, is never a step", () => {
  for (const c of ["git status", "gh pr checks 12", "gh api repos/a/b/pulls", "curl -s http://localhost:7777/api/health", "sed -n 1,20p x", "mc progress 2/5 x", "mc state waiting", "box files:download 1 --destination /tmp/x", "cd /tmp && ls"]) {
    assert.equal(P.simplifyCommand(c), null, c);
  }
  for (const c of ["gh api -X POST repos/a/b/issues", "curl -T dist/x.zip https://share.example/up", "git push origin main", "sed -i '' s/a/b/ f", "make release"]) {
    assert.notEqual(P.simplifyCommand(c), null, c);
  }
  assert.equal(P.simplifyCommand("set -a; source ~/.config/tool/env; set +a; uv run tool build --out dist 2>&1 | tail -5"), "set -a && source ~/.config/tool/env && set +a && uv run tool build --out dist");
});

// ───────────────────────────── one OK ─────────────────────────────

test("a run waits for ONE OK: nothing starts before it, and the OK must name the head he saw and every gate", async () => {
  const pb = chainPlaybook();
  const c = await P.createRun(pb, { pr: PR, by: "robert" });
  assert.ok(c.ok, JSON.stringify(c));
  const run = c.run;
  assert.equal(run.state, "awaiting_ok");
  assert.equal(run.head_sha, SHA1);
  assert.deepEqual(P.pendingGates(run).map((s) => [s.idx, s.gate]), [[1, "merge"], [3, "release"], [4, "deploy"], [5, "publish"]]);
  const early = await P.startStep(run, 1);
  assert.ok(!early.ok && early.status === 409 && early.stop && /waiting for the operator's OK/.test(early.error), JSON.stringify(early));

  const fewer = await P.okRun(run, { sha: SHA1, gates: [1, 3] });
  assert.ok(!fewer.ok && fewer.status === 409 && /gates are not the ones/.test(fewer.error), JSON.stringify(fewer));
  const other = await P.okRun(run, { sha: SHA2, gates: [1, 3, 4, 5] });
  assert.ok(!other.ok && other.status === 409 && /not the head this run targets/.test(other.error), JSON.stringify(other));
  assert.equal(reload(run.id).state, "awaiting_ok", "a refused OK records nothing");

  const before = opened.length;
  const ok = await P.okRun(run, { sha: SHA1, gates: [5, 4, 3, 1], surface: "desk" });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.run.state, "running");
  assert.equal(ok.run.ok_sha, SHA1);
  assert.deepEqual(ok.run.ok_gates!.map((g) => [g.idx, g.gate]), [[1, "merge"], [3, "release"], [4, "deploy"], [5, "publish"]]);
  assert.equal(opened.length, before + 1, "the OK opens its terminal");
  const o = opened.at(-1);
  assert.equal(o.workspace_id, A.id, "in the playbook's own workspace");
  assert.equal(o.created_by, "operator", "his OK opened it: the governor treats it as his own open");
  assert.equal(ok.run.session_id, sessions.list({ workspace_id: A.id }).find((s) => s.goal === o.goal)?.id);
  assert.match(o.description, /step 1: merge[\s\S]*step 3: release[\s\S]*step 4: deploy[\s\S]*step 5: publish/);
  assert.match(o.description, new RegExp(`gh pr merge ${PR} --squash --match-head-commit ${SHA1}`), "the brief shows the merge pinned to the head he OK'd");
  assert.match(o.description, /fail "<what failed>"` and STOP/);
  assert.match(o.description, /ALWAYS a draft/);
  const again = await P.okRun(ok.run, { sha: SHA1, gates: [1, 3, 4, 5] });
  assert.ok(!again.ok && again.status === 409, "one OK per run");
});

test("the OK covers the gates it listed, in that run, and nothing else", async () => {
  // Another run has no OK of its own: the first run's OK does not reach it.
  const first = await okd();
  const pb2 = chainPlaybook();
  const second = await P.createRun(pb2, { pr: PR, by: "terminal x" });
  assert.ok(second.ok);
  const s2 = await P.startStep(second.run, 1);
  assert.ok(!s2.ok && s2.stop, "a run waiting for its own OK takes no step");

  // A run from step 3: the merge before it is not in the run, nor in its OK.
  const from3 = await okd(chainPlaybook(), { from: 3 });
  assert.deepEqual(from3.ok_gates!.map((g) => g.idx), [3, 4, 5]);
  const merge = await P.startStep(from3, 1);
  assert.ok(!merge.ok && merge.stop && /not part of this run/.test(merge.error), JSON.stringify(merge));
  const s3 = await P.startStep(from3, 3);
  assert.ok(s3.ok, JSON.stringify(s3));
  assert.equal(s3.command, "rclone copy dist/tool.zip remote:releases");
  assert.ok(P.finishStep(reload(from3.id), 3, "done", "uploaded").ok);

  // A gate whose entry is not in the OK (a run's OK names each gate by step and content) is refused.
  playbookRuns.patch(from3.id, { ok_gates: reload(from3.id).ok_gates!.filter((g) => g.idx !== 4) });
  const s4 = await P.startStep(reload(from3.id), 4);
  assert.ok(!s4.ok && s4.status === 403 && s4.stop && /deploy gate the operator's OK did not cover/.test(s4.error), JSON.stringify(s4));
  assert.equal(carried.length, 0, "and nothing was deployed");

  // The merge merges the run's own PR at the head he OK'd — the only PR it can name.
  const m = await P.startStep(first, 1);
  assert.ok(m.ok, JSON.stringify(m));
  assert.equal(m.command, `gh pr merge ${PR} --squash --match-head-commit ${SHA1}`);
});

test("the PR head moves after the OK: the run stops before the next gate and waits for a new OK", async () => {
  const run = await okd();
  heads[PR] = { state: "OPEN", head: SHA2, number: 12, draft: false };
  const s1 = await P.startStep(run, 1);
  assert.ok(!s1.ok && s1.status === 409 && s1.stop && /head moved after the OK/.test(s1.error), JSON.stringify(s1));
  let r = reload(run.id);
  assert.equal(r.state, "needs_ok");
  assert.equal(r.head_sha, SHA2);
  assert.equal(r.steps[0].status, "todo", "nothing ran");
  assert.ok(!(await P.startStep(r, 1)).ok, "still stopped");
  // His new OK names the new head; the old one is refused.
  const stale = await P.okRun(r, { sha: SHA1, gates: [1, 3, 4, 5] });
  assert.ok(!stale.ok && /not the head/.test(stale.error));
  told.length = 0;
  const ok = await P.okRun(r, { sha: SHA2, gates: [1, 3, 4, 5] });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.run.state, "running");
  assert.equal(told.length, 1);
  assert.equal(told[0][0], run.session_id, "the same terminal is told to go on");
  assert.match(told[0][1], /OK'd .* again[\s\S]*mc playbook step 1 start/);
  r = reload(run.id);
  const s1b = await P.startStep(r, 1);
  assert.ok(s1b.ok, JSON.stringify(s1b));
  assert.equal(s1b.command, `gh pr merge ${PR} --squash --match-head-commit ${SHA2}`);
});

test("a new OK whose terminal has gone opens a fresh one, told what is already done", async () => {
  const run = await okd();
  assert.ok((await P.startStep(run, 1)).ok);
  assert.ok(P.finishStep(reload(run.id), 1, "done", "merged").ok);
  assert.ok((await P.startStep(reload(run.id), 2)).ok);
  assert.ok(P.finishStep(reload(run.id), 2, "done", "built").ok);
  heads[PR] = { state: "MERGED", head: SHA2, number: 12, draft: false };
  const s3 = await P.startStep(reload(run.id), 3);
  assert.ok(!s3.ok && s3.stop, JSON.stringify(s3));
  assert.equal(reload(run.id).state, "needs_ok");
  P.setPlaybookDeps({ tell: async (sid, text) => { told.push([sid, text]); return "terminal is not live"; } });
  try {
    const before = opened.length;
    const ok = await P.okRun(reload(run.id), { sha: SHA2, gates: [3, 4, 5] });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(opened.length, before + 1, "a fresh terminal picks the run up");
    assert.notEqual(ok.run.session_id, run.session_id);
    assert.match(opened.at(-1).description, /Already done in this run: steps 1, 2\. Start at step 3 — never redo a done step\./);
  } finally {
    P.setPlaybookDeps({ tell: async (sid, text) => { told.push([sid, text]); return null; } });
  }
});

test("a failed step stops the run and asks the operator; nothing after it runs, and nothing runs it again", async () => {
  const run = await okd();
  assert.ok((await P.startStep(run, 1)).ok);
  assert.ok(P.finishStep(reload(run.id), 1, "done", "merged").ok);
  assert.ok((await P.startStep(reload(run.id), 2)).ok);
  const opensBefore = opened.length;
  const notesBefore = notified.length;
  const f = P.finishStep(reload(run.id), 2, "failed", "make: *** [release] Error 2");
  assert.ok(f.ok);
  const r = reload(run.id);
  assert.equal(r.state, "failed");
  assert.match(r.reason!, /step 2 \(make release\) failed: make: \*\*\* \[release\] Error 2/);
  const q = asks.openForSession(run.session_id!);
  assert.equal(q.length, 1, "one question, on the run's terminal");
  assert.equal(q[0].route, "operator");
  assert.equal(q[0].workspace_id, A.id);
  assert.match(q[0].question, /stopped at step 2[\s\S]*not release \(step 3\), deploy \(step 4\), publish \(step 5\)/);
  assert.equal(notified.length, notesBefore + 1, "the operator is told");
  const card = cards.filter(([sid, c]) => sid === run.session_id && c.progress).at(-1)![1];
  assert.deepEqual([card.progress.n, card.progress.of], [1, 6]);
  assert.match(card.progress.label, /2\. make release$/, "its card names the step that failed");
  // The terminal finds its run whatever its state, so what it reads is the daemon's own reason.
  assert.equal(playbookRuns.list({ session_id: run.session_id!, limit: 1 })[0].id, run.id);
  // Stopped means stopped: no next step, no rewriting the failure, no new run, no new terminal.
  const s3 = await P.startStep(r, 3);
  assert.ok(!s3.ok && s3.stop, JSON.stringify(s3));
  assert.ok(!P.finishStep(r, 2, "done", "actually fine").ok);
  assert.equal(playbookRuns.list({ playbook_id: run.playbook_id }).length, 1);
  assert.equal(opened.length, opensBefore);
  // Its brief says so, and marks what ran — with the command each step was given.
  const brief = P.runBrief(r, "Acme");
  assert.match(brief, /This run is failed — step 2 \(make release\) failed[\s\S]*Do nothing more for it\./);
  assert.doesNotMatch(brief, /Start at step/);
  assert.match(brief, new RegExp(`1\\. \\(done\\) \\[merge\\] gh pr merge ${PR} --squash --match-head-commit ${SHA1}`));
  assert.match(brief, /2\. \(FAILED\) cd .* && make release/);
  assert.match(brief, /- step 3: release — rclone copy dist\/tool\.zip remote:releases/);
  // Going on is a NEW run, from the failed step, with a new OK.
  const next = await P.createRun(playbooks.get(run.playbook_id)!, { pr: PR, from: 2, by: "operator" });
  assert.ok(next.ok);
  assert.equal(next.run.state, "awaiting_ok");
  assert.deepEqual(P.pendingGates(next.run).map((s) => s.idx), [3, 4, 5]);
});

test("the step the agent cannot do itself — its workspace's service — is carried out by the daemon, inside the OK'd run only", async () => {
  carried.length = 0;
  const run = await okd(chainPlaybook(), { from: 4 });
  const s4 = await P.startStep(run, 4);
  assert.ok(s4.ok, JSON.stringify(s4));
  assert.deepEqual(carried, [[botA.id, "deploy"]]);
  assert.deepEqual(s4.carried, { ok: true, detail: "deploy bot: ok" });
  const r = reload(run.id);
  assert.equal(r.steps[3].status, "done");
  assert.ok(!P.finishStep(r, 4, "done", "x").ok, "its result is the daemon's to record");
  // A deploy that fails stops the run and asks, like any step.
  serviceFails = "git fetch origin main failed";
  try {
    const run2 = await okd(chainPlaybook(), { from: 4 });
    const f = await P.startStep(run2, 4);
    assert.ok(f.ok && f.carried && !f.carried.ok, JSON.stringify(f));
    assert.equal(reload(run2.id).state, "failed");
    assert.equal(asks.openForSession(run2.session_id!).length, 1);
  } finally {
    serviceFails = null;
  }
});

test("a run never crosses workspaces: another workspace's PR, a terminal of another workspace", async () => {
  const pb = chainPlaybook();
  const theirPr = await P.createRun(pb, { pr: PR_B, by: "robert" });
  assert.ok(!theirPr.ok && theirPr.status === 403 && /not a PR of this workspace/.test(theirPr.error), JSON.stringify(theirPr));
  const theirs = sessions.create({ workspace_id: B.id, cwd: tmp, goal: "b work" } as any);
  const here = await P.createRun(pb, { pr: PR, by: "terminal", here: true, session: theirs.id });
  assert.ok(!here.ok && here.status === 400, JSON.stringify(here));
  const noPr = await P.createRun(pb, { by: "robert" });
  assert.ok(!noPr.ok && /pass --pr/.test(noPr.error));
  assert.equal(playbookRuns.list({ playbook_id: pb.id }).length, 0, "nothing was created");
  // A playbook that a moved wall would now refuse is refused at run time too.
  const moved = playbooks.create({ workspace_id: A.id, name: `moved-${t0}`, steps: [{ kind: "mc", run: "mc service deploy gone", gate: "deploy" }] });
  const m = await P.createRun(moved, { by: "operator" });
  assert.ok(!m.ok && m.status === 400 && /no service named 'gone'/.test(m.error), JSON.stringify(m));
});

test("--here: the OK types the run into the terminal that asked, in its workspace", async () => {
  const mine = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "did the chain" } as any);
  const c = await P.createRun(chainPlaybook(), { pr: PR, by: "terminal", here: true, session: mine.id });
  assert.ok(c.ok, JSON.stringify(c));
  told.length = 0;
  const before = opened.length;
  const ok = await P.okRun(c.run, { sha: SHA1, gates: [1, 3, 4, 5] });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(opened.length, before, "no new terminal");
  assert.equal(ok.run.session_id, mine.id);
  assert.equal(told[0][0], mine.id);
  assert.match(told[0][1], /mc playbook brief [0-9a-f]{8}[\s\S]*mc playbook step 1 start/);
});

test("an OK does not outlive its day, and a run nobody OK'd expires", async () => {
  const run = await okd();
  const later = Date.now() + P.RUN_TTL_MS + 60_000;
  const s = await P.startStep(run, 1, later);
  assert.ok(!s.ok && s.stop, JSON.stringify(s));
  assert.equal(reload(run.id).state, "expired");
  const c = await P.createRun(chainPlaybook(), { pr: PR, by: "robert" });
  assert.ok(c.ok);
  assert.equal(P.freshen(c.run, Date.now() + P.OK_WAIT_MS + 60_000).state, "expired");
  const ok = await P.okRun(reload(c.run.id), { sha: SHA1, gates: [1, 3, 4, 5] });
  assert.ok(!ok.ok && /expired/.test(ok.error));
});

test("one run of a playbook at a time; stopping one is always allowed and tells its terminal", async () => {
  const pb = chainPlaybook();
  const run = await okd(pb);
  const twin = await P.createRun(pb, { pr: PR, by: "robert" });
  assert.ok(!twin.ok && twin.status === 409 && /still running/.test(twin.error), JSON.stringify(twin));
  told.length = 0;
  const st = P.stopRun(run, "operator", "not today");
  assert.ok(st.ok);
  assert.equal(st.run.state, "stopped");
  await new Promise((r) => setImmediate(r));
  assert.equal(told[0]?.[0], run.session_id);
  assert.match(told[0][1], /stopped by operator \(not today\)\. Do nothing more for it/);
  assert.ok(!(await P.startStep(reload(run.id), 1)).ok);
  assert.ok((await P.createRun(pb, { pr: PR, by: "robert" })).ok, "and the next run may start");
});

test("stopping a --here run that still waits for its OK tells the terminal that asked", async () => {
  const mine = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "asked for a run" } as any);
  const c = await P.createRun(chainPlaybook(), { pr: PR, by: "terminal", here: true, session: mine.id });
  assert.ok(c.ok);
  told.length = 0;
  assert.ok(P.stopRun(c.run, "operator", null).ok);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(told.map((x) => x[0]), [mine.id]);
});
