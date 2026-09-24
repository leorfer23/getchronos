/**
 * The CLIs a host can run, by the canonical name a SpawnSpec carries. Not `backends/index.ts`: that
 * registry also loads cursor-cloud, which reads workspace vars from the store — and a host must never
 * open a Chronos database. Every entry here is a local-process backend with no store dependency.
 */
import { claudeBackend } from "../backends/claude.js";
import { cursorBackend } from "../backends/cursor.js";
import { codexBackend } from "../backends/codex.js";
import { grokBackend } from "../backends/grok.js";
import { opencodeBackend } from "../backends/opencode.js";
import { mockBackend } from "../backends/mock.js";
import type { HostBackend } from "./terminals.js";

export function hostBackends(): Record<string, HostBackend> {
  const out: Record<string, HostBackend> = {};
  for (const b of [claudeBackend, cursorBackend, codexBackend, grokBackend, opencodeBackend, mockBackend]) out[b.name] = b;
  return out;
}
