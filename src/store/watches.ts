import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";

/**
 * A watch is "wake <owner> when <condition>" — see migration 94 for why it exists.
 *
 * Two modes, both free to evaluate:
 *  - `bus`  — match a bus event topic (plus optional field equality). Fires the instant it happens.
 *  - `poll` — GET a path on our own API every `every_sec` and test `when_expr` against the JSON.
 *
 * The store is dumb on purpose: every guard (caps, expiry, dedupe, the predicate grammar) lives in
 * src/watches.ts, so the tests can drive the engine without a live daemon.
 */
export type Watch = {
  id: string;
  owner: string;              // executive woken when it fires
  what: string;               // human label — also what the board post says
  mode: "bus" | "poll" | "at";
  on_topic: string | null;    // bus mode: the topic to match
  where_json: string | null;  // bus mode: JSON object of field → expected value
  check_path: string | null;  // poll mode: GET path on our own API
  when_expr: string | null;   // poll mode: predicate over the response JSON
  every_sec: number | null;
  at: string | null;          // at mode: the ISO instant this self-wake comes due
  say: string | null;         // extra instruction handed to the owner on wake
  one_shot: number;
  enabled: number;
  until: string;              // hard expiry — a watch is never forever
  workspace_id: string | null;
  created_by: string | null;
  created_at: string;
  last_checked_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  last_state: string | null;  // dedupe key for repeating watches
  disabled_reason: string | null;
};

export type NewWatch = Pick<Watch, "owner" | "what" | "mode" | "until"> &
  Partial<Omit<Watch, "id" | "created_at" | "fire_count">>;

const COLS = `id,owner,what,mode,on_topic,where_json,check_path,when_expr,every_sec,at,say,one_shot,
  enabled,until,workspace_id,created_by,created_at,last_checked_at,last_fired_at,fire_count,
  last_state,disabled_reason`;

export const watches = {
  create(p: NewWatch): Watch {
    const row: Watch = {
      id: randomUUID(),
      owner: p.owner,
      what: p.what,
      mode: p.mode,
      on_topic: p.on_topic ?? null,
      where_json: p.where_json ?? null,
      check_path: p.check_path ?? null,
      when_expr: p.when_expr ?? null,
      every_sec: p.every_sec ?? null,
      at: p.at ?? null,
      say: p.say ?? null,
      one_shot: p.one_shot ?? 1,
      enabled: p.enabled ?? 1,
      until: p.until,
      workspace_id: p.workspace_id ?? null,
      created_by: p.created_by ?? null,
      created_at: now(),
      last_checked_at: null,
      last_fired_at: null,
      fire_count: 0,
      last_state: null,
      disabled_reason: null,
    };
    db.prepare(
      `INSERT INTO watches (${COLS}) VALUES (@id,@owner,@what,@mode,@on_topic,@where_json,@check_path,
        @when_expr,@every_sec,@at,@say,@one_shot,@enabled,@until,@workspace_id,@created_by,@created_at,
        @last_checked_at,@last_fired_at,@fire_count,@last_state,@disabled_reason)`
    ).run(row);
    return row;
  },

  get(id: string): Watch | undefined {
    return db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Watch | undefined;
  },

  list(f: { owner?: string; enabled?: boolean; mode?: Watch["mode"]; workspace_id?: string | null } = {}): Watch[] {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (f.owner) { where.push("owner = @owner"); args.owner = f.owner; }
    if (f.enabled !== undefined) { where.push("enabled = @enabled"); args.enabled = f.enabled ? 1 : 0; }
    if (f.mode) { where.push("mode = @mode"); args.mode = f.mode; }
    if (f.workspace_id !== undefined) {
      if (f.workspace_id === null) where.push("workspace_id IS NULL");
      else { where.push("workspace_id = @workspace_id"); args.workspace_id = f.workspace_id; }
    }
    const sql = "SELECT * FROM watches" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY created_at DESC";
    return db.prepare(sql).all(args) as Watch[];
  },

  /** Live watches of one mode, cheapest query on the hot path (the bus handler and the tick). */
  live(mode: Watch["mode"]): Watch[] {
    return db
      .prepare("SELECT * FROM watches WHERE enabled = 1 AND mode = ? ORDER BY created_at")
      .all(mode) as Watch[];
  },

  patch(id: string, p: Partial<Watch>): Watch | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...p, id };
    db.prepare(
      `UPDATE watches SET owner=@owner, what=@what, mode=@mode, on_topic=@on_topic, where_json=@where_json,
        check_path=@check_path, when_expr=@when_expr, every_sec=@every_sec, at=@at, say=@say, one_shot=@one_shot,
        enabled=@enabled, until=@until, workspace_id=@workspace_id, last_checked_at=@last_checked_at,
        last_fired_at=@last_fired_at, fire_count=@fire_count, last_state=@last_state,
        disabled_reason=@disabled_reason WHERE id=@id`
    ).run(next);
    return next;
  },

  remove(id: string): void {
    db.prepare("DELETE FROM watches WHERE id = ?").run(id);
  },

  countActive(owner: string): number {
    return (db
      .prepare("SELECT COUNT(*) AS n FROM watches WHERE owner = ? AND enabled = 1")
      .get(owner) as { n: number }).n;
  },
};
