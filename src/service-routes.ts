/**
 * `/api/services` — the HTTP side of services (src/services.ts, SERVICES.md).
 *
 *   GET    /services                  list (a workspace token: its own; the operator: all, or ?workspace=)
 *   GET    /services/:id              one, with live CPU/RAM and uptime
 *   GET    /services/:id/logs         output since ?from=<offset> (or the last ?tail= chars)
 *   POST   /services                  define one              (operator)
 *   PATCH  /services/:id              change its definition   (operator)
 *   DELETE /services/:id              stop it and delete it   (operator)
 *   POST   /services/:id/start|stop|restart|deploy           (operator)
 *
 * `:id` is a service id, or its name when that name is unique among what the caller can see (or
 * within ?workspace=).
 *
 * Everything that changes what runs, or whether it runs, is admin-gated: a service runs outside the
 * agent sandbox as the daemon's user, so letting a workspace token define or start one would hand any
 * agent a way out of its sandbox. A workspace token reads its own workspace's services and logs (404
 * for another's — CLAUDE.md gotcha #4). Env values never leave the daemon: rows carry `env_keys` only.
 */
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { z } from "zod";
import { callerScope, requireAdmin } from "./authz.js";
import { procsView } from "./resources/brain.js";
import { REF_RE, ServiceError, serviceSupervisor } from "./services.js";
import { envOf, RESTART_POLICIES, SERVICE_NAME_RE, services, workspaces, type Service } from "./store.js";
import { NAME_RE as ENV_NAME_RE } from "./store/workspace-vars.js";

type Req = express.Request;
type Res = express.Response;

const EnvMap = z.record(z.string(), z.string().max(8000).nullable()).refine(
  (m) => Object.keys(m).every((k) => ENV_NAME_RE.test(k) && !/^MC_/i.test(k)),
  { message: "env names are letters, digits and _ (not starting with a digit), and MC_* is the daemon's" },
).refine((m) => Object.keys(m).length <= 100, { message: "at most 100 env vars" });

const Definition = {
  name: z.string().trim().regex(SERVICE_NAME_RE, "lowercase letters, digits, - and _ (max 48)"),
  description: z.string().trim().max(500).nullable(),
  command: z.string().trim().min(1).max(4000),
  cwd: z.string().trim().min(1).max(1024),
  ref: z.string().trim().regex(REF_RE, "a branch, tag or sha").nullable(),
  restart: z.enum(RESTART_POLICIES as [string, ...string[]]),
};

const CreateSchema = z.object({
  workspace: z.string().trim().min(1).max(64),
  name: Definition.name,
  command: Definition.command,
  cwd: Definition.cwd,
  description: Definition.description.optional(),
  ref: Definition.ref.optional(),
  restart: Definition.restart.optional(),
  env: EnvMap.optional(),
  /** Switch it on right away. */
  start: z.boolean().optional(),
}).strict();

const PatchSchema = z.object({
  name: Definition.name.optional(),
  description: Definition.description.optional(),
  command: Definition.command.optional(),
  cwd: Definition.cwd.optional(),
  ref: Definition.ref.optional(),
  restart: Definition.restart.optional(),
  /** Merged into the current env: a string sets, null removes. */
  env: EnvMap.optional(),
}).strict();

const bad = (res: Res, e: z.ZodError) =>
  res.status(400).json({ error: `invalid request — ${e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}` });

function cwdError(cwd: string): string | null {
  if (!path.isAbsolute(cwd)) return `cwd must be an absolute path: ${cwd}`;
  try { if (!fs.statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`; } catch { return `cwd does not exist: ${cwd}`; }
  return null;
}

function wsFrom(raw: unknown) {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? workspaces.get(v) ?? workspaces.getBySlug(v) : undefined;
}

/** The services this caller may see. Null after answering the refusal. */
function visible(req: Req, res: Res): Service[] | null {
  const scope = callerScope(req);
  if (scope === null) { res.status(401).json({ error: "invalid workspace token" }); return null; }
  const named = req.query.workspace != null ? wsFrom(req.query.workspace) : undefined;
  if (req.query.workspace != null && (!named || (scope.ws !== null && named.id !== scope.ws))) {
    res.status(404).json({ error: "workspace not found" });
    return null;
  }
  return services.list(scope.ws ?? named?.id ?? null);
}

/** `:id` → the service, by id or by a name unique among what the caller sees. Null after answering. */
function find(req: Req, res: Res): Service | null {
  const all = visible(req, res);
  if (!all) return null;
  const key = String(req.params.id ?? "");
  const byId = all.find((s) => s.id === key);
  if (byId) return byId;
  const named = all.filter((s) => s.name === key);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    res.status(409).json({ error: `${named.length} services are named '${key}' — pass ?workspace=<slug> or the id` });
    return null;
  }
  res.status(404).json({ error: "service not found" });
  return null;
}

/** A row as the API shows it: no env values, plus what the ledger sees it using right now. */
export function serviceView(s: Service, usage = usageById()) {
  const { env: _env, ...rest } = s;
  const u = usage.get(s.id);
  const sup = serviceSupervisor();
  const up = s.status === "running" && s.started_at ? Date.now() - Date.parse(s.started_at) : null;
  return {
    ...rest,
    enabled: !!s.enabled,
    env_keys: Object.keys(envOf(s)).sort(),
    workspace_slug: workspaces.get(s.workspace_id)?.slug ?? null,
    live: sup.isLive(s.id),
    uptime_ms: up != null && Number.isFinite(up) ? up : null,
    pids: u?.pids ?? null,
    rss_mb: u?.rss_mb ?? null,
    cpu: u?.cpu ?? null,
    log_file: sup.logFile(s.id),
  };
}

function usageById(): Map<string, { pids: number; rss_mb: number; cpu: number }> {
  const m = new Map<string, { pids: number; rss_mb: number; cpu: number }>();
  try {
    for (const o of procsView(null).owners) if (o.kind === "service" && !o.ended) m.set(o.id, { pids: o.pids, rss_mb: o.rss_mb, cpu: o.cpu });
  } catch { /* reaper off or not started: no usage, not an error */ }
  return m;
}

function fail(res: Res, e: unknown): void {
  if (e instanceof ServiceError) { res.status(e.status).json({ error: e.message }); return; }
  console.warn(`[services] ${(e as Error)?.stack ?? e}`);
  res.status(500).json({ error: String((e as Error)?.message ?? e) });
}

export function mountServiceRoutes(api: express.Router): void {
  api.get("/services", (req, res) => {
    const all = visible(req, res);
    if (!all) return;
    const usage = usageById();
    res.json(all.map((s) => serviceView(s, usage)));
  });

  api.get("/services/:id", (req, res) => {
    const s = find(req, res);
    if (s) res.json(serviceView(s));
  });

  api.get("/services/:id/logs", (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const from = req.query.from != null ? Number(req.query.from) : undefined;
    const tail = req.query.tail != null ? Number(req.query.tail) : undefined;
    if ((from != null && (!Number.isInteger(from) || from < 0)) || (tail != null && (!Number.isInteger(tail) || tail < 1))) {
      res.status(400).json({ error: "from and tail are non-negative integers" });
      return;
    }
    res.json({ service_id: s.id, status: s.status, ...serviceSupervisor().output(s.id, from, Math.min(tail ?? 64_000, 256_000)) });
  });

  api.post("/services", requireAdmin, async (req, res) => {
    const p = CreateSchema.safeParse(req.body ?? {});
    if (!p.success) return bad(res, p.error);
    const b = p.data;
    const ws = wsFrom(b.workspace);
    if (!ws) return void res.status(404).json({ error: "workspace not found" });
    const ce = cwdError(b.cwd);
    if (ce) return void res.status(400).json({ error: ce });
    if (services.byName(ws.id, b.name)) return void res.status(409).json({ error: `${ws.slug} already has a service named '${b.name}'` });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.env ?? {})) if (v != null) env[k] = v;
    try {
      const s = services.create({
        workspace_id: ws.id, name: b.name, command: b.command, cwd: b.cwd, description: b.description ?? null,
        env, ref: b.ref ?? null, restart: (b.restart as Service["restart"]) ?? "always",
      });
      const out = b.start ? await serviceSupervisor().start(s.id) : s;
      res.status(201).json(serviceView(out));
    } catch (e) { fail(res, e); }
  });

  api.patch("/services/:id", requireAdmin, (req, res) => {
    const s = find(req, res);
    if (!s) return;
    const p = PatchSchema.safeParse(req.body ?? {});
    if (!p.success) return bad(res, p.error);
    const b = p.data;
    if (b.cwd) { const ce = cwdError(b.cwd); if (ce) return void res.status(400).json({ error: ce }); }
    if (b.name && b.name !== s.name && services.byName(s.workspace_id, b.name)) {
      return void res.status(409).json({ error: `this workspace already has a service named '${b.name}'` });
    }
    let env: Record<string, string> | undefined;
    if (b.env) {
      env = envOf(s);
      for (const [k, v] of Object.entries(b.env)) { if (v == null) delete env[k]; else env[k] = v; }
    }
    const next = services.update(s.id, { ...b, restart: b.restart as Service["restart"] | undefined, env });
    // A changed definition applies on the next start; say so rather than restarting on its own.
    res.json({ ...serviceView(next!), restart_needed: serviceSupervisor().isLive(s.id) && !!(b.command || b.cwd || b.env) });
  });

  api.delete("/services/:id", requireAdmin, async (req, res) => {
    const s = find(req, res);
    if (!s) return;
    try {
      await serviceSupervisor().stop(s.id);
      await serviceSupervisor().remove(s.id);
      services.delete(s.id);
      res.json({ deleted: s.id });
    } catch (e) { fail(res, e); }
  });

  for (const action of ["start", "stop", "restart", "deploy"] as const) {
    api.post(`/services/:id/${action}`, requireAdmin, async (req, res) => {
      const s = find(req, res);
      if (!s) return;
      const sup = serviceSupervisor();
      try {
        if (action === "deploy") {
          const r = await sup.deploy(s.id);
          return void res.json({ ...serviceView(r.service), deployed: { from: r.from, to: r.to, restarted: r.restarted } });
        }
        const out = action === "start" ? await sup.start(s.id) : action === "stop" ? await sup.stop(s.id) : await sup.restart(s.id);
        res.json(serviceView(out));
      } catch (e) { fail(res, e); }
    });
  }
}
