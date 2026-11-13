/**
 * `GET /api/setup/optional` (operator only) — the optional upgrades and where each one stands on this
 * Mac (src/setup-optional.ts). Admin only: it names what is installed and which keys are present (never
 * their values), which is this machine's inventory, not a workspace's business. The words say the
 * assistant's chosen name (settings.ts nameIt): setup and the welcome show them right after it is picked.
 */
import express from "express";
import { optionalUpgrades, probeOptional, type OptionalFacts } from "./setup-optional.js";
import { nameIt } from "./settings.js";

export function setupOptionalRoutes(requireAdmin: express.RequestHandler, probe: () => Promise<OptionalFacts> = () => probeOptional()): express.Router {
  const r = express.Router();
  r.get("/setup/optional", requireAdmin, async (_req, res) => {
    try {
      const items = optionalUpgrades(await probe()).map((i) => ({
        ...i, label: nameIt(i.label), why: nameIt(i.why), ...(i.default ? { default: nameIt(i.default) } : {}),
      }));
      res.json({ items, summary: { on: items.filter((i) => i.status === "on").length, total: items.length } });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  return r;
}
