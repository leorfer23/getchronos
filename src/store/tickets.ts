import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { Ticket, TicketRow } from "../types.js";

/**
 * Ticket-key prefix for a workspace slug. Lives here, next to the keys themselves, because the
 * prefix is GLOBAL: "personal" and "presence" both yield PER, so anything resolving a key back to a
 * workspace has to treat a shared prefix as ambiguous rather than pick one (see src/tickets.ts's
 * sequence scan and src/thread-router.ts).
 */
export const wsPrefix = (slug: string) =>
  (slug.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase() || "WS");

export const tickets = {
  list(filter: { workspace_id?: string; status?: string } = {}): Ticket[] {
    const where: string[] = [];
    const params: any = {};
    if (filter.workspace_id) {
      where.push("workspace_id = @workspace_id");
      params.workspace_id = filter.workspace_id;
    }
    if (filter.status) {
      where.push("status = @status");
      params.status = filter.status;
    }
    const sql =
      "SELECT * FROM tickets" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY updated_at DESC";
    return db.prepare(sql).all(params) as Ticket[];
  },
  get(id: string): Ticket | undefined {
    return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined;
  },
  // Flow home view — open tickets across all non-archived workspaces, P0 first then oldest.
  flowQueue(): Ticket[] {
    return db
      .prepare(
        `SELECT t.* FROM tickets t JOIN workspaces w ON w.id = t.workspace_id
         WHERE w.archived = 0 AND t.status IN ('backlog','spec','ready','planning','planned','in_progress','blocked')
         ORDER BY t.priority ASC, t.created_at ASC`
      )
      .all() as Ticket[];
  },
  // Flow home view — review + recently-done tickets (non-archived ws), newest first, capped.
  flowShipped(sinceIso: string, limit = 50): Ticket[] {
    return db
      .prepare(
        `SELECT t.* FROM tickets t JOIN workspaces w ON w.id = t.workspace_id
         WHERE w.archived = 0 AND (t.status = 'review' OR (t.status = 'done' AND t.updated_at >= @since))
         ORDER BY t.updated_at DESC LIMIT @limit`
      )
      .all({ since: sinceIso, limit }) as Ticket[];
  },
  byExternal(system: string, externalId: string): Ticket | undefined {
    return db
      .prepare("SELECT * FROM tickets WHERE external_system = ? AND external_id = ?")
      .get(system, externalId) as Ticket | undefined;
  },
  countByWorkspace(workspaceId: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) c FROM tickets WHERE workspace_id = ?")
        .get(workspaceId) as { c: number }
    ).c;
  },
  create(t: TicketRow): Ticket {
    const ts = now();
    db.prepare(
      `INSERT INTO tickets (id,workspace_id,repo_id,key,slug,title,status,status_source,priority,complexity,complexity_source,backend,model,
        assignee,file_path,external_system,external_id,external_url,external_status,tags,created_at,updated_at)
       VALUES (@id,@workspace_id,@repo_id,@key,@slug,@title,@status,@status_source,@priority,@complexity,@complexity_source,@backend,@model,
        @assignee,@file_path,@external_system,@external_id,@external_url,@external_status,@tags,@created_at,@updated_at)`
    ).run({ ...t, status_source: t.status_source ?? "local", complexity_source: t.complexity_source ?? null, external_status: t.external_status ?? null, created_at: ts, updated_at: ts });
    return this.get(t.id)!;
  },
  update(id: string, patch: Partial<TicketRow>): Ticket | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, updated_at: now() };
    db.prepare(
      `UPDATE tickets SET repo_id=@repo_id,title=@title,status=@status,status_source=@status_source,priority=@priority,complexity=@complexity,complexity_source=@complexity_source,
        backend=@backend,model=@model,assignee=@assignee,file_path=@file_path,
        external_system=@external_system,external_id=@external_id,external_url=@external_url,external_status=@external_status,
        tags=@tags,pr_url=@pr_url,pr_state=@pr_state,ci_state=@ci_state,ci_checks=@ci_checks,summary=@summary,report=@report,updated_at=@updated_at WHERE id=@id`
    ).run(next as any);
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM tickets WHERE id = ?").run(id);
  },
  // Cost/token rollup for one ticket: sum over every run whose job is bound to the ticket (plan,
  // build, review, distill — all go through jobs.ticket_id). Interactive PTY terminals aren't costed
  // (no usage stream captured), so this reflects headless agent spend. models = distinct job models.
  cost(ticketId: string): { cost_usd: number; tokens_in: number; tokens_out: number; runs: number; models: string[] } {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(r.cost_usd),0) AS cost_usd,
           COALESCE(SUM(r.tokens_in),0) AS tokens_in, COALESCE(SUM(r.tokens_out),0) AS tokens_out,
           COUNT(r.id) AS runs, GROUP_CONCAT(DISTINCT j.model) AS models
         FROM jobs j JOIN runs r ON r.job_id = j.id WHERE j.ticket_id = ?`
      )
      .get(ticketId) as any;
    return {
      cost_usd: r?.cost_usd ?? 0,
      tokens_in: r?.tokens_in ?? 0,
      tokens_out: r?.tokens_out ?? 0,
      runs: r?.runs ?? 0,
      models: r?.models ? String(r.models).split(",").filter(Boolean) : [],
    };
  },
  // Batch rollup for a list view: one grouped query → map keyed by ticket_id. Only tickets with
  // at least one run appear; callers default the rest to zero.
  costMap(workspaceId?: string): Record<string, { cost_usd: number; tokens_in: number; tokens_out: number; runs: number; models: string[] }> {
    const rows = db
      .prepare(
        `SELECT j.ticket_id AS ticket_id, COALESCE(SUM(r.cost_usd),0) AS cost_usd,
           COALESCE(SUM(r.tokens_in),0) AS tokens_in, COALESCE(SUM(r.tokens_out),0) AS tokens_out,
           COUNT(r.id) AS runs, GROUP_CONCAT(DISTINCT j.model) AS models
         FROM jobs j JOIN runs r ON r.job_id = j.id
         WHERE j.ticket_id IS NOT NULL ${workspaceId ? "AND j.workspace_id = @ws" : ""}
         GROUP BY j.ticket_id`
      )
      .all(workspaceId ? { ws: workspaceId } : {}) as any[];
    const out: Record<string, any> = {};
    for (const r of rows)
      out[r.ticket_id] = {
        cost_usd: r.cost_usd ?? 0,
        tokens_in: r.tokens_in ?? 0,
        tokens_out: r.tokens_out ?? 0,
        runs: r.runs ?? 0,
        models: r.models ? String(r.models).split(",").filter(Boolean) : [],
      };
    return out;
  },
};

export const LINK_TYPES = ["blocks", "parent", "relates", "duplicates"] as const;
export type LinkType = (typeof LINK_TYPES)[number];
// Directed edges only enforce acyclicity for the hierarchical/dependency kinds.
const ACYCLIC: LinkType[] = ["blocks", "parent"];

export const ticketLinks = {
  // One row per stored edge, joined with the counterpart ticket + a direction relative to `id`.
  forTicket(id: string): Array<{ id: string; type: LinkType; dir: "out" | "in"; ticket: Ticket }> {
    const rows = db
      .prepare(
        `SELECT l.id, l.type, l.from_id, l.to_id FROM ticket_links l
         WHERE l.from_id = @id OR l.to_id = @id ORDER BY l.created_at ASC`
      )
      .all({ id }) as Array<{ id: string; type: LinkType; from_id: string; to_id: string }>;
    const out: Array<{ id: string; type: LinkType; dir: "out" | "in"; ticket: Ticket }> = [];
    for (const r of rows) {
      const dir = r.from_id === id ? "out" : "in";
      const otherId = dir === "out" ? r.to_id : r.from_id;
      const ticket = tickets.get(otherId);
      if (ticket) out.push({ id: r.id, type: r.type, dir, ticket });
    }
    return out;
  },
  // Tickets that must finish before `id` can build: incoming `blocks` edges whose source is still open
  // (a dismissed blocker is a decision not to do it — it must not hold its dependents hostage).
  blockersOpen(id: string): Ticket[] {
    return db
      .prepare(
        `SELECT t.* FROM ticket_links l JOIN tickets t ON t.id = l.from_id
         WHERE l.to_id = @id AND l.type = 'blocks' AND t.status NOT IN ('done','dismissed')
         ORDER BY t.updated_at DESC`
      )
      .all({ id }) as Ticket[];
  },
  // Would from→to (of an acyclic type) create a cycle? True if `to` already reaches `from` via same type.
  wouldCycle(fromId: string, toId: string, type: LinkType): boolean {
    if (!ACYCLIC.includes(type)) return false;
    if (fromId === toId) return true;
    const hit = db
      .prepare(
        `WITH RECURSIVE reach(id) AS (
           SELECT to_id FROM ticket_links WHERE from_id = @to AND type = @type
           UNION
           SELECT l.to_id FROM ticket_links l JOIN reach r ON l.from_id = r.id AND l.type = @type
         ) SELECT 1 FROM reach WHERE id = @from LIMIT 1`
      )
      .get({ to: toId, from: fromId, type }) as unknown;
    return !!hit;
  },
  add(fromId: string, toId: string, type: LinkType): { id: string; type: LinkType; from_id: string; to_id: string } {
    if (!LINK_TYPES.includes(type)) throw new Error(`invalid link type: ${type}`);
    if (fromId === toId) throw new Error("a ticket cannot link to itself");
    if (!tickets.get(fromId) || !tickets.get(toId)) throw new Error("ticket not found");
    if (this.wouldCycle(fromId, toId, type)) throw new Error(`link would create a ${type} cycle`);
    const id = randomUUID();
    db.prepare(
      `INSERT OR IGNORE INTO ticket_links (id, from_id, to_id, type, created_at)
       VALUES (@id, @from_id, @to_id, @type, @created_at)`
    ).run({ id, from_id: fromId, to_id: toId, type, created_at: now() });
    return { id, type, from_id: fromId, to_id: toId };
  },
  get(id: string): { id: string; type: LinkType; from_id: string; to_id: string } | undefined {
    return db.prepare("SELECT id, type, from_id, to_id FROM ticket_links WHERE id = ?").get(id) as
      | { id: string; type: LinkType; from_id: string; to_id: string }
      | undefined;
  },
  remove(id: string): void {
    db.prepare("DELETE FROM ticket_links WHERE id = ?").run(id);
  },
  // Set of ticket ids currently blocked (have ≥1 open `blocks` upstream). One query for list views.
  blockedIds(): Set<string> {
    const rows = db
      .prepare(
        `SELECT DISTINCT l.to_id AS id FROM ticket_links l JOIN tickets t ON t.id = l.from_id
         WHERE l.type = 'blocks' AND t.status NOT IN ('done','dismissed')`
      )
      .all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  },
  // Parent chain of `id`, root-first: walk incoming `parent` edges upward (from=parent, to=child).
  // Feeds goal-ancestry injection so a sub-ticket's agent knows why it exists. Acyclic by construction.
  ancestors(id: string): Ticket[] {
    return db
      .prepare(
        `WITH RECURSIVE up(fid, depth) AS (
           SELECT from_id, 1 FROM ticket_links WHERE to_id = @id AND type = 'parent'
           UNION
           SELECT l.from_id, up.depth + 1 FROM ticket_links l JOIN up ON l.to_id = up.fid AND l.type = 'parent'
         ) SELECT t.* FROM up JOIN tickets t ON t.id = up.fid ORDER BY up.depth DESC`
      )
      .all({ id }) as Ticket[];
  },
  // Direct children of a goal: outgoing `parent` edges (from=parent, to=child). P0-first.
  children(id: string): Ticket[] {
    return db
      .prepare(
        `SELECT t.* FROM ticket_links l JOIN tickets t ON t.id = l.to_id
         WHERE l.from_id = @id AND l.type = 'parent' ORDER BY t.priority ASC, t.created_at ASC`
      )
      .all({ id }) as Ticket[];
  },
  // Ids of every ticket that is a goal (parent of ≥1 child). One query for list views + the autoplan guard.
  goalIds(): Set<string> {
    const rows = db.prepare(`SELECT DISTINCT from_id AS id FROM ticket_links WHERE type = 'parent'`).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  },
};
