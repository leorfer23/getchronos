/**
 * The red-team trial's two doors on the running API (src/api.ts): a hand-off filed through POST
 * /sessions/:id/outcome is counted (and carries each finding beside its answer), and GET
 * /trials/:trial/report answers one workspace's caller with that workspace only.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { sessions, workspaces } = await import("./store.js");
const { requests } = await import("./store/requests.js");
const { trials } = await import("./store/trials.js");
const L = await import("./ledger.js");
const { writeSetting, _resetSettingsCache } = await import("./settings.js");
const { redTeamCheck } = await import("./red-team.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-redteam-"));
const A = workspaces.create({ slug: `rt-a-${Date.now()}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `rt-b-${Date.now()}`, name: "Initech", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
writeSetting("trial.red_team", true, A.id);
_resetSettingsCache();
const json = { "content-type": "application/json" };
const admin = { ...json, "x-mc-admin": CONFIG.adminToken };
const asA = { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token };
const asB = { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token };

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let out: any = null;
  try { out = await r.json(); } catch {}
  return { status: r.status, json: out };
}
function analysis(ws: { id: string }) {
  const s = sessions.create({ workspace_id: ws.id, cwd: tmp, goal: "how many accounts hold a balance", goal_kind: "investigation", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  return s;
}

test("a hand-off from an analysis terminal is counted, in its own workspace's arm, with each finding beside its answer", async () => {
  const s = analysis(A);
  const r = requests.get(requests.primaryAt(s.id)!.request_id)!;
  // The red team already ran on this request and found one thing.
  const { check } = redTeamCheck([{ id: "F1", claim: "amounts look like cents", why: "", check: "compare one invoice" }], { ref: "run:x", label: "claude-code sonnet" }, "x");
  requests.addCheck({ request_id: r.id, name: "red_team", status: check.status, note: check.note, evidence: check.evidence, ran_by: "verifier" });
  const filed = await call("POST", `/sessions/${s.id}/outcome`, asA, {
    summary: "412 accounts hold $3.2M", ask: "review",
    hypotheses: ["old accounts | split by age | survived"], findings: ["F1=holds-not: dollars — one row matches its invoice", "not an answer"],
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.json));
  assert.deepEqual(filed.json.hypotheses, [{ claim: "old accounts", test: "split by age", result: "survived" }]);
  assert.deepEqual(filed.json.findings, [{ id: "F1", resolution: "holds-not", note: "dollars — one row matches its invoice", claim: "amounts look like cents" }]);
  const row = trials.find("red_team", s.id, r.id)!;
  assert.equal(row.workspace_id, A.id);
  assert.equal(row.arm, "on");
  assert.equal(row.hypotheses, 1);
  // Another workspace cannot file it: the same 404 a missing terminal gets, and nothing is counted.
  const s2 = analysis(A);
  assert.equal((await call("POST", `/sessions/${s2.id}/outcome`, asB, { summary: "412", ask: "review" })).status, 404);
  assert.equal(trials.hasSession(s2.id), false);
});

test("the report answers each workspace with its own block; naming another is a 404; the operator reads any", async () => {
  const sb = analysis(B);
  const fb = await call("POST", `/sessions/${sb.id}/outcome`, asB, { summary: "120 of 52K accounts (0.2%)", ask: "review" });
  assert.equal(fb.status, 201);
  const a = await call("GET", "/trials/red-team/report", asA);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual(a.json.workspaces.map((w: any) => w.workspace.id), [A.id]);
  assert.equal(a.json.workspaces[0].trial_on, true);
  assert.equal(a.json.workspaces[0].arms.on.analyses, 1);
  assert.equal(a.json.workspaces[0].arms.off.analyses, 0, "B's analysis is not in A's report");
  const b = await call("GET", "/trials/red_team/report", asB);
  assert.deepEqual(b.json.workspaces.map((w: any) => [w.workspace.id, w.trial_on, w.arms.off.analyses, w.arms.on.analyses]), [[B.id, false, 1, 0]]);
  assert.equal((await call("GET", `/trials/red-team/report?workspace=${B.slug}`, asA)).status, 404);
  assert.equal((await call("GET", "/trials/red-team/report?workspace=nope", asA)).status, 404);
  assert.equal((await call("GET", "/trials/red-team/report", json)).status, 401, "no token, no read");
  const all = await call("GET", "/trials/red-team/report", admin);
  assert.ok([A.id, B.id].every((id) => all.json.workspaces.some((w: any) => w.workspace.id === id)));
  assert.equal((await call("GET", `/trials/red-team/report?workspace=${B.slug}`, admin)).json.workspaces[0].workspace.id, B.id);
});
