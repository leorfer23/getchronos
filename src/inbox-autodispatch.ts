/**
 * Auto-dispatch: every new inbox row becomes a Desk terminal by itself. The operator reads terminals,
 * not the inbox — so a row that waits for a Dispatch press waits forever. He closes the terminals he
 * does not need; closing one closes its row.
 *
 * - Grace: a row must sit `new` for `graceSec` first, so a tracker self-resolve, a dedupe or his own
 *   ✕ wins the race.
 * - Cap: at most `perWorkspace` live inbox terminals per client; the rest wait and open as those close.
 * - Only rows filed after the feature first ran (kv `inbox.auto.after` = rowid then): turning it on
 *   never floods the Desk with the old backlog.
 * - A row whose terminal fails to open three times stays `new` for his hand.
 *
 * Event-driven (inbox.updated, session.ended) plus a cheap 60s store-only tick for the grace timer.
 */
import { bus, type BusEvent } from "./bus.js";
import { CONFIG } from "./config.js";
import { inbox, kv, workspaces } from "./store.js";
import { dispatchInboxItem } from "./inbox-dispatch.js";
import { setting } from "./settings.js";
import { openSession } from "./terminal.js";

const AFTER_KEY = "inbox.auto.after";
const MAX_FAILS = 3;

export type AutoDeps = {
  opener?: typeof openSession;
  now?: () => number;
  enabled?: (wsId: string) => boolean;
};

export function createAutoDispatcher(deps: AutoDeps = {}) {
  const now = deps.now ?? Date.now;
  const enabled = deps.enabled ?? ((ws: string) => setting<boolean>("inbox.auto_dispatch", ws) !== false);
  const firstSeen = new Map<string, number>();
  const fails = new Map<string, number>();
  let running = false;

  const after = (): number => {
    const v = kv.get(AFTER_KEY);
    if (v != null && v !== "") return Number(v) || 0;
    const n = inbox.maxRowid();
    kv.set(AFTER_KEY, String(n));
    return n;
  };

  async function pump(): Promise<string[]> {
    if (running) return [];
    running = true;
    const opened: string[] = [];
    try {
      const t = now();
      const live = inbox.liveDispatched();
      const cands = inbox.autoCandidates(after());
      const seen = new Set(cands.map((c) => c.id));
      for (const id of firstSeen.keys()) if (!seen.has(id)) firstSeen.delete(id);
      for (const c of cands) {
        if (!firstSeen.has(c.id)) firstSeen.set(c.id, t);
        if (t - firstSeen.get(c.id)! < CONFIG.inboxAuto.graceSec * 1000) continue;
        if ((fails.get(c.id) ?? 0) >= MAX_FAILS) continue;
        if ((live[c.workspace_id] ?? 0) >= CONFIG.inboxAuto.perWorkspace) continue;
        if (!workspaces.get(c.workspace_id) || !enabled(c.workspace_id)) continue;
        const ws = workspaces.get(c.workspace_id);
        const claude = !ws?.default_backend || ws.default_backend === "claude-code";
        try {
          await dispatchInboxItem(c.id, deps.opener ?? openSession, { model: claude ? CONFIG.inboxAuto.model || null : null });
          live[c.workspace_id] = (live[c.workspace_id] ?? 0) + 1;
          firstSeen.delete(c.id);
          opened.push(c.id);
        } catch (e: any) {
          // A full seat or a busy computer is the whole client's problem, not this row's: try the next tick.
          if (/cap reached|refus|busy|load|memory/i.test(String(e?.message))) live[c.workspace_id] = Infinity;
          else fails.set(c.id, (fails.get(c.id) ?? 0) + 1);
          console.warn(`[inbox-auto] ${c.id.slice(0, 8)}: ${e?.message ?? e}`);
        }
      }
    } finally {
      running = false;
    }
    return opened;
  }

  function onEvent(e: BusEvent): void {
    if (e.topic === "session.ended") {
      const row = inbox.closeForSession(e.session_id);
      if (row) bus.publish({ topic: "inbox.updated", workspace_id: row.workspace_id, item_id: row.id });
      void pump();
    } else if (e.topic === "inbox.updated") {
      setTimeout(() => void pump(), CONFIG.inboxAuto.graceSec * 1000 + 500).unref?.();
    }
  }

  return { pump, onEvent, _firstSeen: firstSeen };
}

export function startInboxAutoDispatch(): void {
  if (!CONFIG.inboxAuto.enabled) return;
  const d = createAutoDispatcher();
  bus.on("event", d.onEvent);
  setInterval(() => void d.pump(), 60_000).unref();
  void d.pump();
}
