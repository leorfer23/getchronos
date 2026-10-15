import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { brokerCall, credAllows, loadBrokerCreds, resolveSecret, validateCred, wsAllowed, type BrokerCred } from "./broker.js";

const base: BrokerCred = {
  slug: "gh",
  host: "api.github.com",
  header: "Authorization",
  scheme: "Bearer",
  secret: "s3cret",
  allow_methods: ["GET", "POST"],
  allow_path_prefixes: ["/repos/", "/user"],
};

test("validateCred: accepts the canonical shape, rejects the sharp edges", () => {
  assert.equal(validateCred(base), null);
  assert.match(validateCred({ ...base, slug: "Bad Slug" })!, /slug/);
  assert.match(validateCred({ ...base, host: "api..github.com" })!, /host/);
  assert.match(validateCred({ ...base, header: "X:Injected" })!, /header/);
  assert.match(validateCred({ ...base, secret: undefined })!, /exactly one/);
  assert.match(validateCred({ ...base, secret_env: "ALSO" })!, /exactly one/);
  assert.match(validateCred({ ...base, allow_methods: ["YOLO"] })!, /method/);
  assert.match(validateCred({ ...base, allow_path_prefixes: ["repos"] })!, /start with/);
});

const target = (p: string, m = "GET") => {
  const r = credAllows(base, m, p);
  assert.ok(r.ok, `expected allow, got ${r.ok ? "" : r.error}`);
  return r.target;
};
const refusal = (p: string, m = "GET") => {
  const r = credAllows(base, m, p);
  assert.ok(!r.ok, `expected refusal for ${p}`);
  return r.error;
};

test("credAllows: allowed paths return the exact target that will be sent", () => {
  assert.equal(target("/repos/x/y", "get"), "/repos/x/y");
  assert.equal(target("/user"), "/user");
  assert.equal(target("/repos/x?per_page=100"), "/repos/x?per_page=100");
});

test("credAllows: hostile paths rejected", () => {
  assert.match(refusal("/repos/x", "DELETE"), /method/);
  assert.match(refusal("/admin"), /allowlist/);
  assert.match(refusal("repos/x"), /start with/);
  assert.match(refusal("//evil.com/x"), /protocol-relative/);
  assert.match(refusal("/repos/../admin"), /allowlist|traversal/);
  assert.match(refusal("/repos/%2e%2e/admin"), /encoded/);
  assert.match(refusal("/repos/a b"), /whitespace/);
  assert.match(refusal("/repos/x\r\nHost: evil"), /whitespace/);
});

test("credAllows: backslash authority confusion cannot prepend a segment", () => {
  // WHATWG treats \ as / for special schemes, so "/\user/repos" parses with "user" as the
  // AUTHORITY — gating a relative parse while sending the raw path let an agent reach
  // //<anything>/<allowed-path>, which upstreams that collapse slashes resolve to /<anything>/…
  assert.match(refusal("/\\user/repos"), /backslash|protocol-relative/);
  assert.match(refusal("/\\evil.com/repos/x"), /backslash|protocol-relative/);
  assert.match(refusal("/repos/x\\y"), /backslash/);
});

test("credAllows: double-encoding does not survive the escape guard", () => {
  assert.match(refusal("/repos/%252e%252e/admin"), /encoded/);
  assert.match(refusal("/repos/%252f/admin"), /encoded/);
});

test("credAllows: prefixes match on segment boundaries, not raw string prefixes", () => {
  // "/user" must not also grant the whole "/users/*" tree.
  assert.match(refusal("/users/octocat"), /allowlist/);
  assert.match(refusal("/user-admin"), /allowlist/);
  assert.equal(target("/user/repos"), "/user/repos");
});

test("wsAllowed: omitted = everyone; listed = those slugs plus admin", () => {
  assert.equal(wsAllowed(base, "anyws"), true);
  const scoped = { ...base, workspaces: ["personal"] };
  assert.equal(wsAllowed(scoped, "personal"), true);
  assert.equal(wsAllowed(scoped, "other"), false);
  assert.equal(wsAllowed(scoped, null), true); // admin
});

test("resolveSecret: inline wins, env ref resolves, missing env is null", () => {
  assert.equal(resolveSecret(base), "s3cret");
  assert.equal(resolveSecret({ ...base, secret: undefined, secret_env: "BRK_T" }, { BRK_T: "from-env" } as any), "from-env");
  assert.equal(resolveSecret({ ...base, secret: undefined, secret_env: "MISSING" }, {} as any), null);
});

test("loadBrokerCreds: missing file is empty, bad entries dropped, good ones kept", () => {
  assert.deepEqual(loadBrokerCreds("/nonexistent/broker.json"), []);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brk-")), "b.json");
  fs.writeFileSync(f, JSON.stringify([base, { ...base, slug: "BAD SLUG" }]));
  const creds = loadBrokerCreds(f);
  assert.equal(creds.length, 1);
  assert.equal(creds[0].slug, "gh");
});

// End-to-end against a local server: header injected, allowlist enforced upstream of the wire,
// redirects returned unfollowed. insecure_http is CHRONOS_TEST-gated (validateCred enforces that).
const seen: Array<{ url: string; auth: string | undefined; method: string }> = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url!, auth: req.headers.authorization, method: req.method! });
  if (req.url!.startsWith("/repos/redirect")) {
    res.writeHead(302, { location: "http://evil.invalid/steal" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
after(() => server.close());

const local: BrokerCred = { ...base, host: `127.0.0.1:${port}`, insecure_http: true };

test("brokerCall injects the header server-side and returns the response", async () => {
  const out = await brokerCall(local, "GET", "/repos/x/y?page=2", undefined, undefined);
  assert.equal(out.status, 200);
  assert.deepEqual(JSON.parse(out.body), { ok: true });
  const hit = seen.at(-1)!;
  assert.equal(hit.auth, "Bearer s3cret");
  assert.equal(hit.url, "/repos/x/y?page=2");
});

test("brokerCall returns redirects WITHOUT following them", async () => {
  const out = await brokerCall(local, "GET", "/repos/redirect", undefined, undefined);
  assert.equal(out.status, 302);
  assert.ok(!seen.some((s) => s.url.includes("steal")));
});

test("brokerCall refuses a control-char secret WITHOUT echoing it", async () => {
  // undici's "invalid header value" error quotes the header value — i.e. the token — and that
  // message would flow back to the sandboxed caller in the 502 body. Refuse before building it.
  const leaky = { ...local, secret: "tok\nX-Evil: 1" };
  await assert.rejects(
    () => brokerCall(leaky, "GET", "/user", undefined, undefined),
    (e: any) => {
      assert.match(e.message, /control characters/);
      assert.ok(!e.message.includes("tok"), "error must not contain the secret");
      return true;
    },
  );
});

test("brokerCall drops a body on GET instead of throwing", async () => {
  const out = await brokerCall(local, "GET", "/repos/x", "stray body", undefined);
  assert.equal(out.status, 200);
});

test("brokerCall refuses when the secret is unresolvable", async () => {
  await assert.rejects(
    () => brokerCall({ ...local, secret: undefined, secret_env: "NOPE_UNSET" }, "GET", "/user", undefined, undefined),
    /unresolved/,
  );
});
