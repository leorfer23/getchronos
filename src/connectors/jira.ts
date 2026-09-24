import type { ExternalTask, Connector, ExternalComment } from "./types.js";
import { mapStatus, normalizePriority, adfToText, adfMentions } from "./types.js";

// Jira connector. connector_config: { base_url, email, api_token, jql?, status_map?, status_transitions? }.
// API: REST v3, Basic auth (email:api_token).
function auth(cfg: any) {
  const { base_url, email, api_token } = cfg;
  if (!base_url || !email || !api_token) throw new Error("jira connector needs { base_url, email, api_token }");
  return { base: base_url.replace(/\/$/, ""), header: `Basic ${Buffer.from(`${email}:${api_token}`).toString("base64")}` };
}

// Who "me" is, for auto-assigning the tickets agents file on my behalf. cfg.assignee_account_id
// overrides; otherwise it's whoever the api_token belongs to. Cached per site+email (accountIds
// don't move) — and only on success, so one flaky /myself doesn't disable assignment for the
// lifetime of the daemon.
const jiraMe = new Map<string, string>();
export async function myAccountId(cfg: any): Promise<string | null> {
  if (cfg.assignee_account_id) return String(cfg.assignee_account_id);
  const { base, header } = auth(cfg);
  const key = `${base}|${cfg.email}`;
  const hit = jiraMe.get(key);
  if (hit) return hit;
  try {
    const r = await fetch(`${base}/rest/api/3/myself`, { headers: { Authorization: header, Accept: "application/json" } });
    if (!r.ok) { console.warn(`[jira] /myself ${r.status} — creating unassigned`); return null; }
    const id = (await r.json())?.accountId;
    if (!id) return null;
    jiraMe.set(key, String(id));
    return String(id);
  } catch (e) {
    console.warn("[jira] /myself failed — creating unassigned", e);
    return null;
  }
}

// Custom field id for "Hours Spent" — an ordinary number field in the issue's Details that some
// workflows (e.g. Globex's Done transition screen) also require on the transition POST, or Jira
// 400s with "Hours Spent estimate must be provided". Used by both setHours and pushStatus.
// Resolved once via GET /rest/api/3/field and cached per base_url (field ids don't move).
// cfg.hours_field_id overrides; cfg.hours_field_name overrides the name matched (default "Hours Spent").
const jiraHoursField = new Map<string, string | null>();
async function hoursFieldId(cfg: any): Promise<string | null> {
  if (cfg.hours_field_id) return String(cfg.hours_field_id);
  const { base, header } = auth(cfg);
  if (jiraHoursField.has(base)) return jiraHoursField.get(base)!;
  const wantName = (cfg.hours_field_name || "Hours Spent").toLowerCase();
  try {
    const r = await fetch(`${base}/rest/api/3/field`, { headers: { Authorization: header, Accept: "application/json" } });
    if (!r.ok) { console.warn(`[jira] /field ${r.status} — can't resolve Hours Spent field id`); return null; }
    const fields: any[] = await r.json();
    const hit = fields.find((f) => String(f.name ?? "").toLowerCase() === wantName);
    const id = hit ? String(hit.id) : null;
    jiraHoursField.set(base, id);
    if (!id) console.warn(`[jira] no field named "${cfg.hours_field_name || "Hours Spent"}" — hours won't be pushed`);
    return id;
  } catch (e) {
    console.warn("[jira] /field failed — can't resolve Hours Spent field id", e);
    return null;
  }
}

export const jira: Connector = {
  name: "jira",
  me: (cfg) => myAccountId(cfg),
  async pull(cfg): Promise<ExternalTask[]> {
    const { base, header } = auth(cfg);
    // Default query keeps every open ticket AND anything closed in the last 30d, so a ticket
    // closed in Jira surfaces here (status→done) instead of silently vanishing from an open-only pull.
    const query = cfg.jql || "assignee = currentUser() AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC";
    const fields = "summary,status,description,priority,assignee,labels,duedate,updated,comment";
    // Jira removed GET /rest/api/3/search (CHANGE-2046) — use the /search/jql endpoint.
    const r = await fetch(`${base}/rest/api/3/search/jql?maxResults=100&fields=${fields}&jql=${encodeURIComponent(query)}`, {
      headers: { Authorization: header, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`jira pull ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data: any = await r.json();
    return (data.issues ?? []).map((i: any): ExternalTask => {
      const f = i.fields ?? {};
      const cat = f.status?.statusCategory?.key; // new | indeterminate | done
      // Jira's category says the issue is finished; the resolution/status name says whether it was
      // delivered or dropped ("Won't Do" is a category:done issue nobody built).
      const byName = mapStatus(f.status?.name ?? "");
      const local =
        cat === "done"
          ? byName === "dismissed"
            ? "dismissed"
            : "done"
          : cat === "indeterminate"
            ? "in_progress"
            : "backlog";
      const comments: ExternalComment[] = (f.comment?.comments ?? []).map((c: any) => ({
        id: c.id != null ? String(c.id) : undefined,
        author: c.author?.displayName ?? "unknown",
        author_id: c.author?.accountId ?? undefined,
        body: adfToText(c.body).trim(),
        created: c.created ?? null,
        mentions: adfMentions(c.body),
      }));
      return {
        id: String(i.key),
        title: f.summary ?? "(untitled)",
        url: `${base}/browse/${i.key}`,
        status: mapStatus(local),
        statusRaw: f.status?.name ?? local,
        updated: f.updated ?? null,
        description: adfToText(f.description).trim() || null,
        priority: normalizePriority(f.priority?.name),
        assignee: f.assignee?.displayName ?? null,
        assignee_ids: f.assignee?.accountId ? [String(f.assignee.accountId)] : [],
        labels: Array.isArray(f.labels) ? f.labels : [],
        due: f.duedate ?? null,
        comments,
      };
    });
  },

  async pushStatus(cfg, externalId, externalStatus, hours): Promise<void> {
    const { base, header } = auth(cfg);
    const want = externalStatus.trim().toLowerCase();
    // Prefer an explicit id from config; else resolve live from the issue's available transitions
    // (matching the target status name), so no hardcoded transition ids are required.
    const override = cfg.status_transitions?.[externalStatus] ?? cfg.status_transitions?.[want];
    let transitionId = override ? String(override) : null;
    if (!transitionId) {
      const tr = await fetch(`${base}/rest/api/3/issue/${externalId}/transitions`, { headers: { Authorization: header, Accept: "application/json" } });
      if (!tr.ok) throw new Error(`jira transitions ${tr.status}: ${(await tr.text()).slice(0, 200)}`);
      const list: any[] = (await tr.json())?.transitions ?? [];
      const hit = list.find((t) => t.to?.name?.toLowerCase() === want) || list.find((t) => t.name?.toLowerCase() === want);
      if (!hit) { console.warn(`[jira] ${externalId}: no transition to "${externalStatus}" (have: ${list.map((t) => t.to?.name).join(", ")})`); return; }
      transitionId = String(hit.id);
    }
    const body: any = { transition: { id: transitionId } };
    // Done screens on some projects require Hours Spent — attach it whenever the caller has a number,
    // so the transition doesn't 400 with "Hours Spent estimate must be provided before closing this ticket".
    if (typeof hours === "number") {
      const fieldId = await hoursFieldId(cfg);
      if (fieldId) body.fields = { [fieldId]: hours };
    }
    const r = await fetch(`${base}/rest/api/3/issue/${externalId}/transitions`, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`jira push ${r.status}: ${(await r.text()).slice(0, 200)}`);
  },

  async addComment(cfg, externalId, body): Promise<void> {
    const { base, header } = auth(cfg);
    const r = await fetch(`${base}/rest/api/3/issue/${externalId}/comment`, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json" },
      body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] } }),
    });
    if (!r.ok) throw new Error(`jira comment ${r.status}: ${(await r.text()).slice(0, 200)}`);
  },

  // Write Hours Spent on its own, with no transition — the field lives in the issue's Details, so
  // hours can be logged while the ticket is still in progress instead of only at the Done screen.
  // Throws (rather than warning) when the field can't be resolved: the caller asked for exactly this
  // one write, and a silent no-op would read as "logged" when Jira still says Ninguno.
  async setHours(cfg, externalId, hours): Promise<void> {
    const { base, header } = auth(cfg);
    const fieldId = await hoursFieldId(cfg);
    if (!fieldId)
      throw new Error(
        `jira: no field named "${cfg.hours_field_name || "Hours Spent"}" on ${base} (set connector_config.hours_field_id or hours_field_name)`,
      );
    const r = await fetch(`${base}/rest/api/3/issue/${externalId}`, {
      method: "PUT",
      headers: { Authorization: header, "content-type": "application/json" },
      body: JSON.stringify({ fields: { [fieldId]: hours } }),
    });
    if (!r.ok) throw new Error(`jira hours ${r.status}: ${(await r.text()).slice(0, 200)}`);
  },

  async createTask(cfg, input) {
    const { base, header } = auth(cfg);
    const projectKey = cfg.project_key || cfg.projectKey;
    if (!projectKey) throw new Error("jira createTask needs { project_key } in connector_config");
    const issueType = cfg.issue_type || cfg.issueType || "Task";
    const r = await fetch(`${base}/rest/api/3/issue`, {
      method: "POST",
      headers: { Authorization: header, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: input.title,
          issuetype: { name: issueType },
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: input.description }] }],
          },
        },
      }),
    });
    if (!r.ok) throw new Error(`jira create ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data: any = await r.json();
    const key = String(data.key ?? data.id);
    // Assign after create, not in the create body: `assignee` is often missing from a project's
    // create screen, and a rejected field there would lose the whole ticket. Best-effort — a failed
    // assign leaves a created-but-unowned ticket, which beats no ticket.
    const accountId = await myAccountId(cfg);
    if (accountId) {
      try {
        const ar = await fetch(`${base}/rest/api/3/issue/${key}/assignee`, {
          method: "PUT",
          headers: { Authorization: header, "content-type": "application/json" },
          body: JSON.stringify({ accountId }),
        });
        if (!ar.ok) console.warn(`[jira] ${key}: assign ${ar.status}: ${(await ar.text()).slice(0, 160)}`);
      } catch (e) { console.warn(`[jira] ${key}: assign failed`, e); }
    }
    return { id: key, url: `${base}/browse/${key}`, statusRaw: "To Do" };
  },
};
