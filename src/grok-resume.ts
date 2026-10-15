import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Grok stores interactive chats at:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionUuid>/
 *
 * After pinning shipped, Desk spawns with `--session-id <chronosRowId>` so the
 * directory name IS the Chronos id and `--resume <id>` reopens the same chat.
 *
 * Older terminals were spawned without a pin: grok minted its own UUID. Reopening
 * those with the Chronos id starts an empty chat. Resolve the on-disk UUID by
 * created_at proximity (and stable pairing when several Desk rows share a cwd).
 */

export function grokSessionsDir(cwd: string): string {
  return path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(cwd));
}

function pinnedExists(cwd: string, id: string): boolean {
  const dir = path.join(grokSessionsDir(cwd), id);
  return fs.existsSync(path.join(dir, "chat_history.jsonl")) || fs.existsSync(path.join(dir, "summary.json"));
}

interface OnDisk {
  id: string;
  createdMs: number;
  kind: string | null;
}

function listOnDisk(cwd: string): OnDisk[] {
  const base = grokSessionsDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out: OnDisk[] = [];
  for (const id of names) {
    const summary = path.join(base, id, "summary.json");
    let createdMs = 0;
    let kind: string | null = null;
    try {
      const s = JSON.parse(fs.readFileSync(summary, "utf8"));
      kind = typeof s.session_kind === "string" ? s.session_kind : null;
      const raw = s.created_at ?? s.info?.created_at ?? null;
      if (typeof raw === "string") createdMs = Date.parse(raw) || 0;
    } catch {
      // no summary yet — fall back to directory mtime so a just-spawned pin still resolves
      try {
        createdMs = fs.statSync(path.join(base, id)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (!createdMs) continue;
    out.push({ id, createdMs, kind });
  }
  return out;
}

const WINDOW_MS = 30_000;

/**
 * Map a Chronos session row to the grok transcript UUID to `--resume`.
 *
 * `siblings` = other Chronos grok rows in the same cwd (live or ended). When several
 * Desk terminals started within the same second, we pair them in created_at order to
 * on-disk non-subagent sessions so each reopen gets a distinct chat.
 */
export function resolveGrokResumeId(opts: {
  cwd: string;
  sessionId: string;
  createdAt: string;
  siblings?: Array<{ id: string; createdAt: string }>;
}): string {
  const { cwd, sessionId, createdAt } = opts;
  if (pinnedExists(cwd, sessionId)) return sessionId;

  const createdMs = Date.parse(createdAt) || 0;
  if (!createdMs) return sessionId;

  const disk = listOnDisk(cwd).filter((d) => d.kind !== "subagent");
  if (!disk.length) return sessionId;

  const cohort = [
    { id: sessionId, createdAt },
    ...(opts.siblings ?? []).filter((s) => s.id !== sessionId),
  ]
    .map((s) => ({ id: s.id, createdMs: Date.parse(s.createdAt) || 0 }))
    .filter((s) => s.createdMs > 0)
    // Only rows that still need a legacy mapping (no pinned dir of their own).
    .filter((s) => !pinnedExists(cwd, s.id))
    .sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id));

  // Candidate chats near this cohort's time window.
  const lo = Math.min(...cohort.map((c) => c.createdMs)) - WINDOW_MS;
  const hi = Math.max(...cohort.map((c) => c.createdMs)) + WINDOW_MS;
  const cands = disk
    .filter((d) => d.createdMs >= lo && d.createdMs <= hi)
    .sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id));

  if (!cands.length) {
    // Single closest within window of THIS row only.
    let best: OnDisk | null = null;
    let bestDelta = Infinity;
    for (const d of disk) {
      const delta = Math.abs(d.createdMs - createdMs);
      if (delta <= WINDOW_MS && delta < bestDelta) {
        best = d;
        bestDelta = delta;
      }
    }
    return best?.id ?? sessionId;
  }

  // Greedy pair: chronos rows ↔ on-disk chats in time order.
  const paired = new Map<string, string>();
  const used = new Set<string>();
  for (const row of cohort) {
    let best: OnDisk | null = null;
    let bestDelta = Infinity;
    for (const d of cands) {
      if (used.has(d.id)) continue;
      const delta = Math.abs(d.createdMs - row.createdMs);
      if (delta < bestDelta) {
        best = d;
        bestDelta = delta;
      }
    }
    if (best) {
      paired.set(row.id, best.id);
      used.add(best.id);
    }
  }
  return paired.get(sessionId) ?? sessionId;
}
