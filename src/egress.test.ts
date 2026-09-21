import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaces } from "./store.js";
import { interceptCredFor, resetInterceptCache, egressEnv, syncEgress } from "./egress.js";
import { resetCaCache, opensslAvailable } from "./egress-ca.js";
import type { Workspace } from "./types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-egress-"));

// The broker file is the operator's, not the workspace's — point the loader at a temp one.
function brokerFile(creds: unknown[]): void {
  const f = path.join(tmp, `broker-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(creds));
  process.env.CHRONOS_BROKER_FILE = f;
  resetInterceptCache();
}

const ws = (slug: string) => ({ slug } as Workspace);

const GH = {
  slug: "gh", host: "api.github.com", header: "Authorization", scheme: "Bearer",
  secret: "x", allow_methods: ["GET"], allow_path_prefixes: ["/repos"],
  workspaces: ["personal"], intercept: true,
};

after(() => {
  delete process.env.CHRONOS_BROKER_FILE;
  delete process.env.CHRONOS_EGRESS_CA_DIR;
  resetInterceptCache();
  resetCaCache();
});

test("interceptCredFor matches on host AND port, and only for an admitted workspace", () => {
  brokerFile([
    GH,
    // Same host, other port — a different origin entirely.
    { ...GH, slug: "gh-alt", host: "api.github.com:8443" },
    // Interception is opt-in: an ordinary broker cred must never terminate TLS.
    { ...GH, slug: "tg", host: "api.telegram.org", intercept: false },
  ]);

  assert.equal(interceptCredFor(ws("personal"), "api.github.com", 443)?.slug, "gh");
  assert.equal(interceptCredFor(ws("personal"), "API.GitHub.com.", 443)?.slug, "gh", "host match is case- and dot-insensitive");
  assert.equal(interceptCredFor(ws("personal"), "api.github.com", 8443)?.slug, "gh-alt");
  assert.equal(interceptCredFor(ws("personal"), "api.telegram.org", 443), null, "a cred without intercept stays a tunnel");
  assert.equal(interceptCredFor(ws("acme"), "api.github.com", 443), null, "workspace scoping still applies");
  assert.equal(interceptCredFor(undefined, "api.github.com", 443), null, "no workspace → no interception");
  assert.equal(interceptCredFor(ws("personal"), "github.com", 443), null, "no subdomain fuzz: the cred names one origin");
});

// wsAllowed() treats a null workspace as the admin caller and lets it through. Proxy traffic is
// never admin, so that branch must not be reachable from here — an unscoped cred is the only way
// a workspace other than the listed one gets in.
test("an unscoped cred is usable by any workspace, a scoped one by no other", () => {
  brokerFile([{ ...GH, workspaces: undefined }]);
  assert.equal(interceptCredFor(ws("acme"), "api.github.com", 443)?.slug, "gh");
  brokerFile([GH]);
  assert.equal(interceptCredFor(ws("acme"), "api.github.com", 443), null);
});

test("interceptCredFor picks up an edited broker file once the memo expires", () => {
  brokerFile([]);
  assert.equal(interceptCredFor(ws("personal"), "api.github.com", 443), null);
  brokerFile([GH]); // brokerFile() resets the memo, as an operator edit would after ≤5s
  assert.equal(interceptCredFor(ws("personal"), "api.github.com", 443)?.slug, "gh");
});

// The CA is trust: handing it to a workspace that can never see one of our certificates would be
// a gratuitous widening, so the env vars follow the credentials.
test("the CA is exported to a workspace with an intercept cred, and to no other", { skip: !opensslAvailable() ? "no openssl" : undefined }, async () => {
  process.env.CHRONOS_EGRESS_CA_DIR = path.join(tmp, "ca");
  resetCaCache();
  const mine = workspaces.create({ slug: "brokered", name: "Brokered", config_dir: "/tmp/cfg", egress_config: { mode: "enforce", allow: [] } } as any);
  const other = workspaces.create({ slug: "plain", name: "Plain", config_dir: "/tmp/cfg", egress_config: { mode: "enforce", allow: [] } } as any);
  brokerFile([{ ...GH, workspaces: ["brokered"] }]);
  await syncEgress();
  try {
    const env = egressEnv(mine.id);
    assert.match(env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(env.NODE_EXTRA_CA_CERTS, path.join(tmp, "ca", "ca-cert.pem"));

    const plain = egressEnv(other.id);
    assert.match(plain.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:\d+$/, "still proxied");
    assert.equal(plain.NODE_EXTRA_CA_CERTS, undefined, "but never asked to trust our CA");
  } finally {
    // Close both listeners so the suite's event loop can drain.
    workspaces.update(mine.id, { egress_config: null });
    workspaces.update(other.id, { egress_config: null });
    await syncEgress();
  }
});
