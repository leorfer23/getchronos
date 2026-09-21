import { humanizeStep, type RobertStep } from "../robert-steps.js";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { noteClaudeStreamEvent } from "../usage-meter.js";
import { CONFIG } from "../config.js";
import { bus, type BusEvent } from "../bus.js";
import { agentChat, chat as chatLog, kv, workspaces } from "../store.js";
import { getBackend } from "../backends/index.js";
import { sandboxWrap, type SandboxMode } from "../sandbox.js";
import { agentContext } from "../skills.js";
import { agentMemoryBlock, agentMemoryStamp } from "../agent-memory.js";
import { briefsBlock, briefStamp } from "../briefs.js";
import { fleetLine } from "../fleet-line.js";
import { describeTool } from "../focus.js";
import { isAuthError, isProviderLimitError, withProviderFallback } from "../manager-fallback.js";
import { agentDef, agentPrompt } from "../agent-defs.js";
import { widgetPromptBlock } from "../widgets/index.js";
import { askLine, commitTurn, resolveTurn, type Route } from "../thread-router.js";
import { send, sendChatAction, esc } from "./api.js";
import { kb, type Btn } from "./keyboards.js";
import { getActiveExec } from "./active-exec.js";
import { watchRun } from "./ticker.js";

const liveChildren = new Set<ChildProcess>();
process.on("exit", () => { for (const c of liveChildren) { try { c.kill("SIGTERM"); } catch {} } });

// Robert speaks through two surfaces with different authority — propose-and-confirm on Telegram,
// execute-directly on the desk/voice/board. Both prompts, and the shared catalogs they are built
// from, live in agents/robert/ and agents/_blocks/ (see src/agent-defs.ts).
const robertPrompt = (surface: "telegram" | "web") => agentPrompt("robert", surface);

// ── Tiered mutation protocol ─────────────────────────────────────────────────
// The manager persona is prompt-level: the agent is TOLD to only read and to PROPOSE mutations. Enforcement
// is that its tools are already capped (no CHRONOS_ADMIN + budget) — acceptable for a single-operator daemon.
// A PROPOSE line is lifted out here and TIERED: a proposal whose every item matches SAFE_MUTATIONS executes
// immediately with a ⚡ receipt; anything else is shown as a confirm card and executed only on ✅.

export type ProposalItem = { method: string; path: string; body?: unknown };
export type Proposal = { label: string; method?: string; path?: string; body?: unknown; batch?: ProposalItem[] };
export type ProposalScan = {
  reply: string;         // agent text with a trailing PROPOSE line stripped
  proposal?: Proposal;   // parsed + allowlisted
  raw?: string;          // the raw PROPOSE line, when one was present
  error?: string;        // malformed JSON or allowlist rejection
};

// Robert's toolbelt wherever he runs: Bash+Read drive the API, Grep/Glob search repos without
// spawning `find`, WebSearch/WebFetch answer "what's current" questions with sources. Still no
// Write/Edit — hands-on building is the workforce's job, and the persona says so. Declared with the
// rest of him in agents/robert/AGENT.md, so the toolbelt and the prompt describing it sit together.
const MANAGER_TOOLS = agentDef("robert").tools ?? "Bash,Read";

const MUT_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const PROPOSE_RE = /^PROPOSE\s+(\{.*\})\s*$/;

// Batch prior-item refs: {{0.id}} → top-level JSON field from item 0's response. Invented
// placeholders ({{foo}}, {{0.a.b}}) used to sail through as literal URL segments, 400 as
// "ticket not found", and still get a green ⚡ Executed receipt (PER-16). Only prior indices,
// only one-level fields — resolve at fire time; reject everything else at scan time.
const PLACEHOLDER_ANY_RE = /\{\{[^}]*\}\}/g;
const PLACEHOLDER_REF_RE = /^\{\{(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/;
const PLACEHOLDER_RESOLVE_RE = /\{\{(\d+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Path + body text a placeholder scan covers. */
function itemPlaceholderSurface(it: { path?: string; body?: unknown }): string {
  let s = typeof it?.path === "string" ? it.path : "";
  if (it?.body !== undefined) {
    try { s += JSON.stringify(it.body); } catch { /* non-JSON body already fails elsewhere */ }
  }
  return s;
}

/**
 * Validate {{…}} in an item. `itemIndex` is the 0-based position in a batch, or null for a
 * single (non-batch) proposal — refs only make sense after a prior batch item has run.
 */
export function checkPlaceholders(it: { path?: string; body?: unknown }, itemIndex: number | null): string | null {
  const surface = itemPlaceholderSurface(it);
  const found = surface.match(PLACEHOLDER_ANY_RE);
  if (!found) return null;
  for (const raw of found) {
    const m = raw.match(PLACEHOLDER_REF_RE);
    if (!m) return `unsupported placeholder ${raw} (use {{N.field}} for a prior batch item's response field)`;
    if (itemIndex === null) return `placeholder ${raw} only valid inside a batch`;
    const n = Number(m[1]);
    if (n >= itemIndex) {
      return `placeholder ${raw} references item ${n} which has not run yet (current is item ${itemIndex})`;
    }
  }
  return null;
}

/** Substitute {{N.field}} using prior batch responses. Throws on missing/non-scalar fields. */
export function applyBatchRefs(it: ProposalItem, priors: unknown[]): ProposalItem {
  const resolve = (template: string): string =>
    template.replace(PLACEHOLDER_RESOLVE_RE, (_full, nStr: string, field: string) => {
      const n = Number(nStr);
      const prior = priors[n];
      if (prior == null || typeof prior !== "object" || Array.isArray(prior)) {
        throw new Error(`{{${n}.${field}}}: no object response from item ${n}`);
      }
      const v = (prior as Record<string, unknown>)[field];
      if (v === undefined || v === null) {
        throw new Error(`{{${n}.${field}}}: field missing on item ${n} response`);
      }
      if (typeof v === "object") {
        throw new Error(`{{${n}.${field}}}: field is not a scalar`);
      }
      return String(v);
    });
  const path = resolve(it.path);
  if (it.body === undefined) return { ...it, path };
  // Walk via JSON so nested string values (and keys, if ever needed) pick up the same refs.
  const body = JSON.parse(resolve(JSON.stringify(it.body)));
  return { ...it, path, body };
}

// Allowlist guard: only /api/ paths with a mutating method may ever reach a confirm card.
function checkOne(it: any, itemIndex: number | null = null): string | null {
  const method = String(it?.method || "").toUpperCase();
  if (!MUT_METHODS.has(method)) return `method ${it?.method} not allowed (POST/PATCH/DELETE only)`;
  if (typeof it?.path !== "string" || !it.path.startsWith("/api/")) return `path ${it?.path} not allowed (/api/ only)`;
  it.method = method;
  const ph = checkPlaceholders(it, itemIndex);
  if (ph) return ph;
  return null;
}
function checkProposal(p: any): string | null {
  if (!p || typeof p !== "object") return "invalid proposal";
  if (Array.isArray(p.batch)) {
    if (!p.batch.length) return "empty batch";
    for (let i = 0; i < p.batch.length; i++) {
      const e = checkOne(p.batch[i], i);
      if (e) return e;
    }
    return null;
  }
  return checkOne(p, null);
}

// Safe tier — reversible, non-destructive daily-drive actions that auto-execute without a tap.
// Risky-by-default: an endpoint not listed here always gets the confirm card, so new API surface
// never auto-executes by accident. Never add DELETE, kill, continue/take-over, review verdicts,
// recovery decisions, workspace/repo/job config, or /sessions/:id/input (typing into another agent's
// terminal in the operator's name) — those stay on the operator's ✅.
const SAFE_MUTATIONS: Array<{ method: string; re: RegExp }> = [
  { method: "POST", re: /^\/api\/tickets$/ },
  { method: "POST", re: /^\/api\/tickets\/[^/]+\/(note|dispatch|dispatch-plan|plan|dispatch-grade|grade|links|attachments)$/ },
  // Retitle / reprioritise / move a ticket's status. Nothing here leaves the house — the tracker
  // push endpoints (push-comment, push-status, merge-pr) are outward-facing and stay on the ✅.
  { method: "PATCH", re: /^\/api\/tickets\/[^/]+$/ },
  { method: "POST", re: /^\/api\/jobs\/[^/]+\/run$/ },
  { method: "POST", re: /^\/api\/sessions$/ },
  { method: "POST", re: /^\/api\/sessions\/[^/]+\/(resume|wait)$/ },
  { method: "POST", re: /^\/api\/runs\/[^/]+\/wait$/ },
  // Talking to a live worker (steer) and tracking its steps: same class as `mc tell`, and a run
  // that is already running is not a new commitment.
  { method: "POST", re: /^\/api\/runs\/[^/]+\/steer$/ },
  { method: "POST", re: /^\/api\/runs\/[^/]+\/steps(\/\d+)?$/ },
  { method: "POST", re: /^\/api\/agents\/[^/]+\/(name|report|seen|wait|memory)$/ },
  { method: "POST", re: /^\/api\/asks$/ },
  { method: "POST", re: /^\/api\/asks\/[^/]+\/answer$/ },
  { method: "POST", re: /^\/api\/messages$/ },
  { method: "POST", re: /^\/api\/board$/ },
  { method: "POST", re: /^\/api\/reviews\/[^/]+\/dispatch-review$/ },
  { method: "POST", re: /^\/api\/notes$/ },
  { method: "PATCH", re: /^\/api\/notes\/[^/]+$/ },
  { method: "POST", re: /^\/api\/lessons$/ },
  { method: "POST", re: /^\/api\/calendars\/refresh$/ },
  { method: "POST", re: /^\/api\/workspaces\/[^/]+\/(learn|ideas|sync|brief|worklog)$/ },
  // Plan tomorrow opens read-only planner terminals and files cards on the Desk. Nothing leaves the
  // house and nothing is committed to — the operator still presses ▶ on every card.
  { method: "POST", re: /^\/api\/nextday$/ },
];

export function isSafeProposal(p: Proposal): boolean {
  const items: ProposalItem[] = p.batch ?? [p as ProposalItem];
  return items.every((it) => {
    const path = (it.path ?? "").split("?")[0];
    return SAFE_MUTATIONS.some((r) => r.method === it.method && r.re.test(path));
  });
}

// Lift a trailing `PROPOSE {json}` line off the agent reply. Only the LAST non-empty line counts — a PROPOSE
// mid-text is left as-is. Malformed JSON or a rejected path/method returns {error} and never yields a proposal.
export function scanProposal(text: string): ProposalScan {
  const lines = (text ?? "").split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return { reply: text ?? "" };
  const m = lines[i].trim().match(PROPOSE_RE);
  if (!m) return { reply: text ?? "" };
  const raw = lines[i].trim();
  const reply = lines.slice(0, i).join("\n").trimEnd();
  let parsed: any;
  try { parsed = JSON.parse(m[1]); } catch { return { reply, raw, error: "couldn't parse proposal" }; }
  const err = checkProposal(parsed);
  if (err) return { reply, raw, error: err };
  return { reply, proposal: parsed as Proposal };
}

// Pending proposals awaiting a ✅/❌ tap. Same lazy-read / write-through pattern as chat sessions
// below — an in-memory-only Map died on every `npm run deploy`, so a late ✅ after a merge got
// "proposal expired" even though nothing had timed out. TTL is the real safety valve: a late tap
// must not fire a mutation decided days ago. Cap is FIFO; eviction notifies instead of silent drop.
type PendingEntry = { proposal: Proposal; createdAt: number; chat: number };
type GoneReason = "cap" | "ttl";
type GoneEntry = { reason: GoneReason; at: number };

const PROPOSALS_KV = "tg.proposals";
const pending = new Map<string, PendingEntry>();
const gone = new Map<string, GoneEntry>(); // short memory so a late ✅ names the real cause
let proposalsHydrated = false;

function proposeCap(): number {
  const n = CONFIG.telegram.proposalCap;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}
function proposeTtlMs(): number {
  const n = CONFIG.telegram.proposalTtlMs;
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000;
}
function ttlLabel(): string {
  const h = Math.round(proposeTtlMs() / 3_600_000);
  return h >= 1 ? `${h}h` : `${Math.round(proposeTtlMs() / 60_000)}m`;
}

function hydrateProposals(): void {
  if (proposalsHydrated) return;
  proposalsHydrated = true;
  const raw = kv.get(PROPOSALS_KV);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as {
      pending?: Array<[string, PendingEntry]>;
      gone?: Array<[string, GoneEntry]>;
    };
    for (const [id, e] of parsed.pending ?? []) {
      if (e?.proposal && typeof e.createdAt === "number") pending.set(id, e);
    }
    for (const [id, g] of parsed.gone ?? []) {
      if (g?.reason) gone.set(id, g);
    }
  } catch {
    // Corrupt blob — start fresh rather than crash the bot on every message.
  }
}

function persistProposals(): void {
  kv.set(
    PROPOSALS_KV,
    JSON.stringify({
      pending: [...pending.entries()],
      gone: [...gone.entries()],
    }),
  );
}

function rememberGone(id: string, reason: GoneReason, now = Date.now()): void {
  gone.set(id, { reason, at: now });
  // Bound the tombstone map so it cannot grow without limit across deploys.
  while (gone.size > proposeCap() * 2) gone.delete(gone.keys().next().value!);
}

/** Drop TTL-expired pending entries. Called on daemon boot and before each put/take. */
export function purgeExpiredProposals(now = Date.now()): number {
  hydrateProposals();
  const ttl = proposeTtlMs();
  let n = 0;
  for (const [id, e] of pending) {
    if (now - e.createdAt > ttl) {
      pending.delete(id);
      rememberGone(id, "ttl", now);
      n++;
    }
  }
  // Tombstones older than 2× TTL are useless — the operator has moved on.
  let goneTrimmed = false;
  for (const [id, g] of gone) {
    if (now - g.at > ttl * 2) {
      gone.delete(id);
      goneTrimmed = true;
    }
  }
  if (n || goneTrimmed) persistProposals();
  return n;
}

export type PutProposalResult = {
  id: string;
  /** Oldest entry dropped to stay under the FIFO cap — caller should tell the operator. */
  discarded?: { id: string; label: string; chat: number };
};

export function putProposal(p: Proposal, chat: number, now = Date.now()): PutProposalResult {
  purgeExpiredProposals(now);
  const id = randomUUID().slice(0, 8);
  let discarded: PutProposalResult["discarded"];
  const cap = proposeCap();
  if (pending.size >= cap) {
    const oldId = pending.keys().next().value!;
    const old = pending.get(oldId)!;
    pending.delete(oldId);
    rememberGone(oldId, "cap", now);
    discarded = { id: oldId, label: old.proposal.label || "action", chat: old.chat };
  }
  pending.set(id, { proposal: p, createdAt: now, chat });
  gone.delete(id);
  persistProposals();
  return discarded ? { id, discarded } : { id };
}

export function dismissProposal(id: string): boolean {
  hydrateProposals();
  const ok = pending.delete(id);
  if (ok) persistProposals();
  return ok;
}

export type TakeProposalResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: "ttl" | "cap" | "restart" };

/** Look up + consume a pending proposal, naming why it's missing when it is. */
export function takeProposal(id: string, now = Date.now()): TakeProposalResult {
  purgeExpiredProposals(now);
  const e = pending.get(id);
  if (e) {
    if (now - e.createdAt > proposeTtlMs()) {
      pending.delete(id);
      rememberGone(id, "ttl", now);
      persistProposals();
      return { ok: false, reason: "ttl" };
    }
    pending.delete(id);
    persistProposals();
    return { ok: true, proposal: e.proposal };
  }
  const g = gone.get(id);
  if (g?.reason === "ttl") return { ok: false, reason: "ttl" };
  if (g?.reason === "cap") return { ok: false, reason: "cap" };
  // Not in kv and no tombstone → died with the previous in-memory Map (pre-fix cards), or
  // already executed/dismissed. Same operator-facing cause either way: it isn't here after a restart.
  return { ok: false, reason: "restart" };
}

export function proposalGoneMessage(reason: "ttl" | "cap" | "restart"): string {
  if (reason === "ttl") return `⚠️ proposal expired (timed out after ${ttlLabel()})`;
  if (reason === "cap") return `⚠️ proposal discarded (pending limit of ${proposeCap()} reached) — ask again if you still want it`;
  return "⚠️ proposal gone — lost on a daemon restart (or already handled)";
}

/** Test/harness: clear memory + kv so cases don't leak across the shared module Map. */
export function resetPendingProposalsForTest(): void {
  pending.clear();
  gone.clear();
  proposalsHydrated = false;
  kv.del(PROPOSALS_KV);
}

/** Test/harness: drop the in-memory cache only — next access rehydrates from kv (simulates restart). */
export function unloadPendingProposalsForTest(): void {
  pending.clear();
  gone.clear();
  proposalsHydrated = false;
}

export const proposalCard = (p: Proposal) =>
  p.batch
    ? `🅿️ <b>${esc(p.label)}</b>\n<pre>${esc(p.batch.map((it) => `${it.method} ${it.path}`).join("\n").slice(0, 900))}</pre>`
    : `🅿️ <b>${esc(p.label)}</b>\n<code>${esc(p.method!)} ${esc(p.path!)}</code>` +
      (p.body !== undefined ? `\n<pre>${esc(JSON.stringify(p.body).slice(0, 500))}</pre>` : "");
export const proposalKb = (id: string) =>
  kb([[{ text: "✅ Execute", data: `px.x.${id}` }, { text: "❌ Dismiss", data: `px.d.${id}` }]]);

/**
 * Telegram is the operator's phone. Robert's PROPOSE body often stamps by:"robert", which 403s on
 * ask_policy=escalate and leaves the worker parked forever while the chat log still said
 * "⚡ Executed". Stamping by:"telegram" makes the escalate gate see a human action — this
 * surface IS the human path (SAFE auto-exec = the operator pre-authorized the class; ✅ = explicit).
 */
export function stampTelegramAskAnswer(it: ProposalItem): ProposalItem {
  const path = (it.path ?? "").split("?")[0];
  if (!/^\/api\/asks\/[^/]+\/answer$/.test(path)) return it;
  const prev = typeof it.body === "object" && it.body !== null && !Array.isArray(it.body) ? (it.body as Record<string, unknown>) : {};
  return { ...it, body: { ...prev, by: "telegram" } };
}

async function fire(it: ProposalItem) {
  const stamped = stampTelegramAskAnswer(it);
  // The ✅ tap from the claimed operator chat IS the authorization — send the admin header
  // unconditionally rather than hand-mirroring api.ts's requireAdmin route list (drift risk).
  const res = await fetch(`http://localhost:${CONFIG.port}${stamped.path}`, {
    method: stamped.method,
    headers: { "content-type": "application/json", "x-mc-admin": CONFIG.adminToken },
    ...(stamped.body !== undefined ? { body: JSON.stringify(stamped.body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}
const tagOf = (json: any): string =>
  json?.key ?? (json?.id ? String(json.id).slice(0, 8) : json?.run_id ? String(json.run_id).slice(0, 8) : "");

// Sequential batch: stop on first failure, receipt names what succeeded and where it broke.
// Prior JSON bodies feed {{N.field}} substitution so create-then-plan can use {{0.id}}.
async function execBatch(p: Proposal, chat: number, icon: ExecIcon): Promise<boolean> {
  const done: string[] = [];
  const priors: unknown[] = [];
  for (let n = 0; n < p.batch!.length; n++) {
    let item: ProposalItem;
    try { item = applyBatchRefs(p.batch![n], priors); }
    catch (e: any) {
      await send(chat, batchReceipt(done, icon, { item: n + 1, err: String(e?.message ?? e) }));
      return false;
    }
    let res: Response, json: any;
    try { ({ res, json } = await fire(item)); }
    catch (e: any) {
      await send(chat, batchReceipt(done, icon, { item: n + 1, err: String(e?.message ?? e) }));
      return false;
    }
    if (!res.ok) {
      await send(chat, batchReceipt(done, icon, { item: n + 1, err: String(json?.error ?? `HTTP ${res.status}`) }));
      return false;
    }
    priors.push(json);
    const t = tagOf(json); if (t) done.push(t);
  }
  await send(chat, batchReceipt(done, icon));
  return true;
}
function batchReceipt(done: string[], icon: ExecIcon, failed?: { item: number; err: string }) {
  const ok = done.length ? `${icon} created ${done.map(esc).join(", ")}` : "";
  const fail = failed ? `❌ failed on item ${failed.item}: ${esc(failed.err)}` : "";
  return [ok, fail].filter(Boolean).join(" · ") || `${icon} done`;
}

// Shared by the ✅ tap and the safe-tier auto path; the icon on the receipt says which one ran.
type ExecIcon = "✅" | "⚡";
// The detached-batch bug this ticket's branch also found (`return void execBatch(...)` resolved
// before later items ran) was fixed independently by PER-15, which additionally made the whole
// chain return boolean. Keeping main's version; the tests below still pin the behavior.
async function execute(p: Proposal, chat: number, icon: ExecIcon): Promise<boolean> {
  if (p.batch) return execBatch(p, chat, icon);
  let res: Response, json: any;
  try { ({ res, json } = await fire(p as ProposalItem)); }
  catch (e: any) {
    await send(chat, "⚠️ " + esc(String(e?.message ?? e)));
    return false;
  }
  if (!res.ok) {
    await send(chat, `⚠️ ${esc(p.method!)} ${esc(p.path!)} → ${esc(String(json?.error ?? `HTTP ${res.status}`))}`);
    return false;
  }
  if (json?.run_id) {
    void watchRun(json.run_id, chat, p.label); // creates+dispatches → live ticker
    return true;
  }
  const tag = tagOf(json);
  await send(chat, `${icon} ${esc(p.label)}${tag ? ` <code>${esc(tag)}</code>` : ""}`);
  return true;
}

// ✅ handler: Telegram executes the proposal against the local API and reports the result.
// Returns false when the card is gone (ttl/cap/restart) or execute fails — callers (desk chat
// log, PER-15) need the real outcome, not a silent void.
export async function execProposal(id: string, chat: number): Promise<boolean> {
  const taken = takeProposal(id);
  if (!taken.ok) {
    await send(chat, proposalGoneMessage(taken.reason));
    return false;
  }
  return execute(taken.proposal, chat, "✅");
}

// Safe tier: no pending entry, no card — straight to the API, ⚡ on the receipt.
export const autoExecProposal = (p: Proposal, chat: number): Promise<boolean> => execute(p, chat, "⚡");

// Routing fork after scanProposal: SAFE_MUTATIONS auto-fire; everything else waits for a ✅ tap.
// Exported so tests can exercise the tier decision without driving the full agent-spawn stack —
// this fork decides whether an action needs a human at all, and was previously untested (PER-10).
//
// `auto-failed` is its own outcome on purpose: a safe action that fired and FAILED used to still
// log "⚡ Executed" in the desk chat while the ask stayed open (PER-15).
export type ProposalTier = "auto" | "auto-failed" | "card";

export async function tierProposal(p: Proposal, chat: number, msgId?: number): Promise<ProposalTier> {
  if (isSafeProposal(p)) {
    // Safe tier: execute now; the ⚡ receipt (or ⚠️ error) is the only confirmation.
    return (await autoExecProposal(p, chat)) ? "auto" : "auto-failed";
  }
  const { id: pid, discarded } = putProposal(p, chat);
  if (discarded) {
    // Cap is FIFO and silent drops made pending cards mysteriously unusable — tell the operator
    // which label was sacrificed so they can re-ask if it still matters (PER-21).
    void send(
      discarded.chat,
      `⚠️ proposal discarded (pending limit of ${proposeCap()} reached): <b>${esc(discarded.label)}</b> — ask again if you still want it`,
    );
  }
  await send(chat, proposalCard(p), proposalKb(pid), msgId);
  return "card";
}

// chatId -> claude session id (conversation memory). Cache over the kv table (lazy-read,
// write-through) so a resumed conversation survives a daemon restart.
const chatSessions = new Map<number, string>();
function getChatSession(chat: number): string | undefined {
  if (chatSessions.has(chat)) return chatSessions.get(chat);
  const v = kv.get(`tg.session.${chat}`);
  if (v) chatSessions.set(chat, v);
  return v;
}
function setChatSession(chat: number, sessionId: string) {
  chatSessions.set(chat, sessionId);
  kv.set(`tg.session.${chat}`, sessionId);
}
function clearChatSession(chat: number) {
  chatSessions.delete(chat);
  kv.del(`tg.session.${chat}`);
}

const MAX_ASKS = 3; // ponytail: single global cap; single-operator daemon, per-chat would be the same

type Ask = { id: string; chat: number; prompt: string; msgId: number; child?: ChildProcess; warm?: WarmManager; aborted?: boolean };
const asks = new Map<string, Ask>();
let askSeq = 0;

export const asksForChat = (chat: number) => [...asks.values()].filter((a) => a.chat === chat);

// Typing indicator kept alive while any ask for the chat is live.
const typingTimers = new Map<number, NodeJS.Timeout>();
function ensureTyping(chat: number) {
  if (typingTimers.has(chat)) return;
  void sendChatAction(chat);
  const t = setInterval(() => sendChatAction(chat), 5000);
  t.unref?.();
  typingTimers.set(chat, t);
}
function maybeStopTyping(chat: number) {
  if (asksForChat(chat).length) return;
  const t = typingTimers.get(chat);
  if (t) { clearInterval(t); typingTimers.delete(chat); }
}

// Abort buttons: first 40 chars of each prompt, indexed. `ab.k.<id>` kills one, `ab.all` kills all.
export function abortKb(list: Ask[]) {
  const rows: Btn[][] = list.map((a, i) => [{ text: `✕ ${a.prompt.slice(0, 40)} (#${i + 1})`, data: `ab.k.${a.id}` }]);
  if (list.length > 1) rows.push([{ text: "🛑 Abort all", data: "ab.all" }]);
  return kb(rows);
}

export function abortAsk(id: string): boolean {
  const a = asks.get(id);
  if (!a) return false;
  a.aborted = true;
  // Warm asks share the chat's persistent process: SIGKILL it and drop it from the map so the next
  // message respawns (resuming via the kv session id). One-shot children keep the SIGTERM behavior.
  if (a.warm) { a.warm.kill(); tgWarm.delete(a.chat); }
  else a.child?.kill("SIGTERM");
  return true;
}
export function abortAll(chat: number): number {
  const mine = asksForChat(chat);
  for (const a of mine) abortAsk(a.id);
  return mine.length;
}

// ── The routing question ─────────────────────────────────────────────────────────────────────────
// The router refuses to guess (two projects match, or a work request with nothing to go on). One
// line, the candidates as inline buttons, and the tip. The tap re-runs the ORIGINAL message on the
// chosen workspace — nothing was sent to any manager in the meantime, so nothing has to be undone.
const routeAsks = new Map<string, { chat: number; text: string; msgId: number; at: number }>();
const ROUTE_ASK_TTL_MS = 30 * 60 * 1000;
const ROUTE_ASK_CAP = 20;

function putRouteAsk(chat: number, text: string, msgId: number): string {
  for (const [k, v] of routeAsks) if (Date.now() - v.at > ROUTE_ASK_TTL_MS) routeAsks.delete(k);
  while (routeAsks.size >= ROUTE_ASK_CAP) routeAsks.delete(routeAsks.keys().next().value as string);
  const key = randomUUID().slice(0, 8);
  routeAsks.set(key, { chat, text, msgId, at: Date.now() });
  return key;
}

async function offerRoute(chat: number, text: string, msgId: number, r: Route) {
  const key = putRouteAsk(chat, text, msgId);
  // callback_data is capped at 64 bytes: ns.key.ws8, and "all" for fleet-wide.
  const btns = r.candidates.map((c) => ({ text: `#${c.slug}`, data: `tr.${key}.${c.ws ? c.ws.slice(0, 8) : "all"}` }));
  const rows: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  await send(chat, `${esc(askLine(r))}\n<i>${esc(r.why)}</i>`, kb(rows), msgId);
}

/** A tap on a routing question: re-run the message the operator already sent, on his choice. */
export async function answerRouteAsk(key: string, pick: string): Promise<boolean> {
  const pending = routeAsks.get(key);
  if (!pending) return false;
  routeAsks.delete(key);
  if (pick === "all") {
    void runAgent(pending.chat, pending.text, pending.msgId, { ws: null });
    return true;
  }
  const ws = workspaces.list().find((w) => w.id.startsWith(pick));
  if (!ws) return false; // archived or deleted between the question and the tap
  void runAgent(pending.chat, pending.text, pending.msgId, { ws: ws.id });
  return true;
}

// Resume semantics: the first ask in an idle chat runs on the chat's WARM persistent manager (resumes the
// stored session, survives daemon restarts/recycles); asks fired while others are live start FRESH one-shots
// (no --resume) and never overwrite the stored session id — so parallel asks don't interleave one --resume
// state. Stale-session recovery lives inside WarmManager (clears kv + respawns fresh).
export async function runAgent(chat: number, text: string, msgId: number, pick?: { ws: string | null }) {
  if (asks.size >= MAX_ASKS) {
    await send(chat, "⏳ 3 asks already running — /abort one or wait", abortKb(asksForChat(chat)), msgId);
    return;
  }
  const warm = asksForChat(chat).length === 0;
  const id = String(++askSeq);
  // WHICH conversation this continues, in order: a workspace the operator picked by hand (/conv, or
  // the chip on a routing question) → the thread router, which reads a #tag, a ticket key, a project
  // name or the thread's sticky workspace out of the message itself → the unscoped fleet thread.
  // Each workspace is a separate warm Robert on its own CLI session, so this choice IS the isolation.
  const turn = resolveTurn(text, {
    // A tap on a routing question (pick) is as explicit as /conv; pick.ws === null means the shop.
    selected: pick ? pick.ws : activeWsForChat(chat),
    route: pick ? false : undefined,
    surface: "telegram",
  });
  if (turn.ask) {
    await offerRoute(chat, text, msgId, turn.ask);
    return;
  }
  commitTurn("telegram", turn);
  const threadWs = turn.ws;
  const body = turn.text; // the #tag never reaches the model
  // Where it landed, when he did not say so himself — the thread is one, the conversations are not.
  const stamp = turn.ws && turn.how !== "tag" && turn.how !== "selected" ? `#${workspaces.get(turn.ws)?.slug ?? "?"} · ` : "";
  // Shared thread recap so web/brief history is available when the operator switches channels.
  const prompt = fleetLine(threadWs) + "\n\n" + (chatLog.contextBlock({ limit: 12, workspaceId: threadWs }) || "") + body;
  const ask: Ask = { id, chat, prompt, msgId };
  asks.set(id, ask);
  ensureTyping(chat);
  try {
    let reply: string;
    if (warm) {
      const m = threadWs ? warmForChatWs(chat, threadWs) : warmForChat(chat);
      ask.warm = m;
      const tgKey = threadWs ? `tg:${chat}:${threadWs}` : `tg:${chat}`;
      reply = await withProviderFallback({
        key: tgKey,
        primary: () => m.turn(prompt, undefined, undefined, CONFIG.agent.model),
        model: CONFIG.agent.model,
        primaryOn: (model) => m.turn(prompt, undefined, undefined, model),
        system: m.system,
        prompt,
        wsId: threadWs,
        profileDir: threadWs ? webProfileDir(threadWs) : undefined,
        agent: { name: "Robert", tools: MANAGER_TOOLS },
        // Telegram propose-and-confirm: no CHRONOS_ADMIN on primary or fallback.
        killPrimary: () => {
          m.kill();
          if (threadWs) tgWsWarm.delete(`${chat}:${wsKey(threadWs)}`);
          else tgWarm.delete(chat);
        },
      });
    } else {
      // Parallel one-shot: same limit → fallback (detached, never touches the stored session).
      reply = await withProviderFallback({
        key: `tg-oneshot:${chat}`,
        primary: () => spawnAgent(ask),
        model: CONFIG.agent.model,
        primaryOn: (model) => spawnAgent(ask, model),
        system: robertPrompt("telegram"),
        prompt,
        wsId: threadWs,
      });
    }
    const scan = scanProposal(reply || "");
    let storedReply = stamp + (scan.reply || "(no reply)");
    if (scan.proposal) {
      if (scan.reply.trim()) await send(chat, esc(stamp + scan.reply).slice(0, 3900), undefined, msgId);
      const tier = await tierProposal(scan.proposal, chat, msgId);
      const label = scan.proposal.label || "action";
      storedReply =
        (scan.reply?.trim() ? stamp + scan.reply.trim() + "\n\n" : "") +
        (tier === "auto"
          ? `⚡ Executed: ${label}`
          : tier === "auto-failed"
            ? `⚠️ Failed: ${label}`
            : `📋 Proposal: ${label} (confirm in Telegram)`);
    } else if (scan.error) {
      await send(chat, esc(stamp + (scan.reply || "")).slice(0, 3900) + `\n\n⚠️ ${esc(scan.raw ?? "")}\n${esc(scan.error)}`, undefined, msgId);
      storedReply = stamp + (scan.reply || "") + (scan.error ? `\n\n⚠️ ${scan.error}` : "");
    } else {
      await send(chat, esc(stamp + (scan.reply || "(no reply)")).slice(0, 3900), undefined, msgId);
    }
    // Persist into the ROUTED workspace's thread — that is what keeps each recap clean.
    if (!ask.aborted) {
      const row = chatLog.add(body, storedReply, "telegram", threadWs);
      chatLog.prune(2000);
      bus.publish({
        topic: "agent.push",
        you: body,
        reply: storedReply,
        at: row.created_at,
        source: "telegram",
        ws: threadWs,
      });
    }
  } catch (e) {
    if (!ask.aborted) {
      const err = "⚠️ " + String(e);
      await send(chat, esc(err).slice(0, 600), undefined, msgId);
      try {
        const row = chatLog.add(body, err, "telegram", threadWs);
        chatLog.prune(2000);
        bus.publish({
          topic: "agent.push",
          you: body,
          reply: err,
          at: row.created_at,
          source: "telegram",
          ws: threadWs,
        });
      } catch {}
    }
  } finally {
    asks.delete(id);
    maybeStopTyping(chat);
  }
}

// Telegram used not to be Robert-only: /ada (and /ham, /iris, /vega) pointed the chat at that executive
// and every following message goes straight to them. It is the SAME warm singleton the desk and the
// board talk to (agents/<id>/ — their persona, tools, sandbox, --resume session), so it is one
// conversation across surfaces, not a Telegram-flavoured copy.
//
// No propose-and-confirm here. Robert's Telegram surface withholds CHRONOS_ADMIN by design and
// PROPOSEs mutations; an executive answering on Telegram acts with exactly the authority it already
// has on the desk. That is the point of the switch — Ada booking a thing shouldn't need a card —
// but it does mean Telegram now reaches direct execution, which it previously could not.
export async function runExecAgent(chat: number, execId: string, text: string, msgId: number) {
  const thread = `agent:${execId}`;
  ensureTyping(chat);
  const record = (reply: string) => {
    try {
      const row = agentChat.add(execId, text, reply);
      agentChat.prune(2000);
      bus.publish({ topic: "agent.push", you: text, reply, at: row.created_at, source: "telegram", ws: thread });
    } catch {}
  };
  try {
    // Name the turn, so anyone queued behind it is told what they are waiting on rather than
    // "queued behind undefined". `stream` stays off: Telegram gets the finished reply in one send,
    // not a token feed.
    const { reply } = await askExecWeb(execId, text, { origin: "Telegram" });
    const body = (reply || "(no reply)").trim();
    await send(chat, esc(body).slice(0, 3900), undefined, msgId);
    record(body);
  } catch (e) {
    const err = "⚠️ " + String(e);
    await send(chat, esc(err).slice(0, 600), undefined, msgId);
    record(err);
  } finally {
    maybeStopTyping(chat);
  }
}

/**
 * One door for every inbound Telegram message — typed, dictated or a photo caption. Robert keeps
 * his propose-and-confirm path; any other active executive answers directly.
 */
export function deliverToActiveExec(chat: number, text: string, msgId: number): Promise<void> {
  const id = getActiveExec(chat);
  return id === "robert" ? runAgent(chat, text, msgId) : runExecAgent(chat, id, text, msgId);
}

// Pure one-shot manager-agent spawn — no Telegram deps. Returns the agent's result text.
// resumeSessionId continues a prior conversation; onSessionId reports the new id to persist.
// onChild exposes the process (for abort). Used by both the Telegram runAgent path and the web /api/agent.
export function spawnManager(opts: {
  prompt: string;
  resumeSessionId: string | null;
  onSessionId?: (id: string) => void;
  onChild?: (c: ChildProcess) => void;
  system?: string;                       // defaults to the Telegram propose-and-confirm persona
  extraEnv?: Record<string, string>;     // e.g. CHRONOS_ADMIN for the execute-directly web persona
  model?: string;                        // override CONFIG.agent.model (voice uses a faster one)
}): Promise<string> {
  const backend = getBackend(CONFIG.agent.backend ?? "claude-code");
  const profileDir = CONFIG.profiles[CONFIG.agent.profile] ?? CONFIG.profiles.claude;
  const spec = backend.oneShot({
    prompt: opts.prompt,
    system: opts.system ?? robertPrompt("telegram"),
    model: opts.model || CONFIG.agent.model || null,
    configDir: profileDir,
    cwd: process.cwd(),
    resumeSessionId: opts.resumeSessionId,
    allowedTools: MANAGER_TOOLS,
    maxBudgetUsd: CONFIG.agent.maxBudgetUsd,
  });

  const { cmd, cmdArgs } = sandboxWrap("guard", process.cwd(), [], profileDir, [], spec.cmd, spec.args);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: process.cwd(),
      // Operator's personal daemon-level agent — intentionally keeps full env (not client-scoped).
      env: { ...process.env, ...spec.env, ...(opts.extraEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    opts.onChild?.(child);
    const watchdog = setTimeout(() => child.kill("SIGKILL"), CONFIG.agent.timeoutSec * 1000);
    watchdog.unref?.();
    let result = "";
    let resultIsError = false;
    // Rolling tail — same cap pattern as WarmManager / runner.
    const STDERR_CAP = 400;
    let errTail = "";
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const p = JSON.parse(t);
        noteClaudeStreamEvent(profileDir, p);
        if (p.type === "result") {
          result = typeof p.result === "string" ? p.result : "";
          resultIsError = !!p.is_error;
          // Only persist session id on success — error results often echo a bad id.
          if (!resultIsError && p.session_id) opts.onSessionId?.(p.session_id);
        }
      } catch {}
    });
    child.stderr!.on("data", (d) => {
      errTail = (errTail + d.toString()).slice(-STDERR_CAP);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      // is_error (session limit, auth, …) must reject so withProviderFallback can switch backends;
      // resolving with the error string would post "You've hit your session limit" as a reply.
      if (resultIsError) reject(new Error(result || errTail || `agent error`));
      else if (result) resolve(result);
      else reject(new Error(errTail || `agent exited ${code}`));
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      reject(e);
    });
  });
}

function spawnAgent(ask: Ask, model?: string): Promise<string> {
  return spawnManager({
    prompt: ask.prompt,
    resumeSessionId: null, // parallel one-shot: detached, never overwrites the stored session
    onChild: (c) => { ask.child = c; },
    model,
  });
}

// Lift `UI {json}` directives (one per line) out of a web-agent reply. Returns the spoken text (UI lines
// removed) + the parsed directive list the browser will execute against the live dashboard.
export type UiAction = { op: string; [k: string]: unknown };
// Tolerant: models drift on the literal prefix (UI / UID / UI: / ui) and sometimes drop it entirely,
// emitting a bare `{"op":...}` line. Accept any line whose JSON payload carries a string `op`.
const UI_RE = /^ui\S*\s*[:-]?\s*(\{.*\})\s*$/i;
export function scanUiActions(text: string): { reply: string; actions: UiAction[] } {
  const actions: UiAction[] = [];
  const keep: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const t = line.trim();
    const m = t.match(UI_RE);
    const json = m ? m[1] : t.startsWith("{") && t.endsWith("}") ? t : null;
    if (json) {
      try {
        const a = JSON.parse(json);
        if (a && typeof a.op === "string") { actions.push(a); continue; }
      } catch {}
    }
    keep.push(line);
  }
  return { reply: keep.join("\n").trim(), actions };
}

// ── Warm persistent manager ──────────────────────────────────────────────────
// A one-shot `claude -p` per turn pays node boot + auth + session-transcript reload BEFORE any inference
// (multi-second). WarmManager keeps ONE long-lived claude process in stream-json stdin mode and reuses it
// for every turn. Turns are serialized through its queue; a dead/hung process gets one fresh retry. Context
// grows every turn, so it recycles after maxTurns (graceful stdin end → next turn respawns).
// ponytail: one process per manager (single-operator daemon); per-session processes / compaction if that
// ever matters. Web voice = one global instance (no resume, context resets on recycle). Telegram = one per
// chat, spawned with --resume so conversation continuity survives daemon restarts and recycles.

// The operator's own Claude profile — used by Telegram, and by the web chat when no workspace is selected.
const DEFAULT_PROFILE_DIR = CONFIG.profiles[CONFIG.agent.profile] ?? CONFIG.profiles.claude;

// Streamed turn progress: kind "text" = reply delta, "thinking" = reasoning delta, "tool" = a tool
// starting (text = one-line description), "tool_done" = the most recent tool returned.

export type AgentDelta = (t: string, kind: "text" | "thinking" | "tool" | "tool_done") => void;

// Silence budget, not a turn budget: re-armed on every line the CLI emits, so a turn that is actively
// working (long Bash, subagent) never gets killed — only one that has genuinely stopped talking.
const WEB_TURN_TIMEOUT_MS = 90_000;
const WEB_MAX_TURNS = 30;

type WarmOpts = {
  system: string;
  model: string;
  extraEnv?: Record<string, string>;      // e.g. CHRONOS_ADMIN for the execute-directly web persona
  profileDir?: string;                    // CLAUDE_CONFIG_DIR; defaults to CONFIG.agent.profile's dir
  resumeSessionId?: string | null;         // --resume this id on first spawn (Telegram continuity)
  onSessionId?: (id: string) => void;      // persist each turn's session id (also enables resume-on-recycle)
  onStaleResume?: () => void;              // stale --resume id detected → caller drops its stored session
  turnTimeoutMs: number;
  maxTurns: number;
  // Executives think about Chronos, so the daemon's own cwd and a read-only Bash+Read toolset are
  // the right default. An executive who also owns files (Ada, for the house repo) gets editing
  // tools on top; one that LIVES in a single repo can additionally take that repo as cwd and a
  // strict sandbox pinning its writes there. Absent → the pre-existing behaviour, unchanged.
  cwd?: string;
  allowedTools?: string;                   // default "Bash,Read"
  sandbox?: SandboxMode;                   // default "guard"
  // JSON for --mcp-config (AgentDef.mcp). Absent → --strict-mcp-config with nothing to load, i.e.
  // no MCP servers at all, which is what every executive got before agents could declare a bundle.
  mcpConfig?: string;
};

export class WarmManager {
  private child: ChildProcess | null = null;
  private turns = 0;
  private errTail = "";
  private killed = false; // explicit abort → don't auto-resurrect the turn
  private resumeId: string | null;
  // `child` is the process that OWNS this turn. A dying process must never settle a turn that
  // already belongs to its replacement: attempt() kills and respawns synchronously, so the old
  // child's async 'close' used to land on the new turn and fail it with "exited (signal SIGKILL)".
  private pending: {
    resolve: (r: string) => void;
    reject: (e: Error) => void;
    onDelta?: AgentDelta;
    child: ChildProcess;
  } | null = null;
  private curBlock: string | null = null; // type of the streaming content block (only "text" speaks)
  // What the in-flight turn is, and since when — so a caller whose turn is stuck behind it can SAY
  // so instead of leaving a silent "thinking…". A board wake can hold an executive for 15+ minutes.
  private inflight: { label: string; at: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null; // silence watchdog for the in-flight turn
  private timedOut = false;                   // set when the watchdog fired → report it as a timeout

  constructor(private opts: WarmOpts) {
    this.resumeId = opts.resumeSessionId ?? null;
  }

  /** System prompt baked into this process — used when re-running a turn on the fallback backend. */
  get system(): string {
    return this.opts.system;
  }

  /** What this manager is working on right now (label + start ms), or null when it is free. */
  busyWith(): { label: string; at: number } | null {
    return this.inflight;
  }

  /** The in-flight turn, but only when `child` is the process that owns it. */
  private own(child: ChildProcess) {
    return this.pending?.child === child ? this.pending : null;
  }

  /** Same, and clears it — for the settle paths (result / close / error). */
  private takeOwn(child: ChildProcess) {
    const p = this.own(child);
    if (p) this.pending = null;
    return p;
  }

  private spawn(): ChildProcess {
    const profileDir = this.opts.profileDir || DEFAULT_PROFILE_DIR;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", // stream_event deltas → per-sentence voice streaming (web onDelta)
      "--append-system-prompt", this.opts.system,
      "--allowed-tools", this.opts.allowedTools ?? "Bash,Read",
      // strict stays unconditional: whatever the profile dir happens to have configured is never
      // what an executive runs with — only the bundle her AGENT.md asked for, or nothing.
      ...(this.opts.mcpConfig ? ["--mcp-config", this.opts.mcpConfig] : []),
      "--strict-mcp-config", "--dangerously-skip-permissions",
      "--model", this.opts.model,
      // budget covers the whole process lifetime (up to maxTurns turns), not one message
      "--max-budget-usd", String(CONFIG.agent.maxBudgetUsd * this.opts.maxTurns),
    ];
    if (this.resumeId) args.push("--resume", this.resumeId);
    const cwd = this.opts.cwd || process.cwd();
    const { cmd, cmdArgs } = sandboxWrap(
      this.opts.sandbox ?? "guard", cwd, [], profileDir, [], CONFIG.claudeBin, args
    );
    const child = spawn(cmd, cmdArgs, {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: profileDir, ...(this.opts.extraEnv ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    liveChildren.add(child);
    child.on("exit", () => liveChildren.delete(child));
    this.turns = 0;
    this.errTail = "";
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let p: any;
      try { p = JSON.parse(t); } catch { return; }
      noteClaudeStreamEvent(profileDir, p);
      // Any line at all is proof of life: re-arm the silence watchdog.
      this.touch(child);
      // Complete assistant/user messages carry what the partial stream can't: a tool_use block with its
      // INPUT (so "Bash" becomes "run npm test", "Task" becomes "delegate: <what>"), and the tool_result
      // that closes it. Those drive the activity strip; the partial stream only knows the bare name.
      if (p.type === "assistant" || p.type === "user") {
        const blocks = Array.isArray(p.message?.content) ? p.message.content : [];
        for (const b of blocks) {
          if (b?.type === "tool_use") this.own(child)?.onDelta?.(describeTool(b.name ?? "tool", b.input), "tool");
          else if (b?.type === "tool_result") this.own(child)?.onDelta?.("", "tool_done");
        }
        return;
      }
      // Partial-message stream: track the live block type (content_block_start). TEXT deltas stream the
      // reply; thinking deltas stream as tagged activity so the dashboard shows what the manager is
      // doing while the turn runs (only "text" ever speaks). tool_use starts come from the complete
      // message above instead — it has the input, this block has only the name.
      if (p.type === "stream_event") {
        const ev = p.event;
        if (ev?.type === "content_block_start") {
          this.curBlock = ev.content_block?.type ?? null;
        } else if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && this.curBlock === "text")
            this.own(child)?.onDelta?.(ev.delta.text ?? "", "text");
          else if (ev.delta?.type === "thinking_delta" && this.curBlock === "thinking")
            this.own(child)?.onDelta?.(ev.delta.thinking ?? "", "thinking");
        }
        return;
      }
      if (p.type !== "result") return;
      // Error results (e.g. stale --resume dying at boot) must NOT count as a turn or persist their
      // session id (it echoes the bad one back). Reject the pending turn so attempt() retries fresh;
      // a pre-warm has no pending — the close handler's stale-resume respawn covers it.
      if (p.is_error) {
        const pend = this.takeOwn(child);
        pend?.reject(new Error(typeof p.result === "string" && p.result ? p.result : this.errTail || "agent error"));
        return;
      }
      this.turns++;
      if (p.session_id && this.opts.onSessionId) { this.opts.onSessionId(p.session_id); this.resumeId = p.session_id; }
      const pend = this.takeOwn(child);
      pend?.resolve(typeof p.result === "string" ? p.result : "");
      if (this.turns >= this.opts.maxTurns && this.child === child) {
        this.child = null; // graceful exit; next turn respawns (resuming if a session id was captured)
        child.stdin!.end();
      }
    });
    child.stderr!.on("data", (d) => { this.errTail = (this.errTail + d.toString()).slice(-400); });
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = null;
      const pend = this.takeOwn(child);
      // Why it died, so the operator sees a cause instead of a bare "exited". A watchdog kill is a
      // stall (no output for turnTimeoutMs), not a crash — say so; SIGKILL leaves no stderr to quote.
      const why = this.timedOut
        ? `manager stalled — no output for ${Math.round(this.opts.turnTimeoutMs / 1000)}s`
        : this.errTail || `manager exited (${signal ? `signal ${signal}` : `code ${code}`})`;
      // A pre-warm with a stale --resume id dies BEFORE any turn (nothing pending to retry it):
      // forget the id and respawn fresh once so warm() still delivers a live process. resumeId is
      // now null, so a second death can't loop.
      if (!pend && !this.child && this.turns === 0 && this.resumeId && /no conversation found/i.test(this.errTail)) {
        this.resumeId = null;
        this.opts.onStaleResume?.();
        this.spawn();
        return;
      }
      pend?.reject(new Error(why));
    });
    child.on("error", (e) => {
      if (this.child === child) this.child = null;
      this.takeOwn(child)?.reject(e);
    });
    return child;
  }

  // Hub open → boot ahead of the first turn so it skips CLI startup entirely.
  warm() { if (!this.child) this.spawn(); }

  // External abort: SIGKILL and drop the process, and mark it so the in-flight turn doesn't resurrect.
  kill() { this.killed = true; this.child?.kill("SIGKILL"); this.child = null; }

  /**
   * Switch models between turns. The process bakes --model at spawn, so this drops it and lets the
   * next turn respawn — keeping resumeId, so the conversation continues on the new model. Used to
   * run chat on a fast model and escalate to the heavy one only when the message asks for it.
   */
  setModel(model: string) {
    if (!model || model === this.opts.model) return;
    this.opts.model = model;
    this.child?.kill("SIGKILL");
    this.child = null;
  }

  private write(text: string, onDelta?: AgentDelta, label = "a turn"): Promise<string> {
    return new Promise((resolve, reject) => {
      // Queue serializes turns; still refuse if a turn is somehow mid-flight on this process.
      if (this.pending) {
        reject(new Error("warm manager turn already in flight"));
        return;
      }
      const child = this.child ?? this.spawn();
      this.curBlock = null;
      this.timedOut = false;
      // A past abort must not disable this turn's retry forever — `killed` is about the turn that
      // was aborted, not about every turn after it.
      this.killed = false;
      this.inflight = { label, at: Date.now() };
      const done = () => {
        this.inflight = null;
        if (this.idle) { clearTimeout(this.idle); this.idle = null; }
      };
      this.pending = {
        resolve: (r) => { done(); resolve(r); },
        reject: (e) => { done(); reject(e); },
        onDelta,
        child,
      };
      this.touch(child); // arm the silence watchdog; every CLI line re-arms it
      try {
        child.stdin!.write(
          JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
        );
      } catch (e: any) {
        this.pending = null;
        done();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  // Re-arm the silence watchdog. Fires only after turnTimeoutMs with NO output at all — a turn that is
  // streaming text, thinking, or grinding through tools keeps resetting it and runs as long as it needs.
  private touch(child: ChildProcess) {
    if (!this.own(child)) return; // a dead child's late output must not re-arm the live turn's watchdog
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.timedOut = true;
      child.kill("SIGKILL"); // close handler rejects with the timeout message
    }, this.opts.turnTimeoutMs);
    this.idle.unref?.();
  }

  private async attempt(text: string, onDelta?: AgentDelta, label?: string): Promise<string> {
    try {
      return await this.write(text, onDelta, label);
    } catch (e: any) {
      if (this.killed) throw e; // aborted mid-turn → surface, don't respawn
      // Session/rate/credit walls won't clear on a same-process retry — surface immediately so
      // withProviderFallback can switch backends instead of burning a second failed Claude call.
      if (isProviderLimitError(e)) throw e;
      this.child?.kill("SIGKILL");
      this.child = null;
      // Stale --resume id (profile switch, wiped config dir): CLI errors "No conversation found …".
      // Forget it so the retry spawns a fresh session; let the caller drop its stored session id.
      if (/no conversation found/i.test(String(e?.message ?? e) + this.errTail)) { this.resumeId = null; this.opts.onStaleResume?.(); }
      // The respawn above is what recovers an expired token (a warm process never re-auths, it just
      // keeps erroring). If the fresh process ALSO can't authenticate, the login is genuinely dead —
      // name the profile, since the CLI's "run /login" never says which of the config dirs it means.
      return this.write(text, onDelta, label).catch((e2: any) => { throw this.authHint(e2); });
    }
  }

  /** Auth failures name their profile dir + the exact command that fixes them. */
  private authHint(e: any): Error {
    const err = e instanceof Error ? e : new Error(String(e));
    if (!isAuthError(err)) return err;
    const dir = (this.opts.profileDir || DEFAULT_PROFILE_DIR).replace(os.homedir(), "~");
    return new Error(`${err.message} — profile ${dir} (fix: CLAUDE_CONFIG_DIR=${dir} claude /login)`);
  }

  // Serialized: one turn at a time through this process; dead/hung/stale gets one fresh retry.
  // onDelta (web/voice only) fires per streamed TEXT delta; Telegram passes none and ignores stream events.
  // `label` names this turn for whoever ends up waiting behind it (see busyWith).
  // `model` switches at the turn boundary, inside the queue: switching eagerly would SIGKILL a turn
  // still in flight on the old model (a wake on haiku, a desk turn on opus).
  turn(text: string, onDelta?: AgentDelta, label?: string, model?: string): Promise<string> {
    const p = this.queue.then(() => {
      if (model) this.setModel(model);
      return this.attempt(text, onDelta, label);
    });
    this.queue = p.catch(() => {});
    return p;
  }
}

// ── Web/voice: one warm manager PER WORKSPACE, execute-directly persona (curls the API via
//    CHRONOS_ADMIN), may emit UI directives. Flow's workspace selection picks the conversation AND the
//    Claude profile it runs on: a selected workspace uses ITS config_dir (account + skills + MCP) and its
//    own chat thread; "all workspaces" uses the operator's own profile and the unscoped thread (shared
//    with Telegram + briefings). Keyed by workspace rather than by profile so two workspaces on the same
//    account still hold separate conversations.
//    Continuity via claude --resume (session id in kv, per workspace), so it survives recycles/restarts
//    like Telegram — but a >1h idle gap rotates to a FRESH session ("web-session" semantics): the
//    dashboard still shows the full persisted thread, only the model's context resets. ──
const WEB_IDLE_ROTATE_MS = 60 * 60 * 1000;
// Workspace → its Claude profile dir; no workspace (or unknown id) → the operator's default.
export function webProfileDir(wsId?: string | null): string {
  return (wsId ? workspaces.get(wsId)?.config_dir : null) || DEFAULT_PROFILE_DIR;
}
// kv/map key for a thread. Unknown ids collapse to the unscoped thread, same as no selection.
const wsKey = (wsId?: string | null) => (wsId && workspaces.get(wsId) ? wsId : "default");
const getWebSession = (key: string) => kv.get(`web.session:${key}`) ?? null;
const setWebSession = (key: string, id: string) => kv.set(`web.session:${key}`, id);
const clearWebSession = (key: string) => kv.del(`web.session:${key}`);

// Operator-picked model for the web chat; falls back to the configured voice model.
export const getWebModel = () => kv.get("web.model") || CONFIG.agent.voiceModel;
// Switching kills the warm processes but keeps the resume ids, so threads continue on the new model.
export function setWebModel(model: string) {
  if (model === getWebModel()) return;
  kv.set("web.model", model);
  for (const m of webMgrs.values()) m.kill();
  webMgrs.clear();
}

// The skill index is baked into the system prompt at spawn time, so a skill approved (or edited) while
// a manager is warm would stay invisible until the next recycle. Drop that workspace's processes
// instead; the resume ids survive, so the conversation continues — it just reboots knowing the skill.
bus.on("event", (e: BusEvent) => {
  if (e.topic !== "skill.created" && e.topic !== "skill.updated") return;
  const key = wsKey(e.workspace_id);
  webMgrs.get(key)?.kill();
  webMgrs.delete(key);
  dropTgWsManagers(key);
});

// ── Persona memory ──────────────────────────────────────────────────────────────────────────────
// Every named agent carries a durable memory file (src/agent-memory.ts) into its system prompt.
// The prompt is baked at spawn, so a fact written mid-turn only lands on the next process: record
// the stamp we spawned with and recycle at the next manager acquisition, which is always a turn
// boundary. Rotating eagerly on note.updated would kill the very turn that just wrote the fact.
// The resume session id outlives the process, so the conversation continues across the recycle.
const memStamp = new Map<string, string>();
// The brief pages (src/briefs.ts) ride the same stamp: an edit from the Desk lands on the next turn.
const stampOf = (agent: string) => agentMemoryStamp(agent) + "|" + briefStamp();
function personaSystem(agent: string, ...parts: (string | null | undefined)[]): string {
  memStamp.set(agent, stampOf(agent));
  return [...parts, agentMemoryBlock(agent), memoryRules(agent), briefRules()].filter(Boolean).join("\n\n");
}
function memoryMoved(agent: string): boolean {
  const at = memStamp.get(agent);
  return at !== undefined && at !== stampOf(agent);
}

// How Robert keeps each project's page current, and what the fleet block at the top of a turn is.
const briefRules = () =>
  `YOUR BRIEF PER PROJECT: above, under "YOUR STANDING UNDERSTANDING", is one page per workspace — what it is, ` +
  `what the operator wants from it, how work is done there, what happened recently, what is next. He wrote it ` +
  `once; keeping it true is YOUR job, and it is how you stay aligned with him without being told twice.\n` +
  `- POST /api/workspaces/<id>/brief {"fact":"...","heading":"Recently"} — append ONE line (heading = the section)\n` +
  `- PUT /api/workspaces/<id>/brief {"body":"...whole page..."} — rewrite to prune; GET reads it back\n` +
  `WHEN: a terminal you closed or ticked shipped something → one dated line under Recently (keep the newest 8, ` +
  `prune the rest). A durable project fact (a convention, a person, a constraint) → under How work is done here. ` +
  `A decision about direction → under Next. The GOALS section changes only when the operator says so. Do it in ` +
  `the same turn, without announcing it.\n` +
  `FLEET NOW: every desk turn opens with the live fleet — one line per open terminal (id · client · state · goal · ` +
  `what it asks). Answer "who needs me / what's running" from it directly; read \`mc desk digest\` or ` +
  `\`mc session focus <id>\` only when you need what a terminal actually said. Name a terminal by its goal in ` +
  `plain words and add its 8-char id in parentheses — the Desk turns that id into a chip that opens it. To put ` +
  `one on his screen, end with \`UI {"op":"select","id":"<full or 8-char id>"}\`.\n`;


const memoryRules = (agent: string) =>
  `YOUR MEMORY: you have a persistent memory file that loads into every conversation you ever have — ` +
  `its current contents are above under "Your memory". It survives restarts, model switches and new ` +
  `threads. It is yours to write; nobody curates it for you.\n` +
  `- POST /api/agents/${agent}/memory {"fact":"...","heading":"optional section"} — append ONE durable fact\n` +
  `- GET /api/agents/${agent}/memory — read it back raw\n` +
  `- PUT /api/agents/${agent}/memory {"body":"...full markdown..."} — rewrite it whole, to prune and reorganise\n` +
  `(Chronos at http://localhost:${CONFIG.port}, header x-mc-admin: $CHRONOS_ADMIN when you have it.)\n` +
  `WRITE TO IT CONSTANTLY — this is the difference between an assistant and a stranger. The moment the operator ` +
  `tells you something still true next week (a preference, a person and who they are to him, a recurring ` +
  `commitment, a deadline, how he wants something handled, a decision and why, something he hated), record ` +
  `it in that same turn, without announcing it. Never make him tell you twice. A correction IS a fact: ` +
  `when he corrects you, write the rule down before you answer.\n` +
  `KEEP IT CLEAN: one line per fact, under headings, dated when the date is the point. When it grows long ` +
  `or contradicts itself, PUT a pruned version — a stale memory is worse than none.\n` +
  `NEVER record: passwords, tokens, card numbers, anything he asked you to forget, or the small talk of a ` +
  `single conversation. Memory is for what changes how you act next time.\n`;

/** The activity line a degraded turn shows: "⚠️ fable sin créditos → opus", "⚠️ engine degradado: grok/grok-4.5 (…)". */
export const fallbackLine = (fb: { backend: string; model: string | null; why: string }) =>
  fb.backend === "claude"
    ? `⚠️ ${fb.why}`
    : `⚠️ engine degradado: ${fb.backend}${fb.model ? `/${fb.model}` : ""} (${fb.why})`;

const webMgrs = new Map<string, WarmManager>(); // workspace key → warm manager
function webManager(key: string, wsId: string | null): WarmManager {
  let m = webMgrs.get(key);
  if (m && memoryMoved("robert")) { m.kill(); webMgrs.delete(key); m = undefined; }
  if (!m) {
    m = new WarmManager({
      // Same standing workspace context every job runner and terminal agent gets: operator notes + the
      // L0 skill index. Without it the manager was the only agent blind to the skills its workspace has
      // built — it knew the skills API but not what was in it. Bodies stay on demand via `mc skill view`.
      // widgetPromptBlock() is the Desk's live cards (src/widgets/index.ts): the names he may embed,
      // read from the registry at spawn so a widget added later never leaves him naming a card the
      // page cannot mount. Web surface only — Telegram has nowhere to render one.
      system: personaSystem("robert", robertPrompt("web"), wsId ? agentContext(wsId) : "", briefsBlock(wsId), widgetPromptBlock()),
      model: getWebModel(),
      profileDir: webProfileDir(wsId),
      allowedTools: MANAGER_TOOLS,
      // MC_AGENT_NAME signs what he does through `mc` — a keystroke he types into someone
    // else's terminal lands in the activity trail as "robert", not as the operator.
    // MC_WORKSPACE is which client THIS desk Robert belongs to: there is one warm manager per
    // workspace, so every workspace-scoped `mc` command (pad, idea, skill, learn) can default to it
    // instead of making him carry a uuid around. Absent for the unscoped/personal manager, where
    // there is no one right answer and the command should say so rather than guess.
    extraEnv: { CHRONOS_ADMIN: CONFIG.adminToken, MC_AGENT_NAME: "robert", ...(wsId ? { MC_WORKSPACE: wsId } : {}) },
      resumeSessionId: getWebSession(key),
      onSessionId: (id) => setWebSession(key, id),
      onStaleResume: () => clearWebSession(key),
      turnTimeoutMs: WEB_TURN_TIMEOUT_MS,
      maxTurns: WEB_MAX_TURNS,
    });
    webMgrs.set(key, m);
  }
  return m;
}

// >1h since that workspace's last turn → kill its warm process, drop the resume id; the next call
// respawns on a clean session. Idle is per thread so a quiet client chat doesn't reset the busy one.
function rotateWebIfIdle(key: string) {
  const last = Number(kv.get(`web.lastTurnAt:${key}`) ?? 0);
  if (last && Date.now() - last > WEB_IDLE_ROTATE_MS) {
    webMgrs.get(key)?.kill();
    webMgrs.delete(key);
    clearWebSession(key);
  }
}

/**
 * Stop an in-flight web manager turn.
 *
 * Telegram's abortAsk only ever reached the Telegram-local `asks`/`tgWarm` maps, so a Robert turn
 * started from the desk had nothing that could interrupt it — the only
 * bound was the 90s silence watchdog, which never fires on a turn that is merrily producing output.
 *
 * Unlike resetWebConversation this keeps the resume session id: the operator wants THIS turn to
 * stop, not the conversation to lose its memory. The next message respawns and resumes.
 * Returns false when that workspace had no live process to kill.
 */
export function abortWebTurn(wsId?: string | null): boolean {
  const key = wsKey(wsId);
  const m = webMgrs.get(key);
  if (!m) return false;
  m.kill();
  webMgrs.delete(key);
  return true;
}

// Operator hit "new conversation": drop the CLI session so the next turn starts with no context. The
// persisted thread keeps its rows — chat.divide() marks where the model's memory now begins.
export function resetWebConversation(wsId?: string | null) {
  const key = wsKey(wsId);
  webMgrs.get(key)?.kill();
  webMgrs.delete(key);
  clearWebSession(key);
  dropTgWsManagers(key); // Telegram may be resuming this same thread
}

// Hub open → boot the process so the first utterance skips CLI startup entirely.
export function warmWebManager(wsId?: string | null) {
  const key = wsKey(wsId);
  rotateWebIfIdle(key);
  webManager(key, wsId ?? null).warm();
}

// A turn the operator SPOKE on the Desk's voice call. Rides in the prompt, not the system, so a call
// never recycles the warm process; the chat log keeps only what he said.
export const VOICE_TURN =
  "(VOICE — the operator is talking to you on the Desk voice call. What follows is speech-to-text: names of projects, terminals and people may be misheard, so match them generously against the fleet and the briefs, and if two things fit, ask which. Your reply is READ ALOUD: first sentence = the outcome or your one question; at most three short sentences in total; plain spoken words — no markdown, lists, tables, ids, keys, paths, URLs or emoji. Clear commands you execute directly as always, then say what you did. Anything destructive, outward-facing or ambiguous: ask one short yes/no question he can answer out loud, and act on his spoken yes. UI lines still go after the reply; they are not read out.)";

export async function askManagerWeb(
  text: string,
  onDelta?: AgentDelta,
  wsId?: string | null,
  opts?: { model?: string; voice?: boolean; turn?: string; label?: string },
): Promise<{ reply: string; actions: UiAction[]; steps: RobertStep[]; turn: string }> {
  const key = wsKey(wsId);
  rotateWebIfIdle(key);
  // Every tool call he makes becomes a timestamped step: published live, returned for the chat row.
  const turn = opts?.turn ?? randomUUID();
  const steps: RobertStep[] = [];
  const outer = onDelta;
  onDelta = (t, kind) => {
    if (kind === "tool") {
      const step = humanizeStep(t);
      if (step) {
        steps.push(step);
        bus.publish({ topic: "agent.step", ws: wsId ?? null, turn, step, label: opts?.label ?? null });
      }
    }
    outer?.(t, kind);
  };
  const m = webManager(key, wsId ?? null);
  // Caller-chosen model for THIS turn (wake paths run chat fast, escalate on request). No model → the
  // operator's dashboard pick stands — re-applied every turn, or one wake would leave the desk on its
  // model, and a credit-wall downgrade (fable → opus) would never come back.
  const model = opts?.model || getWebModel();
  kv.set(`web.lastTurnAt:${key}`, String(Date.now()));
  const realWsId = key === "default" ? null : key;
  // The live fleet first, then a recap of this workspace's thread (web + any Telegram/briefing rows
  // in it, cut at the last divider), then what he said.
  const prompt = fleetLine(realWsId) + "\n\n" + (chatLog.contextBlock({ limit: 12, workspaceId: realWsId }) || "") + (opts?.voice ? VOICE_TURN + "\n\n" : "") + text;
  const reply = await withProviderFallback({
    key: `web:${key}`,
    primary: () => m.turn(prompt, onDelta, undefined, model),
    model,
    primaryOn: (alt) => m.turn(prompt, onDelta, undefined, alt),
    system: m.system,
    prompt,
    wsId: realWsId,
    // MC_AGENT_NAME signs what he does through `mc`; MC_WORKSPACE is which client this desk
    // Robert belongs to (see the warm-manager spawn above). The fallback engine has to carry both,
    // or a degraded turn silently loses the workspace default the primary had.
    extraEnv: { CHRONOS_ADMIN: CONFIG.adminToken, MC_AGENT_NAME: "robert", ...(realWsId ? { MC_WORKSPACE: realWsId } : {}) },
    profileDir: webProfileDir(realWsId),
    onDelta,
    // `prompt` already carries this thread's recap, so only the declaration needs carrying.
    agent: { name: "Robert", tools: MANAGER_TOOLS },
    onFallback: (fb) => onDelta?.(fallbackLine(fb), "tool"),
    killPrimary: () => {
      m.kill();
      webMgrs.delete(key);
    },
  });
  // No turn ends blind: a few DB reads at the boundary, one notice per episode. Late import — the
  // guard reads the wake queue, which imports this module for the turn it drains.
  void import("../supervision-guard.js")
    .then((g) => g.checkSupervision())
    .catch((e) => console.warn("[agent] supervision check", e?.message ?? e));
  return { ...scanUiActions(reply || ""), steps, turn };
}

// ── The named executives (none, while Robert is the only executive) ───────────────────────────────────────────────
//
// One singleton warm process per agent. This used to be four copies of the same ~60 lines, differing
// only in persona, model, tools, cwd, sandbox and env — so the copies drifted: one grew a PATH the
// others needed, one rotated its session on a slightly different path. All six of those knobs are
// now data in agents/<id>/AGENT.md, which leaves ONE lifecycle here: idle rotation, memory recycle,
// resume-id persistence, provider fallback. A new executive is a new directory.
//
// Robert ships as the only executive, so warmExec/askExec have exactly one id to be called with
// today. The machinery is kept generic anyway, for the reason in the paragraph above: it is the seam
// a second executive returns through, and collapsing it back into Robert's per-workspace path would
// undo the de-duplication the moment anyone adds one.
//
// Robert is deliberately not one of them: the desk runs one manager per workspace and Telegram one
// per chat, so his processes are keyed by more than his name. He shares the prompt files, not this.
const execMgrs = new Map<string, WarmManager>();

function dropExec(id: string, alsoSession: boolean) {
  execMgrs.get(id)?.kill();
  execMgrs.delete(id);
  if (alsoSession) kv.del(`${id}.session`);
}

// Operator hit "new conversation" on an executive's thread. Same contract as
// resetWebConversation for the desk's manager threads: the process dies and the resume id goes,
// so the next message starts a clean session. The persisted thread keeps every row —
// agentChat.divide() marks where the model's memory now begins.
export function resetExecConversation(id: string) {
  dropExec(id, true);
}

// >1h since this executive's last turn → kill the process AND drop the resume id, so the next
// message starts a clean session. Same "web-session" semantics as the desk's per-workspace threads.
function rotateExecIfIdle(id: string) {
  const last = Number(kv.get(`${id}.lastTurnAt`) ?? 0);
  if (last && Date.now() - last > WEB_IDLE_ROTATE_MS) dropExec(id, true);
}

function execManager(id: string): WarmManager {
  const def = agentDef(id);
  let m = execMgrs.get(id);
  // The prompt is baked at spawn, so a fact written mid-turn only lands on the next process.
  if (m && memoryMoved(def.memory)) {
    dropExec(id, false);
    m = undefined;
  }
  if (!m) {
    m = new WarmManager({
      system: personaSystem(def.memory, agentPrompt(id)),
      // Executive default follows voiceModel (opus unless overridden); AGENT.md may pin another.
      model: def.model || CONFIG.agent.voiceModel || "opus",
      profileDir: DEFAULT_PROFILE_DIR,
      extraEnv: def.env,
      ...(def.cwd ? { cwd: def.cwd } : {}),
      ...(def.tools ? { allowedTools: def.tools } : {}),
      ...(def.mcp ? { mcpConfig: def.mcp } : {}),
      ...(def.sandbox ? { sandbox: def.sandbox } : {}),
      resumeSessionId: kv.get(`${id}.session`) ?? null,
      onSessionId: (sid) => kv.set(`${id}.session`, sid),
      onStaleResume: () => kv.del(`${id}.session`),
      turnTimeoutMs: WEB_TURN_TIMEOUT_MS,
      maxTurns: WEB_MAX_TURNS,
    });
    execMgrs.set(id, m);
  }
  return m;
}

/** Pre-spawn an executive's process. First-turn cold start is ~a minute; in chat that reads as broken. */
function warmExec(id: string): void {
  rotateExecIfIdle(id);
  execManager(id).warm();
}

// Every executive turn — chat, board wake, heartbeat, mail sweep — runs through ONE warm process per
// executive, so any of them can hold the others up. Whoever is watching that executive's chat pane
// must therefore see what it is doing even when the turn is not theirs, which is why the deltas are
// published HERE (from the one seam every caller goes through) rather than by the chat route: a board
// wake used to run 15 silent minutes while the operator's queued message showed a bare "thinking…".
export type ExecTurnOpts = {
  /** Names this turn for whoever queues behind it — "the operator's chat", "a board thread", "the heartbeat". */
  origin?: string;
  /** Stream the reply TEXT into the chat thread. Only the chat surface wants it: a board reply belongs
   *  to the board, so a background turn publishes its ACTIVITY (tools) and keeps its prose to itself. */
  stream?: boolean;
};

/** Minutes, floored — "running 0m" is honest for a turn that just started. */
const minsSince = (at: number) => Math.floor((Date.now() - at) / 60_000);

/** The line a caller gets when the executive is already busy with someone else's turn. */
export const queuedNotice = (busy: { label: string; at: number }) =>
  `queued behind ${busy.label} (running ${minsSince(busy.at)}m)`;

/**
 * How much of the thread a one-shot fallback is handed. Enough to answer a follow-up ("y eso cuánto
 * sale?") without re-reading the whole history into a degraded engine's context.
 */
const FALLBACK_HISTORY_TURNS = 6;

/** Recent turns of an executive's own chat thread, oldest→newest, for a fallback that cannot resume. */
function execHistory(id: string): string {
  try {
    const rows = agentChat.recent(id, FALLBACK_HISTORY_TURNS);
    // "New conversation" cut the resuming path's context; a fallback must not walk around it and
    // hand the degraded engine the very turns the operator just put behind a line.
    const divider = rows.map((r: any) => r.source).lastIndexOf("divider");
    return (divider === -1 ? rows : rows.slice(divider + 1))
      .map((r: any) => [r.you ? `the operator: ${r.you}` : "", r.reply ? `Vos: ${r.reply}` : ""].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n")
      .slice(-6000);
  } catch {
    return "";
  }
}

/**
 * Every executive turn's progress, published on the executive's own chat thread. Background turns
 * (board, heartbeat, Telegram) publish their ACTIVITY only: their prose belongs to the surface that
 * asked, not to the operator's pending bubble — but they still get to see the process is working, and on what.
 */
export function execDeltas(id: string, opts?: ExecTurnOpts): AgentDelta {
  const ws = `agent:${id}`;
  return (text, kind) => {
    if (kind === "text" && !opts?.stream) return;
    bus.publish({ topic: "agent.delta", text, kind, ws });
  };
}

async function askExec(
  id: string,
  text: string,
  opts?: ExecTurnOpts,
): Promise<{ reply: string; actions: UiAction[] }> {
  rotateExecIfIdle(id);
  const def = agentDef(id);
  const m = execManager(id);
  const emit = execDeltas(id, opts);
  // Queued behind someone else's turn: say so up front, or the wait is indistinguishable from a hang.
  const busy = m.busyWith();
  if (busy) emit(queuedNotice(busy), "tool");
  kv.set(`${id}.lastTurnAt`, String(Date.now()));
  const model = def.model || CONFIG.agent.voiceModel || "opus";
  const reply = await withProviderFallback({
    key: id,
    primary: () => m.turn(text, emit, opts?.origin ?? "another turn", model),
    model,
    primaryOn: (alt) => m.turn(text, emit, opts?.origin ?? "another turn", alt),
    system: m.system,
    prompt: text,
    // The engine may change; who this is must not. Persona rides in `system`; the rest of the
    // declaration (tools, MCP bundle) rides here so a fallback engine honors what it can and is
    // told what it cannot — see capabilityGap.
    agent: { name: def.name, tools: def.tools, mcpConfig: def.mcp },
    history: execHistory(id),
    onFallback: (fb) => emit(fallbackLine(fb), "tool"),
    // Same isolation as the primary process: a fallback must not gain an admin token or a wider
    // sandbox just because the primary backend was rate-limited.
    extraEnv: def.env,
    ...(def.cwd ? { cwd: def.cwd } : {}),
    ...(def.sandbox ? { sandbox: def.sandbox } : {}),
    onDelta: emit,
    killPrimary: () => dropExec(id, false),
  });
  return scanUiActions(reply || "");
}

/** Ask any executive by id — one entry point for the desk, the board and Telegram. */
export const askExecWeb = (id: string, text: string, opts?: ExecTurnOpts) => askExec(id, text, opts);

/** Warm any executive by id — the counterpart to askExecWeb. */
export const warmExecWeb = (id: string) => warmExec(id);

// ── Telegram: one warm manager per chat, propose-and-confirm persona (no CHRONOS_ADMIN — it only reads
//    and PROPOSEs). Spawned with --resume of the stored session so continuity survives restarts/recycles;
//    each turn's session id is persisted. Created lazily on the first idle ask (parallel asks stay one-shot). ──
const tgWarm = new Map<number, WarmManager>();
function warmForChat(chat: number): WarmManager {
  let m = tgWarm.get(chat);
  if (m && memoryMoved("robert")) { m.kill(); tgWarm.delete(chat); m = undefined; }
  if (!m) {
    m = new WarmManager({
      system: personaSystem("robert", robertPrompt("telegram")),
      model: CONFIG.agent.model,
      allowedTools: MANAGER_TOOLS,
      resumeSessionId: getChatSession(chat) ?? null,
      onSessionId: (id) => setChatSession(chat, id),
      onStaleResume: () => clearChatSession(chat),
      turnTimeoutMs: CONFIG.agent.timeoutSec * 1000, // opus is slow — Telegram default 180s
      maxTurns: WEB_MAX_TURNS,
    });
    tgWarm.set(chat, m);
  }
  return m;
}

// ── Telegram continuing a Mission Control conversation. Same thread as the web chat: it resumes that
//    workspace's `web.session:<ws>` and runs on the workspace's Claude profile, so the model already
//    knows what you were doing in Flow. But it keeps the TELEGRAM persona and, critically, no
//    CHRONOS_ADMIN — the phone can read and PROPOSE, never execute directly. Keyed per (chat,
//    workspace) so switching the active workspace switches which conversation you're continuing.
//    ponytail: web and Telegram share one CLI session id per workspace, which is what makes it one
//    conversation across channels. Two SIMULTANEOUS turns (phone + browser, same workspace) would race
//    on the stored id — single-operator daemon, so unguarded; add a per-workspace lock if it bites. ──
// The chat's active workspace, or null. telegram.ts owns the writes (write-through to kv); this reads
// kv directly to stay out of an import cycle.
export function activeWsForChat(chat: number): string | null {
  const id = kv.get(`tg.activeWs.${chat}`);
  return id && workspaces.get(id) ? id : null;
}

const tgWsWarm = new Map<string, WarmManager>();
function warmForChatWs(chat: number, wsId: string): WarmManager {
  const key = wsKey(wsId);
  const mapKey = `${chat}:${key}`;
  let m = tgWsWarm.get(mapKey);
  if (m && memoryMoved("robert")) { m.kill(); tgWsWarm.delete(mapKey); m = undefined; }
  if (!m) {
    m = new WarmManager({
      // propose-and-confirm — NOT the web execute-directly persona. Same workspace skill index as the
      // web chat, so continuing a thread from the phone knows the same procedures.
      system: personaSystem("robert", robertPrompt("telegram"), agentContext(wsId), briefsBlock(wsId)),
      model: CONFIG.agent.model,
      allowedTools: MANAGER_TOOLS,
      profileDir: webProfileDir(wsId), // the workspace's account + skills + MCP
      // deliberately no extraEnv: without CHRONOS_ADMIN the agent can only read and PROPOSE
      resumeSessionId: getWebSession(key),
      onSessionId: (id) => setWebSession(key, id),
      onStaleResume: () => clearWebSession(key),
      turnTimeoutMs: CONFIG.agent.timeoutSec * 1000,
      maxTurns: WEB_MAX_TURNS,
    });
    tgWsWarm.set(mapKey, m);
  }
  return m;
}

// "New conversation" (from Flow or Telegram) must also drop any Telegram process resuming that thread,
// or the phone would keep talking to the session the operator just reset.
function dropTgWsManagers(key: string) {
  for (const [k, m] of tgWsWarm) {
    if (k.endsWith(`:${key}`)) { m.kill(); tgWsWarm.delete(k); }
  }
}

// Daemon boot → pre-warm the configured operator chat's manager so the first Telegram message skips
// CLI startup (resumes the stored kv session). No-op if no chat is configured. Idle warm costs nothing.
export function prewarmTelegram() {
  const chatId = CONFIG.telegram.chatId;
  if (chatId) warmForChat(Number(chatId)).warm();
}
