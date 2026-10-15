import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces } from "../store.js";

beforeEach(() => {
  db.exec("DELETE FROM workspaces;");
});

test("default_dir round-trips through create, update, and clear", () => {
  const w = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme", default_dir: "/tmp/acme-repos" });
  assert.equal(w.default_dir, "/tmp/acme-repos");

  // Patching an unrelated field leaves it alone.
  assert.equal(workspaces.update(w.id, { name: "Acme Inc" })!.default_dir, "/tmp/acme-repos");

  assert.equal(workspaces.update(w.id, { default_dir: "/tmp/elsewhere" })!.default_dir, "/tmp/elsewhere");
  assert.equal(workspaces.update(w.id, { default_dir: null })!.default_dir, null);
});

test("default_dir defaults to null when omitted", () => {
  const w = workspaces.create({ slug: "bare", name: "Bare", config_dir: "/tmp/bare" });
  assert.equal(w.default_dir, null);
});
