import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, tickets as store } from "../store.js";
import { updateTicket, lastLoggedHours } from "../tickets.js";
import { CONNECTORS, syncWorkspace, pushHours } from "./index.js";
import { isStatusDivergent } from "./types.js";
import type { Connector, ExternalTask } from "./types.js";

// CLAUDE.md: never hit a real backend/connector in tests. A stub registered on CONNECTORS gives
// syncWorkspace real end-to-end behavior (create/patch/status reconcile) without touching
// clickup.ts/jira.ts's network calls.
const STUB_NAME = "stub-mirror";

function stubConnector(pullResult: ExternalTask[]): Connector {
  return {
    name: STUB_NAME,
    pull: async () => pullResult,
    pushStatus: async () => {},
    addComment: async () => {},
  };
}

function extTask(over: Partial<ExternalTask> = {}): ExternalTask {
  return {
    id: "ext-" + randomUUID().slice(0, 6),
    title: "Imported from tracker",
    url: null,
    status: "in_progress",
    statusRaw: "in progress",
    updated: null,
    description: null,
    priority: null,
    assignee: null,
    labels: [],
    due: null,
    comments: [],
    ...over,
  };
}

const mkWs = () =>
  workspaces.create({
    slug: "mirror-" + randomUUID().slice(0, 8),
    name: "Mirror test ws",
    config_dir: `/tmp/mc-test/${randomUUID()}`,
    ticket_connector: STUB_NAME,
  } as any);

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

test("sync creates a brand-new mirror ticket with status_source 'external'", async () => {
  const ws = mkWs();
  const task = extTask({ status: "in_progress" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);

  const res = await syncWorkspace(ws);
  assert.equal(res.created, 1);

  const t = store.byExternal(STUB_NAME, task.id)!;
  assert.ok(t, "ticket was created");
  assert.equal(t.status, "in_progress");
  assert.equal(t.status_source, "external");
});

test("sync marks a tracker-driven status change on an existing ticket as 'external'", async () => {
  const ws = mkWs();
  const task = extTask({ status: "ready" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);
  await syncWorkspace(ws); // creates it at 'ready', status_source 'external'

  const created = store.byExternal(STUB_NAME, task.id)!;
  assert.equal(created.status, "ready");

  // Tracker moves it to in_progress on the next pull. 'ready' isn't LOCAL_OWNED, so the mirror
  // reconciles the status — and it must stay tagged 'external'.
  CONNECTORS[STUB_NAME] = stubConnector([{ ...task, status: "in_progress", statusRaw: "in progress" }]);
  const res2 = await syncWorkspace(ws);
  assert.equal(res2.updated, 1);

  const t = store.byExternal(STUB_NAME, task.id)!;
  assert.equal(t.status, "in_progress");
  assert.equal(t.status_source, "external");
});

test("sync never overwrites a LOCAL_OWNED status (planning/planned/in_progress/review) — status_source untouched either", async () => {
  const ws = mkWs();
  const task = extTask({ status: "in_progress" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);
  await syncWorkspace(ws);

  // Chronos starts real work on it: dispatch flips status AND status_source to 'local' (the choke
  // point in updateTicket — this simulates what dispatchPlan/dispatchTicket do before calling
  // dispatch(), without invoking the real executor per CLAUDE.md).
  const mirror = store.byExternal(STUB_NAME, task.id)!;
  updateTicket(mirror.id, { status: "planning" });
  assert.equal(store.get(mirror.id)!.status_source, "local", "dispatch choke point flips mirror → local");

  // Tracker reports a DIFFERENT status (e.g. still shows "in progress" while Chronos moved to
  // 'planning', a LOCAL_OWNED state) — sync must not downgrade it, and must not touch status_source.
  CONNECTORS[STUB_NAME] = stubConnector([{ ...task, status: "in_progress", statusRaw: "in progress" }]);
  await syncWorkspace(ws);

  const after = store.get(mirror.id)!;
  assert.equal(after.status, "planning", "LOCAL_OWNED protection is untouched by this feature");
  assert.equal(after.status_source, "local", "sync must not re-tag a LOCAL_OWNED ticket as external");
});

test("dispatching real work on a mirror ticket flips it to 'local' automatically (the choke point)", async () => {
  const ws = mkWs();
  const task = extTask({ status: "in_progress" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);
  await syncWorkspace(ws);
  const mirror = store.byExternal(STUB_NAME, task.id)!;
  assert.equal(mirror.status_source, "external");

  // dispatchPlan/dispatchTicket patch `status` through updateTicket before calling dispatch() (which
  // runs the executor synchronously — CLAUDE.md gotcha #1) — exercising that same patch here is the
  // real choke-point behavior without spawning an agent.
  const updated = updateTicket(mirror.id, { status: "in_progress" })!;
  assert.equal(updated.status_source, "local");
});

// The ACM-3 shape: Chronos closed it, the tracker never got the memo. Sync deliberately mirrors
// nothing here (we don't reopen, we don't write back) — the whole point is that the disagreement
// still leaves a trace instead of reading as an open P1 for days.
test("sync keeps the tracker's label on a ticket Chronos already closed, making the divergence readable", async () => {
  const ws = mkWs();
  const task = extTask({ status: "in_progress", statusRaw: "in progress" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);
  await syncWorkspace(ws);
  const mirror = store.byExternal(STUB_NAME, task.id)!;
  assert.equal(mirror.external_status, "in progress", "the create path stamps the tracker's own label");

  // Chronos dismisses it locally (the fix shipped / the call was made). The tracker still says
  // "in progress" on the next pull.
  updateTicket(mirror.id, { status: "dismissed" });
  CONNECTORS[STUB_NAME] = stubConnector([{ ...task, status: "in_progress", statusRaw: "In Progress" }]);
  await syncWorkspace(ws);

  const after = store.get(mirror.id)!;
  assert.equal(after.status, "dismissed", "a local close is never reopened by a pull");
  assert.equal(after.status_source, "local");
  assert.equal(after.external_status, "In Progress", "the tracker's current label is kept as data");
  assert.equal(isStatusDivergent(after), true, "and the contradiction is derivable from the row");
});

test("sync doesn't re-patch a ticket whose tracker label hasn't moved", async () => {
  const ws = mkWs();
  const task = extTask({ status: "ready", statusRaw: "To Do" });
  CONNECTORS[STUB_NAME] = stubConnector([task]);
  await syncWorkspace(ws);
  const created = store.byExternal(STUB_NAME, task.id)!;

  // Same label, same everything: no patch at all. Every patch bumps updated_at, which orders every
  // board and "recently done" list — a status column we write on every 30m pull would reshuffle them.
  const res = await syncWorkspace(ws);
  assert.equal(res.updated, 0, "an unchanged label is not an update");
  assert.equal(store.get(created.id)!.updated_at, created.updated_at, "updated_at untouched");
});

test("a title/priority-only sync patch leaves status_source alone", async () => {
  const ws = mkWs();
  const task = extTask({ status: "planning" as any }); // sync never sets planning; use LOCAL_OWNED to freeze status
  // Create directly as LOCAL_OWNED + external so only title changes on the next pull.
  CONNECTORS[STUB_NAME] = stubConnector([{ ...task, status: "ready" }]);
  await syncWorkspace(ws);
  const created = store.byExternal(STUB_NAME, task.id)!;
  updateTicket(created.id, { status: "in_progress" }); // now LOCAL_OWNED + status_source local

  CONNECTORS[STUB_NAME] = stubConnector([{ ...task, status: "in_progress", statusRaw: "in progress", title: "Renamed upstream" }]);
  await syncWorkspace(ws);

  const after = store.get(created.id)!;
  assert.equal(after.title, "Renamed upstream", "title still mirrors");
  assert.equal(after.status_source, "local", "a non-status patch must not touch status_source");
});

test("pushHours writes the tracker's hours field and mirrors it into the work log", async () => {
  const ws = workspaces.create({
    slug: "hours-" + randomUUID().slice(0, 8),
    name: "Hours test ws",
    config_dir: `/tmp/mc-test/${randomUUID()}`,
    ticket_connector: STUB_NAME,
    connector_config: JSON.stringify({ base_url: "https://example.invalid" }),
  } as any);
  const task = extTask();
  const seen: Array<[string, number]> = [];
  CONNECTORS[STUB_NAME] = { ...stubConnector([task]), setHours: async (_c, id, h) => { seen.push([id, h]); } };
  await syncWorkspace(ws);
  const t = store.byExternal(STUB_NAME, task.id)!;

  const r = await pushHours(t, 3.5);
  assert.deepEqual(seen, [[task.id, 3.5]], "hours went out to the connector");
  assert.equal(r.hours, 3.5);
  // The Done-push fallback reads hours back off the work log, so the two must agree.
  assert.equal(lastLoggedHours(store.get(t.id)!), 3.5);
});

test("pushHours refuses a connector with no hours field instead of silently no-op'ing", async () => {
  const ws = workspaces.create({
    slug: "nohours-" + randomUUID().slice(0, 8),
    name: "No hours ws",
    config_dir: `/tmp/mc-test/${randomUUID()}`,
    ticket_connector: STUB_NAME,
    connector_config: JSON.stringify({}),
  } as any);
  const task = extTask();
  CONNECTORS[STUB_NAME] = stubConnector([task]); // no setHours
  await syncWorkspace(ws);
  const t = store.byExternal(STUB_NAME, task.id)!;

  await assert.rejects(() => pushHours(t, 2), /no hours field/);
});
