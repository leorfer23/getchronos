/**
 * The operator's yes on a terminal's hand-off card — the Desk's dock, the phone's deck — bound to exactly
 * what he approved. The button used to type one generic line into the terminal ("Approved: merge the PR
 * once its checks are green…"): no PR, no commit, no record. A terminal that had opened several PRs over
 * its life could apply it to the wrong one, nobody could tell afterwards what had been approved, and
 * Robert — who never saw the click — told a terminal to stop a merge the operator had just approved.
 *
 * Now the yes goes to POST /api/sessions/:id/approve (card-approval-routes.ts): the server resolves what
 * it covers from the terminal's own hand-off, reads each PR's head on GitHub at that moment, and types a
 * line naming the PR, the commit and who approved it. This module owns the record and the words:
 *
 *   record  kv `card-approvals:<session>` — who (the operator), where (desk | phone), what (merge,
 *           merge + deploy, deploy), each PR with the commit approved, when, and the hand-off it approved
 *           (the hand-off's `at` is its id). The newest MAX_KEPT per terminal. Robert reads it in FLEET NOW
 *           (fleet-line.ts), in a wake about that terminal (robert-drive.ts driveSay), at
 *           GET /api/sessions/:id/approvals, and in the ledger (GET /api/ledger/:id → approvals, and the
 *           merge item decided yes on that commit).
 *   words   approvalLine — what the terminal is told; movedLine — what it is told instead when the PR
 *           moved since it was put to him (no merge: hand off again); approvalNote — Robert's one line.
 *
 * Only kv reads and writes, so the prompt paths can import it without the route's dependencies.
 */
import { kv } from "./store.js";

export const APPROVAL_KINDS = ["merge", "merge+deploy", "deploy"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const APPROVAL_SURFACES = ["desk", "phone"] as const;
export type ApprovalSurface = (typeof APPROVAL_SURFACES)[number];

/** One PR an approval covers, as GitHub had it at the moment he approved. */
export type ApprovedPr = {
  url: string;
  /** owner/repo */
  repo: string;
  num: number;
  /** The head commit he approved (a merge); for a deploy, the merge commit when GitHub reported one. */
  sha: string | null;
  state: "open" | "merged";
};

export interface CardApproval {
  /** `ap-` + 8 hex — named in the line the terminal gets, so its transcript points at this record. */
  id: string;
  session_id: string;
  workspace_id: string | null;
  /** The hand-off it approves (that hand-off's `at`); null = approved from the terminal's one open PR. */
  outcome_at: string | null;
  kind: ApprovalKind;
  prs: ApprovedPr[];
  approved_by: "operator";
  surface: ApprovalSurface;
  at: string;
  /** The ledger items decided yes with it (src/ledger.ts), when the ledger had any. */
  ledger: { request_id: string; item_ids: string[] } | null;
}

const KEY = (sessionId: string) => `card-approvals:${sessionId}`;
const MAX_KEPT = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Every approval given on this terminal's cards, oldest first. */
export function approvalsOf(sessionId: string): CardApproval[] {
  try {
    const v = JSON.parse(kv.get(KEY(sessionId)) ?? "[]");
    return Array.isArray(v) ? v.filter((a) => a && a.session_id === sessionId) : [];
  } catch {
    return [];
  }
}

export function recordApproval(a: CardApproval): void {
  kv.set(KEY(a.session_id), JSON.stringify([...approvalsOf(a.session_id), a].slice(-MAX_KEPT)));
}

/**
 * The approval that still speaks for this terminal — its newest, unless it is older than a day or the
 * terminal has handed off something else since (a later hand-off naming none of the approved PRs is a
 * new question). The record keeps it either way; this only decides what goes in front of Robert.
 */
export function currentApproval(
  s: { id: string; outcome?: { at: string; prs?: string[] } | null },
  nowMs = Date.now(),
): CardApproval | null {
  const a = approvalsOf(s.id).at(-1);
  if (!a) return null;
  const at = Date.parse(a.at);
  if (!Number.isFinite(at) || nowMs - at > DAY_MS) return null;
  const o = s.outcome;
  if (o && o.at > a.at && o.at !== a.outcome_at && !(o.prs ?? []).some((u) => a.prs.some((p) => p.url === u))) return null;
  return a;
}

// ───────────────────────────── the words ─────────────────────────────

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");
const WHERE: Record<ApprovalSurface, string> = { desk: "on the Desk card", phone: "on the phone's card" };
const KIND_WORD: Record<ApprovalKind, string> = { merge: "merge", "merge+deploy": "merge + deploy", deploy: "deploy" };
const shippedFlags = (xs: string[]) => xs.map((x) => `--shipped "${x}"`).join(" ");

/**
 * What the terminal is told. One line (a pty submits on a newline): who approved it and where, the
 * approval's id and the hand-off it answers, each PR by number and link with the exact commit, the
 * command that refuses to merge anything else, what to do if the head moved, and the deploy rule.
 */
export function approvalLine(a: CardApproval): string {
  const head = `Approved by the operator ${WHERE[a.surface]} (approval ${a.id}${a.outcome_at ? `, for your hand-off of ${a.outcome_at}` : ""}):`;
  if (a.kind === "deploy") {
    const what = a.prs.length
      ? ` (${a.prs.map((p) => `PR #${p.num}${p.state === "merged" && p.sha ? `, merged as ${short(p.sha)}` : ""}`).join(", ")})`
      : "";
    return `${head} deploy it — the deploy that hand-off asks for${what}, nothing more. Then run \`mc outcome --shipped "deployed"\`.`;
  }
  const open = a.prs.filter((p) => p.state === "open");
  const deploy = a.kind === "merge+deploy";
  const one = open.length === 1;
  const prs = open.map((p) => `PR #${p.num} (${p.url}) at head ${short(p.sha)}`).join(" and ");
  const cmds = open.map((p) => `\`gh pr merge ${p.url} --match-head-commit ${p.sha}\``).join(", ");
  const moved = one
    ? `If its head is no longer ${short(open[0].sha)}, do not merge${deploy ? " or deploy" : ""}`
    : `If any head is no longer the commit named here, do not merge${deploy ? " or deploy" : ""} that PR`;
  const shipped = shippedFlags([...open.map((p) => `merged #${p.num}`), ...(deploy ? ["deployed"] : [])]);
  return (
    `${head} merge ${prs} — ${one ? "that PR at exactly that commit" : "those PRs at exactly those commits"} and nothing else, once ${one ? "its" : "their"} checks are green: ` +
    `${cmds} (with the repo's usual merge method). ${moved}: file a fresh \`mc outcome\` for the new head and wait for his approval. ` +
    `${deploy ? "Then deploy what you merged." : "Don't deploy."} Then run \`mc outcome ${shipped}\`.`
  );
}

export type MovedPr = { num: number; url: string; was: string; now: string | null };

/** What the terminal is told instead of a merge when a PR moved since it was put to him: hand off again. */
export function movedLine(moved: MovedPr[], surface: ApprovalSurface): string {
  const what = moved.map((m) => `PR #${m.num} was put to him at ${short(m.was)} and GitHub has ${short(m.now)} now`).join("; ");
  return (
    `Not approved yet: the operator said yes ${WHERE[surface]}, but the head moved since — ${what}. ` +
    `Do not merge or deploy ${moved.length > 1 ? "them" : "it"}. File a fresh \`mc outcome\` for the new head (say what changed) so he can approve that version.`
  );
}

const ago = (iso: string, nowMs: number) => {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 120 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

/** What it approved, in a few words: "merge PR #200 @4f1c2d3", "merge + deploy PR #12 @1a2b3c4, PR #13 @5d6e7f8". */
export function approvalWhat(a: CardApproval): string {
  const prs = a.prs.map((p) => `PR #${p.num}${p.sha ? ` @${short(p.sha)}` : ""}`).join(", ");
  return `${KIND_WORD[a.kind]}${prs ? ` ${prs}` : ""}`;
}

/** Robert's one line about it: who, where, when, what — "✓ the operator approved on the Desk card 3m ago: merge PR #200 @4f1c2d3 (ap-1a2b3c4d)". */
export function approvalNote(a: CardApproval, nowMs = Date.now()): string {
  return `✓ the operator approved ${WHERE[a.surface]} ${ago(a.at, nowMs)}: ${approvalWhat(a)} (${a.id})`;
}
