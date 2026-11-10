/**
 * The request ledger's rows (migration 156, LEDGER.md): requests, the terminals serving them, what
 * came back, what the operator owes, and the verifier's checks. Plain reads and idempotent writes —
 * every rule about WHEN to write lives in src/ledger.ts, every rule about what a row MEANS in
 * src/ledger-model.ts. Every upsert is keyed so that replaying an event writes nothing new.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { GoalKind } from "../types.js";
import type {
  Action, CheckStatus, Decision, DeliverableKind, DeliverableState, Evidence, ItemStatus, LinkRole, Prereq, RequestState, Via,
} from "../ledger-model.js";

export interface RequestRow {
  id: string;
  /** Null = the operator's own (a fleet-wide parent, or a terminal with no workspace): admin only. */
  workspace_id: string | null;
  /** A fleet-wide request's per-workspace child points at the fleet-wide row. */
  parent_id: string | null;
  /** What was said, verbatim (clipped). For via `robert` these are Robert's words, not the operator's. */
  words: string;
  via: Via;
  /** Where he said it: desk · phone · bar · web. Null for terminals opened without a conversation. */
  surface: string | null;
  /** `sessions.created_by` of the terminal that opened it, or "robert" for a turn. */
  opened_by: string | null;
  /** The Robert turn that carried it (POST /agent's turn id). */
  turn_id: string | null;
  /** The work type — the same vocabulary as sessions.goal_kind (ledger-model.ts WORK). */
  kind: GoalKind | null;
  /** terminal = mirrored from the primary terminal's goal_kind · set = the opener said so. */
  kind_source: "terminal" | "set" | null;
  prereqs: Prereq[];
  state: RequestState;
  state_line: string | null;
  state_at: string;
  /** Newest hand-off counted for it. Null = no result yet. */
  result_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  asked_at: string;
  created_at: string;
  updated_at: string;
}

export interface NewRequest {
  workspace_id: string | null;
  parent_id?: string | null;
  words: string;
  via: Via;
  surface?: string | null;
  opened_by?: string | null;
  turn_id?: string | null;
  kind?: GoalKind | null;
  kind_source?: "terminal" | "set" | null;
  prereqs?: Prereq[];
  asked_at?: string;
}

export interface RequestLink {
  request_id: string;
  session_id: string;
  role: LinkRole;
  /** This request owns what the terminal hands off inside [linked_at, until). One open primary link per terminal. */
  primary: boolean;
  linked_at: string;
  /** When it was handed over (to a stand-in or a later request). Null = still serving. */
  until: string | null;
  linked_by: string | null;
}

export interface Deliverable {
  id: string;
  request_id: string;
  session_id: string | null;
  kind: DeliverableKind;
  /** What it is: a PR url, a draft's channel+recipient, an artifact id, a dashboard url, `outcome:<session>:<at>`. */
  ref: string;
  label: string | null;
  /** What it is NOW: a PR's head SHA, a draft's content hash (ledger-model.ts draftHash), a page's version. */
  target_hash: string | null;
  state: DeliverableState;
  /** The hand-off (outcome `at`) or event it came from. */
  source_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionItem {
  id: string;
  request_id: string;
  deliverable_id: string | null;
  /** An `answer` item follows this ask (src/asks.ts) — answered there, mirrored here. */
  ask_id: string | null;
  action: Action;
  label: string;
  /** What a yes binds to — copied from the deliverable when the item was raised, re-bound when it changes. */
  target_hash: string | null;
  /** Identity within the request: action | deliverable-or-ask | source. One item per question asked once. */
  item_key: string;
  source_at: string | null;
  status: ItemStatus;
  decision: Decision | null;
  /** His words, verbatim. */
  words: string | null;
  decided_by: string | null;
  decided_at: string | null;
  hold_until: string | null;
  /** The voice layer's recording of the answer, when it came by voice. */
  audio_ref: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckRow {
  id: string;
  request_id: string;
  deliverable_id: string | null;
  name: string;
  status: CheckStatus;
  evidence: Evidence[];
  note: string | null;
  /** What it checked (the PR head it ran against): a check for an older hash is stale. */
  target_hash: string | null;
  /** Who ran it: "verifier", "agent:<id8>", … */
  ran_by: string;
  ran_at: string;
  created_at: string;
}

const json = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const reqRow = (r: any): RequestRow | undefined => (r ? { ...r, prereqs: json<Prereq[]>(r.prereqs, []) } : undefined);
const linkRow = ({ is_primary, ...r }: any): RequestLink => ({ ...r, primary: !!is_primary });
const checkRow = (r: any): CheckRow => ({ ...r, evidence: json<Evidence[]>(r.evidence, []) });
const clip = (s: string | null | undefined, n: number) => (s == null ? null : String(s).slice(0, n));

export type RequestFilter = {
  /** undefined = every workspace (the operator); a string = that workspace only; null = only workspace-less rows. */
  workspace_id?: string | null;
  states?: RequestState[];
  /** Only rows with an open decision item. */
  needsDecision?: boolean;
  /** asked_at or state_at at/after this ISO time. */
  since?: string;
  /** Only rows linked to this terminal. */
  session_id?: string;
  parent_id?: string;
  /** Fleet-wide parents are shown by default only to the operator; children by default. */
  limit?: number;
};

export const requests = {
  create(r: NewRequest): RequestRow {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO requests (id,workspace_id,parent_id,words,via,surface,opened_by,turn_id,kind,kind_source,prereqs,state,state_line,state_at,asked_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'working',NULL,?,?,?,?)`,
    ).run(
      id, r.workspace_id, r.parent_id ?? null, String(r.words).slice(0, 4000), r.via, clip(r.surface, 24), clip(r.opened_by, 60),
      r.turn_id ?? null, r.kind ?? null, r.kind ? r.kind_source ?? "terminal" : null,
      r.prereqs?.length ? JSON.stringify(r.prereqs) : null, t, r.asked_at ?? t, t, t,
    );
    return requests.get(id)!;
  },
  get(id: string): RequestRow | undefined {
    return reqRow(db.prepare("SELECT * FROM requests WHERE id = ?").get(id));
  },
  /** Full id or a unique prefix (id8), like asks and runs. */
  resolve(idOrPrefix: string): RequestRow | undefined {
    const hit = requests.get(idOrPrefix);
    if (hit || !/^[0-9a-f-]{4,36}$/i.test(idOrPrefix)) return hit;
    const rows = db.prepare("SELECT * FROM requests WHERE id LIKE ? LIMIT 2").all(`${idOrPrefix}%`);
    return rows.length === 1 ? reqRow(rows[0]) : undefined;
  },
  /** The request a Robert turn carried into this workspace (null = the fleet-wide parent). */
  byTurn(turnId: string, workspaceId: string | null): RequestRow | undefined {
    return reqRow(db.prepare("SELECT * FROM requests WHERE turn_id = ? AND COALESCE(workspace_id,'') = ?").get(turnId, workspaceId ?? ""));
  },
  list(f: RequestFilter = {}): RequestRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (f.workspace_id === null) where.push("r.workspace_id IS NULL");
    else if (f.workspace_id !== undefined) { where.push("r.workspace_id = ?"); params.push(f.workspace_id); }
    if (f.states?.length) { where.push(`r.state IN (${f.states.map(() => "?").join(",")})`); params.push(...f.states); }
    if (f.needsDecision) where.push("EXISTS (SELECT 1 FROM request_decisions d WHERE d.request_id = r.id AND d.status = 'open')");
    if (f.since) { where.push("(r.asked_at >= ? OR r.state_at >= ?)"); params.push(f.since, f.since); }
    if (f.session_id) { where.push("EXISTS (SELECT 1 FROM request_terminals l WHERE l.request_id = r.id AND l.session_id = ?)"); params.push(f.session_id); }
    if (f.parent_id) { where.push("r.parent_id = ?"); params.push(f.parent_id); }
    // Most urgent first, then the newest move within a state.
    const sql =
      "SELECT r.* FROM requests r" + (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY CASE r.state WHEN 'needs_operator' THEN 0 WHEN 'stuck' THEN 1 WHEN 'working' THEN 2 WHEN 'done' THEN 3 ELSE 4 END, r.state_at DESC, r.asked_at DESC LIMIT ?";
    params.push(Math.max(1, Math.min(f.limit ?? 100, 500)));
    return (db.prepare(sql).all(...params) as any[]).map((r) => reqRow(r)!);
  },
  /** Not closed — what the sweep re-derives. */
  open(limit = 500): RequestRow[] {
    return (db.prepare("SELECT * FROM requests WHERE state != 'closed' ORDER BY state_at ASC LIMIT ?").all(limit) as any[]).map((r) => reqRow(r)!);
  },
  /** Writes only on a change; true when the state or its line moved. */
  setState(id: string, state: RequestState, line: string | null): boolean {
    const cur = db.prepare("SELECT state, state_line FROM requests WHERE id = ?").get(id) as { state: string; state_line: string | null } | undefined;
    if (!cur || (cur.state === state && (cur.state_line ?? null) === (line ?? null))) return false;
    const t = now();
    // state_at is when the STATE changed; a new line under the same state keeps it.
    db.prepare("UPDATE requests SET state = ?, state_line = ?, state_at = CASE WHEN state = ? THEN state_at ELSE ? END, updated_at = ? WHERE id = ?")
      .run(state, line, state, t, t, id);
    return cur.state !== state;
  },
  setKind(id: string, kind: GoalKind | null, source: "terminal" | "set", prereqs?: Prereq[]): void {
    db.prepare("UPDATE requests SET kind = ?, kind_source = ?, updated_at = ?" + (prereqs ? ", prereqs = ?" : "") + " WHERE id = ?")
      .run(...[kind, kind ? source : null, now(), ...(prereqs ? [prereqs.length ? JSON.stringify(prereqs) : null] : []), id]);
  },
  setPrereqs(id: string, prereqs: Prereq[]): void {
    db.prepare("UPDATE requests SET prereqs = ?, updated_at = ? WHERE id = ?").run(prereqs.length ? JSON.stringify(prereqs) : null, now(), id);
  },
  setResultAt(id: string, at: string | null): void {
    db.prepare("UPDATE requests SET result_at = ?, updated_at = ? WHERE id = ? AND COALESCE(result_at,'') != COALESCE(?,'')").run(at, now(), id, at);
  },
  close(id: string, reason: string): void {
    db.prepare("UPDATE requests SET closed_at = COALESCE(closed_at, ?), closed_reason = COALESCE(closed_reason, ?), updated_at = ? WHERE id = ?")
      .run(now(), String(reason).slice(0, 400), now(), id);
  },

  // ── links ────────────────────────────────────────────────────────────────────────────────────
  /** Idempotent: an existing (request, terminal) link is left as it is. True when it was created. */
  link(l: { request_id: string; session_id: string; role: LinkRole; primary: boolean; linked_at?: string; linked_by?: string | null }): boolean {
    const res = db.prepare(
      "INSERT OR IGNORE INTO request_terminals (request_id,session_id,role,is_primary,linked_at,until,linked_by) VALUES (?,?,?,?,?,NULL,?)",
    ).run(l.request_id, l.session_id, l.role, l.primary ? 1 : 0, l.linked_at ?? now(), clip(l.linked_by, 60));
    return res.changes > 0;
  },
  /** Hand a link over: its window closes now and nothing after counts for it. */
  closeLink(requestId: string, sessionId: string, at = now()): void {
    db.prepare("UPDATE request_terminals SET until = ? WHERE request_id = ? AND session_id = ? AND until IS NULL").run(at, requestId, sessionId);
  },
  linksFor(requestId: string): RequestLink[] {
    return (db.prepare("SELECT * FROM request_terminals WHERE request_id = ? ORDER BY linked_at ASC, rowid ASC").all(requestId) as any[]).map(linkRow);
  },
  /** Every link a terminal has had, oldest first; `open` = only those still serving. */
  linksOfSession(sessionId: string, opts: { open?: boolean } = {}): RequestLink[] {
    return (db.prepare(
      "SELECT * FROM request_terminals WHERE session_id = ?" + (opts.open ? " AND until IS NULL" : "") + " ORDER BY linked_at ASC, rowid ASC",
    ).all(sessionId) as any[]).map(linkRow);
  },
  /** The request that owns what this terminal hands off at `at` (default: now). */
  primaryAt(sessionId: string, at?: string): RequestLink | undefined {
    const rows = requests.linksOfSession(sessionId).filter((l) => l.primary);
    if (!at) return rows.filter((l) => !l.until).pop();
    return rows.filter((l) => l.linked_at <= at && (!l.until || at < l.until)).pop();
  },

  // ── deliverables ─────────────────────────────────────────────────────────────────────────────
  /** Keyed by (request, kind, ref). A new label/hash/source refreshes it; its state is never moved backwards. */
  upsertDeliverable(d: { request_id: string; session_id?: string | null; kind: DeliverableKind; ref: string; label?: string | null; target_hash?: string | null; source_at?: string | null }): Deliverable {
    const t = now();
    db.prepare(
      `INSERT INTO request_deliverables (id,request_id,session_id,kind,ref,label,target_hash,state,source_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'open',?,?,?)
       ON CONFLICT(request_id,kind,ref) DO UPDATE SET
         label = COALESCE(excluded.label, label),
         target_hash = COALESCE(excluded.target_hash, target_hash),
         source_at = CASE WHEN excluded.source_at IS NOT NULL AND (source_at IS NULL OR excluded.source_at > source_at) THEN excluded.source_at ELSE source_at END,
         updated_at = excluded.updated_at`,
    ).run(randomUUID(), d.request_id, d.session_id ?? null, d.kind, String(d.ref).slice(0, 600), clip(d.label, 300), d.target_hash ?? null, d.source_at ?? null, t, t);
    return db.prepare("SELECT * FROM request_deliverables WHERE request_id = ? AND kind = ? AND ref = ?").get(d.request_id, d.kind, String(d.ref).slice(0, 600)) as Deliverable;
  },
  deliverable(id: string): Deliverable | undefined {
    return db.prepare("SELECT * FROM request_deliverables WHERE id = ?").get(id) as Deliverable | undefined;
  },
  deliverables(requestId: string): Deliverable[] {
    return db.prepare("SELECT * FROM request_deliverables WHERE request_id = ? ORDER BY created_at ASC, rowid ASC").all(requestId) as Deliverable[];
  },
  /** Every deliverable with this identity in one workspace (one PR served by two requests). Never across workspaces. */
  deliverablesByRef(kind: DeliverableKind, ref: string, workspaceId: string | null): Deliverable[] {
    return db.prepare(
      "SELECT d.* FROM request_deliverables d JOIN requests r ON r.id = d.request_id WHERE d.kind = ? AND d.ref = ? AND r.workspace_id IS ?",
    ).all(kind, ref, workspaceId) as Deliverable[];
  },
  /** Open PR deliverables, for the sweep's look at what GitHub already says about them. */
  openOfKind(kind: DeliverableKind, limit = 300): Deliverable[] {
    return db.prepare("SELECT * FROM request_deliverables WHERE kind = ? AND state = 'open' ORDER BY updated_at ASC LIMIT ?").all(kind, limit) as Deliverable[];
  },
  setDeliverableState(id: string, state: DeliverableState): boolean {
    return db.prepare("UPDATE request_deliverables SET state = ?, updated_at = ? WHERE id = ? AND state != ?").run(state, now(), id, state).changes > 0;
  },
  /**
   * What a deliverable is now (a PR's new head, a rewritten draft). Every OPEN item on it is re-bound
   * in the same statement, so a yes he gave to the old target no longer matches anything.
   */
  bindTarget(deliverableId: string, hash: string | null): number {
    const t = now();
    db.prepare("UPDATE request_deliverables SET target_hash = ?, updated_at = ? WHERE id = ?").run(hash, t, deliverableId);
    return db.prepare("UPDATE request_decisions SET target_hash = ?, updated_at = ? WHERE deliverable_id = ? AND status IN ('open','held') AND COALESCE(target_hash,'') != COALESCE(?,'')")
      .run(hash, t, deliverableId, hash).changes;
  },

  // ── decision items ───────────────────────────────────────────────────────────────────────────
  /** Keyed by (request, item_key). An existing item is never reopened or overwritten — its history stands. */
  upsertItem(i: { request_id: string; action: Action; label: string; item_key: string; deliverable_id?: string | null; ask_id?: string | null; target_hash?: string | null; source_at?: string | null; status?: ItemStatus; hold_until?: string | null }): { item: DecisionItem; created: boolean } {
    const t = now();
    const res = db.prepare(
      `INSERT OR IGNORE INTO request_decisions (id,request_id,deliverable_id,ask_id,action,label,target_hash,item_key,source_at,status,hold_until,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), i.request_id, i.deliverable_id ?? null, i.ask_id ?? null, i.action, String(i.label).slice(0, 300), i.target_hash ?? null, i.item_key, i.source_at ?? null, i.status ?? "open", i.hold_until ?? null, t, t);
    const item = db.prepare("SELECT * FROM request_decisions WHERE request_id = ? AND item_key = ?").get(i.request_id, i.item_key) as DecisionItem;
    return { item, created: res.changes > 0 };
  },
  item(id: string): DecisionItem | undefined {
    return db.prepare("SELECT * FROM request_decisions WHERE id = ?").get(id) as DecisionItem | undefined;
  },
  items(requestId: string): DecisionItem[] {
    return db.prepare("SELECT * FROM request_decisions WHERE request_id = ? ORDER BY created_at ASC, rowid ASC").all(requestId) as DecisionItem[];
  },
  /** Items still owed (open) or deferred (held), for the queue — one workspace or every one. */
  pendingItems(workspaceId?: string | null): Array<DecisionItem & { workspace_id: string | null }> {
    const scoped = workspaceId !== undefined;
    return db.prepare(
      "SELECT d.*, r.workspace_id FROM request_decisions d JOIN requests r ON r.id = d.request_id WHERE d.status IN ('open','held')" +
        (scoped ? " AND r.workspace_id IS ?" : "") + " ORDER BY d.created_at ASC, d.rowid ASC",
    ).all(...(scoped ? [workspaceId] : [])) as Array<DecisionItem & { workspace_id: string | null }>;
  },
  itemsForAsk(askId: string): DecisionItem[] {
    return db.prepare("SELECT * FROM request_decisions WHERE ask_id = ?").all(askId) as DecisionItem[];
  },
  itemsForDeliverable(deliverableId: string): DecisionItem[] {
    return db.prepare("SELECT * FROM request_decisions WHERE deliverable_id = ? ORDER BY created_at ASC, rowid ASC").all(deliverableId) as DecisionItem[];
  },
  /** His answer. Only an open or held item moves; a second answer to the same item is refused (false). */
  decide(id: string, d: { decision: Decision; words?: string | null; by?: string | null; hold_until?: string | null; audio_ref?: string | null; at?: string }): DecisionItem | undefined {
    const at = d.at ?? now();
    const status: ItemStatus = d.decision === "later" ? "held" : "decided";
    const res = db.prepare(
      `UPDATE request_decisions SET status = ?, decision = ?, words = ?, decided_by = ?, decided_at = ?, hold_until = ?, audio_ref = COALESCE(?, audio_ref), updated_at = ?
       WHERE id = ? AND status IN ('open','held')`,
    ).run(status, d.decision, clip(d.words, 4000), clip(d.by, 60), at, d.decision === "later" ? d.hold_until ?? null : null, d.audio_ref ?? null, at, id);
    return res.changes > 0 ? requests.item(id) : undefined;
  },
  /** No longer the question: a newer hand-off asked it again, it was carried out another way, or the request closed. */
  supersede(id: string, by: string | null): boolean {
    return db.prepare("UPDATE request_decisions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND status IN ('open','held')")
      .run(by, now(), id).changes > 0;
  },
  /** An item the ask path or a hold mirror puts back on the list (a dated "later" that came due). */
  reopen(id: string): boolean {
    return db.prepare("UPDATE request_decisions SET status = 'open', updated_at = ? WHERE id = ? AND status = 'held'").run(now(), id).changes > 0;
  },
  setHold(id: string, until: string | null): boolean {
    return db.prepare("UPDATE request_decisions SET status = 'held', hold_until = ?, updated_at = ? WHERE id = ? AND status IN ('open','held')").run(until, now(), id).changes > 0;
  },
  /** Held items whose date has come. */
  holdsDue(nowIso: string): DecisionItem[] {
    return db.prepare("SELECT * FROM request_decisions WHERE status = 'held' AND hold_until IS NOT NULL AND hold_until <= ?").all(nowIso) as DecisionItem[];
  },

  // ── checks (the verifier's slot) ─────────────────────────────────────────────────────────────
  addCheck(c: { request_id: string; deliverable_id?: string | null; name: string; status: CheckStatus; evidence?: Evidence[]; note?: string | null; target_hash?: string | null; ran_by: string; ran_at?: string }): CheckRow {
    const id = randomUUID();
    const t = now();
    db.prepare(
      "INSERT INTO request_checks (id,request_id,deliverable_id,name,status,evidence,note,target_hash,ran_by,ran_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, c.request_id, c.deliverable_id ?? null, c.name, c.status, c.evidence?.length ? JSON.stringify(c.evidence) : null, clip(c.note, 2000), c.target_hash ?? null, String(c.ran_by).slice(0, 60), c.ran_at ?? t, t);
    return checkRow(db.prepare("SELECT * FROM request_checks WHERE id = ?").get(id));
  },
  checks(requestId: string): CheckRow[] {
    return (db.prepare("SELECT * FROM request_checks WHERE request_id = ? ORDER BY ran_at ASC").all(requestId) as any[]).map(checkRow);
  },
};
