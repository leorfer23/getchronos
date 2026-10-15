import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import type { CalEvent, Calendar, NewCalendar } from "../types.js";

export const calendars = {
  list(): Calendar[] {
    return db.prepare("SELECT * FROM calendars ORDER BY created_at ASC").all() as Calendar[];
  },
  get(id: string): Calendar | undefined {
    return db.prepare("SELECT * FROM calendars WHERE id = ?").get(id) as Calendar | undefined;
  },
  create(c: NewCalendar): Calendar {
    const id = randomUUID();
    const source = c.source ?? "ics";
    const ics = c.ics_url ?? (source === "gws" ? `gws://${c.account ?? "primary"}` : "");
    db.prepare(
      "INSERT INTO calendars (id,workspace_id,name,source,ics_url,account,config_dir,color,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,1,?)"
    ).run(id, c.workspace_id ?? null, c.name, source, ics, c.account ?? null, c.config_dir ?? null, c.color ?? null, now());
    return this.get(id)!;
  },
  markSync(id: string): void {
    db.prepare("UPDATE calendars SET last_sync = ? WHERE id = ?").run(now(), id);
  },
  update(id: string, patch: { workspace_id?: string | null; color?: string | null; name?: string; enabled?: boolean }): Calendar | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = {
      workspace_id: patch.workspace_id !== undefined ? patch.workspace_id : cur.workspace_id,
      color: patch.color !== undefined ? patch.color : cur.color,
      name: patch.name ?? cur.name,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : cur.enabled,
      id,
    };
    db.prepare("UPDATE calendars SET workspace_id=@workspace_id,color=@color,name=@name,enabled=@enabled WHERE id=@id").run(next as any);
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM calendars WHERE id = ?").run(id);
  },
};

export const calEvents = {
  // Full-replace a calendar's cached events.
  replace(calendarId: string, evs: Omit<CalEvent, "id" | "calendar_id">[]): void {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM cal_events WHERE calendar_id = ?").run(calendarId);
      const ins = db.prepare(
        "INSERT INTO cal_events (id,calendar_id,uid,title,start,end,all_day,location) VALUES (?,?,?,?,?,?,?,?)"
      );
      for (const e of evs)
        ins.run(randomUUID(), calendarId, e.uid ?? null, e.title, e.start, e.end ?? null, e.all_day ? 1 : 0, e.location ?? null);
    });
    tx();
  },
  agenda(fromIso: string, toIso: string, workspaceId?: string): Array<CalEvent & { calendar: string; color: string | null; workspace_id: string | null }> {
    const params: any = { from: fromIso, to: toIso };
    let wsClause = "";
    if (workspaceId) { wsClause = "AND c.workspace_id = @ws"; params.ws = workspaceId; }
    return db
      .prepare(
        `SELECT e.*, c.name AS calendar, c.color, c.workspace_id
         FROM cal_events e JOIN calendars c ON c.id = e.calendar_id
         WHERE c.enabled = 1 AND e.start < @to AND COALESCE(e.end, e.start) >= @from ${wsClause}
         ORDER BY e.start ASC`
      )
      .all(params) as any[];
  },
};
