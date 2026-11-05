/**
 * The bar's routes ("Send to Chronos", src/capture.ts). Operator only: the bar is the operator's own
 * Mac app holding the admin token, and what it opens is a terminal in any workspace he picks.
 *
 *   POST   /capture/resolve       {ctx}                                → where it would go + the picker's list
 *   POST   /capture/file?name=&mime=   raw bytes                       → a staged file id (a screenshot from Shot)
 *   POST   /capture/open          {ctx, ws, instruction?, files?[]}    → a terminal in `ws`; its keys learned
 *   GET    /capture/routes                                             → every learned route
 *   DELETE /capture/routes/:key                                        → forget one
 */
import express from "express";
import { z } from "zod";
import { requireAdmin } from "./authz.js";
import { validate } from "./validation.js";
import { workspaces } from "./store.js";
import { LOCAL_HOST_ID } from "./hosts/index.js";
import { MAX_DROP_BYTES } from "./drops.js";
import {
  captureBrief,
  captureKeys,
  captureTitle,
  forgetCaptureRoute,
  learnCapture,
  listCaptureRoutes,
  resolveCapture,
  stageCaptureFile,
  stagedPath,
  type CaptureCtx,
} from "./capture.js";

const s = (max: number) => z.string().max(max).nullish();
export const CaptureCtxSchema = z.object({
  text: s(200_000),
  url: s(4000),
  app: s(120),
  bundle: s(200),
  title: s(1000),
  browser_url: s(4000),
});

const ResolveSchema = z.object({ ctx: CaptureCtxSchema.default({}) });
const OpenSchema = z.object({
  ctx: CaptureCtxSchema.default({}),
  ws: z.string().trim().min(1).max(64),
  instruction: z.string().max(4000).nullish(),
  files: z.array(z.string().regex(/^[a-f0-9]{12}$/)).max(10).optional(),
});

type OpenSession = (opts: any) => Promise<{ id: string; workspace_id: string | null }>;

export function mountCaptureRoutes(api: express.Router, deps: { openSession: OpenSession }): void {
  api.post("/capture/resolve", requireAdmin, validate(ResolveSchema), (req, res) => {
    const ctx = req.body.ctx as CaptureCtx;
    const route = resolveCapture(ctx);
    const list = workspaces.list().filter((w: any) => !w.archived).map((w) => ({ id: w.id, slug: w.slug, name: w.name }));
    res.json({ ...route, workspaces: list });
  });

  api.post(
    "/capture/file",
    requireAdmin,
    express.raw({ type: () => true, limit: MAX_DROP_BYTES }),
    (req, res) => {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const f = stageCaptureFile(buf, String(req.query.name ?? "capture"), String(req.query.mime ?? req.get("content-type") ?? ""));
        res.json(f);
      } catch (e: any) {
        res.status(400).json({ error: String(e?.message ?? e) });
      }
    },
  );

  api.post("/capture/open", requireAdmin, validate(OpenSchema), async (req, res) => {
    const { ctx, ws: wsRef, instruction } = req.body as { ctx: CaptureCtx; ws: string; instruction?: string | null };
    const w = workspaces.get(wsRef) ?? workspaces.getBySlug(wsRef);
    if (!w || (w as any).archived) return res.status(404).json({ error: `no workspace \`${wsRef}\`` });
    const files: string[] = (req.body.files ?? []).filter((id: string) => !!stagedPath(id));
    const { brief, overflow } = captureBrief(ctx, instruction);
    if (overflow) {
      try { files.push(stageCaptureFile(Buffer.from(overflow, "utf8"), "capture.txt", "text/plain").id); } catch {}
    }
    if (!brief.trim() && !files.length) return res.status(400).json({ error: "nothing captured" });
    try {
      const s = await deps.openSession({
        workspace_id: w.id,
        goal: captureTitle(ctx, instruction),
        description: brief,
        created_by: "capture",
        // A file only exists on this Mac, so a terminal that has one opens here; text goes wherever
        // placement puts it.
        host_id: files.length ? LOCAL_HOST_ID : null,
        stagedDrops: files,
      });
      // He opened it HERE: every key the capture carried now routes here — including the one he
      // corrected, which is the whole point of showing the guess.
      const learned = learnCapture(captureKeys(ctx).map((k) => k.key), w.id);
      res.json({ session: { id: s.id, workspace_id: s.workspace_id }, workspace: { id: w.id, slug: w.slug, name: w.name }, learned });
    } catch (e: any) {
      res.status(e?.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: String(e?.message ?? e) });
    }
  });

  api.get("/capture/routes", requireAdmin, (_req, res) => {
    res.json(listCaptureRoutes());
  });

  api.delete("/capture/routes/:key", requireAdmin, (req, res) => {
    res.json({ ok: forgetCaptureRoute(String(req.params.key)) });
  });
}
