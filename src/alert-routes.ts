/**
 * `/api/alerts` and `/api/voice/presence` — the HTTP side of stuck-work alerts (src/stuck-alerts.ts).
 *
 *   GET  /alerts                  the record: every alert, what it said, which rungs ran, when he was
 *                                 told and when he acknowledged it; p50/p90 stuck→told; the self-check's
 *                                 misses; live calls; what is waiting out its grace   (?since=24h&limit=&kind=)
 *   POST /alerts/:id/ack          he has it — the ladder stops   {via?}   (the phone's tap, `mc alerts ack`)
 *   POST /alerts/:id/spoken       a live call said it            {client}
 *   POST /voice/presence          a page has a call up / hung up {client, surface, live, lang, lock}
 *
 * All operator-only (requireAdmin). The alerts span every workspace and are written for the
 * operator's own devices, so no workspace token and no project Robert may read or acknowledge them.
 */
import type express from "express";
import { z } from "zod";
import { requireAdmin } from "./authz.js";
import { ackAlert, alertView, alertsReport, checkAlertCoverage, confirmSpoken } from "./stuck-alerts.js";
import { notePresence } from "./voice-presence.js";

const AckSchema = z.object({ via: z.string().trim().max(40).optional() }).passthrough();
const SpokenSchema = z.object({ client: z.string().trim().max(80).optional() }).passthrough();
const PresenceSchema = z.object({
  client: z.string().trim().min(1).max(80),
  surface: z.string().trim().max(40).optional(),
  live: z.boolean(),
  lang: z.enum(["en", "es"]).optional(),
  lock: z.string().trim().max(80).nullable().optional(),
});

/** "24h", "90m", "7d", or an ISO date → ms. */
export function sinceMs(v: unknown, now = Date.now()): number | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const m = /^(\d+)\s*([mhd])$/i.exec(s);
  if (m) return now - Number(m[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2].toLowerCase()];
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

export function mountAlertRoutes(api: express.Router): void {
  api.get("/alerts", requireAdmin, async (req, res) => {
    // A read is also a look: the self-check runs (throttled to once a minute) so the misses shown are current.
    try { await checkAlertCoverage(); } catch {}
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    res.json(alertsReport({
      sinceMs: sinceMs(req.query.since),
      limit: Number.isFinite(limit) ? limit : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
    }));
  });

  api.post("/alerts/:id/ack", requireAdmin, (req, res) => {
    const p = AckSchema.safeParse(req.body ?? {});
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? "invalid" });
    const row = ackAlert(String(req.params.id), p.data.via || "api");
    if (!row) return void res.status(404).json({ error: "no such alert" });
    res.json({ ok: true, alert: alertView(row) });
  });

  api.post("/alerts/:id/spoken", requireAdmin, (req, res) => {
    const p = SpokenSchema.safeParse(req.body ?? {});
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? "invalid" });
    const row = confirmSpoken(String(req.params.id), p.data.client ?? null);
    if (!row) return void res.status(404).json({ error: "no such alert" });
    res.json({ ok: true, delivered_via: row.delivered_via });
  });

  api.post("/voice/presence", requireAdmin, (req, res) => {
    const p = PresenceSchema.safeParse(req.body ?? {});
    if (!p.success) return void res.status(400).json({ error: p.error.issues[0]?.message ?? "invalid" });
    notePresence(p.data);
    res.json({ ok: true });
  });
}
