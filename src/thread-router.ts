/**
 * ONE visible thread, N isolated conversations.
 *
 * The operator types into a single thread — the Desk chat, or Telegram — and never wants to pick a
 * project first. Behind it there is already one warm Robert PER WORKSPACE (its own Claude profile,
 * its own `--resume` session, its own brief, its own scoped chat recap; see the "Web/voice" block in
 * src/telegram/agent.ts). That is the isolation: because the managers are separate CLI sessions,
 * context from one workspace CANNOT reach another — no prompt engineering, no leak to review.
 *
 * The leak was the DEFAULT: a message with no workspace selected went to the unscoped manager, which
 * is handed EVERY brief and the unscoped history. This module is the router that stands in front of
 * that default and picks which workspace's manager executes the turn.
 *
 * Deterministic and free — no model call. Resolution order, first hit wins:
 *   a. an explicit `#slug` / `#alias` tag anywhere in the message (`#all`/`#fleet`/`#shop` = unscoped)
 *   b. a signal in the text: ticket key, repo name/path, workspace name/slug/alias, a session id
 *   c. fleet-wide intent ("status", "what now", "qué pasó") with no workspace signal → unscoped
 *   d. the sticky workspace: whatever the previous routed message in this thread landed on
 *   d'. failing that, the terminal the surface has on screen (see why it sits below the sticky)
 *   e. nothing to go on → ASK. Never guess: the surface offers the candidates as one tappable line.
 *
 * That order is the FALLBACK. The surfaces call resolveTurnSmart, where only (a) stays a rule: every
 * other message goes to a cheap model (src/route-model.ts) that sees the open terminals and the
 * recent thread, with b–d' handed to it as hints. It falls back to the order above when the model is
 * off, slow or makes no sense.
 */
import { CONFIG } from "./config.js";
import { modelRoute, type RouteHints } from "./route-model.js";
import { kv, repos, sessions, tickets, workspaces, wsPrefix } from "./store.js";
import type { Workspace } from "./types.js";

export type RouteHow = "tag" | "key" | "name" | "sticky" | "fleet" | "ask" | "model";

export type RouteCandidate = { ws: string | null; slug: string; name: string };

export type Route = {
  /** Workspace id to run the turn on; null = fleet-wide (the unscoped manager). */
  ws: string | null;
  how: RouteHow;
  /** 0–1. Only ever compared against nothing — it is for the debug endpoint and the logs. */
  confidence: number;
  /** The message with any routing tag removed — this is what reaches the model. */
  text: string;
  /** how === "ask": what to offer the operator, in order. */
  candidates: RouteCandidate[];
  /** One line, for explainRoute and the ask line. */
  why: string;
  /** True when this turn should NOT move the sticky workspace (a greeting, a thanks). */
  social: boolean;
  /**
   * A question for the WHOLE shop ("status", "who needs me", #all), as opposed to a turn that merely
   * landed on no project. Only this — or two named projects — fans a turn out to every project's
   * Robert; small talk and a work request with nothing to go on get ONE reply from the unscoped one.
   */
  fleet?: boolean;
};

export type RouteCtx = {
  /** Which visible thread this is. Sticky is per surface. */
  surface?: string;
  /** The terminal the surface has on screen, if any — the weakest signal there is. */
  stagedSessionId?: string | null;
  /** A workspace the client already knows the turn is about (staged terminal's client). */
  uiWorkspace?: string | null;
  /**
   * The bubble this line answers. Stronger than sticky / the staged terminal, weaker than a #tag
   * or a signal in the text — a "yes, do that" on an Atlas reply stays on Atlas even if the last
   * untagged line was Cedar.
   */
  replyWorkspace?: string | null;
  now?: number;
};

const FLEET_TAGS = new Set(["all", "fleet", "shop", "everything", "todo"]);
const TAG_RE = /(^|\s)#([a-z0-9][a-z0-9_-]{0,39})\b/gi;
const KEY_RE = /\b([A-Z]{2,5})-(\d+)\b/g;
const ID8_RE = /\b([0-9a-f]{8,36})\b/gi;

// "status", "what now", "everything" — a question about the shop, not about a project. Only reached
// when nothing in the text named a workspace, so "status de atlas" never lands here.
const FLEET_INTENT: RegExp[] = [
  /^\s*(status|estado|state of (the )?(shop|fleet|world))\b/i,
  /\bwhat('?s| is| are)?\s*(now|next|up|running|going on|happening|left|on fire)\b/i,
  /\bwho needs me\b/i,
  // No trailing \b on the Spanish alternatives: an accented vowel is not a word character, so a
  // boundary after "pasó" never matches.
  /\bqu[eé]\s*(pas[oó]|pasa|hay|sigue|falta|est[aá] corriendo|hacemos)/i,
  /\b(everything|all projects|every project|all clients|the shop|la tienda|todos los proyectos)\b/i,
  /\b(standup|daily|resumen general|overview|pulse|brief me|briefing|rollup)\b/i,
  /\bhow('?s| is) (it going|everything|the shop|the fleet)\b/i,
  /\bc[oó]mo (va|vamos|anda) (todo|la cosa|el d[ií]a)\b/i,
  /\bc[oó]mo venimos\b/i,
  /\ben qu[eé] estamos\b/i,
];

// A greeting or a thanks routes like any other message but must never MOVE the sticky workspace:
// "gracias" after a Atlas turn is still about Atlas, and "hola" tomorrow must not pin the thread.
//
// Judged on WORDS, not on one regex per phrasing: speech-to-text hands us "Hola, hola.", "buenas
// buenas", "ok dale gracias", "¿me escuchás?" — repeats, fillers and punctuation a phrase regex never
// anticipates. A message is small talk when EVERY word in it is from this vocabulary (accents folded,
// stretched letters squeezed: "holaaa" → "hola"). A work request always carries at least one word
// that is not here ("dale, mergealo" → "mergealo"), so it can never read as social. Yes/no answers
// ("sí", "no", "yes") are deliberately absent: those answer a question, they are not small talk.
const SOCIAL_WORDS = new Set(
  (
    // greetings
    "hi hey hello hiya howdy yo sup ey hola holis holi buenas buenos buena buen dia dias tardes noches " +
    "good morning afternoon evening night goodnight alo che " +
    // thanks / acknowledgements
    "thanks thank thx ty tks gracias graciass mil muchas muchisimas perfecto perfect genial nice great ok okay oka " +
    "okey oki okis dale listo bien muy cool joya barbaro buenisimo excelente awesome sweet gotcha entendido " +
    "claro vale bueno super " +
    // how are you
    "how are u you doing como estas esta andas anda que tal todo onda haces " +
    // goodbyes
    "chau chao bye adios nos vemos hasta manana luego later see cya ciao " +
    // fillers, his name, a mic check
    "robert rob eh em este ah ahh oh mm mmm hmm uh um pues ahi there me escuchas escucha oyes oye se can hear " +
    "probando testing amigo bro capo crack jefe"
  ).split(/\s+/),
);
const LAUGH_RE = /^([jh][aeiou])\1+[jh]?$|^lol$|^xd+$/;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const MAX_SOCIAL_WORDS = 12;
const STICKY_KEY = (surface: string) => `thread.sticky:${surface || "web"}`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Alias → workspace slug, from CHRONOS_THREAD_ALIASES ("at=atlas,cd=cedar"). A workspace has no
 * free-form config column to hang these on, and an alias is an operator's shorthand rather than a
 * project fact, so it lives in the same .secrets the rest of his knobs do.
 */
function configAliases(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [alias, slug] of Object.entries(CONFIG.thread.aliases)) {
    const a = norm(alias);
    if (a) out.set(a, norm(slug));
  }
  return out;
}

/**
 * Every spelling of a workspace the operator might reasonably type, longest first. A slug or name has
 * to be 3+ characters to route (a two-letter project name would fire on half of Spanish); an alias
 * he declared himself is taken at two, which is the whole point of declaring "ml".
 */
function nameIndex(): Array<{ token: string; ws: Workspace }> {
  const aliases = configAliases();
  const rows: Array<{ token: string; ws: Workspace }> = [];
  for (const w of workspaces.list()) {
    const tokens = new Set<string>();
    for (const t of [norm(w.slug), norm(w.name)]) if (t.length >= 3) tokens.add(t);
    for (const [alias, slug] of aliases) if (slug === norm(w.slug) && alias.length >= 2) tokens.add(alias);
    for (const t of tokens) rows.push({ token: t, ws: w });
  }
  return rows.sort((a, b) => b.token.length - a.token.length);
}

const cand = (w: Workspace): RouteCandidate => ({ ws: w.id, slug: w.slug, name: w.name });
const FLEET_CAND: RouteCandidate = { ws: null, slug: "all", name: "the whole shop" };

/** Candidates for an ask line: every live workspace, then fleet-wide. */
export function askCandidates(): RouteCandidate[] {
  return [...workspaces.list().map(cand), FLEET_CAND];
}

// ── sticky ───────────────────────────────────────────────────────────────────────────────────────

export type Sticky = { ws: string | null; at: number };

/** The workspace the previous routed message in this thread landed on, or null once it expires. */
export function getSticky(surface = "web", now = Date.now()): Sticky | null {
  const raw = kv.get(STICKY_KEY(surface));
  if (!raw) return null;
  let parsed: Sticky;
  try { parsed = JSON.parse(raw) as Sticky; } catch { return null; }
  if (!parsed || typeof parsed.at !== "number") return null;
  const mins = CONFIG.thread.stickyMinutes;
  if (mins > 0 && now - parsed.at > mins * 60_000) return null;
  // A workspace deleted since the last turn is no sticky at all.
  if (parsed.ws && !workspaces.get(parsed.ws)) return null;
  return { ws: parsed.ws ?? null, at: parsed.at };
}

/** Pin the thread (ws) or hand it back to the router (null clears it entirely). */
export function setSticky(surface: string, ws: string | null, now = Date.now()): void {
  if (ws === null) return void kv.del(STICKY_KEY(surface));
  kv.set(STICKY_KEY(surface), JSON.stringify({ ws, at: now } satisfies Sticky));
}

export function clearSticky(surface = "web"): void {
  kv.del(STICKY_KEY(surface));
}

/**
 * Remember where this turn landed, unless it was small talk. Fleet-wide turns clear the pin: after
 * "status" the next bare message is about the shop again, not about whatever came before it.
 */
export function rememberRoute(surface: string, r: Route, now = Date.now()): void {
  if (r.social) return;
  if (r.how === "ask") return;
  if (r.ws === null) clearSticky(surface);
  else setSticky(surface, r.ws, now);
}

// ── resolution ───────────────────────────────────────────────────────────────────────────────────

type TagScan = { text: string; targets: Array<string | null>; spellings: string[] };

/** Pull `#slug` / `#all` out of the message. Unknown tags are left alone — they are just text. */
function scanTags(text: string): TagScan {
  const index = nameIndex();
  const targets: Array<string | null> = [];
  const spellings: string[] = [];
  const stripped = text.replace(TAG_RE, (m, lead: string, tag: string) => {
    const t = norm(tag);
    if (FLEET_TAGS.has(t)) { targets.push(null); spellings.push(tag); return lead; }
    const hit = index.find((r) => r.token === t);
    if (!hit) return m; // "#bug" is a word the operator typed, not a route
    targets.push(hit.ws.id);
    spellings.push(tag);
    return lead;
  });
  return { text: stripped.replace(/\s{2,}/g, " ").trim(), targets, spellings };
}

/** Workspaces a ticket key points at. Empty = unknown key; >1 = a prefix two workspaces share. */
function wsForKey(key: string): string[] {
  const t = tickets.list().find((x) => x.key.toUpperCase() === key.toUpperCase());
  if (t?.workspace_id) return [t.workspace_id];
  // No such ticket (yet): the PREFIX still names a workspace — unless two of them share it, which
  // is the CLAUDE.md gotcha. Then it is genuinely ambiguous and the operator has to say which.
  const prefix = key.split("-")[0].toUpperCase();
  return workspaces.list().filter((w) => wsPrefix(w.slug) === prefix).map((w) => w.id);
}

type Signal = { ws: string[]; how: "key" | "name"; why: string };

/** Every workspace the TEXT itself points at, with what pointed there. */
function textSignals(text: string): Signal[] {
  const out: Signal[] = [];

  for (const m of text.matchAll(KEY_RE)) {
    const ws = wsForKey(m[0]);
    if (ws.length) out.push({ ws, how: "key", why: `ticket key ${m[0].toUpperCase()}` });
  }

  // A session/run id the operator pasted — it carries its own workspace.
  for (const m of text.matchAll(ID8_RE)) {
    const s = sessionWs(m[1]);
    if (s) out.push({ ws: [s], how: "key", why: `terminal ${m[1].slice(0, 8)}` });
  }

  // Names are matched on WORDS, not substrings: "cedar" must not fire on "intercedarwood", and
  // a two-word project ("Pied Piper") has to survive being typed with a space in it.
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const grams = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    grams.add(words[i]);
    if (i + 1 < words.length) grams.add(words[i] + words[i + 1]);
    if (i + 2 < words.length) grams.add(words[i] + words[i + 1] + words[i + 2]);
  }

  for (const r of repos.list()) {
    const name = norm(r.name);
    if (name.length >= 3 && grams.has(name)) out.push({ ws: [r.workspace_id], how: "name", why: `repo ${r.name}` });
    else if (r.path && r.path.length > 6 && lower.includes(r.path.toLowerCase()))
      out.push({ ws: [r.workspace_id], how: "name", why: `path ${r.path}` });
  }

  for (const { token, ws } of nameIndex()) {
    if (grams.has(token)) out.push({ ws: [ws.id], how: "name", why: `named ${ws.name}` });
  }
  return out;
}

/** The workspace a session id (full or 8-char prefix) belongs to. */
function sessionWs(idOrPrefix: string): string | null {
  const exact = sessions.get(idOrPrefix);
  if (exact) return exact.workspace_id ?? null;
  const p = idOrPrefix.toLowerCase();
  const hit = sessions.list({ limit: 400 }).find((s) => s.id.startsWith(p));
  return hit?.workspace_id ?? null;
}

const isFleetIntent = (text: string) => FLEET_INTENT.some((re) => re.test(text));

/** Small talk: every word a greeting, thanks, filler or goodbye — never a fleet question. Exported for tests. */
export function isSocial(text: string): boolean {
  const raw = String(text ?? "").trim();
  if (!raw || isFleetIntent(raw)) return false;
  const words = fold(raw).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/(\p{L})\1{2,}/gu, "$1"));
  // Nothing but emoji ("👍", "🙏🙏") is a thanks; nothing at all is not a message.
  if (!words.length) return EMOJI_RE.test(raw);
  if (words.length > MAX_SOCIAL_WORDS) return false;
  return words.every((w) => SOCIAL_WORDS.has(w) || LAUGH_RE.test(w));
}

/** Deduplicate a signal set down to the workspaces it actually agrees on. */
function collapse(signals: Signal[]): { ws: string[]; how: "key" | "name"; why: string } | null {
  if (!signals.length) return null;
  const ids = new Set<string>();
  for (const s of signals) for (const id of s.ws) ids.add(id);
  const how = signals.some((s) => s.how === "key") ? "key" : "name";
  const why = signals.map((s) => s.why).join(" + ");
  return { ws: [...ids], how, why };
}

/**
 * Which workspace's Robert should execute this message. Pure apart from reading the store and the
 * sticky kv row — it writes nothing; the caller commits the decision with rememberRoute().
 */
export function routeMessage(text: string, ctx: RouteCtx = {}): Route {
  const now = ctx.now ?? Date.now();
  const surface = ctx.surface || "web";

  // a. explicit tag — the operator said it, so it also pins the thread.
  const tags = scanTags(text);
  // Social is judged on the message WITHOUT its tag: "#atlas gracias" is still a thank-you.
  const base = { candidates: [] as RouteCandidate[], social: isSocial(tags.text.trim()) };
  const distinct = [...new Set(tags.targets.map((t) => t ?? "\0fleet"))];
  if (distinct.length === 1) {
    const ws = tags.targets[0] ?? null;
    const w = ws ? workspaces.get(ws) : null;
    return { ...base, ws, how: "tag", confidence: 1, text: tags.text, why: `#${w ? w.slug : "all"} (explicit tag)`, fleet: ws === null };
  }
  if (distinct.length > 1) {
    const tagged = tags.targets.filter((t): t is string => !!t).map((t) => cand(workspaces.get(t)!));
    return {
      ...base,
      ws: null,
      how: "ask",
      confidence: 0,
      text: tags.text,
      candidates: [...tagged, FLEET_CAND],
      why: `${tags.spellings.map((sp) => "#" + sp).join(" and ")} — two tags, one turn`,
    };
  }

  const body = tags.text;

  // b. a signal in the text.
  const sig = collapse(textSignals(body));
  if (sig && sig.ws.length === 1) {
    return { ...base, ws: sig.ws[0], how: sig.how, confidence: sig.how === "key" ? 0.9 : 0.8, text: body, why: sig.why };
  }
  if (sig && sig.ws.length > 1) {
    return {
      ...base,
      ws: null,
      how: "ask",
      confidence: 0,
      text: body,
      // The shop is on the list on purpose: two projects in one sentence is usually a handoff, and
      // only the fleet-wide Robert can see both.
      candidates: [...sig.ws.filter((id) => workspaces.get(id)).map((id) => cand(workspaces.get(id)!)), FLEET_CAND],
      why: `${sig.why} — more than one project matches`,
    };
  }

  // c. fleet-wide intent, with nothing pointing at a project.
  if (isFleetIntent(body)) {
    return { ...base, ws: null, how: "fleet", confidence: 0.7, text: body, why: "fleet-wide question", fleet: true };
  }

  // c'. the bubble this line answers — stronger than sticky / the staged terminal.
  if (ctx.replyWorkspace && workspaces.get(ctx.replyWorkspace)) {
    const w = workspaces.get(ctx.replyWorkspace)!;
    return { ...base, ws: ctx.replyWorkspace, how: "sticky", confidence: 0.65, text: body, why: `replying on #${w.slug}` };
  }

  // d. sticky — the workspace the previous routed message in this thread landed on.
  const sticky = getSticky(surface, now);
  if (sticky?.ws) {
    return { ...base, ws: sticky.ws, how: "sticky", confidence: 0.5, text: body, why: `still on ${workspaces.get(sticky.ws)?.slug ?? sticky.ws}` };
  }

  // b'. the terminal the surface has on screen — LAST, below the sticky, though it is a tier-b
  // signal. The Desk always has something on its stage, so above the sticky this would decide almost
  // every untagged message and make the composer's chip a lie: it shows the sticky. Here it only
  // answers the case the sticky cannot — a thread with no pin, looking straight at a terminal.
  // Small talk skips it: the Desk always has a terminal on stage, and "hola" is not about that
  // terminal — it gets one short reply from the unscoped Robert below.
  const staged = ctx.uiWorkspace || (ctx.stagedSessionId ? sessionWs(ctx.stagedSessionId) : null);
  if (staged && workspaces.get(staged) && !base.social) {
    return { ...base, ws: staged, how: "key", confidence: 0.6, text: body, why: "the terminal on your screen" };
  }

  // e. small talk with nothing to go on is harmless on the unscoped manager; a work request is not.
  if (base.social || !workspaces.list().length) {
    return { ...base, ws: null, how: "fleet", confidence: 0.4, text: body, why: base.social ? "small talk" : "no workspaces yet" };
  }
  return { ...base, ws: null, how: "ask", confidence: 0, text: body, candidates: askCandidates(), why: "no project signal and nothing sticky" };
}

// ── the model ────────────────────────────────────────────────────────────────────────────────────

/** Below this the model's pick is a guess, and a guess is worse than asking. */
const MODEL_MIN_CONFIDENCE = 0.5;

/**
 * routeMessage with judgment: an explicit #tag is still final, everything else is the model's call,
 * made with the rules' signals as hints. Null from the model → routeMessage, unchanged.
 */
export async function routeSmart(text: string, ctx: RouteCtx = {}): Promise<Route> {
  const now = ctx.now ?? Date.now();
  const surface = ctx.surface || "web";
  const tags = scanTags(text);
  if (tags.targets.length) return routeMessage(text, ctx);
  const body = tags.text;
  const social = isSocial(body.trim());
  // Small talk never needs judgment, and is never worth a model round trip: the rules already send
  // it to the bubble it answers, the sticky project, or the unscoped Robert. Asking the model used to
  // fan "Hola, hola." out to every project ("all" is also its answer for small talk).
  if (social) return routeMessage(text, ctx);
  const slugOf = (id: string | null) => (id ? workspaces.get(id)?.slug ?? id : null);
  const sticky = getSticky(surface, now);
  const staged = ctx.uiWorkspace || (ctx.stagedSessionId ? sessionWs(ctx.stagedSessionId) : null);
  const replyWs = ctx.replyWorkspace && workspaces.get(ctx.replyWorkspace) ? ctx.replyWorkspace : null;
  const hints: RouteHints = {
    signals: textSignals(body).map((s) => ({ why: s.why, workspaces: s.ws.map((id) => slugOf(id) ?? id) })),
    fleetIntent: isFleetIntent(body),
    social,
    sticky: sticky ? { slug: slugOf(sticky.ws), minutesAgo: Math.round((now - sticky.at) / 60_000) } : null,
    staged: staged && workspaces.get(staged) ? slugOf(staged) : null,
    // A reply's parent is the best hint when nothing else speaks — same slot the model already sees
    // as "staged" (it is "what this turn is about"), and stronger than an old sticky.
    ...(replyWs ? { staged: slugOf(replyWs) } : {}),
  };
  const m = await modelRoute(body, hints);
  if (!m) return routeMessage(text, ctx);
  const base = { text: body, social, why: "model: " + m.why };
  if (m.ws === "ask" || m.confidence < MODEL_MIN_CONFIDENCE) {
    const all = askCandidates();
    const first = m.candidates.map((sl) => all.find((c) => c.slug.toLowerCase() === sl)).filter((c): c is RouteCandidate => !!c);
    return { ...base, ws: null, how: "ask", confidence: m.confidence, candidates: [...new Set([...first, ...all])] };
  }
  // The model's "all" is the whole shop only when the words say so too, or the message is long
  // enough to be a request: a two-word line it shrugged onto "all" ("¿estás?") is not a status call
  // to every project.
  const fleet = m.ws === null && (hints.fleetIntent || wordCount(body) > SHORT_LINE_WORDS);
  return { ...base, ws: m.ws, how: "model", confidence: m.confidence, candidates: [], fleet };
}

const SHORT_LINE_WORDS = 3;
const wordCount = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;

// ── the one seam both surfaces use ───────────────────────────────────────────────────────────────

export type ResolvedTurn = {
  /** Workspace whose Robert runs this turn; null = the fleet-wide manager. */
  ws: string | null;
  /** The message as the model should see it (tag stripped). */
  text: string;
  /** The router's decision, when it made one. Null when the client picked the workspace by hand. */
  routed: Route | null;
  /** Set instead of running the turn: the surface must offer these candidates. */
  ask: Route | null;
  how: RouteHow | "selected";
};

/**
 * Which conversation a turn belongs to. `selected` is the client's own workspace selector and always
 * wins; no selection (Flow's "all workspaces", the Desk, Telegram with no /conv) hands it to the
 * router. `route: false` is the escape for a caller that means the fleet-wide manager literally.
 */
export function resolveTurn(
  text: string,
  opts: { selected?: string | null; route?: boolean; surface?: string; stagedSessionId?: string | null; uiWorkspace?: string | null; replyWorkspace?: string | null } = {},
): ResolvedTurn {
  const selected = opts.selected ?? null;
  if (selected || opts.route === false)
    return { ws: selected, text, routed: null, ask: null, how: selected ? "selected" : "fleet" };
  const r = routeMessage(text, { surface: opts.surface, stagedSessionId: opts.stagedSessionId, uiWorkspace: opts.uiWorkspace, replyWorkspace: opts.replyWorkspace });
  if (r.how === "ask") return { ws: null, text: r.text, routed: null, ask: r, how: "ask" };
  return { ws: r.ws, text: r.text, routed: r, ask: null, how: r.how };
}

/** resolveTurn, routed by the model (routeSmart). What the Desk, the phone and Telegram call. */
export async function resolveTurnSmart(
  text: string,
  opts: { selected?: string | null; route?: boolean; surface?: string; stagedSessionId?: string | null; uiWorkspace?: string | null; replyWorkspace?: string | null } = {},
): Promise<ResolvedTurn> {
  const selected = opts.selected ?? null;
  if (selected || opts.route === false)
    return { ws: selected, text, routed: null, ask: null, how: selected ? "selected" : "fleet" };
  const r = await routeSmart(text, { surface: opts.surface, stagedSessionId: opts.stagedSessionId, uiWorkspace: opts.uiWorkspace, replyWorkspace: opts.replyWorkspace });
  if (r.how === "ask") return { ws: null, text: r.text, routed: null, ask: r, how: "ask" };
  return { ws: r.ws, text: r.text, routed: r, ask: null, how: r.how };
}

/**
 * A SPOKEN turn never gets "Which project is this about?": he is talking, not looking at chips. The
 * router's ask is resolved here instead, in this order: the project of the bubble he is answering →
 * the thread's sticky project → the unscoped Robert, who answers once (no fan-out — a work request
 * with nothing to go on is not a question for the whole shop). Typed turns never come through here.
 */
export function resolveVoiceAsk(
  t: ResolvedTurn,
  opts: { replyWorkspace?: string | null; surface?: string; now?: number } = {},
): ResolvedTurn {
  if (!t.ask) return t;
  const base = { text: t.ask.text, candidates: [] as RouteCandidate[], social: t.ask.social, fleet: false };
  const reply = opts.replyWorkspace && workspaces.get(opts.replyWorkspace) ? opts.replyWorkspace : null;
  const sticky = reply ? null : getSticky(opts.surface || "web", opts.now ?? Date.now())?.ws ?? null;
  const ws = reply ?? sticky;
  const routed: Route = ws
    ? { ...base, ws, how: "sticky", confidence: 0.4, why: `voice: ${reply ? "replying on" : "still on"} #${workspaces.get(ws)?.slug ?? "?"}` }
    : { ...base, ws: null, how: "fleet", confidence: 0.3, why: "voice: no project to go on — the unscoped Robert answers" };
  return { ws: routed.ws, text: routed.text, routed, ask: null, how: routed.how };
}

/**
 * Does a turn that runs on no single project go to EVERY project's Robert? Only when it is a question
 * for the whole shop (routed.fleet) or he picked "the whole shop" by hand (no routed decision). Small
 * talk and a work request with nothing to go on get one reply from the unscoped Robert. Pure.
 */
export function wantsFanout(t: ResolvedTurn): boolean {
  if (t.ask || t.ws !== null) return false;
  if (!t.routed) return true;
  return !t.routed.social && !!t.routed.fleet;
}

/**
 * He talks to ONE Robert. A turn on no single project is answered once, by the unscoped Robert —
 * never by every project's Robert in turn (six of them answering "no, eso no me importa", each read
 * aloud, is not a conversation). The old shop-wide fan-out survives only behind `enabled`
 * (CHRONOS_ROBERT_FANOUT=1), and never for a spoken turn. Pure.
 */
export function fansOut(t: ResolvedTurn, voice: boolean, enabled = false): boolean {
  return enabled && !voice && wantsFanout(t);
}

/**
 * He talks to ONE Robert. A project's own Robert takes the turn only when he pointed at that project
 * himself: picked it, tagged it, named it (or one of its tickets / repos), or is answering one of its
 * bubbles. A guess — the router model's, or "where the last line landed" — does not send him to a
 * different Robert who only knows one project ("¿qué me espera?" answered "nothing, in <project>").
 * Those turns go to the unscoped Robert, who sees all of it. Pure.
 */
export function oneRobert(t: ResolvedTurn, replyWorkspace?: string | null): ResolvedTurn {
  if (t.ask || t.ws === null || !t.routed) return t;
  const guessed = t.routed.how === "model" || (t.routed.how === "sticky" && t.ws !== (replyWorkspace ?? null));
  if (!guessed) return t;
  const routed: Route = { ...t.routed, ws: null, how: "fleet", fleet: false, why: `one Robert: no project named (${t.routed.why})` };
  return { ws: null, text: t.text, routed, ask: null, how: "fleet" };
}

/** Remember where the turn landed, so the next bare message follows it. An ask lands nowhere. */
export function commitTurn(surface: string, t: ResolvedTurn): void {
  if (t.ask) return;
  if (t.routed) return rememberRoute(surface, t.routed);
  // A workspace he picked by hand pins the thread; picking the whole shop releases it.
  if (t.ws) setSticky(surface, t.ws);
  else clearSticky(surface);
}

/** One line the surface can show when the router has to ask. */
export function askLine(r: Route): string {
  // Every surface draws the candidates as tappable choices, so the line only asks.
  return r.candidates.length ? "Which project is this about?" : "Which project is this about? I couldn't tell.";
}

/** Debug view for GET /api/thread/route — the decision plus everything it weighed. */
export function explainRoute(text: string, ctx: RouteCtx = {}): {
  route: Route;
  workspace: { id: string; slug: string; name: string } | null;
  sticky: { ws: string | null; slug: string | null; at: string } | null;
  signals: Array<{ how: string; why: string; workspaces: string[] }>;
  tags: string[];
  social: boolean;
  fleetIntent: boolean;
  stickyMinutes: number;
} {
  const route = routeMessage(text, ctx);
  const tags = scanTags(text);
  const sticky = getSticky(ctx.surface || "web", ctx.now ?? Date.now());
  const w = route.ws ? workspaces.get(route.ws) : undefined;
  return {
    route,
    workspace: w ? { id: w.id, slug: w.slug, name: w.name } : null,
    sticky: sticky
      ? { ws: sticky.ws, slug: sticky.ws ? workspaces.get(sticky.ws)?.slug ?? null : null, at: new Date(sticky.at).toISOString() }
      : null,
    signals: textSignals(tags.text).map((s) => ({
      how: s.how,
      why: s.why,
      workspaces: s.ws.map((id) => workspaces.get(id)?.slug ?? id),
    })),
    tags: tags.spellings.map((s) => "#" + s),
    social: isSocial(tags.text.trim()),
    fleetIntent: isFleetIntent(tags.text),
    stickyMinutes: CONFIG.thread.stickyMinutes,
  };
}
