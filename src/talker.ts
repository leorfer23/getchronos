/**
 * The voice front ("front Robert"): the one conversation the operator has with Robert, spoken or typed.
 *
 * A small fast model answers him in about a second from what the daemon already knows — the request
 * ledger (every workspace's rows: he is the operator, he sees everything) and the approval queue,
 * injected into every turn by code — and hands real work to the existing per-workspace Robert in the
 * background. Behind the setting `voice.talker` (default off): off, POST /agent is unchanged.
 *
 * Two engines, one protocol (no tools — "inject and parse"):
 *   - `cli` (default): its own warm `claude -p` stream-json process on the operator's subscription
 *     (the profile the fleet-wide Robert already uses), haiku, effort low, thinking off, a ~2k-token
 *     system prompt that REPLACES Claude Code's own, no tools, no MCP, no skills, no CLAUDE.md, no
 *     output style, no session on disk. Spawned with a warm-up turn so the first real one is warm.
 *   - `api`: the Messages API, streaming, when the operator adds a key (CHRONOS_TALKER_API_KEY /
 *     ANTHROPIC_API_KEY, or AI_GATEWAY_API_KEY for the Vercel AI Gateway). Optional; nothing depends on it.
 * Each turn the model gets: what he said, the ledger and queue right now, and (after a respawn) the
 * last few exchanges. It answers in plain spoken sentences and, when work must happen, ends with
 * `§delegate <project> …` lines that code parses — and never speaks or shows.
 *
 * The walls, enforced here in code, not in the prompt:
 *   - READ across workspaces: the injected ledger and queue cover every workspace (or only the one a
 *     locked page is locked to, for a screen share).
 *   - WRITE into a workspace only by delegating to that workspace's own Robert. The message he gets is
 *     built by code (buildDelegation) from the operator's own words in this thread plus ledger ids of
 *     THAT workspace — never from the model's text, never from another workspace's rows. A model that
 *     read workspace A's rows has no field through which A's text can reach workspace B.
 *   - NEVER approve, merge, send or deploy: the only action the parser knows is `delegate`; this module
 *     calls no daemon route and holds no daemon token (the cli engine runs with no tools at all, the api
 *     engine sends only to the model provider). Approval stays on the deck / decision route, his hand only.
 *
 * Delegation is asynchronous: he hears "dale, lo miro" at once; when the project Robert's turn comes
 * back, one or two sentences of it land in the thread as a push with no operator line — every live
 * call speaks exactly those (static/phone.html, static/desk.html), and the chat shows it otherwise.
 *
 * Every turn is in the ledger: agent.asked (his words, the turn), markVoiceTurn when spoken, a request
 * per delegation (openRequest + its bound turn, so what the project Robert opens joins it), and a
 * closed "chat" request for a turn answered without any work.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bus } from "./bus.js";
import { chat, workspaces } from "./store.js";
import { requests, type RequestRow } from "./store/requests.js";
import { closeRequest, ledgerText, markVoiceTurn, openRequest, queueView } from "./ledger.js";
import { setting, settingOn } from "./settings.js";
import { noteHelperCall } from "./helper-spend.js";
import { GOAL_KINDS } from "./validation.js";
import { plainFailure } from "./turn-failure.js";
import type { GoalKind } from "./types.js";

// ───────────────────────────── engines + credentials ─────────────────────────────

export type TalkerEngine = "cli" | "api";
export type TalkerProvider = "anthropic" | "gateway";
export type TalkerCred = { provider: TalkerProvider; url: string; key: string; model: string };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";
export const DEFAULT_API_MODEL = "claude-haiku-5-5";
export const DEFAULT_CLI_MODEL = "haiku";

/** `claude-haiku-5-5` → the gateway's `anthropic/claude-haiku-5.5`; an id already in gateway form is kept. */
export function apiModelId(provider: TalkerProvider, model: string): string {
  const m = String(model || DEFAULT_API_MODEL).trim();
  if (provider === "anthropic") return m.replace(/^anthropic\//, "");
  if (m.includes("/")) return m;
  return "anthropic/" + m.replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

/**
 * The api engine's key. `auto`: an Anthropic key first, else the AI Gateway key. Null when the chosen
 * provider has no key.
 */
export function talkerCredential(
  env: NodeJS.ProcessEnv = process.env,
  provider = String(setting("voice.talker_provider") ?? "auto"),
  model = String(setting("voice.talker_api_model") || DEFAULT_API_MODEL),
): TalkerCred | null {
  const anth = env.CHRONOS_TALKER_API_KEY || env.ANTHROPIC_API_KEY || "";
  const gw = env.AI_GATEWAY_API_KEY || "";
  const pick: TalkerProvider | null = provider === "anthropic" ? (anth ? "anthropic" : null)
    : provider === "gateway" ? (gw ? "gateway" : null)
    : anth ? "anthropic" : gw ? "gateway" : null;
  if (!pick) return null;
  return {
    provider: pick,
    url: pick === "anthropic" ? env.CHRONOS_TALKER_URL || ANTHROPIC_URL : GATEWAY_URL,
    key: pick === "anthropic" ? anth : gw,
    model: apiModelId(pick, model),
  };
}

/** Which engine runs the front: the setting, except that `api` without a key falls back to `cli`. */
export function talkerEngine(): TalkerEngine {
  return setting("voice.talker_engine") === "api" && talkerCredential() ? "api" : "cli";
}

/** The front answers POST /agent: only when the operator turned it on. */
export function talkerOn(): boolean {
  return settingOn("voice.talker");
}

/** What GET /api/voice/config says about the front — never a key. */
export function talkerStatus(): { on: boolean; engine: TalkerEngine; model: string; api_key: TalkerProvider | null; warm: boolean } {
  const engine = talkerEngine();
  const cred = talkerCredential();
  return {
    on: talkerOn(), engine,
    model: engine === "api" ? cred!.model : String(setting("voice.talker_cli_model") || DEFAULT_CLI_MODEL),
    api_key: cred?.provider ?? null,
    warm: !!cliTalker?.isWarm(),
  };
}

// ───────────────────────────── the prompt ─────────────────────────────

/** The fixed part. The cli engine bakes it into the process; the api engine caches it (cache_control). */
export const TALKER_SYSTEM = `You are Robert, the operator's right hand. You are the front of his whole shop: one conversation, mostly by voice, sometimes typed. Behind you, each of his projects has its own Robert that does the real work (terminals, code, pull requests, analyses, drafts). You talk; they work.

Who he is: he runs software and data work for several clients and builds his own products. He is moving to voice only: no keyboard, no screen. He speaks Rioplatense Spanish and English and often mixes them in one sentence.

Every message from him arrives with a NOW block: the time, his projects, the ledger (what he asked for, where each thing is, what came back) and the approval queue (what waits for his decision). That block is the truth right now; earlier blocks are stale.

How you talk:
- Your words are read aloud. One to three short spoken sentences. Never more unless he asks for detail; if there is more, end with "¿Te cuento más?" (or "Want more?").
- Verdict first: the answer, or the one thing you need from him, in the first sentence.
- A greeting ("hola", "buen día", "hey") gets a greeting back in one short line — no status, no report, no list of what waits. Status only when he asks for it.
- A status question ("¿cómo va?", "¿cómo venimos?", "¿qué me espera?", "what's waiting?") is answered from the NOW block: how many things need him, the most urgent one, and anything stuck. Never list every project.
- His language of the moment: answer in the language of his last message; if he mixed, the one he used most. In Spanish use voseo ("decime", "dale", "fijate").
- Plain words only: no markdown, no lists, no headings, no emoji, no ids, no hashes, no paths, no URLs. Say a project by its name.
- Never invent status. If the NOW block does not say, say you do not know and offer to find out.

Handing work over: anything that needs doing (opening or steering terminals, fixing, checking, finding out something the ledger does not say, drafting) goes to that project's Robert. Say in one short sentence that you are on it, as yourself ("Dale, me pongo con eso", "Dale, lo miro en <project name>"), then add, on its own line at the very end, one line per project:
§delegate <project-slug> ids=<id8>,<id8> back=<0|1|2> kind=<pr|ui|investigation|qa|product|chat>
Only the slug is required. ids = ledger ids (in brackets in the NOW block) of THAT project's requests the work is about. back = how many of his earlier messages also belong to this request (0 = only his last one). The project's Robert receives exactly his words and those ids; nothing you write reaches the project, so if his words alone would not make sense to that Robert, ask him to say what he wants in one sentence instead of delegating. Never mention the § line out loud. His result comes back later and you will see it in the thread; do not wait for it and do not guess it.

To him there is ONE Robert: you. The Roberts behind you are how you work, never something he hears about. Never say "el Robert de <project>", "otro Robert", "le paso", "le pregunto a" or "that project's Robert": you look into it, you do it, you come back with the result. A project is named only as a place ("en <project name>").

What you never do:
- You never approve, merge, deploy or send anything, and you never ask a project's Robert to. Approvals are his, one item at a time, on his queue: when something waits for him, say what it is in one sentence and tell him to say "veamos" to go through it.
- You never claim work is done because someone said so: say what the ledger shows ("dice que está listo, falta la verificación").
- One project's matters stay in that project: one § line per project, and never another project's details in a request.`;

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Projects the front may name: every non-archived workspace, or the one a locked page is locked to. */
function projects(scope: string | null): Array<{ id: string; slug: string; name: string }> {
  return workspaces.list().filter((w) => !scope || w.id === scope).map((w) => ({ id: w.id, slug: w.slug, name: w.name }));
}

/** The NOW block: when, where, the ledger, the queue, the projects. Rebuilt every turn. */
export function talkerContext(scope: string | null, nowMs = Date.now()): string {
  const ws = scope ?? undefined;
  const q = queueView(ws);
  const items = scope ? q.items.filter((i) => i.workspace?.id === scope) : q.items;
  const queue = items.length
    ? items.slice(0, 6).map((i) => `- [${i.request_id.slice(0, 8)}] ${i.line}`).join("\n") + (items.length > 6 ? `\n- … ${items.length - 6} more` : "")
    : "- nothing waits for him";
  const held = q.held.length ? `\n(${q.held.length} put off for later)` : "";
  const list = projects(scope).map((p) => `${p.slug} (${p.name})`).join(", ") || "(none)";
  return [
    `NOW: ${new Date(nowMs).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit", day: "numeric", month: "long" })}.`,
    scope ? "His screen is locked to one project (a screen share): talk only about it and delegate only to it." : "",
    `Projects (slug and name): ${list}.`,
    ledgerText(ws, { max: 25, width: 150 }),
    `APPROVAL QUEUE (${items.length} waiting):\n${queue}${held}`,
  ].filter(Boolean).join("\n");
}

// ───────────────────────────── delegation ─────────────────────────────

export type Via = "voice" | "typed";
/** What one turn knows: his words (and his earlier ones), where it came from, what it did. */
export type TurnState = {
  turn: string;
  words: string;
  /** His previous messages in this thread, newest first — his own words only. */
  earlier: string[];
  scope: string | null;
  via: Via;
  surface: string;
  client?: string;
  delegations: Array<{ ws: string; request: string; turn: string }>;
};

function wsBySlug(name: string, scope: string | null) {
  const k = String(name || "").trim().replace(/^#/, "").toLowerCase();
  if (!k) return undefined;
  return projects(scope).find((p) => p.slug.toLowerCase() === k || p.name.toLowerCase() === k || p.id === k);
}

export type DelegateAsk = { project: string; ids: string[]; back: number; kind: string | null };

/** The `§delegate …` lines at the end of a reply → what they ask. The spoken part is everything before the first §. */
export function splitReply(text: string): { spoken: string; delegates: DelegateAsk[] } {
  const raw = String(text ?? "");
  const at = raw.indexOf("§");
  const spoken = (at < 0 ? raw : raw.slice(0, at)).trim();
  const delegates: DelegateAsk[] = [];
  if (at >= 0) {
    for (const line of raw.slice(at).split("\n")) {
      const m = /^\s*§\s*delegate\s+(\S+)(.*)$/i.exec(line);
      if (!m) continue;
      const opt = (k: string) => new RegExp(`\\b${k}\\s*=\\s*(\\S+)`, "i").exec(m[2])?.[1] ?? null;
      delegates.push({
        project: m[1].replace(/[,;.]+$/, ""),
        ids: (opt("ids") ?? "").split(",").map((x) => x.replace(/[^0-9a-f-]/gi, "")).filter((x) => x.length >= 4).slice(0, 5),
        back: Math.max(0, Math.min(Number(opt("back")) || 0, 2)),
        kind: opt("kind"),
      });
      if (delegates.length >= 4) break;
    }
  }
  return { spoken, delegates };
}

/**
 * The message a project's Robert receives — built from rows and his words, never from the model's text.
 * Refuses (ok:false) a project outside the scope, or an id that is not that project's request.
 */
export function buildDelegation(
  input: { project?: unknown; ids?: unknown; back?: unknown; kind?: unknown; [k: string]: unknown },
  st: Pick<TurnState, "words" | "earlier" | "scope">,
): { ok: true; ws: { id: string; slug: string; name: string }; payload: string; words: string; requestIds: string[]; kind: GoalKind | null } | { ok: false; error: string } {
  const p = wsBySlug(String(input.project ?? ""), st.scope);
  if (!p) return { ok: false, error: `no project "${clip(input.project, 40)}"${st.scope ? " on this locked screen" : ""}` };
  const ids = Array.isArray(input.ids) ? input.ids.slice(0, 5).map((x) => String(x)) : [];
  const rows: RequestRow[] = [];
  for (const id of ids) {
    const r = requests.resolve(id.trim());
    // The wall: only THIS project's own rows ride along. An id that is another workspace's (or the
    // operator's fleet-wide row, or a mistyped one) is dropped — nothing of it is in the payload — and
    // the work still goes out with his words. Refusing the whole hand-over left him with "dale, lo
    // miro" and nothing happening.
    if (!r || r.workspace_id !== p.id) continue;
    rows.push(r);
  }
  const back = Math.max(0, Math.min(Number(input.back) || 0, 2));
  const kind = GOAL_KINDS.includes(input.kind as GoalKind) ? (input.kind as GoalKind) : null;
  const words = String(st.words || "").trim();
  const earlier = st.earlier.slice(0, back).map((w) => String(w || "").trim()).filter(Boolean).reverse();
  const lines = [
    `FROM THE OPERATOR, through his voice front — for ${p.name} only.`,
    ...(earlier.length ? [`Before that he said: ${earlier.map((w) => `"${clip(w, 1500)}"`).join(" then ")}`] : []),
    `His words: "${clip(words, 3000)}"`,
    ...(rows.length ? ["It is about these requests of this project:", ...rows.map((r) => `- ${r.id.slice(0, 8)}: "${clip(r.words, 300)}" (${r.state})`)] : []),
    "",
    "Handle it as you normally would for this project. Do not merge, deploy or send anything on this: whatever needs his yes goes to his queue (mc outcome --ask …).",
    "Start your reply with one or two short spoken sentences: what you did or found, or the one question you need him to answer. No ids, no markdown in those sentences.",
  ];
  return { ok: true, ws: p, payload: lines.join("\n"), words: [...earlier, words].join(" … "), requestIds: rows.map((r) => r.id), kind };
}

export type Delegator = (payload: string, wsId: string, turn: string) => Promise<{ reply: string }>;
let delegator: Delegator | null = null;
/** Tests swap the project Robert for a stub. null restores the real one (askManagerWeb). */
export function setTalkerDelegator(fn: Delegator | null): void { delegator = fn; }
async function realDelegator(payload: string, wsId: string, turn: string) {
  const { askManagerWeb } = await import("./telegram/agent.js"); // late: agent.ts is heavy and imports half the daemon
  return askManagerWeb(payload, undefined, wsId, { turn, label: "front" });
}

/** What a project Robert's reply sounds like in the thread: its first one or two sentences, spoken. */
export function spokenResult(name: string, reply: string): string {
  const t = String(reply || "")
    .split("\n").filter((l) => !/^\s*(UI\b|\{.*\}\s*$|#{1,6}\s)/.test(l)).join("\n")
    .replace(/^::ask [0-9a-f-]{8,36}::$/gm, " Te dejó una pregunta en la cola. ")
    .replace(/^::artifact [0-9a-f-]{8,36}::$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[ \t]*(?:>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/\*\*|__|~~|[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return `${name}: terminó, sin nada que decir.`;
  const sentences = t.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [t];
  return `${name}: ${clip(sentences.slice(0, 2).join(" ").trim(), 320)}`;
}

/** Hand the work over: a ledger request first (so what that Robert opens joins it), then his turn, async. */
export function startDelegation(d: Extract<ReturnType<typeof buildDelegation>, { ok: true }>, st: TurnState): { request: string; turn: string; done: Promise<string> } {
  const turn = randomUUID();
  const req = openRequest({ workspace_id: d.ws.id, words: d.words || st.words, via: st.via, surface: st.surface, kind: d.kind, turn_id: turn });
  st.delegations.push({ ws: d.ws.id, request: req.id, turn });
  const ask = delegator ?? realDelegator;
  const done = (async () => {
    let line: string;
    let reply = "";
    try {
      reply = (await ask(d.payload, d.ws.id, turn)).reply || "";
      line = spokenResult(d.ws.name, reply);
    } catch (e: any) {
      const f = plainFailure(e, st.words);
      line = `${d.ws.name}: ${f.kind === "other" ? `no le pude pasar el pedido (${clip(e?.message ?? e, 120)}).` : f.reply}`;
    }
    try {
      // That project's own thread keeps his words and its Robert's answer — its recap, its memory.
      if (reply) chat.add(d.words || st.words, reply, "web", d.ws.id, null, null, null, "front");
      const row = chat.add("", line, "front", st.scope, null, null, null, "front");
      bus.publish({ topic: "agent.push", you: "", reply: line, at: row.created_at, source: "front", ws: st.scope, turn: `front-result:${turn}`, id: row.id, engine: "front" });
    } catch (e: any) {
      console.warn("[talker] result", e?.message ?? e);
    }
    return line;
  })();
  return { request: req.id, turn, done };
}

// ───────────────────────────── the stream filter ─────────────────────────────

/**
 * Deltas → what may be spoken and shown: everything before the first `§`. Once a § arrives the rest
 * of the reply is the code's (delegate lines), never the operator's ears.
 */
export function speakFilter(emit: (t: string) => void): { push: (t: string) => void; cut: () => boolean } {
  let closed = false;
  return {
    push(t: string) {
      if (closed || !t) return;
      const at = t.indexOf("§");
      if (at < 0) return emit(t);
      closed = true;
      if (at > 0) emit(t.slice(0, at));
    },
    cut: () => closed,
  };
}

// ───────────────────────────── engine: the warm CLI ─────────────────────────────

type CliTalker = {
  turn: (text: string, onDelta?: (t: string, kind: string) => void, label?: string, model?: string) => Promise<string>;
  warm: () => void;
  kill: () => void;
  isWarm: () => boolean;
  fresh: boolean;
  turns: number;
  warmed: Promise<void> | null;
};
let cliTalker: CliTalker | null = null;
const CLI_RECYCLE_TURNS = 20;

/** The talker's own dir: empty on purpose, so no project file, CLAUDE.md or .mcp.json is near it. */
function talkerHome(): string {
  const dir = path.join(os.homedir(), ".mc", "talker");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the spawn reports it */ }
  return dir;
}

/**
 * The args after `-p --input-format stream-json …`: replace Claude Code's system prompt with ours,
 * no tools, no MCP, no skills/commands, no session on disk, the profile's output style/CLAUDE.md/
 * rules/auto memory off, thinking off, low effort. Exported so a test pins what the talker spawns with.
 */
export function cliTalkerArgs(profileDir: string, system = TALKER_SYSTEM): string[] {
  const settings = {
    outputStyle: "default",
    alwaysThinkingEnabled: false,
    claudeMdExcludes: [path.join(profileDir, "CLAUDE.md"), path.join(profileDir, "rules", "**")],
  };
  return [
    "--system-prompt", system,
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--effort", "low",
    "--settings", JSON.stringify(settings),
  ];
}

async function cliManager(): Promise<CliTalker> {
  if (cliTalker) return cliTalker;
  const { WarmManager } = await import("./telegram/agent.js");
  const { CONFIG } = await import("./config.js");
  const profileDir = CONFIG.profiles[CONFIG.agent.profile] ?? CONFIG.profiles.claude;
  const model = String(setting("voice.talker_cli_model") || DEFAULT_CLI_MODEL);
  const m = new WarmManager({
    system: TALKER_SYSTEM,
    model,
    profileDir,
    turnTimeoutMs: 30_000,
    maxTurns: CLI_RECYCLE_TURNS + 1,
    cwd: talkerHome(),
    sandbox: "guard",
    customArgs: cliTalkerArgs(profileDir),
    extraEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  });
  let warm = false;
  const t: CliTalker = {
    turn: (text, onDelta, label, mdl) => m.turn(text, onDelta as any, label, mdl),
    warm: () => m.warm(),
    kill: () => { warm = false; m.kill(); },
    isWarm: () => warm,
    fresh: true,
    turns: 0,
    warmed: null,
  };
  // A throwaway first turn: the CLI only finishes booting (and opens its connection) on its first
  // message, so this is what makes his first real sentence a warm one.
  t.warmed = m.turn("(warm-up — reply with the single word: ok)", undefined, "talker warm-up")
    .then(() => { warm = true; })
    .catch((e: any) => { console.warn("[talker] warm-up", String(e?.message ?? e).slice(0, 200)); })
    .finally(() => { t.warmed = null; });
  cliTalker = t;
  return t;
}

/** Spawn the talker now (daemon start, a call opening) so the first sentence does not pay for it. */
export function warmTalker(): void {
  if (!talkerOn() || talkerEngine() !== "cli") return;
  void cliManager().catch((e) => console.warn("[talker] warm", e?.message ?? e));
}

/** Drop the warm process (model setting changed, tests). */
export function resetTalker(): void {
  cliTalker?.kill();
  cliTalker = null;
}

// ───────────────────────────── engine: the Messages API ─────────────────────────────

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;
/** Tests replace the network. null restores fetch. */
export function setTalkerFetch(fn: Fetcher | null): void { fetcher = fn; }

/** Haiku answers fastest with thinking off; models that refuse "disabled" just get low effort. */
export function thinkingFor(model: string): Record<string, unknown> {
  return /haiku/.test(model) ? { thinking: { type: "disabled" }, output_config: { effort: "low" } } : { output_config: { effort: "low" } };
}

export function requestBody(cred: TalkerCred, messages: unknown[]): Record<string, unknown> {
  return {
    model: cred.model,
    max_tokens: 1200,
    stream: true,
    system: [{ type: "text", text: TALKER_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages,
    ...thinkingFor(cred.model),
  };
}

function headers(cred: TalkerCred): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (cred.provider === "gateway") h.authorization = `Bearer ${cred.key}`;
  else h["x-api-key"] = cred.key;
  return h;
}

/** Parse one streamed Messages response (SSE). Text deltas go to onText as they come. */
export async function readStream(res: Response, onText: (t: string) => void): Promise<{ text: string; stop: string | null; usage: Record<string, number> }> {
  let text = "";
  let stop: string | null = null;
  const usage: Record<string, number> = {};
  const dec = new TextDecoder();
  let buf = "";
  const handle = (data: string) => {
    let e: any;
    try { e = JSON.parse(data); } catch { return; }
    if (e.type === "message_start") Object.assign(usage, e.message?.usage ?? {});
    else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) { text += e.delta.text; onText(e.delta.text); }
    else if (e.type === "message_delta") { if (e.delta?.stop_reason) stop = e.delta.stop_reason; Object.assign(usage, e.usage ?? {}); }
    else if (e.type === "error") throw new Error(`stream error: ${clip(e.error?.message ?? JSON.stringify(e.error), 200)}`);
  };
  const reader = (res.body as any).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) handle(data);
    }
  }
  return { text, stop, usage };
}

async function apiPost(cred: TalkerCred, body: Record<string, unknown>): Promise<Response> {
  const f = fetcher ?? fetch;
  const res = await f(cred.url, { method: "POST", headers: headers(cred), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw Object.assign(new Error(`talker HTTP ${res.status}: ${clip(txt, 200)}`), { status: res.status });
  }
  return res;
}

// ───────────────────────────── one turn ─────────────────────────────

/** His earlier exchanges in this thread, oldest first; and his own words, newest first. */
function history(scope: string | null): { pairs: Array<{ you: string; reply: string }>; earlier: string[] } {
  const rows = chat.frontTurns(scope, 6);
  return {
    pairs: rows.map((r) => ({ you: String(r.you || "").trim(), reply: splitReply(r.reply).spoken })),
    earlier: rows.map((r) => r.you).filter((w) => w && w.trim()).reverse(),
  };
}

/** The api engine's messages: alternating user/assistant, starting with him, ending with this turn. */
function apiMessages(pairs: Array<{ you: string; reply: string }>, userText: string): any[] {
  const out: any[] = [];
  for (const p of pairs) {
    if (p.you) out.push({ role: "user", content: p.you });
    if (p.reply) out.push({ role: "assistant", content: p.reply });
  }
  const merged: any[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  if (merged.length && merged[merged.length - 1].role === "user") merged.pop();
  return [...merged, { role: "user", content: userText }];
}

/** What the model is handed for this turn: the NOW block, and his words (with the line he answers). */
export function turnText(context: string, text: string, quote?: string | null, recap?: string | null): string {
  return [
    recap ? `EARLIER IN THIS CONVERSATION:\n${recap}\n` : "",
    context,
    "",
    quote ? `(He is answering this line: "${clip(quote, 400)}")` : "",
    `HE SAID: ${text}`,
  ].filter((l, i) => l !== "" || i === 2).join("\n");
}

export type TalkerStart = { ok: true; turn: string; ws: string | null; go: () => Promise<void> } | { ok: false; why: string };

/**
 * Open one front turn. The api engine resolves once the provider answered (HTTP 200) — so a provider
 * that is down or refuses the key falls back to today's path before he was told anything. The cli
 * engine resolves at once (its process is already warm). POST /agent acknowledges, then go() streams.
 */
export async function startTalkerTurn(o: {
  text: string; voice: boolean; surface: string; client?: string; scope: string | null; askedAt: string; quote?: string | null;
}): Promise<TalkerStart> {
  const engine = talkerEngine();
  const turn = randomUUID();
  const h = history(o.scope);
  const st: TurnState = {
    turn, words: o.text, earlier: h.earlier, scope: o.scope, via: o.voice ? "voice" : "typed", surface: o.surface, client: o.client, delegations: [],
  };
  let context: string;
  try { context = talkerContext(o.scope); } catch (e: any) { return { ok: false, why: `context: ${e?.message ?? e}` }; }

  // The api engine: the first request goes out now, so a dead key never reaches him.
  let apiFirst: Response | null = null;
  const cred = engine === "api" ? talkerCredential() : null;
  if (engine === "api") {
    try {
      apiFirst = await apiPost(cred!, requestBody(cred!, apiMessages(h.pairs, turnText(context, o.text, o.quote))));
    } catch (e: any) {
      return { ok: false, why: String(e?.message ?? e) };
    }
  }

  const ws = o.scope;
  const go = async () => {
    bus.publish({ topic: "agent.asked", you: o.text, at: new Date().toISOString(), source: o.surface, ws, client: o.client, turn, voice: o.voice });
    if (o.voice) markVoiceTurn(turn);
    let firstDeltaAt: string | null = null;
    let shown = "";
    const filter = speakFilter((t) => {
      if (!firstDeltaAt) firstDeltaAt = new Date().toISOString();
      shown += t;
      bus.publish({ topic: "agent.delta", text: t, kind: "text", ws, client: o.client, turn });
    });
    let full = "";
    let error: unknown = null;
    try {
      if (engine === "api") {
        const r = await readStream(apiFirst!, (t) => { full += t; filter.push(t); });
        noteHelperCall("talker", { model: cred!.model, tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens });
      } else {
        const m = await cliManager();
        if (m.warmed) await m.warmed; // never queue his sentence behind a half-done boot without knowing
        const recap = m.fresh && h.pairs.length
          ? h.pairs.slice(-4).map((p) => `He: ${clip(p.you, 300)}\nYou: ${clip(p.reply, 300)}`).join("\n")
          : null;
        full = await m.turn(turnText(context, o.text, o.quote, recap), (t, kind) => { if (kind === "text") filter.push(t); }, "talker");
        m.fresh = false;
        if (++m.turns >= CLI_RECYCLE_TURNS) { resetTalker(); warmTalker(); }
        // The CLI's stream can end without deltas (a result-only turn): the result is the reply.
        if (!shown && full) filter.push(full);
      }
    } catch (e) {
      error = e;
      console.warn("[talker]", String((e as any)?.message ?? e).slice(0, 300));
      if (engine === "cli") resetTalker(); // a broken process is respawned on the next turn
    }
    const { delegates } = splitReply(full);
    const refused: string[] = [];
    for (const d of delegates) {
      const b = buildDelegation(d, st);
      if (b.ok) startDelegation(b, st);
      else refused.push(b.error);
    }
    if (refused.length) console.warn("[talker] refused delegation:", refused.join("; "));
    let reply = shown.trim();
    // He is never told work started when it did not: a hand-over that was refused, or a promise
    // ("lo miro", "on it") with no hand-over behind it, is said out loud at once.
    if (reply && !st.delegations.length && (refused.length || PROMISE_RE.test(reply))) {
      const sorry = langOf(o.text) === "es" ? " Perdón, no llegué a arrancarlo. Decime de nuevo en qué proyecto y qué querés." : " Sorry, that did not start. Tell me again which project and what you want.";
      console.warn("[talker] promised with no hand-over:", reply.slice(0, 120));
      filter.push(sorry);
      reply += sorry;
    }
    if (!reply) {
      if (error) {
        const f = plainFailure(error, o.text);
        reply = f.kind === "other" ? (/^es/.test(langOf(o.text)) ? "Perdón, se me cortó. Probá de nuevo." : "Sorry, I lost that. Try again.") : f.reply;
      } else {
        reply = st.delegations.length ? (langOf(o.text) === "es" ? "Dale, estoy en eso." : "On it.") : "…";
      }
      filter.push(reply);
    }
    try {
      const row = chat.add(o.text, reply, "front", ws, null, null, null, "front", { voice: o.voice, asked_at: o.askedAt, first_delta_at: firstDeltaAt });
      chat.prune(2000);
      bus.publish({ topic: "agent.push", you: o.text, reply, at: row.created_at, source: "front", ws, client: o.client, turn, id: row.id, engine: "front" });
    } catch (e: any) {
      console.warn("[talker] store", e?.message ?? e);
    }
    bus.publish({ topic: "agent.turn.done", ws });
    // Nothing he says is lost: a turn that started no work is still a request, closed as answered.
    if (!st.delegations.length) {
      try {
        const r = openRequest({ workspace_id: ws, words: o.text, via: st.via, surface: o.surface, kind: "chat", turn_id: turn });
        closeRequest(r.id, null, "the front");
      } catch (e: any) {
        console.warn("[talker] ledger", e?.message ?? e);
      }
    }
  };
  return { ok: true, turn, ws, go };
}

/** A reply that says work is starting. Exported for tests. */
export const PROMISE_RE = /\b(lo miro|lo reviso|lo veo|me pongo|estoy en eso|me fijo|ya lo hago|lo hago|on it|i'?ll (look|check|do)|looking into)\b/i;

/** Cheap language guess for the front's own fallback lines. */
function langOf(text: string): "es" | "en" {
  return /[ñáéíóú¿¡]|\b(que|el|la|de|dale|che|como|esta|hola|vos)\b/i.test(text) ? "es" : "en";
}
