import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, workspaceVars } from "../store.js";
import { nameError, expiryFromHours } from "./workspace-vars.js";

let wsId = "";
let otherId = "";
beforeEach(() => {
  db.exec("DELETE FROM workspace_vars; DELETE FROM workspaces;");
  wsId = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" }).id;
  otherId = workspaces.create({ slug: "other", name: "Other", config_dir: "/tmp/other" }).id;
});

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

test("a var is set, listed without its value, and read back by active()", () => {
  const v = workspaceVars.set(wsId, "X_TOKEN", "s3cret", hoursFromNow(12));
  assert.equal(v.name, "X_TOKEN");
  assert.equal((v as any).value, undefined, "the value must never leave the store in a list shape");
  assert.equal(v.length, 6);
  assert.deepEqual(workspaceVars.active(wsId), { X_TOKEN: "s3cret" });
  assert.deepEqual(workspaceVars.list(wsId).map((x) => x.name), ["X_TOKEN"]);
});

test("vars are per-workspace — one client's token is invisible to another", () => {
  workspaceVars.set(wsId, "X_TOKEN", "acme-only", null);
  assert.deepEqual(workspaceVars.active(otherId), {});
  assert.deepEqual(workspaceVars.list(otherId), []);
});

test("re-setting a name rotates the value in place rather than duplicating it", () => {
  const a = workspaceVars.set(wsId, "X_TOKEN", "old", null);
  const b = workspaceVars.set(wsId, "X_TOKEN", "new", hoursFromNow(3));
  assert.equal(a.id, b.id);
  assert.equal(workspaceVars.list(wsId).length, 1);
  assert.deepEqual(workspaceVars.active(wsId), { X_TOKEN: "new" });
});

test("an expired var is gone from active() AND deleted from disk", () => {
  workspaceVars.set(wsId, "GONE", "expired-value", new Date(Date.now() - 1000).toISOString());
  workspaceVars.set(wsId, "STAYS", "live-value", null);
  assert.deepEqual(workspaceVars.active(wsId), { STAYS: "live-value" });
  // Purged, not merely filtered: an expired credential must stop existing, not sit in the DB.
  assert.equal((db.prepare("SELECT count(*) c FROM workspace_vars").get() as { c: number }).c, 1);
});

test("patch re-arms or clears the clock without touching the value", () => {
  const v = workspaceVars.set(wsId, "X_TOKEN", "keep-me", hoursFromNow(1));
  workspaceVars.patch(v.id, { expires_at: null });
  assert.equal(workspaceVars.list(wsId)[0].expires_at, null);
  assert.deepEqual(workspaceVars.active(wsId), { X_TOKEN: "keep-me" });

  workspaceVars.patch(v.id, { value: "rotated" });
  assert.deepEqual(workspaceVars.active(wsId), { X_TOKEN: "rotated" });
  assert.equal(workspaceVars.list(wsId)[0].expires_at, null, "patching the value must not re-add an expiry");
});

test("deleting a workspace takes its shared vars with it", () => {
  workspaceVars.set(wsId, "X_TOKEN", "s3cret", null);
  workspaces.remove(wsId);
  assert.equal((db.prepare("SELECT count(*) c FROM workspace_vars").get() as { c: number }).c, 0);
});

test("names that would break a spawn or impersonate the daemon are refused", () => {
  assert.equal(nameError("X_TOKEN"), null);
  assert.equal(nameError("_x1"), null);
  assert.ok(nameError("PATH"), "PATH would take down every terminal in the workspace");
  assert.ok(nameError("home"), "reserved check is case-insensitive");
  assert.ok(nameError("MC_TICKET"), "MC_* is how the daemon tells an agent who it is");
  assert.ok(nameError("2FA"));
  assert.ok(nameError("HAS SPACE"));
  assert.ok(nameError("has-dash"));
});

test("expiryFromHours: null means no expiration at all", () => {
  assert.equal(expiryFromHours(null), null);
  assert.equal(expiryFromHours(undefined), null);
  const iso = expiryFromHours(12)!;
  const drift = Math.abs(Date.parse(iso) - (Date.now() + 12 * 3600_000));
  assert.ok(drift < 5000, `expected ~12h from now, drifted ${drift}ms`);
});
