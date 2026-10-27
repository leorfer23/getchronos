/**
 * Auto-dispatch: every new inbox row with work in it becomes a Desk terminal by itself. The operator
 * reads terminals, not the inbox — so a row that waits for a Dispatch press waits forever. He closes
 * the terminals he does not need; closing one closes its row.
 *
 * - First pass: before a terminal opens, src/inbox-triage.ts asks whether the row has any work in it.
 *   No work (an FYI, a thank-you, a repeat of a live terminal) → the row closes with the reason and
 *   no terminal opens; it stays in the Inbox log, and Reopen there opens it without asking again.
 *   Off per client with the `inbox.triage` setting.
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
import { inbox, kv, workspaces, type InboxItem } from "./store.js";
import { dispatchInboxItem } from "./inbox-dispatch.js";
import { saveVerdict, savedVerdict, triageInboxItem, type Verdict } from "./inbox-triage.js";
import { setting } from "./settings.js";
import { openSession } from "./terminal.js";

const AFTER_KEY = "inbox.auto.after";
const MAX_FAILS = 3;
/** A first pass that keeps failing stops blocking: the row opens as it did before the pass existed. */
const MAX_TRIAGE_FAILS = 2;
/** The reason a no-work row closes with — the Inbox log shows it after a ✓. */
export const NO_WORK = "no work: ";

export type AutoDeps = {
  opener?: typeof openSession;
  now?: () => number;
  enabled?: (wsId: string) => boolean;
  triage?: (item: InboxItem) => Promise<Verdict | null>;
  triageOn?: (wsId: string) => boolean;
};

export function createAutoDispatcher(deps: AutoDeps = {}) {
  const now = deps.now ?? Date.now;
  const enabled = deps.enabled ?? ((ws: string) => setting<boolean>("inbox.auto_dispatch", ws) !== false);
  const triage = deps.triage ?? ((i: InboxItem) => triageInboxItem(i));
  const triageOn = deps.triageOn ?? ((ws: string) => setting<boolean>("inbox.triage", ws) !== false);
  const firstSeen = new Map<string, number>();
  const fails = new Map<string, number>();
  const triageFails = new Map<string, number>();
  let running = false;

  /**
   * Work or not, judged once per row. A saved "no work" on a row that is `new` again means the
   * operator reopened it — that is his yes. "wait" = the pass failed this tick; try again next one.
   */
  async function judge(c: InboxItem): Promise<Verdict | "wait"> {
    const saved = savedVerdict(c.id);
    if (saved) return saved.work ? saved : { work: true, why: "reopened by the operator", task: saved.task };
    if (!triageOn(c.workspace_id)) return { work: true, why: "first pass off", task: null };
    let v: Verdict | null = null;
    try {
      v = await triage(c);
    } catch (e: any) {
      console.warn(`[inbox-auto] triage ${c.id.slice(0, 8)}: ${e?.message ?? e}`);
    }
    if (!v) {
      const n = (triageFails.get(c.id) ?? 0) + 1;
      triageFails.set(c.id, n);
      if (n < MAX_TRIAGE_FAILS) return "wait";
      v = { work: true, why: "first pass failed; opened anyway", task: null };
    }
    triageFails.delete(c.id);
    saveVerdict(c.id, v);
    return v;
  }

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
        if (!workspaces.get(c.workspace_id) || !enabled(c.workspace_id)) continue;
        // Judged before the seat check, so a full client still closes its noise as it arrives.
        const v = await judge(c);
        if (v === "wait") continue;
        if (!v.work) {
          firstSeen.delete(c.id);
          if (inbox.resolve(c.id, (NO_WORK + v.why).slice(0, 300))?.state === "resolved")
            bus.publish({ topic: "inbox.updated", workspace_id: c.workspace_id, item_id: c.id });
          continue;
        }
        if ((live[c.workspace_id] ?? 0) >= CONFIG.inboxAuto.perWorkspace) continue;
        const ws = workspaces.get(c.workspace_id);
        const claude = !ws?.default_backend || ws.default_backend === "claude-code";
        try {
          await dispatchInboxItem(c.id, deps.opener ?? openSession, { model: claude ? CONFIG.inboxAuto.model || null : null, task: v.task });
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
