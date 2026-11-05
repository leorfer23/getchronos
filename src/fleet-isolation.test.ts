/**
 * Workspaces never mix in Robert's prompts: the fleet-wide view is counts, a fleet-wide message fans
 * out to each project's own Robert and is stitched in code, and the router never sees client text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessions, workspaces } from "./store.js";
import { fleetLine } from "./fleet-line.js";
import { askFleetFanout, FANOUT_QUIET } from "./telegram/agent.js";

const A = workspaces.create({ slug: `fi-a-${Date.now()}`, name: "Acme", config_dir: "/tmp/fia" } as any);
const B = workspaces.create({ slug: `fi-b-${Date.now()}`, name: "Initech", config_dir: "/tmp/fib" } as any);
sessions.create({ workspace_id: A.id, cwd: "/tmp", goal: "acme secret migration" } as any);
sessions.create({ workspace_id: B.id, cwd: "/tmp", goal: "initech private report" } as any);

test("the fleet-wide fleet line is counts per project — no client's goals", () => {
  const all = fleetLine(null);
  assert.match(all, /Acme: \d+ open/);
  assert.match(all, /Initech: \d+ open/);
  assert.doesNotMatch(all, /acme secret migration|initech private report/);
  const mine = fleetLine(A.id);
  assert.match(mine, /acme secret migration/);
  assert.doesNotMatch(mine, /initech private report/);
});

test("a fleet-wide message goes to each project's own Robert; QUIET ones are left out; stitched in code", async () => {
  const seen: Array<{ ws: string | null | undefined; prompt: string }> = [];
  const ask: any = async (prompt: string, _d: unknown, ws: string) => {
    seen.push({ ws, prompt });
    return { reply: ws === A.id ? "2 PRs merged today." : FANOUT_QUIET, actions: [], steps: [], turn: "t", engine: "x" };
  };
  const r = await askFleetFanout("¿cómo venimos?", [A.id, B.id], { ask });
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.ok(s.ws === A.id || s.ws === B.id, "always one project's own Robert, never the fleet-wide one");
    const name = s.ws === A.id ? "Acme" : "Initech";
    assert.match(s.prompt, new RegExp(`ONLY for ${name}`));
  }
  assert.equal(r.reply, "**Acme** — 2 PRs merged today.");
  const none = await askFleetFanout("x", [B.id], { ask });
  assert.match(none.reply, /Nothing needs you/);
});
