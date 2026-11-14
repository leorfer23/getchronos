/**
 * Where the red-team trial meets `mc` (scripts/mc): `mc outcome` carries the hypotheses and the answers to
 * the red team, and `mc trial report` reads the trial's route and prints on vs off. mc runs against a
 * stand-in API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { armStats } from "./red-team.js";

const MC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mc");

async function withApi(reply: (method: string, url: string, body: any) => unknown, args: string[], env: Record<string, string> = {}) {
  const seen: Array<{ method: string; url: string; body: any }> = [];
  const srv = http.createServer((q, s) => {
    let raw = "";
    q.on("data", (c) => (raw += c));
    q.on("end", () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      seen.push({ method: q.method!, url: q.url!, body });
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(reply(q.method!, q.url!, body)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const api = `http://127.0.0.1:${(srv.address() as any).port}/api`;
    const child = spawn(process.execPath, [MC, ...args], {
      env: { ...process.env, MC_WORKSPACE: "", MC_SESSION: "", MC_LEAD: "", MC_WORKSPACE_TOKEN: "ws-token-for-test", ...env, MC_API: api },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

test("mc outcome sends the hypotheses and the answers, and says what it kept", async () => {
  const reply = (_m: string, url: string, body: any) => url.endsWith("/outcome")
    ? { summary: body.summary, changes: [], proof: [], shots: [], prs: [], ask: "review", shipped: [], earlier: 0,
      hypotheses: [{ claim: "old accounts", test: "split by age", result: "survived" }], findings: [{ id: "F1", resolution: "fixed", note: "re-ran" }] }
    : {};
  const { code, out, seen } = await withApi(reply, ["outcome", "412 accounts hold $3.2M", "--hypothesis", "old accounts | split by age | survived", "--finding", "F1=fixed: re-ran", "--finding", "looked at it"], { MC_SESSION: "sess-1" });
  assert.equal(code, 0, out);
  const post = seen.find((r) => r.method === "POST" && r.url === "/api/sessions/sess-1/outcome")!;
  assert.deepEqual(post.body.hypotheses, ["old accounts | split by age | survived"]);
  assert.deepEqual(post.body.findings, ["F1=fixed: re-ran", "looked at it"]);
  assert.match(out, /1 hypothesis · 1 red-team finding answered/);
  assert.match(out, /1 --finding value was not "F1=fixed: <what changed>" or "F1=holds-not: <why it does not hold>" and was left out/);
});

test("mc trial report reads the trial's route for one workspace and prints on vs off", async () => {
  const row = (over: object) => ({ arm: "on", protocol: true, hypotheses: 2, rounds: 1, rejections: 0, aspects: { red_team: 1 }, red_team: "ran", findings: 2, answered: 2, changed: 1, operator_turns: 0, started_at: "2026-11-10T10:00:00.000Z", first_handoff_at: "2026-11-10T10:40:00.000Z", ready_at: "2026-11-10T11:00:00.000Z", ...over });
  const on = armStats([row({}), row({ operator_turns: 1, ready_at: "2026-11-10T12:00:00.000Z" }), row({ hypotheses: 0, red_team: null, findings: 0, answered: 0, changed: 0, aspects: {}, rounds: 0 })] as any);
  const off = armStats([row({ arm: "off", protocol: false, hypotheses: 0, red_team: null, findings: 0, answered: 0, changed: 0, aspects: { matches_request: 1 }, rejections: 1, operator_turns: 3, ready_at: null })] as any);
  const body = { trial: "red_team", days: 7, since: "x", workspaces: [{ workspace: { id: "w1", slug: "lab", name: "Lab" }, trial_on: true, verifier_on: true, arms: { on, off } }] };
  const { code, out, seen } = await withApi(() => body, ["trial", "report", "red-team", "--ws", "lab", "--days", "7"]);
  assert.equal(code, 0, out);
  assert.equal(seen[0].url, "/api/trials/red-team/report?workspace=lab&days=7");
  assert.match(out, /^red-team trial · Lab · now ON · last 7 days/);
  assert.match(out, /analyses handed off\s+3\s+1/);
  assert.match(out, /with a hypotheses table\s+2 of 3\s+0 of 1/);
  assert.match(out, /sent back for its own checks\s+0 of 3\s+1 of 1/);
  assert.match(out, /what was sent back, on: {2}red_team 2/);
  assert.match(out, /what was sent back, off: matches_request 1/);
  assert.match(out, /red team: ran on 2 · 4 findings · 2 led to a change · 2 did not hold · 0 unanswered/);
  assert.match(out, /operator follow-ups per analysis\s+0\.3\s+3\.0/);
  assert.match(out, /ready for him\s+3 of 3\s+0 of 1/);
  assert.match(out, /time to ready \(median\)\s+60m\s+—/);
  assert.match(out, /too few to say yet/, "one analysis in the off arm is not a comparison");
  const json = await withApi(() => body, ["trial", "report", "--json"]);
  assert.deepEqual(JSON.parse(json.out), body);
  assert.equal(json.seen[0].url, "/api/trials/red-team/report", "a terminal's own workspace when no --ws");
  const none = await withApi(() => ({ trial: "red_team", days: 30, since: "x", workspaces: [] }), ["trial", "report", "red-team"]);
  assert.match(none.out, /nothing to compare yet/);
});
