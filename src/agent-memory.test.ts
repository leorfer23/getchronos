import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// notes.ts resolves <repo>/notes/<ws-slug>/<slug>.md at module load, and persona memory lives in
// the workspace slug `personal` — the operator's REAL one. Without an isolated root these cases
// write into the live vault, and a note titled "Operator profile" lands squarely on the real
// operator-profile.md. Point CHRONOS_HOME at a temp dir FIRST, then import: a static import would
// evaluate src/repo-root.ts before the assignment ran.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agent-memory-"));

const { db, workspaces, notes: noteStore } = await import("./store.js");
const { createNote, updateNote } = await import("./notes.js");
const {
  agentMemoryBlock,
  agentMemoryNote,
  agentMemoryStamp,
  isMemoryAgent,
  rememberFact,
  rewriteMemory,
} = await import("./agent-memory.js");

// Persona memory always lives in the `personal` workspace — recreate it for every case.
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM workspaces;");
  workspaces.create({ slug: "personal", name: "Personal", config_dir: "/tmp/mc-test/personal" });
});

test("the isolated root actually took — no writes land in the real vault", () => {
  rememberFact("robert", "canary");
  assert.match(agentMemoryNote("robert")!.file_path, /mc-agent-memory-/);
});

test("only the named personas have a memory", () => {
  for (const a of ["robert"]) assert.ok(isMemoryAgent(a));
  assert.equal(isMemoryAgent("../../etc/passwd"), false);
  assert.equal(isMemoryAgent("claude"), false);
  // An id with no agents/<id>/ directory owns no memory, so the persona endpoint stops claiming an
  // owner for it. The generic note mechanics still work through any id — which is why the cases
  // below can keep using made-up ones.
  for (const a of ["ada", "nils", "iris"]) assert.equal(isMemoryAgent(a), false);
});

test("memory note is created once and found again by slug", () => {
  const first = agentMemoryNote("ada")!;
  assert.equal(first.slug, "memory-ada");
  // Second call must reuse the same row — a slug mismatch would mint a new note per turn and the
  // agent would silently forget everything it wrote.
  assert.equal(agentMemoryNote("ada")!.id, first.id);
  assert.equal(noteStore.list(first.workspace_id).filter((n) => n.slug === "memory-ada").length, 1);
});

test("no note until something is written, and reading never creates one", () => {
  assert.equal(agentMemoryStamp("nobody"), "");
  assert.equal(agentMemoryNote("nobody", false), null);
  assert.equal(agentMemoryBlock("nobody"), "");
});

test("appended facts come back in the injected block and move the stamp", () => {
  rememberFact("ada", "the operator lives in Buenos Aires, UTC-3.", "Basics");
  const stamp = agentMemoryStamp("ada");
  assert.notEqual(stamp, "");

  const block = agentMemoryBlock("ada");
  assert.match(block, /Your memory/);
  assert.match(block, /Buenos Aires/);
  assert.match(block, /## Basics/);

  rememberFact("ada", "He hates being asked twice.");
  assert.match(agentMemoryBlock("ada"), /asked twice/);
  assert.notEqual(agentMemoryStamp("ada"), stamp); // stamp change is what recycles the warm process
});

test("rewrite replaces the whole file", () => {
  rememberFact("iris", "stale fact");
  rewriteMemory("iris", "# Memory — iris\n\n## Facts\n- fresh fact\n");
  const block = agentMemoryBlock("iris");
  assert.match(block, /fresh fact/);
  assert.doesNotMatch(block, /stale fact/);
});

test("memories are private to their agent, but the global operator profile is shared", () => {
  rememberFact("ada", "ada-only-fact");
  rememberFact("nils", "nils-only-fact");
  assert.doesNotMatch(agentMemoryBlock("ada"), /nils-only-fact/);
  assert.doesNotMatch(agentMemoryBlock("nils"), /ada-only-fact/);

  const ws = workspaces.getBySlug("personal")!;
  const profile = createNote({ workspace_id: ws.id, title: "Operator profile", body: "the operator prefers short answers." });
  updateNote(profile.id, { scope: "global", context: true });
  assert.match(agentMemoryBlock("ada"), /the operator prefers short answers/);
  assert.match(agentMemoryBlock("nils"), /the operator prefers short answers/);
});

test("a persona memory is never ★context — it must not leak into workspace agents", () => {
  rememberFact("robert", "robert-only-fact");
  assert.equal(agentMemoryNote("robert")!.context, 0);
});
