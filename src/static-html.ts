import fs from "node:fs";
import type express from "express";

// Serving a static HTML page (the native overlay) — deliberately in its own module so the one
// security property that matters here is unit-testable without importing api.ts's full dependency
// graph (dispatcher/runner/terminal/scheduler — heavy, side-effecting modules; see CLAUDE.md #2).
//
// That property: the response is the file on disk, VERBATIM. This handler used to template the
// admin token into the <head> for loopback callers, which leaked it — sandboxed job agents keep
// loopback network, so `curl localhost:7777/overlay.html` handed them a token the sandbox denies
// them at the filesystem level (~/chronos/.admin-token). The token now travels out-of-band: the
// unsandboxed native overlay reads the file and injects it with a WKUserScript
// (desktop/overlay.swift). Nothing about the request — loopback or not — may change this response.
export function serveHtml(filePath: string, notBuiltMessage: string) {
  return (_req: express.Request, res: express.Response) => {
    if (!fs.existsSync(filePath)) {
      res.status(503).type("text").send(notBuiltMessage);
      return;
    }
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.type("html").sendFile(filePath);
  };
}
