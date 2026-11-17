/**
 * `mc limits` (src/limit-postmortem-run.ts) against a stand-in API: the list, one report, and an
 * on-demand read with its flags passed through as query parameters.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mc");
const seen = [];
const report = {
  key: ".claude-acme|5h|2026-11-17T17:00:00.000Z", profile: ".claude-acme", window: "5h", resets_at: "2026-11-17T17:00:00.000Z",
  summary: { total: 42.4, tops: "Desk · operator 60%, Job · monitor (cron) 20%", lever: "Hold background jobs once the window passes 80% (≈9%)" },
  terminal: { at: "2026-11-17T17:01:00.000Z", session_id: "abcdef1234567890", skipped: null, error: null },
  markdown: "# Where the 5-hour window went — acme\n",
};
const server = http.createServer((req, res) => {
  seen.push(req.url);
  const send = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url.startsWith("/api/limits/postmortems")) return send({ reports: [report] });
  if (req.url.startsWith("/api/limits/postmortem?")) return send({ report: {}, markdown: "# Where the weekly window went — acme\n" });
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const API = `http://127.0.0.1:${server.address().port}/api`;

function run(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [mc, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MC_API: API, MC_WORKSPACE: "", MC_SESSION: "" } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("mc limits lists the stored post-mortems, one line each, with the terminal it opened", async () => {
  const r = await run("limits");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ 1  2026-11-17 17:00Z  \.claude-acme\s+5h\s+\$42 · Desk · operator 60%.* · terminal abcdef12$/m);
});

test("mc limits show prints the report; mc limits postmortem passes its flags and writes nothing", async () => {
  const s = await run("limits", "show");
  assert.match(s.stdout, /# Where the 5-hour window went — acme/);
  assert.ok(seen.some((u) => u === "/api/limits/postmortems?full=1"));
  const p = await run("limits", "postmortem", "--profile", "acme", "--window", "week", "--at", "2026-11-17T12:00:00Z");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /# Where the weekly window went — acme/);
  assert.ok(seen.some((u) => u === "/api/limits/postmortem?profile=acme&window=week&at=2026-11-17T12%3A00%3A00Z"), seen.join("\n"));
});
