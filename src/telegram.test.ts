import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSnippet, fmtElapsed, tickerText } from "./telegram/ticker.js";
import {
  scanProposal,
  isSafeProposal,
  stampTelegramAskAnswer,
  putProposal,
  takeProposal,
  dismissProposal,
  purgeExpiredProposals,
  proposalGoneMessage,
  resetPendingProposalsForTest,
  unloadPendingProposalsForTest,
  checkPlaceholders,
  applyBatchRefs,
  autoExecProposal,
  scanUiActions,
} from "./telegram/agent.js";
import { CONFIG } from "./config.js";
import { kv } from "./store.js";
import { routeText } from "./telegram.js";
import { execCommand } from "./telegram/active-exec.js";
import { shouldNotify } from "./telegram/push.js";
import { voiceGate } from "./telegram/voice.js";
import { tg, transportFailStreak } from "./telegram/api.js";

test("extractSnippet: joins assistant text blocks, collapses whitespace, caps at 150", () => {
  const ev = { type: "assistant", message: { content: [{ type: "text", text: "hello\n  world" }, { type: "tool_use", name: "Bash" }] } };
  assert.equal(extractSnippet(ev), "hello world");
  const long = { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(300) }] } };
  assert.equal(extractSnippet(long)!.length, 150);
});

test("extractSnippet: null for non-assistant / no text", () => {
  assert.equal(extractSnippet({ type: "result", result: "done" }), null);
  assert.equal(extractSnippet({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }), null);
  assert.equal(extractSnippet(null), null);
});

test("fmtElapsed: seconds under a minute, m+s above", () => {
  assert.equal(fmtElapsed(0), "0s");
  assert.equal(fmtElapsed(45_000), "45s");
  assert.equal(fmtElapsed(83_000), "1m 23s");
  assert.equal(fmtElapsed(-5), "0s");
});

test("tickerText: running form shows snippet, no turns/cost when absent", () => {
  const t = tickerText({ jobName: "acme", status: "running", elapsedMs: 12_000, snippet: "reading files" });
  assert.match(t, /🟡 <b>acme<\/b> · running · 12s/);
  assert.match(t, /<i>reading files<\/i>/);
  assert.doesNotMatch(t, /turns|\$/);
});

test("tickerText: ended form shows status icon, turns, cost, summary", () => {
  const t = tickerText({ jobName: "acme", status: "success", elapsedMs: 90_000, numTurns: 7, costUsd: 0.1234, summary: "all done", ended: true });
  assert.match(t, /✅ <b>acme<\/b> · success · 1m 30s · 7 turns · \$0\.1234/);
  assert.match(t, /all done/);
});

test("tickerText: escapes HTML in job name (identical input → identical output for the 400-guard)", () => {
  const o = { jobName: "a<b>&", status: "running", elapsedMs: 1000 };
  const a = tickerText(o), b = tickerText(o);
  assert.equal(a, b);
  assert.match(a, /a&lt;b&gt;&amp;/);
});

test("scanProposal: trailing PROPOSE parsed + stripped from reply", () => {
  const s = scanProposal('Filing that ticket.\nPROPOSE {"label":"New ticket","method":"POST","path":"/api/tickets","body":{"workspace_id":"w1","title":"x"}}');
  assert.equal(s.reply, "Filing that ticket.");
  assert.equal(s.proposal?.method, "POST");
  assert.equal(s.proposal?.path, "/api/tickets");
  assert.equal(s.proposal?.label, "New ticket");
  assert.deepEqual(s.proposal?.body, { workspace_id: "w1", title: "x" });
  assert.equal(s.error, undefined);
});

test("scanProposal: absent → reply unchanged, no proposal", () => {
  const s = scanProposal("Here are your 3 tickets: A, B, C.");
  assert.equal(s.reply, "Here are your 3 tickets: A, B, C.");
  assert.equal(s.proposal, undefined);
  assert.equal(s.error, undefined);
});

test("scanProposal: malformed JSON → error + raw kept, reply stripped", () => {
  const s = scanProposal('Doing it.\nPROPOSE {not json}');
  assert.equal(s.reply, "Doing it.");
  assert.equal(s.proposal, undefined);
  assert.match(s.error!, /couldn't parse/);
  assert.match(s.raw!, /^PROPOSE/);
});

test("scanProposal: PROPOSE mid-text (not the last line) is ignored", () => {
  const txt = 'PROPOSE {"label":"x","method":"POST","path":"/api/tickets"}\nthen more prose';
  const s = scanProposal(txt);
  assert.equal(s.proposal, undefined);
  assert.equal(s.error, undefined);
  assert.equal(s.reply, txt);
});

test("scanProposal: trailing blank lines after PROPOSE still parse", () => {
  const s = scanProposal('ok\nPROPOSE {"label":"x","method":"DELETE","path":"/api/tickets/abc"}\n\n');
  assert.equal(s.proposal?.method, "DELETE");
  assert.equal(s.reply, "ok");
});

test("scanProposal: allowlist rejects non-/api path and non-mutating method", () => {
  const bad1 = scanProposal('x\nPROPOSE {"label":"x","method":"POST","path":"/etc/passwd"}');
  assert.equal(bad1.proposal, undefined);
  assert.match(bad1.error!, /path/);
  const bad2 = scanProposal('x\nPROPOSE {"label":"x","method":"GET","path":"/api/tickets"}');
  assert.equal(bad2.proposal, undefined);
  assert.match(bad2.error!, /method/);
});

test("isSafeProposal: daily-drive creates/dispatches are safe", () => {
  for (const [method, path] of [
    ["POST", "/api/tickets"],
    ["POST", "/api/tickets/t1/note"],
    ["POST", "/api/tickets/t1/dispatch"],
    ["POST", "/api/tickets/t1/dispatch-plan"],
    ["POST", "/api/jobs/j1/run"],
    ["POST", "/api/sessions"],
    ["POST", "/api/asks/a1/answer"],
    ["POST", "/api/messages"],
    ["POST", "/api/lessons"],
    ["POST", "/api/workspaces/w1/learn"],
    ["POST", "/api/workspaces/w1/ideas"],
    ["POST", "/api/agents/robert/memory"],
    ["POST", "/api/workspaces/w1/brief"],
    ["PATCH", "/api/notes/n1"],
    // Widened tier: Robert was asking for a tap on in-house, reversible edits he is trusted to
    // just make. Editing a ticket, steering a live run and posting to the board are now his call.
    ["PATCH", "/api/tickets/t1"],
    ["POST", "/api/tickets/t1/plan"],
    ["POST", "/api/tickets/t1/grade"],
    ["POST", "/api/tickets/t1/dispatch-grade"],
    ["POST", "/api/tickets/t1/links"],
    ["POST", "/api/tickets/t1/attachments"],
    ["POST", "/api/runs/r1/steer"],
    ["POST", "/api/runs/r1/steps"],
    ["POST", "/api/runs/r1/steps/2"],
    ["POST", "/api/asks"],
    ["POST", "/api/board"],
    ["POST", "/api/calendars/refresh"],
  ] as const) {
    assert.equal(isSafeProposal({ label: "x", method, path }), true, `${method} ${path}`);
  }
});

test("stampTelegramAskAnswer: rewrites by to telegram on ask-answer paths (PER-15)", () => {
  // Robert's PROPOSE body stamps by:"robert" → escalate workspaces 403. Telegram fire must
  // rewrite authorship so the answer lands and the parked worker resumes.
  const stamped = stampTelegramAskAnswer({
    method: "POST",
    path: "/api/asks/6f1e131c-6e37-4b70-89b0-e5b366c71771/answer",
    body: { answer: "park GAP3", by: "robert" },
  });
  assert.deepEqual(stamped.body, { answer: "park GAP3", by: "telegram" });

  const id8 = stampTelegramAskAnswer({
    method: "POST",
    path: "/api/asks/6f1e131c/answer?x=1",
    body: { answer: "yes" },
  });
  assert.equal((id8.body as any).by, "telegram");
  assert.equal((id8.body as any).answer, "yes");

  const other = stampTelegramAskAnswer({
    method: "POST",
    path: "/api/tickets",
    body: { title: "x", by: "robert" },
  });
  assert.deepEqual(other.body, { title: "x", by: "robert" }, "non-ask paths must be untouched");
});

test("isSafeProposal: destructive/config mutations stay on the confirm card", () => {
  for (const [method, path] of [
    ["DELETE", "/api/tickets/t1"],
    // Outward-facing ticket writes keep the card even though PATCH no longer does: these leave
    // the house (the client's tracker, GitHub) and cannot be taken back.
    ["POST", "/api/tickets/t1/push-comment"],
    ["POST", "/api/tickets/t1/push-status"],
    ["POST", "/api/tickets/t1/merge-pr"],
    ["POST", "/api/runs/r1/kill"],
    ["POST", "/api/runs/r1/continue"],
    ["POST", "/api/sessions/s1/kill"],
    ["POST", "/api/jobs"],
    ["PATCH", "/api/jobs/j1"],
    ["POST", "/api/reviews/r1/merge"],
    ["POST", "/api/reviews/r1/approve"],
    ["POST", "/api/recovery/decide"],
    ["PATCH", "/api/workspaces/w1"],
    ["PATCH", "/api/repos/r1"],
    ["POST", "/api/ideas/i1/promote"],
    ["POST", "/api/ideas/kill"],
    ["POST", "/api/triggers"],
  ] as const) {
    assert.equal(isSafeProposal({ label: "x", method, path }), false, `${method} ${path}`);
  }
});

test("isSafeProposal: query strings don't smuggle a path past the allowlist", () => {
  assert.equal(isSafeProposal({ label: "x", method: "POST", path: "/api/tickets?x=1" }), true);
  assert.equal(isSafeProposal({ label: "x", method: "DELETE", path: "/api/tickets/t1?safe=/api/tickets" }), false);
});

test("isSafeProposal: batch is safe only when every item is", () => {
  const mk = (path: string) => ({ method: "POST", path, body: {} });
  assert.equal(isSafeProposal({ label: "b", batch: [mk("/api/tickets"), mk("/api/tickets")] }), true);
  assert.equal(isSafeProposal({ label: "b", batch: [mk("/api/tickets"), mk("/api/runs/r1/kill")] }), false);
});

test("scanProposal: lowercase method normalized to uppercase", () => {
  const s = scanProposal('x\nPROPOSE {"label":"x","method":"post","path":"/api/jobs/j1/run"}');
  assert.equal(s.proposal?.method, "POST");
});

test("scanProposal: batch form parsed, each item allowlisted + normalized", () => {
  const s = scanProposal('Breaking it down.\nPROPOSE {"label":"create 2 tickets","batch":[{"method":"post","path":"/api/tickets","body":{"title":"a"}},{"method":"POST","path":"/api/tickets","body":{"title":"b"}}]}');
  assert.equal(s.reply, "Breaking it down.");
  assert.equal(s.error, undefined);
  assert.equal(s.proposal?.label, "create 2 tickets");
  assert.equal(s.proposal?.batch?.length, 2);
  assert.equal(s.proposal?.batch?.[0].method, "POST");
  assert.deepEqual(s.proposal?.batch?.[1].body, { title: "b" });
});

test("scanProposal: batch with a bad item is rejected", () => {
  const bad = scanProposal('x\nPROPOSE {"label":"x","batch":[{"method":"POST","path":"/api/tickets"},{"method":"GET","path":"/api/tickets"}]}');
  assert.equal(bad.proposal, undefined);
  assert.match(bad.error!, /method/);
  const empty = scanProposal('x\nPROPOSE {"label":"x","batch":[]}');
  assert.match(empty.error!, /empty batch/);
});

// ── Batch prior-item refs (PER-16) ────────────────────────────────────────────
// {{0.id}} used to pass checkOne as a literal path segment → 400 at the API while the
// safe-tier chat log still said ⚡ Executed. Reject unsupported forms at scan; resolve
// valid {{N.field}} from prior JSON at fire time.

test("scanProposal: unsupported {{…}} placeholders rejected (not left as literal URLs)", () => {
  const invent = scanProposal(
    'x\nPROPOSE {"label":"x","batch":[{"method":"POST","path":"/api/tickets"},{"method":"POST","path":"/api/tickets/{{foo}}/dispatch-plan"}]}',
  );
  assert.equal(invent.proposal, undefined);
  assert.match(invent.error!, /unsupported placeholder \{\{foo\}\}/);

  const nested = scanProposal(
    'x\nPROPOSE {"label":"x","batch":[{"method":"POST","path":"/api/tickets"},{"method":"POST","path":"/api/tickets/{{0.id.extra}}/dispatch-plan"}]}',
  );
  assert.match(nested.error!, /unsupported placeholder/);

  const single = scanProposal(
    'x\nPROPOSE {"label":"x","method":"POST","path":"/api/tickets/{{0.id}}/dispatch-plan"}',
  );
  assert.match(single.error!, /only valid inside a batch/);
});

test("scanProposal: forward {{N.field}} ref rejected; prior-item ref accepted", () => {
  const forward = scanProposal(
    'x\nPROPOSE {"label":"x","batch":[{"method":"POST","path":"/api/tickets/{{0.id}}/dispatch-plan"},{"method":"POST","path":"/api/tickets"}]}',
  );
  assert.equal(forward.proposal, undefined);
  assert.match(forward.error!, /has not run yet/);

  const ok = scanProposal(
    'x\nPROPOSE {"label":"create+plan","batch":[{"method":"POST","path":"/api/tickets","body":{"title":"a"}},{"method":"POST","path":"/api/tickets/{{0.id}}/dispatch-plan"}]}',
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.proposal?.batch?.[1].path, "/api/tickets/{{0.id}}/dispatch-plan");
});

test("checkPlaceholders / applyBatchRefs: resolve scalars; miss/non-scalar throw", () => {
  assert.equal(checkPlaceholders({ path: "/api/tickets" }, 0), null);
  assert.match(checkPlaceholders({ path: "/api/tickets/{{0.id}}/x" }, 0)!, /has not run yet/);
  assert.match(checkPlaceholders({ path: "/api/tickets/{{0.id}}/x" }, null)!, /only valid inside a batch/);

  const resolved = applyBatchRefs(
    { method: "POST", path: "/api/tickets/{{0.id}}/dispatch-plan", body: { note: "for {{0.key}}" } },
    [{ id: "uuid-abc", key: "ACM-99" }],
  );
  assert.equal(resolved.path, "/api/tickets/uuid-abc/dispatch-plan");
  assert.deepEqual(resolved.body, { note: "for ACM-99" });

  assert.throws(
    () => applyBatchRefs({ method: "POST", path: "/api/tickets/{{0.missing}}/x" }, [{ id: "u" }]),
    /field missing/,
  );
  assert.throws(
    () => applyBatchRefs({ method: "POST", path: "/api/tickets/{{0.meta}}/x" }, [{ meta: { a: 1 } }]),
    /not a scalar/,
  );
});

/** Mock fetch for autoExecProposal: Chronos localhost + Telegram sendMessage capture. */
function mockProposalFetch(handler: (url: string, init?: RequestInit) => { status: number; json: unknown }) {
  const apiCalls: { url: string; method: string; body?: string }[] = [];
  const tgTexts: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      try {
        const b = JSON.parse(init?.body ?? "{}");
        if (typeof b.text === "string") tgTexts.push(b.text);
      } catch { /* ignore */ }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    }
    apiCalls.push({ url, method: String(init?.method ?? "GET"), body: init?.body });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    };
  }) as unknown as typeof fetch;
  return {
    apiCalls,
    tgTexts,
    restore: () => { globalThis.fetch = real; },
  };
}

test("autoExecProposal: mid-batch failure returns false and names the item (PER-16)", async () => {
  const mock = mockProposalFetch((url) => {
    if (url.endsWith("/api/tickets")) return { status: 201, json: { id: "u1", key: "ACM-1" } };
    return { status: 400, json: { error: "ticket not found" } };
  });
  try {
    const ok = await autoExecProposal(
      {
        label: "create+plan",
        batch: [
          { method: "POST", path: "/api/tickets", body: { title: "a" } },
          { method: "POST", path: "/api/tickets/missing/dispatch-plan" },
        ],
      },
      99,
    );
    assert.equal(ok, false);
    assert.equal(mock.apiCalls.length, 2);
    assert.match(mock.tgTexts.join("\n"), /failed on item 2.*ticket not found/);
  } finally {
    mock.restore();
  }
});

test("autoExecProposal: {{0.id}} resolved from prior create before dispatch-plan (PER-16)", async () => {
  const mock = mockProposalFetch((url) => {
    if (url.endsWith("/api/tickets")) return { status: 201, json: { id: "created-uuid", key: "ACM-104" } };
    if (url.includes("/dispatch-plan")) return { status: 200, json: { run_id: "run-1", job_id: "job-1" } };
    return { status: 404, json: { error: `unexpected ${url}` } };
  });
  try {
    const ok = await autoExecProposal(
      {
        label: "create+plan",
        batch: [
          { method: "POST", path: "/api/tickets", body: { title: "scout me" } },
          { method: "POST", path: "/api/tickets/{{0.id}}/dispatch-plan" },
        ],
      },
      99,
    );
    assert.equal(ok, true);
    assert.equal(mock.apiCalls.length, 2);
    assert.match(mock.apiCalls[1].url, /\/api\/tickets\/created-uuid\/dispatch-plan$/);
    assert.doesNotMatch(mock.apiCalls[1].url, /\{\{/);
    assert.match(mock.tgTexts.join("\n"), /ACM-104|created/);
  } finally {
    mock.restore();
  }
});

test("routeText: /<executive> switches who the chat talks to; /who reports", () => {
  assert.equal(routeText("/robert"), "exec");
  assert.equal(routeText("/robert dispatch the acme ticket"), "exec"); // switch + first message in one line
  assert.equal(routeText("/who"), "who");
  // Retired executives are no longer a switch. They fall through to "agent", so the text reaches
  // Robert as an ordinary message instead of silently selecting a chat partner who cannot answer.
  for (const c of ["/ada", "/ham", "/iris", "/vega"]) assert.equal(routeText(c), "agent", c);
  // Word boundary: prose that merely starts with a name is not a switch.
  assert.equal(routeText("/roberts list"), "agent");
  assert.equal(routeText("robert, status?"), "agent");
  // The shared command table still wins for its own names.
  assert.equal(routeText("/cost"), "command");
});

test("execCommand: handles map to exec ids; retired ones map to nothing", () => {
  assert.equal(execCommand("/robert"), "robert");
  assert.equal(execCommand("/robert anything"), "robert");
  // Ada, Nils and Iris were retired, and Vega (#239) was Ada's old house
  // handle. None of them is re-pointed at Robert: selecting a chat partner who cannot answer is
  // worse than the command simply not being one.
  for (const c of ["/ada", "/ham", "/nils", "/iris", "/iris", "/vega"])
    assert.equal(execCommand(c), null, c);
  assert.equal(execCommand("/nobody"), null);
  assert.equal(execCommand("plain prose"), null);
});

test("routeText: only /claim /abort /start|/help /conv are typed escapes; everything else → agent", () => {
  assert.equal(routeText("/claim abc123"), "claim");
  assert.equal(routeText("/abort"), "abort");
  assert.equal(routeText("/abort all"), "abort");
  assert.equal(routeText("/start"), "start");
  assert.equal(routeText("/help"), "start");
  assert.equal(routeText("/conv"), "conv");
  assert.equal(routeText("/convs"), "conv");
  assert.equal(routeText("/conversations"), "conv");
  // Word boundary again: /convert is prose, not the conversation picker.
  assert.equal(routeText("/convert this to a ticket"), "agent");
  // Old commands and anything else are natural language now.
  assert.equal(routeText("/fleet"), "agent");
  assert.equal(routeText("/tickets acme"), "agent");
  assert.equal(routeText("/status"), "agent");
  assert.equal(routeText("dispatch the acme ticket"), "agent");
  // Word boundary: /aborting is not /abort.
  assert.equal(routeText("/aborting"), "agent");
  assert.equal(routeText(""), "agent");
});

test("shouldNotify: 'off' never pushes", () => {
  assert.equal(shouldNotify("off", "success"), false);
  assert.equal(shouldNotify("off", "failed"), false);
});

test("shouldNotify: 'failures' only pushes failed/timeout/blocked/rate_limited", () => {
  for (const s of ["failed", "timeout", "blocked", "rate_limited"]) assert.equal(shouldNotify("failures", s), true);
  for (const s of ["success", "queued", "running", "killed", "interrupted"]) assert.equal(shouldNotify("failures", s), false);
});

test("shouldNotify: 'all' and null/undefined push everything (current behavior)", () => {
  assert.equal(shouldNotify("all", "success"), true);
  assert.equal(shouldNotify(null, "failed"), true);
  assert.equal(shouldNotify(undefined, "success"), true);
});

test("voiceGate: local whisper (no CHRONOS_TRANSCRIBE_URL) → allowed without a key", () => {
  const savedKey = process.env.OPENAI_API_KEY, savedUrl = process.env.CHRONOS_TRANSCRIBE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CHRONOS_TRANSCRIBE_URL; // default = local whisper.cpp server
  assert.equal(voiceGate({ duration: 5, file_size: 100 }), null);
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  if (savedUrl !== undefined) process.env.CHRONOS_TRANSCRIBE_URL = savedUrl;
});

test("voiceGate: cloud endpoint without OPENAI_API_KEY → gated", () => {
  const savedKey = process.env.OPENAI_API_KEY, savedUrl = process.env.CHRONOS_TRANSCRIBE_URL;
  delete process.env.OPENAI_API_KEY;
  process.env.CHRONOS_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
  assert.match(voiceGate({ duration: 5, file_size: 100 })!, /OPENAI_API_KEY/);
  savedKey !== undefined ? (process.env.OPENAI_API_KEY = savedKey) : void 0;
  savedUrl !== undefined ? (process.env.CHRONOS_TRANSCRIBE_URL = savedUrl) : delete process.env.CHRONOS_TRANSCRIBE_URL;
});

test("voiceGate: within caps → allowed", () => {
  process.env.OPENAI_API_KEY = "test-key";
  assert.equal(voiceGate({ duration: 60, file_size: 1_000_000 }), null);
  delete process.env.OPENAI_API_KEY;
});

test("voiceGate: over duration cap (5 min) → rejected", () => {
  process.env.OPENAI_API_KEY = "test-key";
  assert.match(voiceGate({ duration: 301, file_size: 100 })!, /too long/);
  delete process.env.OPENAI_API_KEY;
});

test("voiceGate: over size cap (20MB) → rejected", () => {
  process.env.OPENAI_API_KEY = "test-key";
  assert.match(voiceGate({ duration: 10, file_size: 21 * 1024 * 1024 })!, /too large/);
  delete process.env.OPENAI_API_KEY;
});

test("voiceGate: missing duration/file_size treated as 0 (not rejected on caps)", () => {
  process.env.OPENAI_API_KEY = "test-key";
  assert.equal(voiceGate({}), null);
  delete process.env.OPENAI_API_KEY;
});

// A dropped long-poll is routine; a run of them is an outage. The streak is what the poll loop reads
// to decide between retrying in 250ms and backing off to 3s, so it has to reset the moment a call
// succeeds — a streak that never clears would leave the bot on outage backoff forever.
test("tg: transport failures streak and reset, so the poll loop backs off only on a real outage", async () => {
  const realFetch = globalThis.fetch;
  const reset = () => {
    const e: any = new TypeError("fetch failed");
    e.cause = { code: "ECONNRESET" };
    return Promise.reject(e);
  };
  try {
    globalThis.fetch = reset as typeof fetch;
    assert.equal(await tg("getUpdates", {}), null, "transport failure returns null, not a throw");
    assert.equal(transportFailStreak(), 1);
    await tg("getUpdates", {});
    assert.equal(transportFailStreak(), 2, "consecutive drops accumulate");

    globalThis.fetch = (() => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: [] }) })) as unknown as typeof fetch;
    const ok = await tg("getUpdates", {});
    assert.deepEqual(ok, { ok: true, result: [] });
    assert.equal(transportFailStreak(), 0, "one success clears the streak");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Pending proposal persistence (PER-21) ─────────────────────────────────────
// Confirm cards used to live only in an in-memory Map: every deploy wiped them and ✅ got a
// lying "proposal expired". These assert the kv write-through + TTL + cap reasons.

const sample = (label = "Merge PR") => ({
  label,
  method: "POST",
  path: "/api/reviews/r1/merge",
  body: {},
});

test("putProposal: survives an unload (simulated daemon restart) via kv", () => {
  resetPendingProposalsForTest();
  const { id } = putProposal(sample("survive restart"), 42);
  assert.ok(kv.get("tg.proposals"), "written to kv");
  unloadPendingProposalsForTest(); // memory gone, kv intact — like a new process
  const taken = takeProposal(id);
  assert.equal(taken.ok, true);
  if (taken.ok) assert.equal(taken.proposal.label, "survive restart");
  resetPendingProposalsForTest();
});

test("takeProposal: TTL expiry names the cause (not a vague 'expired')", () => {
  resetPendingProposalsForTest();
  const before = CONFIG.telegram.proposalTtlMs;
  CONFIG.telegram.proposalTtlMs = 1_000;
  try {
    const t0 = 1_000_000;
    const { id } = putProposal(sample("old"), 1, t0);
    const gone = takeProposal(id, t0 + 1_001);
    assert.deepEqual(gone, { ok: false, reason: "ttl" });
    assert.match(proposalGoneMessage("ttl"), /timed out/);
  } finally {
    CONFIG.telegram.proposalTtlMs = before;
    resetPendingProposalsForTest();
  }
});

test("purgeExpiredProposals: drops stale entries on boot-style sweep", () => {
  resetPendingProposalsForTest();
  const before = CONFIG.telegram.proposalTtlMs;
  CONFIG.telegram.proposalTtlMs = 5_000;
  try {
    const t0 = 2_000_000;
    const { id: fresh } = putProposal(sample("fresh"), 1, t0);
    const { id: stale } = putProposal(sample("stale"), 1, t0 - 10_000);
    const n = purgeExpiredProposals(t0);
    assert.equal(n, 1);
    assert.equal(takeProposal(fresh, t0).ok, true);
    assert.deepEqual(takeProposal(stale, t0), { ok: false, reason: "ttl" });
  } finally {
    CONFIG.telegram.proposalTtlMs = before;
    resetPendingProposalsForTest();
  }
});

test("putProposal: FIFO cap returns discarded info; late take names 'cap'", () => {
  resetPendingProposalsForTest();
  const before = CONFIG.telegram.proposalCap;
  CONFIG.telegram.proposalCap = 2;
  try {
    const a = putProposal(sample("first"), 7, 10);
    const b = putProposal(sample("second"), 7, 11);
    assert.equal(a.discarded, undefined);
    assert.equal(b.discarded, undefined);
    const c = putProposal(sample("third"), 7, 12);
    assert.ok(c.discarded);
    assert.equal(c.discarded!.id, a.id);
    assert.equal(c.discarded!.label, "first");
    assert.equal(c.discarded!.chat, 7);
    assert.deepEqual(takeProposal(a.id, 12), { ok: false, reason: "cap" });
    assert.match(proposalGoneMessage("cap"), /pending limit/);
    assert.equal(takeProposal(b.id, 12).ok, true);
    assert.equal(takeProposal(c.id, 12).ok, true);
  } finally {
    CONFIG.telegram.proposalCap = before;
    resetPendingProposalsForTest();
  }
});

test("takeProposal: unknown id → restart cause (pre-persistence cards / already handled)", () => {
  resetPendingProposalsForTest();
  assert.deepEqual(takeProposal("deadbeef"), { ok: false, reason: "restart" });
  assert.match(proposalGoneMessage("restart"), /daemon restart/);
});

test("dismissProposal: removes from kv so a restart cannot resurrect it", () => {
  resetPendingProposalsForTest();
  const { id } = putProposal(sample("nope"), 1);
  assert.equal(dismissProposal(id), true);
  unloadPendingProposalsForTest();
  assert.deepEqual(takeProposal(id), { ok: false, reason: "restart" });
  resetPendingProposalsForTest();
});

test("Robert never moves the operator's screen: navigation UI lines leave his reply and go nowhere; ask survives", () => {
  const out = scanUiActions([
    "Login fix is waiting on you (abcd1234).",
    'UI {"op":"select","id":"abcd1234"}',
    'UI {"op":"focus_terminal","match":"login"}',
    'UI {"op":"focus_ticket","key":"API-21"}',
    'UI {"op":"view","name":"flow"}',
    'UI {"op":"workspace","name":"api"}',
    'UI {"op":"jobs","id":"j1"}',
    '{"op":"select","id":"abcd1234"}',
    'UI {"op":"ask","question":"Merge it?"}',
  ].join("\n"));
  assert.equal(out.reply, "Login fix is waiting on you (abcd1234).");
  assert.deepEqual(out.actions, [{ op: "ask", question: "Merge it?" }]);
});
