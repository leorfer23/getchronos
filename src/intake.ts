/**
 * Intake — the Chief-of-Staff sweep.
 *
 * The rest of the loop plans, builds, gates and reviews on its own. The one step still done
 * entirely by the operator is the first one: noticing that a Slack thread, a meeting that just
 * ended, a review comment or a red CI run *is work*, and writing it up well enough to hand over.
 *
 * This sweep does that noticing. It reads the signals a repo-only miner can't see, and files
 * **spec-complete drafts** — context and acceptance criteria already written — into the idea pool
 * as `proposed`. Nothing it produces touches the backlog until a human says yes, in a batch, once
 * a day. That's the trade: it takes the writing, he keeps the deciding.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";
import { bus } from "./bus.js";
import { jobs, repos, tickets, workspaces } from "./store.js";
import { reloadSchedules } from "./scheduler.js";
import { killedTitlesSection, parseIdeasConfig, promoteIdea } from "./ideas.js";
import { slackReady } from "./slack.js";
import { ideas as ideaStore } from "./store.js";
import { notify, esc } from "./telegram/api.js";
import { kb } from "./telegram/keyboards.js";
import type { Idea, IntakeConfig, Workspace } from "./types.js";
import { REPO_ROOT } from "./repo-root.js";

export const INTAKE_DEFAULTS: IntakeConfig = {
  enabled: false,
  count: 5,
  model: null,
  cron: "0 7 * * 1-5", // before the day starts: the drafts are waiting when he opens his phone
  tz: "",
};

export function intakeConfig(ws: Workspace): IntakeConfig {
  const cfg = parseIdeasConfig(ws.ideas_config).intake;
  return {
    ...INTAKE_DEFAULTS,
    ...(cfg ?? {}),
    // An empty source list means "everything available", not "nothing" — an operator who trims the
    // list down to zero has almost certainly mis-edited it, and a silent no-op sweep is the worst
    // possible failure mode for a feature whose whole job is to notice things.
    sources: cfg?.sources?.length ? cfg.sources : undefined,
  };
}

const enabledSource = (cfg: IntakeConfig, name: string) => !cfg.sources || cfg.sources.includes(name);

/**
 * The signal sources actually available to this workspace right now, as prompt lines.
 *
 * Built from real state rather than listed unconditionally: an agent told to "check Slack" in a
 * workspace with no Slack MCP burns turns discovering it can't, and then invents something.
 */
export function intakeSources(ws: Workspace, cfg: IntakeConfig = intakeConfig(ws)): string[] {
  const out: string[] = [];
  const wsRepos = repos.list(ws.id);
  const withRemote = wsRepos.filter((r) => r.git_remote);

  if (enabledSource(cfg, "slack") && slackReady(ws)) {
    out.push(
      `**Slack** (your \`slack\` MCP tools). Read the CHANNELS this workspace works in — commitments made, ` +
        `bugs described in passing, "can someone look at", requests that never became a ticket. ` +
        `Skip your own DMs and @mentions: the slack-triage job already owns those and files them directly.`,
    );
  }
  if (enabledSource(cfg, "calendar")) {
    out.push(
      `**Calendar** (\`mc cal\`). Meetings that ENDED in the last day. A meeting that happened and produced ` +
        `no ticket is the most common way work goes missing here — look for the obvious follow-up it implies. ` +
        `Do not invent outcomes you have no evidence for; if a meeting left no trace anywhere, skip it.`,
    );
  }
  if (enabledSource(cfg, "prs") && withRemote.length) {
    out.push(
      `**Open PRs** (\`gh pr list\`, \`gh pr view <n> --comments\` in ${withRemote.map((r) => r.name).join(", ")}). ` +
        `Unresolved review comments, "follow-up in another PR" promises, and TODOs a reviewer accepted on the ` +
        `condition that someone files the real fix.`,
    );
  }
  if (enabledSource(cfg, "ci")) {
    out.push(
      `**Broken delivery** (\`mc ticket list --status blocked\`, and tickets whose PR CI is failing). ` +
        `Anything stuck long enough to need its own ticket rather than another retry.`,
    );
  }
  if (enabledSource(cfg, "tracker") && ws.ticket_connector && ws.ticket_connector !== "native") {
    out.push(
      `**${ws.ticket_connector}** — items assigned to me that arrived since yesterday and have no local ticket yet.`,
    );
  }
  if (enabledSource(cfg, "notes")) {
    out.push(
      `**Memos** (\`mc memo list\`, \`mc memo get <name>\`). Commitments and "we should…" lines the operator ` +
        `left in his own notes and never turned into work.`,
    );
  }
  return out;
}

/**
 * The sweep prompt.
 *
 * Two things it insists on, because they are what separates this from a noise generator: every
 * draft must cite the signal it came from, and every draft must be specified well enough to build.
 * A draft the operator has to rewrite is worse than no draft — they'd rather have written it themselves.
 */
export function intakeGoal(ws: Workspace, cfg: IntakeConfig = intakeConfig(ws)): string {
  const sources = intakeSources(ws, cfg);
  const recent = tickets
    .list({ workspace_id: ws.id })
    .slice(0, 40)
    .map((t) => `- ${t.key} [${t.status}] ${t.title}`)
    .join("\n");
  const killedSection = killedTitlesSection(ws.id);

  return (
    `INTAKE SWEEP for the ${ws.name} workspace — READ-ONLY. Do not edit code, do not post anywhere, ` +
    `do not create tickets. You file DRAFTS into the idea pool; a human approves them in a batch.\n\n` +
    `Your job is the one step the rest of this system can't do: notice that something IS work, and write it ` +
    `up well enough to hand to an agent.\n\n` +
    `## Where to look\n${sources.length ? sources.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(no signal sources configured or available — report that and stop)"}\n\n` +
    `## Already tracked — do NOT re-file any of these\n${recent || "(backlog is empty)"}\n` +
    `Also run \`mc idea list\` and skip anything already in the pool, including rephrasings.\n\n` +
    `${killedSection ? `${killedSection}\n\n` : ""}` +
    `## What counts\n` +
    `File at most ${cfg.count}. Real, actionable work for THIS workspace that nobody has written down yet. ` +
    `Fewer good drafts beat more mediocre ones — filing nothing is a perfectly good outcome for a quiet day, ` +
    `and it is much better than padding.\n` +
    `SKIP: anything already tracked, vague aspirations ("improve performance"), work belonging to another ` +
    `workspace, and anything you'd have to invent facts to justify.\n\n` +
    `## How to file each one\n` +
    `\`\`\`\n` +
    `mc idea new --kind new|improvement|qa|ux-ui|visibility|expansion --source intake \\\n` +
    `  --title "<max 70 chars, the outcome — not 'investigate X'>" \\\n` +
    `  --pitch "<why this matters + WHERE IT CAME FROM: the channel, meeting, PR or memo, with a link or ` +
    `quote so a human can check it in one click>" \\\n` +
    `  --acceptance "<the spec: concrete, checkable criteria — what must be true for this to be done, ` +
    `which files/systems are involved, what is explicitly out of scope>" \\\n` +
    `  [--repo "<repo name>"]\n` +
    `\`\`\`\n` +
    `The \`--acceptance\` text becomes the ticket's Spec section verbatim when the operator approves, and a ` +
    `build agent works from it directly. Write it as if you were handing the ticket to someone competent who ` +
    `was not in the meeting. If you can't specify it that well, you don't understand it well enough to file it — ` +
    `investigate a little more (read-only) or skip it.\n\n` +
    `Finish by printing one line: how many you filed and which signals they came from.`
  );
}

/** Create/update/remove the recurring intake job for a workspace from its ideas_config.intake. */
export function ensureIntakeJob(ws: Workspace): void {
  const name = `intake:${ws.slug}`;
  const existing = jobs.list().find((j) => j.name === name);
  const cfg = intakeConfig(ws);
  if (!cfg.enabled) {
    if (existing) { jobs.remove(existing.id); reloadSchedules(); }
    return;
  }

  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const cwd = wsRepos[0]?.path || REPO_ROOT;
  const model = cfg.model || CONFIG.intakeModel;
  const fields = {
    goal: intakeGoal(ws, cfg),
    description: `Chief-of-staff intake sweep for ${ws.name}`,
    workspace_id: ws.id,
    // Model path with a provider prefix → opencode; bare alias → the workspace's own backend, so the
    // sweep runs on the same account whose Slack/MCP tools it needs.
    backend: model.includes("/") ? "opencode" : ws.default_backend,
    model,
    cwd,
    add_dirs: wsRepos.map((r) => r.path).filter((p) => p !== cwd),
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "cron" as const,
    cron_expr: cfg.cron || INTAKE_DEFAULTS.cron,
    timezone: cfg.tz || CONFIG.slackTriageTz,
  };
  // Only set `enabled` on create: a daemon restart must not re-enable a job the operator turned off.
  if (existing) jobs.update(existing.id, fields);
  else jobs.create({ name, ...fields, enabled: true });
  reloadSchedules();
}

export function ensureAllIntakeJobs(): void {
  for (const ws of workspaces.list()) {
    try { ensureIntakeJob(ws); } catch (e) { console.error(`[intake] ${ws.slug}`, e); }
  }
}

/** Drafts this sweep left in the pool, newest first. */
export function pendingIntakeDrafts(workspace_id: string): Idea[] {
  return ideaStore.list({ workspace_id, status: "proposed" }).filter((i) => i.source === "intake");
}

/**
 * Promote every intake draft still sitting in a workspace's pool.
 *
 * The batch is the point. A sweep that files five drafts and then asks five separate questions has
 * moved the work rather than removed it — the operator reads them together and says yes once.
 * Failures are collected, not thrown: one bad draft must not strand the other four.
 */
export async function promoteAllIntake(workspace_id: string): Promise<{ promoted: number; failed: number }> {
  let promoted = 0, failed = 0;
  for (const idea of pendingIntakeDrafts(workspace_id)) {
    try { await promoteIdea(idea.id); promoted++; } catch { failed++; }
  }
  return { promoted, failed };
}

// One card per sweep, listing what it found, with a single tap to take all of it.
async function announceSweep(ws: Workspace): Promise<void> {
  const drafts = pendingIntakeDrafts(ws.id);
  if (!drafts.length) return;
  const lines = drafts.slice(0, 8).map((d) => `• <b>${esc(d.title)}</b>\n  <i>${esc(d.pitch.replace(/\s+/g, " ").slice(0, 160))}</i>`);
  const more = drafts.length > 8 ? `\n…and ${drafts.length - 8} more` : "";
  await notify(
    `📥 <b>${esc(ws.name)}</b> · intake found ${drafts.length} thing${drafts.length === 1 ? "" : "s"} nobody had written down:\n\n` +
      lines.join("\n") + more,
    kb([[
      { text: `✅ Take all ${drafts.length}`, data: `ib.all.${ws.id.slice(0, 8)}` },
      { text: "👀 Review in app", data: `ib.no.${ws.id.slice(0, 8)}` },
    ]]),
  ).catch(() => {});
}

export function startIntake(): void {
  ensureAllIntakeJobs();
  bus.on("event", (e: any) => {
    if (e.topic === "workspace.changed") { ensureAllIntakeJobs(); return; }
    // A finished sweep is the only moment the operator needs to hear from intake at all.
    if (e.topic === "run.ended" && typeof e.job_name === "string" && e.job_name.startsWith("intake:")) {
      const ws = e.workspace_id ? workspaces.get(e.workspace_id) : undefined;
      if (ws) void announceSweep(ws);
    }
  });
}
