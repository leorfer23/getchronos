import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated vault root before the first import — see agent-memory.test.ts.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-memory-budget-"));

const { db, workspaces } = await import("./store.js");
const { CONFIG } = await import("./config.js");
const { createNote, updateNote } = await import("./notes.js");
const { rewriteMemory } = await import("./agent-memory.js");
const { agentBudget, estimateTokens, report } = await import("./memory-budget.js");
const { loadAgentsFrom } = await import("./agent-defs.js");

let wsId = "";
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM workspaces;");
  wsId = workspaces.create({ slug: "personal", name: "Personal", config_dir: "/tmp/mc-test/personal" }).id;
});

test("the estimate is stable, conservative and byte-based", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 2); // ceil, never round down into a false fit
  // Multi-byte prose costs what it costs on the wire, not what .length says.
  assert.equal(estimateTokens("—"), 1);
  assert.ok(estimateTokens("x".repeat(400)) > estimateTokens("x".repeat(399)) - 1);
});

test("the report counts every file that loads on every turn, and nothing else", () => {
  rewriteMemory("ada", "# Memory — ada\n\n## Facts\n- a fact\n");
  const profile = createNote({ workspace_id: wsId, title: "Operator profile", body: "short answers, please." });
  updateNote(profile.id, { scope: "global", context: true });
  // A workspace memo that is not ★context reaches no prompt, so it is not part of the budget.
  createNote({ workspace_id: wsId, title: "Session learnings", body: "- something long ".repeat(50) });

  const r = report("ada");
  assert.deepEqual(r.files.map((f) => path.basename(f.path)).sort(), ["memory-ada.md", "operator-profile.md"]);
  // The operator's own profile is counted but never editable by the pass.
  assert.deepEqual(r.files.map((f) => f.editable), [true, false]);
  assert.equal(r.total, r.files.reduce((n, f) => n + f.tokens, 0));
  assert.equal(r.over, 0);
  assert.equal(r.budget, CONFIG.memoryBudgetTokens);
});

test("over is the shortfall, not a boolean", () => {
  rewriteMemory("ada", `# Memory — ada\n\n${"- a reasonably wordy durable fact\n".repeat(40)}`);
  const before = CONFIG.memoryBudgetTokens;
  CONFIG.memoryBudgetTokens = 100;
  const r = report("ada");
  CONFIG.memoryBudgetTokens = before;
  assert.ok(r.total > 100);
  assert.equal(r.over, r.total - 100);
});

test("an agent with no memory file reports zero, not a missing file", () => {
  const r = report("nobody");
  assert.deepEqual(r.files, []);
  assert.equal(r.total, 0);
  assert.equal(r.over, 0);
});

test("AGENT.md may lower its own ceiling, and a malformed one is loud", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agents-budget-"));
  const write = (id: string, fm: string) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, "AGENT.md"), `---\nname: ${id}\ndescription: fixture\n${fm}---\nbody\n`);
  };
  write("thrifty", "memory_budget: 1200\n");
  write("plain", "");
  const defs = loadAgentsFrom(dir);
  assert.equal(defs.get("thrifty")!.memoryBudget, 1200);
  assert.equal(defs.get("plain")!.memoryBudget, null);

  write("broken", "memory_budget: lots\n");
  assert.throws(() => loadAgentsFrom(dir), /memory_budget must be a positive integer/);

  // An agent nobody declared falls back to the daemon-wide budget.
  assert.equal(agentBudget("nobody"), CONFIG.memoryBudgetTokens);
});
