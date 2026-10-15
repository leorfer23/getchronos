import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { REPO_ROOT, resolveStateDir, resolveTicketsDir, resolveAttachmentsDir } from "./repo-root.js";

const under = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};
const free = !process.env.CHRONOS_HOME;

test("resolveStateDir: explicit override, test temp dir, repo default", () => {
  const root = "/srv/chronos";
  const tmp = (n: string) => path.join(os.tmpdir(), `chronos-test-${n}-${process.pid}`);
  for (const [name, fn, v] of [
    ["tickets", resolveTicketsDir, "CHRONOS_TICKETS_DIR"],
    ["attachments", resolveAttachmentsDir, "CHRONOS_ATTACHMENTS"],
  ] as const) {
    assert.equal(fn({ [v]: "/x/y", CHRONOS_TEST: "1" }, root), "/x/y");
    assert.equal(fn({ [v]: "/x/y" }, root), "/x/y");
    assert.equal(fn({ CHRONOS_TEST: "1" }, root), tmp(name));
    assert.equal(fn({ NODE_TEST_CONTEXT: "child" }, root), tmp(name));
    assert.equal(fn({ CHRONOS_TEST: "1", CHRONOS_HOME: root }, root), path.join(root, name));
    assert.equal(fn({}, root), path.join(root, name));
  }
  assert.equal(resolveStateDir("x", "X_DIR", { X_DIR: "" }, root), path.join(root, "x"), "empty override is unset");
});

test("under the test suite wsTicketsDir and ATTACH_ROOT never land in the checkout", async () => {
  const { wsTicketsDir } = await import("./sandbox.js");
  const { ATTACH_ROOT } = await import("./attachments.js");
  if (free && !process.env.CHRONOS_TICKETS_DIR) {
    assert.ok(!under(wsTicketsDir("x"), REPO_ROOT), `${wsTicketsDir("x")} is inside ${REPO_ROOT}`);
    assert.ok(under(wsTicketsDir("x"), os.tmpdir()));
  }
  if (free && !process.env.CHRONOS_ATTACHMENTS) {
    assert.ok(!under(ATTACH_ROOT, REPO_ROOT), `${ATTACH_ROOT} is inside ${REPO_ROOT}`);
    assert.ok(under(ATTACH_ROOT, os.tmpdir()));
  }
});

test("a no-repo ticket's markdown file lands outside the checkout", async () => {
  const { workspaces } = await import("./store.js");
  const { createTicket } = await import("./tickets.js");
  const slug = `sdirs-${randomUUID().slice(0, 8)}`;
  const ws = workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });
  const t = createTicket({ workspace_id: ws.id, title: "leak check" });
  if (free && !process.env.CHRONOS_TICKETS_DIR) assert.ok(!under(t.file_path, REPO_ROOT), `${t.file_path} is inside ${REPO_ROOT}`);
});
