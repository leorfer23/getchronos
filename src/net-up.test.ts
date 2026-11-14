/**
 * The network look (src/net-up.ts) and the nudge for a terminal whose turn died on the network
 * (src/net-nudge.ts). The look is swapped for a switch; the one real connect is to a loopback port.
 */
import { test, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, sessions, workspaces } from "./store.js";
import { applyHook } from "./term-status.js";
import { looksOffline, networkUp, reach, setNetProbe, waitForNetwork } from "./net-up.js";
import { MAX_PER_TERMINAL, NETWORK_NUDGE, networkDeaths, nudgeNetworkDeaths, resetNetNudge } from "./net-nudge.js";

const MC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mc");
// What Claude Code showed when the Mac woke into no network (2026-11-12), as `mc hook` relays it.
const DIED = "server_error: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

let ws: { id: string };
beforeEach(() => {
  db.exec("DELETE FROM session_status; DELETE FROM sessions;");
  ws = workspaces.create({ slug: "nu-" + Math.random().toString(36).slice(2, 8), name: "Acme", config_dir: "/tmp/mc-test/nu" } as any);
  resetNetNudge();
  setNetProbe(null);
});
after(() => { setNetProbe(null); mock.timers.reset(); });

const flush = () => new Promise((r) => setImmediate(r));

// ── the look ─────────────────────────────────────────────────────────────────────────────────

test("reach: a host that takes the connection is up, and so is one that refuses it (a host answered)", async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  assert.equal(await reach("127.0.0.1", port), true);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await reach("127.0.0.1", port), true, "refused = the network is there");
});

test("networkUp looks once per 15s, however many ask", async () => {
  let looks = 0;
  setNetProbe(async () => { looks++; return false; });
  assert.deepEqual(await Promise.all([networkUp(), networkUp(), networkUp()]), [false, false, false]);
  assert.equal(await networkUp(), false);
  assert.equal(looks, 1);
});

test("waitForNetwork: at once when up; otherwise a look a minute until it is; false after maxMs", async () => {
  setNetProbe(async () => true);
  assert.equal(await waitForNetwork(), true);

  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-12T04:01:00Z") });
  try {
    let looks = 0;
    setNetProbe(async () => ++looks >= 4);
    let done: boolean | null = null;
    void waitForNetwork({ label: "test" }).then((v) => (done = v));
    for (let i = 0; i < 5 && done === null; i++) { await flush(); mock.timers.tick(60_000); await flush(); }
    assert.equal(done, true);
    assert.equal(looks, 4);

    setNetProbe(async () => false);
    let gaveUp: boolean | null = null;
    void waitForNetwork({ maxMs: 3 * 60_000 }).then((v) => (gaveUp = v));
    for (let i = 0; i < 6 && gaveUp === null; i++) { await flush(); mock.timers.tick(60_000); await flush(); }
    assert.equal(gaveUp, false);
  } finally {
    mock.timers.reset();
  }
});

test("looksOffline: the CLI's and the tools' wording for no network — not every error", () => {
  for (const s of [DIED, "server_error: API Error: Your computer went to sleep mid-response. The response above may be incomplete.",
    "error connecting to api.github.com", "curl: (6) Could not resolve host: api.example.com", "getaddrinfo EAI_AGAIN api.example.com", "TypeError: fetch failed"])
    assert.equal(looksOffline(s), true, s);
  for (const s of ["server_error", "rate_limit", "authentication_failed", "invalid_request: prompt is too long", "error", null])
    assert.equal(looksOffline(s), false, String(s));
});

// ── the nudge ────────────────────────────────────────────────────────────────────────────────

const T = Date.parse("2026-11-12T13:00:00Z");
function liveTerm(extra: Record<string, unknown> = {}) {
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code", goal: "fix the nightly job" } as any);
  db.prepare("UPDATE sessions SET status = 'live' WHERE id = ?").run(s.id);
  if (extra.host_id) db.prepare("UPDATE sessions SET host_id = ? WHERE id = ?").run(extra.host_id, s.id);
  return s.id;
}
const stub = () => {
  const sent: Array<{ id: string; text: string; by: string }> = [];
  return { sent, send: ((id: string, req: any, by: string) => { sent.push({ id, text: req.text, by }); return null; }) as any, phase: () => "your_turn" };
};

test("a terminal whose turn died on the network is nudged once the network is back — once, with the same line", async () => {
  const id = liveTerm();
  applyHook(id, { event: "prompt" }, T - 120_000);
  applyHook(id, { event: "stop", error: DIED }, T - 60_000);
  const d = stub();
  assert.deepEqual(await nudgeNetworkDeaths(T, { ...d, netUp: async () => false }), [], "still offline: nothing typed");
  assert.deepEqual(await nudgeNetworkDeaths(T, { ...d, netUp: async () => true }), [id]);
  assert.deepEqual(d.sent, [{ id, text: NETWORK_NUDGE, by: "net-nudge" }]);
  assert.match(NETWORK_NUDGE, /never do it twice/);
  assert.deepEqual(await nudgeNetworkDeaths(T + 60_000, { ...d, netUp: async () => true }), [], "one nudge per dead turn");
});

test("not nudged: a turn that failed for another reason, a terminal asking, one already working, one too fresh, another computer's", async () => {
  const other = liveTerm();
  applyHook(other, { event: "stop", error: "rate_limit: API Error: Rate limit reached" }, T - 60_000);
  const asking = liveTerm();
  applyHook(asking, { event: "stop", error: DIED }, T - 60_000);
  db.prepare("UPDATE session_status SET data = json_set(data, '$.asking', json('{\"question\":\"which one?\",\"options\":[],\"at\":1}')) WHERE session_id = ?").run(asking);
  const working = liveTerm();
  applyHook(working, { event: "stop", error: DIED }, T - 120_000);
  applyHook(working, { event: "prompt" }, T - 60_000); // the operator already typed "the network is back"
  const fresh = liveTerm();
  applyHook(fresh, { event: "stop", error: DIED }, T - 5_000);
  const remote = liveTerm({ host_id: "h_other" });
  applyHook(remote, { event: "stop", error: DIED }, T - 60_000);
  const ended = liveTerm();
  applyHook(ended, { event: "stop", error: DIED }, T - 60_000);
  db.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").run(ended);
  assert.deepEqual(networkDeaths(T), []);
  const d = stub();
  assert.deepEqual(await nudgeNetworkDeaths(T, { ...d, netUp: async () => true }), []);
  assert.deepEqual(d.sent, []);
});

test("a flapping network cannot loop a terminal: at most MAX_PER_TERMINAL nudges", async () => {
  const id = liveTerm();
  const d = stub();
  for (let i = 0; i < MAX_PER_TERMINAL + 2; i++) {
    const at = T + i * 600_000;
    applyHook(id, { event: "prompt" }, at - 120_000);
    applyHook(id, { event: "stop", error: DIED }, at - 60_000);
    await nudgeNetworkDeaths(at, { ...d, netUp: async () => true });
  }
  assert.equal(d.sent.length, MAX_PER_TERMINAL);
});

test("mc hook relays StopFailure with the text the CLI showed, so the card and the nudge can read it", async () => {
  const seen: any[] = [];
  const srv = http.createServer((q, s) => {
    let raw = "";
    q.on("data", (c) => (raw += c));
    q.on("end", () => { try { seen.push({ url: q.url, body: JSON.parse(raw || "null") }); } catch {} s.setHeader("content-type", "application/json"); s.end("{}"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const child = spawn(process.execPath, [MC, "hook", "claude"], {
      env: { ...process.env, MC_WORKSPACE: "", MC_LEAD: "", MC_WORKSPACE_TOKEN: "ws-token-for-test", MC_SESSION: "sess-net1", MC_API: `http://127.0.0.1:${(srv.address() as any).port}/api` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify({
      hook_event_name: "StopFailure", session_id: "sess-net1", error: "server_error",
      last_assistant_message: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    }));
    await new Promise((r) => child.on("close", r));
  } finally {
    srv.close();
  }
  const post = seen.find((r) => r.url === "/api/sessions/sess-net1/hook");
  assert.ok(post, JSON.stringify(seen));
  assert.equal(post.body.event, "stop");
  assert.equal(post.body.error, DIED);
  assert.equal(looksOffline(post.body.error), true);
});
