import { bus } from "./bus.js";
import { launches, workspaces, type Launch } from "./store.js";
import { openSession } from "./terminal.js";
import type { Session } from "./types.js";

/**
 * Run a launch: open a terminal from its saved fields — the same door the New-terminal dialog and a
 * jot's Run use (openSession), with the same seed rules (goal + kind + description → first prompt).
 * A launch outlives its runs: the row stays, the count moves, and the last terminal is remembered.
 */
export async function runLaunch(
  id: string,
  overrides: { backend?: string; model?: string | null; cwd?: string } = {},
): Promise<{ launch: Launch; session: Session }> {
  const launch = launches.get(id);
  if (!launch) throw new Error("launch not found");
  const ws = workspaces.get(launch.workspace_id);
  const cwd = overrides.cwd ?? launch.cwd ?? undefined;
  const session = await openSession({
    workspace_id: launch.workspace_id,
    goal: launch.goal,
    goal_kind: launch.goal ? launch.goal_kind : null,
    goal_source: "human",
    description: launch.description,
    backend: overrides.backend ?? launch.backend ?? ws?.default_backend ?? undefined,
    model: overrides.model !== undefined ? overrides.model : launch.model,
    created_by: "operator",
    role: "human",
    ...(cwd ? { cwd } : {}),
  } as any);
  const updated = launches.ran(id, session.id) ?? launch;
  bus.publish({ topic: "launch.ran", launch_id: id, workspace_id: launch.workspace_id, session_id: session.id });
  return { launch: updated, session };
}
