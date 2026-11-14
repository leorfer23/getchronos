/**
 * The two places the ledger meets `mc` (scripts/mc): the draft hook computes the same target hash the
 * daemon's draftHash does (two implementations of one formula — this keeps them in step), and
 * `mc ledger` reads the routes it says it reads. mc runs against a stand-in API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftHash } from "./ledger-model.js";

const MC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mc");

async function withApi(reply: (method: string, url: string) => unknown, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const seen: Array<{ method: string; url: string; body: any }> = [];
  const srv = http.createServer((q, s) => {
    let raw = "";
    q.on("data", (c) => (raw += c));
    q.on("end", () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      seen.push({ method: q.method!, url: q.url!, body });
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(reply(q.method!, q.url!)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const api = `http://127.0.0.1:${(srv.address() as any).port}/api`;
    const child = spawn(process.execPath, [MC, ...args], {
      env: { ...process.env, MC_WORKSPACE: "", MC_SESSION: "", MC_LEAD: "", MC_WORKSPACE_TOKEN: "ws-token-for-test", ...opts.env, MC_API: api },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.stdin.end(opts.stdin ?? "");
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

test("mc hook: a Slack draft's target hash is the daemon's draftHash of the same words — the text never leaves", async () => {
  const stdin = JSON.stringify({
    hook_event_name: "PostToolUse", session_id: "sess-1", tool_name: "mcp__x__slack_send_message_draft",
    tool_input: { channel: "#Ops", message: "numbers are up 4%" },
  });
  const { seen } = await withApi(() => ({ ok: true }), ["hook", "claude"], { stdin, env: { MC_SESSION: "sess-1" } });
  const post = seen.find((r) => r.method === "POST" && r.url === "/api/sessions/sess-1/hook");
  assert.ok(post, JSON.stringify(seen));
  assert.equal(post.body.event, "draft");
  assert.deepEqual(post.body.target, { channel: "slack", to: "#Ops", hash: draftHash({ channel: "slack", to: "#Ops", text: "numbers are up 4%" }) });
  assert.ok(!JSON.stringify(post.body.target).includes("numbers are up 4%"), "the target carries a hash, not the words");
});

test("mc hook: an email draft hashes recipients, subject and body the same way", async () => {
  const stdin = JSON.stringify({
    hook_event_name: "PostToolUse", session_id: "sess-2", tool_name: "mcp__y__create_draft",
    tool_input: { to: ["Someone@Example.com", "other@example.com"], subject: " Weekly numbers ", body: "Up 4% on last week." },
  });
  const { seen } = await withApi(() => ({ ok: true }), ["hook", "claude"], { stdin, env: { MC_SESSION: "sess-2" } });
  const post = seen.find((r) => r.method === "POST" && r.url === "/api/sessions/sess-2/hook")!;
  assert.equal(post.body.target.channel, "email");
  assert.equal(post.body.target.hash, draftHash({ channel: "email", to: "Someone@Example.com, other@example.com", subject: "Weekly numbers", text: "Up 4% on last week." }));
});

test("mc ledger: list, mine, queue, show and text read the ledger's own routes", async () => {
  const row = { id: "abcdef12-0000", state: "needs_operator", kind: "pr", title: "fix the login redirect", state_line: "merge: PR #12", workspace: { slug: "atlas", name: "atlas" }, state_at: new Date().toISOString() };
  const reply = (_m: string, url: string) => {
    if (url.startsWith("/api/ledger/queue")) return { items: [{ item_id: "99887766-x", line: "Merge PR #12 for “fix the login redirect” — not bound yet" }], held: [] };
    if (url.startsWith("/api/ledger?format=text")) return { text: "LEDGER (1 open · 1 need you):" };
    if (url.startsWith("/api/ledger/")) return { ...row, via: "voice", surface: "desk", asked_at: row.state_at, words: "arreglá el login", work: { label: "a backend PR", done: "A PR open…" }, prereqs: [], terminals: [], result: [], deliverables: [], decisions: [], expected_checks: [{ name: "tests", status: "missing" }], children: [] };
    return [row];
  };
  const list = await withApi(reply, ["ledger", "--needs", "--since", "2h"]);
  assert.equal(list.code, 0, list.out);
  assert.equal(list.seen[0].url, "/api/ledger?needs=decision&since=2h");
  assert.match(list.out, /^abcdef12  needs you  \[pr\] fix the login redirect — merge: PR #12 · atlas · \d+m/m);
  const mine = await withApi(reply, ["ledger", "mine"], { env: { MC_SESSION: "sess-9" } });
  assert.equal(mine.seen[0].url, "/api/ledger?session=sess-9&state=all");
  const queue = await withApi(reply, ["ledger", "queue"]);
  assert.match(queue.out, /^1\. \[99887766\] Merge PR #12/m);
  const show = await withApi(reply, ["ledger", "abcdef12"]);
  assert.equal(show.seen[0].url, "/api/ledger/abcdef12");
  assert.match(show.out, /words: arreglá el login/);
  assert.match(show.out, /checks: tests missing/);
  const text = await withApi(reply, ["ledger", "text"]);
  assert.match(text.out, /^LEDGER \(1 open · 1 need you\):/m);
});

test("mc ledger show prints the verifier's checks, readiness and passes; verify re-runs with the operator's token", async () => {
  const at = new Date().toISOString();
  let posted = false;
  const detail = (verified: boolean) => ({
    id: "abcdef12-0000", state: "needs_operator", kind: "ui", title: "new settings page", state_line: "merge: PR #12", state_at: at, via: "voice", asked_at: at,
    words: "make settings readable on the phone", work: null, prereqs: [], terminals: [], result: [], deliverables: [], decisions: [], children: [],
    expected_checks: [{ name: "shots", status: "pass" }],
    checks: [
      { name: "tests", status: "pass", stale: true, target_hash: "a".repeat(40), ran_at: at, note: "test green at aaaaaaa", evidence: [] },
      { name: "shots", status: "pass", stale: false, target_hash: "b".repeat(40), ran_at: at, note: "1 pair", evidence: [{ ref: "/api/sessions/s/outcome/shot/b1.png", meta: { screen: "settings", viewport: "phone", side: "before" } }] },
      { name: "queries", status: "na", stale: false, target_hash: null, ran_at: at, note: "n/a: the answer states no figures", evidence: [] },
    ],
    readiness: [{ action: "merge", label: "PR #12", ready: false, line: "not checked yet: tests", gaps: [] }],
    verification: { rounds_told: 1, last: verified ? { id: "v2", status: "done", trigger: "manual", started_at: at, ready: false, reason: "tests missing", told: false } : { id: "v1", status: "done", trigger: "outcome", started_at: at, ready: false, reason: "x", told: true, round: 1 }, passes: [] },
  });
  const reply = (m: string, url: string) => {
    if (m === "POST" && url === "/api/ledger/abcdef12/verify") { posted = true; return { ok: true, started: true }; }
    return detail(posted);
  };
  const show = await withApi(reply, ["ledger", "show", "abcdef12"]);
  assert.match(show.out, /check runs:/);
  assert.match(show.out, /✓ tests pass \(STALE — ran on an older target\) @aaaaaaa/);
  assert.match(show.out, /before · settings · phone: \/api\/sessions\/s\/outcome\/shot\/b1\.png/);
  assert.match(show.out, /· queries na · .* — n\/a: the answer states no figures/, "a slot that does not apply is shown as such, with why");
  assert.match(show.out, /→ merge PR #12: not ready — not checked yet: tests/);
  assert.match(show.out, /verifier: last pass done \(outcome\).*rounds told 1\/2/);
  const v = await withApi(reply, ["ledger", "verify", "abcdef12"], { env: { CHRONOS_ADMIN_TOKEN: "admin-for-test" } });
  assert.equal(v.code, 0, v.out);
  assert.ok(posted);
  assert.match(v.out, /⛔ not ready — tests missing/);
});
