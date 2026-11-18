/**
 * Command: what the operator lets Robert decide in his place, one workspace at a time.
 *
 * The operator, 2026-11-18, after a night in which six terminals sat finished for eight hours waiting
 * on a merge word nobody was awake to give: Robert has to take command and work with the agents the
 * way he does — merge, and be smart about it — "for one project he can do everything, for the others not".
 *
 *  - The OPERATOR grants it, per workspace: `robert.ship` (off | merge | merge+deploy) and
 *    `robert.close_done`. The daemon refuses a Robert credential that tries to turn either
 *    on (robert-scope.ts derivedWriteRefusal), so Robert can never raise his own authority, and the
 *    settings are workspace-level only: there is no fleet-wide grant.
 *  - ROBERT judges: a wake on a stopped terminal says what he may approve there (robert-drive.ts), he
 *    checks its finish line and proof, and approves with `mc session approve <id> <kind>`.
 *  - The DAEMON binds it: the same POST /sessions/:id/approve the operator's card button uses, so his
 *    yes covers exactly the PRs on that hand-off, in this workspace, at the commit GitHub has now — and
 *    it refuses what a grant never covers (below). The record says `approved_by: "robert"`.
 *
 * What a grant never covers: a terminal with no hand-off filed (nothing to judge), one with an open
 * question, and one opened from outside input or by Robert on his own (inbox, trigger, proactive) —
 * there the request did not come from the operator, so the yes stays his.
 */
import { setting, settingOn } from "./settings.js";
import { asks } from "./store.js";
import { PROACTIVE_AUTO_BY } from "./inbox-guard.js";
import type { ApprovalKind } from "./card-approval.js";
import type { Session } from "./types.js";

export const SHIP_GRANTS = ["off", "merge", "merge+deploy"] as const;
export type ShipGrant = (typeof SHIP_GRANTS)[number];

/** What Robert may approve in this workspace. No workspace, or anything unreadable: nothing. */
export function shipGrant(wsId: string | null | undefined): ShipGrant {
  if (!wsId) return "off";
  const v = setting<string>("robert.ship", wsId);
  return (SHIP_GRANTS as readonly string[]).includes(v) ? (v as ShipGrant) : "off";
}

/** Pure: does this grant cover that approval? A deploy, alone or after a merge, needs the full grant. */
export function grantCovers(grant: ShipGrant, kind: ApprovalKind): boolean {
  if (grant === "merge+deploy") return true;
  return grant === "merge" && kind === "merge";
}

/** A session's tags: a JSON array in the row. */
function tagsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Openers whose request did not come from the operator: their merge and deploy word stays his. */
const BOXED_OPENERS: ReadonlySet<string> = new Set(["inbox", "trigger", PROACTIVE_AUTO_BY]);
export const isBoxed = (s: Pick<Session, "created_by" | "tags">): boolean => {
  const by = (s.created_by ?? "").trim();
  return BOXED_OPENERS.has(by) || (by === "robert" && tagsOf(s.tags).includes("proactive"));
};

/** Why Robert may not approve this hand-off, said to him — or null. `openAsks` is injected for tests. */
export function robertApprovalRefusal(
  s: Pick<Session, "id" | "workspace_id" | "created_by" | "tags" | "outcome">,
  kind: ApprovalKind,
  openAsks: (id: string) => number = (id) => asks.openForSession(id).length,
): string | null {
  const grant = shipGrant(s.workspace_id);
  if (grant === "off") return "the operator keeps merges and deploys for himself in this workspace (robert.ship is off) — hand it up";
  if (!grantCovers(grant, kind)) return `the operator lets you approve merges here, not a ${kind === "deploy" ? "deploy" : "merge + deploy"} — approve the merge, hand the deploy up`;
  if (isBoxed(s)) return "this terminal was opened from outside input or on your own initiative — its merge and deploy word is always the operator's";
  if (!s.outcome) return "it has not filed a hand-off — there is nothing to check; ask it for `mc outcome` first";
  if (openAsks(s.id) > 0) return "it has an open question — settle that first";
  return null;
}

/** What a wake tells Robert about his authority on this terminal, or "" when he has none here. */
export function commandLine(s: Pick<Session, "id" | "workspace_id" | "created_by" | "tags">): string {
  const grant = shipGrant(s.workspace_id);
  if (grant === "off" || isBoxed(s)) return "";
  const id8 = s.id.slice(0, 8);
  const what = grant === "merge+deploy" ? "the merge AND the deploy" : "the merge (a deploy is still the operator's)";
  const kinds = grant === "merge+deploy" ? "merge | merge+deploy | deploy" : "merge";
  return (
    `YOU HOLD THE OPERATOR'S YES HERE — in this workspace he lets you approve ${what} of a hand-off, so it is NOT a hand-up. ` +
    `Be the reviewer he would be: read the hand-off and its proof (\`mc session focus ${id8}\`), and approve only when its finish line is met, ` +
    `its checks and tests are green, no verifier or review finding is open, and the workspace's Standing orders do not say "Ask first" or "Never" for this. ` +
    `Then: \`mc session approve ${id8} <${kinds}>\` — the daemon binds your yes to that PR at its current commit and types it into the terminal. ` +
    `Something missing → tell the terminal exactly what to fix (\`mc session send\`), do not approve. Genuinely his (product call, money, a message to a third party, a risk you cannot rule out) → hand up.\n`
  );
}

/** Every terminal here counts as auto-close (the workspace's `robert.close_done`), or this one was marked. */
export const closesWhenDone = (s: Pick<Session, "auto_close" | "workspace_id">): boolean =>
  !!s.auto_close || (!!s.workspace_id && settingOn("robert.close_done", s.workspace_id));
