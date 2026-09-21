/**
 * What an agent's always-injected memory costs, and what it is allowed to cost.
 *
 * Persona memory rides in every turn of every session, so its size is a standing tax rather than a
 * one-off. A budget is what turns "the file got big" into a decision the stow pass (src/stow.ts) can
 * actually make: without one, decay alone would never bound growth — new facts arrive faster than old
 * ones expire.
 *
 * Two files are measured, mirroring who owns them: the agent's own `memory-<agent>.md` (editable by
 * the pass) and the operator's scope='global' profile notes, which are injected into every agent by
 * design and are counted but NEVER edited here — they are the operator's, not the agent's. The cold
 * archive is deliberately absent: it is never injected, so it is never costed.
 */
import { Buffer } from "node:buffer";
import { CONFIG } from "./config.js";
import { notes as store, workspaces } from "./store.js";
import { agentMemoryNote, MEM_WS_SLUG } from "./agent-memory.js";
import { loadAgents } from "./agent-defs.js";

/**
 * Estimated tokens for a piece of prompt text: ceil(UTF-8 bytes / 3).
 *
 * The same estimator firstmate uses, and deliberately not a tokenizer: it must be stable across
 * machines and dependency-free, because a budget that moves when a library updates is not a budget.
 * ~chars/4 is the real ratio for English prose, so /3 is the conservative fudge — it over-counts
 * rather than letting a file quietly exceed its allowance.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export interface FileTokens {
  path: string;
  tokens: number;
  /** False for the operator-owned profile: counted against the budget, never touched by the pass. */
  editable: boolean;
}

export interface BudgetReport {
  agent: string;
  budget: number;
  files: FileTokens[];
  total: number;
  /** Tokens above the budget, 0 when within it. */
  over: number;
}

/**
 * This agent's budget: `memory_budget` in its AGENT.md frontmatter, else CONFIG.memoryBudgetTokens.
 * Looked up by memory key (AgentDef.memory) first, because that key — not the directory id — is what
 * names the file the budget is about.
 */
export function agentBudget(agent: string): number {
  try {
    for (const def of loadAgents().values()) {
      if (def.memory !== agent && def.id !== agent) continue;
      if (def.memoryBudget != null) return def.memoryBudget;
    }
  } catch {
    // A malformed agents/ tree must not make the budget unreadable: the default is still a budget.
  }
  return CONFIG.memoryBudgetTokens;
}

/** Every file that lands in this agent's prompt on every turn, with what each one costs. */
export function memoryFiles(agent: string): Array<FileTokens & { body: string }> {
  const out: Array<FileTokens & { body: string }> = [];
  const mem = agentMemoryNote(agent, false);
  if (mem) out.push({ path: mem.file_path, tokens: estimateTokens(mem.body), editable: true, body: mem.body });
  const ws = workspaces.getBySlug(MEM_WS_SLUG);
  if (ws) {
    for (const g of store.globalContextNotes())
      out.push({ path: g.file_path, tokens: estimateTokens(g.body), editable: false, body: g.body });
  }
  return out;
}

export function report(agent: string): BudgetReport {
  const budget = agentBudget(agent);
  const files = memoryFiles(agent).map(({ path, tokens, editable }) => ({ path, tokens, editable }));
  const total = files.reduce((n, f) => n + f.tokens, 0);
  return { agent, budget, files, total, over: Math.max(0, total - budget) };
}
