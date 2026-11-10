/**
 * The executor — the execution owner (LEDGER.md → Executing). Daemon code, not a model. It carries out
 * one thing the operator said yes to — merge one PR, send one draft — and only on his recorded yes for
 * that exact item:
 *
 *   his hand ─ POST /api/ledger/:id/decision (ledger-routes.ts operatorHand: the admin token itself, from
 *              this Mac, no agent header, x-mc-operator: 1 — never a Robert, workspace or Lead credential)
 *          └─ recordDecision (ledger.ts): the yes names the target hash he was shown, still current
 *             └─ approve(): ONE approval for that decision item, single use, expiring in minutes
 *                └─ executeApproval(): claim it once → re-read the REAL target (GitHub's live head, the
 *                   provider's live draft — never a copy the daemon kept) → compare with the hash he
 *                   approved → run under the workspace's own identity → log it → move the ledger
 *
 * Nothing else creates or consumes an approval: no route takes an approval id, and carryOutDecision has
 * exactly one caller, the decision route (executor.test.ts holds the source to that). Every switch is a
 * setting read at the moment it decides; with `executor.enabled` off (the default) nothing here runs and
 * a yes is recorded exactly as before.
 *
 * Never: deploys (a disabled seam below — a deploy will need its own yes each time), `gh pr merge
 * --admin` / `--auto` / `--delete-branch`, retries on its own (a failed yes comes back to him as a new
 * question), or sends from an agent's process (the agents' no-send deny list is untouched).
 */
import os from "node:os";
import { bus } from "./bus.js";
import { childEnv } from "./child-env.js";
import { execFileTimed } from "./exec.js";
import { recompute, settleDeliverable } from "./ledger.js";
import { EXECUTABLE, FINAL_DELIVERABLE, draftHash, expectedChecks, type Action, type DeliverableState } from "./ledger-model.js";
import { prBelongsTo } from "./pr-ownership.js";
import { defineSetting, setting, settingOn } from "./settings.js";
import { sessions, workspaces } from "./store.js";
import { executorStore, type Approval, type ApprovalHow, type ExecAction } from "./store/executor.js";
import { requests, type CheckRow, type DecisionItem, type Deliverable, type RequestRow } from "./store/requests.js";
import type { GoalKind, Workspace } from "./types.js";

const iso = (ms: number) => new Date(ms).toISOString();
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// ───────────────────────────── settings ─────────────────────────────

defineSetting({
  key: "executor.enabled", group: "Executor", level: "global", type: "bool", env: "CHRONOS_EXECUTOR",
  label: "Carry out my yes",
  help: "The executor merges a PR or sends a draft you said yes to — that exact version, under the project's own account, logged. Off: your yes is only recorded, as before, and the agent or you do the rest.",
  default: () => process.env.CHRONOS_EXECUTOR === "1",
});
defineSetting({
  key: "executor.merge_pr", group: "Executor", level: "both", type: "bool",
  label: "…merge a PR",
  help: "Merges with gh under the project's GitHub identity, only if the PR's head on GitHub is still the one you approved (--match-head-commit). Never deploys.",
  default: () => true,
});
defineSetting({
  key: "executor.send_draft", group: "Executor", level: "both", type: "bool",
  label: "…send a draft",
  help: "No project has a sender yet: Slack has no API that reads a draft back, and the daemon holds no Gmail credential. On, a yes is still refused with that reason — send it yourself.",
  default: () => false,
});
defineSetting({
  key: "executor.ttl_minutes", group: "Executor", level: "global", type: "int", min: 1, max: 30,
  label: "A yes expires after (minutes)",
  help: "An approval not carried out within this long is void; say it again.",
  default: () => 5,
});
defineSetting({
  key: "executor.no_checks", group: "Executor", level: "both", type: "enum", options: () => ["refuse", "allow"],
  label: "Merge a PR nothing verified",
  help: "When the verifier has no checks at all for the request: refuse (say \"without checks\" with your yes to override once — it is logged), or allow.",
  default: () => "refuse",
});
defineSetting({
  key: "executor.merge_method", group: "Executor", level: "both", type: "enum", options: () => ["squash", "merge", "rebase"],
  label: "Merge method",
  help: "How the executor merges a PR in this project.",
  default: () => "squash",
});

// ───────────────────────────── seams (tests replace them; nothing real runs under test) ─────────────────────────────

export type GhRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
const realGh: GhRunner = async (args, o) => {
  // A test never merges anything real, whatever it forgot to stub.
  if (process.env.CHRONOS_TEST === "1") throw new Error("the executor never runs the real gh under test");
  return (await execFileTimed("gh", args, { cwd: o.cwd, env: o.env, timeout: 30_000 })).stdout;
};
let gh: GhRunner = realGh;
/** Tests: a fake gh. null restores the real one. */
export function setExecutorGh(fn: GhRunner | null): void {
  gh = fn ?? realGh;
}

/** A draft as its provider holds it now. Hashed with ledger-model.ts draftHash — the formula `mc hook` used. */
export type LiveDraft = { channel: "slack" | "email"; to: string; subject: string | null; text: string };
/**
 * One channel's sender. The contract that makes a send safe: `read` returns what the provider holds
 * NOW (never a copy the daemon kept — draft-notify.ts's list is a display stopgap, never trusted
 * here), and `send` sends exactly what `read` returned, so what goes out is what was hashed.
 */
export interface DraftSender {
  /** Why it cannot send for this workspace, or null when it can. */
  unavailable(ws: Workspace): string | null;
  read(d: Deliverable, ws: Workspace): Promise<LiveDraft | null>;
  send(d: Deliverable, live: LiveDraft, ws: Workspace): Promise<{ id: string }>;
}
const never = (why: string): DraftSender => ({
  unavailable: () => why,
  read: async () => null,
  send: async () => { throw new Error(why); },
});
/** What sending means today, per channel (LEDGER.md → Executing → Sending): nothing the daemon can do yet. */
const DEFAULT_SENDERS: Record<LiveDraft["channel"], DraftSender> = {
  slack: never("Slack has no API that reads back or sends a draft a person left, so the executor cannot check what you approved against what would go out — it never sends a Slack draft. Send it from Slack."),
  email: never("no Gmail sender is set up for this project: the daemon holds no Gmail credential (agents draft through their profile's own connector), so it cannot read the draft back or send it. Send it from Gmail."),
};
const senders: Record<LiveDraft["channel"], DraftSender> = { ...DEFAULT_SENDERS };
/** Tests (and, one day, a real sender): one channel's sender. null restores the default (none). */
export function setDraftSender(channel: LiveDraft["channel"], s: DraftSender | null): void {
  senders[channel] = s ?? DEFAULT_SENDERS[channel];
}

type TellFn = (sessionId: string, text: string) => void;
const realTell: TellFn = (sid, text) => {
  // terminal.ts is heavy (ptys, hosts); loaded only when there is something to type.
  void import("./terminal.js").then((t) => t.sendInput(sid, { text }, "executor")).catch(() => {});
};
let tell: TellFn = realTell;
/** Tests: capture what the terminal would be told. null restores typing into it. */
export function setExecutorTell(fn: TellFn | null): void {
  tell = fn ?? realTell;
}

// ───────────────────────────── vocabulary ─────────────────────────────

/** The ledger's action → what the executor runs for it. */
export const EXEC_ACTION: Partial<Record<Action, ExecAction>> = { merge: "merge_pr", send: "send_draft", deploy: "deploy" };
/** Operator-only overrides a yes may carry. */
export const OVERRIDES = ["no_checks"] as const;
export type ExecStatus = "done" | "refused" | "failed" | "queued";

/** How the yes was given, from the surface's own label (`by`): phone, phone-voice:strong, phone-voice:confirmed… */
export function howOf(by: string | null | undefined): ApprovalHow | null {
  const b = String(by ?? "").toLowerCase();
  if (!b.includes("voice")) return "tap";
  if (b.includes("confirm")) return "voice_confirmed";
  if (b.includes("strong") || /voice$/.test(b)) return "voice_strong";
  // A weak spoken yes ("ok", "bien") on something that cannot be undone is no yes (the phone re-asks it).
  return null;
}
/** Which surface he said it on, from `by` when the body does not say: "phone-voice:strong" → phone. */
export function surfaceOf(by: string | null | undefined): string | null {
  const head = String(by ?? "").toLowerCase().split(/[-:]/)[0].trim();
  return head ? head.slice(0, 24) : null;
}

const WHY: Record<string, { es: string; en: string }> = {
  off: { es: "el ejecutor está apagado", en: "the executor is off" },
  action_off: { es: "eso está apagado en la configuración", en: "that action is switched off" },
  unsupported: { es: "el deploy todavía no lo hago yo", en: "deploys are not mine to run yet" },
  weak: { es: "no te escuché un sí claro", en: "I didn't hear a clear yes" },
  expired: { es: "la aprobación venció, decímelo de nuevo", en: "the approval expired, say it again" },
  replay: { es: "esa aprobación ya se usó", en: "that approval was already used" },
  duplicate: { es: "ese sí ya tiene su aprobación", en: "that yes already has its approval" },
  unbound: { es: "no sé qué versión aprobaste", en: "I don't know which version you approved" },
  not_found: { es: "no encuentro lo que aprobaste", en: "I can't find what you approved" },
  not_approved: { es: "no tengo un sí registrado para eso", en: "there is no recorded yes for it" },
  wall: { es: "eso no es de este proyecto", en: "that is not this project's" },
  no_workspace: { es: "no tiene un proyecto con cuenta propia", en: "it has no project account to run under" },
  already: { es: "ya estaba hecho", en: "it was already done" },
  moved: { es: "cambió desde que dijiste que sí, escuchalo de nuevo", en: "it changed since you said yes, hear it again" },
  no_checks: { es: "nadie verificó esta versión", en: "nothing verified this version" },
  checks_stale: { es: "la verificación es de una versión anterior", en: "the checks are for an older version" },
  checks_failed: { es: "falló la verificación", en: "checks failed" },
  checks_missing: { es: "faltan verificaciones", en: "required checks are missing" },
  not_pr: { es: "eso no es un PR de GitHub", en: "that is not a GitHub PR" },
  not_open: { es: "el PR ya no está abierto", en: "the PR is not open" },
  draft_pr: { es: "el PR es un borrador", en: "the PR is a draft" },
  read_failed: { es: "no pude leerlo en el original", en: "I couldn't read the real thing" },
  gh_failed: { es: "GitHub rechazó el merge", en: "GitHub refused the merge" },
  no_sender: { es: "no tengo cómo mandarlo desde acá, mandalo vos", en: "I have no way to send it from here, send it yourself" },
  gone: { es: "el borrador ya no está", en: "the draft is gone" },
  send_failed: { es: "falló el envío", en: "the send failed" },
};
function sayFor(action: ExecAction, status: ExecStatus, code: string): { es: string; en: string } {
  if (status === "done") return action === "merge_pr" ? { es: "Mergeado.", en: "Merged." } : { es: "Enviado.", en: "Sent." };
  if (status === "queued") return { es: "GitHub lo puso en cola: todavía no está mergeado.", en: "GitHub queued it: it is not merged yet." };
  const w = WHY[code] ?? { es: "algo falló", en: "something failed" };
  return { es: `No pude: ${w.es}.`, en: `I couldn't: ${w.en}.` };
}

// ───────────────────────────── the checks gate (reads the verifier's rows; never writes them) ─────────────────────────────

export type ChecksVerdict =
  | { ok: true; override: string | null }
  | { ok: false; code: "no_checks" | "checks_stale" | "checks_failed" | "checks_missing"; why: string };

/**
 * May this PR head be merged, by what the verifier recorded (request_checks, written by the verifier —
 * read here only)? Only a check that names THIS head counts (a pass for an older head is not a pass for
 * this one). No rows at all: the `executor.no_checks` policy, or his one-off override. Any failing
 * check refuses, and so does a missing or skipped required one for the work type (ledger-model.ts WORK).
 */
export function checksGate(
  kind: GoalKind | null | undefined,
  deliverableId: string,
  hash: string,
  rows: CheckRow[],
  policy: string,
  override: string | null,
): ChecksVerdict {
  if (!rows.length) {
    if (override === "no_checks") return { ok: true, override: "no_checks:operator" };
    if (policy === "allow") return { ok: true, override: "no_checks:setting" };
    return { ok: false, code: "no_checks", why: "the verifier has no checks for this request — refused by default; say \"without checks\" with the yes to override (it is logged)" };
  }
  const mine = rows.filter((c) => (!c.deliverable_id || c.deliverable_id === deliverableId) && c.target_hash === hash);
  if (!mine.length) return { ok: false, code: "checks_stale", why: `the verifier's checks are for another version, none for ${hash.slice(0, 12)}` };
  // The newest run of each check is the one that counts.
  const latest = new Map<string, CheckRow>();
  for (const c of [...mine].sort((a, b) => a.ran_at.localeCompare(b.ran_at))) latest.set(c.name, c);
  const failed = [...latest.values()].filter((c) => c.status === "fail").map((c) => c.name);
  if (failed.length) return { ok: false, code: "checks_failed", why: `failed: ${failed.join(", ")}` };
  const required = expectedChecks(kind ?? null, [...latest.values()]).filter((c) => c.required);
  const missing = required.filter((c) => c.status !== "pass").map((c) => (c.status === "missing" ? c.name : `${c.name} (${c.status})`));
  if (missing.length) return { ok: false, code: "checks_missing", why: `required and not passed: ${missing.join(", ")}` };
  if (!required.length && ![...latest.values()].some((c) => c.status === "pass")) return { ok: false, code: "checks_missing", why: "no check passed for this version" };
  return { ok: true, override: null };
}

// ───────────────────────────── approvals ─────────────────────────────

export type Execution = {
  approval_id: string | null;
  action: ExecAction;
  status: ExecStatus;
  code: string;
  error: string | null;
  target_ref: string | null;
  approved_hash: string | null;
  live_hash: string | null;
  ran: string | null;
  result: Record<string, unknown> | null;
  /** The item that asks him again when a later yes could succeed. */
  reraised_item: string | null;
  /** What the voice layer says: "Mergeado." / "No pude: …". */
  say: { es: string; en: string };
};
export type CarryOut = { executed: boolean; executor?: string; execution?: Execution };
export type CarryMeta = {
  words?: string | null;
  by?: string | null;
  surface?: string | null;
  how?: ApprovalHow | null;
  override?: string | null;
  audio_ref?: string | null;
};

/**
 * Write the one approval a recorded yes earns. Only for an item decided yes this moment, with a bound
 * target: its hash is what he was shown (recordDecision checked it against the item and its deliverable).
 */
export function approve(
  inp: { item: DecisionItem; request: RequestRow; action: ExecAction; how: ApprovalHow; meta: CarryMeta },
  nowMs = Date.now(),
): Approval | { refused: string; why: string } {
  const { item, request } = inp;
  if (item.request_id !== request.id || item.status !== "decided" || item.decision !== "yes") return { refused: "not_approved", why: "the item is not decided yes on this request" };
  if (!item.target_hash) return { refused: "unbound", why: "the item has no target hash to bind the approval to" };
  const d = item.deliverable_id ? requests.deliverable(item.deliverable_id) : undefined;
  if (!d || d.request_id !== request.id) return { refused: "not_found", why: "the item names no deliverable of this request" };
  const ttl = Math.max(1, Number(setting<number>("executor.ttl_minutes")) || 5) * 60_000;
  try {
    return executorStore.createApproval({
      request_id: request.id, decision_id: item.id, workspace_id: request.workspace_id, action: inp.action,
      target_ref: d.ref, target_hash: item.target_hash, approved_at: item.decided_at ?? iso(nowMs), approved_by: item.decided_by,
      surface: inp.meta.surface ?? surfaceOf(inp.meta.by), transcript: inp.meta.words?.trim() || null, how: inp.how,
      audio_ref: inp.meta.audio_ref ?? null, override: inp.meta.override ?? null, expires_at: iso(nowMs + ttl),
    });
  } catch {
    return { refused: "duplicate", why: "this yes already has its approval" };
  }
}

/**
 * The decision route's one call after a recorded answer. A yes on something the executor carries out,
 * with the executor on: one approval, executed now. Anything else: nothing happens, and it says why.
 */
export async function carryOutDecision(item: DecisionItem, request: RequestRow, meta: CarryMeta, nowMs = Date.now()): Promise<CarryOut> {
  if (item.decision !== "yes" || !EXECUTABLE.has(item.action)) return { executed: false };
  if (!settingOn("executor.enabled")) return { executed: false, executor: "off" };
  const action = EXEC_ACTION[item.action];
  if (!action) return { executed: false };
  if (action === "deploy") return { executed: false, executor: "deploy is not carried out by the executor in v1 — it will need its own yes each time" };
  if (!settingOn(`executor.${action}`, request.workspace_id)) return { executed: false, executor: `${action} is switched off` };
  const how = meta.how ?? howOf(meta.by);
  const base = { approval_id: null, request_id: request.id, decision_id: item.id, workspace_id: request.workspace_id, action, approved_by: item.decided_by, surface: meta.surface ?? surfaceOf(meta.by), words: meta.words ?? null, target_ref: null, approved_hash: item.target_hash, live_hash: null, ran: null, override: meta.override ?? null };
  const refusedBeforeApproval = (code: string, why: string): CarryOut => {
    executorStore.log({ ...base, how: how ?? null, status: "refused", code, error: why });
    const execution: Execution = { approval_id: null, action, status: "refused", code, error: why, target_ref: null, approved_hash: item.target_hash, live_hash: null, ran: null, result: null, reraised_item: null, say: sayFor(action, "refused", code) };
    publish(request, item, execution);
    return { executed: false, execution };
  };
  if (!how) return refusedBeforeApproval("weak", "a weak spoken yes carries nothing out — it has to be confirmed");
  const made = approve({ item, request, action, how, meta }, nowMs);
  if ("refused" in made) return refusedBeforeApproval(made.refused, made.why);
  const execution = await executeApproval(made.id, nowMs);
  return { executed: execution.status === "done", execution };
}

// ───────────────────────────── execution ─────────────────────────────

type Ctx = { a: Approval; r: RequestRow; item: DecisionItem; d: Deliverable; ws: Workspace; nowMs: number };
type Ending = {
  status: ExecStatus;
  code: string;
  error?: string | null;
  live?: string | null;
  ran?: string | null;
  result?: Record<string, unknown> | null;
  /** Put the question back to him: bound (same target), unbound (what he approved is gone), or not at all. */
  reraise?: "bound" | "unbound" | null;
  settle?: DeliverableState | null;
  override?: string | null;
};
const errText = (e: any) => String(e?.stderr || e?.message || e).trim().slice(0, 1500);

/**
 * Carry out one approval. Claimed once (a replay or a race gets "replay"), only before it expires,
 * only while every switch is on, only inside the workspace the yes was given in, and only if the real
 * target is still the version he approved. Every path ends in conclude(): logged, and the ledger told.
 */
export async function executeApproval(id: string, nowMs = Date.now()): Promise<Execution> {
  const a = executorStore.approval(id);
  if (!a) {
    const execution: Execution = { approval_id: id, action: "merge_pr", status: "refused", code: "not_found", error: "no such approval", target_ref: null, approved_hash: null, live_hash: null, ran: null, result: null, reraised_item: null, say: sayFor("merge_pr", "refused", "not_found") };
    executorStore.log({ approval_id: id, request_id: null, decision_id: null, workspace_id: null, action: "unknown", approved_by: null, surface: null, how: null, words: null, target_ref: null, approved_hash: null, live_hash: null, ran: null, status: "refused", code: "not_found", error: "no such approval", override: null });
    return execution;
  }
  const at = iso(nowMs);
  const r = requests.get(a.request_id);
  const item = requests.item(a.decision_id);
  if (!executorStore.claim(a.id, at)) {
    // Used already: the second use of one yes. Never used but past its time: void, and asked again.
    const replay = !!a.used_at;
    if (!replay) executorStore.expire(a.id, at);
    return bareEnding(a, r, item, { status: "refused", code: replay ? "replay" : "expired", error: replay ? `already used at ${a.used_at}` : `expired at ${a.expires_at}`, reraise: replay ? null : "bound" }, nowMs);
  }
  if (!settingOn("executor.enabled")) return bareEnding(a, r, item, { status: "refused", code: "off", error: "the executor was switched off before it ran" }, nowMs);
  if (a.action === "deploy") return bareEnding(a, r, item, { status: "refused", code: "unsupported", error: "deploy is a disabled seam in v1" }, nowMs);
  if (!settingOn(`executor.${a.action}`, a.workspace_id)) return bareEnding(a, r, item, { status: "refused", code: "action_off", error: `${a.action} was switched off before it ran` }, nowMs);
  if (!r || !item || item.request_id !== r.id) return bareEnding(a, r, item, { status: "refused", code: "not_found", error: "the request or its decision item is gone" }, nowMs);
  // The wall: the request is still in the workspace the yes was given in.
  if ((r.workspace_id ?? null) !== (a.workspace_id ?? null)) return bareEnding(a, r, item, { status: "refused", code: "wall", error: "the request is not in the workspace the yes was given in" }, nowMs);
  if (item.status !== "decided" || item.decision !== "yes") return bareEnding(a, r, item, { status: "refused", code: "not_approved", error: `the item is ${item.status}${item.decision ? ` (${item.decision})` : ""}` }, nowMs);
  if (item.target_hash !== a.target_hash) return bareEnding(a, r, item, { status: "refused", code: "moved", error: "the item was re-bound to another version after the yes" }, nowMs);
  const d = item.deliverable_id ? requests.deliverable(item.deliverable_id) : undefined;
  if (!d || d.request_id !== r.id || d.ref !== a.target_ref) return bareEnding(a, r, item, { status: "refused", code: "not_found", error: "the deliverable the yes named is gone" }, nowMs);
  if (FINAL_DELIVERABLE.has(d.state)) return bareEnding(a, r, item, { status: "refused", code: "already", error: `it is already ${d.state}` }, nowMs);
  const ws = r.workspace_id ? workspaces.get(r.workspace_id) : undefined;
  if (!ws || ws.archived) return bareEnding(a, r, item, { status: "refused", code: "no_workspace", error: "a merge or a send runs under a workspace's own identity; this request has none (or it is archived)" }, nowMs);
  const c: Ctx = { a, r, item, d, ws, nowMs };
  try {
    return a.action === "merge_pr" ? await runMerge(c) : await runSend(c);
  } catch (e) {
    return conclude(c, { status: "failed", code: a.action === "merge_pr" ? "gh_failed" : "send_failed", error: errText(e), reraise: "bound" });
  }
}

async function runMerge(c: Ctx): Promise<Execution> {
  const url = c.d.ref;
  if (!PR_URL.test(url)) return conclude(c, { status: "refused", code: "not_pr", error: `not a GitHub PR link: ${url}` });
  const own = prBelongsTo(c.ws.id, url);
  if (!own.ok) return conclude(c, { status: "refused", code: "wall", error: `that PR is not this workspace's: ${own.why}` });
  const gate = checksGate(c.r.kind, c.d.id, c.a.target_hash, requests.checks(c.r.id), String(setting("executor.no_checks", c.ws.id)), c.a.override);
  if (!gate.ok) return conclude(c, { status: "refused", code: gate.code, error: gate.why, reraise: "bound" });
  // The workspace's own GitHub identity: its token or gh login dir, else the login its agents use too.
  const env = childEnv(c.ws);
  const cwd = os.homedir();
  let v: any;
  try {
    v = JSON.parse(await gh(["pr", "view", url, "--json", "state,isDraft,headRefOid,url"], { cwd, env }));
  } catch (e) {
    return conclude(c, { status: "failed", code: "read_failed", error: errText(e), reraise: "bound", override: gate.override });
  }
  const live = typeof v?.headRefOid === "string" ? v.headRefOid : null;
  const state = String(v?.state ?? "").toUpperCase();
  if (state === "MERGED") return conclude(c, { status: "refused", code: "already", error: "GitHub says it is already merged", live, settle: "merged" });
  if (state === "CLOSED") return conclude(c, { status: "refused", code: "not_open", error: "the PR is closed on GitHub", live, settle: "closed" });
  if (state !== "OPEN") return conclude(c, { status: "refused", code: "not_open", error: `GitHub says the PR is ${state || "in an unknown state"}`, live, reraise: "bound" });
  if (v?.isDraft) return conclude(c, { status: "refused", code: "draft_pr", error: "the PR is a draft on GitHub", live, reraise: "bound" });
  if (!live || live !== c.a.target_hash) {
    return conclude(c, { status: "refused", code: "moved", error: `GitHub's head is ${live ?? "unknown"}; the yes was for ${c.a.target_hash}`, live, reraise: "unbound" });
  }
  const method = String(setting("executor.merge_method", c.ws.id) || "squash");
  // --match-head-commit: GitHub itself refuses the merge if the head moved after the read above.
  const args = ["pr", "merge", url, `--${method}`, "--match-head-commit", c.a.target_hash];
  const ran = `gh ${args.join(" ")}`;
  try {
    await gh(args, { cwd, env });
  } catch (e) {
    const msg = errText(e);
    const moved = /head (branch )?(was )?modified|expected head|head sha|match.?head/i.test(msg);
    return conclude(c, { status: "failed", code: moved ? "moved" : "gh_failed", error: msg, live, ran, reraise: moved ? "unbound" : "bound", override: gate.override });
  }
  let after: any = null;
  try { after = JSON.parse(await gh(["pr", "view", url, "--json", "state,mergeCommit"], { cwd, env })); } catch { /* the merge ran; the re-read is a courtesy */ }
  if (String(after?.state ?? "").toUpperCase() === "MERGED") {
    return conclude(c, { status: "done", code: "merged", live, ran, settle: "merged", result: { merge_commit: after?.mergeCommit?.oid ?? null }, override: gate.override });
  }
  return conclude(c, { status: "queued", code: "queued", error: "GitHub accepted the merge but has not merged it yet (a merge queue or a pending requirement)", live, ran, result: { state: after?.state ?? null }, override: gate.override });
}

async function runSend(c: Ctx): Promise<Execution> {
  const channel: LiveDraft["channel"] | null = c.d.kind === "email_draft" ? "email" : c.d.kind === "slack_draft" ? "slack" : null;
  if (!channel) return conclude(c, { status: "refused", code: "not_found", error: `not a draft: ${c.d.kind}` });
  const sender = senders[channel];
  const why = sender.unavailable(c.ws);
  // Nothing he can fix by saying yes again: no new question, the yes stays recorded, he sends it himself.
  if (why) return conclude(c, { status: "refused", code: "no_sender", error: why });
  let live: LiveDraft | null;
  try {
    live = await sender.read(c.d, c.ws);
  } catch (e) {
    return conclude(c, { status: "failed", code: "read_failed", error: errText(e), reraise: "bound" });
  }
  if (!live) return conclude(c, { status: "refused", code: "gone", error: "the provider has no such draft any more" });
  const hash = draftHash({ channel: live.channel, to: live.to, subject: live.subject, text: live.text });
  if (live.channel !== channel || hash !== c.a.target_hash) {
    return conclude(c, { status: "refused", code: "moved", error: "the draft's words, recipient or channel are not the ones you approved", live: hash, reraise: "unbound" });
  }
  const ran = `${channel} sender: send the draft to ${live.to}`;
  try {
    const out = await sender.send(c.d, live, c.ws);
    return conclude(c, { status: "done", code: "sent", live: hash, ran, settle: "sent", result: { id: out.id } });
  } catch (e) {
    return conclude(c, { status: "failed", code: "send_failed", error: errText(e), live: hash, ran, reraise: "bound" });
  }
}

/** An ending before the context is whole (the claim, a switch, a vanished row): logged and said, nothing else moves unless asked. */
function bareEnding(a: Approval, r: RequestRow | undefined, item: DecisionItem | undefined, e: Ending, nowMs: number): Execution {
  const d = item?.deliverable_id ? requests.deliverable(item.deliverable_id) : undefined;
  if (r && item && d && d.request_id === r.id) {
    const ws = r.workspace_id ? workspaces.get(r.workspace_id) : undefined;
    if (ws) return conclude({ a, r, item, d, ws, nowMs }, e);
  }
  executorStore.finish(a.id, e.status);
  executorStore.log({ ...logBase(a), live_hash: null, ran: null, status: e.status, code: e.code, error: e.error ?? null });
  const execution: Execution = { approval_id: a.id, action: a.action, status: e.status, code: e.code, error: e.error ?? null, target_ref: a.target_ref, approved_hash: a.target_hash, live_hash: null, ran: null, result: null, reraised_item: null, say: sayFor(a.action, e.status, e.code) };
  if (r && item) publish(r, item, execution);
  return execution;
}

const logBase = (a: Approval) => ({
  approval_id: a.id, request_id: a.request_id, decision_id: a.decision_id, workspace_id: a.workspace_id, action: a.action,
  approved_by: a.approved_by, surface: a.surface, how: a.how, words: a.transcript, target_ref: a.target_ref,
  approved_hash: a.target_hash, override: a.override,
});

/** Every ending: the approval's result, the log row, the ledger (settled, or asked again), the terminal, the bus. */
function conclude(c: Ctx, e: Ending): Execution {
  executorStore.finish(c.a.id, e.status);
  executorStore.log({
    ...logBase(c.a), live_hash: e.live ?? null, ran: e.ran ?? null, status: e.status, code: e.code, error: e.error ?? null,
    override: e.override ?? c.a.override,
  });
  if (e.settle) settleDeliverable(c.d.id, e.settle, c.nowMs);
  const reraised = e.reraise ? raiseAgain(c, WHY[e.code]?.en ?? e.code, e.reraise === "unbound") : null;
  if (e.status === "done" && c.d.session_id && sessions.get(c.d.session_id)?.status === "live") {
    tell(c.d.session_id, c.a.action === "merge_pr"
      ? `The operator said yes and the executor merged ${c.d.ref} at ${c.a.target_hash.slice(0, 7)}. Do not merge it again, and do not deploy unless he asks.`
      : `The operator said yes and the executor sent the ${c.d.kind === "email_draft" ? "email" : "Slack"} draft (${c.d.label ?? c.d.ref}). Do not send it again.`);
  }
  recompute(c.r.id, c.nowMs);
  const execution: Execution = {
    approval_id: c.a.id, action: c.a.action, status: e.status, code: e.code, error: e.error ?? null, target_ref: c.a.target_ref,
    approved_hash: c.a.target_hash, live_hash: e.live ?? null, ran: e.ran ?? null, result: e.result ?? null, reraised_item: reraised,
    say: sayFor(c.a.action, e.status, e.code),
  };
  publish(c.r, c.item, execution);
  return execution;
}

/**
 * A yes that could not be carried out, when a later yes could be: a fresh item asks him again, and the
 * spent one is retired (its answer stays on the row). `unbound`: what he approved is no longer there —
 * the deliverable loses its target too, so no yes goes through until the verifier binds the new version.
 */
function raiseAgain(c: Ctx, why: string, unbound: boolean): string | null {
  if (unbound) requests.bindTarget(c.d.id, null);
  const d = requests.deliverable(c.d.id);
  if (!d || FINAL_DELIVERABLE.has(d.state)) return null;
  const { item } = requests.upsertItem({
    request_id: c.r.id, action: c.item.action, label: `${(d.label || d.ref).slice(0, 200)} — ${why}`.slice(0, 300),
    item_key: `${c.item.action}|${d.id}|retry:${c.a.id}`, deliverable_id: d.id, target_hash: d.target_hash, source_at: iso(c.nowMs),
  });
  requests.retire(c.item.id, item.id);
  return item.id;
}

function publish(r: RequestRow, item: DecisionItem, x: Execution): void {
  bus.publish({
    topic: "executor.result", request_id: r.id, item_id: item.id, approval_id: x.approval_id, workspace_id: r.workspace_id,
    action: x.action, status: x.status, code: x.code, say: x.say, actor: "executor",
  });
}

// ───────────────────────────── boot, status ─────────────────────────────

/** At boot: an approval nobody used died with the process that was about to run it. Void, logged, never run late. */
export function startExecutor(nowMs = Date.now()): number {
  const voided = executorStore.voidUnused(iso(nowMs));
  for (const a of voided) {
    executorStore.log({ ...logBase(a), live_hash: null, ran: null, status: "void", code: "restart", error: "the daemon restarted before it ran — say it again" });
  }
  return voided.length;
}

/** What the executor would do now, for a workspace (or the defaults): the phone reads it to know whether to type an approval line. */
export function executorStatus(wsId?: string | null) {
  const ws = wsId ? workspaces.get(wsId) : undefined;
  return {
    enabled: settingOn("executor.enabled"),
    ttl_minutes: Number(setting("executor.ttl_minutes")),
    actions: {
      merge_pr: { on: settingOn("executor.merge_pr", wsId ?? null), merge_method: String(setting("executor.merge_method", wsId ?? null)), no_checks: String(setting("executor.no_checks", wsId ?? null)) },
      send_draft: {
        on: settingOn("executor.send_draft", wsId ?? null),
        senders: Object.fromEntries((Object.keys(senders) as LiveDraft["channel"][]).map((ch) => [ch, ws ? senders[ch].unavailable(ws) ?? "ready" : DEFAULT_SENDERS[ch] === senders[ch] ? "none" : "set"])),
      },
      deploy: { on: false, why: "not in v1 — a deploy will need its own yes each time" },
    },
  };
}
