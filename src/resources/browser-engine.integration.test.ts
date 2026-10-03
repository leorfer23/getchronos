/**
 * ONE real launch of the shared browser (darwin, when chrome-headless-shell / Chrome for Testing is
 * installed — skipped cleanly otherwise): lease a context through the CDP proxy, open about:blank in
 * it, release, assert the context is gone, stop, and assert no browser process is left behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { ChromeEngine, browserConfigFromEnv, findEngine } from "./browser-engine.js";

const engine = process.platform === "darwin" ? findEngine({ home: os.homedir(), platform: process.platform }).found : null;

async function cdp(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(String(d)); pending.get(m.id)?.(m); pending.delete(m.id); });
  return {
    send: (method: string, params: Record<string, unknown> = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }),
    close: () => ws.close(),
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const procsUsing = (dir: string): string => {
  try { return execFileSync("/usr/bin/pgrep", ["-f", dir], { encoding: "utf8" }).trim(); } catch { return ""; }
};

test("real browser: lease → page → release → context gone → stop leaves nothing running", { skip: engine ? false : "no chrome-headless-shell / Chrome for Testing installed", timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-browser-it-"));
  const eng = new ChromeEngine({ cfg: { ...browserConfigFromEnv({}), idleMs: 60_000 }, dataDir, log: () => {} });
  let pid: number | null = null;
  try {
    const lease = await eng.open();
    pid = eng.status().pid;
    assert.ok(pid && alive(pid));
    const c = await cdp(lease.ws_endpoint);
    const page = await c.send("Target.createTarget", { url: "about:blank", browserContextId: lease.context_id });
    assert.ok(page.result?.targetId, JSON.stringify(page));
    const before = await c.send("Target.getBrowserContexts");
    assert.ok(before.result.browserContextIds.includes(lease.context_id));
    // A second lease sees the browser through its own handle.
    const other = await eng.open();
    const c2 = await cdp(other.ws_endpoint);
    c.close();
    await eng.close(lease.handle);
    const after = await c2.send("Target.getBrowserContexts");
    assert.equal(after.result.browserContextIds.includes(lease.context_id), false, "the released context is disposed");
    const targets = await c2.send("Target.getTargets");
    assert.equal(targets.result.targetInfos.some((t: any) => t.targetId === page.result.targetId), false, "…and its page with it");
    c2.close();
    await eng.close(other.handle);
  } finally {
    await eng.stop("test");
    if (pid) for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    const left = procsUsing(dataDir);
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.ok(!pid || !alive(pid), "the browser process is gone");
    assert.equal(left, "", "no renderer/GPU helper left behind");
  }
});
