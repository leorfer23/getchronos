import { test } from "node:test";
import assert from "node:assert/strict";
import { externalStatusFor, normalizePriority, adfToText, mapStatus, isStatusDivergent, DEFAULT_STATUS_MAP } from "./types.js";
import { jira } from "./jira.js";
import { clickup, fetchTasks as clickupFetchTasks } from "./clickup.js";
import { isCredentialError, syncWorkspace } from "./index.js";
import { workspaces, tickets, deletedExternals } from "../store.js";

test("externalStatusFor: collapse-to-nearest defaults", () => {
  assert.equal(externalStatusFor("planning", {}), "in progress");
  assert.equal(externalStatusFor("planned", {}), "in progress");
  assert.equal(externalStatusFor("review", {}), "in review");
  assert.equal(externalStatusFor("spec", {}), "to do");
  assert.equal(externalStatusFor("done", {}), "done");
});

test("externalStatusFor: per-workspace override, incl. null to disable push", () => {
  assert.equal(externalStatusFor("review", { status_map: { review: "QA" } }), "QA");
  assert.equal(externalStatusFor("blocked", { status_map: { blocked: null } }), null); // explicit disable
  assert.equal(externalStatusFor("done", { status_map: { review: "QA" } }), "done"); // untouched keys fall back
});

test("status round-trips: local → external label → mapStatus stays stable", () => {
  for (const local of ["in_progress", "review", "blocked", "done"] as const) {
    const label = DEFAULT_STATUS_MAP[local]!;
    assert.equal(mapStatus(label), local, `${local} → "${label}" → ${mapStatus(label)}`);
  }
});

test("normalizePriority: tracker labels → P0..P3", () => {
  assert.equal(normalizePriority("Highest"), "P0");
  assert.equal(normalizePriority("urgent"), "P0");
  assert.equal(normalizePriority("High"), "P1");
  assert.equal(normalizePriority("normal"), "P2");
  assert.equal(normalizePriority("Low"), "P3");
  assert.equal(normalizePriority(""), null);
  assert.equal(normalizePriority(null), null);
});

test("adfToText: flattens Jira ADF to readable text", () => {
  const adf = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      { type: "paragraph", content: [{ type: "text", text: "line two" }] },
    ],
  };
  assert.equal(adfToText(adf).trim(), "Hello world\nline two");
  assert.equal(adfToText(null), "");
  assert.equal(adfToText("plain"), "plain");
});

// Fake fetch: routes by URL substring, records every call, returns scripted JSON.
function stubFetch(routes: Record<string, { status?: number; body?: any }>) {
  const calls: { url: string; method: string; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const hit = Object.entries(routes).find(([k]) => u.includes(k))?.[1];
    const status = hit?.status ?? 200;
    return { ok: status < 400, status, json: async () => hit?.body ?? {}, text: async () => JSON.stringify(hit?.body ?? {}) } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("jira createTask assigns the new issue to the token's own user", async () => {
  const { calls, restore } = stubFetch({
    "/myself": { body: { accountId: "acc-leo" } },
    "/rest/api/3/issue/ANA-9/assignee": { body: {} },
    "/rest/api/3/issue": { body: { key: "ANA-9" } },
  });
  try {
    // fresh base per test so the module-level accountId cache can't mask a missing /myself call
    const cfg = { base_url: "https://x1.atlassian.net", email: "leo@x", api_token: "t", project_key: "ANA" };
    const out = await jira.createTask!(cfg, { title: "T", description: "D" });
    assert.equal(out.id, "ANA-9");
    const assign = calls.find((c) => c.method === "PUT" && c.url.endsWith("/assignee"));
    assert.ok(assign, "expected a PUT to the assignee endpoint");
    assert.deepEqual(assign!.body, { accountId: "acc-leo" });
  } finally { restore(); }
});

test("jira createTask still returns the issue when the assign call fails", async () => {
  const { restore } = stubFetch({
    "/myself": { body: { accountId: "acc-leo" } },
    "/assignee": { status: 403, body: { error: "nope" } },
    "/rest/api/3/issue": { body: { key: "ANA-10" } },
  });
  try {
    const cfg = { base_url: "https://x2.atlassian.net", email: "leo@x", api_token: "t", project_key: "ANA" };
    assert.equal((await jira.createTask!(cfg, { title: "T", description: "D" })).id, "ANA-10");
  } finally { restore(); }
});

test("jira assignee_account_id overrides the /myself lookup", async () => {
  const { calls, restore } = stubFetch({ "/assignee": { body: {} }, "/rest/api/3/issue": { body: { key: "ANA-11" } } });
  try {
    const cfg = { base_url: "https://x3.atlassian.net", email: "leo@x", api_token: "t", project_key: "ANA", assignee_account_id: "acc-other" };
    await jira.createTask!(cfg, { title: "T", description: "D" });
    assert.equal(calls.some((c) => c.url.includes("/myself")), false);
    assert.deepEqual(calls.find((c) => c.url.endsWith("/assignee"))!.body, { accountId: "acc-other" });
  } finally { restore(); }
});

test("clickup createTask puts the token's own user in assignees", async () => {
  const { calls, restore } = stubFetch({
    "/v2/user": { body: { user: { id: 4242 } } },
    "/task": { body: { id: "abc", url: "u", status: { status: "to do" } } },
  });
  try {
    const out = await clickup.createTask!({ token: "t", list_id: "L1" }, { title: "T", description: "D" });
    assert.equal(out.id, "abc");
    assert.deepEqual(calls.find((c) => c.method === "POST")!.body.assignees, [4242]);
  } finally { restore(); }
});

test("jira pushStatus attaches the Hours Spent field when hours is given", async () => {
  const { calls, restore } = stubFetch({
    "/transitions": { body: { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] } },
    "/rest/api/3/field": { body: [{ id: "customfield_10042", name: "Hours Spent" }, { id: "customfield_1", name: "Story Points" }] },
  });
  try {
    const cfg = { base_url: "https://x4.atlassian.net", email: "leo@x", api_token: "t" };
    await jira.pushStatus(cfg, "ANA-20", "Done", 8);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    assert.deepEqual(post!.body, { transition: { id: "31" }, fields: { customfield_10042: 8 } });
  } finally { restore(); }
});

test("jira pushStatus omits fields when no hours is passed", async () => {
  const { calls, restore } = stubFetch({
    "/transitions": { body: { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] } },
  });
  try {
    const cfg = { base_url: "https://x5.atlassian.net", email: "leo@x", api_token: "t" };
    await jira.pushStatus(cfg, "ANA-21", "Done");
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    assert.deepEqual(post!.body, { transition: { id: "31" } });
    assert.equal(calls.some((c) => c.url.includes("/rest/api/3/field")), false);
  } finally { restore(); }
});

test("jira pushStatus falls back to no fields when the Hours Spent field can't be resolved", async () => {
  const { calls, restore } = stubFetch({
    "/transitions": { body: { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] } },
    "/rest/api/3/field": { status: 500, body: {} },
  });
  try {
    const cfg = { base_url: "https://x6.atlassian.net", email: "leo@x", api_token: "t" };
    await jira.pushStatus(cfg, "ANA-22", "Done", 5);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    assert.deepEqual(post!.body, { transition: { id: "31" } });
  } finally { restore(); }
});

test("jira pushStatus honors hours_field_id override without calling /field", async () => {
  const { calls, restore } = stubFetch({
    "/transitions": { body: { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] } },
  });
  try {
    const cfg = { base_url: "https://x7.atlassian.net", email: "leo@x", api_token: "t", hours_field_id: "customfield_99" };
    await jira.pushStatus(cfg, "ANA-23", "Done", 3);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    assert.deepEqual(post!.body, { transition: { id: "31" }, fields: { customfield_99: 3 } });
    assert.equal(calls.some((c) => c.url.includes("/rest/api/3/field")), false);
  } finally { restore(); }
});

test("clickup createTask still files the task when /user is unavailable", async () => {
  const { calls, restore } = stubFetch({
    "/v2/user": { status: 401, body: {} },
    "/task": { body: { id: "def", url: "u", status: { status: "to do" } } },
  });
  try {
    const out = await clickup.createTask!({ token: "t", list_id: "L2" }, { title: "T", description: "D" });
    assert.equal(out.id, "def");
    assert.equal("assignees" in calls.find((c) => c.method === "POST")!.body, false);
  } finally { restore(); }
});

// PER-70 bug 2: a connector-linked ticket deleted locally used to respawn on the next sync, because
// syncWorkspace only checked "do we already track this external id" — never "was it deleted here on
// purpose". deletedExternals is the tombstone that closes that gap.
function stubClickupPull(taskId: string) {
  return stubFetch({
    "/list/LSYNC/task": { body: { tasks: [{ id: taskId, name: "Still open upstream", status: { status: "open" }, url: "u" }] } },
    [`/task/${taskId}/comment`]: { body: { comments: [] } },
  });
}

test("syncWorkspace mirrors in a new external task when it isn't tombstoned", async () => {
  const { restore } = stubClickupPull("tk-fresh");
  const ws = workspaces.create({
    slug: `sync-fresh-${randomSlug()}`, name: "SyncFresh", config_dir: "/tmp/sync-fresh",
    ticket_connector: "clickup", connector_config: { token: "t", list_id: "LSYNC" },
  });
  try {
    const res = await syncWorkspace(ws);
    assert.equal(res.created, 1);
    assert.ok(tickets.byExternal("clickup", "tk-fresh"));
  } finally {
    restore();
    workspaces.remove(ws.id);
  }
});

test("syncWorkspace refuses to respawn a ticket whose external id was deleted here on purpose", async () => {
  const { restore } = stubClickupPull("tk-deleted");
  const ws = workspaces.create({
    slug: `sync-tomb-${randomSlug()}`, name: "SyncTomb", config_dir: "/tmp/sync-tomb",
    ticket_connector: "clickup", connector_config: { token: "t", list_id: "LSYNC" },
  });
  deletedExternals.add(ws.id, "clickup", "tk-deleted");
  try {
    const res = await syncWorkspace(ws);
    assert.equal(res.created, 0);
    assert.equal(tickets.byExternal("clickup", "tk-deleted"), undefined);
  } finally {
    restore();
    workspaces.remove(ws.id);
  }
});

function randomSlug() {
  return Math.random().toString(36).slice(2, 10);
}

// A tracker's "won't do" is a decision, not a delivery: collapsing it to 'done' loses exactly the
// distinction the dismissed state exists to keep.
test("mapStatus separates dropped work from delivered work", () => {
  assert.equal(mapStatus("Won't Do"), "dismissed");
  assert.equal(mapStatus("wontfix"), "dismissed");
  assert.equal(mapStatus("Cancelled"), "dismissed");
  assert.equal(mapStatus("Closed"), "done");
  assert.equal(mapStatus("Complete"), "done");
});

// ACM-3's exact shape: closed here (the fix shipped days ago), still "in progress" in ClickUp.
// Nothing mirrors that back in on purpose — so the disagreement itself has to be readable.
test("isStatusDivergent: a local close contradicts a tracker that still shows it open", () => {
  assert.equal(isStatusDivergent({ status: "dismissed", external_status: "in progress" }), true);
  assert.equal(isStatusDivergent({ status: "done", external_status: "In Review" }), true);
  assert.equal(isStatusDivergent({ status: "in_progress", external_status: "To Do" }), true);
});

// Chronos has states no tracker has; collapsing them the way DEFAULT_STATUS_MAP does on the way out
// is what keeps "planning" vs "In Progress" from screaming contradiction on every active ticket.
test("isStatusDivergent: our finer vocabulary is not a contradiction", () => {
  assert.equal(isStatusDivergent({ status: "planning", external_status: "in progress" }), false);
  assert.equal(isStatusDivergent({ status: "planned", external_status: "In Progress" }), false);
  assert.equal(isStatusDivergent({ status: "shipping", external_status: "in review" }), false);
  assert.equal(isStatusDivergent({ status: "blocked", external_status: "In Progress" }), false);
  // Both sides agree it's over, even though they disagree on which kind of over.
  assert.equal(isStatusDivergent({ status: "dismissed", external_status: "Closed" }), false);
  assert.equal(isStatusDivergent({ status: "done", external_status: "Won't Do" }), false);
});

test("isStatusDivergent: nothing pulled yet is never divergent", () => {
  assert.equal(isStatusDivergent({ status: "done" }), false); // native ticket
  assert.equal(isStatusDivergent({ status: "done", external_status: null }), false);
  assert.equal(isStatusDivergent({ status: "done", external_status: "  " }), false);
  assert.equal(isStatusDivergent({ status: "legacy-unknown", external_status: "To Do" }), false);
});

// No tracker has our word for it — pushing a dismissal out has to say *something*, and a workspace
// whose tracker does have one overrides it.
test("dismissed pushes out as a close, overridable per workspace", () => {
  assert.equal(externalStatusFor("dismissed", {}), "done");
  assert.equal(externalStatusFor("dismissed", { status_map: { dismissed: "Won't do" } }), "Won't do");
});

test("clickup fetchTasks: list scope keeps the original single-request shape", async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    calls.push(String(u));
    return { ok: true, json: async () => ({ tasks: [{ id: "1" }] }) } as any;
  }) as any;
  try {
    const out = await clickupFetchTasks({ token: "t", list_id: "L1" });
    assert.equal(out.length, 1);
    assert.equal(calls.length, 1, "list scope must not page");
    assert.match(calls[0], /\/list\/L1\/task/);
    assert.match(calls[0], /include_closed=true/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("clickup fetchTasks: team scope pages to the end and filters by assignee", async () => {
  // The team endpoint pages at 100 and does not reliably send last_page — an empty/short page is
  // the terminator. Without the loop, team scope would silently sync only the first 100 tasks.
  const calls: string[] = [];
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })), [{ id: "b0" }], []];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    calls.push(url);
    const p = Number(new URL(url).searchParams.get("page") ?? 0);
    return { ok: true, json: async () => ({ tasks: pages[p] ?? [] }) } as any;
  }) as any;
  try {
    const out = await clickupFetchTasks({ token: "t", team_id: "T1", assignee_id: 42 });
    assert.equal(out.length, 101, "both pages collected");
    // 3, not 2: the loop terminates on an EMPTY page, not a short one. Breaking early on a short
    // page would save this request but assumes the API always fills a page to 100 — if it ever
    // returned fewer for any other reason we would silently drop the remainder. One extra request
    // per sync is the cheaper mistake.
    assert.equal(calls.length, 3, "one extra call to confirm the end");
    assert.match(calls[0], /\/team\/T1\/task/);
    assert.match(calls[0], /assignees%5B%5D=42|assignees\[\]=42/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("clickup fetchTasks: rejects a config with neither list_id nor team_id", async () => {
  await assert.rejects(() => clickupFetchTasks({ token: "t" }), /list_id.*team_id/);
});

// A dead token fails identically forever, so it is the one sync error that has to reach the operator
// instead of the log. These are the real strings the two connectors throw.
test("isCredentialError: a revoked token is told apart from a broken sync", () => {
  assert.ok(isCredentialError('clickup pull 401: {"err":"Token invalid","ECODE":"OAUTH_025"}'));
  assert.ok(isCredentialError("jira: 403 Forbidden"));
  assert.ok(isCredentialError("Unauthorized"));
  assert.ok(!isCredentialError("clickup pull 500: internal error"));
  assert.ok(!isCredentialError("fetch failed"));
  assert.ok(!isCredentialError("clickup connector needs { list_id } or { team_id, assignee_id }"));
});
