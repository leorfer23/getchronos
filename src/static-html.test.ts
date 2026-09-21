import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveHtml } from "./static-html.js";

// Minimal req/res fakes — the handler only ever touches these four members.
function fakeReq(remoteAddress: string | undefined): any {
  return { socket: { remoteAddress } };
}
function fakeRes() {
  const calls: { status?: number; type?: string; sent?: string; sentFile?: string; headers: Record<string, string> } = {
    headers: {},
  };
  const res: any = {
    status(code: number) { calls.status = code; return res; },
    type(t: string) { calls.type = t; return res; },
    send(body: string) { calls.sent = body; return res; },
    sendFile(p: string) { calls.sentFile = p; return res; },
    setHeader(k: string, v: string) { calls.headers[k] = v; return res; },
  };
  return { res, calls };
}

test("serveHtml: sends the file itself, never a templated body — for loopback callers too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-static-html-"));
  const file = path.join(dir, "overlay.html");
  fs.writeFileSync(file, "<!doctype html><html><head><title>x</title></head><body></body></html>");
  try {
    const handler = serveHtml(file, "missing");
    // Loopback is the case that used to get the admin token injected (PER-4). It must now be
    // indistinguishable from any other caller: sendFile, no body of our own.
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", undefined]) {
      const { res, calls } = fakeRes();
      handler(fakeReq(ip), res);
      assert.equal(calls.sentFile, file, `sendFile for ${ip}`);
      assert.equal(calls.sent, undefined, `no in-memory body for ${ip}`);
      assert.equal(calls.headers["Cache-Control"], "no-store, must-revalidate");
      assert.equal(calls.status, undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serveHtml: 503s with the not-built message when the file is gone", () => {
  const handler = serveHtml(path.join(os.tmpdir(), "mc-does-not-exist-per4.html"), "Overlay UI missing.");
  const { res, calls } = fakeRes();
  handler(fakeReq("127.0.0.1"), res);
  assert.equal(calls.status, 503);
  assert.equal(calls.type, "text");
  assert.equal(calls.sent, "Overlay UI missing.");
});
