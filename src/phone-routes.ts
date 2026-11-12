/**
 * `/api/phone/*` — the HTTP side of phone-access.ts, for the Desk's Phone dialog (static/desk-phone.js).
 *
 *   GET  /phone/status            (requireAdmin) how a phone reaches this Mac today, and the next step
 *   POST /phone/tailscale/enable  (operator only) `tailscale serve --bg <port>` + record the owner → { url }
 *
 * Enabling is the operator's own hand — the admin token itself, from this Mac — never a Robert
 * credential or anything replayed by a host: it opens the daemon to the tailnet and decides whose
 * account the owner gate (phone-gate.ts) lets in.
 */
import express from "express";
import { isOperator } from "./authz.js";
import { defaultPhoneDeps, enableTailscale, phoneStatus, type PhoneDeps } from "./phone-access.js";

export function phoneRoutes(requireAdmin: express.RequestHandler, deps: Partial<PhoneDeps> = {}): express.Router {
  const r = express.Router();
  const d = (): PhoneDeps => ({ ...defaultPhoneDeps(), ...deps });

  r.get("/phone/status", requireAdmin, async (_req, res) => {
    try {
      res.json(await phoneStatus(d()));
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  r.post("/phone/tailscale/enable", async (req, res) => {
    if (!isOperator(req)) return res.status(403).json({ error: "turning on phone access is the operator's own hand (the admin token, on this Mac)" });
    try {
      const out = await enableTailscale(d());
      if (out.ok) return res.json({ url: out.url });
      res.status(out.status).json({ error: out.error, step: out.step ?? null, fix: out.fix ?? null });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  return r;
}
