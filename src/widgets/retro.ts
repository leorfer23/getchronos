/**
 * Weekly retro — per workspace: this week's KPIs beside last week's (verifier rejections per hand-off,
 * repeat asks, infra interruptions, duplicate terminals), the rules waiting on the operator with
 * approve / dismiss, and any approved rule that is not holding. src/retro-pass.ts builds every number.
 *
 * Scoped: with the Desk locked to one client (`q.ws`) it reads that workspace alone. The tap itself is
 * not a read — the module posts it to /workspaces/:id/retro/proposals/:pid, the operator's hand only.
 */
import { workspaces } from "../store.js";
import { retroView } from "../retro-pass.js";
import type { Workspace } from "../types.js";
import type { Widget } from "./index.js";

/** Every workspace with a week on record or a rule waiting, the locked one alone when there is a lock. */
export function retroRows(q: Record<string, string>) {
  const list: Workspace[] = q.ws ? [workspaces.get(q.ws)].filter((w): w is Workspace => !!w && !w.archived) : workspaces.list();
  return list.map(retroView).filter((r) => r.run || r.pending.length);
}

const retro: Widget = {
  name: "retro",
  title: "Weekly retro",
  topics: ["retro.updated"],
  scoped: true,
  data: (q) => ({ rows: retroRows(q) }),
};

export default retro;
