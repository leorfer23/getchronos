/**
 * A workspace on its own GitHub credential never reaches the operator's login, and no workspace
 * reaches another's. The daemon still reads its PRs' CI (fine-grained tokens cannot), and hands an
 * agent only its own workspace's.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
const PORT = await freePort();
process.env.CHRONOS_PORT = String(PORT);
process.env.CHRONOS_CLAUDE_BIN = "/usr/bin/true";

const { startServer } = await import("./api.js");
const { childEnv, ghReadEnv } = await import("./child-env.js");
const { operatorGhDir, ownGhDir, expandHome } = await import("./gh-env.js");
const { prChecks, setPrChecksView } = await import("./pr-checks.js");
const { clearPrOwnershipCache, setRemoteReader } = await import("./pr-ownership.js");
const { repos, workspaces } = await import("./store.js");
const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); setPrChecksView(null); setRemoteReader(null); });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gh-"));
const file = (name: string, body: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
const stamp = Date.now();
// Acme: a fine-grained token. Globex: a gh login dir of its own (a separate account). Hooli: neither.
const acme = workspaces.create({ slug: `gh-acme-${stamp}`, name: "Acme", config_dir: path.join(tmp, "cfg-a"), secrets_file: file("acme.env", "GH_TOKEN=github_pat_acme\n") } as any);
const globex = workspaces.create({ slug: `gh-globex-${stamp}`, name: "Globex", config_dir: path.join(tmp, "cfg-g"), secrets_file: file("globex.env", "GH_CONFIG_DIR=~/.config/gh-globex\n") } as any);
const hooli = workspaces.create({ slug: `gh-hooli-${stamp}`, name: "Hooli", config_dir: path.join(tmp, "cfg-h") } as any);
const globexDir = expandHome("~/.config/gh-globex");

test("a token workspace reads gh's config from its own dir; the daemon's read env drops the token", () => {
  const env = childEnv(acme);
  assert.equal(env.GH_TOKEN, "github_pat_acme");
  assert.equal(env.GH_CONFIG_DIR, ownGhDir(acme.slug), "gh exits when it cannot read ~/.config/gh, so it gets its own");
  const read = ghReadEnv(acme);
  assert.equal(read.GH_TOKEN, undefined, "check runs: the operator's login reads them, the token cannot");
  assert.equal(read.GH_CONFIG_DIR, undefined);
  // A workspace on its own account keeps it, for reads too.
  assert.equal(ghReadEnv(globex).GH_CONFIG_DIR, "~/.config/gh-globex");
  assert.equal(childEnv(hooli).GH_CONFIG_DIR, undefined, "no credential of its own: unchanged");
});

test("sandbox: the operator's login is denied to a workspace with its own credential; another's gh dir to everyone else", () => {
  const op = operatorGhDir();
  assert.ok(workspaces.isolationDenyDirs(acme.id).includes(op), "Acme's token cannot be traded for the login that sees every org");
  assert.ok(workspaces.isolationDenyDirs(globex.id).includes(op));
  assert.ok(!workspaces.isolationDenyDirs(hooli.id).includes(op), "a workspace on the operator's login keeps it");
  assert.ok(workspaces.isolationDenyDirs(acme.id).includes(globexDir), "Globex's account");
  assert.ok(workspaces.isolationDenyDirs(hooli.id).includes(globexDir));
  assert.ok(!workspaces.isolationDenyDirs(globex.id).includes(globexDir), "never its own");
});

test("a project's Robert starts from his workspace's env: its token, none of the daemon's secrets", async () => {
  process.env.CHRONOS_TG_TOKEN = "daemon-bot-token";
  const { robertSandbox } = await import("./telegram/agent.js");
  const env = robertSandbox(acme.id).baseEnv!;
  assert.equal(env.GH_TOKEN, "github_pat_acme");
  assert.equal(env.CHRONOS_TG_TOKEN, undefined, "the bot token is the daemon's");
  assert.equal(robertSandbox(null).baseEnv, undefined, "the fleet-wide Robert keeps the daemon's env");
});

test("mc pr checks: the daemon reads CI with the operator's login, only for the caller's own PRs", async () => {
  repos.create({ workspace_id: acme.id, name: "app", path: path.join(tmp, "app"), git_remote: "https://github.com/acme-co/app.git" } as any);
  repos.create({ workspace_id: hooli.id, name: "api", path: path.join(tmp, "api"), git_remote: "https://github.com/hooli-co/api.git" } as any);
  clearPrOwnershipCache();
  let seen: NodeJS.ProcessEnv | null = null;
  setPrChecksView(async (_url, env) => {
    seen = env;
    return { state: "OPEN", mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/1" }] };
  });
  const r = await prChecks(acme, "https://github.com/acme-co/app/pull/7");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.ci, "failing");
    assert.deepEqual(r.checks, [{ name: "test", state: "failing", url: "https://ci/1" }]);
  }
  assert.equal(seen!.GH_TOKEN, undefined, "read with the operator's login");
  assert.equal((await prChecks(acme, "https://github.com/hooli-co/api/pull/3")).ok, false, "another workspace's PR");
  assert.equal((await prChecks(acme, "not a url")).ok, false);

  const asAcme = { "x-mc-workspace-token": (workspaces.get(acme.id) as any).token };
  const mine = await fetch(`${base}/prs/checks?url=${encodeURIComponent("https://github.com/acme-co/app/pull/7")}`, { headers: asAcme });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).ci, "failing");
  const theirs = await fetch(`${base}/prs/checks?url=${encodeURIComponent("https://github.com/hooli-co/api/pull/3")}`, { headers: asAcme });
  assert.equal(theirs.status, 403);
});
