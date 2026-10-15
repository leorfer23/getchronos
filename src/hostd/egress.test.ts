/**
 * A workspace's egress proxy on a host (HOSTS.md phase 5): the brain's policy enforced by the same
 * proxy code, every connection reported for the brain's audit log (and kept while the link is down),
 * and a locked workspace refused — never spawned open, never spawned locked with nowhere to go.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { HostEgress, egressForSpawn } from "./egress.js";

const WS = { id: "ws-acme", slug: "acme" };
const upstream = http.createServer((_q, r) => r.end("upstream-ok"));
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upPort = (upstream.address() as net.AddressInfo).port;
const egresses: HostEgress[] = [];
after(() => { upstream.close(); for (const e of egresses) e.closeAll(); });

/** One CONNECT through the proxy; resolves the status line. */
function connect(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]); s.destroy(); });
    s.once("error", reject);
  });
}

test("enforce: the allowlist decides, each connection is reported, and records wait out a link drop", async () => {
  const e = new HostEgress();
  egresses.push(e);
  const sent: any[] = [];
  let up = false;
  e.setSink((r) => (up ? (sent.push(r), true) : false));
  const port = await e.ensure(WS.id, { mode: "enforce", allow: ["localhost"], base_allow: [] });
  assert.ok(port);
  assert.match(await connect(port!, `localhost:${upPort}`), /200/);
  assert.match(await connect(port!, "evil.example.com:443"), /403/);
  assert.match(await connect(port!, "169.254.169.254:80"), /403/, "the metadata IP floor holds on a host too");
  assert.equal(sent.length, 0, "nothing sent while the link is down");
  up = true;
  e.flush();
  assert.deepEqual(sent.map((r) => [r.workspace_id, r.host, r.action]), [
    [WS.id, "localhost", "allow"], [WS.id, "evil.example.com", "deny"], [WS.id, "169.254.169.254", "deny"],
  ]);
  // The policy is replaced by the next spawn's: an allowlist edit reaches a running proxy.
  assert.equal(await e.ensure(WS.id, { mode: "audit", allow: [], base_allow: [] }), port, "one proxy per workspace");
  assert.match(await connect(port!, `localhost:${upPort}`), /200/);
  assert.equal(sent.at(-1).action, "allow");
});

test("a spawn's egress: locked needs a proxy; audit gets the env but no lock", async () => {
  const e = new HostEgress();
  egresses.push(e);
  const locked = await egressForSpawn(e, WS, { mode: "enforce", allow: [], base_allow: [] }, true);
  assert.equal(locked.locked, true);
  assert.match(locked.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(locked.env.NO_PROXY, "localhost,127.0.0.1,::1", "the mc forwarder stays reachable");
  const audit = await egressForSpawn(e, { id: "ws-b", slug: "b" }, { mode: "audit", allow: [], base_allow: [] }, false);
  assert.equal(audit.locked, false);
  assert.ok(audit.env.HTTP_PROXY);
  await assert.rejects(egressForSpawn(undefined, WS, { mode: "enforce", allow: [], base_allow: [] }, true), /runs no egress proxy/);
  await assert.rejects(egressForSpawn(e, WS, null, true), /sent no egress policy/);
  assert.deepEqual(await egressForSpawn(undefined, WS, null, false), { env: {}, locked: false });
});
