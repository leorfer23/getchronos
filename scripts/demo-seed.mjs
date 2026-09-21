#!/usr/bin/env node
// Seeds a SCRATCH Chronos daemon with fictional demo data, purely over its HTTP API, so the
// site/assets/ screenshots can be regenerated on demand. Never point this at a real daemon —
// see site/assets/README.md for how to boot the scratch instance this expects.
//
// Usage:
//   CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-token node scripts/demo-seed.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const BASE = (process.env.CHRONOS_BASE_URL ?? "http://127.0.0.1:7799").replace(/\/$/, "");
const API = `${BASE}/api`;
const ADMIN_TOKEN = process.env.CHRONOS_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error("CHRONOS_ADMIN_TOKEN is required — set it to whatever you booted the scratch daemon with.");
  process.exit(1);
}

async function call(method, path, body, { admin = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (admin) headers["x-mc-admin"] = ADMIN_TOKEN;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return json;
}

async function main() {
  console.log(`Seeding demo data at ${BASE} ...`);

  // A throwaway config_dir — never the operator's real ~/.claude — even though default_backend
  // "mock" means nothing here ever spawns a real agent CLI or touches real credentials.
  const configDir = process.env.CHRONOS_DEMO_CONFIG_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "chronos-demo-config-"));
  const ws = await call("POST", "/workspaces", {
    slug: "demo",
    name: "Demo",
    kind: "personal",
    config_dir: configDir,
    default_backend: "mock",
    default_model: "sonnet",
    sandbox_mode: "off",
  }, { admin: true });
  console.log(`workspace: ${ws.id} (${ws.slug})`);

  // Ticket creation writes a ticket file under `<repo.path>/.mc/tickets`, so each fake repo needs a
  // real (but empty and throwaway) directory on disk — it never needs to be a git checkout.
  const reposDir = process.env.CHRONOS_DEMO_REPOS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "chronos-demo-repos-"));
  // delivery: "pr" requires the path to actually be a git repo, so give each fake project a
  // throwaway local-only git history — no remote, nothing pushed anywhere.
  const initGitRepo = (repoPath, name) => {
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "README.md"), `# ${name}\n\nFictional demo project for Chronos OSS screenshots.\n`);
    const git = (...args) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "demo@example.com");
    git("config", "user.name", "Chronos Demo");
    git("add", "-A");
    git("commit", "-q", "-m", "initial commit");
  };
  // delivery: "commit" — no fake GitHub remote to wire up or accidentally push to.
  const repo = async (name, delivery = "commit") => {
    const repoPath = path.join(reposDir, name);
    initGitRepo(repoPath, name);
    return call("POST", `/workspaces/${ws.id}/repos`, {
      name,
      path: repoPath,
      default_branch: "main",
      delivery,
    }, { admin: true });
  };

  const acmeApi = await repo("acme-api");
  const storefront = await repo("storefront");
  const docsSite = await repo("docs-site");
  console.log(`repos: ${acmeApi.name}, ${storefront.name}, ${docsSite.name}`);

  const ticket = async (repoId, title, extra = {}) =>
    call("POST", "/tickets", { workspace_id: ws.id, repo_id: repoId, title, ...extra });

  // acme-api: a small, mostly-finished backlog.
  const t1 = await ticket(acmeApi.id, "Add rate limiting to /v1/orders");
  const t2 = await ticket(acmeApi.id, "Support idempotency keys on POST /charges");
  const t3 = await ticket(acmeApi.id, "Investigate p95 latency regression", { status: "planned" });
  const t4 = await ticket(acmeApi.id, "Flaky webhook-retry test", { status: "backlog" });

  // storefront: a goal ticket ("Lead") with three worker tickets under it.
  const goal = await ticket(storefront.id, "Ship checkout redesign", { status: "in_progress" });
  const cart = await ticket(storefront.id, "Cart drawer loses state on refresh", { status: "in_progress" });
  const pricing = await ticket(storefront.id, "Migrate checkout to new pricing API", { status: "planned" });
  const darkMode = await ticket(storefront.id, "Add dark mode toggle", { status: "done" });
  for (const child of [cart, pricing, darkMode]) {
    await call("POST", `/tickets/${goal.id}/links`, { to_id: child.id, type: "parent" });
  }

  // docs-site: one done ticket, for variety.
  const docs = await ticket(docsSite.id, "Broken links in quickstart", { status: "done" });

  console.log("tickets created, dispatching mock runs ...");

  // A clean, successful mock run on acme-api's rate-limiting ticket.
  await call("POST", `/tickets/${t1.id}/dispatch`, { backend: "mock" });
  await call("PATCH", `/tickets/${t1.id}`, {
    status: "done",
    summary: "Added a token-bucket limiter in front of /v1/orders; 429s carry Retry-After.",
  });

  // A second mock run, left mid-review.
  await call("POST", `/tickets/${t2.id}/dispatch`, { backend: "mock" });
  await call("PATCH", `/tickets/${t2.id}`, {
    status: "review",
    summary: "Idempotency-Key header honored on POST /charges; replays return the original response.",
  });

  await call("PATCH", `/tickets/${t3.id}`, { summary: "p95 climbed 40ms after last week's deploy — bisecting now." });
  await call("PATCH", `/tickets/${t4.id}`, { summary: "Webhook-retry test fails about 1 in 20 runs; looks like a timing race." });
  await call("PATCH", `/tickets/${docs.id}`, { summary: "Fixed three dead links in the quickstart, added a redirect check to CI." });
  await call("PATCH", `/tickets/${goal.id}`, { summary: "Redesigned checkout: cart drawer, new pricing API, dark mode." });
  await call("PATCH", `/tickets/${pricing.id}`, { summary: "Waiting on the pricing team's v2 API to leave beta." });
  await call("PATCH", `/tickets/${darkMode.id}`, { summary: "Shipped a prefers-color-scheme toggle, persisted per session." });

  // The cart-drawer ticket gets a run that pauses on an open ask (see src/execute.test.ts's
  // "park: success with an open ask becomes paused" for why the timing below works: the mock
  // backend sleeps just long enough for the ask to attach to the still-running run before it
  // exits, and the run stays "paused" forever after — no live process, nothing to keep alive).
  const job = await call("POST", "/jobs", {
    name: "build:cart-drawer-fix",
    goal: "work\n!sleep: 2000",
    backend: "mock",
    workspace_id: ws.id,
    ticket_id: cart.id,
  });
  const run = await call("POST", `/jobs/${job.id}/run`);
  await call("POST", "/asks", {
    run_id: run.run_id,
    question: "Should refreshing the page reset the promo code too, or keep it sticky across reloads?",
    options: ["Reset it", "Keep it sticky"],
  });
  await call("PATCH", `/tickets/${cart.id}`, {
    summary: "Cart state now persists to sessionStorage — stalled on one product call before merging.",
  });

  console.log("\nDone. Open the Desk at " + BASE + "/desk");
  console.log(`Goal ticket (storefront): ${goal.key}  |  cart-drawer ticket (paused, open ask): ${cart.key}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
