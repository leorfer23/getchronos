import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, ideas, tickets, notes, repos } from "./store.js";
import {
  createIdea,
  promoteIdea,
  killIdea,
  parseIdeaJson,
  ideaContextBundle,
  feederConfig,
  resolveFeederAgent,
  repoIdeasEnabled,
  runFeeder,
  dispatchIdeaFeeder,
  ticketFromIdea,
  recentKilledTitles,
  killedTitlesSection,
} from "./ideas.js";
import { setExecutor } from "./dispatcher.js";
import { jobs } from "./store.js";
import { validateSpawnTarget } from "./backends/index.js";

beforeEach(() => {
  db.exec("DELETE FROM ideas; DELETE FROM tickets; DELETE FROM notes; DELETE FROM repos; DELETE FROM workspaces;");
});

const mkWs = (slug = `idea-${randomUUID().slice(0, 6)}`) =>
  workspaces.create({ slug, name: slug, config_dir: `/tmp/mc-test/${slug}` });

test("createIdea inserts proposed card and skips case-insensitive duplicate title", () => {
  const ws = mkWs();
  const a = createIdea({
    workspace_id: ws.id,
    title: "Add dark mode",
    pitch: "Users want a dark theme for late-night work.",
    kind: "ux-ui",
    source: "manual",
  });
  assert.ok(a);
  assert.equal(a!.status, "proposed");
  assert.equal(a!.kind, "ux-ui");

  const dup = createIdea({
    workspace_id: ws.id,
    title: "add dark mode",
    pitch: "Same idea different case.",
    kind: "new",
    source: "manual",
  });
  assert.equal(dup, null);
  assert.equal(ideas.list({ workspace_id: ws.id, status: "proposed" }).length, 1);
});

test("promoteIdea creates ticket + learning fact and marks idea promoted", async () => {
  const ws = mkWs();
  const idea = createIdea({
    workspace_id: ws.id,
    title: "Ship keyboard shortcuts",
    pitch: "j/k navigation on idea pool cards.",
    kind: "improvement",
    source: "miner",
  })!;

  const ticket = await promoteIdea(idea.id);
  assert.ok(ticket.key);
  assert.equal(ticket.title, idea.title);
  assert.ok(ticket.tags?.includes("improvement") || ticket.tags?.includes("idea"));

  const decided = ideas.get(idea.id)!;
  assert.equal(decided.status, "promoted");
  assert.equal(decided.promoted_ticket_id, ticket.id);
  assert.ok(decided.decided_at);

  const learn = notes.bySlug(ws.id, "session-learnings");
  assert.ok(learn?.body.includes("Idea promoted"));
  assert.ok(learn?.body.includes(idea.title));
});

test("ticketFromIdea detects the idea tag so promoted tickets don't re-trigger followups", () => {
  assert.equal(ticketFromIdea({ tags: JSON.stringify(["improvement", "idea"]) }), true);
  assert.equal(ticketFromIdea({ tags: JSON.stringify(["improvement"]) }), false);
  assert.equal(ticketFromIdea({ tags: null }), false);
  assert.equal(ticketFromIdea({ tags: "not json" }), false);
});

test("killIdea soft-kills and records learning; expireOld flips stale proposed", () => {
  const ws = mkWs();
  const idea = createIdea({
    workspace_id: ws.id,
    title: "Kill me",
    pitch: "Not worth it.",
    kind: "qa",
    source: "followups",
  })!;
  const killed = killIdea(idea.id);
  assert.equal(killed.status, "killed");
  assert.ok(killed.decided_at);
  assert.ok(notes.bySlug(ws.id, "session-learnings")?.body.includes("Idea killed"));

  // Insert a stale proposed row directly and expire
  const oldId = randomUUID();
  ideas.insert({
    id: oldId,
    workspace_id: ws.id,
    repo_id: null,
    title: "Ancient idea",
    pitch: "From last month",
    kind: "new",
    source: "manual",
    source_ref: null,
    status: "proposed",
    model: null,
    promoted_ticket_id: null,
    created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    decided_at: null,
  });
  const n = ideas.expireOld(14);
  assert.ok(n >= 1);
  assert.equal(ideas.get(oldId)!.status, "expired");
});

test("parseIdeaJson validates kinds and strips fences", () => {
  const raw = '```json\n[{"title":"A","pitch":"B","kind":"qa","repo":null},{"title":"X","pitch":"Y","kind":"nope"}]\n```';
  const items = parseIdeaJson(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "qa");
  assert.equal(items[0].title, "A");
});

test("ideaContextBundle includes workspace context section shape", () => {
  const ws = mkWs();
  const bundle = ideaContextBundle(ws);
  // empty workspace still returns string (may be empty)
  assert.equal(typeof bundle, "string");
});

test("feederConfig defaults to disabled with sane counts", () => {
  const ws = mkWs();
  const fu = feederConfig(ws, "followups");
  assert.equal(fu.enabled, false);
  assert.equal(fu.count, 3);
  assert.equal(fu.model, null); // no hardcoded model — resolveFeederAgent picks route_config
  const miner = feederConfig(ws, "miner");
  assert.equal(miner.enabled, false);
  assert.equal(miner.count, 5);
  assert.equal(miner.model, null);
});

test("repoIdeasEnabled: null/missing allowed; repo opt-out blocks", () => {
  const ws = mkWs();
  assert.equal(repoIdeasEnabled(null), true);
  assert.equal(repoIdeasEnabled(undefined), true);
  const r = repos.create({
    workspace_id: ws.id,
    name: "app",
    path: `/tmp/mc-test/${ws.slug}-app`,
  });
  assert.equal(repoIdeasEnabled(r.id), true); // default on
  repos.update(r.id, { ideas_enabled: false });
  assert.equal(repoIdeasEnabled(r.id), false);
});

test("dispatchIdeaFeeder returns job_id + run_id immediately", () => {
  setExecutor(async () => {}); // don't spawn real agents in tests
  const ws = mkWs();
  workspaces.update(ws.id, {
    ideas_config: { miner: { enabled: true, count: 2, model: "haiku" } },
  });
  const r = dispatchIdeaFeeder(ws.id, "miner", { force: true });
  assert.ok(r.job_id);
  assert.ok(r.run_id);
  assert.ok(r.status === "queued" || r.status === "running" || r.status === "blocked");
});

test("resolveFeederAgent uses route_config tier 1 when ideas_config omits model", () => {
  const ws = mkWs();
  workspaces.update(ws.id, {
    route_config: { "1": "cursor-agent:auto", "4": "claude-code:opus" },
    default_backend: "claude-code",
  });
  const w = workspaces.get(ws.id)!;
  assert.deepEqual(resolveFeederAgent(w, null), { backend: "cursor-agent", model: "auto" });
  // Explicit override still wins (bare → workspace default backend).
  assert.deepEqual(resolveFeederAgent(w, "haiku"), { backend: "claude-code", model: "haiku" });
  assert.deepEqual(resolveFeederAgent(w, "opencode/big-pickle"), {
    backend: "opencode",
    model: "opencode/big-pickle",
  });
});

test("resolveFeederAgent falls back to global routeModels when no route_config", () => {
  const ws = mkWs(); // no route_config; default_backend is claude-code
  // routeAgent's global fallback maps difficulty 1 → haiku (CONFIG.routeModels).
  assert.deepEqual(resolveFeederAgent(ws, null), { backend: "claude-code", model: "haiku" });
});

test("dispatchIdeaFeeder without model pins the route_config tier-1 agent on the job", () => {
  setExecutor(async () => {});
  const ws = mkWs();
  workspaces.update(ws.id, {
    ideas_config: { miner: { enabled: true, count: 2 } }, // no model
    route_config: { "1": "cursor-agent:auto", "5": "claude-code:opus" },
  });
  const r = dispatchIdeaFeeder(ws.id, "miner", { force: true });
  const job = jobs.get(r.job_id)!;
  assert.equal(job.backend, "cursor-agent");
  assert.equal(job.model, "auto");
});

test("dispatchIdeaFeeder rejects a retired model with an explicit error", () => {
  setExecutor(async () => {});
  const ws = mkWs();
  workspaces.update(ws.id, {
    ideas_config: {
      miner: { enabled: true, count: 2, model: "vercel/moonshotai/kimi-k3" },
    },
  });
  assert.throws(
    () => dispatchIdeaFeeder(ws.id, "miner", { force: true }),
    (e: Error) => /modelo desconocido \(retirado\).*kimi-k3/.test(e.message),
  );
});

test("validateSpawnTarget: unknown backend and retired model", () => {
  assert.equal(validateSpawnTarget("claude-code", "sonnet"), null);
  assert.match(validateSpawnTarget("no-such-backend", "sonnet")!, /unknown backend/);
  assert.match(validateSpawnTarget("opencode", "vercel/moonshotai/kimi-k3")!, /modelo desconocido \(retirado\)/);
});

test("runFeeder followups no-ops when ticket repo has ideas_enabled=0", async () => {
  const ws = mkWs();
  workspaces.update(ws.id, {
    ideas_config: {
      followups: { enabled: true, count: 3, model: "haiku" },
    },
  });
  const r = repos.create({
    workspace_id: ws.id,
    name: "silent",
    path: `/tmp/mc-test/${ws.slug}-silent`,
    ideas_enabled: false,
  });
  const ticket = createIdea({
    workspace_id: ws.id,
    title: "unused",
    pitch: "x",
    kind: "qa",
    source: "manual",
  }); // just need a ticket-like shape — use store tickets instead
  void ticket;
  // seed a real ticket row with disabled repo
  const t = tickets.create({
    id: randomUUID(),
    workspace_id: ws.id,
    repo_id: r.id,
    key: "T-1",
    slug: "t-1",
    title: "Done work",
    status: "done",
    priority: "P2",
    complexity: null,
    backend: null,
    model: null,
    assignee: "agent",
    file_path: `/tmp/t-1.md`,
    external_system: null,
    external_id: null,
    external_url: null,
    tags: null,
  } as any);
  // force=true would bypass workspace enable but still respects repo gate in runFeeder
  const out = await runFeeder(workspaces.get(ws.id)!, "followups", { ticket: t, force: true });
  assert.equal(out.length, 0);
});

// ───────────────────────────── "no is no" zombie guard ─────────────────────────────

test("createIdea permanently blocks a zombie of a killed idea matching source_ref", () => {
  const ws = mkWs();
  const killedId = randomUUID();
  ideas.insert({
    id: killedId, workspace_id: ws.id, repo_id: null,
    title: "Old title nobody will reuse", pitch: "old pitch", kind: "new", source: "intake",
    source_ref: "slack:C123:171234.5678", status: "proposed", model: null,
    promoted_ticket_id: null, created_at: new Date().toISOString(), decided_at: null,
  });
  killIdea(killedId);

  const again = createIdea({
    workspace_id: ws.id,
    title: "Totally different phrasing",
    pitch: "the sweep found the same Slack thread again",
    kind: "new",
    source: "intake",
    source_ref: "slack:C123:171234.5678",
  });
  assert.equal(again, null, "same source_ref as a killed idea is blocked forever, even with a new title");
});

test("createIdea permanently blocks a zombie of a killed idea matching normalized title", () => {
  const ws = mkWs();
  const idea = createIdea({
    workspace_id: ws.id, title: "Add retry button", pitch: "p", kind: "improvement", source: "manual",
  })!;
  killIdea(idea.id);

  const again = createIdea({
    workspace_id: ws.id, title: "  ADD retry button  ", pitch: "different pitch, same ask",
    kind: "improvement", source: "miner", source_ref: "different-source-ref",
  });
  assert.equal(again, null, "a killed idea's normalized title blocks a zombie forever, regardless of source/source_ref");
});

test("createIdea blocks an expired idea's zombie while inside the cooldown window", () => {
  const ws = mkWs();
  const id = randomUUID();
  ideas.insert({
    id, workspace_id: ws.id, repo_id: null, title: "Snoozed idea", pitch: "p", kind: "new",
    source: "miner", source_ref: null, status: "expired", model: null, promoted_ticket_id: null,
    created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    decided_at: new Date(Date.now() - 10 * 86_400_000).toISOString(), // expired 10d ago, inside the 30d cooldown
  });

  const again = createIdea({
    workspace_id: ws.id, title: "Snoozed idea", pitch: "p2", kind: "new", source: "miner",
  });
  assert.equal(again, null, "silence isn't a permanent no, but it still blocks inside the cooldown window");
});

test("createIdea allows an expired idea's zombie once the cooldown has passed", () => {
  const ws = mkWs();
  const id = randomUUID();
  ideas.insert({
    id, workspace_id: ws.id, repo_id: null, title: "Old snoozed idea", pitch: "p", kind: "new",
    source: "miner", source_ref: null, status: "expired", model: null, promoted_ticket_id: null,
    created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    decided_at: new Date(Date.now() - 40 * 86_400_000).toISOString(), // 40d ago, past the 30d cooldown
  });

  const again = createIdea({
    workspace_id: ws.id, title: "Old snoozed idea", pitch: "p2", kind: "new", source: "miner",
  });
  assert.ok(again, "past the cooldown, the operator's earlier silence no longer blocks the idea");
  assert.equal(again!.title, "Old snoozed idea");
});

// ───────────────────────────── sweep learns from kills ─────────────────────────────

test("recentKilledTitles surfaces kills from the last 90 days and drops older ones", () => {
  const ws = mkWs();
  const fresh = createIdea({ workspace_id: ws.id, title: "Fresh kill", pitch: "p", kind: "new", source: "manual" })!;
  killIdea(fresh.id);

  const staleId = randomUUID();
  ideas.insert({
    id: staleId, workspace_id: ws.id, repo_id: null, title: "Ancient kill", pitch: "p", kind: "new",
    source: "manual", source_ref: null, status: "killed", model: null, promoted_ticket_id: null,
    created_at: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    decided_at: new Date(Date.now() - 120 * 86_400_000).toISOString(),
  });

  const titles = recentKilledTitles(ws.id);
  assert.ok(titles.includes("Fresh kill"));
  assert.ok(!titles.includes("Ancient kill"), "kills older than 90 days fall off the sweep prompt");
});

test("killedTitlesSection formats a prompt block, and empty when there are no kills", () => {
  const ws = mkWs();
  assert.equal(killedTitlesSection(ws.id), "", "no kills → no section, not an empty header");

  const idea = createIdea({ workspace_id: ws.id, title: "Rejected pitch", pitch: "p", kind: "new", source: "manual" })!;
  killIdea(idea.id);
  const section = killedTitlesSection(ws.id);
  assert.match(section, /operator said NO/i);
  assert.match(section, /Rejected pitch/);
});

test("ideaContextBundle (feeder prompt) includes the killed-titles section", () => {
  const ws = mkWs();
  const idea = createIdea({ workspace_id: ws.id, title: "Feeder should skip this", pitch: "p", kind: "new", source: "manual" })!;
  killIdea(idea.id);
  const bundle = ideaContextBundle(ws);
  assert.match(bundle, /operator said NO/i);
  assert.match(bundle, /Feeder should skip this/);
});

test("ideas.stats groups promote/kill rates", async () => {
  const ws = mkWs();
  const a = createIdea({
    workspace_id: ws.id, title: "A1", pitch: "p", kind: "new", source: "miner",
  })!;
  const b = createIdea({
    workspace_id: ws.id, title: "A2", pitch: "p", kind: "new", source: "miner",
  })!;
  await promoteIdea(a.id);
  killIdea(b.id);
  const stats = ideas.stats(ws.id);
  const row = stats.find((s) => s.source === "miner" && s.kind === "new");
  assert.ok(row);
  assert.equal(row!.promoted, 1);
  assert.equal(row!.killed, 1);
  assert.equal(row!.total, 2);
});
