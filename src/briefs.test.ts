import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation as agent-memory.test.ts: notes resolve <repo>/notes/<ws>/<slug>.md at module load,
// and a brief is a real note in a real workspace — point CHRONOS_HOME at a temp dir before importing.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-briefs-"));

const { db, workspaces } = await import("./store.js");
const { BRIEF_SEED, BRIEF_SLUG, appendBrief, briefNote, briefStamp, briefsBlock, listBriefs, rewriteBrief } = await import("./briefs.js");

let acme = "", globex = "";
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM workspaces;");
  acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/mc-test/acme" }).id;
  globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/mc-test/globex" }).id;
});

test("a brief is one note per workspace, seeded with the sections, created on first write", () => {
  assert.equal(briefNote(acme, false), null);
  const n = appendBrief(acme, "Abby signs off every PR", "How work is done here");
  assert.equal(n.slug, BRIEF_SLUG);
  assert.equal(n.workspace_id, acme);
  assert.match(n.body, /## What the operator wants \(goals\)/);
  assert.match(n.body, /## How work is done here\nAbby signs off every PR/);
  assert.match(n.file_path, /mc-briefs-/);
});

test("the prompt block carries only written briefs — a seed page is not an understanding", () => {
  assert.equal(briefsBlock(null), "");
  rewriteBrief(globex, BRIEF_SEED);
  assert.equal(briefsBlock(null), "", "an untouched seed says nothing");
  rewriteBrief(acme, "# Robert — brief\n\n## What the operator wants (goals)\nShip the menu report by Friday\n");
  const all = briefsBlock(null);
  assert.match(all, /YOUR STANDING UNDERSTANDING/);
  assert.match(all, /### Acme \(workspace /);
  assert.match(all, /Ship the menu report by Friday/);
  assert.doesNotMatch(all, /Globex/);
  // Scoped to a workspace: that page only.
  assert.doesNotMatch(briefsBlock(globex), /Acme/);
  assert.match(briefsBlock(acme), /Acme/);
});

test("the stamp moves on every write, so a warm Robert recycles at the next turn", () => {
  const before = briefStamp();
  appendBrief(acme, "2026-09-11 · shipped the tray blanking export", "Recently");
  assert.notEqual(briefStamp(), before);
  assert.equal(listBriefs().filter((b) => b.note).length, 1);
});
