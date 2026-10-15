import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { kv, tickets, workspaces } from "./store.js";
import {
  composeWritebackComment,
  proposeWriteback,
  decideWriteback,
  getProposal,
  startWriteback,
} from "./writeback.js";

// Fake fetch: routes by URL substring, records every call. Same shape as connectors/sync.test.ts's
// stubFetch — the write-back push must never touch the real network in tests.
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

let n = 0;
function seedClickupTicket(over: Partial<{ report: string | null; summary: string | null; pr_url: string | null; status: string }> = {}) {
  n++;
  const ws = workspaces.create({
    slug: `wb-${n}-${randomUUID().slice(0, 6)}`,
    name: `WB ${n}`,
    config_dir: `/tmp/wb-${n}`,
    ticket_connector: "clickup",
    connector_config: { token: "tok-123", list_id: "list-1" },
  } as any);
  const key = `WB-${n}`;
  const t = tickets.create({
    id: randomUUID(),
    workspace_id: ws.id,
    repo_id: null,
    key,
    slug: key.toLowerCase(),
    title: `Ticket ${n}`,
    status: "review",
    priority: "P2",
    complexity: null,
    backend: null,
    model: null,
    assignee: "agent",
    file_path: `/tmp/wb-${n}/${key}.md`,
    external_system: "clickup",
    external_id: String(1000 + n),
    external_url: `https://app.clickup.com/t/${1000 + n}`,
    tags: null,
  } as any);
  // Store-level update: sets report/summary/pr_url/status without touching the filesystem or the bus
  // (tickets.ts's service-layer updateTicket does both — irrelevant to what write-back itself does).
  tickets.update(t.id, {
    report: over.report ?? "Implemented the thing end to end; tests green.",
    summary: over.summary ?? null,
    pr_url: over.pr_url === undefined ? "https://github.com/acme/repo/pull/42" : over.pr_url,
    status: (over.status ?? "done") as any,
  } as any);
  return { ws, t: tickets.get(t.id)! };
}

test("composeWritebackComment: title + report + PR link, no LLM involved", () => {
  const text = composeWritebackComment({
    title: "Fix the flaky login test",
    report: "Root-caused a race in the session setup; added a retry.",
    summary: null,
    pr_url: "https://github.com/acme/repo/pull/7",
  });
  assert.match(text, /Fix the flaky login test/);
  assert.match(text, /Root-caused a race/);
  assert.match(text, /PR: https:\/\/github\.com\/acme\/repo\/pull\/7/);
});

test("composeWritebackComment: falls back to summary, then just the title", () => {
  const withSummary = composeWritebackComment({ title: "T1", report: null, summary: "One-line summary.", pr_url: null });
  assert.match(withSummary, /One-line summary\./);
  assert.doesNotMatch(withSummary, /PR:/);

  const bare = composeWritebackComment({ title: "T2", report: null, summary: null, pr_url: null });
  assert.match(bare, /T2/);
  assert.doesNotMatch(bare, /PR:/);
});

test("proposeWriteback composes + persists to kv; a second call is a no-op (idempotent)", async () => {
  const { t } = seedClickupTicket();
  const p = await proposeWriteback(t);
  assert.ok(p, "a proposal was made");
  assert.equal(p!.decision, "proposed");
  assert.equal(p!.ticketKey, t.key);
  assert.equal(p!.targetStatus, "done"); // clickup's DEFAULT_STATUS_MAP for local 'done'
  assert.match(p!.comment, new RegExp(t.title));

  const stored = getProposal(t.id);
  assert.deepEqual(stored, p, "kv holds exactly what was proposed");

  const again = await proposeWriteback(t);
  assert.equal(again, null, "a ticket already asked about is not re-proposed");
});

test("proposeWriteback: nothing to propose without an external link, or with the killswitch off", async () => {
  const { t } = seedClickupTicket();

  const nativeWs = workspaces.create({ slug: `wb-native-${randomUUID().slice(0, 6)}`, name: "Native", config_dir: "/tmp/wb-native" } as any);
  const native = tickets.create({
    id: randomUUID(), workspace_id: nativeWs.id, repo_id: null, key: "NAT-1", slug: "nat-1", title: "no tracker",
    status: "done", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/wb-native/NAT-1.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  assert.equal(await proposeWriteback(native), null, "no external_system/external_id → nothing to propose");

  const before = CONFIG.writebackCard;
  CONFIG.writebackCard = false;
  try {
    assert.equal(await proposeWriteback(t), null, "killswitch off → nothing proposed");
    assert.equal(getProposal(t.id), undefined);
  } finally {
    CONFIG.writebackCard = before;
  }
});

test("decideWriteback: decline records the decision in kv and never touches the network", async () => {
  const { t } = seedClickupTicket();
  await proposeWriteback(t);
  const { calls, restore } = stubFetch({});
  try {
    const out = await decideWriteback(t.id, false);
    assert.match(out, /Skipped/);
    assert.equal(getProposal(t.id)!.decision, "declined");
    assert.equal(calls.length, 0, "declining must never call the tracker");

    const again = await decideWriteback(t.id, false);
    assert.match(again, /Already skipped/);
  } finally { restore(); }
});

test("decideWriteback: approve pushes a comment + status close via the tracker's real connector (fetch stubbed)", async () => {
  const { t } = seedClickupTicket();
  const p = await proposeWriteback(t);
  const { calls, restore } = stubFetch({
    [`/task/${t.external_id}/comment`]: { body: {} },
    [`/task/${t.external_id}`]: { body: {} },
  });
  try {
    const out = await decideWriteback(t.id, true);
    assert.match(out, /^✅ Pushed/);
    assert.match(out, /comment \+ closed/);

    const comment = calls.find((c) => c.url.endsWith(`/task/${t.external_id}/comment`) && c.method === "POST");
    assert.ok(comment, "posted a comment to the clickup task");
    assert.equal(comment!.body.comment_text, p!.comment);

    const status = calls.find((c) => c.url.endsWith(`/task/${t.external_id}`) && c.method === "PUT");
    assert.ok(status, "pushed the mapped status");
    assert.equal(status!.body.status, "done");

    const stored = getProposal(t.id)!;
    assert.equal(stored.decision, "approved");
    assert.equal(stored.error, undefined);

    // Approving twice must not push again.
    const again = await decideWriteback(t.id, true);
    assert.match(again, /Already pushed/);
    assert.equal(calls.length, 2, "no additional network calls on a repeat approve");
  } finally { restore(); }
});

test("decideWriteback: a push failure is reported and leaves the proposal re-executable", async () => {
  const { t } = seedClickupTicket();
  await proposeWriteback(t);
  const { calls, restore } = stubFetch({
    [`/task/${t.external_id}/comment`]: { status: 500, body: { err: "clickup is down" } },
  });
  try {
    const out = await decideWriteback(t.id, true);
    assert.match(out, /^⚠️ Push to clickup failed/);

    const stored = getProposal(t.id)!;
    assert.equal(stored.decision, "failed");
    assert.ok(stored.error, "the error is kept for the retry card");
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "status push never ran — the comment failed first");
  } finally { restore(); }

  // Re-executable: with the tracker back up, tapping ✅ again succeeds without re-proposing.
  const { calls: calls2, restore: restore2 } = stubFetch({
    [`/task/${t.external_id}/comment`]: { body: {} },
    [`/task/${t.external_id}`]: { body: {} },
  });
  try {
    const retry = await decideWriteback(t.id, true);
    assert.match(retry, /^✅ Pushed/);
    assert.equal(getProposal(t.id)!.decision, "approved");
    assert.ok(calls2.length >= 2);
  } finally { restore2(); }
});

test("choke point: a ticket.updated status:done bus event proposes a write-back", async () => {
  startWriteback(); // idempotent-ish: registers a bus listener; fine to call once for the whole file
  const { t, ws } = seedClickupTicket();
  bus.publish({ topic: "ticket.updated", ticket_id: t.id, status: "done", workspace_id: ws.id });
  // The listener fires async (proposeWriteback is awaited internally but not by the publisher) —
  // give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 20));
  const p = getProposal(t.id);
  assert.ok(p, "the done transition produced a write-back proposal");
  assert.equal(p!.decision, "proposed");
});

test("choke point: a connector-sync-originated done is not echoed back as a write-back", async () => {
  startWriteback();
  const { t, ws } = seedClickupTicket();
  bus.publish({ topic: "ticket.updated", ticket_id: t.id, status: "done", workspace_id: ws.id, actor: "connector-sync" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getProposal(t.id), undefined, "a status the tracker itself reported must not be proposed back to it");
});
