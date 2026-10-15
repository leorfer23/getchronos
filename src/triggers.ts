import { bus } from "./bus.js";
import { triggers as triggerStore } from "./store.js";
import { dispatch } from "./dispatcher.js";
import type { Trigger, TriggerCondition } from "./types.js";

// A trigger event — what an HTTP webhook (or future source) hands the engine.
export interface TriggerEvent {
  method?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  ip?: string;
  ts?: string;
}

// Resolve a dot-path into an arbitrary object: "body.alert.type" / "headers.x-github-event".
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o == null) return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

export function matchCondition(c: TriggerCondition, event: unknown): boolean {
  const actual = getPath(event, c.path);
  switch (c.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return actual === c.value || String(actual) === String(c.value);
    case "contains":
      if (Array.isArray(actual)) return actual.map(String).includes(String(c.value));
      return String(actual ?? "").includes(String(c.value));
    case "regex":
      try {
        return new RegExp(String(c.value)).test(String(actual ?? ""));
      } catch {
        return false;
      }
    case "gt":
      return Number(actual) > Number(c.value);
    case "lt":
      return Number(actual) < Number(c.value);
    default:
      return false;
  }
}

// All conditions ANDed. An empty/absent filter matches everything.
export function matchFilter(filter: TriggerCondition[] | null | undefined, event: unknown): boolean {
  if (!filter || filter.length === 0) return true;
  return filter.every((c) => matchCondition(c, event));
}

// Render the event into the text injected into the job's prompt (inject mode "goal").
function renderContext(trigger: Trigger, event: TriggerEvent): string | undefined {
  if (trigger.inject !== "goal") return undefined;
  const payload = event.body ?? event;
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

export type FireResult = { matched: boolean; run_id?: string; status?: string; error?: string };

// Evaluate a trigger against an event; on match, dispatch its job (with optional injected context).
export function fireTrigger(trigger: Trigger, event: TriggerEvent): FireResult {
  const filter = trigger.filter ? (JSON.parse(trigger.filter) as TriggerCondition[]) : null;
  if (!matchFilter(filter, event)) {
    bus.publish({ topic: "trigger.fired", trigger_id: trigger.id, matched: false });
    return { matched: false };
  }
  triggerStore.recordFire(trigger.id, new Date().toISOString());
  const context = renderContext(trigger, event);
  const r = dispatch(trigger.job_id, `trigger:${trigger.name}`, 0, context);
  if ("error" in r) {
    bus.publish({ topic: "trigger.fired", trigger_id: trigger.id, matched: true });
    return { matched: true, error: r.error };
  }
  bus.publish({ topic: "trigger.fired", trigger_id: trigger.id, matched: true, run_id: r.run_id });
  return { matched: true, run_id: r.run_id, status: r.status };
}
