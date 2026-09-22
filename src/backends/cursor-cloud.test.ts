import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorCloudBackend, fetchModelCatalog, isGitHubRemote, __resetModelCatalogCache } from "./cursor-cloud.js";
import { validateSpawnTarget } from "./index.js";
import type { CloudLaunchOpts, CloudRef } from "./types.js";

// Same shape as src/writeback.test.ts's stubFetch: routes matched by URL substring, records every
// call. cursor-cloud must never touch the real network in tests.
function stubFetch(routes: Record<string, { status?: number; body?: any; headers?: Record<string, string> }>) {
  const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    calls.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers });
    const hit = Object.entries(routes).find(([k]) => u.includes(k))?.[1];
    const status = hit?.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (n: string) => hit?.headers?.[n.toLowerCase()] ?? null },
      json: async () => hit?.body ?? {},
      text: async () => JSON.stringify(hit?.body ?? {}),
    } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// A fetch stub whose response streams SSE text (one or more chunks) instead of json()/text().
function stubStream(url: string, chunks: string[], status = 200) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any = {}) => {
    if (!String(u).includes(url)) throw new Error(`unexpected fetch: ${u}`);
    lastHeaders = { ...(init.headers ?? {}) };
    return {
      ok: status < 400,
      status,
      body: (async function* () {
        for (const c of chunks) yield new TextEncoder().encode(c);
      })(),
    } as any;
  }) as any;
  return { restore: () => { globalThis.fetch = real; } };
}
let lastHeaders: Record<string, string> = {};

function job(over: Partial<CloudLaunchOpts["job"]> = {}): CloudLaunchOpts["job"] {
  return {
    id: "job-1", name: "ticket-1", description: null, goal: "do the thing", append_system: null,
    profile: "default", workspace_id: "ws-1", ticket_id: null, backend: "cursor-cloud", cwd: "/repo",
    add_dirs: null, model: null, allowed_tools: null, disallowed_tools: null, trigger_type: "manual" as any,
    cron_expr: null, run_at: null, timezone: "UTC", max_budget_usd: null, timeout_sec: 3600, retry_max: 0,
    retry_backoff_sec: 0, verify: 0, sandbox: "off", on_success: null, on_failure: null, notify: null,
    enabled: 1, created_at: "now", updated_at: "now", ...over,
  } as any;
}

function launchOpts(over: Partial<CloudLaunchOpts> = {}): CloudLaunchOpts {
  return {
    job: job(),
    runId: "run-local-1",
    context: null,
    idempotencyKey: "idem-1",
    repos: [{ url: "https://github.com/acme/widgets" }],
    autoCreatePr: true,
    name: "ticket-1",
    ...over,
  };
}

test("cursor-cloud: bin/buildArgs/oneShot/interactiveArgs/encodeSteer all throw, naming cursor-cloud", () => {
  assert.throws(() => cursorCloudBackend.bin(), /cursor-cloud/);
  assert.throws(() => cursorCloudBackend.buildArgs({} as any, "s", null), /cursor-cloud/);
  assert.throws(() => cursorCloudBackend.oneShot({ prompt: "p", configDir: "/c" }), /cursor-cloud/);
  assert.throws(() => cursorCloudBackend.interactiveArgs!(null), /cursor-cloud/);
  assert.throws(() => cursorCloudBackend.encodeSteer!("hi"), /cursor-cloud/);
});

test("cursor-cloud: required shape", () => {
  assert.equal(cursorCloudBackend.name, "cursor-cloud");
  assert.equal(cursorCloudBackend.kind, "cloud");
  assert.equal(cursorCloudBackend.supportsHeadless, true);
  assert.equal(cursorCloudBackend.supportsResume, true);
  assert.equal(cursorCloudBackend.pinsSession, true);
  assert.equal(cursorCloudBackend.appendsSystem, false);
  assert.deepEqual(cursorCloudBackend.capabilities, {});
});

test("cursor-cloud launch: happy path posts prompt/repos/agentId and maps the response", async () => {
  const { calls, restore } = stubFetch({
    "/v1/agents": { status: 200, body: { agent: { id: "bc-idem-1", url: "https://cursor.com/agents/bc-idem-1", latestRunId: "run-abc" }, run: { id: "run-abc", status: "RUNNING" } } },
  });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const out = await cursorCloudBackend.launch(launchOpts());
    assert.deepEqual(out, { agentId: "bc-idem-1", runId: "run-abc", url: "https://cursor.com/agents/bc-idem-1", status: "running" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.Authorization, "Bearer crsr_test");
    assert.equal(calls[0].body.agentId, "bc-idem-1");
    assert.equal(calls[0].body.prompt.text, "do the thing");
    assert.deepEqual(calls[0].body.repos, [{ url: "https://github.com/acme/widgets" }]);
    assert.equal(calls[0].body.autoCreatePR, true);
    assert.equal(calls[0].body.workOnCurrentBranch, false);
    assert.equal(calls[0].body.model, undefined); // no model / "auto" → omit
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud launch: folds append_system + context into the prompt, sets model.id when not auto", async () => {
  const { calls, restore } = stubFetch({
    "/v1/agents": { status: 200, body: { agent: { id: "bc-x", url: null }, run: { id: "run-x", status: "RUNNING" } } },
  });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    await cursorCloudBackend.launch(launchOpts({
      job: job({ append_system: "STANDING NOTE", model: "claude-sonnet-5" }),
      context: "cron fired",
    }));
    assert.match(calls[0].body.prompt.text, /^STANDING NOTE\n\n---\n\ndo the thing/);
    assert.ok(calls[0].body.prompt.text.includes("cron fired"));
    assert.deepEqual(calls[0].body.model, { id: "claude-sonnet-5" });
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud launch: 429 with retryAfter retries then succeeds", async () => {
  let n = 0;
  const real = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    calls.push(init);
    n++;
    if (n < 3) {
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ retryAfter: 0.001 }), text: async () => "" } as any;
    }
    return { ok: true, status: 200, json: async () => ({ agent: { id: "bc-idem-1", url: null }, run: { id: "run-3", status: "RUNNING" } }) } as any;
  }) as any;
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const out = await cursorCloudBackend.launch(launchOpts());
    assert.equal(n, 3);
    assert.equal(out.runId, "run-3");
  } finally {
    globalThis.fetch = real;
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud launch: 429 exhausts retries (cap 3 tries) and throws instead of retrying forever", async () => {
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ retryAfter: 0.001 }), text: async () => "still busy" } as any;
  }) as any;
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    await assert.rejects(() => cursorCloudBackend.launch(launchOpts()), /429/);
    assert.equal(n, 3);
  } finally {
    globalThis.fetch = real;
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud launch: 409 agent_id_conflict resolves to the EXISTING agent, never launches twice", async () => {
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    return {
      ok: false, status: 409,
      json: async () => ({ error: "agent_id_conflict", agent: { id: "bc-idem-1", url: "https://cursor.com/agents/bc-idem-1", latestRunId: "run-prior" }, run: { id: "run-prior", status: "RUNNING" } }),
      text: async () => "",
    } as any;
  }) as any;
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const out = await cursorCloudBackend.launch(launchOpts());
    assert.equal(n, 1); // no second attempt — a 409 is resolved, not retried
    assert.deepEqual(out, { agentId: "bc-idem-1", runId: "run-prior", url: "https://cursor.com/agents/bc-idem-1", status: "running" });
  } finally {
    globalThis.fetch = real;
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud launch: resolves CURSOR_API_KEY from workspace vars before env", async () => {
  const { calls, restore } = stubFetch({
    "/v1/agents": { status: 200, body: { agent: { id: "bc-idem-1", url: null }, run: { id: "run-1", status: "RUNNING" } } },
  });
  const { workspaceVars, workspaces } = await import("../store.js");
  const ws = workspaces.create({ slug: `cc-${Date.now()}`, name: "CC test", config_dir: "/tmp/cc" } as any);
  workspaceVars.set(ws.id, "CURSOR_API_KEY", "crsr_from_ws", null);
  try {
    delete process.env.CURSOR_API_KEY;
    await cursorCloudBackend.launch(launchOpts({ job: job({ workspace_id: ws.id }) }));
    assert.equal(calls[0].headers.Authorization, "Bearer crsr_from_ws");
  } finally {
    restore();
  }
});

test("cursor-cloud checkAuth: resolves the key from workspace vars, not just env", async () => {
  const { calls, restore } = stubFetch({ "/v1/me": { status: 200, body: {} } });
  const { workspaceVars, workspaces } = await import("../store.js");
  const ws = workspaces.create({ slug: `cc-auth-${Date.now()}`, name: "CC auth", config_dir: "/tmp/cc-auth" } as any);
  workspaceVars.set(ws.id, "CURSOR_API_KEY", "crsr_from_ws", null);
  try {
    delete process.env.CURSOR_API_KEY;
    // No workspaceId → env only → no key anywhere → false, never a network call.
    assert.equal(await cursorCloudBackend.checkAuth!(), false);
    assert.equal(calls.length, 0);
    // workspaceId passed → finds the key in that workspace's vars, same as every other method.
    assert.equal(await cursorCloudBackend.checkAuth!(ws.id), true);
    assert.equal(calls[0].headers.Authorization, "Bearer crsr_from_ws");
  } finally {
    restore();
  }
});

test("cursor-cloud stream: parses SSE blocks, resumes via Last-Event-ID, marks result terminal", async () => {
  const sse = [
    "id: 1\nevent: status\ndata: {\"status\":\"RUNNING\"}\n\n",
    "id: 2\nevent: assistant\ndata: {\"text\":\"Hel\"}\n\n",
    "id: 3\nevent: assistant\ndata: {\"text\":\"lo\"}\n\n",
    "id: 4\nevent: tool_call\ndata: {\"tool\":\"bash\"}\n\n",
    "id: 5\nevent: result\ndata: {\"result\":\"done\",\"isError\":false}\n\n",
  ];
  const { restore } = stubStream("/v1/agents/bc-1/runs/run-1/stream", sse);
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const ref: CloudRef = { agentId: "bc-1", runId: "run-1", workspaceId: null };
    const frames = [];
    for await (const f of cursorCloudBackend.stream(ref, "0")) frames.push(f);

    assert.equal(lastHeaders["Last-Event-ID"], "0");
    // status frame
    assert.equal(frames[0].eventId, "1");
    assert.equal(frames[0].event?.type, "status");
    assert.equal(frames[0].terminal, false);
    // the two assistant deltas are concatenated into ONE frame (flushed when tool_call arrives),
    // never one row per token
    const assistantFrames = frames.filter((f) => f.event?.type === "assistant");
    assert.equal(assistantFrames.length, 1);
    assert.equal(assistantFrames[0].event?.payload.text, "Hello");
    assert.equal(assistantFrames[0].eventId, "3"); // cursor at flush time
    // tool_call frame
    const toolFrame = frames.find((f) => f.event?.type === "tool_call")!;
    assert.equal(toolFrame.terminal, false);
    // result frame is terminal and ends the stream
    const last = frames[frames.length - 1];
    assert.equal(last.event?.type, "result");
    assert.equal(last.terminal, true);
    assert.equal(last.eventId, "5");
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud stream: interaction_update text-completed flushes buffered deltas without its own row", async () => {
  const sse = [
    "id: 1\nevent: assistant\ndata: {\"text\":\"partial\"}\n\n",
    "id: 2\nevent: interaction_update\ndata: {\"kind\":\"text-completed\"}\n\n",
    "id: 3\nevent: done\ndata: {}\n\n",
  ];
  const { restore } = stubStream("/v1/agents/bc-2/runs/run-2/stream", sse);
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const ref: CloudRef = { agentId: "bc-2", runId: "run-2", workspaceId: null };
    const frames = [];
    for await (const f of cursorCloudBackend.stream(ref, null)) frames.push(f);
    assert.equal(frames.length, 2); // assistant flush + done — interaction_update itself isn't stored
    assert.equal(frames[0].event?.type, "assistant");
    assert.equal(frames[0].event?.payload.text, "partial");
    assert.equal(frames[1].event?.type, "done");
    assert.equal(frames[1].terminal, true);
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud getRun: maps status/result/branches", async () => {
  const { restore } = stubFetch({
    "/v1/agents/bc-1/runs/run-1": { status: 200, body: { status: "FINISHED", result: "all done", durationMs: 5260, git: { branches: [{ repoUrl: "https://github.com/acme/widgets", branch: "cursor/foo-1", prUrl: "https://github.com/acme/widgets/pull/9" }] } } },
  });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const st = await cursorCloudBackend.getRun({ agentId: "bc-1", runId: "run-1", workspaceId: null });
    assert.equal(st.status, "finished");
    assert.equal(st.result, "all done");
    assert.equal(st.durationMs, 5260);
    assert.deepEqual(st.branches, [{ repoUrl: "https://github.com/acme/widgets", branch: "cursor/foo-1", prUrl: "https://github.com/acme/widgets/pull/9" }]);
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud CloudStatus mapping: FINISHED/ERROR/CANCELLED/EXPIRED/RUNNING", async () => {
  for (const [vendor, want] of [["FINISHED", "finished"], ["ERROR", "error"], ["CANCELLED", "cancelled"], ["EXPIRED", "expired"], ["RUNNING", "running"]] as const) {
    const { restore } = stubFetch({ "/v1/agents/bc-1/runs/run-1": { status: 200, body: { status: vendor } } });
    try {
      process.env.CURSOR_API_KEY = "crsr_test";
      const st = await cursorCloudBackend.getRun({ agentId: "bc-1", runId: "run-1", workspaceId: null });
      assert.equal(st.status, want, vendor);
    } finally {
      restore();
      delete process.env.CURSOR_API_KEY;
    }
  }
});

test("cursor-cloud usage: cost_usd = chargedCents / 100, a vendor total", async () => {
  const { restore } = stubFetch({
    "/v1/agents/bc-1/usage": { status: 200, body: { tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 }, cost: { chargedCents: 248 } } },
  });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const u = await cursorCloudBackend.usage({ agentId: "bc-1", runId: "run-1", workspaceId: null });
    assert.equal(u.cost_usd, 2.48);
    assert.equal(u.tokens_in, 1000);
    assert.equal(u.tokens_out, 200);
    assert.equal(u.tokens_cache_read, 50);
    assert.equal(u.tokens_cache_write, 10);
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud followup: posts a new turn on the same agent, returns the new run id", async () => {
  const { calls, restore } = stubFetch({
    "/v1/agents/bc-1/runs": { status: 200, body: { run: { id: "run-2", status: "RUNNING" } } },
  });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const out = await cursorCloudBackend.followup({ agentId: "bc-1", runId: "run-1", workspaceId: null }, "keep going");
    assert.equal(out.agentId, "bc-1");
    assert.equal(out.runId, "run-2");
    assert.equal(calls[0].body.prompt.text, "keep going");
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud followup: 409 agent_busy throws a clear error", async () => {
  const { restore } = stubFetch({ "/v1/agents/bc-1/runs": { status: 409, body: { error: "agent_busy" } } });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    await assert.rejects(() => cursorCloudBackend.followup({ agentId: "bc-1", runId: "run-1", workspaceId: null }, "hi"), /busy/);
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud cancel: posts to the cancel endpoint", async () => {
  const { calls, restore } = stubFetch({ "/v1/agents/bc-1/runs/run-1/cancel": { status: 200, body: {} } });
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    await cursorCloudBackend.cancel({ agentId: "bc-1", runId: "run-1", workspaceId: null });
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.includes("/cancel"));
  } finally {
    restore();
    delete process.env.CURSOR_API_KEY;
  }
});

test("cursor-cloud extractResult / textDelta / detectRateLimit over SSE-shaped events", () => {
  const resultEv = cursorCloudBackend.parseLine(JSON.stringify({ type: "result", result: "final answer", isError: false }));
  const r = cursorCloudBackend.extractResult(resultEv)!;
  assert.equal(r.result_text, "final answer");
  assert.equal(r.is_error, false);
  assert.equal(cursorCloudBackend.extractResult(cursorCloudBackend.parseLine(JSON.stringify({ type: "status", status: "RUNNING" }))), null);

  const delta = cursorCloudBackend.parseLine(JSON.stringify({ type: "assistant", text: "hi" }));
  assert.equal(cursorCloudBackend.textDelta!(delta), "hi");
  assert.equal(cursorCloudBackend.textDelta!(cursorCloudBackend.parseLine(JSON.stringify({ type: "tool_call" }))), null);

  const wall = cursorCloudBackend.parseLine(JSON.stringify({ type: "error", message: "429 resource_exhausted", retryAfter: 60 }));
  const rl = cursorCloudBackend.detectRateLimit(wall);
  assert.equal(rl?.rateLimited, true);
  assert.ok(typeof rl?.resetsAt === "number");
  assert.equal(cursorCloudBackend.detectRateLimit(cursorCloudBackend.parseLine(JSON.stringify({ type: "error", message: "bad prompt" }))), null);
});

test("isGitHubRemote: accepts https and ssh GitHub urls, rejects everything else", () => {
  assert.equal(isGitHubRemote("https://github.com/acme/widgets"), true);
  assert.equal(isGitHubRemote("https://github.com/acme/widgets.git"), true);
  assert.equal(isGitHubRemote("git@github.com:acme/widgets.git"), true);
  assert.equal(isGitHubRemote("https://gitlab.com/acme/widgets"), false);
  assert.equal(isGitHubRemote(null), false);
  assert.equal(isGitHubRemote(""), false);
});

test("validateSpawnTarget: cursor-cloud refuses a repo with no GitHub remote, naming the repo", () => {
  const err = validateSpawnTarget("cursor-cloud", null, { name: "widgets", git_remote: null, delivery: "pr" });
  assert.match(err!, /widgets/);
  assert.match(err!, /GitHub/);
});

test("validateSpawnTarget: cursor-cloud refuses delivery=commit, naming the repo", () => {
  const err = validateSpawnTarget("cursor-cloud", null, { name: "widgets", git_remote: "https://github.com/acme/widgets", delivery: "commit" });
  assert.match(err!, /widgets/);
  assert.match(err!, /delivery=pr/);
});

test("validateSpawnTarget: cursor-cloud allows a GitHub repo with delivery=pr", () => {
  assert.equal(validateSpawnTarget("cursor-cloud", null, { name: "widgets", git_remote: "https://github.com/acme/widgets", delivery: "pr" }), null);
});

test("validateSpawnTarget: repo arg is optional and does not affect other backends or unknown-backend/model checks", () => {
  assert.equal(validateSpawnTarget("claude-code", "sonnet"), null);
  assert.match(validateSpawnTarget("no-such-backend", "sonnet")!, /unknown backend/);
  assert.equal(validateSpawnTarget("cursor-cloud", null), null); // no repo info passed → nothing to refuse yet
});

test("cursor-cloud: static models fallback omits claude-sonnet-5 (over its spend cap on this account)", () => {
  assert.ok(!cursorCloudBackend.models!.includes("claude-sonnet-5"));
});

test("fetchModelCatalog: fetches GET /v1/models, caches 1h, force bypasses the cache", async () => {
  __resetModelCatalogCache();
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    return { ok: true, status: 200, json: async () => ({ models: [{ id: "claude-opus-5" }, "composer-2.5", { id: null }] }) } as any;
  }) as any;
  try {
    process.env.CURSOR_API_KEY = "crsr_test";
    const first = await fetchModelCatalog(null);
    assert.deepEqual(first, ["claude-opus-5", "composer-2.5"]);
    assert.equal(n, 1);
    const second = await fetchModelCatalog(null); // within the 1h TTL → cached, no second fetch
    assert.deepEqual(second, first);
    assert.equal(n, 1);
    await fetchModelCatalog(null, { force: true });
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = real;
    delete process.env.CURSOR_API_KEY;
    __resetModelCatalogCache();
  }
});
