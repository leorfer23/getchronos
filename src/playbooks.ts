/**
 * Playbooks — a workspace's recurring multi-step chain, run on ONE operator OK.
 *
 * Why: the same release chain (merge the PR → build and upload a release → refresh a service → rebuild
 * a hosted data page → leave an unsent "it is live" draft) ran twice in two days in one workspace, each
 * step approved separately through Robert's asks — four approvals a run, plus reminders when a step was
 * missed, and once an approval for one PR was nearly taken for another.
 *
 * A playbook is a name and ordered steps: a shell command, an `mc` command, an instruction for the
 * agent, and an optional final message that is always a draft. Some steps are GATES — merge, deploy,
 * publish, release: a recognised command is always one (`gh pr merge`, `mc service deploy`, `npm
 * publish`, `gh release create`…), and the operator can mark any other step as one.
 *
 *   create a run ── `mc playbook run <name> --pr <url>` (a terminal, Robert) or the Desk's Run
 *    │              the steps are copied, the PR's head SHA is read; nothing runs yet
 *   ONE OK ──────── POST /api/playbook-runs/:id/ok from the operator's own hand (ledger-routes.ts
 *    │              operatorHand: the admin token itself, no agent header, x-mc-operator: 1). It names
 *    │              the head SHA he was shown and every gate the run will pass; both must still be true
 *   the terminal ── opened in the SAME workspace (openSession) or, with --here, the one that asked
 *    │              (sendInput). It works step by step through `mc playbook step <n> start|done|fail`.
 *   each start ──── the daemon checks the order, that the OK covered this gate (exactly this step), and
 *                   before every gate that the PR head is still the one he OK'd. Moved → the run stops
 *                   (needs_ok) and waits for a new OK. A failed step stops the run and asks him; a
 *                   failed run is never run again on its own — a new run, with a new OK, is.
 *
 * Steps run in the run's terminal, in that workspace's sandbox — a playbook never gives a command more
 * reach than the agent already has. The one exception is the step the agent cannot do itself:
 * `mc service deploy|restart <name>` (services are operator-only, SERVICES.md). Inside a run he OK'd,
 * on a service of that workspace, the daemon carries it out when the step starts.
 *
 * The walls: every step is checked against its workspace when it is saved and again when a run is
 * created — a `cd` outside the workspace's repos/services, a path into another workspace, a service or
 * a `--workspace` that is not this one's, a merge of any PR but the run's own (`{{pr}}`) are refused —
 * and a run's PR must belong to the workspace (pr-ownership.ts).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bus } from "./bus.js";
import { prBelongsTo } from "./pr-ownership.js";
import { worktreeRootFor } from "./worktree-core.js";
import {
  asks, GATE_KINDS, LIVE_RUN_STATES, playbookRuns, playbooks, repos, services, sessions, workspaces,
  type Ask, type GateKind, type OkGate, type Playbook, type PlaybookRun, type PlaybookStep, type RunState, type PlaybookRunStep, type Service,
} from "./store.js";
import type { Workspace } from "./types.js";

/** `created_by` of the terminals a run opens. */
export const PLAYBOOK_BY = "playbook";
export const MAX_STEPS = 30;
export const MAX_RUN_CHARS = 4000;
/** A run nobody OK'd within this long is void. */
export const OK_WAIT_MS = 24 * 3600_000;
/** An OK is good for this long: a run not finished by then is void — a new run asks again. */
export const RUN_TTL_MS = 24 * 3600_000;

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/;
const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const TEMPLATE_VARS = new Set(["pr", "pr_number", "sha", "repo"]);
const id8 = (id: string) => id.slice(0, 8);
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");
const iso = (ms: number) => new Date(ms).toISOString();

export type Fail = { ok: false; status: number; error: string; [k: string]: unknown };
export type Result<T> = ({ ok: true } & T) | Fail;
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Fail => ({ ok: false, status, error, ...extra });

// ───────────────────────────── the line format ─────────────────────────────
//
// What `mc playbook save --file`, the Desk's editor and `mc playbook show` read and write. One step a
// line; a line indented two spaces continues the step above (a heredoc, a long command).
//
//   [merge] gh pr merge {{pr}} --squash --match-head-commit {{sha}}
//   cd ~/work/tool && make release
//   [release] ./scripts/upload.sh dist/tool.zip
//   mc service deploy bot
//   [publish] agent: rebuild the data page and republish it
//   message slack @requester: It is live — what changed, in two lines.

const GATE_TAG = /^\[([a-z]+)\]\s*/i;
const MESSAGE_RE = /^message\s+(slack|email)\s+(.+?):\s+([\s\S]+)$/i;
const CONTINUE = /^( {2}|\t)/;

export function parseSteps(text: string): { steps: PlaybookStep[]; errors: string[] } {
  const blocks: { line: number; text: string }[] = [];
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    if (CONTINUE.test(raw) && blocks.length) {
      blocks[blocks.length - 1].text += "\n" + raw.replace(CONTINUE, "");
      return;
    }
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    blocks.push({ line: i + 1, text: t });
  });
  const steps: PlaybookStep[] = [];
  const errors: string[] = [];
  for (const b of blocks) {
    let rest = b.text.replace(/\s+$/, "");
    let gate: GateKind | null = null;
    const g = GATE_TAG.exec(rest);
    if (g) {
      const k = g[1].toLowerCase() as GateKind;
      if (!GATE_KINDS.includes(k)) {
        errors.push(`line ${b.line}: [${g[1]}] is not a gate — merge, deploy, publish or release`);
        continue;
      }
      gate = k;
      rest = rest.slice(g[0].length);
    }
    if (/^agent:/i.test(rest)) {
      steps.push({ kind: "agent", run: rest.replace(/^agent:\s*/i, ""), gate });
    } else if (/^message\b/i.test(rest)) {
      const m = MESSAGE_RE.exec(rest);
      if (!m) { errors.push(`line ${b.line}: a message step is "message slack|email <to>: <text>"`); continue; }
      if (gate) { errors.push(`line ${b.line}: a message is a draft, never a gate`); continue; }
      steps.push({ kind: "message", channel: m[1].toLowerCase() as "slack" | "email", to: m[2].trim(), run: m[3].trim(), gate: null });
    } else if (/^mc(\s|$)/.test(rest)) {
      steps.push({ kind: "mc", run: rest, gate });
    } else {
      steps.push({ kind: "shell", run: rest, gate });
    }
    if (!steps[steps.length - 1].run.trim()) {
      steps.pop();
      errors.push(`line ${b.line}: an empty step`);
    }
  }
  return { steps, errors };
}

const indentRest = (s: string) => s.split("\n").map((l, i) => (i ? "  " + l : l)).join("\n");

export function formatSteps(steps: PlaybookStep[]): string {
  return steps.map((s) => {
    const g = s.gate ? `[${s.gate}] ` : "";
    if (s.kind === "message") return indentRest(`message ${s.channel ?? "slack"} ${s.to ?? "?"}: ${s.run}`);
    if (s.kind === "agent") return indentRest(`${g}agent: ${s.run}`);
    return indentRest(`${g}${s.run}`);
  }).join("\n");
}

// ───────────────────────────── gates, labels ─────────────────────────────

/** Commands that are always a gate, whatever the step says. */
const GATE_PATTERNS: Array<[GateKind, RegExp]> = [
  ["merge", /\bgh\s+pr\s+merge\b/],
  ["deploy", /^mc\s+service\s+(deploy|restart)\b/],
  ["deploy", /\bnpm\s+run\s+deploy\b|\bwrangler\s+(deploy|publish)\b|\bfly(ctl)?\s+deploy\b|\bkubectl\s+(apply|rollout)\b|\bterraform\s+apply\b|\bfirebase\s+deploy\b|\bvercel\b[^\n]*--prod\b|\bgcloud\s+[\w-]+\s+deploy\b/],
  ["publish", /\b(npm|pnpm|yarn)\s+publish\b|\bmc\s+artifact\s+(put|publish)\b|\bdocker\s+push\b|\btwine\s+upload\b|\bcargo\s+publish\b/],
  ["release", /\bgh\s+release\s+(create|upload)\b|\brclone\s+(copy|copyto|sync|move)\b|\baws\s+s3\s+(cp|sync|mv)\b|\bgsutil\s+(cp|rsync|mv)\b|\bgcloud\s+storage\s+(cp|rsync)\b|\bbox\s+files:(upload|version)/],
];

export function detectGate(s: Pick<PlaybookStep, "kind" | "run">): GateKind | null {
  if (s.kind !== "shell" && s.kind !== "mc") return null;
  for (const [g, re] of GATE_PATTERNS) if (re.test(s.run)) return g;
  return null;
}

/** Every step as stored: a message is never a gate; a recognised command always is (an explicit kind wins). */
export function normalizeSteps(steps: PlaybookStep[]): PlaybookStep[] {
  return steps.map((s) => {
    const run = String(s.run ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (s.kind === "message") return { kind: "message", run, gate: null, to: String(s.to ?? "").trim(), channel: s.channel === "email" ? "email" : "slack" };
    const gate = (s.gate && GATE_KINDS.includes(s.gate) ? s.gate : null) ?? detectGate({ kind: s.kind, run });
    return { kind: s.kind, run, gate };
  });
}

/** `mc service deploy|restart <name>` — the one kind of step the daemon carries out itself. */
export function serviceAction(s: Pick<PlaybookStep, "kind" | "run">): { action: "deploy" | "restart"; name: string } | null {
  if (s.kind !== "mc") return null;
  const m = /^mc\s+service\s+(deploy|restart)\s+([a-z0-9][a-z0-9_-]*)\s*$/.exec(s.run.trim());
  return m ? { action: m[1] as "deploy" | "restart", name: m[2] } : null;
}

const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** What a step reads as on a card: the command without its leading `cd`, the instruction, who a draft is for. */
export function stepLabel(s: PlaybookStep): string {
  if (s.kind === "message") return `Draft for ${s.to ?? "?"} (${s.channel ?? "slack"}) — never sent`;
  if (s.kind === "agent") return oneLine(s.run);
  return oneLine(s.run.split("\n")[0].replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, ""));
}

/** What the OK binds per gate: exactly what that step runs (its template — the SHA is bound on its own). */
export function stepHash(s: PlaybookStep): string {
  return crypto.createHash("sha256").update(JSON.stringify([s.kind, s.gate, s.run, s.to ?? null, s.channel ?? null])).digest("hex").slice(0, 16);
}

// ───────────────────────────── the walls ─────────────────────────────

const home = () => os.homedir();
const expandHome = (p: string) => (p === "~" ? home() : p.startsWith("~/") ? path.join(home(), p.slice(2)) : p);
export function isUnder(p: string, root: string): boolean {
  const a = path.resolve(p);
  const b = path.resolve(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Where this workspace's steps may `cd`: its repos (owned or shared in) and their worktrees, its landing dir, its services. */
export function workspaceRoots(ws: Workspace): string[] {
  const out = new Set<string>();
  for (const r of repos.accessible(ws.id)) {
    if (!r.path) continue;
    out.add(r.path);
    out.add(worktreeRootFor(r.path));
  }
  if (ws.default_dir) out.add(expandHome(ws.default_dir));
  for (const s of services.list(ws.id)) if (s.cwd) out.add(s.cwd);
  return [...out];
}

const hasVar = (p: string) => /[$`{}*?]/.test(p);
/** Absolute (or ~) paths a command names. Rough on purpose: a guardrail; the sandbox is the wall. */
export function pathsIn(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:^|[\s=:'"(])((?:~|\/)[^\s'"`;|&<>()]*)/g)) {
    const p = m[1];
    if (p.startsWith("//") || hasVar(p)) continue;
    out.push(expandHome(p));
  }
  return out;
}
/** Where a command `cd`s to — the targets it names, when they can be read without running it. */
export function cdTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:^|&&|\|\||;|\n|\()\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g)) {
    const p = m[1] ?? m[2] ?? m[3];
    if (!p || hasVar(p) || p === "-") continue;
    out.push(p);
  }
  return out;
}

const MC_WS_FLAG = /(?:^|\s)--(?:workspace|ws)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/g;
const SERVICE_READS = new Set(["ls", "list", "status", "show", "logs", "log"]);

/** Every way these steps would reach outside the workspace — empty when they don't. */
export function validateSteps(ws: Workspace, steps: PlaybookStep[]): string[] {
  const errors: string[] = [];
  if (!steps.length) errors.push("a playbook needs at least one step");
  if (steps.length > MAX_STEPS) errors.push(`at most ${MAX_STEPS} steps (this has ${steps.length})`);
  const roots = workspaceRoots(ws);
  const deny = workspaces.isolationDenyDirs(ws.id);
  const mine = new Set([ws.id, ws.slug]);
  if (steps.filter((x) => x.kind === "message").length > 1) errors.push("one message step at most");
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    const run = String(s.run ?? "");
    if (!run.trim()) errors.push(`${at}: empty`);
    if (run.length > MAX_RUN_CHARS) errors.push(`${at}: longer than ${MAX_RUN_CHARS} characters`);
    for (const m of run.matchAll(TEMPLATE_RE)) if (!TEMPLATE_VARS.has(m[1])) errors.push(`${at}: {{${m[1]}}} is not a template — {{pr}}, {{pr_number}}, {{sha}} or {{repo}}`);
    if (s.kind === "message") {
      if (i !== steps.length - 1) errors.push(`${at}: the message step is the last one`);
      if (s.gate) errors.push(`${at}: a message is a draft, never a gate`);
      if (!String(s.to ?? "").trim()) errors.push(`${at}: who is the draft for?`);
      return;
    }
    if (s.kind === "agent") {
      if (s.gate === "merge") errors.push(`${at}: a merge is the command itself — \`gh pr merge {{pr}} …\`, so the daemon can bind it to the SHA he OK'd`);
      return;
    }
    if (s.kind === "mc" && !/^mc\s+\S/.test(run)) errors.push(`${at}: an mc step starts with \`mc \``);
    // A merge merges the run's own PR, at the head he OK'd — never a PR named in the step.
    if (/\bgh\s+pr\s+merge\b/.test(run) && !/\bgh\s+pr\s+merge\s+\{\{\s*pr\s*\}\}/.test(run)) {
      errors.push(`${at}: a merge step merges the run's PR — write \`gh pr merge {{pr}} …\``);
    }
    const svc = /^mc\s+service\s+(\S+)/.exec(run.trim());
    if (svc) {
      const act = serviceAction(s);
      if (act) {
        if (!services.byName(ws.id, act.name)) errors.push(`${at}: this workspace has no service named '${act.name}'`);
      } else if (!SERVICE_READS.has(svc[1])) {
        errors.push(`${at}: a playbook deploys or restarts one of this workspace's services per step — \`mc service deploy|restart <name>\` alone on the line`);
      }
    }
    if (s.kind === "mc" || /(^|[\s;&|(])mc\s/.test(run)) {
      for (const m of run.matchAll(MC_WS_FLAG)) {
        const v = m[1].replace(/^["']|["']$/g, "");
        if (!mine.has(v)) errors.push(`${at}: --workspace ${v} is not this workspace`);
      }
    }
    for (const t of cdTargets(run)) {
      const p = expandHome(t);
      if (!path.isAbsolute(p)) continue;
      if (!roots.some((r) => isUnder(p, r))) errors.push(`${at}: \`cd ${t}\` is outside this workspace's repos and services`);
    }
    for (const p of pathsIn(run)) {
      if (deny.some((d) => isUnder(p, d))) errors.push(`${at}: ${p} belongs to another workspace`);
    }
  });
  return [...new Set(errors)];
}

// ───────────────────────────── the target ─────────────────────────────

export type Target = { pr_url: string | null; pr_number: number | null; sha: string | null };

export const usesTarget = (s: Pick<PlaybookStep, "run">): boolean => /\{\{\s*(pr|pr_number|sha|repo)\s*\}\}/.test(s.run);

export function repoOfPr(url: string | null | undefined): string | null {
  const m = PR_URL_RE.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The command a step runs for this target. A merge is always pinned to the head he OK'd. */
export function renderRun(s: PlaybookStep, t: Target): string {
  let out = s.run.replace(TEMPLATE_RE, (all, k: string) =>
    k === "pr" ? t.pr_url ?? all : k === "pr_number" ? (t.pr_number != null ? String(t.pr_number) : all) : k === "sha" ? t.sha ?? all : k === "repo" ? repoOfPr(t.pr_url) ?? all : all);
  if (s.gate === "merge" && /\bgh\s+pr\s+merge\b/.test(out) && !/--match-head-commit\b/.test(out) && t.sha) out += ` --match-head-commit ${t.sha}`;
  return out;
}

const targetOf = (r: PlaybookRun): Target => ({ pr_url: r.pr_url, pr_number: r.pr_number, sha: r.ok_sha ?? r.head_sha });

// ───────────────────────────── drafting from a terminal's transcript ─────────────────────────────

export type ToolCall = { tool: string; input: any; ok: boolean; at: number | null };

/** The tool calls in a CLI transcript, in order, each marked by whether it worked. claude and codex. */
export function readCalls(text: string, backend: string | null | undefined): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const codex = /^codex/.test(String(backend ?? ""));
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const at = Date.parse(o?.timestamp) || null;
    if (codex) {
      if (o?.type !== "response_item") continue;
      const p = o.payload ?? {};
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        let args: any = {};
        try { args = JSON.parse(p.arguments ?? "{}"); } catch {}
        const cmd = codexCommand(args);
        const call: ToolCall = cmd != null ? { tool: "Bash", input: { command: cmd }, ok: true, at } : { tool: String(p.name ?? "tool"), input: args, ok: true, at };
        calls.push(call);
        if (typeof p.call_id === "string") byId.set(p.call_id, call);
      } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && typeof p.call_id === "string") {
        const c = byId.get(p.call_id);
        try {
          const out = JSON.parse(String(p.output ?? ""));
          if (c && Number(out?.metadata?.exit_code ?? 0) !== 0) c.ok = false;
        } catch {}
      }
      continue;
    }
    if (o?.isSidechain) continue; // a subagent's own calls are not the chain the terminal ran
    const blocks = Array.isArray(o?.message?.content) ? o.message.content : [];
    if (o?.type === "assistant") {
      for (const b of blocks) {
        if (b?.type !== "tool_use") continue;
        const call: ToolCall = { tool: String(b.name ?? ""), input: b.input ?? {}, ok: true, at };
        calls.push(call);
        if (typeof b.id === "string") byId.set(b.id, call);
      }
    } else if (o?.type === "user") {
      for (const b of blocks) {
        if (b?.type === "tool_result" && b.is_error && typeof b.tool_use_id === "string") {
          const c = byId.get(b.tool_use_id);
          if (c) c.ok = false;
        }
      }
    }
  }
  return calls;
}

function codexCommand(args: any): string | null {
  if (typeof args?.cmd === "string") return args.cmd;
  const c = args?.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c) && c.every((x) => typeof x === "string")) {
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && /^-l?c$/.test(c[1])) return c[2];
    return c.join(" ");
  }
  return null;
}

// Commands that only look: never a step of a chain.
const READ_CMDS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "wc", "echo", "printf",
  "pwd", "which", "type", "date", "sleep", "true", "false", "test", "[", "stat", "file", "du", "df", "ps", "pgrep", "lsof",
  "printenv", "id", "whoami", "uname", "hostname", "basename", "dirname", "realpath", "readlink", "sort", "uniq", "cut",
  "tr", "jq", "diff", "cmp", "shasum", "md5", "md5sum", "sha1sum", "sha256sum", "tree", "column", "open", "unzip", "zipinfo",
  "launchctl", "awk", "xxd", "nl", "tee",
]);
const READ_GIT = new Set(["status", "log", "diff", "show", "fetch", "remote", "rev-parse", "describe", "ls-files", "ls-remote", "merge-base", "blame", "reflog", "cat-file", "shortlog", "grep"]);
const READ_GH = /^(pr\s+(view|list|checks|diff|status)|run\s+(list|view|watch)|repo\s+view|issue\s+(view|list)|release\s+(view|list|download)|auth\s+status|search\b)/;
// Chronos bookkeeping a terminal does around the work — progress, state, memory, questions.
const MC_NOISE = new Set([
  "outcome", "progress", "state", "goal", "when", "steps", "step", "recall", "memo", "learn", "lesson", "prose", "ask-robert",
  "askrobert", "ask-lead", "ask", "show", "pad", "jot", "desk", "session", "whoami", "vars", "var", "pr", "heavy", "idea",
  "remember", "note", "worklog", "search", "status", "machine", "usage", "clip", "playbook", "playbooks", "asks", "answer",
  "report", "tell", "inbox", "activity", "fleet", "agents", "wall", "worktree", "wt", "lead", "browser", "cost", "file", "files",
]);
const ENV_CMDS = new Set(["cd", "set", "source", ".", "export", "unset", "mkdir", "pushd", "popd"]);

/** Split on top-level `&&`, `||`, `;` and newlines — not inside quotes, $( ) or backticks. */
export function splitTop(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const two = cmd.slice(i, i + 2);
    if (q) {
      cur += c;
      if (c === "\\" && q !== "'" && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { q = c; cur += c; continue; }
    if (two === "$(") { depth++; cur += two; i++; continue; }
    if (c === ")" && depth) { depth--; cur += c; continue; }
    if (!depth && (two === "&&" || two === "||")) { out.push(cur); cur = ""; i++; continue; }
    if (!depth && (c === ";" || c === "\n")) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Drop what a segment pipes into only to read it (`| tail -3`, `| jq …`) and where it throws output away. */
function stripDisplay(seg: string): string {
  let s = seg.replace(/\s+\d?>\s*\/dev\/null\b/g, "").replace(/\s+2>&1\b/g, "").trim();
  const parts = s.split(/\s\|\s(?!\|)/);
  while (parts.length > 1) {
    const head = parts[parts.length - 1].trim().split(/\s+/)[0];
    if (!["tail", "head", "cut", "grep", "egrep", "jq", "sed", "awk", "sort", "uniq", "wc", "less", "cat", "tr", "column", "tee"].includes(head)) break;
    parts.pop();
  }
  s = parts.join(" | ").trim();
  return s;
}

type SegClass = "env" | "read" | "noise" | "do";
export function classifySegment(seg: string): SegClass {
  let words: string[] = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (;;) {
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    if (!words.length) return "env";
    const w = path.basename(words[0]);
    if (w === "timeout" || w === "gtimeout") { words = words.slice(2); continue; }
    if (w === "nice") { words = words.slice(words[1] === "-n" ? 3 : /^-\d+$/.test(words[1] ?? "") ? 2 : 1); continue; }
    if (w === "env" || w === "command" || w === "time" || w === "rtk") { words = words.slice(1); continue; }
    break;
  }
  const w0 = path.basename(words[0]);
  const w1 = words[1] ?? "";
  const w2 = words[2] ?? "";
  const rest = words.slice(1).join(" ");
  if (ENV_CMDS.has(w0)) return "env";
  if (w0 === "mc") {
    if (w1 === "service") return w2 === "deploy" || w2 === "restart" ? "do" : "read";
    if (w1 === "artifact" || w1 === "artifacts") return w2 === "put" || w2 === "publish" ? "do" : "noise";
    return MC_NOISE.has(w1) ? "noise" : "do";
  }
  if (w0 === "git") return READ_GIT.has(w1) || (w1 === "branch" && !/\s-[dDmM]\b/.test(rest)) || (w1 === "worktree" && w2 === "list") || (w1 === "tag" && !w2) || (w1 === "config" && w2 === "--get") ? "read" : "do";
  if (w0 === "gh") {
    if (READ_GH.test(rest)) return "read";
    if (w1 === "api") return /\s(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)\s/i.test(" " + rest + " ") ? "do" : "read";
    return "do";
  }
  if (w0 === "curl") return /\s(-T|--upload-file|-F|--form|-d|--data[\w-]*|--json)\b|\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i.test(" " + rest) ? "do" : "read";
  if (w0 === "box") return /^(files|folders):(get|download|items|search|list)\b/.test(w1) ? "read" : "do";
  if (w0 === "sed") return /\s-i\b/.test(" " + rest) ? "do" : "read";
  return READ_CMDS.has(w0) ? "read" : "do";
}

/** A Bash call as a step: only the segments that DO something (and what they need first), or null. */
export function simplifyCommand(cmd: string): string | null {
  const text = String(cmd ?? "").trim();
  if (!text) return null;
  if (text.includes("<<")) return text; // a heredoc is one thing; the operator trims it if it is noise
  const segs = splitTop(text).map(stripDisplay).filter(Boolean);
  const kept: string[] = [];
  let pending: string[] = [];
  let any = false;
  for (const s of segs) {
    const c = classifySegment(s);
    if (c === "env") pending.push(s);
    else if (c === "do") { kept.push(...pending, s); pending = []; any = true; }
  }
  return any ? kept.join(" && ") : null;
}

/**
 * A service deploy is a step of its own — the daemon carries it out, alone on its line — so a command
 * that did one in the middle (`cd x && mc service deploy bot && …`) becomes up to three steps.
 */
function serviceSplit(run: string): string[] {
  const segs = run.split(" && ");
  if (!segs.some((g) => serviceAction({ kind: "mc", run: g }))) return [run];
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.some((g) => classifySegment(g) === "do")) out.push(buf.join(" && "));
    buf = [];
  };
  for (const g of segs) {
    if (serviceAction({ kind: "mc", run: g })) { flush(); out.push(g.trim()); } else buf.push(g);
  }
  flush();
  return out;
}

const MERGE_RE = /\bgh\s+pr\s+merge\s+(\S+)/;
function mergeTarget(cmd: string): { url: string | null; sha: string | null; method: string } {
  const ref = MERGE_RE.exec(cmd)?.[1] ?? "";
  const repo = /--repo(?:=|\s+)(\S+)/.exec(cmd)?.[1] ?? /-R\s+(\S+)/.exec(cmd)?.[1] ?? null;
  const sha = /--match-head-commit(?:=|\s+)([0-9a-f]{7,40})/.exec(cmd)?.[1] ?? null;
  const method = /--(squash|merge|rebase)\b/.exec(cmd)?.[1] ?? "squash";
  let url: string | null = null;
  if (PR_URL_RE.test(ref)) url = ref.replace(/\/$/, "");
  else if (/^#?\d+$/.test(ref) && repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) url = `https://github.com/${repo}/pull/${ref.replace("#", "")}`;
  return { url, sha, method };
}

export type Draft = { steps: PlaybookStep[]; notes: string[]; target: { pr_url: string | null; sha: string | null } };

/**
 * Steps out of what a terminal ran: the commands that changed something (looks and Chronos
 * bookkeeping dropped), from its first merge on when it merged one — the chain starts there — with the
 * PR and its head as templates, repeats folded, its last draft as the final message, and a claude.ai
 * page it republished as an instruction. A draft: the operator reviews and edits it.
 */
export function draftSteps(all: ToolCall[], opts: { since?: number | null } = {}): Draft {
  const notes: string[] = [];
  const calls = all.filter((c) => c.ok && (opts.since == null || c.at == null || c.at >= opts.since));
  const failed = all.filter((c) => !c.ok).length;
  if (failed) notes.push(`left out ${failed} call${failed === 1 ? "" : "s"} that failed`);
  type Cand = { step: PlaybookStep; merge?: { url: string | null; sha: string | null; method: string } };
  const cands: Cand[] = [];
  for (const c of calls) {
    const tool = c.tool;
    if (tool === "Bash" || tool === "shell" || tool === "exec_command" || tool === "local_shell") {
      const cmd = typeof c.input?.command === "string" ? c.input.command : "";
      const run = simplifyCommand(cmd);
      if (!run) continue;
      for (const part of serviceSplit(run)) {
        const merge = MERGE_RE.test(part) ? mergeTarget(part) : undefined;
        cands.push({ step: { kind: /^mc\s/.test(part) ? "mc" : "shell", run: part, gate: null }, merge });
      }
    } else if (/slack_send_message_draft$/.test(tool)) {
      const to = String(c.input?.channel_id ?? c.input?.channel ?? "?");
      const text = String(c.input?.message ?? c.input?.text ?? "").trim();
      if (text) cands.push({ step: { kind: "message", channel: "slack", to, run: text, gate: null } });
    } else if (/(^|__)create_draft$/.test(tool)) {
      const to = Array.isArray(c.input?.to) ? c.input.to.join(", ") : String(c.input?.to ?? "?");
      const text = String(c.input?.body ?? c.input?.text ?? "").trim();
      if (text) cands.push({ step: { kind: "message", channel: "email", to, run: text, gate: null } });
    } else if (tool === "Artifact" && (c.input?.action == null || c.input.action === "publish") && typeof c.input?.url === "string") {
      cands.push({ step: { kind: "agent", run: `Republish the claude.ai page ${c.input.url} with the rebuilt data (the Artifact tool, publish to that url)`, gate: "publish" } });
    }
  }
  // The chain starts at the first merge: what came before was the work that made the PR.
  const first = cands.findIndex((c) => c.merge);
  let chain = cands;
  if (first > 0) {
    notes.push(`started at the first merge — left out ${first} earlier step${first === 1 ? "" : "s"}`);
    chain = cands.slice(first);
  }
  const target = { pr_url: chain[0]?.merge?.url ?? null, sha: chain[0]?.merge?.sha ?? null };
  const out: PlaybookStep[] = [];
  const otherMerges = new Set<string>();
  let message: PlaybookStep | null = null;
  for (const c of chain) {
    let s = c.step;
    if (s.kind === "message") { message = s; continue; }
    if (c.merge) {
      // Only the run's own PR is merged in a run; another PR it merged along the way is not a step.
      if (target.pr_url && c.merge.url && c.merge.url !== target.pr_url) { otherMerges.add(c.merge.url.replace(/^.*\/pull\//, "#")); continue; }
      s = { kind: "shell", run: `gh pr merge {{pr}} --${c.merge.method} --match-head-commit {{sha}}`, gate: "merge" };
    } else {
      let run = s.run;
      if (target.pr_url) run = run.split(target.pr_url).join("{{pr}}");
      if (target.sha && target.sha.length === 40) run = run.split(target.sha).join("{{sha}}");
      s = { ...s, run };
    }
    if (out.some((x) => x.kind === s.kind && x.run === s.run)) continue;
    out.push(s);
  }
  if (otherMerges.size) notes.push(`left out merges of other PRs (${[...otherMerges].join(", ")}) — a run merges only its own PR`);
  if (message) out.push(message);
  if (out.length > MAX_STEPS) {
    notes.push(`kept the first ${MAX_STEPS} of ${out.length} steps`);
    out.length = MAX_STEPS;
  }
  return { steps: normalizeSteps(out), notes, target };
}

/** Where a terminal's CLI transcript is, and which parser reads it. Null file = none found (yet). */
export async function transcriptOf(sessionId: string): Promise<{ file: string | null; backend: string; error?: string }> {
  const s = sessions.get(sessionId);
  if (!s) return { file: null, backend: "", error: "no such terminal" };
  const backend = String(s.backend ?? "claude-code");
  if (!/^(claude|codex)/.test(backend)) return { file: null, backend, error: `drafting reads claude and codex transcripts; this terminal runs ${backend}` };
  const { locateTranscript } = await import("./focus.js");
  const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
  if (s.host_id && s.host_id !== "local") {
    const { mirrorFile } = await import("./hosts/transcript-mirror.js");
    const f = mirrorFile(s.id);
    return { file: fs.existsSync(f) ? f : null, backend };
  }
  const ctx = { sessionId: s.id, backend, cwd: s.cwd ?? home(), configDir: ws?.config_dir ?? "", sinceMs: Date.parse(s.created_at) || 0 };
  let file = ctx.configDir ? locateTranscript(ctx) : null;
  if (!file) {
    // A walled account may have routed a live terminal to a sibling login (terminal.ts liveHomes).
    const { liveHomes } = await import("./terminal.js");
    const h = liveHomes(s.id);
    if (h) file = locateTranscript({ ...ctx, configDir: h.configDir });
  }
  return { file, backend };
}

// ───────────────────────────── seams (tests replace them; nothing real runs under test) ─────────────────────────────

export type PrHead = { state: string; head: string | null; number: number | null; draft: boolean };
export type OpenArgs = {
  workspace_id: string; goal: string; goal_source: "human"; description: string; created_by: string; role: "human";
  repo_id?: string; backend?: string;
};
export type PlaybookDeps = {
  /** The PR as GitHub has it now (state, head SHA) — read with the workspace's own reach. */
  readPr: (ws: Workspace, url: string) => Promise<PrHead>;
  /** Open the run's terminal (terminal.ts openSession). */
  open: (a: OpenArgs) => Promise<{ id: string }>;
  /** Type one line into a live terminal (terminal.ts sendInput). Resolves to why not, or null. */
  tell: (sessionId: string, text: string) => Promise<string | null>;
  /** Carry out `mc service deploy|restart` for a service of the run's workspace. Returns what happened. */
  service: (svc: Service, action: "deploy" | "restart") => Promise<string>;
  /** Tell the operator about a fresh ask (asks.ts notifyAskCreated). */
  notifyAsk: (a: Ask) => void;
  /** The run's progress, and a terminal waiting on the operator, on its Desk card (term-status.ts). */
  card: (sessionId: string, c: { progress?: { n: number; of: number; label: string } | null; waiting?: string | null }) => void;
};

const realDeps: PlaybookDeps = {
  readPr: async (ws, url) => {
    // A test never reads GitHub, whatever it forgot to stub.
    if (process.env.CHRONOS_TEST === "1") throw new Error("playbooks never run the real gh under test");
    const [{ ghReadEnv }, { execFileTimed }] = await Promise.all([import("./child-env.js"), import("./exec.js")]);
    const out = await execFileTimed("gh", ["pr", "view", url, "--json", "state,headRefOid,number,isDraft"], { cwd: home(), env: ghReadEnv(ws), timeout: 20_000 });
    const v = JSON.parse(out.stdout);
    return { state: String(v?.state ?? "").toUpperCase(), head: typeof v?.headRefOid === "string" ? v.headRefOid : null, number: Number(v?.number) || null, draft: !!v?.isDraft };
  },
  open: async (a) => {
    const { openSession } = await import("./terminal.js");
    return openSession(a as any);
  },
  tell: async (sid, text) => {
    // terminal.ts is heavy (ptys, hosts): loaded only when there is something to type.
    const { sendInput } = await import("./terminal.js");
    return sendInput(sid, { text }, PLAYBOOK_BY);
  },
  service: async (svc, action) => {
    const { serviceSupervisor } = await import("./services.js");
    if (action === "deploy") {
      const r = await serviceSupervisor().deploy(svc.id);
      return `deployed ${svc.ref ?? ""} ${short(r.from)} → ${short(r.to)}${r.restarted ? ", restarted" : " (switched off — not started)"}`.replace(/\s+/g, " ");
    }
    await serviceSupervisor().restart(svc.id);
    return `restarted ${svc.name}`;
  },
  notifyAsk: (a) => {
    void import("./asks.js").then((m) => m.notifyAskCreated(a, undefined)).catch((e) => console.error("[playbooks] ask notify failed", e));
  },
  card: (sid, c) => {
    void import("./term-status.js").then((m) => {
      if (c.progress !== undefined) m.setProgress(sid, c.progress);
      if (c.waiting) m.declare(sid, { state: "waiting", label: c.waiting, on: "person" });
    }).catch(() => {});
  },
};
let deps: PlaybookDeps = { ...realDeps };
/** Tests: replace some seams. null restores every real one. */
export function setPlaybookDeps(d: Partial<PlaybookDeps> | null): void {
  deps = d ? { ...deps, ...d } : { ...realDeps };
}

// ───────────────────────────── runs ─────────────────────────────

function publish(r: PlaybookRun, extra: { step?: number; step_status?: string; actor?: string; ok?: boolean } = {}): void {
  bus.publish({
    topic: "playbook.run", run_id: r.id, playbook_id: r.playbook_id, workspace_id: r.workspace_id, name: r.name, state: r.state,
    step: extra.step ?? null, step_status: extra.step_status ?? null, reason: r.reason, pr_url: r.pr_url,
    ok: extra.ok && r.ok_at ? { sha: r.ok_sha, gates: (r.ok_gates ?? []).map((g) => ({ idx: g.idx, gate: g.gate })), by: r.ok_by ?? "operator", surface: r.ok_surface } : null,
    actor: extra.actor ?? PLAYBOOK_BY,
  });
}

/** The gates the next OK covers: gate steps not yet done. */
export function pendingGates(r: Pick<PlaybookRun, "steps">): PlaybookRunStep[] {
  return r.steps.filter((s) => s.gate && (s.status === "todo" || s.status === "active"));
}

/** A run past its lifetime becomes `expired` — on any read, so nothing acts on a stale OK. */
export function freshen(r: PlaybookRun, nowMs = Date.now()): PlaybookRun {
  let why: string | null = null;
  if (r.state === "awaiting_ok" && nowMs - Date.parse(r.created_at) > OK_WAIT_MS) why = "nobody OK'd it within 24 hours";
  else if ((r.state === "running" || r.state === "needs_ok") && r.ok_at && nowMs - Date.parse(r.ok_at) > RUN_TTL_MS) why = "not finished within 24 hours of the OK — run it again for a new OK";
  if (!why) return r;
  const out = playbookRuns.patch(r.id, { state: "expired", reason: why, ended_at: iso(nowMs) }, [r.state]);
  if (out) publish(out);
  return out ?? playbookRuns.get(r.id) ?? r;
}

export type CreateOpts = { pr?: string | null; from?: number | null; here?: boolean; by: string; session?: string | null };

/** A run of this playbook, waiting for the operator's OK. Nothing runs here. */
export async function createRun(pb: Playbook, o: CreateOpts, nowMs = Date.now()): Promise<Result<{ run: PlaybookRun }>> {
  const ws = workspaces.get(pb.workspace_id);
  if (!ws || ws.archived) return fail(404, "workspace not found");
  const errs = validateSteps(ws, pb.steps);
  if (errs.length) return fail(400, `the playbook does not pass its checks any more — ${errs.join("; ")}`);
  const from = o.from ?? 1;
  if (!Number.isInteger(from) || from < 1 || from > pb.steps.length) return fail(400, `--from is a step number, 1 to ${pb.steps.length}`);
  for (const live of playbookRuns.list({ playbook_id: pb.id, states: LIVE_RUN_STATES })) {
    const f = freshen(live, nowMs);
    if (LIVE_RUN_STATES.includes(f.state)) return fail(409, `run ${id8(f.id)} of ${pb.name} is still ${f.state.replace("_", " ")} — stop it first (mc playbook stop ${id8(f.id)})`, { run_id: f.id });
  }
  const active = pb.steps.slice(from - 1);
  let pr_url: string | null = null;
  let pr_number: number | null = null;
  let head: string | null = null;
  if (o.pr) {
    const url = String(o.pr).trim().replace(/\/$/, "");
    const m = PR_URL_RE.exec(url);
    if (!m) return fail(400, "--pr is a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)");
    const own = prBelongsTo(ws.id, url);
    if (!own.ok) return fail(403, `not a PR of this workspace: ${own.why}`);
    let live: PrHead;
    try { live = await deps.readPr(ws, url); } catch (e) { return fail(502, `could not read the PR: ${String((e as Error)?.message ?? e).slice(0, 300)}`); }
    const merges = active.some((s) => s.gate === "merge");
    if (live.state === "CLOSED") return fail(409, "the PR is closed");
    if (merges && live.state !== "OPEN") return fail(409, `the PR is ${live.state.toLowerCase() || "not open"} — a run that merges it needs it open (after a merge, start past it with --from)`);
    if (merges && live.draft) return fail(409, "the PR is a draft");
    if (!live.head) return fail(502, "GitHub gave no head SHA for the PR");
    pr_url = url;
    pr_number = live.number ?? Number(m[3]);
    head = live.head;
  } else if (active.some(usesTarget)) {
    return fail(400, "this playbook acts on a PR — pass --pr <url>");
  }
  let requested: string | null = null;
  if (o.session) {
    const s = sessions.get(o.session);
    if (s && s.status === "live" && s.workspace_id === ws.id) requested = s.id;
  }
  if (o.here && !requested) return fail(400, "--here runs in the terminal that asks — call it from a live terminal of this workspace");
  const steps: PlaybookRunStep[] = pb.steps.map((s, i) => ({
    ...s, idx: i + 1, status: i + 1 < from ? "skipped" : "todo", note: i + 1 < from ? `before step ${from}` : null, started_at: null, ended_at: null,
  }));
  const run = playbookRuns.create({ playbook: pb, steps, pr_url, pr_number, head_sha: head, from_step: from, here: !!o.here, requested_by: o.by, requested_session: requested });
  publish(run, { actor: o.by });
  if (o.here && requested) deps.card(requested, { waiting: `playbook ${pb.name} waits for the operator's OK (Desk ▶ Playbooks)` });
  return { ok: true, run };
}

const prRef = (r: Pick<PlaybookRun, "pr_url" | "pr_number">) => (r.pr_url ? `${repoOfPr(r.pr_url)}#${r.pr_number ?? r.pr_url.replace(/^.*\//, "")}` : "");

/** The one line typed into a terminal that already exists (sendInput flattens newlines anyway). */
function hereLine(r: PlaybookRun, n: number, again: boolean): string {
  const what = `playbook run ${id8(r.id)} ("${r.name}"${r.pr_url ? `, ${prRef(r)} at ${short(r.ok_sha)}` : ""})`;
  return again
    ? `The operator OK'd ${what} again. Continue where it stopped: mc playbook step ${n} start — then follow the run's protocol exactly (mc playbook brief ${id8(r.id)}).`
    : `The operator OK'd ${what}. Read it with \`mc playbook brief ${id8(r.id)}\` and follow its protocol exactly, starting with: mc playbook step ${n} start`;
}

const nextIdx = (r: PlaybookRun) => r.steps.find((s) => s.status === "todo" || s.status === "active")?.idx ?? r.steps.length;

export type OkBody = { sha?: string | null; gates?: number[] | null; surface?: string | null };

/**
 * Record the operator's ONE OK and start the run. The route has already checked it is HIS hand. It
 * must name what he was shown — the head SHA and every gate still to run — and both must still be
 * true now: a moved head or a different gate list is refused, and he looks again.
 */
export async function okRun(run: PlaybookRun, b: OkBody, nowMs = Date.now()): Promise<Result<{ run: PlaybookRun }>> {
  let r = freshen(run, nowMs);
  if (r.state !== "awaiting_ok" && r.state !== "needs_ok") return fail(409, `the run is ${r.state.replace("_", " ")}${r.reason ? ` — ${r.reason}` : ""}`);
  const ws = workspaces.get(r.workspace_id);
  if (!ws || ws.archived) return fail(404, "workspace not found");
  const want = pendingGates(r).map((s) => s.idx);
  const got = [...new Set((b.gates ?? []).map(Number))].sort((x, y) => x - y);
  if (JSON.stringify(got) !== JSON.stringify(want)) return fail(409, "the gates are not the ones this run has — reload it and look again", { gates: want });
  if (r.pr_url) {
    if (!b.sha || b.sha !== r.head_sha) return fail(409, "that is not the head this run targets — reload it and look again", { head_sha: r.head_sha });
    let live: PrHead;
    try { live = await deps.readPr(ws, r.pr_url); } catch (e) { return fail(502, `could not read the PR to check its head: ${String((e as Error)?.message ?? e).slice(0, 300)}`); }
    if (live.head && live.head !== r.head_sha) {
      const moved = playbookRuns.patch(r.id, { head_sha: live.head, reason: `the PR head moved ${short(r.head_sha)} → ${short(live.head)} before the OK` }, [r.state]);
      if (moved) publish(moved);
      return fail(409, `the PR head moved since you looked (${short(r.head_sha)} → ${short(live.head)}) — look again`, { head_sha: live.head });
    }
    if (live.state === "CLOSED") return fail(409, "the PR is closed");
    if (pendingGates(r).some((s) => s.gate === "merge") && live.state !== "OPEN") return fail(409, `the PR is ${live.state.toLowerCase() || "not open"} — this run would merge it`);
  }
  const okGates: OkGate[] = pendingGates(r).map((s) => ({ idx: s.idx, gate: s.gate as GateKind, hash: stepHash(s) }));
  const again = !!r.session_id;
  const okd = playbookRuns.patch(r.id, {
    state: "running", reason: null, ok_sha: r.pr_url ? r.head_sha : null, ok_gates: okGates, ok_by: "operator", ok_at: iso(nowMs),
    ok_surface: String(b.surface ?? "desk").slice(0, 24),
  }, [r.state]);
  if (!okd) return fail(409, "the run changed while you answered — reload it");
  r = okd;
  publish(r, { actor: "operator", ok: true });
  const n = nextIdx(r);
  if (again) {
    const why = await deps.tell(r.session_id!, hereLine(r, n, true)).catch((e) => String((e as Error)?.message ?? e));
    if (!why) return { ok: true, run: r };
    // Its terminal is gone (closed, or a restart that did not bring it back): a new one picks the run
    // up where it stopped — the brief says which steps are done.
  }
  const asked = !again && r.here && r.requested_session ? sessions.get(r.requested_session) : undefined;
  if (asked && asked.status === "live" && asked.workspace_id === r.workspace_id) {
    r = playbookRuns.patch(r.id, { session_id: asked.id }) ?? r;
    const why = await deps.tell(asked.id, hereLine(r, n, false)).catch((e) => String((e as Error)?.message ?? e));
    if (!why) {
      progressCard(r);
      return { ok: true, run: r };
    }
    // Typed nowhere: stop rather than leave an OK'd run that no terminal knows about.
    const stopped = playbookRuns.patch(r.id, { state: "stopped", reason: `could not type into its terminal: ${why}`, ended_at: iso(nowMs) }, ["running"]);
    if (stopped) publish(stopped);
    return fail(409, `the OK is recorded but its terminal could not be told (${why}) — run it again`, { run: stopped ?? r });
  }
  const pb = playbooks.get(r.playbook_id);
  try {
    const s = await deps.open({
      workspace_id: r.workspace_id,
      goal: `Playbook ${r.name}${r.pr_url ? ` · ${prRef(r)}` : ""}`.slice(0, 400),
      goal_source: "human",
      description: runBrief(r, ws.name),
      created_by: PLAYBOOK_BY,
      role: "human",
      ...(pb?.repo_id ? { repo_id: pb.repo_id } : {}),
      ...(ws.default_backend ? { backend: ws.default_backend } : {}),
    });
    r = playbookRuns.patch(r.id, { session_id: s.id }) ?? r;
    progressCard(r);
    return { ok: true, run: r };
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 300);
    const stopped = playbookRuns.patch(r.id, { state: "stopped", reason: `could not open its terminal: ${why}`, ended_at: iso(nowMs) }, ["running"]);
    if (stopped) publish(stopped);
    return fail(503, `could not open the run's terminal: ${why}`, { run: stopped ?? r });
  }
}

function progressCard(r: PlaybookRun): void {
  if (!r.session_id) return;
  const counted = r.steps.filter((s) => s.status !== "skipped");
  const done = counted.filter((s) => s.status === "done").length;
  const cur = r.steps.find((s) => s.status === "active") ?? r.steps.find((s) => s.status === "todo");
  try {
    deps.card(r.session_id, { progress: { n: done, of: counted.length || 1, label: `${r.name}${cur ? ` · ${cur.idx}. ${stepLabel(cur)}` : ""}`.slice(0, 120) } });
  } catch { /* a card is a courtesy */ }
}

function setStep(r: PlaybookRun, idx: number, p: Partial<PlaybookRunStep>, from: readonly RunState[] = ["running"]): PlaybookRun | undefined {
  const steps = r.steps.map((s) => (s.idx === idx ? { ...s, ...p } : s));
  return playbookRuns.patch(r.id, { steps }, from);
}

/** Why a run in this state takes no step — said to the agent, which must stop. */
function stateRefusal(r: PlaybookRun): Fail {
  const why = r.reason ? ` — ${r.reason}` : "";
  if (r.state === "awaiting_ok") return fail(409, "the run is waiting for the operator's OK — nothing runs before it", { state: r.state, stop: true });
  if (r.state === "needs_ok") return fail(409, `the run is stopped${why}. The operator has to OK it again; you will be told here when he has. Do nothing for it until then.`, { state: r.state, stop: true });
  return fail(409, `the run is ${r.state}${why}. Do nothing more for it.`, { state: r.state, stop: true });
}

/** The question a failure puts to the operator, on the run's terminal. Never a retry of its own. */
function askAboutFailure(r: PlaybookRun, step: PlaybookRunStep, why: string): void {
  const gatesLeft = r.steps.filter((s) => s.gate && s.idx > step.idx && s.status === "todo").map((s) => `${s.gate} (step ${s.idx})`);
  const q = `Playbook ${r.name} stopped at step ${step.idx} (${stepLabel(step)}): ${oneLine(why, 300)}. Nothing after it ran${gatesLeft.length ? ` — not ${gatesLeft.join(", ")}` : ""}. Fix it, then run it again from step ${step.idx} (a new run, one new OK)?`;
  try {
    const a = asks.create({
      session_id: r.session_id, workspace_id: r.workspace_id, route: "operator", asked_by: `playbook ${r.name}`,
      question: q.slice(0, 1000), options: [`Fix it, then run again from step ${step.idx}`, "Leave it"],
    });
    deps.notifyAsk(a);
  } catch (e) {
    console.error("[playbooks] could not ask about a failed step", e);
  }
}

function failStep(r: PlaybookRun, idx: number, why: string, nowMs: number): PlaybookRun {
  const t = iso(nowMs);
  const step = r.steps.find((s) => s.idx === idx)!;
  const withStep = setStep(r, idx, { status: "failed", note: oneLine(why, 500), ended_at: t }) ?? r;
  const out = playbookRuns.patch(r.id, { state: "failed", reason: `step ${idx} (${stepLabel(step)}) failed: ${oneLine(why, 300)}`, ended_at: t }, ["running"]) ?? withStep;
  publish(out, { step: idx, step_status: "failed" });
  askAboutFailure(out, step, why);
  progressCard(out);
  return out;
}

export type StartOut = { run: PlaybookRun; step: PlaybookRunStep; command: string | null; carried: { ok: boolean; detail: string } | null };

/**
 * The agent is about to run step `n`. Refused — and the agent stops — unless the run is OK'd and
 * running, every step before it is done, it is not already finished, a gate is one the OK covered
 * (exactly this step), and before a gate the PR head is still the one he OK'd. A daemon-carried step
 * (`mc service deploy|restart`) is carried out right here.
 */
export async function startStep(run: PlaybookRun, n: number, nowMs = Date.now()): Promise<Result<StartOut>> {
  let r = freshen(run, nowMs);
  if (r.state !== "running") return stateRefusal(r);
  const step = r.steps.find((s) => s.idx === n);
  if (!step) return fail(404, `this run has no step ${n}`);
  if (step.status === "skipped") return fail(409, `step ${n} is not part of this run (it starts at step ${r.from_step})`, { stop: true });
  const before = r.steps.find((s) => s.idx < n && s.status !== "done" && s.status !== "skipped");
  if (before) return fail(409, `step ${before.idx} comes first (it is ${before.status})`);
  if (step.status === "done") return fail(409, `step ${n} is already done`);
  const svc = serviceAction(step);
  const t = targetOf(r);
  if (step.status === "active") {
    // A daemon-carried step still active means the carry-out never finished (a daemon restart): it is
    // not run twice on its own — it fails, and he decides.
    if (svc) return { ok: true, run: failStep(r, n, "it was being carried out when the daemon stopped — check the service before running it again", nowMs), step, command: null, carried: { ok: false, detail: "interrupted" } };
    return { ok: true, run: r, step, command: step.kind === "shell" || step.kind === "mc" ? renderRun(step, t) : null, carried: null };
  }
  if (step.gate) {
    const g = (r.ok_gates ?? []).find((x) => x.idx === n);
    if (!g || g.gate !== step.gate || g.hash !== stepHash(step)) {
      return fail(403, `step ${n} is a ${step.gate} gate the operator's OK did not cover — stop; nothing may run it`, { stop: true });
    }
    if (r.pr_url) {
      const ws = workspaces.get(r.workspace_id);
      if (!ws) return fail(404, "workspace not found");
      let live: PrHead;
      try { live = await deps.readPr(ws, r.pr_url); } catch (e) {
        return fail(503, `could not read the PR head to check it before this gate (${String((e as Error)?.message ?? e).slice(0, 200)}) — try \`start\` again in a minute`);
      }
      if (live.head && live.head !== r.ok_sha) {
        const why = `the PR head moved after the OK: ${short(r.ok_sha)} → ${short(live.head)}`;
        const moved = playbookRuns.patch(r.id, { state: "needs_ok", reason: why, head_sha: live.head }, ["running"]);
        if (moved) {
          publish(moved, { step: n });
          if (moved.session_id) deps.card(moved.session_id, { waiting: `playbook ${r.name}: the PR moved — waiting for the operator's OK again` });
        }
        return fail(409, `${why}. The run stopped before step ${n}; the operator has to OK it again — you will be told here when he has. Do nothing for it until then.`, { state: "needs_ok", stop: true });
      }
      if (live.state === "CLOSED" || (step.gate === "merge" && live.state === "MERGED")) {
        const why = live.state === "CLOSED" ? "the PR was closed" : "the PR was merged outside this run";
        const stopped = playbookRuns.patch(r.id, { state: "stopped", reason: why, ended_at: iso(nowMs) }, ["running"]);
        if (stopped) publish(stopped, { step: n });
        return fail(409, `${why} — the run stopped. Do nothing more for it.`, { state: "stopped", stop: true });
      }
    }
  }
  const started = setStep(r, n, { status: "active", started_at: iso(nowMs) });
  if (!started) return stateRefusal(playbookRuns.get(r.id) ?? r);
  r = started;
  publish(r, { step: n, step_status: "active" });
  progressCard(r);
  if (svc) {
    const s = services.byName(r.workspace_id, svc.name);
    if (!s) return { ok: true, run: failStep(r, n, `this workspace has no service named '${svc.name}'`, nowMs), step, command: null, carried: { ok: false, detail: "no such service" } };
    try {
      const detail = await deps.service(s, svc.action);
      const out = completeStep(r, n, "done", detail, Date.now(), true);
      return out.ok ? { ok: true, run: out.run, step, command: null, carried: { ok: true, detail } } : out;
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 500);
      return { ok: true, run: failStep(r, n, why, Date.now()), step, command: null, carried: { ok: false, detail: why } };
    }
  }
  return { ok: true, run: r, step, command: step.kind === "shell" || step.kind === "mc" ? renderRun(step, t) : null, carried: null };
}

/** Step `n` worked (done) or did not (failed). A failure ends the run and asks the operator; it is never retried here. */
export function finishStep(run: PlaybookRun, n: number, outcome: "done" | "failed", note: string | null, nowMs = Date.now()): Result<{ run: PlaybookRun }> {
  return completeStep(run, n, outcome, note, nowMs, false);
}

function completeStep(run: PlaybookRun, n: number, outcome: "done" | "failed", note: string | null, nowMs: number, byDaemon: boolean): Result<{ run: PlaybookRun }> {
  const r = freshen(run, nowMs);
  if (r.state !== "running") return stateRefusal(r);
  const step = r.steps.find((s) => s.idx === n);
  if (!step) return fail(404, `this run has no step ${n}`);
  if (step.status !== "active") return fail(409, `step ${n} is ${step.status} — \`mc playbook step ${n} start\` first`);
  if (serviceAction(step) && !byDaemon) return fail(409, `the daemon carries step ${n} out itself and records how it went — nothing to report`);
  if (outcome === "failed") return { ok: true, run: failStep(r, n, note?.trim() || "failed (no reason given)", nowMs) };
  const t = iso(nowMs);
  let out = setStep(r, n, { status: "done", note: note?.trim() ? oneLine(note, 500) : null, ended_at: t });
  if (!out) return stateRefusal(playbookRuns.get(r.id) ?? r);
  if (out.steps.every((s) => s.status === "done" || s.status === "skipped")) {
    out = playbookRuns.patch(out.id, { state: "done", reason: null, ended_at: t }, ["running"]) ?? out;
  }
  publish(out, { step: n, step_status: "done" });
  progressCard(out);
  return { ok: true, run: out };
}

/** Stop a run that has not finished. Always allowed in its workspace: stopping only ever halts. */
export function stopRun(run: PlaybookRun, by: string, why: string | null, nowMs = Date.now()): Result<{ run: PlaybookRun }> {
  const r = freshen(run, nowMs);
  if (!LIVE_RUN_STATES.includes(r.state)) return fail(409, `the run is already ${r.state}`);
  const out = playbookRuns.patch(r.id, { state: "stopped", reason: `stopped by ${by}${why ? `: ${oneLine(why, 200)}` : ""}`, ended_at: iso(nowMs) }, LIVE_RUN_STATES);
  if (!out) return fail(409, "the run changed — reload it");
  publish(out, { actor: by });
  // Its terminal — or, for a --here run still waiting for the OK, the terminal that asked for it.
  const sid = out.session_id ?? (out.here ? out.requested_session : null);
  if (sid && by !== "its terminal") void deps.tell(sid, `Playbook run ${id8(out.id)} (${out.name}) was stopped by ${by}${why ? ` (${oneLine(why, 120)})` : ""}. Do nothing more for it.`).catch(() => null);
  return { ok: true, run: out };
}

// ───────────────────────────── what surfaces show ─────────────────────────────

function stepView(s: PlaybookRunStep | (PlaybookStep & { idx: number }), t: Target) {
  return {
    idx: s.idx, kind: s.kind, gate: s.gate, label: stepLabel(s), run: s.kind === "shell" || s.kind === "mc" ? renderRun(s, t) : s.run,
    to: s.to ?? null, channel: s.channel ?? null, carried: !!serviceAction(s),
    ...("status" in s ? { status: s.status, note: s.note, started_at: s.started_at, ended_at: s.ended_at } : {}),
  };
}

export function runView(r: PlaybookRun) {
  const t = targetOf(r);
  const counted = r.steps.filter((s) => s.status !== "skipped");
  return {
    id: r.id, playbook_id: r.playbook_id, workspace_id: r.workspace_id, workspace_slug: workspaces.get(r.workspace_id)?.slug ?? null,
    name: r.name, state: r.state, reason: r.reason, pr_url: r.pr_url, pr_number: r.pr_number, head_sha: r.head_sha, from_step: r.from_step,
    session_id: r.session_id, session_live: r.session_id ? sessions.get(r.session_id)?.status === "live" : false,
    here: !!r.here, requested_by: r.requested_by, created_at: r.created_at, updated_at: r.updated_at, ended_at: r.ended_at,
    ok: r.ok_at ? { sha: r.ok_sha, gates: (r.ok_gates ?? []).map((g) => ({ idx: g.idx, gate: g.gate })), by: r.ok_by, at: r.ok_at, surface: r.ok_surface } : null,
    steps: r.steps.map((s) => stepView(s, t)),
    gates: pendingGates(r).map((s) => stepView(s, t)),
    progress: { done: counted.filter((s) => s.status === "done").length, total: counted.length },
    needs_ok: r.state === "awaiting_ok" || r.state === "needs_ok",
  };
}

export function playbookView(pb: Playbook, last?: PlaybookRun | null) {
  const t: Target = { pr_url: null, pr_number: null, sha: null };
  return {
    id: pb.id, workspace_id: pb.workspace_id, workspace_slug: workspaces.get(pb.workspace_id)?.slug ?? null, name: pb.name,
    description: pb.description, repo_id: pb.repo_id, source: pb.source, drafted_from: pb.drafted_from, reviewed: !!pb.reviewed_at,
    reviewed_at: pb.reviewed_at, created_by: pb.created_by, created_at: pb.created_at, updated_at: pb.updated_at,
    text: formatSteps(pb.steps),
    steps: pb.steps.map((s, i) => stepView({ ...s, idx: i + 1 }, t)),
    gates: pb.steps.map((s, i) => ({ idx: i + 1, gate: s.gate })).filter((g) => g.gate),
    needs_pr: pb.steps.some(usesTarget),
    last_run: last ? runView(last) : null,
  };
}

/** The run's terminal brief: the steps as they will run, the gates the OK covered, and the protocol. */
export function runBrief(r: PlaybookRun, wsName: string): string {
  const t = targetOf(r);
  const gates = (r.ok_gates ?? pendingGates(r).map((s) => ({ idx: s.idx, gate: s.gate as GateKind, hash: "" })));
  const line = (s: PlaybookRunStep) => {
    const head = `${s.idx}. `;
    if (s.status === "skipped") return `${head}(not in this run — it starts at step ${r.from_step}) ${stepLabel(s)}`;
    if (s.kind === "message") return indentRest(`${head}(a DRAFT — never send it) ${s.channel ?? "slack"} for ${s.to}: ${s.run}`);
    const g = s.gate ? `[${s.gate}] ` : "";
    if (s.kind === "agent") return indentRest(`${head}${g}(instruction) ${s.run}`);
    return indentRest(`${head}${g}${renderRun(s, t)}${serviceAction(s) ? "   ← the daemon carries this out when you start it" : ""}`);
  };
  const done = r.steps.filter((s) => s.status === "done").map((s) => s.idx);
  const next = r.steps.find((s) => s.status === "todo" || s.status === "active");
  return [
    `The daemon opened this terminal to run the playbook "${r.name}" for ${wsName} — run ${id8(r.id)}.`,
    ...(done.length ? [`Already done in this run: step${done.length === 1 ? "" : "s"} ${done.join(", ")}. Start at step ${next?.idx ?? "?"} — never redo a done step.`] : []),
    `The operator gave ONE OK for this run${r.pr_url ? `, for ${r.pr_url} at head ${short(r.ok_sha)}` : ""}. It covers these gates and nothing else:`,
    ...(gates.length ? gates.map((g) => `  - step ${g.idx}: ${g.gate}`) : ["  (none)"]),
    "",
    "## Steps — in this order, exactly as written",
    ...r.steps.map(line),
    "",
    "## Protocol — follow it exactly",
    "For each step n, in order:",
    "1. `mc playbook step <n> start` — the daemon checks the OK, the order and, before a gate, that the PR head is still the one he OK'd. If it refuses, STOP: do nothing more for this run, say why in one line and end your turn. (If the head moved he has to OK again; you will be told here when he has.)",
    "2. Do exactly that step: the command as printed, nothing added. A step marked \"the daemon carries this out\" is done by `start` itself — read its answer, never run it yourself.",
    "3. It worked → `mc playbook step <n> done \"<what happened, one line>\"`. Anything else — a non-zero exit, an error, output you did not expect → `mc playbook step <n> fail \"<what failed>\"` and STOP. The daemon asks the operator; wait for his answer in this terminal.",
    "Never retry, skip, reorder, edit or work around a step on your own, never run a gate `start` did not allow, and do nothing that is not one of these steps.",
    "The message step is ALWAYS a draft: leave it unsent (Slack: slack_send_message_draft · email: create_draft) and say where it is. Only a note to the operator himself may be sent, and only if your send tool allows it.",
    "When the last step is done: `mc outcome \"<what shipped>\"` and `mc goal done`.",
  ].join("\n");
}
