import { proseBlock } from "./prose.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { skills as store, workspaces, searchIndex } from "./store.js";
import { bus } from "./bus.js";
import { guard } from "./guard.js";
import { lessonsBlock } from "./lessons.js";
import { contextBlock } from "./notes.js";
import { memoryBlock } from "./recall.js";
import type { Skill, NewSkill, SkillStatus } from "./types.js";
import { inRepo } from "./repo-root.js";

// Procedural skills (Hermes-style closed learning loop): agents author SKILL.md from successful work
// and patch them on reuse; a per-workspace vault of reusable procedures. Progressive disclosure means
// only the L0 index (name + description) auto-loads into agent prompts — the full procedure is pulled
// on demand via `mc skill view`. File on disk is source of truth; the DB row is the index.

const home = os.homedir();
const VAULT = inRepo("skills-vault");
const L0_CAP = 3000; // token-ish budget for the auto-injected index ("assume it's all the model reads")

const kebab = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
const now = () => new Date().toISOString();

function skillDir(wsSlug: string, slug: string): string { return path.join(VAULT, wsSlug, slug); }
function skillFile(wsSlug: string, slug: string): string { return path.join(skillDir(wsSlug, slug), "SKILL.md"); }

interface SkillMeta { name: string; description: string; category?: string | null; tags?: string[]; version: number; }

function renderSkillMd(meta: SkillMeta, body: string): string {
  const fm = [`name: ${meta.name}`, `description: ${meta.description.replace(/\n/g, " ")}`];
  if (meta.category) fm.push(`category: ${meta.category}`);
  if (meta.tags && meta.tags.length) fm.push(`tags: [${meta.tags.join(", ")}]`);
  fm.push(`version: ${meta.version}`);
  return `---\n${fm.join("\n")}\n---\n\n${body.trim()}\n`;
}

// Parse a SKILL.md back into frontmatter fields + body.
export function parseSkillMd(raw: string): { meta: Partial<SkillMeta>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: any = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^(\w+):\s*(.*)$/);
    if (!mm) continue;
    const k = mm[1]; let v = mm[2].trim();
    if (k === "tags") meta.tags = v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "version") meta.version = Number(v) || 1;
    else meta[k] = v;
  }
  return { meta, body: (m[2] || "").trim() };
}

// Default skeleton so an agent's `mc skill new` without a body still yields the right section shape.
const TEMPLATE = `## When to use\n(plain-language triggers — when should an agent reach for this?)\n\n## Quick reference\n(key commands, paths, env, values)\n\n## Procedure\n1. (ordered steps — don't improvise these away)\n\n## Pitfalls\n- (known failure modes / silent failures)\n\n## Verification\n- (what "green" looks like — how to confirm success)\n`;

function ensureUniqueSlug(wsId: string, base: string): string {
  let slug = base, i = 2;
  while (store.bySlug(wsId, slug)) slug = `${base}-${i++}`;
  return slug;
}

function indexSkill(s: Skill, body: string) {
  searchIndex.removeRef(s.id);
  searchIndex.add({ kind: "skill", ref_id: s.id, workspace: s.workspace_id, title: s.name, body: `${s.description} ${body}`.slice(0, 4000) });
}

// Create a new skill. Lands `pending` unless the workspace trusts agents (auto_skill) or a status is forced.
export function createSkill(input: NewSkill): Skill {
  const ws = workspaces.get(input.workspace_id);
  if (!ws) throw new Error("workspace not found");
  const name = input.name.trim();
  if (!name) throw new Error("skill needs a name");
  const slug = ensureUniqueSlug(ws.id, kebab(name));
  const description = guard((input.description ?? "").trim() || name, `skill ${slug} desc`, ws.id);
  const body = guard((input.body ?? TEMPLATE).trim(), `skill ${slug}`, ws.id);
  const status: SkillStatus = input.status ?? (ws.auto_skill ? "active" : "pending");
  const tags = input.tags ?? [];
  const file = skillFile(ws.slug, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderSkillMd({ name, description, category: input.category, tags, version: 1 }, body), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  const row: Skill = {
    id: randomUUID(), workspace_id: ws.id, slug, name, description,
    category: input.category ?? null, tags: tags.length ? JSON.stringify(tags) : null,
    status, version: 1, usage_count: 0, last_used_at: null, file_path: file,
    source: input.source ?? "agent", created_at: now(), updated_at: now(),
  };
  store.insert(row);
  indexSkill(row, body);
  // Telegram push (actionable approve/reject) is emitted by the bus listener on skill.created.
  bus.publish({ topic: "skill.created", skill_id: row.id, workspace_id: ws.id, status });
  return row;
}

// Read the markdown body of a skill (L1 content).
export function skillBody(s: Skill): string {
  try { return parseSkillMd(fs.readFileSync(s.file_path, "utf8")).body; } catch { return ""; }
}

// Read a supporting reference file under the skill dir (L2). Path is confined to the skill's own dir.
export function skillRef(s: Skill, rel: string): string | null {
  const dir = path.dirname(s.file_path);
  const target = path.resolve(dir, rel);
  if (!target.startsWith(dir + path.sep)) return null; // no escaping the skill dir
  try { return fs.readFileSync(target, "utf8"); } catch { return null; }
}

// Persist a new body for a skill (used by patch/append). Re-guards, bumps version, and — unless the
// workspace auto-publishes — sends the skill back to `pending` so a human re-reviews the change.
function rewriteBody(s: Skill, newBody: string, label: string): Skill {
  const ws = workspaces.get(s.workspace_id);
  const safe = guard(newBody.trim(), `skill ${s.slug} (${label})`, s.workspace_id);
  const tags = s.tags ? (JSON.parse(s.tags) as string[]) : [];
  fs.writeFileSync(s.file_path, renderSkillMd({ name: s.name, description: s.description, category: s.category, tags, version: s.version + 1 }, safe), { mode: 0o600 });
  try { fs.chmodSync(s.file_path, 0o600); } catch {}
  const status: SkillStatus = s.status === "archived" ? "archived" : ws?.auto_skill ? "active" : "pending";
  const updated = store.update(s.id, { version: s.version + 1, status, updated_at: now() })!;
  indexSkill(updated, safe);
  bus.publish({ topic: "skill.updated", skill_id: s.id, workspace_id: s.workspace_id, status });
  return updated;
}

export function patchSkill(id: string, oldStr: string, newStr: string): Skill {
  const s = store.get(id); if (!s) throw new Error("skill not found");
  const body = skillBody(s);
  if (!body.includes(oldStr)) throw new Error("old_string not found in skill body");
  return rewriteBody(s, body.replace(oldStr, newStr), "patch");
}

export function appendSkill(id: string, text: string, heading?: string): Skill {
  const s = store.get(id); if (!s) throw new Error("skill not found");
  const body = skillBody(s);
  const block = (heading ? `\n\n## ${heading}\n` : "\n\n") + text.trim();
  return rewriteBody(s, body.replace(/\n*$/, "") + block, "append");
}

export function setSkillStatus(id: string, status: SkillStatus): Skill {
  const s = store.get(id); if (!s) throw new Error("skill not found");
  const updated = store.update(id, { status, updated_at: now() })!;
  bus.publish({ topic: "skill.updated", skill_id: id, workspace_id: s.workspace_id, status });
  return updated;
}

export function removeSkill(id: string): void {
  const s = store.get(id); if (!s) return;
  try { fs.rmSync(path.dirname(s.file_path), { recursive: true, force: true }); } catch {}
  searchIndex.removeRef(id);
  store.remove(id);
  bus.publish({ topic: "skill.updated", skill_id: id, workspace_id: s.workspace_id, status: "archived" });
}

export function useSkill(id: string): void { store.bumpUsage(id); }

// L0 progressive-disclosure index: only the active skills' name/description/category for a workspace,
// bounded so it never blows the prompt. Guarded (defense-in-depth) before it joins the system prompt.
export function skillIndexBlock(workspace_id: string): string {
  const active = store.active(workspace_id);
  if (!active.length) return "";
  let lines = "", used = 0;
  for (const s of active) {
    const line = `\n- ${s.slug}${s.category ? ` (${s.category})` : ""}: ${s.description}`;
    if (used + line.length > L0_CAP) { lines += `\n- …(${active.length} skills total; list with \`mc skill list\`)`; break; }
    lines += line; used += line.length;
  }
  const block = `Workspace skills — reusable procedures agents have built here. Before doing one of these tasks, run \`mc skill view <name>\` for the full procedure:${lines}`;
  return guard(block, "skill-index", workspace_id);
}

// The full standing context injected into every agent's system prompt for a workspace:
// operator-curated notes (contextBlock) + the L0 skill index + the comms rules this workspace has
// learned from the operator's own corrections. All guarded internally.
//
// Only `comms` lessons ride here — how to report, what he wants in the first line, what he doesn't
// want at all — because they apply to every agent that ever writes to him. Build and review rules
// are injected at dispatch, where the ticket's own text can rank them.
export function agentContext(workspace_id: string, repo_id?: string | null): string {
  return [
    contextBlock(workspace_id, repo_id),
    memoryBlock(workspace_id),
    skillIndexBlock(workspace_id),
    proseBlock(workspace_id),
    lessonsBlock(workspace_id, {
      repo_id,
      topic: "comms",
      limit: 5,
      heading: "How this operator wants to be talked to (learned from his corrections):",
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
