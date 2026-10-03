/**
 * ONE real launch of the shared browser (darwin, when chrome-headless-shell / Chrome for Testing is
 * installed — skipped cleanly otherwise). Two leases through the lease proxy: each sees and touches
 * only its own page, Chrome listens on no TCP port at all, a forged secret is turned away, the page
 * cannot read the daemon's disk; release disposes the context; stop leaves no process behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
    send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    close: () => ws.close(),
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sh = (cmd: string, args: string[]): string => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return ""; } };

test("real browser: two leases isolated, no debugging port, forged secret refused, no file reads, nothing left running", { skip: engine ? false : "no chrome-headless-shell / Chrome for Testing installed", timeout: 30_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-browser-it-"));
  const eng = new ChromeEngine({ cfg: { ...browserConfigFromEnv({}), idleMs: 60_000 }, dataDir, log: () => {} });
  let pid: number | null = null;
  try {
    const A = await eng.open(), B = await eng.open();
    pid = eng.status().pid;
    assert.ok(pid && alive(pid));
    // No door but the proxy: the browser (and every helper process of it) listens on nothing.
    const kids = sh("/usr/bin/pgrep", ["-P", String(pid)]).split("\n").filter(Boolean);
    for (const p of [String(pid), ...kids]) assert.equal(sh("/usr/sbin/lsof", ["-nP", "-a", "-p", p, "-iTCP", "-sTCP:LISTEN"]), "", `pid ${p} listens on TCP`);
    // Control: lsof does see a listener — the lease proxy, in THIS process, on loopback only.
    const proxyPort = new URL(A.ws_endpoint).port;
    const mine = sh("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN"]);
    assert.match(mine, new RegExp(`127\\.0\\.0\\.1:${proxyPort} \\(LISTEN\\)`), "the check can see a listener");
    const prof = fs.readdirSync(dataDir).find((n) => n.startsWith("profile-"))!;
    assert.equal(fs.existsSync(path.join(dataDir, prof, "DevToolsActivePort")), false, "no port file to find");
    assert.equal(fs.statSync(path.join(dataDir, prof)).mode & 0o777, 0o700);
    await assert.rejects(cdp(A.ws_endpoint.replace(/[^/]+$/, randomBytes(32).toString("base64url"))), /404/, "forged secret");

    const a = await cdp(A.ws_endpoint), b = await cdp(B.ws_endpoint);
    const aPage = (await a.send("Target.createTarget", { url: "about:blank", browserContextId: A.context_id })).result?.targetId;
    const bPage = (await b.send("Target.createTarget", { url: "about:blank", browserContextId: B.context_id })).result?.targetId;
    assert.ok(aPage && bPage);
    assert.deepEqual((await b.send("Target.getTargets")).result.targetInfos.map((t: any) => t.targetId), [bPage], "B lists only its own page");
    assert.match((await b.send("Target.attachToTarget", { targetId: aPage, flatten: true })).error?.message ?? "", /not a target of this Chronos browser lease/);
    assert.match((await b.send("Target.closeTarget", { targetId: aPage })).error?.message ?? "", /not a target of this Chronos browser lease/);
    assert.deepEqual((await b.send("Target.getBrowserContexts")).result.browserContextIds, [B.context_id]);
    assert.match((await b.send("SystemInfo.getInfo")).error?.message ?? "", /not available/);

    // A's page, end to end — and it cannot read the daemon's disk.
    const s = (await a.send("Target.attachToTarget", { targetId: aPage, flatten: true })).result.sessionId;
    assert.match((await a.send("Page.navigate", { url: "file:///etc/hosts" }, s)).error?.message ?? "", /only http\(s\)/);
    const read = await a.send("Runtime.evaluate", { expression: "fetch('file:///etc/hosts').then(() => 'read', () => 'blocked')", awaitPromise: true }, s);
    assert.equal(read.result?.result?.value, "blocked");
    assert.equal((await a.send("Runtime.evaluate", { expression: "6 * 7", returnByValue: true }, s)).result.result.value, 42);

    a.close();
    await eng.close(A.handle);
    const ctxs = (await b.send("Target.getBrowserContexts")).result.browserContextIds;
    assert.deepEqual(ctxs, [B.context_id]);
    const all = await (eng as any).run.mux.send("Target.getBrowserContexts");
    assert.equal(all.browserContextIds.includes(A.context_id), false, "the released context is disposed");
    const targets = await (eng as any).run.mux.send("Target.getTargets");
    assert.equal(targets.targetInfos.some((t: any) => t.targetId === aPage), false, "…and its page with it");
    b.close();
    await eng.close(B.handle);
  } finally {
    await eng.stop("test");
    if (pid) for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    const left = sh("/usr/bin/pgrep", ["-f", dataDir]);
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert.ok(!pid || !alive(pid), "the browser process is gone");
    assert.equal(left, "", "no renderer/GPU helper left behind");
  }
});
