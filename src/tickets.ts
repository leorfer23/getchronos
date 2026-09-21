import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { db, tickets as store, workspaces, repos, jobs, reviews, runs, searchIndex, notes as notesStore, skills as skillsStore, ticketLinks, deletedExternals, wsPrefix } from "./store.js";
import { dispatch } from "./dispatcher.js";
import { getBackend, validateSpawnTarget } from "./backends/index.js";
import { formatAttachmentsBlock } from "./attachments.js";
import { bus } from "./bus.js";
import { guard } from "./guard.js";
import { CONFIG } from "./config.js";
import { wsTicketsDir } from "./sandbox.js";
import { aiTicketSummary } from "./summarize.js";
import { ensureTicketWorktree, isGitRepo } from "./worktrees.js";
import { parseGates, parseHumanGate } from "./gates.js";
import { lessonsBlock } from "./lessons.js";
import { relevanceBlock } from "./recall.js";
import { SCOUT_LENSES, type Lens } from "./panels.js";
import type { ExternalTask } from "./connectors/types.js";
import type { NewTicket, Repo, Ticket, TicketRow, TicketStatus, Workspace } from "./types.js";

// Plan-graded implementation difficulty 1-5 (5 = hardest) → build agent auto-routing.
// Stored in the `complexity` column as "1".."5"; legacy trivial|easy|medium|hard rows map in. null → 3.
const LEGACY_DIFFICULTY: Record<string, number> = { trivial: 1, easy: 2, medium: 3, hard: 4 };
export function difficultyOf(complexity: string | null | undefined): number {
  if (complexity == null) return 3;
  const n = Number(complexity);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return LEGACY_DIFFICULTY[complexity] ?? 3;
}
export const isDifficulty = (v: unknown): boolean =>
  v != null && v !== "" && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5;

function parseRouteConfig(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}

/**
 * Every build agent the operator listed for this ticket's difficulty tier, in HIS order.
 *
 * A `route_config` value may name more than one candidate, comma-separated
 * ({"4": "claude-code:opus,codex:gpt-5-codex"}); a value with no comma is the same one-candidate
 * answer this has always given, so an existing config behaves identically. Order is load-bearing:
 * the quota gate (src/quota-gate.ts) ranks these by spend priority and settles a genuine tie by
 * taking the first one here. Same tier only — the gate must never spend a tier-4 ticket on the
 * tier-2 rung to conserve quota.
 */
export function routeCandidates(
  t: Pick<Ticket, "complexity" | "backend" | "model">,
  ws: Pick<Workspace, "default_backend" | "route_config">,
): Array<{ backend?: string; model?: string }> {
  if (t.model) return []; // explicit model pinned → don't second-guess it
  const d = difficultyOf(t.complexity);
  const spec = parseRouteConfig(ws.route_config)[String(d)];
  if (spec) {
    return spec
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((one) => {
        const i = one.indexOf(":");
        if (i >= 0) return { backend: one.slice(0, i) || undefined, model: one.slice(i + 1) || undefined };
        return { model: one }; // model within the workspace's default backend
      });
  }
  if ((t.backend ?? ws.default_backend) !== "claude-code") return [];
  const m = CONFIG.routeModels[String(d)];
  return m ? [{ model: m }] : [];
}

// Auto-route the build agent from the ticket's plan-graded difficulty. Per-workspace route_config
// ({"1".."5": "backend:model" | "model"}) wins → else the global CONFIG.routeModels fallback (claude-code
// model names only, so never applied to another backend). Explicit ticket backend/model is handled by
// the caller and always wins over routing. Returns {} when nothing routes (caller uses ws defaults).
export function routeAgent(
  t: Pick<Ticket, "complexity" | "backend" | "model">,
  ws: Pick<Workspace, "default_backend" | "route_config">,
): { backend?: string; model?: string } {
  return routeCandidates(t, ws)[0] ?? {};
}

const home = os.homedir();

/**
 * "Is this already done?" — the first question every stage asks (PER-27).
 *
 * 7 of the 12 asks in Chronos' history are a worker discovering the ticket had already shipped:
 * PER-18 (duplicate of PER-3/PER-11, asked three times), PER-4 (merged in #173, 34 runs burned),
 * ACM-101 (merged in two PRs), ACM-14. The workers did good work and reached the right conclusion —
 * they were handed work that no longer existed, and the only way to find out was to spend the run.
 *
 * The exit matters as much as the check. A ticket proven already-shipped is settled by the evidence,
 * not by a human's judgment, so the agent closes it with that evidence instead of parking on an ask.
 * PER-18 asked the same question three times because asking was the only exit it had.
 *
 * Stage-specific because the authority differs: a lens scout must not close a ticket its two
 * siblings are still investigating — it reports, and the merge step decides.
 */
function stalenessGoal(stage: "plan" | "scout" | "merge" | "build", key: string): string {
  const head =
    `FIRST — IS THIS ALREADY DONE? Before anything else, check whether this work already exists on the ` +
    `default branch: search for the symbols/files the ticket describes, and check the log for commits or ` +
    `merged PRs matching it. Tickets go stale — the fix may have shipped under another key, or the ticket ` +
    `may duplicate one already closed.\n`;
  const exit = {
    plan:
      `If it IS already shipped, do NOT write a brief: run \`mc dismiss ${key} "<what you found — commits, PRs, ` +
      `files, and why it covers this ticket>"\` and stop. That is a complete, successful outcome for this run.\n`,
    scout:
      `If it looks already shipped, do NOT dismiss the ticket — your two sibling scouts are still working and ` +
      `the merge step owns that call. Lead your \`mc note\` with the evidence (commits, PRs, files) so the merge ` +
      `step can close it.\n`,
    merge:
      `If the scouts' findings show it is already shipped, do NOT write a plan: run \`mc dismiss ${key} "<the ` +
      `evidence>"\` and stop.\n`,
    build:
      `If it IS already shipped, do NOT write code and do NOT open an ask asking permission to say so — run ` +
      `\`mc dismiss ${key} "<the evidence>"\` and stop. Stating a verified fact is not a decision that needs a human.\n`,
  }[stage];
  return `${head}${exit}Only claim this after actually looking; "probably fine" is not evidence.\n\n`;
}

export type Capability = { name: string; available: boolean; note?: string };

/** Parse the workspace's declared capabilities; malformed JSON is treated as "nothing declared". */
export function parseCapabilities(json: string | null | undefined): Capability[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((c) => c && typeof c.name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What this environment CANNOT reach (PER-28).
 *
 * CED-99 reached step 3 of 6 before discovering the sandbox denies `~/.config/gcloud`, and ACM-106
 * hit the identical Redshift/Snowflake wall ACM-105 had already hit — the knowledge existed in the
 * system and never reached the next worker. Both then opened asks whose honest answer was "we don't
 * have it", which no human can resolve.
 *
 * Only the unavailable entries are listed: what works is noise in a prompt, what doesn't is the
 * thing that saves the run. Empty when nothing is declared, so prompts are unchanged by default.
 */
export function capabilitiesGoal(capsJson: string | null | undefined): string {
  const missing = parseCapabilities(capsJson).filter((c) => !c.available);
  if (!missing.length) return "";
  const lines = missing.map((c) => `  • ${c.name}${c.note ? ` — ${c.note}` : ""}`).join("\n");
  return (
    `\nWHAT THIS ENVIRONMENT DOES NOT HAVE — do not plan around acquiring these, they are absent by design:\n` +
    `${lines}\n` +
    `If this ticket fundamentally requires one of them, say so NOW and stop: note it on the ticket and end the ` +
    `run. Do not spend the run reaching the wall, and do not open an ask — "we don't have it" is not an answer ` +
    `a human can give you.\n\n`
  );
}

// Goal ancestry: if this ticket hangs under parent tickets, inject the chain (root-first) so the agent
// understands WHY it exists, not just the local task. Empty when the ticket has no parent. Titles may be
// external (tracker sync) → guarded, like relevanceBlock.
function ancestryGoal(ws: Pick<Workspace, "id">, ticketId: string): string {
  const chain = ticketLinks.ancestors(ticketId);
  if (!chain.length) return "";
  const lines = chain.map((a, i) => `${"  ".repeat(i)}- ${a.key}: ${a.title}`).join("\n");
  const block = guard(
    `This ticket is part of a larger goal — its parent chain (top-level first). Keep the top goal in mind; ` +
      `don't solve beyond this ticket's own scope:\n${lines}`,
    `ancestry ${ticketId}`,
    ws.id,
  );
  return `\n\n${block}`;
}

// Goal-suffix form: parses the ticket's JSON tags and adds a leading separator when non-empty.
function relevanceGoal(ws: Pick<Workspace, "id">, title: string, tagsJson: string | null, key: string): string {
  let tags: string[] = [];
  try { if (tagsJson) tags = JSON.parse(tagsJson); } catch {}
  const block = relevanceBlock(ws, title, tags, key);
  return block ? `\n\n${block}` : "";
}

// ───────────────────────────── markdown <-> ticket ─────────────────────────────

// PR-delivery branch for a ticket. Key is system-generated ([A-Z]{3}-\d+); sanitize anyway so the
// value is always a safe git ref fragment (no shell interpolation of user strings ever reaches git).
export function ticketBranch(key: string): string {
  const safe = key.toLowerCase().replace(/[^a-z0-9-]+/g, "");
  return `mc/${safe || "ticket"}`;
}

/** Per-repo Definition of Done block injected into build/review agent goals. */
export function formatDoneCriteria(repo?: Repo | null): string {
  if (!repo) return "";
  const parts: string[] = [];
  if (repo.done_criteria?.trim()) {
    parts.push(
      `## Definition of Done (repo: ${repo.name})\n` +
        `You MUST satisfy every item before finishing. Report what you ran in the Work log.\n` +
        `${repo.done_criteria.trim()}\n`,
    );
  }
  const gates = parseGates(repo);
  if (gates.length) {
    parts.push(
      `## Evidence gates (hard)\n` +
        `When you finish, the system runs these in your worktree. Any non-zero exit sends the ticket ` +
        `straight back to you with the output — it never reaches a reviewer:\n` +
        gates.map((g) => `- **${g.name}**: \`${g.cmd}\``).join("\n") +
        `\nRun them yourself before you finish, and fix what they report.\n`,
    );
  }
  const gate = parseHumanGate(repo.human_gate);
  if (gate !== "never") {
    parts.push(
      `## Human gate\n` +
        (gate === "always"
          ? `A human must Approve or Merge the review before this ticket can be Done. AI review cannot close it alone.\n`
          : `Changes at risk tier **${gate}** or above (migrations, auth/secrets, deploy config, money paths, very large diffs) ` +
            `need a human Approve. Below that, an AI approve ships it — so keep the diff tight and scoped, and say in your ` +
            `handoff which risky paths you touched and why.\n`),
    );
  }
  return parts.length ? `\n${parts.join("\n")}\n` : "";
}

// Ensure `repoPath`'s working tree is on `branch`: check it out if it exists, else branch off `base`.
// Throws on a dirty-tree checkout conflict — rethrow with git's stderr for the caller.
const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "ticket";

function frontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// Minimal frontmatter parser: returns { meta, body }. Supports scalars + inline [a, b] lists.
export function parseMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

function buildBody(input: NewTicket): string {
  return [
    "## Context",
    input.context?.trim() || "",
    "",
    "## Spec / Acceptance criteria",
    input.acceptance?.trim() || "",
    "",
    "## Work log",
    "<!-- agent appends timestamped entries; never rewrites history -->",
    "",
    "## Review notes",
    "",
  ].join("\n");
}

function fileFrontmatter(t: TicketRow, wsSlug: string, repoName: string | null): string {
  return frontmatter({
    id: t.key,
    workspace: wsSlug,
    repo: repoName,
    title: t.title,
    status: t.status,
    priority: t.priority,
    complexity: t.complexity,
    complexity_source: t.complexity_source,
    backend: t.backend,
    model: t.model,
    assignee: t.assignee,
    external_system: t.external_system,
    external_id: t.external_id,
    external_url: t.external_url,
    pr_url: t.pr_url,
    tags: t.tags ? (JSON.parse(t.tags) as string[]) : null,
    created: new Date().toISOString().slice(0, 10),
    updated: new Date().toISOString().slice(0, 10),
  });
}

function resolveFilePath(wsSlug: string, repoPath: string | null, key: string): string {
  const name = `${key}.md`;
  return repoPath
    ? path.join(repoPath, ".mc", "tickets", name)
    : path.join(wsTicketsDir(wsSlug), name);
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const data = content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

// ───────────────────────────── service ─────────────────────────────

export function createTicket(input: NewTicket): Ticket {
  const ws = workspaces.get(input.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const repo = input.repo_id ? repos.get(input.repo_id) : undefined;
  if (input.repo_id && !repo) throw new Error("repo not found");
  if (repo && repo.workspace_id !== ws.id) throw new Error("repo belongs to another workspace");
  const parent = input.parent_id ? store.get(input.parent_id) : undefined;
  if (input.parent_id && !parent) throw new Error("parent ticket not found");
  if (parent && parent.workspace_id !== ws.id) throw new Error("parent belongs to another workspace");

  // Next key = max existing numeric suffix + 1 (count+1 collides after deletions leave gaps).
  // Scanned across ALL workspaces sharing this prefix, not just this one: wsPrefix is 3 letters of
  // the slug, so "personal" and "presence" both map to PER — per-workspace sequences handed both of
  // them a PER-72, and every key-addressed surface (`mc tell KEY`, `mc note KEY`, Telegram cards)
  // resolves keys globally, so a duplicate can route a message to another workspace's ticket.
  const prefix = wsPrefix(ws.slug);
  const keyRe = new RegExp(`^${prefix}-(\\d+)$`);
  const maxNum = store.list({}).reduce((m, t) => {
    const n = keyRe.exec(t.key)?.[1];
    return n ? Math.max(m, +n) : m;
  }, 0);
  const key = `${prefix}-${maxNum + 1}`;
  const slug = kebab(input.title);
  const filePath = resolveFilePath(ws.slug, repo?.path ?? null, key);

  const row: TicketRow = {
    id: randomUUID(),
    workspace_id: ws.id,
    repo_id: repo?.id ?? null,
    key,
    slug,
    title: input.title,
    status: input.status ?? "backlog",
    // 'local' unless the caller says otherwise — only connector sync (src/connectors/index.ts)
    // passes 'external' for a freshly-mirrored ticket that reflects the tracker's own status.
    status_source: input.status_source ?? "local",
    priority: input.priority ?? "P2",
    complexity: input.complexity ?? null,
    // 'human' whenever complexity is being set on create and the caller didn't say otherwise — the
    // public API (operator/Robert) is the only in-process caller that ever sets complexity on create.
    complexity_source: input.complexity_source ?? (input.complexity != null ? "human" : null),
    backend: input.backend ?? null,
    model: input.model ?? null,
    assignee: input.assignee ?? "agent",
    file_path: filePath,
    external_system: input.external_system ?? null,
    external_id: input.external_id ?? null,
    external_url: input.external_url ?? null,
    external_status: input.external_status ?? null,
    tags: input.tags ? JSON.stringify(input.tags) : null,
    pr_url: null,
    pr_state: null,
    ci_state: null,
    ci_checks: null,
    summary: null,
    report: null,
  };

  const body = buildBody(input);
  writeFile(filePath, `${fileFrontmatter(row, ws.slug, repo?.name ?? null)}\n\n${body}`);
  const created = store.create(row);
  if (parent) ticketLinks.add(parent.id, created.id, "parent"); // child of a goal → feeds ancestryGoal injection
  void ensureTicketSummary(created); // fire-and-forget one-liner description
  searchIndex.add({
    kind: "ticket",
    ref_id: created.id,
    workspace: ws.id,
    title: `${created.key} ${created.title}`,
    body,
  });
  bus.publish({ topic: "ticket.created", ticket_id: created.id, workspace_id: ws.id });
  return created;
}

// Generate-on-read one-liner description. No-op if the ticket already has one; deduped so concurrent
// list+detail reads don't fire twice. Fire-and-forget: a failed/slow model call is a silent no-op and
// the next read retries. Emits ticket.updated so the UI refreshes once the summary lands.
const summarizing = new Set<string>();
export function ensureTicketSummary(t: Ticket): void {
  if (t.summary || summarizing.has(t.id)) return;
  summarizing.add(t.id);
  const ws = workspaces.get(t.workspace_id);
  const configDir = ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude;
  void aiTicketSummary(t.title, getBody(t), configDir, ws)
    .then((s) => {
      if (s) {
        store.update(t.id, { summary: s });
        bus.publish({ topic: "ticket.updated", ticket_id: t.id, workspace_id: t.workspace_id });
      }
    })
    .catch(() => {})
    .finally(() => summarizing.delete(t.id));
}

export function getBody(t: Ticket): string {
  try {
    return fs.readFileSync(t.file_path, "utf8");
  } catch {
    return "";
  }
}

// Update DB index + rewrite the file's frontmatter (preserving the existing body).
// Internal only — never pushes anything out to Jira/ClickUp. External write-back happens solely by
// explicit operator action, never as a side effect of a local status change.
// `silent` is for callers that publish ticket.updated themselves (reviews, which carries the actor
// and must publish AFTER its transaction commits) — without it they'd emit the event twice and every
// listener (activity, autoplan, skill distill) would fire twice per transition.
// THE status_source choke point (types.ts has the full rationale on TicketStatusSource). Every status
// transition in the codebase — API, mc, the autonomous loop, reviews, connector sync — flows through
// this function, so it's where the default lives: whenever `status` changes and the caller didn't say
// otherwise, status_source becomes 'local'. Only connectors/index.ts's syncWorkspace passes
// status_source: 'external' explicitly (a tracker-driven mirror), which is also how dispatching real
// work on a mirrored ticket flips it back to 'local' — dispatchPlan/dispatchTicket/etc. patch `status`
// here without touching status_source, so the default kicks in.
//
// THE complexity_source choke point (types.ts has the full rationale on TicketComplexitySource). The
// generic PATCH /tickets/:id — the operator's `mc ticket new/update --difficulty` and Robert's
// PROPOSE→PATCH — is the only public path that ever touches `complexity`, so whenever it changes here
// and the caller didn't say otherwise, complexity_source becomes 'human'. setPlan (scout) and
// gradeTicket (second-pass grader) bypass updateTicket entirely and stamp their own source directly —
// see tickets.ts for both.
export function updateTicket(
  id: string,
  patch: Partial<TicketRow>,
  opts?: { silent?: boolean; actor?: string }
): Ticket | undefined {
  if (patch.status !== undefined && patch.status_source === undefined) {
    patch = { ...patch, status_source: "local" };
  }
  if (patch.complexity !== undefined && patch.complexity_source === undefined) {
    patch = { ...patch, complexity_source: "human" };
  }
  // `tags` is a JSON string column, but PatchTicketSchema accepts (and createTicket takes) a real
  // array — so every caller that patched tags the way the API documents them hit "SQLite3 can only
  // bind numbers, strings, bigints, buffers, and null". Serialize here, the one path all of them
  // share, instead of at each call site.
  if (Array.isArray(patch.tags)) {
    patch = { ...patch, tags: JSON.stringify(patch.tags) };
  }
  const updated = store.update(id, patch);
  if (!updated) return undefined;
  const ws = workspaces.get(updated.workspace_id);
  const repo = updated.repo_id ? repos.get(updated.repo_id) : undefined;
  const { body } = parseMarkdown(getBody(updated));
  writeFile(
    updated.file_path,
    `${fileFrontmatter(updated, ws?.slug ?? "?", repo?.name ?? null)}\n${body || ""}`
  );
  searchIndex.removeRef(updated.id);
  searchIndex.add({
    kind: "ticket",
    ref_id: updated.id,
    workspace: updated.workspace_id,
    title: `${updated.key} ${updated.title}`,
    body,
  });
  // Notify listeners (activity, WS UI). Include status only when it changed so
  // summary-only / metadata patches stay quiet for bridges that key off status transitions.
  if (!opts?.silent) {
    bus.publish({
      topic: "ticket.updated",
      ticket_id: updated.id,
      workspace_id: updated.workspace_id,
      ...(patch.status !== undefined ? { status: updated.status } : {}),
      ...(opts?.actor ? { actor: opts.actor } : {}),
    });
  }
  return updated;
}

// Regenerate the ticket's `## External` section from a freshly pulled task. External-owned content
// (tracker description, metadata, comments) lives ONLY here — Chronos's own sections (Context, Plan,
// Work log, Review notes) are never touched — so each sync overwrites this section without clobbering
// local work. Untrusted external text is guarded (agents read this file).
export function writeExternalSection(id: string, ext: ExternalTask): void {
  const t = store.get(id);
  if (!t) return;
  const ws = workspaces.get(t.workspace_id);
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const { body } = parseMarkdown(getBody(t));
  const meta = [
    `**Status:** ${ext.statusRaw || "—"}`,
    `**Priority:** ${ext.priority ?? "—"}`,
    `**Assignee:** ${ext.assignee ?? "—"}`,
    `**Due:** ${ext.due ?? "—"}`,
    `**Updated:** ${ext.updated ?? "—"}`,
  ].join(" · ");
  const comments = ext.comments.length
    ? ext.comments.map((c) => `- **${c.author}** (${c.created ?? "?"}): ${c.body}`).join("\n")
    : "_(none)_";
  const raw = [
    "## External",
    `<!-- mirrored from ${t.external_system} ${t.external_id} — regenerated each sync; edits here are overwritten -->`,
    "",
    meta,
    ext.labels.length ? `**Labels:** ${ext.labels.join(", ")}` : null,
    ext.url ? `**Link:** ${ext.url}` : null,
    "",
    "### Description",
    ext.description || "_(none)_",
    "",
    "### Comments",
    comments,
    "",
  ].filter((l): l is string => l !== null).join("\n");
  const section = guard(raw, `external ${t.key}`, t.workspace_id) + "\n";
  const next = /##\s*External\b[\s\S]*?(?=\n##\s|\s*$)/i.test(body)
    ? body.replace(/##\s*External\b[\s\S]*?(?=\n##\s|\s*$)/i, section)
    : `${body.trimEnd()}\n\n${section}`;
  writeFile(t.file_path, `${fileFrontmatter(t, ws?.slug ?? "?", repo?.name ?? null)}\n${next}`);
  searchIndex.removeRef(t.id);
  searchIndex.add({ kind: "ticket", ref_id: t.id, workspace: t.workspace_id, title: `${t.key} ${t.title}`, body: next });
}

// Append a timestamped note to a ticket's work log (agents log progress / QA findings here).
export function appendNote(id: string, text: string, by = "agent"): Ticket | undefined {
  const t = store.get(id);
  if (!t) return undefined;
  const ws = workspaces.get(t.workspace_id);
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const { body } = parseMarkdown(getBody(t));
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- **${stamp}** (${by}): ${text}`;
  const next = /##\s*Work log/i.test(body)
    ? body.replace(/(##\s*Work log[^\n]*\n)/i, `$1${line}\n`)
    : `${body.trimEnd()}\n\n## Work log\n${line}\n`;
  writeFile(t.file_path, `${fileFrontmatter(t, ws?.slug ?? "?", repo?.name ?? null)}\n${next}`);
  searchIndex.removeRef(t.id);
  searchIndex.add({ kind: "ticket", ref_id: t.id, workspace: t.workspace_id, title: `${t.key} ${t.title}`, body: next });
  return store.get(id);
}

// Most recent "Logged Nh." note off the ticket's Work log (e.g. "Logged 8h." typed in chat when
// closing a ticket). Notes are prepended, so the first match in the section is the newest.
// Used to backfill Jira's Hours Spent field on a Done push when the caller didn't pass one explicitly.
export function lastLoggedHours(t: Ticket): number | null {
  const { body } = parseMarkdown(getBody(t));
  const section = body.match(/##\s*Work log\b[\s\S]*?(?=\n##\s|\s*$)/i)?.[0] ?? "";
  const hit = section.match(/logged\s+(\d+(?:\.\d+)?)\s*h\b/i);
  return hit ? Number(hit[1]) : null;
}

// Write/replace the ticket's "## Plan" section with the scout's context brief, and (by default)
// flip status → planned so a human gates the build. Source of truth = the .md file.
export function setPlan(id: string, markdown: string, opts: { status?: TicketStatus; complexity?: string } = {}): Ticket | undefined {
  const t = store.get(id);
  if (!t) return undefined;
  const status = opts.status ?? "planned";
  // Planner grades implementation complexity (drives build model routing); ignore invalid grades.
  // A human-set complexity (complexity_source 'human') is authoritative — the scout's own grade never
  // overwrites it, same rule gradeTicket enforces for the second pass.
  const patch: Partial<TicketRow> = { status };
  if (isDifficulty(opts.complexity) && t.complexity_source !== "human") {
    patch.complexity = String(Number(opts.complexity));
    patch.complexity_source = "scout";
  }
  const updated = store.update(id, patch)!;
  const ws = workspaces.get(updated.workspace_id);
  const repo = updated.repo_id ? repos.get(updated.repo_id) : undefined;
  const { body } = parseMarkdown(getBody(updated));
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const section = `## Plan\n<!-- agent-generated ${stamp}; awaiting human approval -->\n\n${markdown.trim()}\n`;
  const next = /##\s*Plan\b[\s\S]*?(?=\n##\s|\s*$)/i.test(body)
    ? body.replace(/##\s*Plan\b[\s\S]*?(?=\n##\s|\s*$)/i, section)
    : `${body.trimEnd()}\n\n${section}`;
  writeFile(updated.file_path, `${fileFrontmatter(updated, ws?.slug ?? "?", repo?.name ?? null)}\n${next}`);
  searchIndex.removeRef(updated.id);
  searchIndex.add({ kind: "ticket", ref_id: updated.id, workspace: updated.workspace_id, title: `${updated.key} ${updated.title}`, body: next });
  bus.publish({ topic: "ticket.updated", ticket_id: updated.id, status });
  return updated;
}

type DispatchOutcome = { job_id?: string; run_id?: string; status?: string };

/**
 * Every dispatch attempt lands in the ticket's own thread — including the ones that never produce a run.
 *
 * run.started/run.ended are the only signals timeline listeners have that work happened, so a dispatch that
 * dies in pre-flight (goal has children, open upstream blocker, worktree refused, non-headless backend)
 * or one the dispatcher answers `blocked` (daily budget cap) left the thread silent — ACM-90 was
 * dispatched, failed before a job existed, and its forum thread still read as if nothing was attempted.
 * The failure is the part of the history worth keeping, so it publishes like any other ticket event.
 */
export function traceDispatch<F extends (...args: any[]) => DispatchOutcome | Promise<DispatchOutcome>>(
  what: string,
  fn: F,
  ticketIdOf: (...args: Parameters<F>) => string | null | undefined = (...args) => args[0] as string,
): F {
  const emit = (args: Parameters<F>, text: string) => {
    const ticketId = ticketIdOf(...args);
    if (ticketId) bus.publish({ topic: "ticket.event", ticket_id: ticketId, text });
  };
  // A run that actually started narrates itself through run.started/run.ended — only report the
  // outcomes that produce no run at all.
  const done = (args: Parameters<F>, out: DispatchOutcome) => {
    const status = out.status ?? "";
    if (status && status !== "queued" && status !== "running")
      emit(args, `⚠️ **${what}** never started — \`${status}\``);
    return out;
  };
  const failed = (args: Parameters<F>, err: unknown) => {
    emit(args, `⚠️ **${what}** dispatch failed — ${(err as Error)?.message ?? String(err)}`);
  };
  return ((...args: Parameters<F>) => {
    let out: DispatchOutcome | Promise<DispatchOutcome>;
    try {
      out = fn(...args);
    } catch (err) {
      failed(args, err);
      throw err;
    }
    return out instanceof Promise
      ? out.then(
          (o) => done(args, o),
          (err) => {
            failed(args, err);
            throw err;
          },
        )
      : done(args, out);
  }) as F;
}

// Every entry point (API, mc, Telegram, autoplan, recovery) goes through these, so the
// trail is on by construction rather than remembered at each call site.
export const dispatchPlan = traceDispatch("plan", dispatchPlanRaw);
export const dispatchPlanMerge = traceDispatch("plan merge", dispatchPlanMergeRaw);
export const dispatchGrade = traceDispatch("grade", dispatchGradeRaw);
export const dispatchTicket = traceDispatch("build", dispatchTicketRaw);
export const dispatchCiFix = traceDispatch("CI fix", dispatchCiFixRaw);

// Dispatch a READ-ONLY planning agent: a scout that enriches the ticket with a context brief (relevant
// files/symbols/references, gotchas, open questions) — NOT an action plan — then marks it `planned`.
// No code edits — Edit/Write tools are disallowed.
function dispatchPlanRaw(id: string, opts: { lens?: Lens } = {}): { job_id: string; run_id?: string; status?: string } {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  if (runs.hasActiveJob(t.id, "plan:"))
    throw new Error(`${t.key} is already being planned`);
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  // Repo optional (same rule as dispatchTicket): plan against the ticket's repo if set, else across the
  // workspace's repos. Read-only, so we grant every workspace repo for investigation.
  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const cwd = repo?.path && fs.existsSync(repo.path) ? repo.path : (wsRepos[0]?.path ?? os.homedir());
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== cwd);

  const ticketRef = repo && cwd === repo.path ? path.relative(repo.path, t.file_path) : t.file_path;
  const scope = repo
    ? `in repo "${repo.name}"`
    : wsRepos.length
      ? `across workspace "${ws.name}" repos: ${wsRepos.map((r) => r.name).join(", ")}`
      : `in workspace "${ws.name}"`;
  // Ticket title may originate from an external tracker (ClickUp/Jira sync) or an operator — guard
  // it uniformly here, at the point it's embedded into the agent's goal prompt.
  const title = guard(t.title, `ticket ${t.key} title`, ws.id);
  const goal =
    `PLANNING TASK (read-only — do NOT modify any code). Ticket ${t.key} ${scope}.\n` +
    `TITLE: ${title}\n` +
    stalenessGoal(opts.lens ? "scout" : "plan", t.key) +
    capabilitiesGoal(ws.capabilities) +
    `Read the ticket at ${ticketRef}, then investigate the code to ENRICH the ticket for the senior agent who will build it. ` +
    `You are a scout, not an architect: gather facts and references so the builder starts fast — do NOT decide or suggest how to solve it.\n\n` +
    `Produce a CONTEXT BRIEF covering: (1) what exists today — the relevant files, modules, and symbols, with real paths, ` +
    `(2) how the pieces connect (call sites, data flow, configs) as far as this ticket touches them, ` +
    `(3) where the behavior in question lives — for bugs, the observed root cause as fact, not a fix proposal, ` +
    `(4) related tests, fixtures, and repo conventions the builder should know, ` +
    `(5) gotchas, constraints, ambiguities, and open questions for the human.\n` +
    `Do NOT include: step-by-step implementation plans, recommended approaches, opinions on how it should be done, or code sketches. ` +
    `If the ticket is ambiguous, surface the ambiguity — don't resolve it by picking an approach. Only cite paths/symbols you actually read.\n\n` +
    `If a question blocks the plan itself (contradictory requirements, missing access) rather than just being an open ` +
    `question for the brief, file it fire-and-forget — \`mc ask "..." --wait 0\` — then finish the brief noting it's ` +
    `unresolved; planners are cheap, don't park waiting on an answer.\n\n` +
    `You may ONLY read/search (Read, Grep, Glob, read-only shell). Do NOT edit, write, or run mutating commands.\n` +
    `End the brief by grading implementation difficulty 1-5 — a factual scope/risk estimate, not a recommendation (1=one-liner, 2=small/localized, 3=multi-file/moderate, 4=cross-cutting/tricky, 5=architectural/risky). Provisional: a stronger model may re-grade.\n` +
    (opts.lens
      ? `\n## Your lens: ${opts.lens.label.toUpperCase()}\n${opts.lens.brief}\n` +
        `You are one of ${SCOUT_LENSES.length} scouts on this ticket, each searching differently. Cover YOUR lens ` +
        `thoroughly rather than producing a shallow version of all three — the others are covered, and a merge ` +
        `agent will combine the findings into the single brief the builder reads.\n` +
        `When done, file your findings with \`mc note "<your full markdown findings>"\`. Do NOT run \`mc plan\` — ` +
        `the merge step owns the plan and the difficulty grade.\n`
      : `When done, save it with: \`mc plan --difficulty 1-5 "<full markdown brief>"\` — this writes it to the ticket and marks it 'planned' for human review.\n`) +
    `\`mc learn "<durable fact>"\` records a lasting learning about this repo/company/operator (conventions, gotchas, preferences) — use it when you discover one.\n` +
    `Do not change the ticket status yourself otherwise. Stay within this workspace; you have no access to other workspaces or their repos.` +
    ancestryGoal(ws, t.id) +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const job = jobs.create({
    name: opts.lens ? `plan:${t.key}:${opts.lens.id}` : `plan:${t.key}`,
    description: opts.lens ? `Scout ${title} (${opts.lens.label})` : `Plan ${title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: t.backend ?? ws.default_backend,
    model: t.model ?? ws.default_model ?? undefined,
    cwd,
    add_dirs: addDirs.length ? addDirs : null, // sibling repos in this workspace (jobs.create JSON-encodes)
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });

  updateTicket(t.id, { status: "planning" });
  const r = dispatch(job.id, opts.lens ? `plan:${t.key}:${opts.lens.id}` : `plan:${t.key}`);
  if ("error" in r) { updateTicket(t.id, { status: "backlog" }); return { job_id: job.id, status: `error: ${r.error}` }; }
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

/**
 * Send a hard ticket to a scout PANEL: one agent per lens (map / prior art / risk), all reading the
 * same code with different questions. Returns the dispatched lens ids, or null when the ticket
 * doesn't warrant it and the caller should plan it normally.
 */
export function dispatchPlanPanel(id: string): string[] | null {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  if (!wantsScoutPanel(t, ws)) return null;
  if (runs.hasActiveJob(t.id, "plan:")) throw new Error(`${t.key} is already being planned`);

  const dispatched: string[] = [];
  for (const lens of SCOUT_LENSES) {
    try {
      const r = dispatchPlan(t.id, { lens });
      if (!r.status?.startsWith("error")) dispatched.push(lens.id);
    } catch (e) {
      console.error(`[plan-panel] ${lens.id} dispatch failed`, e);
    }
  }
  if (!dispatched.length) {
    updateTicket(t.id, { status: "backlog" }); // nothing started — don't strand it in 'planning'
    return null;
  }
  return dispatched;
}

/** A ticket earns a panel when it's been graded hard, or its workspace always wants one. */
export function wantsScoutPanel(
  t: Pick<Ticket, "complexity">,
  ws: Pick<Workspace, "plan_panel">,
): boolean {
  if (!ws.plan_panel) return false;
  // complexity is null until something grades it. An ungraded ticket is treated as a 3 everywhere
  // else in this file, and a 3 is not what panels are for.
  return difficultyOf(t.complexity) >= CONFIG.panelMinDifficulty;
}

/**
 * Merge the scouts' findings into the one brief the builder actually reads.
 *
 * The scouts wrote into the Work log rather than returning text, so this agent reads the ticket
 * file: nothing depends on run summaries surviving truncation, and the operator keeps the raw
 * findings even if the merge is disappointing.
 */
function dispatchPlanMergeRaw(id: string): { job_id: string; run_id?: string; status?: string } {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const cwd = repo?.path && fs.existsSync(repo.path) ? repo.path : (wsRepos[0]?.path ?? os.homedir());
  const ticketRef = repo && cwd === repo.path ? path.relative(repo.path, t.file_path) : t.file_path;
  const title = guard(t.title, `ticket ${t.key} title`, ws.id);

  const goal =
    `PLAN MERGE (read-only — do NOT modify code). Ticket ${t.key}: ${title}\n` +
    stalenessGoal("merge", t.key) +
    `Three scouts just investigated this ticket with different lenses and wrote their findings into the ` +
    `"## Work log" of ${ticketRef}:\n` +
    SCOUT_LENSES.map((l) => `  - **${l.label}** — ${l.brief.split(".")[0]}.`).join("\n") + `\n\n` +
    `Read the ticket file, then write the ONE context brief the builder will work from. You are still a ` +
    `scout, not an architect: no implementation plans, no recommended approaches, no code sketches.\n\n` +
    `Merge properly — this is the whole job:\n` +
    `  • Deduplicate. Three scouts will have found the same file three times; say it once.\n` +
    `  • Keep every distinct finding. A risk only one scout saw is exactly the finding worth keeping.\n` +
    `  • Reconcile contradictions by checking the code yourself, and say which one was right.\n` +
    `  • Drop anything no scout actually verified. Do not add findings of your own invention.\n` +
    `  • Keep the open questions and ambiguities as open questions — do not resolve them by choosing.\n\n` +
    `If the scouts' findings show this ticket is really several pieces of work, say so explicitly at the ` +
    `top of the brief and list the split you'd suggest — the operator can file them with \`mc ticket new ` +
    `--parent ${t.key}\` and order them with \`mc ticket link A blocks B\`. Do not file them yourself.\n\n` +
    `Save the merged brief with \`mc plan --difficulty 1-5 "<full markdown brief>"\` — this marks the ticket ` +
    `'planned'. Grade the difficulty from what the scouts actually found, not from the ticket title.\n` +
    `You may ONLY read/search. Stay within this workspace.` +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const job = jobs.create({
    name: `plan:${t.key}:merge`,
    description: `Merge scout briefs for ${title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    // The merge is the judgment call in a panel — synthesis, contradiction, what to drop. Route it to
    // the workspace's review engine (its strong/cross-vendor slot) rather than the cheap scout model.
    backend: ws.review_backend ?? t.backend ?? ws.default_backend,
    model: ws.review_model ?? t.model ?? ws.default_model ?? undefined,
    cwd,
    add_dirs: wsRepos.map((r) => r.path).filter((p) => p !== cwd),
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });

  const r = dispatch(job.id, `plan:${t.key}:merge`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

// Second-pass grader writes here (via `mc grade`): set difficulty 1-5 + append a review note.
// Does NOT touch status or the plan — pure grade, so it's safe to run after 'planned'.
// A human-set complexity (complexity_source 'human') is authoritative: this never overwrites it. The
// grader still gets a clean success (never throws) — its note is logged for the record, but the value
// is left alone. maybeGrade (src/autoplan.ts) already refuses to dispatch a grader in this situation;
// this is the belt-and-suspenders guard for a direct `mc grade` call against a human-graded ticket.
export function gradeTicket(id: string, difficulty: number | string, note?: string): Ticket | undefined {
  if (!isDifficulty(difficulty)) throw new Error("difficulty must be an integer 1-5");
  const d = String(Number(difficulty));
  const cur = store.get(id);
  if (!cur) return undefined;
  if (cur.complexity_source === "human") {
    if (note?.trim()) {
      appendNote(id, `grader suggested difficulty ${d}/5 — not applied, this ticket's complexity is human-set — ${note.trim()}`, "system");
    }
    return cur;
  }
  const updated = store.update(id, { complexity: d, complexity_source: "grader" });
  if (!updated) return undefined;
  if (note?.trim()) appendNote(id, `graded difficulty ${d}/5 — ${note.trim()}`, "system");
  bus.publish({ topic: "ticket.updated", ticket_id: id, status: updated.status } as any);
  return updated;
}

// Second grading pass: a strong read-only model reviews the explorer's brief and grades
// difficulty 1-5. Cheap — reads the ticket + its ## Plan, no re-exploration expected.
// CHRONOS_GRADER_* env pins every workspace; otherwise prefer route_config tier 4 (judgment work),
// then the live CONFIG.grader* defaults (claude-code:sonnet — never a withdrawn gateway model).
function resolveGraderAgent(ws: Workspace): { backend: string; model: string } {
  if (process.env.CHRONOS_GRADER_BACKEND || process.env.CHRONOS_GRADER_MODEL) {
    return {
      backend: process.env.CHRONOS_GRADER_BACKEND || CONFIG.graderBackend,
      model: process.env.CHRONOS_GRADER_MODEL || CONFIG.graderModel,
    };
  }
  const routed = routeAgent({ complexity: "4", backend: null, model: null }, ws);
  return {
    backend: routed.backend ?? ws.default_backend ?? CONFIG.graderBackend,
    model: routed.model ?? CONFIG.graderModel,
  };
}

function dispatchGradeRaw(id: string): { job_id: string; run_id?: string; status?: string } {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const cwd = repo?.path && fs.existsSync(repo.path) ? repo.path : (wsRepos[0]?.path ?? os.homedir());
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== cwd);
  const ticketRef = repo && cwd === repo.path ? path.relative(repo.path, t.file_path) : t.file_path;
  const title = guard(t.title, `ticket ${t.key} title`, ws.id);
  const goal =
    `GRADING TASK (read-only — do NOT modify any code). Ticket ${t.key}.\n` +
    `TITLE: ${title}\n` +
    `Read the ticket at ${ticketRef}, including its "## Plan" context brief from the scout. Spot-check the cited files/symbols if it helps you judge scope.\n` +
    `Grade the IMPLEMENTATION DIFFICULTY on a 1-5 scale — a factual scope/risk estimate, not a recommendation:\n` +
    `1 = one-liner/config tweak · 2 = small localized change · 3 = multi-file, moderate · 4 = cross-cutting or tricky · 5 = architectural, risky, or high-uncertainty.\n` +
    `Also judge whether the scout's brief is adequate for a builder — flag missing files, a wrong root-cause, or open questions in one or two sentences.\n` +
    `You may ONLY read/search (Read, Grep, Glob, read-only shell). Do NOT edit, write, or run mutating commands.\n` +
    `When done, save with: \`mc grade <1-5> "<one-line review: brief quality + any gaps>"\` — this sets the ticket's difficulty (drives build-agent routing) and logs your note. Do not change the ticket status.` +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const { backend, model } = resolveGraderAgent(ws);
  const spawnErr = validateSpawnTarget(backend, model);
  if (spawnErr) throw new Error(spawnErr);

  const job = jobs.create({
    name: `grade:${t.key}`,
    description: `Grade ${title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend,
    model,
    cwd,
    add_dirs: addDirs.length ? addDirs : null,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });

  const r = dispatch(job.id, `grade:${t.key}`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

export function removeTicket(id: string): void {
  const t = store.get(id);
  // Pending review: reviews.ticket_id is ON DELETE SET NULL, so delete would leave a mergeable
  // review with no ticket. merge() then commits in the worktree but skips land-on-default (gated
  // on t) and still returns 200 — Inbox shows success, commit stranded on mc/<key> (PER-34).
  // Decided reviews (merged/dismissed/…) may stay as historical rows with a nulled ticket_id.
  if (t && reviews.byTicket(id).some((r) => r.state === "pending")) {
    throw new Error(
      `${t.key} has a pending review — merge or dismiss it before deleting the ticket`,
    );
  }
  // Search-index removal + the row delete must commit together — a crash between the two used to be
  // able to leave the FTS ref pointing at a ticket that no longer exists (or vice versa).
  db.transaction(() => {
    searchIndex.removeRef(id);
    store.remove(id);
  })();
  // The markdown file is the ticket's other half — leaving it behind orphans a file nothing
  // references (and a stale `mc ticket new` can't reuse the key, so it lingers forever).
  // Basename guard: only ever unlink the file this ticket owns, never whatever a corrupted
  // file_path happens to point at.
  if (t && path.basename(t.file_path) === `${t.key}.md`) {
    try { fs.rmSync(t.file_path, { force: true }); } catch {}
  }
  // A connector-linked ticket deleted here on purpose must stay deleted — without this, the next
  // sync sees the external task still tracked nowhere locally and mirrors it back in under a new
  // key (PER-70). Tombstone regardless of whether an upstream close succeeds (api.ts attempts one).
  if (t && t.external_system && t.external_id) deletedExternals.add(t.workspace_id, t.external_system, t.external_id);
  if (t)
    bus.publish({
      topic: "ticket.deleted",
      ticket_id: id,
      workspace_id: t.workspace_id,
      ticket_key: t.key,
      title: t.title,
    });
}

// Build a Chronos job from a ticket and dispatch it, scoped to the ticket's workspace.
async function dispatchTicketRaw(
  id: string,
  opts?: { backend?: string | null; model?: string | null },
): Promise<{ job_id: string; run_id?: string; status?: string }> {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  // A goal (parent of ≥1 child) is an umbrella, not buildable work — refuse to dispatch an agent onto it.
  // Root-cause guard: every path (autoplan pump, operator click, mc, Telegram) routes through here.
  if (ticketLinks.children(id).length)
    throw new Error(`${t.key} is a goal (has child tickets) — it tracks child completion; it isn't built directly`);

  // Atomic checkout: refuse a second build if one is already in flight for this ticket. dispatchTicket
  // runs synchronously through the status flip + run creation, so this check + dispatch never interleave
  // — it prevents autoplan's pump, an operator click, and Telegram from racing two agents onto the same
  // worktree branch. hasActiveJob is the same in-flight signal the grade/plan pumps already trust.
  if (runs.hasActiveJob(t.id, "ticket:"))
    throw new Error(`${t.key} already has a build in progress`);

  // Dependency gate: don't build while an upstream `blocks` ticket is still open.
  const blockers = ticketLinks.blockersOpen(id);
  if (blockers.length)
    throw new Error(`blocked by ${blockers.map((b) => b.key).join(", ")} — resolve upstream first`);

  // Operator picked a backend/model at dispatch time → persist as the ticket's standing override
  // (also drives display + future CI-fix/redispatch), then dispatch with it. undefined = leave as-is;
  // "" (empty) = clear the override back to workspace default / complexity auto-route.
  if (opts) {
    const patch: Partial<Ticket> = {};
    if (opts.backend !== undefined) patch.backend = opts.backend || null;
    if (opts.model !== undefined) patch.model = opts.model || null;
    if (Object.keys(patch).length) {
      Object.assign(t, patch);
      updateTicket(t.id, patch);
    }
  }

  // Auto-route backend/model from the plan-graded difficulty (per-ws route_config or global fallback).
  // Explicit ticket backend/model still wins (routeAgent returns {} when a model is pinned).
  const routed = routeAgent(t, ws);
  // Headless dispatch only. A non-headless backend (grok) has no JSONL mode — buildArgs() throws
  // async and would strand the ticket at in_progress. Fail loud, up front, before any status flip.
  const resolvedBackend = t.backend ?? routed.backend ?? ws.default_backend;
  if (getBackend(resolvedBackend).supportsHeadless === false)
    throw new Error(`${resolvedBackend} has no headless build mode — open an interactive terminal instead`);
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  // Repo is optional. Workspace = the access boundary: the agent may work across ANY repo in the
  // workspace. cwd = the ticket's repo if set, else the first workspace repo, else home. Every
  // workspace repo is granted (OS sandbox + claude --add-dir) via the job's add_dirs.
  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  let cwd = repo?.path && fs.existsSync(repo.path) ? repo.path : (wsRepos[0]?.path ?? os.homedir());

  // Every build on a git repo runs in its own per-ticket worktree off fresh origin/<default>,
  // regardless of delivery mode — two builds (or a build and an open terminal) on the same repo must
  // never share one working tree. If a worktree can't be created for a repo that IS a git repo, FAIL
  // LOUDLY rather than building in the shared checkout: an in-place build there sweeps unrelated
  // uncommitted work (a human's edits, another ticket's WIP) onto the branch via `git add -A`, and a
  // branch switch by the other session silently discards this one's edits. Non-git repo dirs have no
  // tree to share, so they keep building in place.
  if (repo?.path && (await isGitRepo(repo.path))) {
    const wt = await ensureTicketWorktree(repo, t.key);
    if (!wt)
      throw new Error(
        `could not create an isolated worktree for ${t.key} in ${repo.path} — refusing to build in the shared checkout (would risk committing unrelated changes onto ${repo.default_branch})`,
      );
    cwd = wt;
  }
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== cwd);

  const ticketRef = repo && cwd === repo.path ? path.relative(repo.path, t.file_path) : t.file_path;
  const scope = repo
    ? `in repo "${repo.name}"`
    : wsRepos.length
      ? `in workspace "${ws.name}" — you may work across any of its repos: ${wsRepos.map((r) => r.name).join(", ")}`
      : `in workspace "${ws.name}" (no repos attached)`;
  const hasPlan = /##\s*Plan\b/i.test(getBody(t));
  // Ticket titles may originate from an external tracker (ClickUp/Jira sync) — guard at the point
  // they're embedded into the goal. Rework notes are NOT guarded here; see the comment on reworkNote.
  const title = guard(t.title, `ticket ${t.key} title`, ws.id);
  // Rework: if reviewers requested changes, lead with their notes — EVERY round, not just the last.
  // Feeding only the latest verdict made PER-3 oscillate: each rework satisfied the newest reviewer
  // by re-breaking what an earlier round demanded, because the builder never saw both constraints.
  //
  // Do NOT guard() these notes. They are Chronos control-plane instructions (human / ai:reviewer /
  // ai:gate → builder), not untrusted payload. Guarding them self-DoSes tickets about the guard
  // itself: a reviewer citing "ignore the system prompt" as a required match gets
  // ⟦BLOCKED:prompt-injection⟧, and the builder cannot see which string must match (PER-3, 3
  // oscillation rounds). That is not contradictory with still guarding untrusted surfaces —
  // external tracker text (writeExternalSection / connectors), titles, memos, skills, lessons —
  // because those are foreign or standing context, not a reviewer telling the builder what to fix.
  // Diff content is never pasted into this block; the builder reads the repo. A reviewer quoting a
  // poisoned span is a compromised-reviewer problem, not an untrusted-ingestion one.
  const allChanges = reviews.byTicket(t.id).filter((r) => r.state === "changes_requested" && r.notes?.trim()).reverse(); // oldest → newest
  const reworkNote = allChanges.length
    ? `REWORK — a reviewer requested changes on the previous build. Notes from every review round follow, oldest first. ` +
      `Your fix must satisfy ALL rounds at once — do NOT resolve the latest by re-breaking an earlier one. ` +
      `If two rounds genuinely conflict, pick the safer behavior and say so explicitly in your handoff instead of flip-flopping:\n` +
      allChanges
        .map((r, i) => `— round ${i + 1}${i === allChanges.length - 1 ? " (most recent)" : ""} —\n${r.notes!}`)
        .join("\n") +
      `\n\n`
    : "";
  // Per-repo definition of done (checklist + evidence gates). Also see createForRun → human review.
  const doneBlock = formatDoneCriteria(repo);
  const attachBlock = formatAttachmentsBlock(t.id);
  // Rules learned from previous corrections in this repo. Ranked against this ticket's own text, so
  // the agent hears the migrations rule when it's about to touch migrations — not all of them, always.
  const lessonBlock = lessonsBlock(ws.id, {
    repo_id: t.repo_id,
    topic: "build",
    text: `${t.title} ${getBody(t).slice(0, 2000)}`,
  });
  // If this build runs in an isolated worktree (cwd differs from the repo's main checkout), tell the
  // agent plainly to keep all edits + commits here. The sandbox denies the main checkout regardless,
  // but saying so avoids wasted turns where the agent tries an absolute main-checkout path and is blocked.
  const worktreeNote =
    repo?.path && cwd !== repo.path
      ? `\nIMPORTANT: you are in an ISOLATED git worktree at ${cwd} (branch ${ticketBranch(t.key)}). Make ALL file edits and git commits HERE, in this working directory. Do NOT cd into or edit ${repo.path} (the shared main checkout) — it is sandbox-denied and writing there would collide with other builds.\n`
      : "";
  const goal =
    reworkNote +
    `You are working ticket ${t.key} ${scope}.\n` +
    worktreeNote +
    `Read the ticket file at ${ticketRef} for full context and acceptance criteria.\n` +
    (hasPlan ? `This ticket has a "## Plan" section — a context brief from a read-only scout (relevant files, references, gotchas). Use it to start fast, but verify against reality and decide the approach yourself.\n` : "") +
    `\nTITLE: ${title}\n\n` +
    stalenessGoal("build", t.key) +
    capabilitiesGoal(ws.capabilities) +
    `PROGRESS PROTOCOL (required): after reading the ticket, declare your plan as steps: \`mc steps declare "step one" "step two" ...\` (3-8 steps, concrete milestones — not "investigate"). As you work: \`mc step start <n>\` when you begin one, \`mc step done <n> "one-line evidence"\` when it's met, \`mc step skip <n> "why"\` if it becomes unnecessary. This is how the operator supervises the fleet — a run with no step updates looks stalled and may be killed.\n\n` +
    `NEED A HUMAN DECISION? Never guess on ambiguous scope, destructive choices, or conflicting requirements — ask: \`mc ask "your question" --options "a,b"\` . It notifies the operator and waits ~5 min. If the wait times out, follow the CLI's parking instructions (commit WIP, mc note, exit cleanly) — you will be resumed automatically with the answer. Ask sparingly: one good question with options beats three vague ones.\n\n` +
    `Operator messages may arrive in the output of your \`mc step\`/\`mc note\` calls (marked 📨) — they are directives; incorporate them before continuing.\n\n` +
    `Do the work. When done:\n` +
    `1. Append a timestamped entry under the "## Work log" section of ${ticketRef} describing what you changed.\n` +
    `2. Do NOT edit the frontmatter status — the system manages it.\n` +
    `3. Satisfy the repo Definition of Done below (run the checks yourself; a hard verify command may also run after you exit).\n` +
    `4. You cannot mark the ticket done yourself — it goes to human/AI review first.\n` +
    `5. If screenshots/attachments are listed below, inspect them (Read tool / vision) when they show UI or expected behavior.\n` +
    `6. Finish by filing a structured handoff for the reviewer — it becomes the review card AND the PR description, so make it complete:\n` +
    `   Pipe this exact markdown to \`mc review --report -\` (heredoc), filling every section:\n` +
    `   \`\`\`\n` +
    `   ## Summary\n   <1-3 sentences: what changed & why>\n\n` +
    `   ## Changes\n   - \`path/file\` — what changed here, and why\n\n` +
    `   ## Acceptance criteria\n   - [x] <criterion> — met by <file:line / how>\n   - [ ] <criterion> — partial/deferred, because …\n\n` +
    `   ## Testing\n   - <commands you ran + result; tests added; manual steps>\n\n` +
    `   ## Risks\n   - <blast radius, migrations, perf/security-sensitive touches — where to look hardest>\n\n` +
    `   ## Out of scope / follow-ups\n   - <what you deliberately did NOT do; link any follow-up tickets you filed>\n` +
    `   \`\`\`\n` +
    `   Base every claim on what you actually did — the reviewer checks it against the diff. \`mc review --report -\` also moves the ticket to review.\n` +
    doneBlock +
    lessonBlock +
    attachBlock +
    `Backlog tools (run in shell): \`mc note "<progress>"\` logs to this ticket; \`mc ticket new --title "..."\` files a follow-up/sub-task; \`mc ticket list\` shows the backlog.\n` +
    // PER-27: already-shipped is handled by the FIRST check (dismiss with evidence). This line is the
    // residual cases — out of scope, product call, wrong problem — where a human must drop the work.
    `If this ticket turns out to be out of scope or obsolete for a reason that is not "already shipped" (see FIRST above), say so with \`mc note\` and stop — do NOT \`mc dismiss\` or delete it yourself; dropping work is the operator's call. Already-shipped → dismiss with evidence as directed at the top.\n` +
    `\`mc learn "<durable fact>"\` records a lasting learning about this repo/company/operator (conventions, gotchas, preferences) — use it when you discover one.\n` +
    `Stay within this workspace; you have no access to other workspaces or their repos.` +
    ancestryGoal(ws, t.id) +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const job = jobs.create({
    name: `ticket:${t.key}`,
    description: title,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: resolvedBackend,
    // Explicit ticket.model wins → else auto-route from the plan-graded difficulty → else ws default.
    model: t.model ?? routed.model ?? ws.default_model ?? undefined,
    cwd,
    add_dirs: addDirs.length ? addDirs : null, // sibling repos in this workspace (jobs.create JSON-encodes); OS sandbox + --add-dir
    sandbox: ws.sandbox_mode,
    // ponytail: no auto-retry on ticket builds. Retries shared the single mc/<key> worktree with the
    // run they replaced — two agents on one branch, duplicated work, spend burned on dead runs. A
    // failed build blocks the ticket; the operator redispatches when they've decided why it failed.
    trigger_type: "manual",
  });

  updateTicket(t.id, { status: "in_progress" });
  const r = dispatch(job.id, `ticket:${t.key}`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

// CI failed on an open PR → spawn a terminal on that PR's branch to diagnose from the GitHub logs and
// push a fix. Same worktree/branch the build used, so the push updates the existing PR (no new PR).
// Called by the delivery poll (auto) — keep it side-effect-light: it must not flip the ticket status.
async function dispatchCiFixRaw(id: string): Promise<{ job_id: string; run_id?: string; status?: string }> {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  if (!repo?.path || !fs.existsSync(repo.path)) throw new Error("ticket has no repo path");
  if (!t.pr_url) throw new Error("ticket has no PR");

  // Reuse the ticket's PR branch in an isolated worktree. If one can't be made, FAIL LOUDLY rather
  // than checking the branch out in the shared main tree (git add -A there sweeps unrelated work).
  const branch = ticketBranch(t.key);
  const wt = await ensureTicketWorktree(repo, t.key);
  if (!wt)
    throw new Error(
      `could not create an isolated worktree for ${t.key} — refusing to build in the shared checkout`,
    );
  const cwd = wt;

  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== cwd);
  const routed = routeAgent(t, ws);

  const goal =
    `CI is failing on the open PR for ticket ${t.key} in repo "${repo.name}". Fix it.\n` +
    `PR: ${t.pr_url}\n` +
    `You are on the PR's branch "${branch}". Steps:\n` +
    `1. \`git pull --rebase\` to get the latest branch state.\n` +
    `2. Inspect the failure: \`gh pr checks ${t.pr_url}\` lists the checks; \`gh run view --log-failed\` (or the failing run's URL) shows why. Read the actual error, don't guess.\n` +
    `3. Fix the root cause in the code. Run the repo's checks locally to confirm green before pushing.\n` +
    `4. Commit and \`git push\` to the SAME branch — do NOT open a new PR; the push re-triggers CI on the existing one.\n` +
    `5. Append a timestamped note under "## Work log" of the ticket file describing the fix.\n` +
    `Do not edit the frontmatter status. Stay within this workspace.` +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const job = jobs.create({
    name: `ci-fix:${t.key}`,
    description: `Fix failing CI — ${t.title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: t.backend ?? routed.backend ?? ws.default_backend,
    model: t.model ?? routed.model ?? ws.default_model ?? undefined,
    cwd,
    add_dirs: addDirs.length ? addDirs : null,
    sandbox: ws.sandbox_mode,
    trigger_type: "manual",
  });

  const r = dispatch(job.id, `ci-fix:${t.key}`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

// Merge gate: an agent reviews the OPEN PR — not the worktree diff the review panel saw — decides
// whether it should land, fixes small gaps itself, and ends with a machine-readable verdict that
// merge-gate.ts acts on. It deliberately does NOT run `gh pr merge`: chronos owns the merge so the
// action is auditable (ticket note + notification) and so a confused agent cannot land code by
// improvising a shell command. The last line of its output is the whole contract.
//
// What it can see that the pre-PR review could not: CI results, whether main moved underneath the
// branch, merge conflicts, and the diff as GitHub actually renders it.
async function dispatchMergeGateRaw(id: string): Promise<{ job_id: string; run_id?: string; status?: string }> {
  const t = store.get(id);
  if (!t) throw new Error("ticket not found");
  const ws = workspaces.get(t.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  if (!repo?.path || !fs.existsSync(repo.path)) throw new Error("ticket has no repo path");
  if (!t.pr_url) throw new Error("ticket has no PR");
  if (runs.hasActiveJob(t.id, "merge-gate:")) throw new Error(`${t.key} already has a merge gate running`);

  // Same rule as the CI fix: never work in the shared checkout — the daemon's `git add -A` there
  // would sweep unrelated changes into this ticket's commit.
  const branch = ticketBranch(t.key);
  const wt = await ensureTicketWorktree(repo, t.key);
  if (!wt)
    throw new Error(
      `could not create an isolated worktree for ${t.key} — refusing to run the merge gate in the shared checkout`,
    );

  const wsRepos = repos.list(ws.id).filter((r) => r.path && fs.existsSync(r.path));
  const addDirs = wsRepos.map((r) => r.path).filter((p) => p !== wt);
  const gates = parseGates(repo);
  const gateHint = gates.length
    ? `This repo declares its own checks — run them and treat a failure as blocking:\n` +
      gates.map((g) => `  - ${g.name}: \`${g.cmd}\``).join("\n") + "\n"
    : `This repo declares no gate commands. If it has a test/build command of its own, run it.\n`;

  const goal =
    `MERGE GATE for ticket ${t.key} in repo "${repo.name}". You are the last check before this lands on ` +
    `${repo.default_branch}.\n` +
    `PR: ${t.pr_url}\nBranch: ${branch} (already checked out here)\n\n` +
    `A review panel already approved the diff BEFORE the PR existed. Do not repeat its work — look at what it ` +
    `could not see:\n` +
    `1. \`git pull --rebase\` — then check whether ${repo.default_branch} moved underneath this branch and whether ` +
    `the change still makes sense against it. Report conflicts rather than forcing past them.\n` +
    `2. \`gh pr checks ${t.pr_url}\` — if any check is red, that is blocking.\n` +
    `3. \`gh pr diff ${t.pr_url}\` — read the final diff. Does it do what ${t.key} asked, and nothing else? ` +
    `Watch for debug leftovers, absolute paths from this machine, secrets, and files that should not be committed.\n` +
    `${gateHint}` +
    `\nIf you find a SMALL, in-scope problem (a typo, a stale line, a leftover, a one-line fix), fix it: commit and ` +
    `\`git push\` to this same branch — never open a new PR. If the problem is substantive — the approach is wrong, ` +
    `the ticket is not actually satisfied, the change is riskier than it looked, or the fix would need judgement that ` +
    `is the human's to make — do NOT fix it. Hold and explain.\n\n` +
    `Do NOT run \`gh pr merge\`. Chronos performs the merge when you approve.\n\n` +
    `Finish with your verdict as the LAST line, exactly one of:\n` +
    `MERGE-GATE: APPROVE — <one line on what you verified>\n` +
    `MERGE-GATE: HOLD — <one line on what a human must decide>\n` +
    `If you pushed a fix, still emit a verdict: APPROVE only if you are confident the pushed state is correct.` +
    relevanceGoal(ws, t.title, t.tags, t.key);

  const job = jobs.create({
    name: `merge-gate:${t.key}`,
    description: `Merge gate — ${t.title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: ws.review_backend ?? ws.default_backend,
    model: ws.review_model ?? CONFIG.mergeGateModel,
    cwd: wt,
    add_dirs: addDirs.length ? addDirs : null,
    sandbox: ws.sandbox_mode,
    trigger_type: "manual",
  });

  const r = dispatch(job.id, `merge-gate:${t.key}`);
  if ("error" in r) return { job_id: job.id, status: `error: ${r.error}` };
  return { job_id: job.id, run_id: r.run_id, status: r.status };
}

export const dispatchMergeGate = traceDispatch("merge gate", dispatchMergeGateRaw);
