import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { activity, db, workspaces } from "./store.js";
import { callerScope } from "./authz.js";
import { scopedActivity } from "./api.js";

beforeEach(() => {
  db.exec("DELETE FROM activity; DELETE FROM workspaces;");
});

function fakeReq(headers: Record<string, string> = {}): any {
  return { get: (h: string) => headers[h.toLowerCase()] };
}

function seed() {
  const a = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const b = workspaces.create({ slug: "beta", name: "Beta", config_dir: "/tmp/beta" });
  activity.add({ topic: "session.input", actor: "operator", workspace_id: a.id, entity: "s-a", detail: '{"text":"acme typed"}' });
  activity.add({ topic: "session.input", actor: "operator", workspace_id: b.id, entity: "s-b", detail: '{"text":"beta typed"}' });
  activity.add({ topic: "host.offline", actor: "system", workspace_id: null, entity: "h1", detail: "{}" });
  return { a, b };
}

test("a workspace token reads only its own workspace's activity, whatever ?workspace= says", () => {
  const { a, b } = seed();
  const scope = callerScope(fakeReq({ "x-mc-workspace-token": a.token }))!;
  for (const q of [{}, { workspace: b.id }, { topic: "session.input" }, { entity: "s-b" }]) {
    const rows = scopedActivity(scope, q);
    assert.ok(rows.every((r) => r.workspace_id === a.id), `query ${JSON.stringify(q)} leaked another workspace's rows`);
  }
  assert.deepEqual(scopedActivity(scope, {}).map((r) => r.entity), ["s-a"]);
  assert.deepEqual(scopedActivity(scope, { entity: "s-b" }), [], "naming the other workspace's entity finds nothing");
});

test("the admin token still reads every workspace, and can filter to one", () => {
  const { b } = seed();
  const scope = callerScope(fakeReq({ "x-mc-admin": CONFIG.adminToken }))!;
  assert.equal(scopedActivity(scope, {}).length, 3);
  assert.deepEqual(scopedActivity(scope, { workspace: b.id }).map((r) => r.entity), ["s-b"]);
});
