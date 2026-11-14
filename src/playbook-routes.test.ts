/**
 * `/api/playbooks` + `/api/playbook-runs` over real HTTP with the real store and authz
 * (playbook-routes.ts). What is under test is who may do what: a workspace token reaches its own
 * workspace's playbooks and runs only (another's are the 404 a missing id gets, CLAUDE.md gotcha #4),
 * the OK is the operator's own hand and nobody else's, a run's steps are worked by its own terminal,
 * and a draft from a terminal never crosses into another workspace. GitHub, the terminal and the
 * supervisor are seams (setPlaybookDeps).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

const { CONFIG } = await import("./config.js");
const { workspaces, repos, services, sessions, playbooks, playbookRuns } = await import("./store.js");
const { robertToken } = await import("./authz.js");
const routes = await import("./playbook-routes.js");
const P = await import("./playbooks.js");
const { clearPrOwnershipCache } = await import("./pr-ownership.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pb-routes-"));
const t0 = Date.now();
const A = workspaces.create({ slug: `pra-${t0}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `prb-${t0}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const repoA = repos.create({ workspace_id: A.id, name: "app", path: path.join(tmp, "a", "app"), git_remote: "https://github.com/acme/app" } as any);
const repoB = repos.create({ workspace_id: B.id, name: "core", path: path.join(tmp, "b", "core"), git_remote: "https://github.com/initech/core" } as any);
services.create({ workspace_id: A.id, name: "bot", command: "./run.sh", cwd: repoA.path, ref: "main" });
services.create({ workspace_id: B.id, name: "tps", command: "./run.sh", cwd: repoB.path });
clearPrOwnershipCache();

const PR = "https://github.com/acme/app/pull/12";
const PR_B = "https://github.com/initech/core/pull/7";
const SHA = "a".repeat(40);
const opened: any[] = [];
P.setPlaybookDeps({
  readPr: async (_ws, url) => ({ state: "OPEN", head: SHA, number: Number(url.split("/").pop()), draft: false }),
  open: async (a) => {
    opened.push(a);
    return sessions.create({ workspace_id: a.workspace_id, cwd: tmp, goal: a.goal, created_by: a.created_by } as any);
  },
  tell: async () => null,
  service: async (svc, action) => `${action} ${svc.name}`,
  notifyAsk: () => {},
  card: () => {},
});

const app = express();
app.use(express.json());
const api = express.Router();
routes.mountPlaybookRoutes(api);
app.use("/api", api);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
after(() => { server.close(); P.setPlaybookDeps(null); fs.rmSync(tmp, { recursive: true, force: true }); });

const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const hand = { ...admin, "x-mc-operator": "1" };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token };
const asB = { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token };
const robertA = { ...json, "x-mc-admin": robertToken(A.id, "rw", "operator") };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}

const CHAIN = [
  "[merge] gh pr merge {{pr}} --squash --match-head-commit {{sha}}",
  `cd ${repoA.path} && make release`,
  "mc service deploy bot",
  "message slack @requester: It is live.",
].join("\n");

let k = 0;
async function savedAndRun(name = `rel-${++k}`) {
  const pb = await call("POST", "/playbooks", asA, { name, text: CHAIN });
  assert.equal(pb.status, 201, JSON.stringify(pb.json));
  const run = await call("POST", `/playbooks/${pb.json.id}/runs`, asA, { pr: PR });
  assert.equal(run.status, 201, JSON.stringify(run.json));
  return { pb: pb.json, run: run.json };
}

test("a workspace token reaches its own playbooks and runs only — another workspace's are the 404 a missing id gets", async () => {
  const { pb, run } = await savedAndRun("release");
  assert.equal(pb.workspace_id, A.id);
  assert.equal(pb.reviewed, false, "saved by an agent: not reviewed by the operator");
  assert.deepEqual(pb.gates.map((g: any) => [g.idx, g.gate]), [[1, "merge"], [3, "deploy"]]);
  assert.equal(run.state, "awaiting_ok");
  assert.deepEqual(run.gates.map((g: any) => g.idx), [1, 3]);

  const missing = await call("GET", "/playbooks/00000000-0000-0000-0000-000000000000", asB);
  assert.equal(missing.status, 404);
  for (const [method, p, body] of [
    ["GET", `/playbooks/${pb.id}`],
    ["GET", "/playbooks/release"],
    ["PATCH", `/playbooks/${pb.id}`, { description: "mine now" }],
    ["DELETE", `/playbooks/${pb.id}`],
    ["POST", `/playbooks/${pb.id}/runs`, { pr: PR }],
    ["GET", `/playbook-runs/${run.id}`],
    ["GET", `/playbook-runs/${run.id}/brief`],
    ["POST", `/playbook-runs/${run.id}/stop`, {}],
    ["POST", `/playbook-runs/${run.id}/steps/1/start`, {}],
  ] as const) {
    const r = await call(method, p, asB, body);
    assert.equal(r.status, missing.status, `${method} ${p} as workspace B: ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.deepEqual((await call("GET", "/playbooks", asB)).json, [], "B lists none of A's");
  assert.deepEqual((await call("GET", "/playbook-runs", asB)).json, []);
  assert.equal((await call("GET", `/playbooks?workspace=${A.slug}`, asB)).status, 404);
  assert.equal((await call("POST", "/playbooks", asB, { workspace: A.slug, name: "x", text: "make" })).status, 404, "nor writes into A");
  // Control: A sees both, and nothing above touched them.
  assert.equal((await call("GET", `/playbook-runs/${run.id}`, asA)).json.state, "awaiting_ok");
  assert.equal(playbooks.get(pb.id)?.description, null);
  // A run keeps the steps it was created with: editing the playbook changes the next run.
  const edit = await call("PATCH", `/playbooks/${pb.id}`, asA, { text: "make other-thing" });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(playbookRuns.get(run.id)!.steps[0].gate, "merge");
});

test("the OK is the operator's own hand: not a workspace token, not Robert, not the admin token without his hand", async () => {
  const { run } = await savedAndRun();
  const body = { sha: SHA, gates: [1, 3] };
  for (const [who, h] of [
    ["workspace A", asA],
    ["Robert of A", robertA],
    ["admin token, no x-mc-operator", admin],
    ["his hand from an agent's process", { ...hand, "x-mc-session": "abc12345" }],
    ["his hand with a workspace token", { ...hand, "x-mc-workspace-token": workspaces.get(A.id)!.token }],
  ] as const) {
    const r = await call("POST", `/playbook-runs/${run.id}/ok`, h, body);
    assert.equal(r.status, 403, `${who}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(playbookRuns.get(run.id)!.state, "awaiting_ok", "no refused OK moved the run");
  const ok = await call("POST", `/playbook-runs/${run.id}/ok`, hand, { ...body, surface: "desk" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.state, "running");
  assert.deepEqual(ok.json.ok.gates, [{ idx: 1, gate: "merge" }, { idx: 3, gate: "deploy" }]);
  assert.equal(ok.json.ok.sha, SHA);
  assert.equal(ok.json.ok.by, "operator");
  assert.equal(opened.at(-1).workspace_id, A.id);
});

test("only the run's own terminal works its steps — not another terminal, not Robert, not another workspace", async () => {
  const { run } = await savedAndRun();
  const notYet = await call("POST", `/playbook-runs/${run.id}/steps/1/start`, { ...asA, "x-mc-session": "abc12345" }, {});
  assert.equal(notYet.status, 403, "before the OK there is no terminal to work it");
  const ok = await call("POST", `/playbook-runs/${run.id}/ok`, hand, { sha: SHA, gates: [1, 3] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const sid = ok.json.session_id as string;
  const other = sessions.create({ workspace_id: A.id, cwd: tmp, goal: "another terminal" } as any);
  for (const [who, h, want] of [
    ["A with no terminal", asA, 403],
    ["another terminal of A", { ...asA, "x-mc-session": other.id }, 403],
    ["Robert of A", { ...robertA, "x-mc-session": sid }, 403],
    ["workspace B naming the terminal", { ...asB, "x-mc-session": sid }, 404],
  ] as const) {
    const r = await call("POST", `/playbook-runs/${run.id}/steps/1/start`, h, {});
    assert.equal(r.status, want, `${who}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  const mine = { ...asA, "x-mc-session": sid };
  const s1 = await call("POST", `/playbook-runs/${run.id}/steps/1/start`, mine, {});
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  assert.equal(s1.json.command, `gh pr merge ${PR} --squash --match-head-commit ${SHA}`);
  assert.equal((await call("POST", `/playbook-runs/${run.id}/steps/1/done`, mine, { note: "merged" })).status, 200);
  const skip = await call("POST", `/playbook-runs/${run.id}/steps/3/start`, mine, {});
  assert.equal(skip.status, 409, "order is kept: step 2 comes first");
  // Anyone in the workspace may stop it; stopping only halts.
  const stop = await call("POST", `/playbook-runs/${run.id}/stop`, robertA, { reason: "wrong PR" });
  assert.equal(stop.status, 200, JSON.stringify(stop.json));
  assert.equal(stop.json.state, "stopped");
});

function transcript(calls: Array<{ name?: string; input: any }>): string {
  return calls.flatMap((c, i) => [
    JSON.stringify({ type: "assistant", timestamp: new Date(t0 + i * 1000).toISOString(), message: { content: [{ type: "tool_use", id: `tu_${i}`, name: c.name ?? "Bash", input: c.input }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "ok" }] } }),
  ]).join("\n");
}

test("save from session over HTTP: the draft lands in the terminal's own workspace, and never crosses into another", async () => {
  const term = sessions.create({ workspace_id: A.id, cwd: repoA.path, goal: "shipped #12", backend: "claude-code" } as any);
  const dir = path.join(A.config_dir, "projects", "-a-app");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${term.id}.jsonl`), transcript([
    { input: { command: `gh pr merge 12 --repo acme/app --squash --match-head-commit ${SHA}` } },
    { input: { command: 'mc outcome --shipped "merged #12"' } },
    { input: { command: "mc service deploy bot" } },
    { name: "mcp__slack__slack_send_message_draft", input: { channel_id: "C1", message: "It is live." } },
  ]));
  const saved = await call("POST", "/playbooks", { ...asA, "x-mc-session": term.id }, { name: "from-term", from_session: term.id.slice(0, 8) });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.source, "session");
  assert.equal(saved.json.drafted_from, term.id);
  assert.equal(saved.json.reviewed, false, "a draft waits for the operator's review");
  assert.equal(saved.json.text, "[merge] gh pr merge {{pr}} --squash --match-head-commit {{sha}}\n[deploy] mc service deploy bot\nmessage slack C1: It is live.", "every gate is shown, the recognised ones too");
  assert.equal((await call("POST", "/playbooks", asA, { name: "from-term", from_session: term.id })).status, 409, "an existing playbook is not overwritten without replace");

  const steal = await call("POST", "/playbooks", asB, { name: "steal", from_session: term.id });
  assert.equal(steal.status, 404, JSON.stringify(steal.json));
  const stealNamed = await call("POST", "/playbooks", admin, { workspace: B.slug, name: "steal", from_session: term.id });
  assert.equal(stealNamed.status, 404, "not even the operator drafts one workspace's playbook from another's terminal");
  // The operator, naming no workspace: the draft lands where the terminal is. A dry run saves nothing.
  const dry = await call("POST", "/playbooks", admin, { name: "op-draft", from_session: term.id, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.workspace_id, A.id);
  assert.deepEqual(dry.json.errors, []);
  assert.equal(playbooks.byName(A.id, "op-draft"), undefined);
  // Saved by his own hand it is reviewed; an agent's edit makes it a draft again.
  const byHand = await call("POST", "/playbooks", admin, { workspace: A.slug, name: "by-hand", text: "make release" });
  assert.equal(byHand.json.reviewed, true);
  assert.equal((await call("PATCH", `/playbooks/${byHand.json.id}`, asA, { text: "make release-2" })).json.reviewed, false);
});

test("the walls over HTTP: another workspace's PR, service or path is refused when saving or running", async () => {
  const pb = await call("POST", "/playbooks", asA, { name: `walls-${t0}`, text: CHAIN });
  assert.equal(pb.status, 201);
  const theirPr = await call("POST", `/playbooks/${pb.json.id}/runs`, asA, { pr: PR_B });
  assert.equal(theirPr.status, 403, JSON.stringify(theirPr.json));
  const svc = await call("POST", "/playbooks", asA, { name: "svc", text: "mc service deploy tps" });
  assert.equal(svc.status, 400);
  assert.match(svc.json.error, /no service named 'tps'/);
  const cd = await call("POST", "/playbooks", asA, { name: "cd", text: `cd ${repoB.path} && make` });
  assert.equal(cd.status, 400);
  assert.ok(svc.json.errors.length && cd.json.errors.some((e: string) => /outside this workspace's repos/.test(e)), JSON.stringify(cd.json));
  assert.equal(playbooks.byName(A.id, "svc"), undefined);
});
