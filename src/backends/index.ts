import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBackend } from "./claude.js";
import { cursorBackend } from "./cursor.js";
import { codexBackend } from "./codex.js";
import { grokBackend } from "./grok.js";
import { opencodeBackend } from "./opencode.js";
import { openaiApiBackend } from "./openai-api.js";
import { mockBackend } from "./mock.js";
import type { AgentBackend } from "./types.js";

// Backend registry. Add a new harness (codex, gemini, …) = one module + one line here.
const REGISTRY: Record<string, AgentBackend> = {
  "claude-code": claudeBackend,
  claude: claudeBackend, // legacy alias
  "cursor-agent": cursorBackend,
  cursor: cursorBackend,
  codex: codexBackend,
  grok: grokBackend,
  "grok-cli": grokBackend, // alias
  opencode: opencodeBackend,
  "openai-api": openaiApiBackend,
  // Scripted stand-in (spawns `node -e`, zero tokens): drives the real execute() in tests and
  // lets an operator smoke-test the whole dispatch pipeline. See src/backends/mock.ts.
  mock: mockBackend,
};

export function getBackend(name: string | null | undefined): AgentBackend {
  return (name && REGISTRY[name]) || claudeBackend;
}

/** True when `name` is a registered backend (including aliases like `claude` / `cursor`). */
export function hasBackend(name: string | null | undefined): boolean {
  return !!(name && REGISTRY[name]);
}

// Models known to fail at spawn (gateway/provider withdrawn). Advisory `models` lists are NOT a
// closed allowlist — opencode accepts any provider/model — so we only reject known-dead strings.
// Without this, dispatching kimi-k3 produced a 1s exit with "Unexpected server error" and zero events.
const RETIRED_MODELS = new Set([
  "vercel/moonshotai/kimi-k3",
]);

/**
 * Pre-spawn check for a job's (backend, model). Returns an explicit error message, or null if ok.
 * Unknown backend names used to silently fall through to claude-code via getBackend().
 */
export function validateSpawnTarget(
  backend: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (backend && !hasBackend(backend)) return `unknown backend: ${backend}`;
  if (model && RETIRED_MODELS.has(model)) return `modelo desconocido (retirado): ${model}`;
  return null;
}

export function listBackends(): Array<{ name: string; models?: string[]; supportsResume: boolean; supportsHeadless: boolean }> {
  const seen = new Set<AgentBackend>();
  const out: Array<{ name: string; models?: string[]; supportsResume: boolean; supportsHeadless: boolean }> = [];
  for (const b of Object.values(REGISTRY)) {
    if (seen.has(b)) continue;
    seen.add(b);
    // Resolvable by name (tests, deliberate smoke jobs) but never advertised: in the UI picker or
    // as a fallback_backend it would fake a verified, reviewed success with zero work done.
    if (b === mockBackend) continue;
    out.push({ name: b.name, models: b.models, supportsResume: b.supportsResume, supportsHeadless: b.supportsHeadless !== false });
  }
  return out;
}

/**
 * Which backends a workspace may spawn, from `workspaces.backends`.
 *
 * Null / empty / unparseable → every registered backend, so a workspace nobody has restricted keeps
 * working exactly as before. Unknown names are dropped rather than trusted: a typo must narrow the
 * list to the ones that are real, never widen it or leave a name the spawner would resolve into
 * claude-code by accident.
 *
 * Returns names only — the caller decides whether it is answering "what may I offer" (the Desk
 * picker) or "may this spawn proceed" (backendAllowed).
 */
/**
 * The workspace's explicit allow-list, or null when it has none.
 *
 * Kept separate from the display list because the two answer different questions, and conflating
 * them refuses backends that are deliberately unadvertised: `listBackends()` hides `mock` on
 * purpose, so a gate built on it rejected every mock-backend dispatch — which is how the whole
 * test suite spawns.
 */
function explicitList(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const picked = list.filter((n): n is string => typeof n === "string" && hasBackend(n));
  return picked.length ? picked : null;
}

/**
 * What to OFFER this workspace in a picker: its allow-list, or every advertised backend.
 * Display-only — never the gate, or unadvertised-but-valid backends vanish.
 */
export function workspaceBackends(raw: string | null | undefined): string[] {
  const advertised = listBackends().map((b) => b.name);
  const explicit = explicitList(raw);
  return explicit ? explicit.filter((n) => advertised.includes(n)) : advertised;
}

/**
 * May this workspace spawn this backend? The gate at every spawn path.
 *
 * A workspace with NO allow-list allows anything — unknown names are already `validateSpawnTarget`'s
 * job, and failing closed here would strand a workspace whose column holds a typo. A workspace WITH
 * one is held to it exactly.
 */
export function backendAllowed(raw: string | null | undefined, backend: string | null | undefined): boolean {
  if (!backend) return true; // no explicit ask → the workspace's own default is used
  const explicit = explicitList(raw);
  return explicit ? explicit.includes(backend) : true;
}

export type { AgentBackend } from "./types.js";

/**
 * Is this backend's CLI actually on disk? A failover that opens a terminal on a binary that isn't
 * installed dies in a second with the work nowhere — so the chain skips it instead. Bare names are
 * looked up on the same PATH the pty inherits (~/.mc/bin + the daemon's), absolute ones checked as is.
 */
export function backendInstalled(name: string | null | undefined): boolean {
  if (!hasBackend(name)) return false;
  let bin: string;
  try { bin = getBackend(name).bin(); } catch { return false; }
  if (!bin) return false;
  const runnable = (p: string) => {
    try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
  };
  if (bin.includes("/")) return runnable(bin);
  const dirs = [path.join(os.homedir(), ".mc", "bin"), ...(process.env.PATH ?? "").split(path.delimiter)];
  return dirs.some((d) => !!d && runnable(path.join(d, bin)));
}
