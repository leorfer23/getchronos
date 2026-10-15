import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, resolveNotesDir } from "./repo-root.js";
import { CONFIG } from "./config.js";

const under = (p: string, dir: string) => !path.relative(dir, p).startsWith("..") && !path.isAbsolute(path.relative(dir, p));

test("under the test suite the notes mirror never lands in the checkout", () => {
  assert.equal(process.env.CHRONOS_TEST, "1", "npm test sets CHRONOS_TEST=1");
  if (process.env.CHRONOS_NOTES_DIR || process.env.CHRONOS_HOME) return;
  assert.ok(!under(CONFIG.notesDir, REPO_ROOT), `${CONFIG.notesDir} is inside ${REPO_ROOT}`);
  assert.ok(under(CONFIG.notesDir, os.tmpdir()));
});

test("resolveNotesDir: explicit override, test temp dir, repo default", () => {
  const root = "/srv/chronos";
  assert.equal(resolveNotesDir({ CHRONOS_NOTES_DIR: "/x/notes", CHRONOS_TEST: "1" }, root), "/x/notes");
  assert.equal(resolveNotesDir({ CHRONOS_TEST: "1" }, root), path.join(os.tmpdir(), `chronos-test-notes-${process.pid}`));
  assert.equal(resolveNotesDir({ NODE_TEST_CONTEXT: "child" }, root), path.join(os.tmpdir(), `chronos-test-notes-${process.pid}`));
  assert.equal(resolveNotesDir({ CHRONOS_TEST: "1", CHRONOS_HOME: root }, root), path.join(root, "notes"));
  assert.equal(resolveNotesDir({}, root), path.join(root, "notes"));
});

test("createNote writes its mirror file under CONFIG.notesDir, not the repo", async () => {
  const { workspaces } = await import("./store.js");
  const { createNote } = await import("./notes.js");
  const slug = `notesdir-${process.pid}-${Date.now().toString(36)}`;
  const ws = workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });
  const n = createNote({ workspace_id: ws.id, title: "leak check", body: "x" });
  assert.ok(under(n.file_path, CONFIG.notesDir), `${n.file_path} not under ${CONFIG.notesDir}`);
  if (!process.env.CHRONOS_NOTES_DIR && !process.env.CHRONOS_HOME) assert.ok(!under(n.file_path, REPO_ROOT));
});
