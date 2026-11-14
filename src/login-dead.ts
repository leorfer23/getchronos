/**
 * A Claude login known to be dead, remembered from the last terminal that hit it.
 *
 * A login wall ("Not logged in · Please run /login", "Login reached its time limit") is not something
 * failover moves (terminal-failover.ts → detectLoginWall): neither another model nor waiting fixes it.
 * But nothing remembered it either, so the next agent terminal for the same workspace (Robert's, an
 * inbox auto-open) was spawned onto the same dead profile, painted the same wall, and had to be told to
 * stop. This is that memory:
 *
 *  - MARKED when a local claude terminal's settled frame shows a login wall (onTerminalQuiet). Cached
 *    state only: nothing here ever spawns a CLI or probes an account.
 *  - READ at spawn (openSession): a non-operator claude terminal for a marked profile goes to the
 *    failover chain instead (workspace.fallback_backend, then ⚙ Settings → Failover), or is refused
 *    when there is none. The operator is never rerouted: his own terminal is how he logs in again.
 *  - CLEARED by proof the login works: a claude terminal on that profile, opened AFTER the mark, got a
 *    real reply (its transcript shows output tokens). An older terminal does not count — it may still
 *    ride a token minted before the login died. After `TTL_MS` without a fresh wall the mark lapses on
 *    its own (an agent may try claude again), but the alert does not repeat until it was proven fixed.
 *  - ALERTED once per profile until it is fixed (`markLoginDead` answers true only the first time).
 *
 * Keyed by workspace AND profile dir: a workspace's agents only ever read their own workspace's mark,
 * so one client's dead login never changes where another client's work runs. In memory only — a daemon
 * restart forgets it, which costs at most one more walled terminal.
 */
import { CONFIG } from "./config.js";
import { workspaces } from "./store.js";

export type LoginDeadMark = {
  workspace_id: string | null;
  dir: string;
  /** First wall seen (ms): only terminals opened after it can prove the login works again. */
  at: number;
  /** Latest wall seen (ms): the TTL runs from here. */
  seen: number;
  line: string;
  session_id: string;
};

export const LOGIN_DEAD_TTL_MS = 6 * 60 * 60_000;

const marks = new Map<string, LoginDeadMark>();
const alerted = new Set<string>();
const keyOf = (wsId: string | null | undefined, dir: string) => `${wsId ?? ""}\0${dir}`;

/** The claude profile a workspace's terminals spawn with — the same dir openSession pins. */
export function claudeDirFor(wsId: string | null | undefined): string {
  const ws = wsId ? workspaces.get(wsId) : undefined;
  return ws?.config_dir ?? CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? "";
}

/**
 * A terminal on this profile is sitting on a login wall. Returns true when the operator should be told:
 * the first wall since the login was last proven to work, never once per terminal.
 */
export function markLoginDead(
  wsId: string | null | undefined,
  dir: string,
  wall: { line: string; session_id: string },
  now = Date.now(),
): boolean {
  const k = keyOf(wsId, dir);
  const m = marks.get(k);
  if (m) Object.assign(m, { seen: now, line: wall.line, session_id: wall.session_id });
  else marks.set(k, { workspace_id: wsId ?? null, dir, at: now, seen: now, line: wall.line, session_id: wall.session_id });
  if (alerted.has(k)) return false;
  alerted.add(k);
  return true;
}

/** The live mark for this workspace's profile, or null (never marked, proven fixed, or lapsed). */
export function loginDeadFor(wsId: string | null | undefined, dir: string, now = Date.now()): LoginDeadMark | null {
  const m = marks.get(keyOf(wsId, dir));
  return m && now - m.seen < LOGIN_DEAD_TTL_MS ? m : null;
}

/** Is anything remembered for this profile (live or lapsed)? Cheap gate before reading a transcript. */
export function loginDeadKnown(wsId: string | null | undefined, dir: string): boolean {
  return marks.has(keyOf(wsId, dir));
}

/**
 * A claude terminal on this profile got a real reply. Clears the mark and re-arms the alert — but only
 * for a terminal opened after the first wall. Returns true when it cleared something.
 */
export function loginWorks(wsId: string | null | undefined, dir: string, openedAt: number | null | undefined): boolean {
  const k = keyOf(wsId, dir);
  const m = marks.get(k);
  if (!m || openedAt == null || openedAt <= m.at) return false;
  marks.delete(k);
  alerted.delete(k);
  return true;
}

/** Tests only. */
export function resetLoginDead(): void {
  marks.clear();
  alerted.clear();
}
