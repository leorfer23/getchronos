/**
 * Persona memory — one durable markdown file per named agent, always in its prompt.
 *
 * Robert is a long-lived person, not a one-shot worker, but his warm process only ever knew its
 * static system prompt: everything the operator told it died with the session. Workspace agents
 * already had this (notes flagged ★context, injected by agentContext) — the personas were the ones
 * with no vault at all.
 *
 * A persona memory is just a note: same table, same <repo>/notes/<ws>/<slug>.md file on disk,
 * same FTS index, same read-time guard. What's different is who owns it. It is NOT ★context —
 * flagging it would leak every persona's memory into every workspace agent's prompt. It loads for
 * exactly one agent, by name, plus the scope='global' operator profile that everyone gets.
 *
 * Writes go through the agent itself (POST /api/agents/:name/memory) so recording a fact is one
 * curl mid-conversation, not a thing the operator has to do for them.
 */
import { workspaces, notes as store } from "./store.js";
import { createNote, appendNote, updateNote, globalProfileBlock, renderNotes } from "./notes.js";
import type { Note } from "./types.js";

// Persona memories live in the `personal` workspace: these agents serve the operator, not a client.
// Their files land in <repo>/notes/personal/memory-<agent>.md.
export const MEM_WS_SLUG = "personal";
const MEM_CAP = 6000; // prompt budget for one persona's memory, on top of the global profile

/**
 * Agents that get a memory file. Anything not on this list is rejected by the API. Add an id here
 * when you add an `agents/<id>/` directory that should remember things between sessions.
 *
 * Taking an id OFF this list does not delete anything: a persona memory is an ordinary note, so
 * `notes/personal/memory-<agent>.md` stays on disk, stays a row in the notes store, stays in the
 * FTS index, and stays readable through GET /api/notes and GET /api/search. Only the
 * /api/agents/:name/memory route stops answering for it — which is the point, since serving a
 * persona endpoint for an agent nobody runs would claim an owner that does not exist.
 */
export const MEMORY_AGENTS = ["robert"] as const;
export type MemoryAgent = (typeof MEMORY_AGENTS)[number];

export function isMemoryAgent(name: string): name is MemoryAgent {
  return (MEMORY_AGENTS as readonly string[]).includes(name);
}

// Title first, slug second: createNote kebabs the title, so the title has to kebab to exactly
// `memory-<agent>` or every lookup misses and we'd create a fresh note per turn.
const titleOf = (agent: string) => `Memory — ${agent}`;
const slugOf = (agent: string) => `memory-${agent}`;

const SEED = (agent: string) =>
  `# ${titleOf(agent)}\n\n` +
  `Durable facts ${agent} has learned about the operator, their people, their work and their preferences.\n` +
  `Append with POST /api/agents/${agent}/memory; rewrite with PUT to prune.\n\n` +
  `## Facts\n`;

/**
 * The agent's memory note, created on first use. Returns null if the personal workspace is missing
 * (fresh install) — callers degrade to no memory rather than throwing mid-turn.
 */
export function agentMemoryNote(agent: string, create = true): Note | null {
  const ws = workspaces.getBySlug(MEM_WS_SLUG);
  if (!ws) return null;
  const existing = store.bySlug(ws.id, slugOf(agent));
  if (existing || !create) return existing ?? null;
  return createNote({ workspace_id: ws.id, title: titleOf(agent), body: SEED(agent) });
}

/** Fingerprint for "has this memory changed since the warm process spawned". */
export function agentMemoryStamp(agent: string): string {
  return agentMemoryNote(agent, false)?.updated_at ?? "";
}

/** Append one durable fact. Guarding happens at read time, in agentMemoryBlock. */
export function rememberFact(agent: string, fact: string, heading?: string): Note {
  const n = agentMemoryNote(agent);
  if (!n) throw new Error(`no '${MEM_WS_SLUG}' workspace — cannot store agent memory`);
  return appendNote(n.id, fact.trim(), heading);
}

/** Replace the whole file — how an agent prunes, dedupes and reorganises its own memory. */
export function rewriteMemory(agent: string, body: string): Note {
  const n = agentMemoryNote(agent);
  if (!n) throw new Error(`no '${MEM_WS_SLUG}' workspace — cannot store agent memory`);
  return updateNote(n.id, { body });
}

/**
 * The block injected into a persona's system prompt: the shared operator profile plus that one
 * agent's own memory. Empty string when there is nothing yet, so callers can `.filter(Boolean)`.
 */
export function agentMemoryBlock(agent: string): string {
  const ws = workspaces.getBySlug(MEM_WS_SLUG);
  if (!ws) return "";
  const sections: string[] = [];
  const profile = globalProfileBlock(ws.id);
  if (profile) sections.push(profile);
  const mem = agentMemoryNote(agent, false);
  if (mem) {
    const { text } = renderNotes([mem], "agent-memory", MEM_CAP, ws.id);
    if (text) {
      sections.push(
        `Your memory — durable facts you recorded in past conversations. Treat as ground truth ` +
          `about the operator and act on it without being told again:${text}`,
      );
    }
  }
  return sections.join("\n\n");
}
