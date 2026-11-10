/**
 * Who can make the executor act, over the real API (startServer): only the operator's own hand. Every
 * credential an agent process can hold — a project Robert's (rw/ro, either lane), the fleet-wide
 * Robert's (rw/ro, either lane), a workspace token (what every terminal's env carries), a Lead's token,
 * the admin token sent the way daemon code sends it for a model's proposal, or nothing at all — is
 * refused on the one route that creates and consumes an approval, and none of them reads the log.
 * Then the roads to the operator's token that a Robert credential used to have: settings that switch
 * the executor or loosen a wall, a workspace's sandbox, a repo's unsandboxed commands, services,
 * self-deploy — all refused — while the fleet-wide Robert keeps reading every workspace's ledger.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertToken, fleetScopeOf, robertScopeOf, withoutOperatorToken } = await import("./authz.js");
const { db, kv, repos, sessions, workspaces } = await import("./store.js");
const { requests } = await import("./store/requests.js");
const L = await import("./ledger.js");
const X = await import("./executor.js");
const { writeSetting, setting, _resetSettingsCache } = await import("./settings.js");
const { setRemoteReader } = await import("./pr-ownership.js");
const { WORK } = await import("./ledger-model.js");
const { mcEnv } = await import("./terminal.js");
const { childEnv } = await import("./child-env.js");
const { robertCredential } = await import("./telegram/agent.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); X.setExecutorGh(null); X.setExecutorTell(null); });

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: "finished its turn" }));
L.setLedgerProgressProvider(() => null);
X.setExecutorTell(() => {});

const SHA = "d".repeat(40);
const PR = "https://github.com/atlas-co/svc/pull/7";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-exa-"));
const A = workspaces.create({ slug: `exa-a-${Date.now()}`, name: "Atlas", config_dir: path.join(tmp, "cfg-a"), default_dir: path.join(tmp, "a") } as any);
const B = workspaces.create({ slug: `exa-b-${Date.now()}`, name: "Cedar", config_dir: path.join(tmp, "cfg-b"), default_dir: path.join(tmp, "b") } as any);
const repoA = repos.create({ workspace_id: A.id, name: "svc", path: path.join(tmp, "svc"), git_remote: "https://github.com/atlas-co/svc.git" } as any);

let merges = 0;
let ghCalls = 0;
function fakeGh() {
  X.setExecutorGh(async (args) => {
    ghCalls++;
    if (args[1] === "merge") { merges++; return ""; }
    if (args.includes("state,isDraft,headRefOid,url")) return JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: SHA, url: args[2] });
    return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "e".repeat(40) } });
  });
}

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

type Fx = { r: any; item: any; d: any; s: any };
let fx: Fx;
function build(): Fx {
  const s = sessions.create({ workspace_id: A.id, cwd: "/tmp", goal: "fix the retry loop", goal_kind: "pr", created_by: "operator" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  sessions.setOutcome(s.id, { summary: "fixed", changes: [], proof: [], prs: [PR], shots: [], ask: "merge", shipped: [], at: new Date(Date.now() + 1000).toISOString() } as any);
  L.onLedgerEvent({ topic: "session.updated", session_id: s.id });
  const r = requests.get(requests.primaryAt(s.id)!.request_id)!;
  const d = requests.deliverables(r.id).find((x) => x.kind === "pr")!;
  requests.bindTarget(d.id, SHA);
  for (const e of WORK.pr.evidence.filter((x) => x.required)) {
    requests.addCheck({ request_id: r.id, deliverable_id: d.id, name: e.name, status: "pass", target_hash: SHA, ran_by: "verifier" } as any);
  }
  return { r, item: requests.items(r.id).find((i) => i.action === "merge")!, d, s };
}

beforeEach(() => {
  db.exec("DELETE FROM executor_log; DELETE FROM executor_approvals; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests;");
  for (const k of ["executor.enabled", "executor.no_checks", "executor.merge_pr"]) writeSetting(k, null);
  _resetSettingsCache();
  writeSetting("executor.enabled", true);
  setRemoteReader(() => null);
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  merges = 0;
  ghCalls = 0;
  fakeGh();
  fx = build();
});

const HAND = { "x-mc-operator": "1" };
const lead = sessions.create({ workspace_id: A.id, role: "lead", cwd: "/tmp" } as any);
const leadTok = sessions.leadToken(lead.id)!;
/** Every credential an agent process can hold, each also forging the operator's `x-mc-operator: 1`. */
const AGENT_CREDENTIALS: Array<[string, Record<string, string>]> = [
  ["project Robert rw (operator lane)", { "x-mc-admin": robertToken(A.id, "rw", "operator"), ...HAND }],
  ["project Robert rw (wake lane)", { "x-mc-admin": robertToken(A.id, "rw", "wake"), ...HAND }],
  ["project Robert ro (Telegram)", { "x-mc-admin": robertToken(A.id, "ro"), ...HAND }],
  ["another project's Robert rw", { "x-mc-admin": robertToken(B.id, "rw"), ...HAND }],
  ["fleet-wide Robert rw (operator lane)", { "x-mc-admin": robertToken(null, "rw", "operator"), ...HAND }],
  ["fleet-wide Robert rw (wake lane)", { "x-mc-admin": robertToken(null, "rw", "wake"), ...HAND }],
  ["fleet-wide Robert ro", { "x-mc-admin": robertToken(null, "ro"), ...HAND }],
  ["the workspace token (every terminal's MC_WORKSPACE_TOKEN)", { "x-mc-workspace-token": A.token!, ...HAND }],
  ["a Lead's token", { "x-mc-lead": leadTok, ...HAND }],
  ["the workspace token with a Robert's token beside it", { "x-mc-workspace-token": A.token!, "x-mc-admin": robertToken(A.id, "rw"), ...HAND }],
  ["the admin token without the operator's hand (how daemon code fires a model's proposal)", { "x-mc-admin": CONFIG.adminToken }],
  ["the admin token from inside a terminal (its workspace token rides along)", { "x-mc-admin": CONFIG.adminToken, "x-mc-workspace-token": A.token!, ...HAND }],
  ["the admin token naming an agent session", { "x-mc-admin": CONFIG.adminToken, "x-mc-session": fx?.s?.id ?? "s", ...HAND }],
  ["the admin token naming a Lead", { "x-mc-admin": CONFIG.adminToken, "x-mc-lead": leadTok, ...HAND }],
  ["no token at all", { ...HAND }],
  ["a made-up derived-looking token", { "x-mc-admin": "f".repeat(64), ...HAND }],
];

test("no credential an agent process can hold creates an approval: refused, nothing recorded, nothing run", async () => {
  for (const [who, headers] of AGENT_CREDENTIALS) {
    const res = await call("POST", `/ledger/${fx.r.id}/decision`, headers, { item: fx.item.id, decision: "yes", target_hash: SHA, words: "dale", by: "phone" });
    assert.ok(res.status === 403 || res.status === 401, `${who}: ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(requests.item(fx.item.id)!.status, "open", `${who}: his yes was not recorded`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM executor_approvals").get()!.n, 0);
  assert.equal(ghCalls, 0, "GitHub was never even asked");
});

test("the operator's own hand: recorded and carried out once — and no credential consumes it again, his own included", async () => {
  const res = await call("POST", `/ledger/${fx.r.id}/decision`, { "x-mc-admin": CONFIG.adminToken, ...HAND }, { item: fx.item.id, decision: "yes", target_hash: SHA, words: "dale, mergealo", by: "phone-voice:strong" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.executed, true);
  assert.equal(res.json.execution.status, "done");
  assert.deepEqual(res.json.execution.say, { es: "Mergeado.", en: "Merged." });
  assert.equal(merges, 1);
  // Consume again: there is no route that takes an approval, and the item is already decided.
  for (const [who, headers] of [...AGENT_CREDENTIALS, ["the operator again", { "x-mc-admin": CONFIG.adminToken, ...HAND }] as [string, Record<string, string>]]) {
    const again = await call("POST", `/ledger/${fx.r.id}/decision`, headers, { item: fx.item.id, decision: "yes", target_hash: SHA });
    assert.ok([401, 403, 404, 409].includes(again.status), `${who}: ${again.status}`);
  }
  const approval = db.prepare("SELECT id FROM executor_approvals").get() as { id: string };
  for (const p of [`/executor/approvals/${approval.id}`, `/executor/approvals/${approval.id}/run`, `/executor/run`]) {
    const r = await call("POST", p, { "x-mc-admin": CONFIG.adminToken, ...HAND }, {});
    assert.equal(r.status, 404, `${p} must not exist`);
  }
  assert.equal(merges, 1, "carried out exactly once");
});

test("with the executor off, the operator's yes is recorded exactly as before and says executed: false", async () => {
  writeSetting("executor.enabled", false);
  const res = await call("POST", `/ledger/${fx.r.id}/decision`, { "x-mc-admin": CONFIG.adminToken, ...HAND }, { item: fx.item.id, decision: "yes", target_hash: SHA, by: "phone" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.executed, false);
  assert.equal(res.json.executor, "off");
  assert.equal(res.json.item.status, "decided");
  assert.equal(ghCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM executor_approvals").get()!.n, 0);
});

test("the executor's log is the operator's alone", async () => {
  await call("POST", `/ledger/${fx.r.id}/decision`, { "x-mc-admin": CONFIG.adminToken, ...HAND }, { item: fx.item.id, decision: "yes", target_hash: SHA, words: "dale", by: "phone" });
  // (His own token with no agent header is simply him reading — the hand is for decisions, not reads.)
  for (const [who, headers] of AGENT_CREDENTIALS.filter(([, h]) => !(h["x-mc-admin"] === CONFIG.adminToken && Object.keys(h).length === 1))) {
    const r = await call("GET", "/executor/log", headers);
    assert.ok(r.status === 403 || r.status === 401, `${who}: ${r.status}`);
  }
  const mine = await call("GET", "/executor/log", { "x-mc-admin": CONFIG.adminToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.json[0].words, "dale");
  assert.equal(mine.json[0].approved_hash, SHA);
  assert.equal(mine.json[0].status, "done");
  // Status: the operator, or a Robert asking about his own workspace.
  assert.equal((await call("GET", "/executor/status", { "x-mc-admin": robertToken(A.id, "rw") })).status, 200);
  assert.equal((await call("GET", `/executor/status?workspace=${B.slug}`, { "x-mc-admin": robertToken(A.id, "rw") })).status, 404);
  assert.equal((await call("GET", "/executor/status", { "x-mc-workspace-token": A.token! })).status, 403);
});

// ── the credentials themselves ───────────────────────────────────────────────────────────────────

test("every Robert credential is derived, lane-tagged and told apart — none is the operator's token, none reaches a spawn env", () => {
  const all = [robertToken(A.id, "rw", "operator"), robertToken(A.id, "rw", "wake"), robertToken(A.id, "ro"), robertToken(null, "rw", "operator"), robertToken(null, "rw", "wake"), robertToken(null, "ro")];
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes(CONFIG.adminToken));
  assert.deepEqual(robertScopeOf(robertToken(A.id, "rw", "wake")), { ws: A.id, role: "rw", lane: "wake" });
  assert.deepEqual(fleetScopeOf(robertToken(null, "rw", "operator")), { ws: null, role: "rw", lane: "operator", fleet: true });
  assert.equal(robertScopeOf(robertToken(null, "rw")), null, "the fleet's credential names no workspace");
  assert.equal(fleetScopeOf(robertToken(A.id, "rw")), null);
  assert.equal(fleetScopeOf(CONFIG.adminToken), null);
  // What the processes are handed: the fleet-wide Robert no longer carries the admin token.
  assert.notEqual(robertCredential(null), CONFIG.adminToken);
  assert.equal(robertCredential(null, "rw", "wake"), robertToken(null, "rw", "wake"));
  assert.equal(robertCredential(A.id), robertToken(A.id, "rw", "operator"));
  // A terminal's env (what `mc` and the agent can read): its workspace token, never the admin token.
  const term = { ...childEnv(A as any), ...mcEnv(A.id, repoA.id) };
  assert.ok(!Object.values(term).includes(CONFIG.adminToken));
  // Whatever the daemon's own env carries, a spawn env drops it.
  assert.deepEqual(withoutOperatorToken({ CHRONOS_ADMIN_TOKEN: "x", SOMETHING: CONFIG.adminToken, PATH: "/bin" }), { PATH: "/bin" });
});

// ── the roads to the operator's token a Robert credential used to have ──────────────────────────

test("the fleet-wide Robert reads every workspace's ledger, and writes none of it", async () => {
  const fleet = { "x-mc-admin": robertToken(null, "rw") };
  const other = requests.create({ workspace_id: B.id, words: "numbers for the week", via: "typed" });
  const rows = await call("GET", "/ledger?state=all", fleet);
  assert.equal(rows.status, 200);
  const wsSeen = new Set(rows.json.map((r: any) => r.workspace_id));
  assert.ok(wsSeen.has(A.id) && wsSeen.has(B.id), "both workspaces");
  assert.equal((await call("GET", `/ledger/${other.id}`, fleet)).status, 200);
  assert.equal((await call("GET", "/ledger/queue", fleet)).status, 200);
  assert.equal((await call("POST", `/ledger/${fx.r.id}/close`, { ...fleet, ...HAND }, { words: "done" })).status, 403);
  // A project's Robert still reads only his own.
  assert.equal((await call("GET", `/ledger/${other.id}`, { "x-mc-admin": robertToken(A.id, "rw") })).status, 404);
});

test("no Robert credential switches the executor, lets unchecked merges through, or loosens a wall through settings", async () => {
  for (const tok of [robertToken(null, "rw"), robertToken(null, "rw", "wake")]) {
    const h = { "x-mc-admin": tok };
    for (const body of [
      { key: "executor.enabled", value: false },
      { key: "executor.no_checks", value: "allow" },
      { key: "executor.ttl_minutes", value: 30 },
      { key: "ws.sandbox_mode", value: "off", workspace: A.slug },
      { key: "ws.auto_merge_prs", value: true, workspace: A.slug },
      { key: "ws.merge_gate", value: false, workspace: A.slug },
    ]) {
      const r = await call("PUT", "/settings", h, body);
      assert.equal(r.status, 403, `${body.key}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, /operator-only/);
    }
  }
  assert.equal(setting("executor.enabled"), true);
  assert.equal(setting("executor.no_checks"), "refuse");
  // An ordinary knob is still his to turn on the operator's word.
  const ok = await call("PUT", "/settings", { "x-mc-admin": robertToken(null, "rw") }, { key: "inbox.triage", value: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  writeSetting("inbox.triage", null);
});

test("no Robert credential weakens a workspace's sandbox, re-grants secrets, or sets a command the daemon runs unsandboxed", async () => {
  for (const tok of [robertToken(A.id, "rw"), robertToken(null, "rw")]) {
    const h = { "x-mc-admin": tok };
    for (const body of [{ sandbox_mode: "off" }, { sandbox_allow: ["~/.ssh"] }, { secrets_file: "/tmp/x.env" }, { config_dir: path.join(tmp, "other") }, { auto_merge_prs: true }, { merge_gate: false }]) {
      const r = await call("PATCH", `/workspaces/${A.id}`, h, body);
      assert.equal(r.status, 403, `${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    for (const body of [{ gate_cmds: [{ name: "t", cmd: "cat ~/chronos/.admin-token" }] }, { verify_cmd: "true" }, { post_merge_cmd: "true" }]) {
      assert.equal((await call("PATCH", `/repos/${repoA.id}`, h, body)).status, 403, JSON.stringify(body));
    }
    // Tightening, and what his prompts document, still work.
    assert.equal((await call("PATCH", `/workspaces/${A.id}`, h, { sandbox_mode: "strict" })).status, 200);
    assert.equal((await call("PATCH", `/workspaces/${A.id}`, h, { auto_plan: false })).status, 200);
    workspaces.update(A.id, { sandbox_mode: "guard" } as any);
  }
  assert.equal(workspaces.get(A.id)!.sandbox_mode, "guard");
});

test("the fleet-wide Robert does not reach the operator-only set: services, self-deploy, review approve/merge, shared vars, triggers, his chat, the clipboard", async () => {
  const h = { "x-mc-admin": robertToken(null, "rw") };
  const refused: Array<[string, string, unknown]> = [
    ["POST", "/services", { workspace: A.slug, name: "x", command: "cat ~/chronos/.admin-token", cwd: tmp }],
    ["POST", "/self-deploy", {}],
    ["POST", "/reviews/00000000-0000-0000-0000-000000000000/merge", {}],
    ["POST", "/reviews/00000000-0000-0000-0000-000000000000/approve", {}],
    ["POST", `/workspaces/${A.id}/vars`, { name: "X", value: "y", hours: 1 }],
    ["POST", "/triggers", { job_id: "x" }],
    ["GET", "/clipboard", undefined],
    ["POST", "/agent", { text: "hola" }],         // his own chat surface — he does not talk to himself
  ];
  for (const [m, p, body] of refused) {
    const r = await call(m, p, h, body);
    assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  // But the broad surface he had with the operator's token stays his: he still reads the fleet and the
  // settings, and (coverage in robert-fleet.test.ts) files tickets, dispatches, drives and closes terminals.
  assert.equal((await call("GET", "/fleet", h)).status, 200);
  assert.equal((await call("GET", "/settings", h)).status, 200);
});
