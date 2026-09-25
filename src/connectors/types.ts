import type { TicketStatus } from "../types.js";

export interface ExternalComment {
  /** The tracker's comment id, when it has one. */
  id?: string;
  author: string;
  /** The tracker's id for the author (Jira accountId / ClickUp user id) — what prose harvest matches on. */
  author_id?: string;
  body: string;
  created: string | null; // ISO
  /** Tracker ids of the people the comment @mentions (Jira ADF mention nodes / ClickUp tag blocks). */
  mentions?: string[];
}

// A task pulled from an external tracker (Jira/ClickUp). External is the source of truth:
// every field here is mirrored INTO the local ticket on sync. `status`/`title` also drive the
// bidirectional status reconcile; the rest render into the ticket's `## External` section.
export interface ExternalTask {
  id: string;
  title: string;
  url: string | null;
  status: TicketStatus; // normalized via mapStatus
  statusRaw: string;    // the tracker's own status label (kept for display + status_map round-trip)
  updated: string | null; // external last-updated (ISO)
  description: string | null;
  priority: string | null; // normalized P0..P3
  assignee: string | null; // display name
  /** Tracker ids of every assignee — what the inbox compares against Connector.me(). */
  assignee_ids?: string[];
  labels: string[];
  due: string | null; // ISO / date string
  comments: ExternalComment[];
}

export interface Connector {
  name: string;
  pull(cfg: Record<string, any>): Promise<ExternalTask[]>;
  // Optional: the tracker's id for whoever owns the token — the operator. Comments with that
  // author_id are his own writing and feed the prose corpus (src/prose.ts).
  me?(cfg: Record<string, any>): Promise<string | null>;
  // Move the external task to the given external status label. Connector resolves the label to its
  // own mechanism (Jira: a workflow transition; ClickUp: a status field write). No-op + log if the
  // label doesn't exist in the tracker, so an unmapped status never throws the whole sync.
  // `hours` (optional): hours-spent value to attach to the transition, when the tracker's workflow
  // requires it (Jira: Hours Spent custom field on Done screens). Connectors that don't need it ignore it.
  pushStatus(cfg: Record<string, any>, externalId: string, externalStatus: string, hours?: number): Promise<void>;
  addComment(cfg: Record<string, any>, externalId: string, body: string): Promise<void>;
  // Optional: write hours-spent onto the external task WITHOUT moving its status, for trackers that
  // carry hours as an ordinary field (Jira: the "Hours Spent" custom field in Details). Connectors
  // that have no such field leave this undefined and callers report "not supported".
  setHours?(cfg: Record<string, any>, externalId: string, hours: number): Promise<void>;
  // Optional: create a brand-new external task (Idea Pool promote with external:true). Local-first
  // promote never depends on this — failures are logged, local ticket stays.
  createTask?(
    cfg: Record<string, any>,
    input: { title: string; description: string },
  ): Promise<{ id: string; url: string | null; statusRaw: string }>;
}

// Normalize a free-form external status string to our ticket lifecycle.
export function mapStatus(s: string): TicketStatus {
  const t = (s || "").toLowerCase();
  // Checked before the done family: a tracker's "closed - won't do" is a decision, not a delivery.
  if (/won'?t ?(do|fix)|wontfix|cancel|dismiss|abandon|discard|rejected/.test(t)) return "dismissed";
  if (/done|complete|closed|resolved/.test(t)) return "done";
  if (/review|qa|verify/.test(t)) return "review";
  if (/progress|doing|active|wip/.test(t)) return "in_progress";
  if (/ready|to ?do|open|selected/.test(t)) return "ready";
  if (/block/.test(t)) return "blocked";
  return "backlog";
}

/**
 * Coarse phase a status collapses to, for asking "do Chronos and the tracker say the same thing
 * about where this work is?" — untouched, being worked, awaiting review, or over.
 *
 * Chronos has states no tracker has (planning/planned/shipping), so comparing statuses directly
 * would call "Chronos: planning / ClickUp: In Progress" a contradiction when it is only our finer
 * vocabulary — the same collapse DEFAULT_STATUS_MAP does on the way out. Phases are the honest unit
 * of disagreement: a phase gap is something a human reading the board would want explained.
 */
export type StatusPhase = "open" | "active" | "review" | "closed";
export const STATUS_PHASE: Record<TicketStatus, StatusPhase> = {
  backlog: "open",
  spec: "open",
  ready: "open",
  planning: "active",
  planned: "active",
  in_progress: "active",
  blocked: "active", // "we're on it but stuck" vs a tracker's "In Progress" is not a contradiction
  review: "review",
  shipping: "review",
  done: "closed",
  dismissed: "closed",
};

/**
 * Does this ticket's local status contradict the tracker's last-known one?
 *
 * `external_status` is the raw label the last sync pulled (tickets.external_status, migration 90);
 * NULL — a native ticket, or a mirror no pull has covered yet — is never divergent. The local side
 * is read live, so a ticket Chronos closes right now shows divergent immediately rather than waiting
 * for the next 30m pull to notice. The canonical case: ACM-3, `dismissed` here with ClickUp still on
 * "in progress", which syncWorkspace deliberately does not mirror back in and which therefore left
 * no trace on any board before this.
 *
 * Freshness of the external side is the workspace's `last_sync` (GET /workspaces) — this is
 * last-known state, not live.
 */
export function isStatusDivergent(t: { status: string; external_status?: string | null }): boolean {
  const raw = t.external_status?.trim();
  if (!raw) return false;
  const local = STATUS_PHASE[t.status as TicketStatus];
  if (!local) return false; // unknown/legacy local status — no honest comparison to make
  return local !== STATUS_PHASE[mapStatus(raw)];
}

// Collapse a local lifecycle state to the nearest external status label (Chronos has states the
// trackers don't). Overridable per-workspace via connector_config.status_map (a null value there
// disables push for that state). Labels are matched case-insensitively by each connector.
export const DEFAULT_STATUS_MAP: Record<TicketStatus, string | null> = {
  backlog: "to do",
  spec: "to do",
  ready: "to do",
  planning: "in progress",
  planned: "in progress",
  in_progress: "in progress",
  review: "in review",
  shipping: "in review",
  blocked: "blocked",
  done: "done",
  // No tracker has our word for it. "done" is the honest collapse — the task is closed either way —
  // and a workspace whose tracker has a real "won't do" overrides this in connector_config.status_map.
  dismissed: "done",
};

export function externalStatusFor(local: TicketStatus, cfg: Record<string, any>): string | null {
  const map = cfg?.status_map ?? {};
  if (Object.prototype.hasOwnProperty.call(map, local)) return map[local]; // explicit override (incl. null)
  return DEFAULT_STATUS_MAP[local] ?? null;
}

// Fuzzy-map a tracker's priority label (Jira Highest/High/…, ClickUp urgent/high/…) to our P0..P3.
export function normalizePriority(raw: string | null | undefined): string | null {
  const t = (raw || "").toLowerCase();
  if (!t) return null;
  if (/urgent|highest|critical|blocker|p0/.test(t)) return "P0";
  if (/high|p1/.test(t)) return "P1";
  if (/normal|medium|p2/.test(t)) return "P2";
  if (/lowest|low|minor|trivial|p3/.test(t)) return "P3";
  return null;
}

// Flatten Jira's Atlassian Document Format (ADF) rich-text into plain text. Jira v3 returns
// description/comment bodies as nested ADF JSON; we only need readable text for the mirror.
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  let out = node.type === "text" ? String(node.text ?? "") : node.type === "mention" ? String(node.attrs?.text ?? "") : "";
  if (node.content) out += adfToText(node.content);
  if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") out += "\n";
  return out;
}

// Tracker ids of everyone a Jira ADF body @mentions — the mention nodes adfToText renders as "@Name".
export function adfMentions(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) adfMentions(n, out); return out; }
  if (node.type === "mention" && node.attrs?.id && !out.includes(String(node.attrs.id))) out.push(String(node.attrs.id));
  if (node.content) adfMentions(node.content, out);
  return out;
}
