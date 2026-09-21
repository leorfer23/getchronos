import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bus } from "./bus.js";
import { getBackend, validateSpawnTarget } from "./backends/index.js";
import { childEnv } from "./child-env.js";
import { CONFIG } from "./config.js";
import { dispatch } from "./dispatcher.js";
import { guard } from "./guard.js";
import { captureLearnings, contextBlock } from "./notes.js";
import { db, ideas as store, jobs, notes, repos, tickets, workspaces } from "./store.js";
import { resultText } from "./summarize.js";
import { createTicket, getBody, routeAgent, updateTicket } from "./tickets.js";
import { clickup } from "./connectors/clickup.js";
import { jira } from "./connectors/jira.js";
import type { Connector } from "./connectors/types.js";
import type {
  FeederConfig,
  Idea,
  IdeaKind,
  IdeasConfig,
  IdeaSource,
  NewIdea,
  Repo,
  Ticket,
  Workspace,
} from "./types.js";
import { IDEA_KINDS, IDEA_SOURCES } from "./types.js";
import { notify } from "./telegram/api.js";
import { REPO_ROOT } from "./repo-root.js";

const CONNECTORS: Record<string, Connector> = { clickup, jira };
// model: null → resolveFeederAgent picks the workspace route_config tier-1 (or defaultModel).
// Never hardcode a provider/model literal here — the previous kimi-k3 default died silently (PER-22).
const FEEDER_DEFAULTS: Record<"followups" | "miner", FeederConfig> = {
  followups: { enabled: false, count: 3, model: null },
  miner: { enabled: false, count: 5, model: null },
};

export function parseIdeasConfig(raw: string | null | undefined): IdeasConfig {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as IdeasConfig;
  } catch {
    return {};
  }
}

export function feederConfig(ws: Workspace, feeder: "followups" | "miner"): FeederConfig {
  const cfg = parseIdeasConfig(ws.ideas_config)[feeder];
  return {
    enabled: cfg?.enabled ?? FEEDER_DEFAULTS[feeder].enabled,
    count: cfg?.count ?? FEEDER_DEFAULTS[feeder].count,
    model: cfg?.model !== undefined ? cfg.model : FEEDER_DEFAULTS[feeder].model,
  };
}

/**
 * Resolve the (backend, model) an ideas feeder should run on.
 * Explicit ideas_config.model wins; otherwise use the workspace's cheapest route_config rung
 * (tier 1 — idea generation is light scout work), then ws.default_* / CONFIG.defaultModel.
 */
export function resolveFeederAgent(
  ws: Pick<Workspace, "default_backend" | "default_model" | "route_config">,
  modelOverride: string | null | undefined,
): { backend: string; model: string } {
  if (modelOverride) {
    // provider/model → opencode; bare alias → the workspace's own backend (same as intake).
    return {
      model: modelOverride,
      backend: modelOverride.includes("/") ? "opencode" : (ws.default_backend || "claude-code"),
    };
  }
  const routed = routeAgent({ complexity: "1", backend: null, model: null }, ws);
  return {
    backend: routed.backend ?? ws.default_backend ?? "claude-code",
    model: routed.model ?? ws.default_model ?? CONFIG.defaultModel,
  };
}

/** Repo opt-in for AI feeders. No repo (workspace-level ticket/idea) → allowed. Missing row → allowed. */
export function repoIdeasEnabled(repoId: string | null | undefined): boolean {
  if (!repoId) return true;
  const r = repos.get(repoId);
  if (!r) return true;
  // Missing column on very old rows is treated as enabled (migration default 1).
  return r.ideas_enabled !== 0;
}

/** True when a ticket was promoted from an idea (tagged "idea" by promoteIdea). Such tickets must
 * not re-trigger the followups feeder on completion — ideas begetting ideas is a never-ending loop. */
export function ticketFromIdea(t: Pick<Ticket, "tags">): boolean {
  if (!t.tags) return false;
  try {
    return (JSON.parse(t.tags) as string[]).includes("idea");
  } catch {
    return false;
  }
}

export function isIdeaKind(v: unknown): v is IdeaKind {
  return typeof v === "string" && (IDEA_KINDS as string[]).includes(v);
}

export function isIdeaSource(v: unknown): v is IdeaSource {
  return typeof v === "string" && (IDEA_SOURCES as string[]).includes(v);
}

/** Same normalization the dedupe/zombie checks share: trim + case-fold. */
function normTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** Case-insensitive title match among proposed ideas in the workspace. */
function hasDupTitle(workspace_id: string, title: string): boolean {
  const t = normTitle(title);
  return store.list({ workspace_id, status: "proposed" }).some((i) => normTitle(i.title) === t);
}

/**
 * "No is no": block a new idea that is the zombie twin of one the operator already decided on.
 *
 * - `killed` match → permanent block. Killing an idea was a decision; a feeder/intake sweep
 *   re-proposing it from the same signal (same thread, same PR) next week must not get a second
 *   vote on something already voted down.
 * - `expired` match → time-boxed block (CONFIG.ideaExpiredCooldownDays). Nobody said no — the
 *   operator just never got to it — so it isn't gone forever, but re-filing it every sweep is
 *   exactly the nagging this guard exists to stop. Past the cooldown it's fair game again.
 *
 * A match is either the same non-null `source_ref` (the same Slack thread/PR/meeting resurfacing
 * it) or the same normalized title — the identical criterion `hasDupTitle` already uses.
 */
function blockedByPastDecision(
  workspace_id: string,
  title: string,
  source_ref: string | null | undefined,
): boolean {
  const t = normTitle(title);
  const isMatch = (i: Idea) =>
    (source_ref != null && i.source_ref != null && i.source_ref === source_ref) || normTitle(i.title) === t;

  if (store.list({ workspace_id, status: "killed" }).some(isMatch)) return true;

  const cutoffMs = Date.now() - CONFIG.ideaExpiredCooldownDays * 86_400_000;
  return store
    .list({ workspace_id, status: "expired" })
    .some((i) => isMatch(i) && i.decided_at != null && Date.parse(i.decided_at) >= cutoffMs);
}

/**
 * Titles of ideas the operator killed within `days` days, newest decision first — fed into the
 * intake/feeder prompts so the sweep learns from a "no" instead of re-inventing the same idea in
 * different words next time (the block above only stops the exact zombie; this stops the rephrase).
 */
export function recentKilledTitles(workspace_id: string, days = 90): string[] {
  const cutoffMs = Date.now() - days * 86_400_000;
  return store
    .list({ workspace_id, status: "killed" })
    .filter((i) => i.decided_at != null && Date.parse(i.decided_at) >= cutoffMs)
    .sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))
    .map((i) => i.title);
}

/** Prompt section listing recent kills, or "" when there are none. Capped like every other
 * externally-sourced block injected into an agent prompt, and passed through the content guard —
 * idea titles can originate from an AI feeder, so they're untrusted the same way ticket text is. */
export function killedTitlesSection(workspace_id: string): string {
  const titles = recentKilledTitles(workspace_id).slice(0, 20);
  if (!titles.length) return "";
  const body = guard(cap(titles.map((t) => `- ${t}`).join("\n"), 2_000), `killed-ideas ${workspace_id}`, workspace_id);
  return `## The operator said NO to these — do not re-propose or rephrase them\n${body}`;
}

export function createIdea(input: NewIdea): Idea | null {
  if (!workspaces.get(input.workspace_id)) throw new Error("workspace not found");
  if (!isIdeaKind(input.kind)) throw new Error(`invalid kind: ${input.kind}`);
  if (!isIdeaSource(input.source)) throw new Error(`invalid source: ${input.source}`);
  const title = String(input.title || "").trim();
  const pitch = String(input.pitch || "").trim();
  if (!title) throw new Error("title required");
  if (!pitch) throw new Error("pitch required");
  if (hasDupTitle(input.workspace_id, title)) return null;
  if (blockedByPastDecision(input.workspace_id, title, input.source_ref)) return null;

  if (input.repo_id) {
    const r = repos.get(input.repo_id);
    if (!r || r.workspace_id !== input.workspace_id) throw new Error("repo not found in workspace");
  }

  const row: Idea = {
    id: randomUUID(),
    workspace_id: input.workspace_id,
    repo_id: input.repo_id ?? null,
    title,
    pitch,
    acceptance: input.acceptance?.trim() || null,
    kind: input.kind,
    source: input.source,
    source_ref: input.source_ref ?? null,
    status: "proposed",
    model: input.model ?? null,
    promoted_ticket_id: null,
    created_at: new Date().toISOString(),
    decided_at: null,
  };
  const created = store.insert(row);
  bus.publish({ topic: "idea.created", idea_id: created.id, workspace_id: created.workspace_id });
  return created;
}

export async function promoteIdea(
  id: string,
  opts: { external?: boolean } = {},
): Promise<Ticket> {
  const idea = store.get(id);
  if (!idea) throw new Error("idea not found");
  if (idea.status !== "proposed") throw new Error(`idea is ${idea.status}, not proposed`);

  // Ticket row + idea decision must land together — a promoted idea with no ticket (or a ticket
  // with no promoted-idea record) is an inconsistent state a caller could observe mid-crash.
  const ticket = db.transaction(() => {
    const t = createTicket({
      workspace_id: idea.workspace_id,
      repo_id: idea.repo_id,
      title: idea.title,
      context: idea.pitch,
      // An intake draft arrives already specified; carrying it into the ticket verbatim is the whole
      // point — an approved draft has to be buildable without the operator writing the spec himself.
      acceptance: idea.acceptance ?? undefined,
      tags: [idea.kind, "idea"],
    });
    store.decide(id, { status: "promoted", promoted_ticket_id: t.id });
    return t;
  })();
  bus.publish({
    topic: "idea.decided",
    idea_id: id,
    workspace_id: idea.workspace_id,
    status: "promoted",
  });

  captureLearnings(
    idea.workspace_id,
    [`Idea promoted: "${idea.title}" (kind=${idea.kind}, source=${idea.source})`],
    "idea-triage",
  );

  const ws = workspaces.get(idea.workspace_id);
  const cfg = parseIdeasConfig(ws?.ideas_config);
  const wantExternal = opts.external ?? !!cfg.push_external;
  if (wantExternal && ws && ws.ticket_connector !== "native") {
    const conn = CONNECTORS[ws.ticket_connector];
    if (conn?.createTask) {
      try {
        const ccfg = ws.connector_config ? JSON.parse(ws.connector_config) : {};
        const ext = await conn.createTask(ccfg, { title: idea.title, description: idea.pitch });
        updateTicket(ticket.id, {
          external_system: ws.ticket_connector,
          external_id: ext.id,
          external_url: ext.url,
        });
      } catch (e: any) {
        console.warn("[ideas] external create failed", e?.message ?? e);
        notify(
          `⚠ Idea promoted locally but external create failed: ${String(e?.message ?? e).slice(0, 120)}`,
        ).catch(() => {});
      }
    }
  }

  return tickets.get(ticket.id) ?? ticket;
}

export function killIdea(id: string): Idea {
  const idea = store.get(id);
  if (!idea) throw new Error("idea not found");
  if (idea.status !== "proposed") throw new Error(`idea is ${idea.status}, not proposed`);
  const updated = store.decide(id, { status: "killed" })!;
  bus.publish({
    topic: "idea.decided",
    idea_id: id,
    workspace_id: idea.workspace_id,
    status: "killed",
  });
  captureLearnings(
    idea.workspace_id,
    [`Idea killed: "${idea.title}" (kind=${idea.kind}, source=${idea.source})`],
    "idea-triage",
  );
  return updated;
}

export function killIdeas(ids: string[]): Idea[] {
  const out: Idea[] = [];
  for (const id of ids) {
    try {
      out.push(killIdea(id));
    } catch {
      /* skip missing / already decided */
    }
  }
  return out;
}

// ───────────────────────────── context bundle + AI feeders ─────────────────────────────

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n(…truncated at ${max} chars)`;
}

export function ideaContextBundle(ws: Workspace, repo?: Repo | null): string {
  const sections: string[] = [];

  // 1. Workspace goals/context (★ notes) — narrowed to this repo's scoped memos when a repo is given
  const ctx = contextBlock(ws.id, repo?.id ?? null);
  if (ctx) sections.push(`## Workspace context\n${ctx}`);

  // 2. Repos — only idea-enabled ones are valid attribution targets for AI feeders
  const allRepos = repos.list(ws.id);
  const enabledRepos = allRepos.filter((r) => r.ideas_enabled !== 0);
  const disabledRepos = allRepos.filter((r) => r.ideas_enabled === 0);
  if (enabledRepos.length) {
    const lines = enabledRepos.map((r) => {
      const focus = repo && r.id === repo.id ? " ← FOCUS" : "";
      const done = r.done_criteria ? ` — done: ${r.done_criteria.replace(/\s+/g, " ").slice(0, 120)}` : "";
      return `- ${r.name} (${r.path.split("/").pop() ?? r.path})${done}${focus}`;
    });
    sections.push(`## Repos\n${lines.join("\n")}\n\n(Repo-level nuance lives in a ★ note slug \`repo-<name>\` if present.)`);
  }
  if (disabledRepos.length) {
    sections.push(
      `## Repos opted out of idea feeders — do NOT propose ideas for these\n` +
        disabledRepos.map((r) => `- ${r.name}`).join("\n"),
    );
  }

  // 3. Recent tickets
  const now = Date.now();
  const d7 = now - 7 * 86_400_000;
  const d30 = now - 30 * 86_400_000;
  const all = tickets.list({ workspace_id: ws.id });
  const recent = all.filter((t) => {
    const ts = Date.parse(t.updated_at || t.created_at);
    return Number.isFinite(ts) && ts >= d30;
  });
  const full: string[] = [];
  const titles: string[] = [];
  let fullChars = 0;
  for (const t of recent) {
    const ts = Date.parse(t.updated_at || t.created_at);
    const tags = t.tags ? (() => { try { return JSON.parse(t.tags).join(","); } catch { return t.tags; } })() : "";
    const head = `${t.key} ${t.title} [${t.status}]${tags ? ` (${tags})` : ""}`;
    if (ts >= d7 && fullChars < 20_000) {
      const body = cap(getBody(t), 800);
      const piece = `- ${head}\n${body}`;
      full.push(piece);
      fullChars += piece.length;
    } else {
      titles.push(`- ${head}`);
    }
  }
  if (full.length) sections.push(`## Tickets (last 7 days, full)\n${cap(full.join("\n\n"), 20_000)}`);
  if (titles.length) sections.push(`## Tickets (8-30 days, titles)\n${cap(titles.join("\n"), 4_000)}`);

  // 4. Existing pool
  const pool = store.list({ workspace_id: ws.id, status: "proposed" });
  if (pool.length) {
    const lines = pool.map((i) => `- ${i.kind}: ${i.title} — ${i.pitch.replace(/\s+/g, " ").slice(0, 160)}`);
    sections.push(`## Ideas already in the pool — do NOT duplicate or rephrase any of these\n${cap(lines.join("\n"), 4_000)}`);
  }

  // 4b. Kills — a rejected pitch is a stronger signal than the live pool: it tells the feeder what
  // NOT to try again, phrased differently or not.
  const killedSection = killedTitlesSection(ws.id);
  if (killedSection) sections.push(killedSection);

  // 5. Learnings
  const learn = notes.bySlug(ws.id, "session-learnings");
  if (learn?.body) sections.push(`## Operator learnings\n${cap(learn.body, 5_000)}`);

  return sections.join("\n\n");
}

function buildPrompt(
  feeder: "followups" | "miner",
  count: number,
  bundle: string,
  ticket?: Ticket,
): string {
  const task =
    feeder === "followups" && ticket
      ? `## Just-completed ticket\n${ticket.key} ${ticket.title}\n${cap(getBody(ticket), 6_000)}\n\nTask: propose ${count} follow-up or expansion ideas that build on this ticket.`
      : `Task: analyze the backlog above for gaps — missing QA coverage, UX debt, visibility/observability holes, natural next features. Propose ${count} ideas.`;

  return `You generate ticket ideas for a software workspace. Staging only — a human triages.

${bundle}

${task}

Output STRICT JSON, nothing else:
[{"title":"<max 70 chars>","pitch":"<2 lines, why it matters + rough shape>",
  "kind":"expansion|new|improvement|ux-ui|qa|visibility","repo":"<repo name or null>"}]
Rules: no duplicates of pool or recent tickets; concrete and shippable; prefer small over epic.`;
}

/** Parse model JSON array; validate kinds. Exported for unit tests. */
export function parseIdeaJson(raw: string | null): Array<{ title: string; pitch: string; kind: IdeaKind; repo?: string | null }> {
  if (!raw) return [];
  let text = raw.trim();
  // strip markdown fences
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(text);
  if (fence) text = fence[1].trim();
  // extract first JSON array if prose wraps it
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ title: string; pitch: string; kind: IdeaKind; repo?: string | null }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as any;
    if (!isIdeaKind(o.kind)) continue;
    const title = String(o.title || "").trim();
    const pitch = String(o.pitch || "").trim();
    if (!title || !pitch) continue;
    out.push({ title, pitch, kind: o.kind, repo: o.repo ?? null });
  }
  return out;
}

function resolveRepoId(wsId: string, name: string | null | undefined): string | null {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const hit = repos.list(wsId).find((r) => r.name.toLowerCase() === n);
  return hit?.id ?? null;
}

async function runOneShotAgent(
  prompt: string,
  backendName: string,
  model: string | null,
  ws: Workspace,
): Promise<string | null> {
  const backend = getBackend(backendName);
  const env = childEnv(ws);
  const timeoutMs = 120_000;
  const spec = backend.oneShot({ prompt, model, configDir: "", timeoutMs });
  return new Promise((resolve) => {
    try {
      execFile(
        spec.cmd,
        spec.args,
        { timeout: timeoutMs, maxBuffer: 4 << 20, env: { ...env, ...spec.env } },
        (err, stdout) => resolve(err ? null : resultText(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}

/** In-process one-shot feeder (tests / cheap sync path). Prefer dispatchIdeaFeeder for UI. */
export async function runFeeder(
  ws: Workspace,
  feeder: "followups" | "miner",
  extra?: { ticket?: Ticket; force?: boolean },
): Promise<Idea[]> {
  const cfg = feederConfig(ws, feeder);
  if (!cfg.enabled && !extra?.force) return [];

  // Followups: skip when the completed ticket's repo opted out of ideas.
  if (feeder === "followups" && extra?.ticket?.repo_id && !repoIdeasEnabled(extra.ticket.repo_id)) {
    return [];
  }

  const repo = extra?.ticket?.repo_id ? repos.get(extra.ticket.repo_id) : null;
  const bundle = ideaContextBundle(ws, repo);
  const prompt = buildPrompt(feeder, cfg.count, bundle, extra?.ticket);
  const agent = resolveFeederAgent(ws, cfg.model);
  const raw = await runOneShotAgent(prompt, agent.backend, agent.model, ws);
  const items = parseIdeaJson(raw);
  const created: Idea[] = [];
  for (const item of items.slice(0, cfg.count)) {
    let repo_id = resolveRepoId(ws.id, item.repo) ?? extra?.ticket?.repo_id ?? null;
    // Drop attribution (or skip) if the resolved repo opted out — never force ideas onto disabled repos.
    if (repo_id && !repoIdeasEnabled(repo_id)) {
      if (feeder === "followups") continue;
      repo_id = null;
    }
    const idea = createIdea({
      workspace_id: ws.id,
      repo_id,
      title: item.title.slice(0, 70),
      pitch: item.pitch,
      kind: item.kind,
      source: feeder,
      source_ref: extra?.ticket?.id ?? null,
      model: agent.model,
    });
    if (idea) created.push(idea);
  }
  if (created.length) {
    notify(
      `💡 <b>${ws.name}</b> · ${created.length} new idea${created.length === 1 ? "" : "s"} (${feeder})`,
    ).catch(() => {});
  }
  return created;
}

/**
 * Headless job that researches + files ideas via `mc idea new`. Returns immediately so the UI
 * can toast "started" and deep-link to the live run (same shape as plan/distill).
 */
export function dispatchIdeaFeeder(
  workspaceId: string,
  feeder: "followups" | "miner",
  opts: { ticketId?: string | null; force?: boolean } = {},
): { job_id: string; run_id?: string; status?: string } {
  const ws = workspaces.get(workspaceId);
  if (!ws) throw new Error("workspace not found");
  const cfg = feederConfig(ws, feeder);
  if (!cfg.enabled && !opts.force) throw new Error(`${feeder} feeder disabled for this workspace`);

  const ticket = opts.ticketId ? tickets.get(opts.ticketId) : undefined;
  if (opts.ticketId && !ticket) throw new Error("ticket not found");
  if (ticket && ticket.workspace_id !== ws.id) throw new Error("ticket belongs to another workspace");
  if (feeder === "followups" && ticket?.repo_id && !repoIdeasEnabled(ticket.repo_id)) {
    throw new Error("ticket repo has idea feeders disabled");
  }

  const repo = ticket?.repo_id ? repos.get(ticket.repo_id) : null;
  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path) && r.ideas_enabled !== 0);
  const cwd =
    repo?.path && fs.existsSync(repo.path)
      ? repo.path
      : wsRepos[0]?.path || REPO_ROOT;
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== cwd);

  const bundle = ideaContextBundle(ws, repo);
  const ticketBlock =
    feeder === "followups" && ticket
      ? `\n## Focus ticket (build follow-ups on this)\n${ticket.key} ${ticket.title}\n${cap(getBody(ticket), 6_000)}\n`
      : "";

  const goal =
    `IDEA GENERATION TASK (staging only — do NOT create tickets, do NOT edit code).\n` +
    `Workspace: ${ws.name} (${ws.slug}). Feeder: ${feeder}. File exactly ~${cfg.count} ideas.\n` +
    `You may ONLY read/search the codebase and call Mission Control CLI.\n\n` +
    `${ticketBlock}` +
    `## Context bundle\n${bundle}\n\n` +
    `For each idea, file it with:\n` +
    `  mc idea new --title "..." --pitch "..." --acceptance "<concrete, checkable criteria>" --kind expansion|new|improvement|ux-ui|qa|visibility --source ${feeder}` +
    (ticket ? ` --source-ref ${ticket.id}` : "") +
    ` [--repo "repo-name"]\n` +
    `List the current pool first: \`mc idea list\` — do NOT duplicate or rephrase those titles.\n` +
    `Prefer small, shippable ideas over epics. When done, print a one-line summary of how many you filed.`;

  const { backend, model } = resolveFeederAgent(ws, cfg.model);
  const spawnErr = validateSpawnTarget(backend, model);
  if (spawnErr) throw new Error(spawnErr);

  const job = jobs.create({
    name: ticket ? `ideas:${feeder}:${ticket.key}` : `ideas:${feeder}:${ws.slug}`,
    description: ticket
      ? `Idea follow-ups for ${ticket.key}`
      : `Idea miner for ${ws.name}`,
    goal,
    workspace_id: ws.id,
    ticket_id: ticket?.id ?? null,
    backend,
    model,
    cwd,
    add_dirs: addDirs.length ? addDirs : null,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });

  const r = dispatch(job.id, `ideas:${feeder}`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

// ───────────────────────────── wiring ─────────────────────────────

let lastMinerDay: string | null = null;
const todayStr = () => new Date().toISOString().slice(0, 10);

export async function maybeMineIdeas() {
  if (CONFIG.digestHour < 0) return;
  const now = new Date();
  // Sunday at digestHour+1 (one hour after memory hygiene)
  if (now.getDay() !== 0 || now.getHours() !== ((CONFIG.digestHour + 1) % 24)) return;
  if (lastMinerDay === todayStr()) return;
  lastMinerDay = todayStr();

  for (const w of workspaces.list()) {
    const cfg = feederConfig(w, "miner");
    if (!cfg.enabled) continue;
    try {
      const r = dispatchIdeaFeeder(w.id, "miner");
      if (r.status?.startsWith("error")) console.warn("[ideas] miner dispatch", w.slug, r.status);
    } catch (e: any) {
      console.warn("[ideas] miner failed", w.slug, e?.message ?? e);
    }
  }
}

export function maybeExpireIdeas() {
  try {
    const n = store.expireOld(14);
    if (n) console.log(`[ideas] expired ${n} stale proposed idea(s)`);
  } catch (e: any) {
    console.warn("[ideas] expire", e?.message ?? e);
  }
}

export function startIdeas() {
  bus.on("event", (e: any) => {
    if (e.topic !== "ticket.updated" || e.status !== "done") return;
    const t = tickets.get(e.ticket_id);
    if (!t) return;
    const ws = workspaces.get(t.workspace_id);
    if (!ws) return;
    // Idea-promoted tickets don't spawn more ideas — else ideas → ticket → ideas loops forever.
    if (ticketFromIdea(t)) return;
    const cfg = feederConfig(ws, "followups");
    if (!cfg.enabled) return;
    if (t.repo_id && !repoIdeasEnabled(t.repo_id)) return;
    try {
      dispatchIdeaFeeder(ws.id, "followups", { ticketId: t.id });
    } catch (err: any) {
      console.warn("[ideas] followups failed", t.key, err?.message ?? err);
    }
  });
  console.log("[ideas] followups listener + pool service ready");
}
