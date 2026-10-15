/**
 * Reading what a terminal spent off the CLI's own transcript: turns, context occupancy, cost.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { forgetUsage, sessionUsage } from "./session-usage.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

let n = 0;
function mkSessionWithTranscript(lines: any[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  const ws = workspaces.create({ slug: `usage${++n}`, name: "Usage", config_dir: dir });
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const proj = path.join(dir, "projects", "-tmp");
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${s.id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { id: s.id, file };
}

const assistant = (usage: any, model = "claude-sonnet-5") => ({ type: "assistant", message: { model, usage } });
const prompt = (text: string) => ({ type: "user", message: { content: text } });
const toolResult = () => ({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });

test("turns count prompts, not tool results, and not a subagent's own conversation", () => {
  const { id } = mkSessionWithTranscript([
    prompt("Goal: open the rollback PR"),
    assistant({ input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000 }),
    toolResult(),
    assistant({ input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 2000 }),
    { ...prompt("sidechain prompt"), isSidechain: true },
    prompt("now do the second thing"),
    assistant({ input_tokens: 3, output_tokens: 70, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }),
  ]);
  const u = sessionUsage(id)!;
  assert.equal(u.turns, 2);
  // Context is what the model was handed LAST — not a sum of every turn.
  assert.equal(u.context_tokens, 3 + 9000 + 500);
  assert.equal(u.tokens_out, 220);
  assert.equal(u.cache_read, 12000);   // cache is counted apart: it bills at a tenth of input
  assert.equal(u.cache_write, 500);
  assert.deepEqual(u.models, ["claude-sonnet-5"]);
});

test("cost comes from the CLI's own running total, and a growing file is read incrementally", () => {
  const { id, file } = mkSessionWithTranscript([
    prompt("start"),
    assistant({ input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100 }),
    { type: "cost-state", totalCostUSD: 0.42, totalLinesAdded: 12, totalLinesRemoved: 3 },
  ]);
  const first = sessionUsage(id)!;
  assert.equal(first.cost_usd, 0.42);
  assert.equal(first.lines_added, 12);
  assert.equal(first.turns, 1);

  // Append a second exchange: the next read consumes only the new bytes and the totals move.
  fs.appendFileSync(
    file,
    [prompt("keep going"), assistant({ input_tokens: 4, output_tokens: 90, cache_read_input_tokens: 50_000 }), { type: "cost-state", totalCostUSD: 1.07 }]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const second = sessionUsage(id)!;
  assert.equal(second.turns, 2);
  assert.equal(second.cost_usd, 1.07);
  assert.equal(second.context_tokens, 50_004);
  assert.equal(second.tokens_out, 100);
});

test("cost is estimated from tokens until the CLI writes its own total, and marked as such", () => {
  const { id, file } = mkSessionWithTranscript([
    prompt("go"),
    // 1M cache reads + 100k output on sonnet ≈ 0.1×3 + 1.5 = $1.80 — the shape of the arithmetic
    // matters more than the cent: it stops a young terminal reading as free.
    assistant({ input_tokens: 0, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 }),
  ]);
  const est = sessionUsage(id)!;
  assert.equal(est.cost_estimated, true);
  assert.ok(est.cost_usd! > 1.5 && est.cost_usd! < 2.1, `estimate was ${est.cost_usd}`);

  // The CLI's own number lands → it wins, and stops being flagged.
  fs.appendFileSync(file, JSON.stringify({ type: "cost-state", totalCostUSD: 2.5 }) + "\n");
  const real = sessionUsage(id)!;
  assert.equal(real.cost_estimated, false);
  assert.equal(real.cost_usd, 2.5);
});

test("a session with no transcript reports nothing rather than zeroes", () => {
  const ws = workspaces.create({ slug: "empty", name: "Empty", config_dir: "/tmp/does-not-exist-here" });
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  forgetUsage(s.id);
  assert.equal(sessionUsage(s.id), null);
});
