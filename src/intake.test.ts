import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { jobs, repos, workspaces } from "./store.js";
import { ensureIntakeJob, intakeConfig, intakeGoal, intakeSources, INTAKE_DEFAULTS } from "./intake.js";
import { createIdea, killIdea, promoteIdea } from "./ideas.js";
import { getBody } from "./tickets.js";
import type { IdeasConfig, Workspace } from "./types.js";

function mkWs(ideas?: IdeasConfig, over: Record<string, unknown> = {}): Workspace {
  const slug = `intk-${randomUUID().slice(0, 6)}`;
  return workspaces.create({
    slug,
    name: slug,
    config_dir: `/tmp/${slug}`,
    ideas_config: ideas ?? null,
    ...over,
  });
}

// ───────────────────────────── config ─────────────────────────────

test("intake is off until a workspace opts in", () => {
  assert.equal(intakeConfig(mkWs()).enabled, false);
  assert.equal(intakeConfig(mkWs({ intake: { enabled: true, count: 3, model: null } })).enabled, true);
});

test("an empty source list means every available source, not none", () => {
  const cfg = intakeConfig(mkWs({ intake: { enabled: true, count: 5, model: null, sources: [] } }));
  assert.equal(cfg.sources, undefined, "an operator who empties the list has mis-edited it, not disabled everything");
});

test("config overrides the defaults it names and inherits the rest", () => {
  const cfg = intakeConfig(mkWs({ intake: { enabled: true, count: 2, model: "opus", cron: "0 6 * * *" } }));
  assert.equal(cfg.count, 2);
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.cron, "0 6 * * *");
  assert.equal(cfg.tz, INTAKE_DEFAULTS.tz);
});

// ───────────────────────────── sources ─────────────────────────────

test("sources reflect what the workspace actually has, not a fixed list", () => {
  const ws = mkWs({ intake: { enabled: true, count: 5, model: null } });
  const bare = intakeSources(ws).join("\n");
  assert.ok(!bare.includes("Slack"), "no Slack config → don't send an agent looking for Slack tools");
  assert.ok(!bare.includes("gh pr list"), "no repo with a remote → no PR source");
  assert.ok(bare.includes("Calendar"));

  repos.create({ workspace_id: ws.id, name: "api", path: `/tmp/${ws.slug}-api`, git_remote: "git@github.com:x/y.git" });
  assert.ok(intakeSources(ws).join("\n").includes("gh pr list"), "a repo with a remote unlocks the PR source");
});

test("a tracker-backed workspace gets its tracker as a source", () => {
  const ws = mkWs({ intake: { enabled: true, count: 5, model: null } }, { ticket_connector: "jira" });
  assert.ok(intakeSources(ws).some((s) => s.includes("jira")));
  const native = mkWs({ intake: { enabled: true, count: 5, model: null } });
  assert.ok(!intakeSources(native).some((s) => s.includes("jira")));
});

test("an explicit source list is honoured", () => {
  const ws = mkWs({ intake: { enabled: true, count: 5, model: null, sources: ["calendar"] } });
  const s = intakeSources(ws);
  assert.equal(s.length, 1);
  assert.ok(s[0].includes("Calendar"));
});

// ───────────────────────────── prompt ─────────────────────────────

test("the sweep prompt is read-only, batch-gated, and demands a spec", () => {
  const ws = mkWs({ intake: { enabled: true, count: 3, model: null } });
  const goal = intakeGoal(ws);
  assert.match(goal, /READ-ONLY/);
  assert.match(goal, /do not create tickets/i, "drafts go to the pool; a human promotes them");
  assert.match(goal, /--acceptance/, "a draft without a spec is work for the operator, not less of it");
  assert.match(goal, /at most 3/);
  assert.match(goal, /--source intake/);
});

test("the prompt lists what's already tracked so the sweep can't re-file it", () => {
  const ws = mkWs({ intake: { enabled: true, count: 3, model: null } });
  const repo = repos.create({ workspace_id: ws.id, name: "api", path: `/tmp/${ws.slug}-api` });
  const idea = createIdea({
    workspace_id: ws.id, repo_id: repo.id, title: "Existing tracked work", pitch: "p", kind: "new", source: "manual",
  })!;
  const ticket = promoteIdea(idea.id);
  return ticket.then(() => {
    assert.match(intakeGoal(ws), /Existing tracked work/);
  });
});

test("the sweep prompt lists recent kills so it learns from a 'no' instead of re-filing it", () => {
  const ws = mkWs({ intake: { enabled: true, count: 3, model: null } });
  const idea = createIdea({
    workspace_id: ws.id, title: "Operator already said no to this", pitch: "p", kind: "new", source: "manual",
  })!;
  killIdea(idea.id);

  const goal = intakeGoal(ws);
  assert.match(goal, /operator said NO/i, "the goal must inject a kills section, not just the live pool");
  assert.match(goal, /Operator already said no to this/);
  assert.match(goal, /do not re-propose or rephrase/i);
});

test("the sweep prompt has no kills section for a workspace with no kill history", () => {
  const ws = mkWs({ intake: { enabled: true, count: 3, model: null } });
  assert.doesNotMatch(intakeGoal(ws), /operator said NO/i);
});

// ───────────────────────────── scheduling ─────────────────────────────

test("ensureIntakeJob creates, updates and removes the cron job with the flag", () => {
  const ws = mkWs({ intake: { enabled: true, count: 4, model: null, cron: "0 7 * * 1-5" } });
  ensureIntakeJob(ws);
  const job = jobs.list().find((j) => j.name === `intake:${ws.slug}`);
  assert.ok(job, "an enabled workspace gets a scheduled sweep");
  assert.equal(job!.trigger_type, "cron");
  assert.equal(job!.cron_expr, "0 7 * * 1-5");
  assert.match(job!.disallowed_tools ?? "", /Write/, "the sweep must never write code");

  const off = workspaces.update(ws.id, { ideas_config: { intake: { enabled: false, count: 4, model: null } } })!;
  ensureIntakeJob(off);
  assert.equal(jobs.list().find((j) => j.name === `intake:${ws.slug}`), undefined);
});

test("re-running ensureIntakeJob preserves a job the operator disabled by hand", () => {
  const ws = mkWs({ intake: { enabled: true, count: 4, model: null } });
  ensureIntakeJob(ws);
  const job = jobs.list().find((j) => j.name === `intake:${ws.slug}`)!;
  jobs.update(job.id, { enabled: false });

  ensureIntakeJob(ws); // e.g. a daemon restart
  assert.equal(jobs.get(job.id)!.enabled, 0, "a restart must not switch a job back on behind him");
});

// ───────────────────────────── the payoff ─────────────────────────────

test("a promoted draft carries its spec into the ticket, ready to build", async () => {
  const ws = mkWs();
  const idea = createIdea({
    workspace_id: ws.id,
    title: "Alert when the nightly sync drops below 90% of yesterday's rows",
    pitch: "Raised by finance in #data-questions on Tuesday; nobody filed it.",
    acceptance: "- [ ] Threshold configurable per table\n- [ ] Alert posts to #data-alerts\n- [ ] Out of scope: backfilling history",
    kind: "new",
    source: "intake",
  })!;
  assert.equal(idea.acceptance?.includes("Threshold configurable"), true);

  const ticket = await promoteIdea(idea.id);
  const body = getBody(ticket);
  assert.match(body, /Threshold configurable per table/, "the spec becomes the ticket's acceptance criteria verbatim");
  assert.match(body, /Raised by finance/, "the pitch becomes the context, so the trail back to the signal survives");
});
