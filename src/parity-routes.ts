/**
 * `/api/setup/parity` — "same tools as your own Claude / ChatGPT" (src/parity.ts).
 *
 *   GET  /setup/parity           the report: per CLI and profile, what the person's own setup has next
 *                                to what Chronos agents get, plus `fixes` and printable `lines`   (admin)
 *   POST /setup/parity/fix/:id   apply one fix                                                    (operator)
 *
 * Names only, never values (MCP definitions carry tokens). A fix changes which Claude Code setup —
 * which MCP servers, which login — the operator's agents start with, or writes into a profile's config,
 * so it takes the operator himself: the real admin token, sent from this computer. A Robert-derived
 * credential (requireAdmin may admit the fleet Robert for a read) and a request forwarded from a host
 * link are refused.
 */
import express from "express";
import { CONFIG } from "./config.js";
import { tokenOk } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { applyParityFix, FIX_ID_RE, parityReport, type ParityDeps } from "./parity.js";

/** Test seam: the fixture home, profiles and runner a test points the routes at. */
let depsOverride: ParityDeps | null = null;
export function setParityDepsForTest(d: ParityDeps | null): void {
  depsOverride = d;
}
const deps = (): ParityDeps => depsOverride ?? { profiles: CONFIG.profiles, claudeBin: CONFIG.claudeBin };

const operatorOnly = (req: express.Request): boolean =>
  forwardedHost(req) === null && tokenOk(req.get("x-mc-admin"), CONFIG.adminToken);

export function parityRoutes(requireAdmin: express.RequestHandler): express.Router {
  const router = express.Router();

  router.get("/setup/parity", requireAdmin, (_req, res) => {
    try {
      res.json(parityReport(deps()));
    } catch (e) {
      res.status(500).json({ error: `could not read the setups: ${(e as Error)?.message ?? e}` });
    }
  });

  router.post("/setup/parity/fix/:id", async (req, res) => {
    if (!operatorOnly(req)) return res.status(403).json({ error: "the operator's own admin token, from this computer, is required to change agents' tools" });
    const id = String(req.params.id ?? "");
    if (!FIX_ID_RE.test(id)) return res.status(404).json({ error: "unknown fix" });
    try {
      const result = await applyParityFix(id, deps());
      res.status(result.ok ? 200 : 409).json({ result, report: parityReport(deps()) });
    } catch (e) {
      res.status(500).json({ error: `fix failed: ${(e as Error)?.message ?? e}` });
    }
  });

  return router;
}
