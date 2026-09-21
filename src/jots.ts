import { bus } from "./bus.js";
import { jots, workspaces } from "./store.js";
import { openSession } from "./terminal.js";
import type { Jot, JotSource } from "./store/jots.js";
import type { Session } from "./types.js";

/**
 * Who may write a jot. The operator (admin token) writes anything. A terminal, carrying only its
 * workspace token, may ADD rows to its own client's pad but never rewrite or remove one: a dated card
 * is the plan-tomorrow planner (`nextday`), an undated one is a follow-up a working terminal found
 * (`agent`). Either way the row is stamped as the agent's, never the operator's. A caller with no
 * token at all is not the operator either: loopback is reachable from inside a sandbox, and "no
 * header" must not read as "dashboard". Returns the fields the route stamps, or the refusal to send.
 */
export function jotWritePolicy(
  caller: { admin: boolean; scopedWs: string | null | undefined },
  body: { for_date?: string | null; planned_by?: string | null },
): { ok: true; source: JotSource; planned_by: string | null } | { ok: false; status: number; error: string } {
  if (caller.admin) return { ok: true, source: "operator", planned_by: null };
  if (!caller.scopedWs) return { ok: false, status: 403, error: "workspace mutations are dashboard-only (admin token required)" };
  return { ok: true, source: body.for_date ? "nextday" : "agent", planned_by: body.planned_by ?? null };
}

/**
 * Turn a parked thought into a working terminal.
 *
 * The jot IS the spawn dialog, pre-filled: its title is the goal, its body is the description the
 * daemon folds into the terminal's first prompt (deskSeed in src/terminal.ts). That is the whole
 * reason to write the body down over days rather than typing it once at spawn time — by the time you
 * press Run, the brief is already written.
 *
 * Everything else falls back to the client's own defaults, because a jot deliberately does not carry
 * a backend/model/cwd: choosing them is part of starting, and the point of the row is that you had
 * not started yet. An override is still accepted for the run that needs one.
 */
export async function runJot(
  id: string,
  overrides: { backend?: string; model?: string | null; cwd?: string; goal_kind?: "pr" | "investigation" | "qa" | null } = {},
): Promise<{ jot: Jot; session: Session }> {
  const jot = jots.get(id);
  if (!jot) throw new Error("jot not found");
  const ws = workspaces.get(jot.workspace_id);

  const session = await openSession({
    workspace_id: jot.workspace_id,
    goal: jot.title.slice(0, 400),
    goal_kind: overrides.goal_kind ?? null,
    goal_source: "human",
    description: jot.body,
    backend: overrides.backend ?? ws?.default_backend ?? undefined,
    model: overrides.model ?? null,
    created_by: "operator",
    role: "human",
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
  } as any);

  // Record the link before returning: the Desk repaints off this row, and a run whose session the
  // jot does not know about is a terminal with no way back to the thought that opened it.
  const updated = jots.ran(id, session.id) ?? jot;
  bus.publish({ topic: "jot.ran", jot_id: id, workspace_id: jot.workspace_id, session_id: session.id });
  return { jot: updated, session };
}
