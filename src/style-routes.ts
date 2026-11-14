/**
 * `/api/workspaces/:id/style…` — the house style over HTTP (src/house-style.ts), and what the visual
 * critic rendered (src/visual-critic.ts). Every route is walled to one workspace (CLAUDE.md gotcha #4):
 * its own token or the operator's; another workspace's token gets the same 404 a missing one does.
 *
 *   GET  /workspaces/:id/style?kind=dashboard|report|artifact[&rescan=1]   what `mc style` prints
 *   GET  /workspaces/:id/style/sources[?rescan=1]     the style sources found in its own profile and repos
 *   GET  /workspaces/:id/style/notes                  the corrections and approvals the page learns from
 *   POST /workspaces/:id/style/notes {text, kind?}    one correction (origin stamped from the caller, never the body)
 *   PUT  /workspaces/:id/style/guide {body}           replace the page (≤ STYLE_CAP, refused not trimmed)
 *   POST /workspaces/:id/style/learn                  rewrite the page now
 *   GET  /workspaces/:id/style/critique?session=<id>  the critic's newest verdict on that terminal's hand-offs
 *   GET  /workspaces/:id/critic/:pass/:file           one render (only names the critic wrote)
 */
import fs from "node:fs";
import type express from "express";
import { z } from "zod";
import { checkScope, tokenOk } from "./authz.js";
import { CONFIG } from "./config.js";
import { validate } from "./validation.js";
import { sessions, workspaces } from "./store.js";
import { addStyleNote, asKind, NOTE_CAP, saveStyleGuide, startStyleLearning, styleBrief, styleGuide, styleNotes } from "./house-style.js";
import { registeredSources } from "./style-sources.js";
import { criticFile, latestCritique } from "./visual-critic.js";
import type { Note } from "./types.js";

const NoteSchema = z.object({
  text: z.string().trim().min(1).max(NOTE_CAP),
  kind: z.enum(["correction", "approved"]).optional(),
  ref: z.string().trim().max(200).optional(),
});
// A transport bound only: the one-page cap is saveStyleGuide's, which refuses with how to fix it.
const GuideSchema = z.object({ body: z.string().trim().min(1).max(16000) });

const page = (n: Note | undefined) => (n ? { id: n.id, slug: n.slug, title: n.title, body: n.body, updated_at: n.updated_at } : null);
const flag = (v: unknown) => v === "1" || v === "true";

/** The workspace this route names, after the wall — or null once the refusal is answered. */
function own(req: express.Request, res: express.Response) {
  if (!checkScope(req, res, req.params.id)) return null;
  const ws = workspaces.get(req.params.id);
  if (!ws) { res.status(404).json({ error: "workspace not found" }); return null; }
  return ws;
}

export function mountStyleRoutes(api: express.Router): void {
  api.get("/workspaces/:id/style", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    const kind = asKind(req.query.kind);
    const text = styleBrief(ws, { kind, rescan: flag(req.query.rescan) });
    res.json({ text, kind, guide: page(styleGuide(ws.id)), sources: registeredSources(ws).sources });
  });
  api.get("/workspaces/:id/style/sources", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    res.json(registeredSources(ws, { rescan: flag(req.query.rescan) }));
  });
  api.get("/workspaces/:id/style/notes", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    res.json(styleNotes(ws.id));
  });
  api.post("/workspaces/:id/style/notes", validate(NoteSchema), (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    // Only the operator's own token speaks first-hand; a terminal relaying his words is an agent.
    const origin = tokenOk(req.get("x-mc-admin"), CONFIG.adminToken) ? "operator" : "agent";
    const r = addStyleNote(ws.id, { text: req.body.text, kind: req.body.kind, origin, ref: req.body.ref ?? null });
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.status(r.note ? 201 : 200).json({ added: !!r.note, note: r.note });
  });
  api.put("/workspaces/:id/style/guide", validate(GuideSchema), (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    const r = saveStyleGuide(ws.id, req.body.body);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json(page(r.note));
  });
  api.post("/workspaces/:id/style/learn", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    const r = startStyleLearning(ws);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.status(202).json(r);
  });
  api.get("/workspaces/:id/style/critique", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    const s = sessions.get(String(req.query.session ?? ""));
    // A terminal of another workspace is the same 404 as one that does not exist.
    if (!s || s.workspace_id !== ws.id) return res.status(404).json({ error: "session not found" });
    res.json({ critique: latestCritique(ws.id, s.id) });
  });
  api.get("/workspaces/:id/critic/:pass/:file", (req, res) => {
    const ws = own(req, res);
    if (!ws) return;
    const f = criticFile(ws.id, req.params.pass, req.params.file);
    if (!f) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", f.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(f.path).pipe(res);
  });
}
