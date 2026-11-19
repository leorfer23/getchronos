/**
 * `mc robert followup` — Robert's deadline on himself (src/robert-followups.ts). The CLI only carries
 * the words to the daemon, with his credential; every rule (5m..7d, ≤400 chars, 20 per workspace) is
 * the daemon's. Driven against a stand-in API that records what it was sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
const ROW = { id: "abcdef0123456789", workspace_id: "w1", due_at: new Date(Date.now() + 2 * 3600_000).toISOString(), note: "check CI on PR 12", subject: null, status: "pending", fired_at: null };

async function mcAgainst(reply, args) {
  const seen = [];
  const srv = http.createServer((q, s) => {
    let body = "";
    q.on("data", (b) => (body += b));
    q.on("end", () => {
      seen.push({ line: `${q.method} ${q.url}`, admin: q.headers["x-mc-admin"] ?? null, body: body ? JSON.parse(body) : null });
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(reply(q.method, q.url)));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${srv.address().port}/api`;
    const env = { ...process.env, MC_API: api, MC_WORKSPACE: "", MC_SESSION: "", MC_LEAD: "", MC_WORKSPACE_TOKEN: "", CHRONOS_ADMIN_TOKEN: "", CHRONOS_ADMIN: "robert-cred" };
    const child = spawn(process.execPath, [mc, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const code = await new Promise((r) => child.on("close", r));
    return { code, out, seen };
  } finally {
    srv.close();
  }
}

test("mc robert followup sets one with his credential, the time in his words and the subject", async () => {
  const r = await mcAgainst(() => ROW, ["robert", "followup", "+2h", "check CI on PR 12", "--subject", "https://github.com/acme/app/pull/12"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].line, "POST /api/robert/followups");
  assert.equal(r.seen[0].admin, "robert-cred");
  assert.deepEqual(r.seen[0].body, { when: "+2h", note: "check CI on PR 12", subject: "https://github.com/acme/app/pull/12" });
  assert.match(r.out, /abcdef01 follow-up set — due in 2h/);
});

test("mc robert followups lists; cancel names the id", async () => {
  const list = await mcAgainst(() => [ROW], ["robert", "followups"]);
  assert.equal(list.code, 0, list.out);
  assert.equal(list.seen[0].line, "GET /api/robert/followups");
  assert.match(list.out, /⏳ abcdef01 due in 2h · check CI on PR 12/);

  const gone = await mcAgainst(() => ({ ...ROW, status: "cancelled" }), ["robert", "followup", "cancel", "abcdef01"]);
  assert.equal(gone.code, 0, gone.out);
  assert.equal(gone.seen[0].line, "POST /api/robert/followups/abcdef01/cancel");
  assert.match(gone.out, /cancelled abcdef01/);
});

test("mc robert followup with no note says how to use it and sends nothing", async () => {
  const r = await mcAgainst(() => ROW, ["robert", "followup", "+2h"]);
  assert.equal(r.code, 1);
  assert.equal(r.seen.length, 0);
  assert.match(r.out, /mc robert followup "<when>" "<note/);
});
