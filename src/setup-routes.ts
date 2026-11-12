/**
 * The setup panel's routes: what is installed and signed in, a real test prompt, and — operator only —
 * installing a CLI and starting its browser sign-in. The checks themselves live in src/setup-check.ts.
 *
 *   GET  /setup/status          requireAdmin   the picture (cached 30 s; ?fresh=1 to look again)
 *   POST /setup/smoke/:id       requireAdmin   { ok, ms, reply?, error? }
 *   POST /setup/install/:id     operator only  { ok, log_tail }
 *   POST /setup/login/:id       operator only  { ok, message? }
 *
 * Installing software and signing an account in are the operator's own hand: the admin token itself,
 * from this Mac — never a Robert credential (requireAdmin lets the fleet-wide Robert through on most
 * writes, robert-scope.ts) and never a request a host link replayed.
 */
import express from "express";
import { isOperator } from "./authz.js";
import { installCli, isCliId, loginCli, setupStatus, smokeCli, type CliId } from "./setup-check.js";

export type SetupImpl = {
  status: (o: { fresh?: boolean }) => Promise<unknown>;
  smoke: (id: CliId) => Promise<unknown>;
  install: (id: CliId) => Promise<unknown>;
  login: (id: CliId) => Promise<unknown>;
};

const real: SetupImpl = {
  status: (o) => setupStatus(o),
  smoke: (id) => smokeCli(id),
  install: (id) => installCli(id),
  login: (id) => loginCli(id),
};

export const OPERATOR_ONLY = "only you can install or sign in — from the Desk or `npm run setup`, not with a Robert's credential";

export function setupRoutes(requireAdmin: express.RequestHandler, impl: SetupImpl = real): express.Router {
  const r = express.Router();
  const known = (req: express.Request, res: express.Response): CliId | null => {
    const id = String(req.params.id ?? "");
    if (isCliId(id)) return id;
    res.status(404).json({ error: `unknown CLI ${JSON.stringify(id.slice(0, 40))}` });
    return null;
  };
  const operator: express.RequestHandler = (req, res, next) => (isOperator(req) ? next() : void res.status(403).json({ error: OPERATOR_ONLY }));
  const send = (res: express.Response, p: Promise<unknown>) =>
    p.then((v) => res.json(v), (e) => res.status(500).json({ error: String(e?.message ?? e) }));

  r.get("/setup/status", requireAdmin, (req, res) => void send(res, impl.status({ fresh: req.query.fresh === "1" })));
  r.post("/setup/smoke/:id", requireAdmin, (req, res) => {
    const id = known(req, res);
    if (id) void send(res, impl.smoke(id));
  });
  r.post("/setup/install/:id", operator, (req, res) => {
    const id = known(req, res);
    if (id) void send(res, impl.install(id));
  });
  r.post("/setup/login/:id", operator, (req, res) => {
    const id = known(req, res);
    if (id) void send(res, impl.login(id));
  });
  return r;
}
