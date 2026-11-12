/**
 * What Robert does himself — the setting `robert.hands`, and the code that holds him to it.
 *
 * The operator's words: "only if it's a simple answer then Robert, all the rest goes to its own
 * terminal." The persona has always said so (agents/_blocks/routing.md), and a new user still watched
 * Robert do the work in the chat: prose is a request, not a wall. With `answers` (the default) two walls
 * stand in code, and both leave his real job — reading the shop and coordinating it — untouched:
 *
 *  - his sandbox (robertReadonlyDirs → sandbox.ts's read-only tier, look-only form): every project's
 *    places on disk and the daemon's own checkout are read-only to him. He can read a file to answer a
 *    question; he cannot edit one, build in one, or commit in one.
 *  - his turn (TurnBudget → handOff): an operator chat turn gets a few looks. Calls to the Chronos API or
 *    `mc` that change something (a ticket, a terminal, a setting, an ask, a memo) are coordination and
 *    cost nothing; reads cost one; reads outside Chronos (files, searches, shell, the web) also count
 *    against a smaller allowance. The call past the budget ends the turn, a terminal opens in that
 *    project seeded with the request and what he had found, and his reply is one line naming it.
 *    Opening or dispatching anything himself switches the count off for that turn: that IS the job.
 *
 * The numbers come from his real turns (chat_messages.steps, 248 operator turns with tool calls,
 * 2026-09-22 → 2026-11-10): tool calls per turn p50 2 · p75 4 · p90 8 · max 14; outside-Chronos calls
 * p50 1 · p75 2 · p90 5; a status brief p50 6 · max 9. The turns past 8 calls (8%) were mostly him in a
 * repo — cd, grep, sed, git grep — which is the behaviour being removed. Wakes and automatic turns never
 * carry a budget (only callers that pass the operator's words do), and a status read gets twice the
 * longest brief seen.
 *
 * `anything` is the old behaviour: the same prose, no walls.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bus } from "./bus.js";
import { CONFIG } from "./config.js";
import { resolveNotesDir, REPO_ROOT } from "./repo-root.js";
import { humanizeStep, normalizeCommand, terminalMove, type RobertStep } from "./robert-steps.js";
import { wsTicketsDir } from "./sandbox.js";
import { setting } from "./settings.js";
import { repos, sessions, tickets, workspaces } from "./store.js";
import { isSocial } from "./thread-router.js";
import { saidInSpanish } from "./turn-failure.js";
import { worktreeRootFor } from "./worktree-core.js";
import type { Workspace } from "./types.js";

export type Hands = "answers" | "anything";

/** What Robert does himself in this project (or, with no project, for the whole shop). */
export function robertHands(wsId?: string | null): Hands {
  return setting("robert.hands", wsId ?? null) === "anything" ? "anything" : "answers";
}

/**
 * The CLI's built-in tool set for him while he answers: exactly the tools agents/robert/AGENT.md
 * declares, as `claude --tools`. `--allowed-tools` alone only pre-approves — under
 * --dangerously-skip-permissions the CLI still exposes Edit, Write, NotebookEdit, Task and the rest
 * (checked on claude 2.1.322: init lists 25 built-ins with --allowed-tools "Bash,Read", exactly the six
 * with --tools; MCP servers load either way). Null when he may do anything (the old wiring).
 */
export function robertBuiltinTools(wsId: string | null | undefined, declared: string): string | null {
  return robertHands(wsId) === "answers" ? declared : null;
}

// ───────────────────────────── the sandbox wall ─────────────────────────────

/** A path and, when it differs, its real path — Seatbelt matches resolved paths, so a rule needs both. */
function withReal(p: string): string[] {
  try {
    const r = fs.realpathSync(p);
    return r === p ? [p] : [p, r];
  } catch {
    return [p];
  }
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * A project's places on disk: its repos (its own and the ones shared into it) and their worktree
 * roots, its landing dir, its ticket files and its notes.
 */
export function workspacePlaces(wsId: string): string[] {
  const w = workspaces.get(wsId);
  if (!w) return [];
  const out: string[] = [];
  for (const r of repos.accessible(wsId)) if (r.path) out.push(r.path, worktreeRootFor(r.path));
  if (w.default_dir) out.push(w.default_dir);
  out.push(wsTicketsDir(w.slug), path.join(resolveNotesDir(), w.slug));
  return out;
}

/**
 * What Robert may read but never write while he answers: the places of every project he can see — his
 * own project's, or every project's for the fleet-wide Robert — and the daemon's own checkout, which
 * holds every client's notes and tickets and the daemon's code. [] when he may do anything.
 *
 * Never `/`, $HOME or anything above it: that would take his Claude profile, temp and caches with it.
 * A place that happens to hold his own home or profile is fine — the sandbox re-grants what the caller
 * itself granted inside a read-only dir (sandbox.ts readonlyRules).
 */
export function robertReadonlyDirs(wsId: string | null): string[] {
  if (robertHands(wsId) !== "answers") return [];
  const ids = wsId ? [wsId] : workspaces.list(true).map((w) => w.id);
  const home = path.resolve(os.homedir());
  const out = new Set<string>();
  for (const p of [...ids.flatMap(workspacePlaces), REPO_ROOT, process.cwd()]) {
    if (!p) continue;
    const abs = path.resolve(p);
    if (abs === "/" || abs === home || isInside(home, abs)) continue;
    for (const q of withReal(abs)) out.add(q);
  }
  return [...out];
}

// ───────────────────────────── the turn budget ─────────────────────────────

export type Limits = { looks: number; outside: number };
/** A turn that may be work: 8 looks, at most 4 of them outside Chronos. The next one hands it off. */
export const WORK_LIMITS: Limits = { looks: 8, outside: 4 };
/** A status read ("status", "what's running", a recap): twice the longest brief seen (9), no outside cap of its own. */
export const STATUS_LIMITS: Limits = { looks: 16, outside: 16 };

// Questions about the shop, answered from reads — not the routing list (thread-router FLEET_INTENT):
// "fix everything" is work, whatever word it shares with "how's everything".
const STATUS_RE: RegExp[] = [
  /^\s*(status|estado|state)\b/i,
  /\bwhat('?s| is| are)?\s*(now|next|up|running|going on|happening|left|on fire|waiting|pending)\b/i,
  /\bwho needs me\b/i,
  /\bqu[eé]\s*(pas[oó]|pasa|sigue|falta|est[aá] corriendo|hay(?!\s+que))/i,
  /\b(standup|overview|brief me|briefing|rollup|pulse)\b/i,
  /\bhow('?s| is) (it going|everything|the shop|the fleet)\b/i,
  /\bc[oó]mo (va|vamos|venimos|anda)\b/i,
  /\ben qu[eé] estamos\b/i,
  /\b(recap|ahoy|where were we|d[oó]nde quedamos)\b/i,
];

/** "status", "what's running", a recap, a hello → a read of the shop. Anything else may be work. */
export function turnKind(words: string): "status" | "work" {
  const t = String(words ?? "").trim();
  if (!t) return "work";
  return STATUS_RE.some((re) => re.test(t)) || isSocial(t) ? "status" : "work";
}

export const limitsFor = (words: string): Limits => (turnKind(words) === "status" ? STATUS_LIMITS : WORK_LIMITS);

/** One tool call as it starts: the CLI's raw block when the engine streams it, else its one-line description. */
export type ToolCall = { name?: string | null; input?: unknown; desc?: string };
/** routes: opened or dispatched work (the count stops); acts: changed something in Chronos (free); outside: left Chronos. */
export type CallKind = { routes: boolean; acts: boolean; outside: boolean };

const LOCAL_API = /\b(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\//i;
const SHELL_TOOLS = new Set(["Bash", "shell", "exec", "run_terminal_command", "local_shell"]);
// Moves that hand work to an agent, as humanizeStep words them (terminal opens come from terminalMove).
const ROUTE_STEP = /^POST \/(?:tickets\/[^/]+\/(?:dispatch|dispatch-plan|dispatch-grade)|jobs\/[^/]+\/run|runs\/[^/]+\/continue|sessions\/[^/]+\/resume|nextday|startday)$|^Reopened the terminal$|^mc job run\b/;

/** The shell command a call runs, whole when the engine streamed the raw block, else from its description. */
function shellCommand(c: ToolCall): string | null {
  const inp = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : null;
  if (c.name && SHELL_TOOLS.has(c.name) && typeof inp?.command === "string") return inp.command;
  const m = /^run\s+([\s\S]+)$/.exec((c.desc ?? "").trim());
  return m ? m[1] : null;
}

/** What one tool call was, for the budget. A command is coordination only when it talks to Chronos itself. */
export function classifyCall(c: ToolCall): CallKind {
  const cmd = shellCommand(c);
  if (cmd == null) return { routes: false, acts: false, outside: true }; // a file, a search, the web, an MCP tool
  const kinds = cmd
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter((s) => LOCAL_API.test(s) || /^mc\s/.test(normalizeCommand(s)))
    .map((s) => humanizeStep(`run ${s}`))
    .filter((s): s is RobertStep => !!s);
  if (!kinds.length) return { routes: false, acts: false, outside: true };
  const routes = kinds.some((s) => terminalMove(s)?.move === "open" || ROUTE_STEP.test(s.text));
  return { routes, acts: routes || kinds.some((s) => s.kind === "act"), outside: false };
}

/**
 * One operator turn's allowance. `note` every tool call as it starts; the first call past the limits
 * answers "trip" (once) and the caller ends the turn. What it saw rides into the terminal's brief.
 */
export class TurnBudget {
  looks = 0;
  outside = 0;
  routed = false;
  tripped = false;
  /** The calls he made, as the operator reads them (humanizeStep), the cut one excluded. */
  readonly seen: string[] = [];
  /** Everything his calls named, for "which project did he go into" (the fleet-wide Robert only). */
  readonly reached: string[] = [];
  private said = "";

  constructor(readonly limits: Limits, readonly scope: string | null = null) {}

  note(c: ToolCall): "ok" | "trip" {
    if (this.tripped) return "ok";
    const k = classifyCall(c);
    if (k.routes) this.routed = true;
    if (this.routed) return "ok";
    if (!k.acts) this.looks++;
    if (k.outside) this.outside++;
    // Where the cut call was going is still evidence of which project this is.
    if (this.scope === null) this.reached.push(callText(c));
    if (this.looks > this.limits.looks || this.outside > this.limits.outside) {
      this.tripped = true;
      return "trip";
    }
    const desc = wholeDesc(c);
    const step = desc ? humanizeStep(desc) : null;
    if (step && step.kind !== "warn") this.seen.push(step.text);
    return "ok";
  }

  /** His reply text as it streams — what he had worked out before the cut. */
  hear(text: string): void {
    if (!this.tripped && text) this.said = (this.said + text).slice(-4000);
  }

  get heard(): string {
    return this.said.replace(/\s+/g, " ").trim();
  }
}

/**
 * The call's one-line description, rebuilt from the raw block when there is one: describeTool clips a
 * path at 100 characters, and humanizeStep's "Read <basename>" then names a fragment of a folder.
 */
function wholeDesc(c: ToolCall): string | undefined {
  const inp = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : null;
  if (c.name && /^(Read|Edit|Write|NotebookEdit)$/.test(c.name) && typeof (inp?.file_path ?? inp?.notebook_path) === "string")
    return `${c.name} ${inp!.file_path ?? inp!.notebook_path}`;
  const cmd = shellCommand(c);
  return cmd != null ? `run ${cmd.replace(/\s+/g, " ").trim()}` : c.desc;
}

/** Strings in a tool call that say where it went: its command, path, URL. */
function callText(c: ToolCall): string {
  const inp = c.input && typeof c.input === "object" ? (c.input as Record<string, unknown>) : {};
  const parts = [c.desc ?? ""];
  for (const k of ["command", "file_path", "path", "notebook_path", "url"]) if (typeof inp[k] === "string") parts.push(inp[k] as string);
  return parts.join("\n");
}

// ───────────────────────────── which project ─────────────────────────────

/**
 * The projects the fleet-wide Robert's calls went into: a path inside a project's places, or a
 * project, terminal or ticket named in a Chronos call. Evidence only — names in prose are not read.
 */
export function projectsReached(texts: string[]): string[] {
  const all = workspaces.list();
  const places = all
    .flatMap((w) => workspacePlaces(w.id).flatMap((p) => withReal(path.resolve(p)).map((dir) => ({ dir, ws: w.id }))))
    .sort((a, b) => b.dir.length - a.dir.length);
  const found = new Set<string>();
  const home = os.homedir();
  const byRef = (ref: string) => workspaces.get(ref)?.id ?? workspaces.getBySlug(ref)?.id;
  for (const t of texts) {
    for (const m of t.matchAll(/(?:^|[\s'"=:(])((?:~|\/)[^\s'"`;|&<>()]+)/g)) {
      const p = path.resolve(m[1].startsWith("~") ? path.join(home, m[1].slice(1)) : m[1]);
      const hit = places.find((x) => p === x.dir || p.startsWith(x.dir + path.sep));
      if (hit) found.add(hit.ws);
    }
    for (const m of t.matchAll(/\/api\/workspaces\/([\w-]+)|[?&]workspace(?:_id)?=([\w-]+)|"workspace_id"\s*:\s*"([\w-]+)"|--workspace[= ]([\w-]+)/g)) {
      const id = byRef(m[1] ?? m[2] ?? m[3] ?? m[4]);
      if (id) found.add(id);
    }
    for (const m of t.matchAll(/\/api\/sessions\/([0-9a-f]{8}[0-9a-f-]{0,28})|\bmc session \w+ ([0-9a-f]{8}[0-9a-f-]{0,28})/g)) {
      const ref = (m[1] ?? m[2]).toLowerCase();
      const s = sessions.get(ref) ?? sessions.list({ limit: 400 }).find((x) => x.id.startsWith(ref));
      if (s?.workspace_id) found.add(s.workspace_id);
    }
    for (const m of t.matchAll(/\/api\/tickets\/([0-9a-f-]{36})/g)) {
      const w = tickets.get(m[1])?.workspace_id;
      if (w) found.add(w);
    }
  }
  return [...found].filter((id) => all.some((w) => w.id === id));
}

export type HomePick = { ws: Workspace | null; how: "only" | "personal" | "created" | "none" };

/**
 * Where work with no project goes. The only project there is; else the operator's own (kind
 * "personal"); else — with no project at all, a brand-new install — a Personal project created now,
 * so the work opens in a terminal rather than staying in the chat. Several client projects and none of
 * them his own: nowhere (the caller asks which).
 */
export function homeWorkspace(opts: { create?: boolean; landingRoot?: string } = {}): HomePick {
  const live = workspaces.list();
  if (live.length === 1) return { ws: live[0], how: "only" };
  const own = live.filter((w) => w.kind === "personal").sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (own) return { ws: own, how: "personal" };
  if (live.length || !opts.create) return { ws: null, how: "none" };
  return { ws: createPersonal(opts.landingRoot), how: "created" };
}

/**
 * The Personal project, created on first need — the README's own first project (slug "personal", the
 * default Claude profile). It lands in a folder Chronos owns, `~/.chronos-landing/personal` (the same
 * root a host builds landing dirs under, hostd/landing.ts): never one of his own folders, where a
 * repo-scan of the landing dir would adopt checkouts that are not this project's, and never $HOME,
 * where a terminal could write anywhere. Synchronous on purpose, so two hand-offs cannot both create one.
 */
function createPersonal(root = path.join(os.homedir(), ".chronos-landing")): Workspace {
  let slug = "personal";
  for (let n = 2; workspaces.getBySlug(slug); n++) slug = `personal-${n}`;
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configDir = CONFIG.profiles[CONFIG.agent.profile] ?? CONFIG.profiles.claude;
  const w = workspaces.create({ slug, name: "Personal", kind: "personal", config_dir: configDir, default_dir: dir });
  console.log(`[robert-hands] no project yet — created ${slug} (landing ${dir}) for the first piece of work`);
  bus.publish({ topic: "workspace.changed" } as any);
  // The same per-project jobs POST /workspaces seeds (each is a no-op when its knob is off).
  void Promise.all([import("./inbox-cleanup.js"), import("./job-check.js")])
    .then(([c, j]) => { c.ensureCleanupJob(w); j.ensureCheckJob(w); })
    .catch((e) => console.warn("[robert-hands] seeding the new project's jobs:", e?.message ?? e));
  return w;
}

// ───────────────────────────── the hand-off ─────────────────────────────

const clip = (s: string, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/**
 * The terminal's goal: his request, on one line. Double quotes become single ones: the goal is
 * announced as `mc session new --goal "<goal>"` (humanizeStep reads it back to the quote) and the
 * ledger matches the terminal to its turn on those exact words.
 */
export const goalOf = (words: string) =>
  clip(String(words ?? "").split("\n").find((l) => l.trim()) ?? words, 90).replace(/"/g, "'") || "his request from the chat";

export type OpenFn = (o: { workspace_id: string; role: "worker"; goal: string; description: string; created_by: string; backend?: string }) => Promise<{ id: string }>;

export type HandOffInput = {
  /** What the operator said — the request itself. */
  words: string;
  /** The project whose Robert took the turn; null = the fleet-wide Robert. */
  wsId: string | null;
  budget: TurnBudget;
  /** Read aloud (a voice turn, the voice front): no terminal id in the line. */
  spoken?: boolean;
  /** Say the open as one of this turn's steps BEFORE it happens — the ledger matches the terminal to it. */
  announce?: (step: RobertStep, ws: string) => void;
  /** Test seam; the daemon's own openSession otherwise. */
  open?: OpenFn;
  landingRoot?: string;
};

export type HandOffResult = { reply: string; session: { id: string; ws: string } | null; how: "project" | "reached" | HomePick["how"] };

let openerForTest: OpenFn | null = null;
/** Tests of a whole turn (askManagerWeb) swap the terminal opener for a stub. null restores openSession. */
export function setHandOffOpener(fn: OpenFn | null): void { openerForTest = fn; }

/**
 * The turn went past his budget: the work goes to a terminal in that project, and his reply says so in
 * one line. The fleet-wide Robert's project is where his calls went, else the home project.
 *
 * Workspaces never mix: what he had found rides into the brief only when nothing in it can belong to
 * another project — always for a project's own Robert (his walls and his prompt hold only that
 * project), and for the fleet-wide one only when his calls stayed inside the target. Even then his
 * streamed text stays out (his prompt carries every project's ledger): the steps he took are enough.
 */
export async function handOff(i: HandOffInput): Promise<HandOffResult> {
  const es = saidInSpanish(i.words);
  let target: string | null = i.wsId;
  let how: HandOffResult["how"] = "project";
  let findings = !!i.wsId;
  if (!target) {
    const reached = projectsReached(i.budget.reached);
    if (reached.length === 1) {
      target = reached[0];
      how = "reached";
      findings = true;
    } else if (!reached.length) {
      const home = homeWorkspace({ create: true, landingRoot: i.landingRoot });
      target = home.ws?.id ?? null;
      how = home.how;
      findings = home.how !== "none";
    } else {
      how = "none";
    }
  }
  if (!target) {
    return {
      reply: es
        ? "Eso es más que una respuesta rápida y no sé de qué proyecto es — decime cuál y te abro una terminal ahí."
        : "That's more than a quick answer, and I can't tell which project it belongs to — tell me which one and I'll open a terminal there.",
      session: null,
      how,
    };
  }
  const goal = goalOf(i.words);
  const looked = findings ? i.budget.seen.slice(-8) : [];
  const heard = findings && i.wsId ? clip(i.budget.heard, 700) : "";
  const description = [
    `His words, to the assistant in the chat: "${clip(i.words, 2500)}"`,
    "That needed more than a quick answer, so it is this terminal's job — the assistant handed it over instead of doing it in the chat.",
    looked.length ? `What the assistant had already looked at:\n${looked.map((s) => `- ${s}`).join("\n")}` : "",
    heard ? `What it had worked out so far: ${heard}` : "",
  ].filter(Boolean).join("\n\n");
  const step = humanizeStep(`run mc session new --goal "${goal}"`);
  if (step) i.announce?.(step, target);
  // The cwd is openSession's to pick (the project's landing dir or repo), as for any Desk terminal.
  const open: OpenFn = i.open ?? openerForTest ?? (async (o) => (await import("./terminal.js")).openSession(o as any));
  try {
    const backend = workspaces.get(target)?.default_backend || undefined;
    const s = await open({ workspace_id: target, role: "worker", goal, description, created_by: "robert", ...(backend ? { backend } : {}) });
    const id8 = s.id.slice(0, 8);
    const reply = es
      ? i.spoken ? `Eso es más que una respuesta rápida, así que te abrí una terminal: ${goal}.` : `Eso es más que una respuesta rápida — te abrí una terminal: ${goal} · ${id8}`
      : i.spoken ? `That's more than a quick answer, so I opened a terminal for it: ${goal}.` : `That's more than a quick answer — I opened a terminal for it: ${goal} · ${id8}`;
    return { reply, session: { id: s.id, ws: target }, how };
  } catch (e: any) {
    const why = clip(String(e?.message ?? e), 200);
    return {
      reply: es ? `Eso es más que una respuesta rápida, pero la terminal no abrió: ${why}` : `That's more than a quick answer, but the terminal didn't open: ${why}`,
      session: null,
      how,
    };
  }
}

/** The error a turn ends with when its budget handed it off — never a limit or auth error, so no fallback engine re-runs it. */
export const HANDED_OFF = "robert-hands: handed off to a terminal";
