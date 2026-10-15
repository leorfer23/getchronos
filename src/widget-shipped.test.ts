/**
 * The Shipped card (src/widgets/shipped.ts + static/desk-widgets/shipped.js).
 *
 * The three things that are easy to get wrong and impossible to notice on the board: a landing filed
 * under the wrong day because the instant was bucketed in UTC, one PR counted three times because
 * three sources know about it, and a dollar figure attached to work it did not pay for. Each gets a
 * test here against a seeded db, plus regex pins on the client module (no build step, no types).
 *
 * The notes store resolves <CHRONOS_HOME>/notes/<ws>/<slug>.md at module load and the worklog IS a
 * note, so CHRONOS_HOME points at a temp dir before anything is imported (same as briefs.test.ts).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-shipped-"));

const { db, jobs, runs, sessions, tickets, workspaces } = await import("./store.js");
const { writeEntry } = await import("./worklog.js");
const { isDeployJob, localDay, parseWorklogStamp, prKey, shippedData, windowStart } = await import("./widgets/shipped.js");
const shipped = (await import("./widgets/shipped.js")).default;

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const NOW = new Date(2026, 8, 16, 14, 0, 0); // Wed 16 Sep 2026, 14:00 LOCAL — the daemon's clock
const at = (daysAgo: number, h = 12, m = 0) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, h, m).toISOString();

let acme = "";
let globex = "";
beforeEach(() => {
  db.exec(
    "DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM sessions; DELETE FROM tickets; DELETE FROM notes; DELETE FROM workspaces;",
  );
  acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/mc-test/acme" }).id;
  globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/mc-test/globex" }).id;
});

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────

function mkTicket(wsId: string, key: string, over: Record<string, unknown> = {}) {
  const t = tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(), title: `${key} title`,
    status: "done", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: `/tmp/${key}.md`, external_system: null, external_id: null, external_url: null, tags: null,
    ...over,
  } as any);
  return t;
}

/** A ticket's `updated_at` is what the shipped list dates it by, and create() stamps it now(). */
const touchTicket = (id: string, iso: string) =>
  db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(iso, id);

function mkEndedSession(wsId: string, over: Record<string, unknown> = {}) {
  const s = sessions.create({ workspace_id: wsId, cwd: "/tmp", title: "a terminal" });
  const row = { ended_at: at(0), cost_usd: null, worktree_branch: null, worktree_path: null, ticket_id: null, ...over };
  db.prepare(
    "UPDATE sessions SET status='ended', ended_at=@ended_at, cost_usd=@cost_usd, worktree_branch=@worktree_branch," +
      " worktree_path=@worktree_path, ticket_id=@ticket_id WHERE id=@id",
  ).run({ ...row, id: s.id });
  return sessions.get(s.id)!;
}

function mkRun(wsId: string, jobName: string, over: { status?: string; ended_at?: string; cost_usd?: number; ticket_id?: string } = {}) {
  const job = jobs.create({ name: jobName, goal: "g", workspace_id: wsId, cwd: "/tmp", ticket_id: over.ticket_id ?? null } as any);
  const r = runs.create(job.id, "manual");
  runs.patch(r.id, {
    status: (over.status ?? "success") as any,
    ended_at: over.ended_at ?? at(0),
    cost_usd: over.cost_usd ?? 0,
  });
  return runs.get(r.id)!;
}

const allItems = (d: ReturnType<typeof shippedData>) =>
  d.days.flatMap((day) => day.clients.flatMap((c) => c.items.map((i) => ({ ...i, date: day.date, workspace_id: c.workspace_id }))));

// ── local days ──────────────────────────────────────────────────────────────────────────────────

test("a landing is filed under the operator's local day, not UTC's", () => {
  // 23:30 local yesterday and 00:30 local today are different days on his clock whatever the offset.
  mkEndedSession(acme, { ended_at: at(1, 23, 30), worktree_branch: "lf/late" });
  mkEndedSession(acme, { ended_at: at(0, 0, 30), worktree_branch: "lf/early" });
  const d = shippedData({}, NOW);
  const dates = allItems(d).map((i) => i.date).sort();
  assert.deepEqual(dates, [localDay(new Date(at(1, 23, 30))), localDay(new Date(at(0, 0, 30)))].sort());
  assert.equal(d.days[0].date, localDay(NOW), "newest day first");
});

test("the window is local midnight N-1 days back, and older landings fall outside it", () => {
  assert.equal(localDay(windowStart(NOW, 7)), localDay(new Date(at(6))));
  assert.equal(windowStart(NOW, 7).getHours(), 0);
  mkEndedSession(acme, { ended_at: at(9), worklog: null, worktree_branch: "lf/ancient" });
  mkEndedSession(acme, { ended_at: at(2), worktree_branch: "lf/recent" });
  const labels = allItems(shippedData({}, NOW)).map((i) => i.label);
  assert.ok(labels.some((l) => l.includes("lf/recent")), "inside the window");
  assert.ok(!labels.some((l) => l.includes("lf/ancient")), "outside it");
  // …until the operator asks for more days.
  assert.ok(allItems(shippedData({ days: "14" }, NOW)).some((i) => i.label.includes("lf/ancient")));
});

test("the worklog's own stamp is local wall clock, parsed as such", () => {
  const d = parseWorklogStamp("2026-09-16 23:45")!;
  assert.equal(localDay(d), "2026-09-16");
  assert.equal(d.getHours(), 23);
  assert.equal(parseWorklogStamp("nonsense"), null);
});

// ── dedupe ──────────────────────────────────────────────────────────────────────────────────────

test("one PR is one landing, however many sources know about it", () => {
  const url = "https://github.com/acme/app/pull/12";
  const t = mkTicket(acme, "ACM-1", { status: "done" });
  tickets.update(t.id, { pr_url: url } as any);
  touchTicket(t.id, at(0, 10));
  mkEndedSession(acme, { ended_at: at(0, 11), ticket_id: t.id, cost_usd: 1.25 });
  writeEntry(acme, { what: "the rollback", outcome: "shipped", pending: [], next: [], pr: url, ticket: "ACM-1" }, NOW);

  const items = allItems(shippedData({}, NOW));
  const prs = items.filter((i) => i.url === url);
  assert.equal(prs.length, 1, JSON.stringify(items, null, 1));
  // The terminal wins the row: it is the only source that knows what the work cost.
  assert.equal(prs[0].kind, "pr");
  assert.equal(prs[0].usd, 1.25);
  assert.ok(prs[0].session_id, "the card can title it the way the rail does");
});

test("prKey collapses a trailing slash, a query and an anchor; a non-url dedupes on nothing", () => {
  assert.equal(prKey("https://github.com/a/b/pull/7/"), prKey("https://github.com/A/b/pull/7#issuecomment-1"));
  assert.equal(prKey("mc/ACM-2"), null);
  assert.equal(prKey(null), null);
});

test("a terminal with a PR is a pr row; one with only a worktree is a worktree row", () => {
  const t = mkTicket(acme, "ACM-3");
  tickets.update(t.id, { pr_url: "https://github.com/acme/app/pull/3" } as any);
  touchTicket(t.id, at(3));
  mkEndedSession(acme, { ended_at: at(0, 9), ticket_id: t.id });
  mkEndedSession(acme, { ended_at: at(0, 9, 30), worktree_branch: "lf/feat/x", worktree_path: "/tmp/wt/x" });
  const items = allItems(shippedData({}, NOW));
  assert.deepEqual(items.map((i) => i.kind).sort(), ["pr", "worktree"]);
  // The ticket row three days back is the SAME PR, so it collapses into the terminal's row and the
  // landing is dated by the terminal that did it — one url is one line, on one day.
  assert.equal(items.filter((i) => i.kind === "pr").length, 1);
  assert.equal(items.find((i) => i.kind === "pr")!.date, localDay(NOW));
});

test("a terminal that landed nothing — no PR, no worktree — is not a ship event", () => {
  mkEndedSession(acme, { ended_at: at(0, 8) });
  assert.deepEqual(shippedData({}, NOW).days, []);
});

// ── cost attribution ────────────────────────────────────────────────────────────────────────────

test("a terminal's own cost_usd is its row's burn; a ledger entry's is null", () => {
  mkEndedSession(acme, { ended_at: at(0, 9), worktree_branch: "lf/a", cost_usd: 2.5 });
  writeEntry(acme, { what: "wrote the migration", outcome: "shipped", pending: [], next: [], pr: null, ticket: "ACM-9" }, NOW);
  const items = allItems(shippedData({}, NOW));
  const wt = items.find((i) => i.kind === "worktree")!;
  const ledger = items.find((i) => i.kind === "ticket" && i.label.startsWith("ACM-9"))!;
  assert.equal(wt.usd, 2.5);
  assert.equal(ledger.usd, null, "the ledger keeps no id of the row that paid for it");
  assert.equal(shippedData({}, NOW).days[0].total_usd, 2.5);
});

test("a ticket's burn is attributed only when exactly one cost row links to it", () => {
  const one = mkTicket(acme, "ACM-10", { status: "review" });
  mkRun(acme, "ticket:ACM-10", { cost_usd: 0.75, ticket_id: one.id, ended_at: at(0, 7) });
  const two = mkTicket(acme, "ACM-11", { status: "review" });
  mkRun(acme, "ticket:ACM-11", { cost_usd: 0.5, ticket_id: two.id, ended_at: at(0, 7) });
  mkRun(acme, "ci-fix:ACM-11", { cost_usd: 0.25, ticket_id: two.id, ended_at: at(0, 7) });

  const items = allItems(shippedData({}, NOW));
  assert.equal(items.find((i) => i.label.startsWith("ACM-10"))!.usd, 0.75, "one row: unambiguous");
  assert.equal(items.find((i) => i.label.startsWith("ACM-11"))!.usd, null, "two rows: no figure rather than half of one");
});

test("dollars already shown against a terminal are never counted again under its ticket", () => {
  const t = mkTicket(acme, "ACM-12", { status: "review" });
  touchTicket(t.id, at(0, 9)); // create() stamps the wall clock; pin it to NOW's day or days[0] is today's
  mkEndedSession(acme, { ended_at: at(0, 9), ticket_id: t.id, cost_usd: 3, worktree_branch: "lf/b" });
  const day = shippedData({}, NOW).days[0];
  const items = day.clients.flatMap((c) => c.items);
  assert.equal(items.find((i) => i.kind === "worktree")!.usd, 3);
  assert.equal(items.find((i) => i.kind === "ticket")!.usd, null);
  assert.equal(day.total_usd, 3, "the day totals the fleet once");
  assert.equal(day.count, items.length);
});

test("a cost row is only spent once it is SHOWN — a terminal that landed nothing keeps its dollars available", () => {
  const t = mkTicket(acme, "ACM-13", { status: "review" });
  // Ended with a real cost but no PR and no worktree: no row of its own, so the ticket may claim it.
  mkEndedSession(acme, { ended_at: at(0, 9), ticket_id: t.id, cost_usd: 1.5 });
  const items = allItems(shippedData({}, NOW));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "ticket");
  assert.equal(items[0].usd, 1.5);
});

test("a day whose landings all cost nothing knowable totals null, not $0.00", () => {
  writeEntry(acme, { what: "merged the docs PR", outcome: "shipped", pending: [], next: [], pr: "https://github.com/a/b/pull/1", ticket: null }, NOW);
  assert.equal(shippedData({}, NOW).days[0].total_usd, null);
});

// ── deploys ─────────────────────────────────────────────────────────────────────────────────────

test("a deploy is a successful run of a deploy-named job — and nothing else claims to be one", () => {
  assert.ok(isDeployJob("deploy:prod"));
  assert.ok(isDeployJob("nightly-deploy"));
  assert.ok(!isDeployJob("ticket:ACM-1"));
  assert.ok(!isDeployJob(null));
  mkRun(acme, "deploy:prod", { cost_usd: 0.4, ended_at: at(0, 6) });
  mkRun(acme, "deploy:prod", { status: "failed", cost_usd: 9, ended_at: at(0, 6) });
  mkRun(acme, "ticket:ACM-99", { cost_usd: 1, ended_at: at(0, 6) });
  const deploys = allItems(shippedData({}, NOW)).filter((i) => i.kind === "deploy");
  assert.equal(deploys.length, 1, "only the one that succeeded");
  assert.equal(deploys[0].usd, 0.4);
});

// ── shape ───────────────────────────────────────────────────────────────────────────────────────

test("clients are split per day, and one client can be asked for alone", () => {
  mkEndedSession(acme, { ended_at: at(0, 9), worktree_branch: "lf/a" });
  mkEndedSession(globex, { ended_at: at(0, 10), worktree_branch: "gx/b" });
  const day = shippedData({}, NOW).days[0];
  assert.equal(day.clients.length, 2);
  assert.equal(day.count, 2);
  const only = shippedData({ ws: acme }, NOW);
  assert.deepEqual(only.days[0].clients.map((c) => c.workspace_id), [acme]);
});

test("the sparkline is one bar per day of the window, oldest first, zeros kept", () => {
  mkEndedSession(acme, { ended_at: at(0, 9), worktree_branch: "lf/a" });
  mkEndedSession(acme, { ended_at: at(2, 9), worktree_branch: "lf/b" });
  mkEndedSession(acme, { ended_at: at(2, 10), worktree_branch: "lf/c" });
  const d = shippedData({}, NOW);
  assert.equal(d.spark.length, 7);
  assert.deepEqual(d.spark.map((s) => s.date), [6, 5, 4, 3, 2, 1, 0].map((n) => localDay(new Date(at(n)))));
  assert.deepEqual(d.spark.map((s) => s.count), [0, 0, 0, 0, 2, 0, 1]);
  assert.equal(d.spark.at(-1)!.date, localDay(NOW), "today is the last bar");
  assert.equal(shippedData({ days: "3" }, NOW).spark.length, 3);
});

test("an empty week is an empty payload, not a throw — the card writes its own empty line", () => {
  const d = shippedData({}, NOW);
  assert.deepEqual(d.days, []);
  assert.equal(d.spark.length, 7);
  assert.ok(!isNaN(Date.parse(d.now)));
});

// ── the registry and the client module ──────────────────────────────────────────────────────────

test("the reader is registered under the name the module and the board use", () => {
  assert.equal(shipped.name, "shipped");
  assert.equal(shipped.title, "Shipped");
  assert.match(read("src/widgets/index.ts"), /import shipped from "\.\/shipped\.js";/);
  assert.match(read("src/widgets/index.ts"), /WIDGETS: Widget\[\] = \[[^\]]*\bshipped\b[^\]]*\]/);
  assert.match(read("static/desk-widgets/index.js"), /export const WIDGETS = \[[^\]]*"shipped"[^\]]*\]/);
  assert.ok(fs.existsSync(path.join(process.cwd(), "static/desk-widgets/shipped.js")));
});

test("Robert is told he can put this card in a reply", () => {
  assert.match(read("src/widgets/shipped.ts"), /::widget shipped::/);
});

test("the client module declares the same topics as the reader, and refetches every minute", () => {
  const js = read("static/desk-widgets/shipped.js");
  assert.match(js, /refreshMs: 60000,/);
  for (const t of shipped.topics!) assert.ok(js.includes(`"${t}"`), `client module is missing ${t}`);
  assert.deepEqual(shipped.topics, ["session.ended", "run.ended", "ticket.updated", "ticket.delivered", "note.updated"]);
});

test("the card renders idempotently, in the page's tokens, without animating", () => {
  const js = read("static/desk-widgets/shipped.js");
  assert.match(js, /body\.replaceChildren\(/, "replaces its output, never appends");
  assert.doesNotMatch(js, /@keyframes|animation:|transition:|setInterval\(/);
  assert.doesNotMatch(js, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, "colours come from var() tokens only");
  assert.match(js, /var\(--accent\)/);
  assert.match(js, /nothing shipped yet this week/);
  // Day groups: Today / Yesterday / "Mon 14", assembled so the weekday always comes first.
  assert.match(js, /return "Today"/);
  assert.match(js, /return "Yesterday"/);
  assert.match(js, /toLocaleDateString\(\[\], \{ weekday: "short" \}\)\} \$\{d\.getDate\(\)\}/);
  // The sparkline is inline SVG in the body — the card's <header> belongs to the loader.
  assert.match(js, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.doesNotMatch(js, /querySelector\("\.widget > header"\)|closest\("\.widget"\)/);
  // A PR opens in a new tab, and never hands the opener to GitHub.
  assert.match(js, /target: "_blank", rel: "noreferrer"/);
  // The rail's own name for a live terminal, its agent name when it is gone.
  assert.match(js, /ctx\.chipLabel\(s\) : it\.by/);
});
