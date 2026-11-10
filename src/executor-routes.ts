/**
 * `/api/executor` — reading what the executor did (src/executor.ts). Nothing here runs anything: an
 * approval is created and carried out only by POST /api/ledger/:id/decision, from the operator's hand.
 *
 *   GET /executor/log     the audit log, newest first: who approved, his exact words, the surface,
 *                         what ran, the hashes compared, the result, the error. ?request= ?workspace=
 *                         ?status= ?limit=. The operator's alone — no Robert, workspace or Lead
 *                         credential reads it (it holds what he said in every workspace).
 *   GET /executor/status  is it on, which actions, the approval lifetime, what each channel can send
 *                         (?workspace=). The operator or a Robert credential: a Robert can then say
 *                         "the executor is off — turn it on in Settings" instead of guessing.
 */
import type express from "express";
import { isOperator, robertIdentity } from "./authz.js";
import { forwardedHost } from "./hostlink/brain-link.js";
import { executorStatus } from "./executor.js";
import { workspaces } from "./store.js";
import { executorStore } from "./store/executor.js";
import { requests } from "./store/requests.js";

export function mountExecutorRoutes(api: express.Router): void {
  api.get("/executor/log", (req, res) => {
    // His token, from this Mac, and no agent's header beside it (a terminal's `mc` always sends its own).
    const agent = req.get("x-mc-workspace-token") || req.get("x-mc-lead") || req.get("x-mc-session") || req.get("x-mc-agent");
    if (!isOperator(req) || agent) return res.status(403).json({ error: "the executor's log is the operator's (x-mc-admin)" });
    const q = req.query as Record<string, string | undefined>;
    let ws: string | undefined;
    if (q.workspace) {
      const w = workspaces.get(q.workspace) ?? workspaces.getBySlug(q.workspace);
      if (!w) return res.status(404).json({ error: "workspace not found" });
      ws = w.id;
    }
    const request = q.request ? requests.resolve(q.request)?.id ?? q.request : undefined;
    res.json(executorStore.logRows({ request_id: request, workspace_id: ws, status: q.status || undefined, limit: Number(q.limit) || 50 }));
  });

  api.get("/executor/status", (req, res) => {
    const robert = forwardedHost(req) === null ? robertIdentity(req.get("x-mc-admin")) : null;
    if (!isOperator(req) && !robert) return res.status(403).json({ error: "the operator or a Robert credential (x-mc-admin)" });
    const ref = typeof req.query.workspace === "string" ? req.query.workspace : "";
    const w = ref ? workspaces.get(ref) ?? workspaces.getBySlug(ref) : undefined;
    if (ref && !w) return res.status(404).json({ error: "workspace not found" });
    // A project's Robert asks about his own workspace only.
    if (robert && robert.ws !== null && w && w.id !== robert.ws) return res.status(404).json({ error: "workspace not found" });
    res.json(executorStatus(w?.id ?? (robert && robert.ws !== null ? robert.ws : null)));
  });
}
