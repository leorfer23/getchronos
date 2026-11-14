/**
 * The operator's yes on a terminal's hand-off card, bound on the server to what it covers
 * (card-approval.ts says why the page no longer types its own line).
 *
 *   POST /sessions/:id/approve    {kind: merge | merge+deploy | deploy, outcome_at?, surface?, ledger?: {request, item}}
 *   GET  /sessions/:id/approvals  what he approved on this terminal's cards, oldest first
 *
 * Who: the operator's own hand (ledger-routes.ts operatorHand — his token itself from this Mac, no agent
 * header, `x-mc-operator: 1`). No Robert, Lead, workspace or agent credential approves anything for him.
 *
 * What, resolved here — the page only says which button it was:
 *   1. The card. `outcome_at`, when sent, must still be the terminal's newest hand-off: a newer one means
 *      the card he approved is gone (409, nothing typed). The PRs are that hand-off's; with no hand-off
 *      filed, the terminal's one open PR (several and none named: 409). `ledger` (the phone's deck) names
 *      the request item the card was built from: it must be in this terminal's workspace and link to this
 *      terminal — anything else is the same 404 as one that does not exist — and it narrows the approval
 *      to its own PR.
 *   2. The wall. Every PR must belong to the terminal's workspace (pr-ownership.ts); one that does not
 *      refuses the whole approval.
 *   3. The commit. Each PR's head is read on GitHub now, under the workspace's own read identity, and
 *      that is the commit approved. If the card was bound to a version (the ledger item's head) and
 *      GitHub has another, the PR moved since it was put to him: no merge is typed — the terminal is told
 *      to hand off again (409 `moved`).
 * Then the line naming the PRs and commits is typed into that terminal as his (by "operator", as the
 * Desk's button always was), the approval is recorded where Robert reads it, the ledger's merge items for
 * those PRs are decided yes on that commit, and `session.approval` goes on the bus (the activity trail).
 */
import os from "node:os";
import { randomBytes } from "node:crypto";
import type express from "express";
import { z } from "zod";
import { bus } from "./bus.js";
import { checkScope } from "./authz.js";
import { ghReadEnv } from "./child-env.js";
import { execFileTimed } from "./exec.js";
import { recordDecision } from "./ledger.js";
import { operatorHand } from "./ledger-routes.js";
import { prBelongsTo } from "./pr-ownership.js";
import { sessionPrs, sessions, workspaces } from "./store.js";
import { requests, type DecisionItem, type RequestRow } from "./store/requests.js";
import { validate } from "./validation.js";
import {
  APPROVAL_KINDS, APPROVAL_SURFACES, approvalLine, approvalsOf, movedLine, recordApproval,
  type ApprovalKind, type ApprovalSurface, type ApprovedPr, type CardApproval, type MovedPr,
} from "./card-approval.js";
import type { Session, Workspace } from "./types.js";

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

// ───────────────────────────── seams (tests replace them; nothing real runs under test) ─────────────────────────────

/** What GitHub says about one PR right now. */
export type PrNow = { state: string; head: string | null; merge_commit: string | null };
export type PrReader = (ws: Workspace | null, url: string) => Promise<PrNow>;
const realRead: PrReader = async (ws, url) => {
  // A test never reaches GitHub, whatever it forgot to stub.
  if (process.env.CHRONOS_TEST === "1") throw new Error("no real gh under test");
  const out = await execFileTimed("gh", ["pr", "view", url, "--json", "state,headRefOid,mergeCommit"], { cwd: os.homedir(), env: ghReadEnv(ws), timeout: 20_000 });
  const v = JSON.parse(out.stdout);
  return {
    state: String(v?.state ?? "").toUpperCase(),
    head: typeof v?.headRefOid === "string" ? v.headRefOid : null,
    merge_commit: typeof v?.mergeCommit?.oid === "string" ? v.mergeCommit.oid : null,
  };
};

/** Type one line into the terminal as the operator. null = typed, else why not. */
export type LineTyper = (s: Session, text: string) => Promise<string | null>;
const realType: LineTyper = async (s, text) => {
  // A cloud terminal has no tty: the line becomes its next turn, as POST /sessions/:id/input does it.
  if (s.cloud_agent_id) {
    const { followUpCloudSession } = await import("./desk-cloud.js");
    const r = followUpCloudSession(s, text);
    return "error" in r ? r.error : null;
  }
  const { sendInput } = await import("./terminal.js");
  const err = sendInput(s.id, { text, enter: true }, "operator");
  if (err) return err;
  // His hand, counted as POST /input counts the Desk's buttons: he engaged, and any ask of his it answers.
  const [{ noteOperatorInput }, { operatorAnswered }] = await Promise.all([import("./proactive-score.js"), import("./ask-in-terminal.js")]);
  noteOperatorInput(s.id);
  void operatorAnswered(s.id, text).catch((e) => console.warn("[ask-in-terminal]", e?.message ?? e));
  return null;
};

let readPr: PrReader = realRead;
let typeLine: LineTyper = realType;
/** Tests: a fake GitHub read and a fake keyboard. A key left out keeps its current seam; null restores both. */
export function setApprovalDeps(d: { readPr?: PrReader | null; type?: LineTyper | null } | null): void {
  if (!d || "readPr" in d) readPr = d?.readPr ?? realRead;
  if (!d || "type" in d) typeLine = d?.type ?? realType;
}

// ───────────────────────────── resolving one approval ─────────────────────────────

export type ApproveInput = {
  kind: ApprovalKind;
  /** The hand-off the card was drawn from (its `at`), null = it showed none. Absent = not checked. */
  outcome_at?: string | null;
  surface?: ApprovalSurface | null;
  /** The request item the card was built from (the phone's deck): this terminal's, in its workspace. */
  ledger?: { request: string; item: string } | null;
};
export type ApproveRefusal = { ok: false; status: number; error: string; moved?: MovedPr[]; told?: boolean };
export type ApproveResult = { ok: true; approval: CardApproval; line: string } | ApproveRefusal;

const refuse = (status: number, error: string, extra: Partial<ApproveRefusal> = {}): ApproveRefusal => ({ ok: false, status, error, ...extra });

/** Why this PR is not the terminal's to merge, or null. A terminal with no workspace may only touch a PR no workspace claims. */
function prWall(wsId: string | null, url: string): string | null {
  if (!PR_URL.test(url)) return "not a GitHub PR link";
  if (wsId) {
    const r = prBelongsTo(wsId, url);
    return r.ok ? null : r.why;
  }
  return workspaces.list(true).some((w) => prBelongsTo(w.id, url).ok) ? "it is a workspace's repo" : null;
}

/** The request that owns what this terminal handed off at `at`, inside the terminal's own workspace. */
function ownerOf(s: Session, at: string | null): RequestRow | undefined {
  const l = at ? requests.primaryAt(s.id, at) : undefined;
  const r = l ? requests.get(l.request_id) : undefined;
  return r && (r.workspace_id ?? null) === (s.workspace_id ?? null) ? r : undefined;
}

export async function approveCard(s: Session, inp: ApproveInput, nowMs = Date.now()): Promise<ApproveResult> {
  if (s.status !== "live") return refuse(409, "that terminal has ended — nothing was typed");
  const surface: ApprovalSurface = inp.surface === "phone" ? "phone" : "desk";
  const wsId = s.workspace_id ?? null;
  const ws = wsId ? workspaces.get(wsId) ?? null : null;
  const o = s.outcome ?? null;
  // The card he approved must still be the one on top: a newer hand-off is a new question.
  if (inp.outcome_at !== undefined && (inp.outcome_at ?? null) !== (o?.at ?? null))
    return refuse(409, "a newer hand-off landed since that card was drawn — have another look; nothing was typed");

  // The ledger item the card came from: this terminal's, in its workspace — anything else is the 404 a missing one gets.
  let led: { r: RequestRow; item: DecisionItem; ref: string | null } | null = null;
  if (inp.ledger) {
    const r = requests.resolve(inp.ledger.request);
    const mine = !!r && (r.workspace_id ?? null) === wsId && requests.linksFor(r.id).some((l) => l.session_id === s.id);
    const hits = r && mine ? requests.items(r.id).filter((i) => i.id === inp.ledger!.item || i.id.startsWith(inp.ledger!.item)) : [];
    if (!r || hits.length !== 1) return refuse(404, "no such request item on this terminal — nothing was typed");
    const d = hits[0].deliverable_id ? requests.deliverable(hits[0].deliverable_id) : undefined;
    led = { r, item: hits[0], ref: d && d.kind === "pr" ? d.ref : null };
  }

  const merging = inp.kind !== "deploy";
  if (led && led.item.action !== (merging ? "merge" : "deploy")) return refuse(409, `that item asks for a ${led.item.action}, not a ${inp.kind} — nothing was typed`);
  if (merging && o && o.ask !== "merge" && o.ask !== "merge+deploy") return refuse(409, "its hand-off does not ask for a merge — nothing was typed");
  if (!merging && !(o && (o.ask === "deploy" || o.ask === "merge+deploy"))) return refuse(409, "its hand-off does not ask for a deploy — nothing was typed");

  // What it covers: the PRs on that hand-off — or, with none filed, the terminal's one open PR.
  let urls: string[];
  if (o) urls = [...o.prs];
  else {
    // Its own PRs still open (a repo with no CI is only "skipped" by auto-merge: still open, merged by hand).
    urls = sessionPrs.forSession(s.id).filter((p) => p.state === "open" || (p.state === "skipped" && p.no_ci === 1)).map((p) => p.url);
    if (urls.length > 1 && !led?.ref) return refuse(409, `it has ${urls.length} open PRs and no hand-off naming one — ask it for \`mc outcome --pr <url>\`; nothing was typed`);
  }
  // A card built from one ledger item approves that item's PR only.
  if (led?.ref) {
    if (!urls.includes(led.ref)) return refuse(409, "that PR is not on its hand-off any more — have another look; nothing was typed");
    urls = [led.ref];
  }
  if (merging && !urls.length)
    return refuse(409, o ? "its hand-off names no PR to merge — nothing was typed" : "it has no open PR on record and no hand-off — ask it for `mc outcome --pr <url>`; nothing was typed");

  // The wall: every PR is this terminal's workspace's, or nothing is approved.
  for (const url of urls) {
    const why = prWall(wsId, url);
    if (why) return refuse(403, `${url} is not this terminal's to merge (${why}) — nothing was typed`);
  }

  // The commit: GitHub's head now. The version the card was bound to, when it was (the phone shows the
  // ledger item's verified head), must still be it.
  const bound = led?.ref && led.item.target_hash ? new Map([[led.ref, led.item.target_hash]]) : new Map<string, string>();
  const prs: ApprovedPr[] = [];
  const moved: MovedPr[] = [];
  const ended: string[] = [];
  for (const url of urls) {
    const [, owner, repo, num] = PR_URL.exec(url)!;
    const base = { url, repo: `${owner}/${repo}`, num: Number(num) };
    let now: PrNow | null = null;
    let readErr = "";
    try {
      now = await readPr(ws, url);
    } catch (e: any) {
      readErr = String(e?.stderr || e?.message || e).trim().slice(0, 200);
    }
    if (!merging) {
      const merged = now?.state === "MERGED";
      prs.push({ ...base, sha: merged ? now!.merge_commit : now?.head ?? null, state: merged ? "merged" : "open" });
      continue;
    }
    const want = bound.get(url) ?? null;
    if (!now) {
      // GitHub could not be read: a version the card was bound to is still a commit to name — GitHub itself
      // refuses any other at merge time (--match-head-commit). Nothing to bind to: nothing is approved.
      if (want) { prs.push({ ...base, sha: want, state: "open" }); continue; }
      return refuse(502, `could not read PR #${base.num} on GitHub (${readErr || "no answer"}) — nothing was typed; try again`);
    }
    if (now.state === "MERGED" || now.state === "CLOSED") { ended.push(`PR #${base.num} is ${now.state.toLowerCase()}`); continue; }
    if (now.state !== "OPEN" || !now.head) return refuse(502, `GitHub did not say where PR #${base.num} stands — nothing was typed; try again`);
    if (want && want !== now.head) { moved.push({ num: base.num, url, was: want, now: now.head }); continue; }
    prs.push({ ...base, sha: now.head, state: "open" });
  }

  if (moved.length) {
    // Never a merge on a moved head: the terminal hands off again, and he approves what is there now.
    const err = await typeLine(s, movedLine(moved, surface));
    bus.publish({
      topic: "session.approval", session_id: s.id, workspace_id: wsId, result: "moved", kind: inp.kind, outcome_at: o?.at ?? null,
      prs: moved.map((m) => ({ url: m.url, was: m.was, now: m.now })), surface, actor: "operator",
    });
    const what = moved.map((m) => `PR #${m.num} was ${m.was.slice(0, 7)}, is ${String(m.now).slice(0, 7)}`).join("; ");
    return refuse(409, `the head moved since it was put to you (${what}) — nothing was merged; ${err ? `the terminal could not be told (${err})` : "the terminal was told to hand off again"}`, { moved, told: !err });
  }
  if (merging && !prs.length) return refuse(409, `nothing left to merge: ${ended.join(", ")} — nothing was typed`);

  const approval: CardApproval = {
    id: `ap-${randomBytes(4).toString("hex")}`, session_id: s.id, workspace_id: wsId, outcome_at: o?.at ?? null,
    kind: inp.kind, prs, approved_by: "operator", surface, at: new Date(nowMs).toISOString(), ledger: null,
  };
  const line = approvalLine(approval);
  const err = await typeLine(s, line);
  if (err) return refuse(err.startsWith("rate limit") ? 429 : 409, `${err} — nothing was approved`);
  // Typed: from here on it is his decision on record, whatever the ledger makes of it.
  try {
    approval.ledger = mirrorToLedger(s, approval, led?.r ?? ownerOf(s, approval.outcome_at) ?? null);
  } catch (e: any) {
    console.warn("[card-approval] ledger:", e?.message ?? e);
  }
  recordApproval(approval);
  bus.publish({
    topic: "session.approval", session_id: s.id, workspace_id: wsId, result: "approved", approval_id: approval.id, kind: approval.kind,
    outcome_at: approval.outcome_at, prs: approval.prs.map((p) => ({ url: p.url, sha: p.sha })), surface, actor: "operator",
  });
  return { ok: true, approval, line };
}

/**
 * The ledger hears it too: each approved PR's merge item on the request is decided yes on the commit he
 * approved (bound to it first, as the verifier re-binds a moved head), so the queue stops asking and
 * GET /api/ledger shows his yes. The executor never acts on it — only the decision route hands it a yes —
 * so the terminal merges, as the card told it.
 */
function mirrorToLedger(s: Session, a: CardApproval, r: RequestRow | null): CardApproval["ledger"] {
  if (a.kind === "deploy" || !r || (r.workspace_id ?? null) !== (s.workspace_id ?? null)) return null;
  const ids: string[] = [];
  for (const p of a.prs) {
    if (p.state !== "open" || !p.sha) continue;
    for (const it of requests.items(r.id)) {
      if (it.action !== "merge" || !it.deliverable_id) continue;
      const d = requests.deliverable(it.deliverable_id);
      if (!d || d.kind !== "pr" || d.ref !== p.url) continue;
      // Already his yes on this commit (the phone records it before asking for the line): nothing to add.
      if (it.status === "decided" && it.decision === "yes" && it.target_hash === p.sha) { ids.push(it.id); continue; }
      if (it.status !== "open" && it.status !== "held") continue;
      if (d.target_hash !== p.sha) requests.bindTarget(d.id, p.sha);
      const out = recordDecision({
        request: r.id, item: it.id, decision: "yes", target_hash: p.sha, by: a.surface,
        words: `approved ${a.surface === "phone" ? "on the phone's card" : "on the Desk card"} (${a.id}): merge PR #${p.num} at ${p.sha.slice(0, 7)}`,
      });
      if (out.ok) ids.push(it.id);
    }
  }
  return ids.length ? { request_id: r.id, item_ids: ids } : null;
}

// ───────────────────────────── routes ─────────────────────────────

const ApproveSchema = z.object({
  kind: z.enum(APPROVAL_KINDS),
  outcome_at: z.string().max(40).nullish(),
  surface: z.enum(APPROVAL_SURFACES).nullish(),
  ledger: z.object({ request: z.string().trim().min(4).max(64), item: z.string().trim().min(4).max(64) }).nullish(),
});

export function mountCardApprovalRoutes(api: express.Router): void {
  api.post("/sessions/:id/approve", validate(ApproveSchema), async (req, res) => {
    if (!operatorHand(req, res)) return;
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    const b = req.body as z.infer<typeof ApproveSchema>;
    try {
      const out = await approveCard(s, { kind: b.kind, outcome_at: b.outcome_at, surface: b.surface ?? null, ledger: b.ledger ?? null });
      if (!out.ok) {
        const { ok: _ok, status, ...body } = out;
        return res.status(status).json(body);
      }
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
  // Read like the terminal itself: the operator, its workspace's token, or that workspace's Robert.
  api.get("/sessions/:id/approvals", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (!checkScope(req, res, s.workspace_id)) return;
    res.json({ approvals: approvalsOf(s.id) });
  });
}
