import type { ExternalTask, Connector, ExternalComment } from "./types.js";
import { mapStatus, normalizePriority } from "./types.js";

// ClickUp connector. connector_config: { token, list_id, status_map?, done_status? }.
// API: https://clickup.com/api  — auth via the personal token in the Authorization header.
const msToIso = (ms: any): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

// Who "me" is, for auto-assigning the tickets agents file on my behalf. cfg.assignee_id overrides;
// otherwise it's whoever the token belongs to. Cached per list (not per token — no secrets in a
// module-global) and only on success, so a flaky /user doesn't disable assignment for good.
const clickupMe = new Map<string, number>();
export async function myUserId(cfg: any): Promise<number | null> {
  if (cfg.assignee_id) return Number(cfg.assignee_id);
  const hit = clickupMe.get(String(cfg.list_id));
  if (hit) return hit;
  try {
    const r = await fetch("https://api.clickup.com/api/v2/user", { headers: { Authorization: cfg.token } });
    if (!r.ok) { console.warn(`[clickup] /user ${r.status} — creating unassigned`); return null; }
    const id = Number((await r.json())?.user?.id);
    if (!Number.isFinite(id)) return null;
    clickupMe.set(String(cfg.list_id), id);
    return id;
  } catch (e) {
    console.warn("[clickup] /user failed — creating unassigned", e);
    return null;
  }
}

// Which tasks a workspace syncs. Two shapes, because one list is not always the unit of work:
//
//   { list_id }              → that list (the original behaviour, unchanged)
//   { team_id, assignee_id } → every task assigned to that user across the whole ClickUp workspace
//
// The second exists because a person's work is often spread over many lists — 96 tasks across 5
// lists, in the case that prompted this — and picking one list silently drops the rest.
//
// The team endpoint pages at 100; the list endpoint does not page at all (it caps at ~100 and the
// original code did not loop). Paging here is what makes team scope usable rather than truncated.
export async function fetchTasks(cfg: any): Promise<any[]> {
  const { token, list_id, team_id, assignee_id } = cfg;
  const H = { Authorization: token };

  if (!team_id) {
    if (!list_id) throw new Error("clickup connector needs { list_id } or { team_id, assignee_id }");
    // include_closed=true so a task closed in ClickUp surfaces (status→done) instead of vanishing
    // from an open-only pull. The list is the workspace's active list, so this stays bounded.
    const r = await fetch(`https://api.clickup.com/api/v2/list/${list_id}/task?include_closed=true&subtasks=true`, { headers: H });
    if (!r.ok) throw new Error(`clickup pull ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json())?.tasks ?? [];
  }

  const out: any[] = [];
  // Hard page cap: a runaway loop against a 141-member workspace would be a lot of API calls, and
  // `last_page` is not always present — an empty page is the reliable terminator.
  for (let page = 0; page < 20; page++) {
    const u = new URL(`https://api.clickup.com/api/v2/team/${team_id}/task`);
    u.searchParams.set("include_closed", "true");
    u.searchParams.set("subtasks", "true");
    u.searchParams.set("page", String(page));
    if (assignee_id) u.searchParams.append("assignees[]", String(assignee_id));
    const r = await fetch(u, { headers: H });
    if (!r.ok) throw new Error(`clickup pull ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const batch: any[] = j?.tasks ?? [];
    out.push(...batch);
    if (!batch.length || j?.last_page) break;
  }
  return out;
}

export const clickup: Connector = {
  name: "clickup",
  async me(cfg) {
    const id = await myUserId(cfg);
    return id == null ? null : String(id);
  },
  async pull(cfg): Promise<ExternalTask[]> {
    const { token } = cfg;
    if (!token) throw new Error("clickup connector needs { token }");
    const tasks: any[] = await fetchTasks(cfg);
    const out: ExternalTask[] = [];
    // One GET /comment per task, so the cost is linear in the sync's size — tolerable for a list,
    // unbounded under team scope. Cap it and SAY what was skipped: a silent cap reads as "this task
    // has no comments", which is a different and wrong statement. Newest-first (the API's order)
    // means the cap drops the stalest tasks. cfg.comment_limit=0 turns comments off entirely.
    const commentLimit = cfg.comment_limit === undefined ? 120 : Number(cfg.comment_limit);
    if (tasks.length > commentLimit)
      console.warn(`[clickup] ${tasks.length} tasks — fetching comments for the first ${commentLimit}; the rest sync without comments`);
    let fetched = 0;
    for (const t of tasks) {
      let comments: ExternalComment[] = [];
      if (fetched++ < commentLimit) try {
        const cr = await fetch(`https://api.clickup.com/api/v2/task/${t.id}/comment`, { headers: { Authorization: token } });
        if (cr.ok) comments = ((await cr.json())?.comments ?? []).map((c: any): ExternalComment => ({
          id: c.id != null ? String(c.id) : undefined,
          author: c.user?.username ?? "unknown",
          author_id: c.user?.id != null ? String(c.user.id) : undefined,
          body: c.comment_text ?? "",
          created: msToIso(c.date),
        }));
      } catch { /* comments are best-effort; a fetch hiccup shouldn't drop the task */ }
      // Trust ClickUp's status TYPE for terminal states: 'done'/'closed' types (e.g. "complete",
      // "will not implement") must read as closed even when their label wouldn't match by name. The
      // label still decides WHICH close it is — "won't do" is a decision, not a delivery.
      const stype = t.status?.type;
      const byLabel = mapStatus(t.status?.status ?? "");
      const status = stype === "closed" || stype === "done" ? (byLabel === "dismissed" ? "dismissed" : "done") : byLabel;
      out.push({
        id: String(t.id),
        title: t.name ?? "(untitled)",
        url: t.url ?? null,
        status,
        statusRaw: t.status?.status ?? "",
        updated: msToIso(t.date_updated),
        description: (t.description || t.text_content || "").trim() || null,
        priority: normalizePriority(t.priority?.priority),
        assignee: t.assignees?.[0]?.username ?? null,
        labels: (t.tags ?? []).map((x: any) => x.name).filter(Boolean),
        due: msToIso(t.due_date),
        comments,
      });
    }
    return out;
  },

  async pushStatus(cfg, externalId, externalStatus): Promise<void> {
    const { token } = cfg;
    if (!token) throw new Error("clickup connector needs { token }");
    const r = await fetch(`https://api.clickup.com/api/v2/task/${externalId}`, {
      method: "PUT",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ status: externalStatus }),
    });
    // Throw on failure (matches addComment/jira.pushStatus) — callers decide what "best-effort" means
    // for them (pushClose already wraps in try/catch; write-back needs the real error to report + retry).
    if (!r.ok) throw new Error(`clickup status "${externalStatus}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
  },

  async addComment(cfg, externalId, body): Promise<void> {
    const { token } = cfg;
    if (!token) throw new Error("clickup connector needs { token }");
    const r = await fetch(`https://api.clickup.com/api/v2/task/${externalId}/comment`, {
      method: "POST",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ comment_text: body }),
    });
    if (!r.ok) throw new Error(`clickup comment ${r.status}: ${(await r.text()).slice(0, 200)}`);
  },

  async createTask(cfg, input) {
    const { token, list_id } = cfg;
    if (!token || !list_id) throw new Error("clickup connector needs { token, list_id }");
    // ClickUp takes assignees in the create body (no create-screen field config to trip over), so
    // one call does it. A ticket an agent files for me should land in my queue, not the void.
    const me = await myUserId(cfg);
    const r = await fetch(`https://api.clickup.com/api/v2/list/${list_id}/task`, {
      method: "POST",
      headers: { Authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ name: input.title, description: input.description, ...(me ? { assignees: [me] } : {}) }),
    });
    if (!r.ok) throw new Error(`clickup create ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const t: any = await r.json();
    return {
      id: String(t.id),
      url: t.url ?? null,
      statusRaw: t.status?.status ?? "to do",
    };
  },
};
