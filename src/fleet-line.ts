/**
 * The fleet, in one block, at the top of every desk turn: what is open, whose turn it is, what
 * each terminal is for. Robert answers "who needs me" from this without a Bash round-trip; anything
 * deeper is still `mc desk digest` / `mc session focus`.
 */
import { sessions, workspaces } from "./store.js";
import { sessionActivity } from "./terminal.js";
import { getAgent } from "./agent-lifecycle.js";
import { sessionGoalReached, statusOf } from "./term-status.js";

const MAX_ROWS = 30;
/** Same order as the Desk rail: needs you → to review → your turn → stalled → waiting on others → working. */
const RANK: Record<string, number> = { blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6 };
const one = (s: string | null | undefined, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function fleetLine(workspace_id?: string | null): string {
  const rows = sessions.list({ workspace_id: workspace_id ?? undefined, status: "live", limit: 200 });
  if (!rows.length) return `FLEET NOW: no open terminals.`;
  const items = rows.map((s) => {
    const act = sessionActivity(s.id);
    const st = statusOf(s.id);
    const phase = st?.phase ?? (sessionGoalReached(s, act) ? "review" : getAgent(s.id)?.state === "blocked" ? "blocked" : act.quiet ? "your_turn" : "working");
    const quiet = act.quiet && act.last_out ? Math.round((Date.now() - act.last_out) / 60000) : 0;
    const rank = RANK[phase] ?? 9;
    const ws = s.workspace_id ? workspaces.get(s.workspace_id)?.name ?? "—" : "—";
    const extra = st ? [st.subagents ? `${st.subagents} subagents` : "", st.progress ? `${st.progress.n}/${st.progress.of}` : ""].filter(Boolean).join(", ") : "";
    const line =
      `- ${s.id.slice(0, 8)} · ${ws} · ${phase.replace("_", " ")}${quiet && phase === "your_turn" ? ` ${quiet}m` : ""}${extra ? ` (${extra})` : ""} · ${one(s.goal || s.title, 90) || "(no goal)"}` +
      (st?.line ? ` · ${one(st.line, 120)}` : "");
    return { rank, quiet, line };
  });
  items.sort((a, b) => a.rank - b.rank || b.quiet - a.quiet);
  const needs = items.filter((i) => i.rank <= 1).length;
  const shown = items.slice(0, MAX_ROWS).map((i) => i.line);
  if (items.length > MAX_ROWS) shown.push(`- … ${items.length - MAX_ROWS} more (mc desk digest)`);
  return `FLEET NOW (${rows.length} open · ${needs} need the operator; ids are the first 8 chars):\n${shown.join("\n")}`;
}
