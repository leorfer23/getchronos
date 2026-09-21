#!/usr/bin/env node
// Seeds a SCRATCH Chronos daemon with fictional demo data, purely over its HTTP API (plus one
// direct, read-only peek at the scratch DB file itself — see the "lead token" note below), so the
// site/assets/ screenshots can be regenerated on demand. Never point this at a real daemon — see
// site/assets/README.md for how to boot the scratch instance this expects.
//
// Usage:
//   CHRONOS_BASE_URL=http://127.0.0.1:7799 CHRONOS_ADMIN_TOKEN=scratch-token \
//     CHRONOS_DB=/tmp/chronos-scratch/scratch.db node scripts/demo-seed.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const BASE = (process.env.CHRONOS_BASE_URL ?? "http://127.0.0.1:7799").replace(/\/$/, "");
const API = `${BASE}/api`;
const ADMIN_TOKEN = process.env.CHRONOS_ADMIN_TOKEN;
const DB_PATH = process.env.CHRONOS_DB;
if (!ADMIN_TOKEN) {
  console.error("CHRONOS_ADMIN_TOKEN is required — set it to whatever you booted the scratch daemon with.");
  process.exit(1);
}
if (!DB_PATH || DB_PATH === ":memory:") {
  console.error("CHRONOS_DB is required and must be a real file (not :memory:) — same value you booted the scratch daemon with. Needed to read a Lead session's lead_token (see below).");
  process.exit(1);
}

async function call(method, path, body, { admin = false, leadToken = null } = {}) {
  const headers = { "content-type": "application/json" };
  if (admin) headers["x-mc-admin"] = ADMIN_TOKEN;
  if (leadToken) headers["x-mc-lead"] = leadToken;
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
  const t1 = await ticket(acmeApi.id, "Add rate limiting to /v1/orders", {
    context: "Orders API has no per-key rate limit — a misbehaving integration can hammer /v1/orders.",
    acceptance: "- 429 with Retry-After once a key exceeds its budget\n- Limits configurable per API key",
  });
  const t2 = await ticket(acmeApi.id, "Support idempotency keys on POST /charges", {
    context: "Retried charge requests can double-charge a customer when a client times out mid-request.",
    acceptance: "- Idempotency-Key header honored on POST /charges\n- A replayed key returns the original response, not a new charge",
  });
  const t3 = await ticket(acmeApi.id, "Investigate p95 latency regression", { status: "planned" });
  const t4 = await ticket(acmeApi.id, "Flaky webhook-retry test", { status: "backlog" });

  // storefront: a goal ticket ("Lead") with three worker tickets under it.
  const goal = await ticket(storefront.id, "Ship checkout redesign", { status: "in_progress" });
  const cart = await ticket(storefront.id, "Cart drawer loses state on refresh", {
    status: "in_progress",
    context: "Refreshing the page while the cart drawer is open drops its contents — repro'd on Safari and Chrome.",
    acceptance: "- Cart contents survive a refresh\n- Decide: does the promo code survive too, or reset?",
  });
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

  // A second mock run, left mid-review — with real Work log entries so the ticket detail page has
  // something under that heading instead of an empty "## Work log".
  await call("POST", `/tickets/${t2.id}/dispatch`, { backend: "mock" });
  await call("POST", `/tickets/${t2.id}/note`, { text: "Added Idempotency-Key handling in the charges controller; replays now short-circuit to the stored response.", by: "agent" });
  await call("POST", `/tickets/${t2.id}/note`, { text: "Added a unit test for a replayed key racing the original request.", by: "agent" });
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
  // This is what site/assets/ticket-run.webp and ask.webp screenshot (the /app ticket detail).
  const askQuestion = "Should refreshing the page reset the promo code too, or keep it sticky across reloads?";
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
    question: askQuestion,
    options: ["Reset it", "Keep it sticky"],
  });
  await call("PATCH", `/tickets/${cart.id}`, {
    summary: "Cart state now persists to sessionStorage — stalled on one product call before merging.",
  });

  console.log("run-based ask created, opening Desk terminal sessions ...");

  // ── Desk terminal sessions ──────────────────────────────────────────────────────────────────
  // /desk and /phone.html are wired to live terminal SESSIONS, not tickets/runs — the wall of
  // terminal cards, and the phone's Working/Needs-you/Finished lists, both read `sessions`. This
  // scratch demo never spawns a real agent CLI (no real credentials, nothing billed), so every
  // session below opens on backend "mock", whose interactiveArgs (src/backends/mock.ts) is a
  // harmless `node -e` script: it prints a short plausible transcript once the ticket brief is
  // typed in, then idles. The actual state a screenshot shows (working / blocked / done) comes
  // from `mc state`-equivalent calls below, not from anything that script prints.
  const session = (opts, leadToken) =>
    call("POST", "/sessions", { workspace_id: ws.id, backend: "mock", ...opts }, { leadToken });
  const setState = (id, state, extra = {}) =>
    call("POST", `/sessions/${id}/status`, { state, ...extra });

  // One Lead, supervising the checkout-redesign goal.
  const lead = await session({ ticket_id: goal.id, role: "lead", created_by: "operator" });
  await setState(lead.id, "working", { label: "watching the board" });

  // A Lead's workers are stamped with its lead_id only when the caller presents the Lead's OWN
  // credential (x-mc-lead) — by design, nothing else can claim a worker for a Lead it doesn't own
  // (src/authz.ts leadScope). That credential (session.lead_token) is deliberately stripped from
  // every API response (src/store/sessions.ts) — it's meant to reach only the Lead's own spawned
  // process, as an env var. For this scratch-only seed we read it straight out of the scratch DB
  // file instead: a direct, read-only, local file read of a throwaway sqlite file we just created
  // ourselves, isolated from the live daemon's DB — not a bypass of anyone else's data.
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const leadToken = db.prepare("SELECT lead_token FROM sessions WHERE id = ?").pluck().get(lead.id);
  db.close();
  if (!leadToken) throw new Error(`could not read lead_token for session ${lead.id} from ${DB_PATH}`);

  // Worker on the cart-drawer ticket: actively working. DEM-6 already carries the run-based ask
  // above (that's what ticket-run.webp/ask.webp screenshot) — a second, session-based ask on the
  // SAME ticket would render as a duplicate "Waiting on you" block, so this worker's question goes
  // on a different ticket (below) instead.
  const workerCart = await session({ ticket_id: cart.id, role: "worker", created_by: "lead" }, leadToken);
  await setState(workerCart.id, "working", { label: "persisting cart state to sessionStorage" });

  // Worker on the pricing migration: blocked on its own question — this is the Desk wall's/phone's
  // "needs you" session (distinct ticket from DEM-6's run-based ask, so nothing duplicates).
  await call("PATCH", `/tickets/${pricing.id}`, { status: "blocked" });
  const workerPricing = await session({ ticket_id: pricing.id, role: "worker", created_by: "lead" }, leadToken);
  const pricingQuestion = "Keep the old /v1/pricing endpoint alive during the migration, or cut over all at once?";
  await setState(workerPricing.id, "blocked", { reason: "question", label: "old pricing endpoint during migration?" });
  await call("POST", "/asks", { session_id: workerPricing.id, question: pricingQuestion, options: ["Dual-write during migration", "Cut over at once"] });

  // An unrelated engineer, outside the Lead's goal entirely — the flaky webhook-retry test.
  await call("PATCH", `/tickets/${t4.id}`, { status: "in_progress" });
  const independent = await session({ ticket_id: t4.id, role: "worker", created_by: "operator" });
  await setState(independent.id, "working", { label: "adding a retry-jitter unit test" });

  // A finished session, for the Desk's "Recent" list: opens, "finishes", and its terminal is
  // killed — no live process left over.
  const finished = await session({ ticket_id: docs.id, role: "worker", created_by: "operator" });
  await setState(finished.id, "done", { label: "fixed three dead links" });
  await call("PATCH", `/sessions/${finished.id}`, { goal: "Fix broken links in quickstart", goal_done: true });
  await call("POST", `/sessions/${finished.id}/kill`, {});

  // scripts/demo-screenshot.mjs reads this to unfold the Lead's worker group on /desk (the
  // fold-state is client-only, in the Desk's own localStorage — this just hands it the id to set).
  const idsPath = process.env.CHRONOS_DEMO_IDS_FILE ?? path.join(os.tmpdir(), "chronos-demo-ids.json");
  fs.writeFileSync(idsPath, JSON.stringify({ leadId: lead.id, pricingWorkerId: workerPricing.id }));

  console.log("\nDone. Open the Desk at " + BASE + "/desk (paste the scratch admin token once) or " + BASE + "/app");
  console.log(`Goal ticket (storefront): ${goal.key}  |  cart-drawer ticket (paused, open ask): ${cart.key}`);
  console.log(`Lead session: ${lead.id.slice(0, 8)}  |  workers: ${workerCart.id.slice(0, 8)}, ${workerPricing.id.slice(0, 8)}  |  independent: ${independent.id.slice(0, 8)}  |  finished: ${finished.id.slice(0, 8)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
