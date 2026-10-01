/**
 * The fleet, in one block, at the top of every desk turn: what is open, whose turn it is, what
 * each terminal is for. Robert answers "who needs me" from this without a Bash round-trip; anything
 * deeper is still `mc desk digest` / `mc session focus`. With more than one computer (HOSTS.md) a
 * HOSTS line leads it, and a terminal on another computer says which (` · @m2`).
 */
import { hosts, sessions, workspaces, LOCAL_HOST_ID } from "./store.js";
import { sessionActivity } from "./terminal.js";
import { getAgent } from "./agent-lifecycle.js";
import { sessionGoalReached, statusOf } from "./term-status.js";
import { sessionHostOffline } from "./remote-terminals.js";
import { brainLink } from "./hostlink/brain-link.js";
import { hostsView, type HostView } from "./hostlink/view.js";

const MAX_ROWS = 30;
/** Same order as the Desk rail: needs you → to review → your turn → stalled → waiting on others → working. */
const RANK: Record<string, number> = { blocked: 0, decide: 1, review: 2, your_turn: 3, stalled: 4, waiting: 5, working: 6 };
const one = (s: string | null | undefined, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const pct = (n: number | null | undefined) => (n == null ? "?" : `${Math.round(n)}%`);
const ago = (iso: string | null, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 120 ? ` ${m}m` : ` ${Math.round(m / 60)}h`;
};

/**
 * The computers, in one line (HOSTS.md), so Robert knows where work can go before he opens any. Pure
 * over hostsView()'s rows. One computer = "" (nothing to choose between, nothing to say).
 */
export function hostsLine(view: HostView[], now = Date.now()): string {
  if (view.length <= 1) return "";
  const parts = view.map((h) => {
    const last = h.vitals.history[h.vitals.history.length - 1];
    if (!h.connected) {
      const off = `${h.name} ${h.status === "disabled" ? "disabled" : `OFFLINE${ago(h.last_seen_at, now)}`}`;
      return off + (h.live_sessions ? ` ${h.live_sessions} live` : "");
    }
    const notes = [
      h.status === "draining" || h.status === "disabled" ? h.status : "",
      h.admission.ok ? "" : `full (${h.admission.reason})`,
      ...h.checklist.clis.filter((c) => c.auth === "no").map((c) => `${c.name} logged out`),
      ...(h.checklist.profiles ?? []).filter((p) => p.auth === "no").map((p) => `profile ${p.name} logged out`),
      h.update?.status?.state === "failed" ? "update failed" : h.update?.available ? "behind brain (update)" : "",
    ].filter(Boolean);
    return `${h.name}${h.is_brain ? " (brain)" : ""} cpu ${pct(last?.cpu)} ram ${pct(last?.ram)} ${h.live_sessions} live` + (notes.length ? `, ${notes.join(", ")}` : "");
  });
  return `HOSTS: ${parts.join(" · ")}`;
}

/** The HOSTS line for this turn. A brain with no joined host never builds the view: one SELECT. */
function fleetHostsLine(): string {
  try {
    if (!hosts.list().some((h) => h.id !== LOCAL_HOST_ID && !!h.token_hash)) return "";
    return hostsLine(hostsView(brainLink()));
  } catch (e: any) {
    return `HOSTS: (unreadable — ${String(e?.message ?? e).slice(0, 80)})`;
  }
}

/** ` · @m2` for a terminal on another computer, plus a warning while that computer's link is down. */
export function hostSuffix(s: { host_id?: string | null; status: string }, nameOf: (id: string) => string): string {
  if (!s.host_id || s.host_id === LOCAL_HOST_ID) return "";
  const name = nameOf(s.host_id);
  return ` · @${name}` + (sessionHostOffline({ host_id: s.host_id, status: s.status as any }) ? ` · ⚠ ${name} offline` : "");
}

export function fleetLine(workspace_id?: string | null): string {
  const head = fleetHostsLine();
  const body = fleetBody(workspace_id);
  return head ? `${head}\n${body}` : body;
}

function fleetBody(workspace_id?: string | null): string {
  const rows = sessions.list({ workspace_id: workspace_id ?? undefined, status: "live", limit: 200 });
  if (!rows.length) return `FLEET NOW: no open terminals.`;
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, hosts.get(id)?.name || id);
    return names.get(id)!;
  };
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
      (st?.line ? ` · ${one(st.line, 120)}` : "") +
      hostSuffix(s, nameOf);
    return { rank, quiet, line };
  });
  items.sort((a, b) => a.rank - b.rank || b.quiet - a.quiet);
  const needs = items.filter((i) => i.rank <= 1).length;
  const shown = items.slice(0, MAX_ROWS).map((i) => i.line);
  if (items.length > MAX_ROWS) shown.push(`- … ${items.length - MAX_ROWS} more (mc desk digest)`);
  return `FLEET NOW (${rows.length} open · ${needs} need the operator; ids are the first 8 chars):\n${shown.join("\n")}`;
}
