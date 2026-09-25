// Handing a booting CLI its first prompt is not a `write()` — it's a small negotiation, and getting it
// wrong is silent: the card comes up, the goal is on it, and the agent never starts.
//
// Three failures, all seen on the wall:
//   · Type too early and the keystrokes land on a splash screen that is still repainting, so half the
//     prompt is eaten and what survives can trip a slash command.
//   · Send the text and its Enter in one write and a TUI in bracketed-paste mode reads the trailing
//     \r as a newline INSIDE the paste — the prompt sits there, full and unsent, forever.
//   · Silence is not readiness. A Lead opened 7 claude workers in 3s (2026-09-25); on the loaded
//     machine two went quiet mid-boot, got typed at, and kept only the TAIL of the seed (≈ full −
//     1024 bytes). The tty was still in cooked mode, which holds 1024 bytes (MAX_INPUT) and drops
//     them when the CLI switches to raw — the input box never saw the start of its task.
// So: wait until the CLI says its input is up (it turns bracketed paste on, DEC 2004, when the box
// mounts), and for the boot chatter to stop — with a floor, and a ceiling for a CLI that never
// settles — hand the prompt over as ONE paste, then press Enter by itself.
// Shared by the brain (terminal.ts) and a host (hostd/terminals.ts): one negotiation, typed next to its pty.
import type { ModeTracker } from "./term-modes.js";

export const SEED_MIN_MS = 2500;    // never before this: no CLI is ready sooner
export const SEED_QUIET_MS = 1200;  // "the splash screen stopped moving"
export const SEED_MAX_MS = 20000;   // a CLI that keeps painting (spinner) still gets its prompt
export const SEED_ENTER_MS = 250;   // Enter as its own keystroke, after the paste has landed

/**
 * CLIs measured to turn bracketed paste on the moment their input box mounts (claude 2.x ≈2.4s on an
 * idle Mac, grok ≈0.9s). Their seed waits for it. The rest (cursor-agent, codex: not seen to announce
 * one before their input) keep the silence heuristic alone — waiting on a signal that never comes
 * would hold every seed to the ceiling.
 */
const ANNOUNCES_INPUT = new Set(["claude-code", "grok"]);
export function seedWaitsForInput(backend: string): boolean {
  return ANNOUNCES_INPUT.has(backend);
}

/**
 * How long after the paste the Enter goes. cursor-agent folds a pasted seed into a "[Pasted text #1]"
 * chip and swallows a key that arrives while it is still doing that: at 250ms the seed sat in its
 * prompt unsent (m2, 2026-09-24 — one more Enter by hand and the run went through). claude and grok
 * submit fine at 250ms, so only cursor waits longer.
 */
export function seedEnterMsFor(backend: string): number {
  return backend === "cursor-agent" || backend === "cursor" ? 1200 : SEED_ENTER_MS;
}

/**
 * Text as the TUI should read it. In bracketed-paste mode it goes between the paste markers, so the
 * CLI takes it as one paste on purpose instead of guessing from how fast the bytes came.
 */
export function pasteOf(text: string, bracketed: boolean): string {
  return bracketed ? `\x1b[200~${text}\x1b[201~` : text;
}

export interface SeedTarget {
  write(data: string): void;
  /** When the pty last produced output. */
  lastOut(): number;
  modes: ModeTracker;
  /** The terminal is gone (exited, or replaced under the same id): stop waiting. */
  gone?(): boolean;
}

export function typeSeed(
  t: SeedTarget,
  seed: string,
  backend: string,
  o: { enterMs?: number; minMs?: number; quietMs?: number; maxMs?: number; tickMs?: number } = {},
): void {
  const { enterMs = seedEnterMsFor(backend), minMs = SEED_MIN_MS, quietMs = SEED_QUIET_MS, maxMs = SEED_MAX_MS, tickMs = 250 } = o;
  const waitInput = seedWaitsForInput(backend);
  const started = Date.now();
  const line = seed.replace(/\r?\n/g, " ");
  const tick = setInterval(() => {
    if (t.gone?.()) return void clearInterval(tick);
    const waited = Date.now() - started;
    if (waited < minMs) return;
    const ready = (!waitInput || t.modes.isOn(2004)) && Date.now() - t.lastOut() >= quietMs;
    if (!ready && waited < maxMs) return;
    clearInterval(tick);
    try {
      t.write(pasteOf(line, t.modes.isOn(2004)));
      setTimeout(() => { try { if (!t.gone?.()) t.write("\r"); } catch {} }, enterMs).unref?.();
    } catch {
      // pty died while we waited — the session already ended, nothing to seed
    }
  }, tickMs);
  tick.unref?.();
}
